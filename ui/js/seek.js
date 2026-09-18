/**
 * seek.js — the seek's arithmetic, shared by the ruler scrub and the
 * play start (docs/frame.md). The engine's `seekTransport` takes a
 * PHASE ADVANCE in samples, not a position: the engine reads no frame,
 * and only the view knows where the frame's zero is seated. So the
 * view turns a target phase — samples into the audible loop, as the
 * ruler draws it — into the advance that lands it, and tells the
 * engine which transport reading the advance was computed against so
 * the engine can correct for the clock having moved since the poll.
 *
 * The engine answers what it applied, and when. A scrub streams seeks
 * faster than the poll, and every seek moves the seated zero (every
 * origin rides it), so the view folds each answer back into its frame
 * facts (seekApplied) — the next seek in the same poll interval is
 * then computed against the truth, not a stale picture.
 */

import { posMod } from './math_utils.js';

/**
 * The advance that moves the playing phase to `targetSamples`.
 *
 * @param {number} targetSamples  the wanted phase, samples into the audible loop
 * @param {{rawClock:number, zero:number, loopSamples:number}|null} frame
 *        the latest frame facts: the raw transport, the seated zero
 *        and the audible loop's length (all samples)
 * @returns {number|null} the seekTransport argument, or null with no frame
 */
export function seekDelta(targetSamples, frame) {
    if (!frame) return null;
    const { rawClock, zero, loopSamples } = frame;
    if (![rawClock, zero, loopSamples, targetSamples].every(Number.isFinite)) return null;
    if (!(loopSamples > 0)) return null;
    const phase = posMod(rawClock - zero, loopSamples);
    // The smallest advance that lands the target: a whole loop either
    // way is the same phase and the same picture (every origin rides
    // the move, so nothing on screen changes but the cursor).
    let delta = posMod(targetSamples - phase, loopSamples);
    if (delta > loopSamples / 2) delta -= loopSamples;
    return Math.round(delta);
}

/**
 * The frame facts after the engine applied a seek: the zero (and with
 * it every origin) moved back by the advance, at the clock the engine
 * named. Answers `frame` itself when the result is not a seek answer.
 *
 * @param {object|null} frame   the facts the seek was computed against
 * @param {{advance:number, clock:number}|boolean} result  seekTransport's answer
 */
export function seekApplied(frame, result) {
    if (!frame || !result || typeof result !== 'object') return frame;
    const { advance, clock } = result;
    if (!Number.isFinite(advance) || !Number.isFinite(clock)) return frame;
    return { ...frame, rawClock: clock, zero: frame.zero - advance };
}
