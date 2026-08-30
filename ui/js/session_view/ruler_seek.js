/**
 * Ruler scrub (owner ruling 2026-08-27): the ruler is the transport's
 * seek surface. Click teleports the playhead; press-and-drag scrubs
 * continuously (no Q snap — the pointer is the truth). The gesture
 * sends `seekTransport` targets in the published-masterPos domain
 * (epoch-relative samples, folded on the audible cycle), which is the
 * one inverse of the display mapping below.
 *
 * DISPLAY → ENGINE DOMAIN (the inverse of view_model.js's playhead
 * mapping, one rule for every view): the audible loop occupies
 * [loopStartQ, loopStartQ + loopCycleQ) of the display frame — trim
 * view (Q13), root audition (§11.2), and the sole-group audition all
 * set loopStartQ/loopCycleQ; plain playback has loopStartQ = 0 and
 * loopCycleQ = cycleQ. A click CLAMPS into that span (owner ruling:
 * clicks outside an audition's bracket scrub to its edges, never end
 * the audition), and the engine target is the offset into the loop.
 *
 * Refusals mirror the engine: while any take is live or armed the
 * gesture is locked (class `seek-locked`, not-allowed cursor) and
 * nothing is sent — takes place audio by the clock. Pre-Q there is no
 * frame to seek in.
 *
 * The module is patch-fed (the drag_pin pattern): patch.js calls
 * noteSeekVm each poll with the latest vm facts; the DOM wiring runs
 * once from init.js. The hover line lives inside #ruler and re-attaches
 * lazily after patchRuler rebuilds (textContent = '' drops it).
 */

import { ctx } from './context.js';

/* Send cadence: at most one in-flight target per poll interval, with a
 * trailing send so the release position always lands. */
const SEND_MIN_MS = 45;

const seek = {
    vm: null,            // latest patch's frame facts
    locked: true,        // recording (or no frame yet) — gesture refused
    dragging: false,
    lastSendMs: 0,
    trailing: 0,         // timeout id for the trailing send
    pendingSamples: null,
    hoverLine: null,
};

/** Patch feed (every poll): the frame facts the next gesture maps with. */
export function noteSeekVm(vm, anyRecording) {
    seek.vm = vm;
    seek.locked = !!anyRecording || !vm || !vm.qEstablished;
    if (ctx.els && ctx.els.ruler) {
        ctx.els.ruler.classList.toggle('seek-locked', !!anyRecording);
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
 * @param {object} vm    view model (quantum, cycleQ, loopStartQ, loopCycleQ, qEstablished)
 */
export function seekTargetFromFrac(frac, vm) {
    if (!vm || !vm.qEstablished) return null;
    const cycleQ = vm.cycleQ;
    const quantum = vm.quantum;
    if (!(cycleQ > 0) || !(quantum > 0) || !Number.isFinite(frac)) return null;

    const loopStartQ = vm.loopStartQ || 0;
    const loopLenQ = vm.loopCycleQ > 0 ? vm.loopCycleQ : cycleQ;

    // Pointer position in display Q, clamped into the audible loop's
    // span. The very end of the loop is a legal target — the engine
    // folds it to the loop top (rel == cycle → 0).
    let dQ = frac * cycleQ;
    dQ = Math.min(Math.max(dQ, loopStartQ), loopStartQ + loopLenQ);

    const relQ = dQ - loopStartQ;
    return {
        samples: relQ * quantum,
        displayQ: loopStartQ + (relQ >= loopLenQ ? 0 : relQ),
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
        // NO preventDefault here: it would suppress the native focus
        // change, so a click on the ruler stopped BLURRING an open
        // rename editor (its commit-on-blur never fired — caught by
        // the phase-3 rename e2e). Text selection is prevented in CSS
        // (user-select: none on #ruler) instead.
        seek.dragging = true;
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
