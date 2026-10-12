/**
 * Ruler scrub: the ruler is the transport's seek surface. A click
 * teleports the playhead; press-and-drag scrubs continuously (no Q snap
 * — the pointer is the truth). The gesture hands the app a target PHASE
 * — samples into the audible loop — and the app turns it into the phase
 * advance `seekTransport` takes (seek.js; the engine reads no frame,
 * docs/frame.md).
 *
 * DISPLAY → ENGINE (the inverse of the view model's playhead mapping,
 * one rule for every view): the audible loop occupies its runs of the
 * display frame (loop_runs.js — one span from loopStartQ for plain
 * playback, the trim view and the auditions; several for a definer
 * selection with cuts). A press CLAMPS into the loop — outside an
 * audition's bracket it scrubs to the bracket's edge and never ends the
 * audition; in a cut it lands on the seam — and the target is the
 * offset into the loop.
 *
 * Refusals mirror the engine: while any take is live or armed the
 * gesture is locked (`seek-locked`) and nothing is sent — takes place
 * audio by the clock. Before Q there is no frame to seek in.
 *
 * Patch-fed: patch.js calls noteSeekVm each poll; the DOM wiring runs
 * once from init.js. The hover line lives inside #ruler and re-attaches
 * after patchRuler rebuilds it away.
 */

import { ctx } from './context.js';
import { guardGesture } from './sv_util.js';
import { loopRuns, runsLength, heardAt, placeAt } from './loop_runs.js';

/* Send cadence: at most one in-flight target per poll interval, with a
 * trailing send so the release position always lands. */
const SEND_MIN_MS = 45;

const seek = {
    vm: null,            // latest patch's frame facts
    locked: true,        // a take live or armed, or no frame yet — gesture refused
    dragging: false,
    lastSendMs: 0,
    trailing: 0,         // timeout id for the trailing send
    pendingSamples: null,
    hoverLine: null,
};

/** Patch feed (every poll): the frame facts the next gesture maps
 * with, and `takeActive` — a take is live or armed, so the engine
 * refuses a seek and the ruler locks. */
export function noteSeekVm(vm, takeActive) {
    seek.vm = vm;
    seek.locked = !!takeActive || !vm || !vm.qEstablished;
    if (ctx.els && ctx.els.ruler) {
        ctx.els.ruler.classList.toggle('seek-locked', !!takeActive);
        ctx.els.ruler.classList.toggle('seekable', !seek.locked);
    }
}

/**
 * Pure display→engine mapping for a pointer at `frac` of the ruler's
 * width (unclamped; <0 and >1 arrive from drags past the edges).
 * Returns { samples, displayQ } — the seekTransport target and where
 * the playhead will show it — or null when there is nothing to seek
 * (no frame yet, or degenerate geometry). Exported for unit tests.
 *
 * @param {number} frac  pointer x as a fraction of the ruler width
 * @param {object} vm    view model (quantum, cycleQ, qEstablished, and
 *                       the loop: loopStartQ, loopCycleQ, loopRunsQ)
 */
export function seekTargetFromFrac(frac, vm) {
    if (!vm || !vm.qEstablished) return null;
    const cycleQ = vm.cycleQ;
    const quantum = vm.quantum;
    if (!(cycleQ > 0) || !(quantum > 0) || !Number.isFinite(frac)) return null;

    // The pointer's Q into the loop (heardAt clamps into it). The very
    // end of the loop is a legal target: the engine folds it to the top,
    // and it shows there.
    const runs = loopRuns(vm);
    const relQ = heardAt(runs, frac * cycleQ);
    return {
        samples: relQ * quantum,
        displayQ: relQ >= runsLength(runs) ? runs[0][0] : placeAt(runs, relQ),
    };
}

/* ---------- DOM wiring (once, from init.js) ---------- */

function fracFromEvent(e) {
    const rect = ctx.els.ruler.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return (e.clientX - rect.left) / rect.width;
}

/** The hover line: a thin indicator inside #ruler that follows the
 * pointer — immediate feedback while the playhead converges via polls.
 * patchRuler rebuilds wipe it; re-attach lazily. */
function hoverLineEl() {
    if (!seek.hoverLine) {
        const line = document.createElement('div');
        line.className = 'seek-hover';
        seek.hoverLine = line;
    }
    if (!seek.hoverLine.isConnected) ctx.els.ruler.appendChild(seek.hoverLine);
    return seek.hoverLine;
}

function showHover(frac) {
    const t = seekTargetFromFrac(frac, seek.vm);
    if (!t) { hideHover(); return; }
    const line = hoverLineEl();
    line.style.left = (t.displayQ / seek.vm.cycleQ * 100) + '%';
    line.style.display = 'block';
}

function hideHover() {
    if (seek.hoverLine) seek.hoverLine.style.display = 'none';
}

/** Throttled sender: immediate when the window allows, else one
 * trailing send — the release position must always land. */
function sendTarget(samples) {
    seek.pendingSamples = samples;
    const now = performance.now();
    if (now - seek.lastSendMs >= SEND_MIN_MS) {
        flushSend();
    } else if (!seek.trailing) {
        seek.trailing = setTimeout(flushSend, SEND_MIN_MS - (now - seek.lastSendMs));
    }
}

function flushSend() {
    if (seek.trailing) { clearTimeout(seek.trailing); seek.trailing = 0; }
    if (seek.pendingSamples === null) return;
    const samples = seek.pendingSamples;
    seek.pendingSamples = null;
    seek.lastSendMs = performance.now();
    if (ctx.cb.onSeek) ctx.cb.onSeek(samples);
}

function scrubTo(e) {
    const frac = fracFromEvent(e);
    if (frac === null) return;
    showHover(frac);
    const t = seekTargetFromFrac(frac, seek.vm);
    if (t) sendTarget(t.samples);
}

export function wireRulerSeek() {
    const ruler = ctx.els.ruler;

    ruler.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        if (seek.locked) return;
        // No preventDefault: the press must still blur an open rename
        // editor (it commits on blur). CSS stops the text selection
        // (#ruler user-select).
        seek.dragging = true;
        // Lost capture / window blur ends the scrub like a release.
        seek.guard = guardGesture(ruler, () => {
            seek.dragging = false;
            flushSend();
            hideHover();
        });
        ruler.setPointerCapture(e.pointerId);
        scrubTo(e);
    });

    ruler.addEventListener('pointermove', e => {
        if (seek.dragging) { scrubTo(e); return; }
        // Plain hover: show where a click would land (no sends).
        if (seek.locked) { hideHover(); return; }
        const frac = fracFromEvent(e);
        if (frac !== null) showHover(frac);
    });

    const end = e => {
        if (!seek.dragging) return;
        seek.dragging = false;
        if (seek.guard) { seek.guard(); seek.guard = null; }
        try { ruler.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
        // The release position is the seek that matters — flush it.
        scrubTo(e);
        flushSend();
        hideHover();
    };
    ruler.addEventListener('pointerup', end);
    ruler.addEventListener('pointercancel', end);
    ruler.addEventListener('pointerleave', () => {
        if (!seek.dragging) hideHover();
    });
}
