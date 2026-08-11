/**
 * Timeline Model — single source of truth for Celestrian timing math (JS side).
 *
 * Mirrors `src/timing.h`; both are pinned to the same golden vectors in
 * `shared/timing_golden.json` (see ui/js/tests/timeline_model_golden.test.mjs
 * and tests/timing_golden_tests.cc).
 *
 * Rules for this module:
 *  - Pure functions only. No DOM, no backend calls, no state.
 *  - Sample-domain values are integers; use Math.floor to match C++ integer
 *    division. Pixel-domain values are suffixed `Px`.
 *  - The UI renderer AND the mock backend both import from here, so the mock
 *    cannot drift from the math the UI (and, via golden vectors, the C++
 *    engine) uses.
 */

import { lcm } from './math_utils.js';
import { qtime, toSamples, fromSamples } from './qtime.js';
import { flatSegPeriod, mapOffset } from './time_map.js';

// Re-exported for consumers that fold periods on top of this module's
// cycle math (view_model.js); the canonical home is math_utils.js.
export { lcm };

/**
 * Capture-fold for a take recorded THROUGH an active map (time_maps.md
 * §3), JS mirror of timing.h throughMapDest: the buffer destination
 * index for heard-elapsed sample heardI of a take anchored at heard
 * offset anchorOff within the map period, folded into the dense
 * [0, commitCycle) buffer. Segment-general.
 * Precondition: 0 ≤ heardI < mapPeriod(map) ≤ commitCycle.
 */
export function throughMapDest(heardI, anchorOff, map, commitCycle) {
    const originInner = mapOffset(map, anchorOff);
    const inner = mapOffset(map, anchorOff + heardI);
    let d = inner - originInner;
    if (commitCycle > 0) d = ((d % commitCycle) + commitCycle) % commitCycle;
    return d;
}

// === The physical/musical boundary (Q12 / D-T3), JS mirror of timing.h ===
// Musical facts project onto the island's Q frame through the one law
// (qtime.js fromSamples); physical facts (clock, epoch, buffer lengths,
// q_samples) stay in samples. These back the device-independent metadata
// the save format serializes.

/**
 * A clip's origin as a musical offset from the island epoch (D-T3):
 * (origin − epoch) / qSamples · Q. Exact; unsnapped origins yield an
 * ugly-but-exact rational (D-T5). Mirrors timing::originQ.
 */
export function originQ(originSamples, epochSamples, qSamples) {
    return fromSamples(originSamples - epochSamples, qSamples);
}

/** A period / duration as musical time (D-T3). Mirrors timing::periodQ. */
export function periodQ(durationSamples, qSamples) {
    return fromSamples(durationSamples, qSamples);
}

/**
 * A Q subdivision boundary in samples, through THE rounding law
 * (qtime.js): toSamples(1/d · Q). Mirrors timing::subdivisionSamples —
 * replaces bare `Math.floor(quantum / d)`, which silently floored when
 * Q wasn't divisible (Q12 / D-T4).
 */
export function subdivisionSamples(quantum, denominator) {
    return toSamples(qtime(1, denominator), quantum);
}

/** Tolerance (fraction of Q) for snapping a committed duration. */
export const HYSTERESIS_THRESHOLD = 0.15;

/** Subdivisions of Q considered when committing/stopping short recordings. */
export const SUBDIVISIONS = [2, 4, 8];

/**
 * The arm target (Q11 ruling): the next Q boundary at/after the HEARD
 * (latency-compensated) epoch-relative position `rel`, on the CONTEXT
 * loop's grid. Mirrors timing::armTarget — see its header comment for
 * why no anticipatory-deferral window exists on top of this.
 */
export function armTarget(rel, quantum, contextLoop) {
    if (rel < 0) rel = 0;
    if (quantum <= 0) return rel;
    if (!contextLoop || contextLoop <= 0) contextLoop = quantum;

    if (contextLoop === quantum) {
        if (rel % quantum === 0) return rel;
        return (Math.floor(rel / quantum) + 1) * quantum;
    }

    const effective = rel % contextLoop;
    const nextVisual = (effective % quantum === 0)
        ? effective
        : (Math.floor(effective / quantum) + 1) * quantum;
    const loopBase = Math.floor(rel / contextLoop) * contextLoop;
    // A mark at/past the context top = the top of the NEXT cycle — the
    // heard grid restarts there (folding % contextLoop put an unsnapped
    // context's final-partial-Q boundary in the PAST; fixed with the
    // through-window vectors, phase 2).
    const offset = nextVisual >= contextLoop ? contextLoop : nextVisual;
    return loopBase + offset;
}

/**
 * LCM of a set of durations, seeded with the quantum.
 * Mirrors AudioEngine::calculateTimelineLength's core loop.
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
 * A clip's contribution (samples) to any whole-Q cycle math (frame LCM,
 * composite duration). Normally-committed clips have whole-Q durations
 * and contribute them unchanged. A Q13-trimmed definer's buffer is a
 * multiple of the OLD Q — incommensurate with the grid its own window
 * defined — and LCM-ing the raw duration exploded the display frame
 * ("142336Q", waveforms vanished behind the maxTiles guards; field
 * 2026-07-19b). Its whole-Q truth is the WINDOW (exactly 1Q by
 * construction); ceil-to-Q is the defensive fallback so even a bypassed
 * incommensurate clip yields a finite frame. Audio is untouched — the
 * engine wraps the transport on the EFFECTIVE cycle, which already uses
 * the window.
 */
