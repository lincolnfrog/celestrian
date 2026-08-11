/**
 * Top-level patch: patchSessionView renders the Q-unit view model into
 * the DOM every poll — transport chrome, ruler, keyed lane
 * reconciliation, nav docks, and the one playhead (I8).
 */

import { ctx } from './context.js';
import { setText, fmtQ, snapThenAnimate } from './sv_util.js';
import { noteFrame } from './drag_pin.js';
import { patchRuler } from './ruler.js';
import { buildLane } from './lane_build.js';
import { patchRail } from './rail.js';
import { patchLaneBody } from './lane_body.js';
import { updateNavDock } from './teleport.js';
import { animatorPoll, stopAnimator } from './animator.js';

/* A recording playhead moving backwards by more than this many px is a
 * commit jump — snap, never sweep backwards. */
const REC_SNAP_BACK_PX = 40;

export function patchSessionView(vm, aux) {
    // Pin source for map gestures (see drag_pin.js)
    noteFrame(vm.cycleQ, vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ);
    // Transport (all writes idempotent — see the setText note)
    setText(ctx.els.playBtn, vm.isPlaying ? '⏸' : '▶');
    ctx.els.playBtn.classList.toggle('playing', vm.isPlaying);
    const anyRecording = vm.lanes.some(l => l.recording);
    if (vm.provisionalDefiner) {
        // Q13: while trimming the sole clip, Q-units are circular (the
        // loop IS 1Q by definition). Read out the tempo being set — the
        // loop length in seconds — not the full-buffer frame in Q.
        const sr = aux.sampleRate || vm.sampleRate || 44100;
        setText(ctx.els.readout, 'loop ' + (vm.quantum / sr).toFixed(2) + ' s · sets tempo');
    } else if (vm.qEstablished) {
        // When windows shorten the audible cycle (E-C) the playhead
        // wraps before the frame end — the readout says why
        const loopNote = !vm.frameExtended && vm.loopCycleQ < vm.lcmQ
            ? ' · loop ' + fmtQ(vm.loopCycleQ) + 'Q' : '';
        setText(ctx.els.readout, vm.playheadQ.toFixed(1) + 'Q / ' + fmtQ(vm.cycleQ) + 'Q'
            + (vm.frameExtended ? '…' : ' ↺') + loopNote);
    } else if (anyRecording) {
        // First take: no Q yet — this recording will define it
        const sr = aux.sampleRate || 44100;
        setText(ctx.els.readout, (vm.playheadQ * vm.quantum / sr).toFixed(1) + ' s · first take');
    } else {
        setText(ctx.els.readout, '—');
    }
    if (aux.sampleRate) {
        setText(ctx.els.qInfo,
            'Q = ' + (vm.quantum / aux.sampleRate).toFixed(2) + ' s · ' +
            (aux.sampleRate / 1000) + ' kHz');
    }

    patchRuler(vm);

    // Lanes: keyed reconciliation in VM order
    const seen = new Set();
    let prev = null;
    vm.lanes.forEach(lane => {
        let row = ctx.laneEls.get(lane.id);
        if (!row) {
            row = buildLane(lane);
            ctx.laneEls.set(lane.id, row);
        }
        if (prev ? row.previousElementSibling !== prev : row !== ctx.els.lanes.firstElementChild) {
            ctx.els.lanes.insertBefore(row, prev ? prev.nextElementSibling : ctx.els.lanes.firstElementChild);
        }
        patchRail(row, lane, vm);
        patchLaneBody(row, lane, vm, aux);
        // Add rows match their sibling lanes' real height by measurement
        if (lane.kind === 'add' && prev) {
            const btn = row.querySelector('.add-track-row-btn');
            const h = prev.getBoundingClientRect().height + 'px';
            if (btn.style.minHeight !== h) btn.style.minHeight = h;
        }
        seen.add(lane.id);
        prev = row;
    });
    ctx.laneEls.forEach((row, id) => {
        if (!seen.has(id)) {
            row.remove();
            ctx.laneEls.delete(id);
        }
    });

    // Handle nav docks mirror the overlays just patched above (ticks
    // parse the handles' own left styles — same pct() truth, no drift).
    ctx.laneEls.forEach(row => updateNavDock(row));

    ctx.els.emptyState.style.display = vm.lanes.length ? 'none' : 'block';

    // The one playhead (I8): a single line from the ruler through the
    // last audio lane — never through the add-track affordance below.
    if (vm.isPlaying && vm.lanes.length) {
        ctx.els.playhead.style.display = 'block';
        if (!anyRecording && vm.qEstablished) {
            // Idle/playing: the animator draws at 60fps and wraps
            // exactly at the audible cycle; the poll only corrects it
            if (ctx.els.playhead.style.transition !== 'none') {
                ctx.els.playhead.style.transition = 'none';
            }
            animatorPoll(vm, aux);
        } else {
            stopAnimator();
            if (ctx.els.playhead.style.transition === 'none') {
                ctx.els.playhead.style.transition = '';
            }
            const timelineW = ctx.els.ruler.clientWidth;
            const newLeft = (vm.playheadQ / vm.cycleQ) * timelineW;
            // Recording: glide with the same 140ms linear timing as the
            // recording bar's edge (they move in lockstep, law 10) — a
            // commit jump must snap, not sweep backwards
            const prevLeft = ctx.els.playhead._left ?? newLeft;
            if (newLeft < prevLeft - REC_SNAP_BACK_PX) {
                snapThenAnimate(ctx.els.playhead);
            }
            ctx.els.playhead._left = newLeft;
            ctx.els.playhead.style.left = newLeft + 'px';
        }
        const audioRows = [...ctx.els.lanes.children].filter(r =>
            !r.classList.contains('lane-add') && !r.classList.contains('lane-fx'));
        const last = audioRows[audioRows.length - 1];
        if (last) {
            const h = last.offsetTop + last.offsetHeight;
            const hpx = h + 'px';
            if (ctx.els.playhead.style.height !== hpx) ctx.els.playhead.style.height = hpx;
        }
        maskPlayheadOverInspectors();
    } else {
        stopAnimator();
        ctx.els.playhead.style.display = 'none';
    }
}

