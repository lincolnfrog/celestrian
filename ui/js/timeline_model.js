/**
 * Timeline Model — the JS mirror of src/timing.h. What is DEFINED here
 * is pinned to the same golden vectors as the C++ side
 * (shared/timing_golden.json: ui/js/tests/timeline_model_golden.test.mjs
 * and tests/timing_golden_tests.cc) — all but driftsByRoundingOnly,
 * which reads a published node and lives here because Q's subdivisions
 * do. Pure functions; samples are integers, and Math.floor matches C++
 * integer division.
 *
 * The other names this module exports are RE-EXPORTS kept for its
 * importers, and none is a timing.h mirror: the period law
 * (period_law.js, twin of src/period_law.h), the published-sequence
 * readers (sequence_program.js), and the law's providers over published
 * nodes (vm/published.js — no C++ twin, no golden).
 */

import { lcm, posMod } from './math_utils.js';
import { qtime, toSamples, fromSamples } from './qtime.js';
import { mapOffset } from './time_map.js';
import { ownPeriod } from './period_law.js';
import { publishedLaw } from './vm/published.js';

export { ownPeriod, periodContribution, periodDrifts, nodeDrifts, islandCycle }
    from './period_law.js';
export { activeSequenceSamples, sequenceProgram, sequenceVisits,
         sequenceTotalSamples, isAuditionWindow } from './sequence_program.js';
export { publishedLaw, frameLaw, publishedNodeDrifts, calculateStackLCM,
         computeEffectiveQuantum } from './vm/published.js';

/**
 * Capture-fold for a take recorded THROUGH an active map (time_maps.md
 * §3; timing::throughMapDest): the buffer index for heard-elapsed sample
 * `heardI` of a take anchored at heard offset `anchorOff` within the map
 * period, folded into the dense [0, commitCycle) buffer.
 * Precondition: 0 ≤ heardI < mapPeriod(map) ≤ commitCycle. Called by the
 * golden test only (the mock folds its captures inline).
 */
export function throughMapDest(heardI, anchorOff, map, commitCycle) {
    const originInner = mapOffset(map, anchorOff);
    const inner = mapOffset(map, anchorOff + heardI);
    let d = inner - originInner;
    if (commitCycle > 0) d = posMod(d, commitCycle);
    return d;
}

/**
 * A clip's origin as a musical offset from the island zero (Q12, D-T3;
 * timing::originQ): (origin − zero) / qSamples · Q, exact. Musical facts
 * project onto the Q frame through qtime.fromSamples; physical facts
 * (the clock, the zero, buffer lengths, Q in samples) stay in samples.
 * Called by the golden test only.
 */
export function originQ(originSamples, frameZero, qSamples) {
    return fromSamples(originSamples - frameZero, qSamples);
}

/**
 * A Q subdivision in samples, through THE rounding law (qtime.toSamples;
 * timing::subdivisionSamples): toSamples(1/d · Q). A bare
 * floor(quantum / d) is wrong wherever d does not divide Q.
 */
export function subdivisionSamples(quantum, denominator) {
    return toSamples(qtime(1, denominator), quantum);
}

/** Tolerance (fraction of Q) for snapping a committed duration. */
export const HYSTERESIS_THRESHOLD = 0.15;

/** Subdivisions of Q considered when committing or stopping a short take. */
export const SUBDIVISIONS = [2, 4, 8];

/**
 * The arm target (Q11; timing::armTarget): the next Q boundary at or
 * after the HEARD (latency-compensated) zero-relative position `rel`, on
 * the CONTEXT loop's grid.
 */