export function commensuratePeriod(node, effectiveQ) {
    const d = Math.round(node.duration || 0);
    const q = Math.round(effectiveQ || 0);
    if (!(d > 0) || !(q > 1)) return d;
    // LAW 13 AMENDED (2026-07-19k): an ACTIVE map IS the displayed
    // material, so the clip contributes the map period — the summed
    // segment lengths, or the loop window as the map's single-segment
    // form — whenever it is a real whole-Q shortening. Incommensurate
    // (free-cut ⚠) maps fall through to the finite fallbacks below.
    if (!node.loopBypassed) {
        let p = 0;
        if (node.segments && node.segments.length >= 4) {
            p = flatSegPeriod(node.segments);
        } else {
            p = (node.loopEnd || 0) - (node.loopStart || 0);
        }
        p = Math.round(p);
        if (p > 0 && p < d && p % q === 0) return p;
    }
    if (d % q === 0) return d;
    const winLen = Math.round((node.loopEnd || 0) - (node.loopStart || 0));
    if (!node.loopBypassed && winLen > 0 && winLen % q === 0) return winLen;
    return Math.ceil(d / q) * q;
}

/**
 * LCM for a stack's children (recursive for nested stacks).
 * A nested stack contributes its internal LCM as its composite duration.
 * Clip contributions are COMMENSURATE (see commensuratePeriod): the
 * composite stays a whole-Q fact even over a Q13-trimmed take.
 */
export function calculateStackLCM(stackNodes, effectiveQ) {
    let stackLCM = effectiveQ;
    let maxDuration = 0;

    (stackNodes || []).forEach(child => {
        if (child.isRecording) return; // Skip recording clips
        // One-shots excluded (Q5): period := context cycle — they adopt
        // the scope's cycle, never extend it (engine fold parity).
        if (child.periodSource === 'context') return;

        if (child.type === 'clip' && child.duration > 0) {
            const p = commensuratePeriod(child, effectiveQ);
            stackLCM = lcm(Math.round(stackLCM), p);
            maxDuration = Math.max(maxDuration, p);
        } else if (child.type === 'stack' && child.nodes) {
            const childLCM = calculateStackLCM(child.nodes, effectiveQ);
            stackLCM = lcm(Math.round(stackLCM), Math.round(childLCM));
            maxDuration = Math.max(maxDuration, childLCM);
        }
    });

    return Math.max(stackLCM, maxDuration);
}

/**
 * The effective quantum for a node tree: the minimum positive
 * `effectiveQuantum` reported by any node, or 1 if none is established.
 */
export function computeEffectiveQuantum(nodes) {
    let effectiveQ = Infinity;

    const visit = (list) => (list || []).forEach(n => {
        if (n.effectiveQuantum > 0 && n.effectiveQuantum < effectiveQ) {
            effectiveQ = n.effectiveQuantum;
        }
        if (n.type === 'stack' && n.nodes) visit(n.nodes);
    });
    visit(nodes);

    return effectiveQ === Infinity ? 1 : effectiveQ;
}

/**
 * Where playback starts within a clip so that when the context phase equals
 * the recording start phase, the clip plays its first recorded sample.
 * docs/recording.md Example 2: duration=8Q, startPhase=2Q -> launch=6Q.
 */
export function launchPointFor(startPhase, duration) {
    if (duration <= 0) return 0;
    return (duration - (startPhase % duration)) % duration;
}

/**
 * Normalized playhead position (0..1) for a clip.
 */
export function playheadPercent(masterPos, launchPoint, duration) {
    if (duration <= 0) return 0;
    return ((masterPos + launchPoint) % duration) / duration;
}

/**
 * The boundary at which a stop request is honored: the next clean multiple of
 * Q, or — for short recordings (L < Q/2) — the smallest subdivision of Q that
 * is still ahead of the recorded length. Mirrors timing::nextStopBoundary.
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
 * Hysteresis snap applied when a recording commits.
 * Mirrors timing::snapCommittedDuration.
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

/**
 * Ghost tile positions for a looping clip: fills the timeline with
 * clip-width tiles, skipping the region occupied by the main clip.
 * Pure extraction of the ghost renderer's tiling loop.
 *
 * @returns {Array<{x: number, width: number}>} tile positions in px
 */
export function computeGhostTiles({ clipStartPx, clipWidthPx, timelineWidthPx, maxTiles = 100 }) {
    const tiles = [];
    if (clipWidthPx <= 0) return tiles;

    const clipEndPx = clipStartPx + clipWidthPx;
    let x = 0;

    while (x < timelineWidthPx - 5 && tiles.length < maxTiles) {
        // Skip if this position overlaps the main clip (small tolerance)
        const overlapsMainClip = (x + clipWidthPx > clipStartPx + 1) && (x < clipEndPx - 1);
        if (overlapsMainClip) {
            x = clipEndPx;
            continue;
        }

        // Ghost width may be clipped at the timeline end
        let width = clipWidthPx;
        if (x + clipWidthPx > timelineWidthPx) width = timelineWidthPx - x;

        if (width < 5) {
            x += clipWidthPx;
            continue;
        }

        tiles.push({ x, width });
        x += clipWidthPx;
    }

    return tiles;
}
