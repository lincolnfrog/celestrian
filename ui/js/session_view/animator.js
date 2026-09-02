/**
 * Playhead animator (idle/playing only).
 *
 * Between 50ms polls the playhead DEAD-RECKONS at the estimated
 * transport velocity and wraps EXACTLY at the audible cycle
 * (vm.loopCycleQ) — a CSS glide lags the target by the transition
 * time, so the sweep would visually wrap early and restart past zero.
 * Window cursors ride the same clock
 * (heard time advances at the same rate everywhere). While RECORDING
 * the animator is off and the 140ms glide keeps the playhead in
 * lockstep with the recording bar's edge (law 10) — there is no wrap
 * to touch during a take.
 */

import {
    forwardDelta, estimateVelocity, advancePosition, correctPosition,
} from '../playhead_clock.js';
import { ctx } from './context.js';

/* A hidden tab delivers one giant rAF delta on refocus; clamping it
 * keeps the dead-reckoner from teleporting. */
const HIDDEN_TAB_CLAMP_MS = 100;

const anim = {
    raf: 0, running: false, posQ: 0, velQperMs: 0,
    loopQ: 0, loopStartQ: 0, cycleQ: 1, timelineW: 0, lastFrame: 0,
    lastPollQ: null, lastPollMs: 0,
};

/** True while the 60fps dead-reckoner owns the playhead (and window
 * cursors) — patchWinCursor branches on this. */
export function isAnimRunning() { return anim.running; }

/** Re-measure the ruler width the animator draws against. The animator
 * caches it between polls — zoom must refresh it immediately or the
 * playhead runs on the old scale for up to 50ms. */
export function refreshTimelineWidth() {
    anim.timelineW = ctx.els.ruler.offsetWidth;
}

/** Feed one poll into the dead-reckoner: correct position, re-estimate
 * velocity, cache the frame geometry, and (re)start the rAF loop. */
export function animatorPoll(vm, aux) {
    const now = performance.now();
    const nominal = aux.sampleRate > 0 && vm.quantum > 1
        ? aux.sampleRate / vm.quantum / 1000 : 0;
    // The audible loop may not start at frame 0 (Q13 trim view: the
    // playhead loops over the SELECTION, [loopStartQ, loopStartQ +
    // loopCycleQ)). The wrap math (forwardDelta/advance/correct) runs in
    // LOOP coordinates; drawing adds the offset back.
    const relQ = vm.playheadQ - (vm.loopStartQ || 0);
    if (anim.lastPollQ === null) {
        anim.posQ = relQ;
        anim.velQperMs = 0; // ramps up from observation, never assumed
    } else {
        const d = forwardDelta(relQ, anim.lastPollQ, vm.loopCycleQ);
        const { vel, teleport } = estimateVelocity(
            anim.velQperMs, d, now - anim.lastPollMs, nominal);
        anim.velQperMs = vel;
        anim.posQ = teleport ? relQ
            : correctPosition(anim.posQ, relQ, vm.loopCycleQ);
    }
    anim.lastPollQ = relQ;
    anim.lastPollMs = now;
    anim.loopQ = vm.loopCycleQ;
    anim.loopStartQ = vm.loopStartQ || 0;
    anim.cycleQ = vm.cycleQ;
    anim.timelineW = ctx.els.ruler.clientWidth;
    if (!anim.running) {
        anim.running = true;
        anim.lastFrame = now;
        anim.raf = requestAnimationFrame(animTick);
    }
}

/** Halt the rAF loop and forget the poll history (recording/paused —
 * the 140ms CSS glide takes over). */
export function stopAnimator() {
    if (!anim.running) return;
    anim.running = false;
    anim.lastPollQ = null;
    cancelAnimationFrame(anim.raf);
}

/** One 60fps frame: advance and draw the playhead, then every window
 * cursor (same clock, own phase, wrap at their own window — the
 * cursors' _startQ/_lenQ/_cycleQ/_phase expandos are written by
 * patchWinCursor in lane_body.js). The global .win-cursor query per
 * frame is a documented smell, kept as-is. */
function animTick(t) {
    if (!anim.running) return;
    const dt = Math.min(t - anim.lastFrame, HIDDEN_TAB_CLAMP_MS);
    anim.lastFrame = t;
    anim.posQ = advancePosition(anim.posQ, anim.velQperMs, dt, anim.loopQ);
    const frameQ = anim.loopStartQ + anim.posQ; // loop coords → frame coords
    ctx.els.playhead.style.left = (frameQ / anim.cycleQ) * anim.timelineW + 'px';
    ctx.els.playhead._left = (frameQ / anim.cycleQ) * anim.timelineW;
    // Window cursors: same clock, own phase, wrap at their own window
    document.querySelectorAll('.win-cursor').forEach(el => {
        if (!(el._lenQ > 0)) return;
        el._phase = advancePosition(el._phase || 0, anim.velQperMs / el._lenQ, dt, 1);
        el.style.left = ((el._startQ + el._phase * el._lenQ) / el._cycleQ) * 100 + '%';
    });
    anim.raf = requestAnimationFrame(animTick);
}
