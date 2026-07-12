/**
 * Playhead dead-reckoning clock (docs/ui_overhaul.md law 10 coda).
 *
 * The published masterPos arrives every ~50ms; drawing it with a CSS
 * glide lags the target by the transition time, so the sweep visually
 * wrapped ~5% before the loop end and restarted past zero (field
 * 2026-07-11). Instead, between polls the playhead ADVANCES at the
 * estimated transport velocity and wraps EXACTLY at the audible cycle;
 * each poll corrects the position. Velocity is estimated from observed
 * masterPos deltas — never assumed — so a static mock scene stays
 * static and a manual seek reads as a teleport, not a burst of speed.
 *
 * Everything here is pure (unit-tested); the rAF loop lives in the
 * patch layer.
 */

/** Forward wrap-aware delta: how far target moved past `last` in [0, L). */
export function forwardDelta(targetQ, lastQ, loopQ) {
    const d = targetQ - lastQ;
    if (!(loopQ > 0)) return d;
    return ((d % loopQ) + loopQ) % loopQ;
}

/**
 * Blend an instantaneous velocity observation into the estimate.
 * `deltaQ` is the forward wrap-aware target movement over `dtMs`.
 * Movement far beyond real-time playback (2× nominal) is a TELEPORT —
 * a seek or a test's setMasterPos — and must not become velocity.
 * Returns { vel, teleport }.
 */
export function estimateVelocity(prevVel, deltaQ, dtMs, nominalQperMs) {
    if (!(dtMs > 0) || !(nominalQperMs > 0)) return { vel: prevVel, teleport: false };
    const inst = deltaQ / dtMs;
    if (inst < 0 || inst > 2 * nominalQperMs) return { vel: 0, teleport: true };
    return { vel: 0.6 * prevVel + 0.4 * inst, teleport: false };
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
        e = ((e % loopQ) + loopQ) % loopQ;
        if (e > loopQ / 2) e -= loopQ;
    }
    if (Math.abs(e) > maxErrQ) return targetQ;
    return posQ + e * 0.3;
}
