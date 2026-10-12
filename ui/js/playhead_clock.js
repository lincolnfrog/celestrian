/**
 * Playhead dead-reckoning clock (docs/session_view.md law 10 coda).
 *
 * Between polls the playhead ADVANCES at the estimated transport
 * velocity and wraps EXACTLY at the audible cycle; each poll corrects
 * it. (A CSS glide toward each polled position lags by its transition
 * time, so the sweep would wrap before the loop end and restart past
 * zero.) Velocity is estimated from observed masterPos deltas, never
 * assumed: a static scene stays static, and a seek reads as a
 * teleport, not a burst of speed.
 *
 * Pure; the rAF loop lives in the patch layer.
 */
import { posMod } from './math_utils.js';

// Velocity blend weights: how much of the running estimate survives each
// observation vs. how much the new instantaneous sample contributes. A
// light low-pass — enough to smooth poll jitter without lagging real
// tempo changes by more than a couple of polls. Must sum to 1.
const VEL_KEEP = 0.6;
const VEL_BLEND = 0.4;

// Movement beyond this multiple of nominal real-time velocity is a
// TELEPORT (a seek or a test's setMasterPos), never evidence of speed.
const TELEPORT_VEL_FACTOR = 2;

// Per-poll correction easing: fraction of the (wrap-aware) error closed
// each poll. Small enough that corrections read as a glide, large
// enough to converge within a few polls.
const CORRECT_EASE = 0.3;

/** Forward wrap-aware delta: how far target moved past `last` in [0, L). */
export function forwardDelta(targetQ, lastQ, loopQ) {
    const d = targetQ - lastQ;
    if (!(loopQ > 0)) return d;
    return posMod(d, loopQ);
}

/**
 * Blend an instantaneous velocity observation into the estimate.
 * `deltaQ` is the forward wrap-aware target movement over `dtMs`; a
 * teleport (TELEPORT_VEL_FACTOR) never becomes velocity.
 * Returns { vel, teleport }.
 */
export function estimateVelocity(prevVel, deltaQ, dtMs, nominalQperMs) {
    if (!(dtMs > 0) || !(nominalQperMs > 0)) return { vel: prevVel, teleport: false };
    const inst = deltaQ / dtMs;
    if (inst < 0 || inst > TELEPORT_VEL_FACTOR * nominalQperMs) {
        return { vel: 0, teleport: true };
    }
    return { vel: VEL_KEEP * prevVel + VEL_BLEND * inst, teleport: false };
}

/** Advance a position by vel·dt, wrapping EXACTLY at the loop boundary. */
export function advancePosition(posQ, velQperMs, dtMs, loopQ) {
    let p = posQ + velQperMs * dtMs;
    if (loopQ > 0 && p >= loopQ) p = p % loopQ;
    return p;
}

/**
 * Per-poll correction: ease the rendered position toward the published
 * target (wrap-aware shortest path); a large error snaps outright.
 */
export function correctPosition(posQ, targetQ, loopQ, maxErrQ = 0.2) {
    let e = targetQ - posQ;
    if (loopQ > 0) {
        e = posMod(e, loopQ);
        if (e > loopQ / 2) e -= loopQ;
    }
    if (Math.abs(e) > maxErrQ) return targetQ;
    return posQ + e * CORRECT_EASE;
}