export function armTarget(rel, quantum, contextLoop) {
    if (quantum <= 0) return rel < 0 ? 0 : rel;
    if (!contextLoop || contextLoop <= 0) contextLoop = quantum;
    if (rel < 0) {
        // The heard clock behind the zero (a backward seek, a reloaded
        // session): the grid is periodic in the context loop — fold
        // forward by whole loops, answer there, fold back.
        const k = Math.ceil(-rel / contextLoop);
        return armTarget(rel + k * contextLoop, quantum, contextLoop) -
            k * contextLoop;
    }

    if (contextLoop === quantum) {
        if (rel % quantum === 0) return rel;
        return (Math.floor(rel / quantum) + 1) * quantum;
    }

    const effective = rel % contextLoop;
    const nextVisual = (effective % quantum === 0)
        ? effective
        : (Math.floor(effective / quantum) + 1) * quantum;
    const loopBase = Math.floor(rel / contextLoop) * contextLoop;
    // A mark at or past the context top is the top of the NEXT cycle:
    // the heard grid restarts there. Folding % contextLoop would put an
    // unsnapped context's final partial-Q boundary in the past.
    const offset = nextVisual >= contextLoop ? contextLoop : nextVisual;
    return loopBase + offset;
}

/**
 * LCM of a set of lengths, seeded with the quantum (`lcm_cases`). Each
 * value is rounded first — lengths can arrive with float jitter — and a
 * non-positive one is skipped.
 */
export function timelineLcm(durations, quantum) {
    let result = Math.round(quantum) || 0;
    for (const d of (durations || [])) {
        const dur = Math.round(d);
        if (dur > 0) result = lcm(result, dur);
    }
    return result;
}

/**
 * Does a drifting published node drift only by SAMPLE ROUNDING — its own
 * period is one of Q's subdivisions (a length a short take commits at)
 * where Q does not divide exactly? It still drifts, a few samples per Q,
 * so the period law keeps it out of every fold; but it is no musical
 * mismatch, and the rail does not badge it.
 */
export function driftsByRoundingOnly(node, quantum) {
    const q = Math.round(quantum || 0);
    const p = ownPeriod(node, publishedLaw(q));
    return q > 1 && p > 0 && SUBDIVISIONS.some(k => subdivisionSamples(q, k) === p);
}

/**
 * Where playback starts within a clip so that, when the context phase
 * equals the recording's start phase, the clip plays its first recorded
 * sample (timing::launchPointFor; docs/recording.md Example 2:
 * duration 8Q, startPhase 2Q → 6Q).
 */
export function launchPointFor(startPhase, duration) {
    if (duration <= 0) return 0;
    return (duration - (startPhase % duration)) % duration;
}

/**
 * The boundary at which a stop request is honoured
 * (timing::nextStopBoundary): the next whole multiple of Q, or — for a
 * take shorter than Q/2 — the smallest subdivision of Q still ahead of
 * the recorded length.
 */
export function nextStopBoundary(recordedLength, quantum) {
    let nextB = (Math.floor(recordedLength / quantum) + 1) * quantum;
    if (recordedLength < subdivisionSamples(quantum, 2)) {
        for (const d of SUBDIVISIONS) {
            const sub = subdivisionSamples(quantum, d);
            if (sub > recordedLength && sub < nextB) nextB = sub;
        }
    }
    return nextB;
}

/**
 * The hysteresis snap applied when a recording commits
 * (timing::snapCommittedDuration).
 *
 * @returns {{duration: number, loopEnd: number, snapped: boolean}}
 */
export function snapCommittedDuration(recordedLength, quantum) {
    const L = Math.round(recordedLength);
    const Q = Math.round(quantum);
    if (Q <= 0) return { duration: L, loopEnd: L, snapped: false };

    const floorMultiple = Math.floor(L / Q) * Q;
    const candidates = [floorMultiple, floorMultiple + Q];
    for (const d of SUBDIVISIONS) {
        const sub = subdivisionSamples(Q, d);
        if (sub > 0) candidates.push(sub);
    }

    let best = -1;
    let minDiff = Infinity;
    for (const b of candidates) {
        if (b <= 0) continue;
        const diff = Math.abs(L - b);
        if (diff < minDiff) {
            minDiff = diff;
            best = b;
        }
    }

    if (best !== -1 && minDiff < Math.floor(HYSTERESIS_THRESHOLD * Q)) {
        return { duration: best, loopEnd: best, snapped: true };
    }

    let loopEnd = Math.floor(L / Q) * Q;
    if (loopEnd === 0) loopEnd = subdivisionSamples(Q, 2);
    return { duration: L, loopEnd, snapped: false };
}
