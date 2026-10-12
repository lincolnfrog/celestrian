/**
 * Playhead animator (idle/playing only).
 *
 * Between polls the playhead DEAD-RECKONS at the estimated transport
 * velocity and wraps EXACTLY at the audible loop (vm.loopCycleQ) — a CSS
 * glide lags its target by the transition time, so the sweep would wrap
 * early and restart past zero. Window cursors ride the same clock.
 * While RECORDING the animator is off: the 140 ms glide keeps the
 * playhead in step with the recording bar's edge, and a take never
 * wraps.
 *
 * The reckoning runs in LOOP coordinates — Q into the audible loop — and
 * is drawn through the loop's place on the frame: one span from
 * vm.loopStartQ, or the runs of a cut definer selection (vm.loopRunsQ,
 * loop_runs.js), whose cuts the playhead never visits.
 */

import {
    forwardDelta, estimateVelocity, advancePosition, correctPosition,
} from '../playhead_clock.js';
import { posMod } from '../math_utils.js';
import { ctx } from './context.js';
import { heardAt, placeAt } from './loop_runs.js';

/* A hidden tab delivers one giant rAF delta on refocus; clamping it
 * keeps the dead-reckoner from teleporting. */
const HIDDEN_TAB_CLAMP_MS = 100;

const anim = {
    raf: 0, running: false, posQ: 0, velQperMs: 0,
    loopQ: 0, loopStartQ: 0, runs: null, cycleQ: 1, timelineW: 0, lastFrame: 0,
    lastPollQ: null, lastPollMs: 0,
    zeroRelQ: null,  // the frame zero past the island zero, last patch (Q)
};

/** True while the dead-reckoner owns the playhead and the window
 * cursors (patchWinCursor branches on it). */
export function isAnimRunning() { return anim.running; }

/** Re-measure the ruler width the animator draws against: it is cached
 * between polls, and a zoom must not run a poll on the old scale. */
export function refreshTimelineWidth() {
    anim.timelineW = ctx.els.ruler.offsetWidth;
}

/** Feed one poll into the dead-reckoner: correct position, re-estimate
 * velocity, cache the frame geometry, and (re)start the rAF loop. */
export function animatorPoll(vm, aux) {
    const now = performance.now();
    const nominal = aux.sampleRate > 0 && vm.quantum > 1
        ? aux.sampleRate / vm.quantum / 1000 : 0;
    const runs = vm.loopRunsQ || null;
    const relQ = runs ? heardAt(runs, vm.playheadQ)
                      : vm.playheadQ - (vm.loopStartQ || 0);
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
    anim.runs = runs;
    anim.cycleQ = vm.cycleQ;
    anim.timelineW = ctx.els.ruler.clientWidth;
    if (!anim.running) {
        anim.running = true;
        anim.lastFrame = now;
        anim.raf = requestAnimationFrame(animTick);
    }
}

/**
 * THE FRAME MOVED, NOT THE CLOCK: called on every patch before any poll
 * is fed (patch.js). The reckoned positions are measured from the
 * frame's zero, and the zero moves on its own (a re-seat, a pin taken
 * or released — frame.md §1): that is the zero moving RELATIVE TO THE
 * ISLAND ZERO. Shift the reckoned position and the poll history by
 * exactly it, the shortest way round the loop, so a poll measures only
 * the transport and a re-render between polls needs nothing more — fed
 * as a poll, its stale clock would read as a jump back and stall the
 * sweep. A seek moves the island zero WITH the frame: no frame move, it
 * reads as the teleport it is (session_view.md law 14).
 */
export function animatorFrame(vm) {
    const zRel = vm.quantum > 0 && Number.isFinite(vm.frameZero) &&
        Number.isFinite(vm.rootFrame)
        ? (vm.frameZero - vm.rootFrame) / vm.quantum : null;
    const prev = anim.zeroRelQ;
    anim.zeroRelQ = zRel;
    if (!anim.running || anim.lastPollQ === null || prev === null ||
        zRel === null || zRel === prev) return;
    const L = vm.loopCycleQ;
    let d = prev - zRel;  // the zero moved +x: the playhead −x
    if (L > 0) d = posMod(d + L / 2, L) - L / 2;
    anim.posQ = L > 0 ? posMod(anim.posQ + d, L) : anim.posQ + d;
    anim.lastPollQ = L > 0 ? posMod(anim.lastPollQ + d, L) : anim.lastPollQ + d;
}

/** Halt the rAF loop and forget the poll history (recording/paused —
 * the CSS glide takes over). */
export function stopAnimator() {
    if (!anim.running) return;
    anim.running = false;
    anim.lastPollQ = null;
    cancelAnimationFrame(anim.raf);
}

/** One animation frame: advance and draw the playhead, then every
 * window cursor — same clock, own phase, wrapping at its own window
 * (`_startQ` / `_lenQ` / `_cycleQ` / `_phase`: lane_body's expando
 * table). */
function animTick(t) {
    if (!anim.running) return;
    const dt = Math.min(t - anim.lastFrame, HIDDEN_TAB_CLAMP_MS);
    anim.lastFrame = t;
    anim.posQ = advancePosition(anim.posQ, anim.velQperMs, dt, anim.loopQ);
    const frameQ = anim.runs ? placeAt(anim.runs, anim.posQ)
                             : anim.loopStartQ + anim.posQ;
    const left = (frameQ / anim.cycleQ) * anim.timelineW;
    ctx.els.playhead.style.left = left + 'px';
    ctx.els.playhead._left = left;
    document.querySelectorAll('.win-cursor').forEach(el => {
        if (!(el._lenQ > 0)) return;
        el._phase = advancePosition(el._phase || 0, anim.velQperMs / el._lenQ, dt, 1);
        el.style.left = ((el._startQ + el._phase * el._lenQ) / el._cycleQ) * 100 + '%';
    });
    anim.raf = requestAnimationFrame(animTick);
}
