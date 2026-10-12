/**
 * Top-level patch: patchSessionView renders the Q-unit view model into
 * the DOM every poll — transport chrome, ruler, keyed lane
 * reconciliation, region panels, and the playhead. Every write is
 * idempotent (sv_util setText).
 */

import { ctx } from './context.js';
import { setText, fmtQ, MAX_INDENT_DEPTH } from './sv_util.js';
import { noteFrame } from './drag_pin.js';
import { patchRuler } from './ruler.js';
import { buildLane } from './lane_build.js';
import { patchRail, patchSeqChip, patchFxChip } from './rail.js';
import { patchLaneBody } from './lane_body.js';
import { patchRegionPanel } from './region_panel.js';
import { patchRegionDock } from './region_dock.js';
import { patchPlayhead } from './playhead.js';
import { ensureDefaultSelection } from './selection.js';
import { noteSeekVm } from './ruler_seek.js';
import { flushTeardowns } from './gesture.js';

/** Is the synthetic `kind` row ('seq' | 'fx') of the root open? */
const rootRowOpen = (vm, kind) =>
    vm.lanes.some(l => l.kind === kind && l.ownerId === vm.rootId);

/** The transport's readout and Q line. */
function patchReadout(vm, anyRecording) {
    const seconds = samples => samples / vm.sampleRate;
    if (vm.provisionalDefiner) {
        // Q13: while trimming the sole clip, Q-units are circular (the
        // loop IS 1Q by definition). Read out the tempo being set — the
        // loop length in seconds — not the full-buffer frame in Q.
        setText(ctx.els.readout,
            'loop ' + seconds(vm.quantum).toFixed(2) + ' s · sets tempo');
    } else if (vm.qEstablished) {
        // When windows shorten the audible cycle the playhead wraps
        // before the frame end — the readout says why.
        const loopNote = !vm.frameExtended && vm.loopCycleQ < vm.lcmQ
            ? ' · loop ' + fmtQ(vm.loopCycleQ) + 'Q' : '';
        setText(ctx.els.readout, vm.playheadQ.toFixed(1) + 'Q / ' + fmtQ(vm.cycleQ) + 'Q'
            + (vm.frameExtended ? '…' : ' ↺') + loopNote);
    } else if (anyRecording) {
        // First take: no Q yet — this recording will define it.
        setText(ctx.els.readout,
            seconds(vm.playheadQ * vm.quantum).toFixed(1) + ' s · first take');
    } else {
        setText(ctx.els.readout, '—');
    }
    setText(ctx.els.qInfo,
        'Q = ' + seconds(vm.quantum).toFixed(2) + ' s · ' +
        (vm.sampleRate / 1000) + ' kHz');
}

/** The root's two chips. The session's own song lives on the root
 * stack, which has no rail: its seq chip sits in the ruler row's rail
 * spacer (hidden until there is anything to sequence) and its fx chip
 * on the master strip; each opens its row as the first lane. */
function patchRootChips(vm) {
    const seqBtn = document.getElementById('root-seq-btn');
    if (seqBtn) {
        patchSeqChip(seqBtn, vm.rootSeq);
        seqBtn.classList.toggle('open', rootRowOpen(vm, 'seq'));
        const show = vm.lanes.length && vm.qEstablished ? '' : 'none';
        if (seqBtn.style.display !== show) seqBtn.style.display = show;
    }
    const fxBtn = document.getElementById('master-fx-btn');
    if (fxBtn) {
        patchFxChip(fxBtn, vm.rootFxCount || 0);
        fxBtn.classList.toggle('open', rootRowOpen(vm, 'fx'));
    }
}

/**
 * `aux.rerender`: a re-render between polls (render_request.js —
 * the re-seat tween's frames, a gesture's pending preview), derived
 * from the LAST poll's state. Its clock is stale, which is the
 * playhead's concern (playhead.js).
 */
export function patchSessionView(vm, aux) {
    // Pin source for map gestures (drag_pin.js): the zero AT REST —
    // under a re-seat tween, the seat it is moving to.
    noteFrame(vm.cycleQ, vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ,
              Number.isFinite(vm.restZero) ? vm.restZero : vm.frameZero);
    setText(ctx.els.playBtn, vm.isPlaying ? '⏸' : '▶');
    ctx.els.playBtn.classList.toggle('playing', vm.isPlaying);
    const anyRecording = vm.lanes.some(l => l.recording);
    patchReadout(vm, anyRecording);
    patchRootChips(vm);
    patchRuler(vm);

    // The rail column grows one indent per nesting level PRESENT, so a
    // nested rail keeps the full control set's width instead of paying
    // for its indent (the rows would spill past the rail's edge).
    let railDepth = 0;
    for (const l of vm.lanes) {
        if (l.kind === 'clip' || l.kind === 'group') {
            railDepth = Math.max(railDepth, Math.min(l.depth || 0, MAX_INDENT_DEPTH));
        }
    }
    const rootStyle = document.documentElement.style;
    if (rootStyle.getPropertyValue('--rail-depth') !== String(railDepth)) {
        rootStyle.setProperty('--rail-depth', String(railDepth));
    }

    // THE RE-SEAT TWEEN (frame.md §1): the zero moves by per-frame
    // re-derives, so tiles must land where each derive puts them — a
    // tile's own left/width transition would trail it (session.css).
    ctx.els.lanes.classList.toggle('frame-tweening', !!vm.frameTweening);

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
            if (row._region) row._region.nav.remove();  // in the edit bar
            ctx.laneEls.delete(id);
        }
    });

    // A track is selected by default (selection.js): prune vanished ids,
    // and with nothing selected pick the first real lane — after the
    // rails are patched, so paintSelection sees current rows.
    ensureDefaultSelection(
        vm.lanes.filter(l => l.kind === 'clip' || l.kind === 'group')
            .map(l => l.id));

    // The SELECTED track's region panel in the edit bar (after the
    // selection settled above): the whole raw take + the kept region,
    // from the peaks the body patch just resolved.
    vm.lanes.forEach(lane => {
        const row = ctx.laneEls.get(lane.id);
        if (!row || (lane.kind !== 'clip' && lane.kind !== 'group')) return;
        const body = row.querySelector(':scope > .lane-body');
        patchRegionPanel(row, lane, vm, aux, body ? body._peaks : null);
    });
    patchRegionDock(vm);
    // A finished map gesture's held preview comes down HERE — after its
    // body / strip rebuilt from the committed state above, in the same
    // frame, so nothing shows in between (gesture.js deferTeardown).
    flushTeardowns();
    // THE RECORDING GATE (vm/lane_common.js bandGate): while a take is live or
    // pending every loop region is display-only; the lanes' map chrome
    // takes no presses and shows no grab cursor (session.css).
    ctx.els.lanes.classList.toggle('map-locked', !!vm.mapEditsLocked);
    if (ctx.els.regionDock) {
        ctx.els.regionDock.classList.toggle('map-locked', !!vm.mapEditsLocked);
    }

    ctx.els.emptyState.style.display = vm.lanes.length ? 'none' : 'block';
    // The ruler row measures LANES — with zero lanes it would be a
    // stray hairline and dead air above the + row. '' restores the
    // stylesheet's grid when lanes return.
    ctx.els.rulerRow.style.display = vm.lanes.length ? '' : 'none';

    // Ruler scrub: the frame facts this patch rendered, and its lock —
    // the engine refuses a seek under the recording gate.
    noteSeekVm(vm, !!vm.mapEditsLocked);

    patchPlayhead(vm, aux, anyRecording);
}