/* Suppression of the white playhead over INSPECTOR lanes, made
 * paint-order-independent (field 2026-07-25b): the z-index scheme
 * (.inspecting body z 7 over playhead z 6) relies on the lane painting
 * OPAQUELY above the line, and the webview compositor let the line
 * bleed through in stray frames mid-drag. A vertical mask carves the
 * inspecting lanes' bands out of the line itself — no stacking, no
 * compositor, no bleed. */
function maskPlayheadOverInspectors() {
    const ph = ctx.els.playhead;
    const bodies = document.querySelectorAll('.lane-body.inspecting');
    if (!bodies.length) {
        if (ph._masked) {
            ph._masked = false;
            ph.style.webkitMaskImage = '';
            ph.style.maskImage = '';
        }
        return;
    }
    const pr = ph.getBoundingClientRect();
    if (!(pr.height > 0)) return;
    const bands = [...bodies].map(b => b.getBoundingClientRect())
        .map(r => [Math.max(0, (r.top - pr.top) / pr.height * 100),
                   Math.min(100, (r.bottom - pr.top) / pr.height * 100)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    let prevPct = 0;
    const stops = [];
    for (const [a, b] of bands) {
        stops.push('black ' + prevPct + '%, black ' + a + '%, ' +
                   'transparent ' + a + '%, transparent ' + b + '%');
        prevPct = b;
    }
    stops.push('black ' + prevPct + '%, black 100%');
    const img = 'linear-gradient(to bottom, ' + stops.join(', ') + ')';
    if (ph._maskImg !== img) {
        ph._maskImg = img;
        ph._masked = true;
        ph.style.webkitMaskImage = img;
        ph.style.maskImage = img;
    }
}
