/**
 * Live recording peaks, TIME-INDEXED (docs/ui_overhaul.md).
 *
 * The naive approach — push one peak per poll tick — couples waveform
 * geometry to poll cadence: the bar's width tracks the engine's
 * `duration` (real time), so whenever polls jitter or drop, the peak
 * count and elapsed time diverge and the stretched-to-fit content
 * visibly drifts sideways while recording (field report 2026-07-10).
 *
 * Here each sample lands at an index derived from `duration` itself
 * (PEAKS_PER_SECOND resolution), so a peak's position in the array — and
 * therefore on screen — is a pure function of WHEN it happened. Skipped
 * polls leave gaps that are back-filled with the current value; repeated
 * polls at the same index max-pool.
 */

export const PEAKS_PER_SECOND = 50;

/**
 * Smoothed display boost for a LIVE waveform. The committed renderer
 * normalizes a clip to its peak (boost = 0.95/max, capped 8×); drawing
 * the live bar un-normalized popped to full frame at commit, and
 * re-normalizing per poll pumped the whole waveform on every new max.
 * The ratchet: since the running max only ever RISES, the target boost
 * only ever FALLS — easing toward it (30%/poll) settles gently, needs no
 * extra hysteresis, and CONVERGES to the committed value, so the commit
 * handoff is seamless by construction.
 */
export function liveBoost(prevBoost, peaks) {
    let max = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
    const target = max > 0 ? Math.min(0.95 / max, 8) : 1;
    if (prevBoost === undefined || prevBoost === null) return target;
    return prevBoost + (target - prevBoost) * 0.3;
}

/**
 * Record `peak` as the level at `durationSamples` into the take.
 * Mutates and returns `arr` (the lane's live peak array).
 */
export function appendLivePeak(arr, durationSamples, sampleRate, peak) {
    const sr = sampleRate > 0 ? sampleRate : 44100;
    const p = Math.min(1, Math.abs(peak) || 0);
    const idx = Math.max(0, Math.floor((durationSamples / sr) * PEAKS_PER_SECOND));
    // Gaps sustain the PREVIOUS level — filling with the new value would
    // smear a fresh transient backwards over every skipped slot
    const last = arr.length ? arr[arr.length - 1] : 0;
    while (arr.length < idx) arr.push(last);
    if (arr.length === idx) arr.push(p);
    else arr[idx] = Math.max(arr[idx], p);
    return arr;
}
