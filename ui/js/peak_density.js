/**
 * Committed waveform DENSITY (navigation N7, 2026-09-22): how many
 * peaks the UI asks the backend for per take (getWaveform /
 * getTakeWaveform).
 *
 * A flat count (it was 800 per take) gave a 56Q take ~14 peaks per Q,
 * so any zoom — the region panel's, or the main view's on a long take —
 * drew an interpolated blob instead of transients, and a fine edit could
 * not be judged by the waveform. The request now scales with the take's
 * LENGTH: COMMITTED_PEAKS_PER_SECOND of material (≈300 per Q at a 1.47 s Q),
 * never fewer than MIN_PEAKS (short takes keep today's resolution) and
 * never more than MAX_PEAKS (one bridge payload stays bounded).
 *
 * The backend buckets with proportional bounds (engine
 * ClipNode::peakBucket, mock waveform.js peakBucket): bucket i covers
 * [⌊i·D/n⌋, ⌊(i+1)·D/n⌋), so the last bucket reaches the end of the
 * take and a peak never drifts early — a denser request is a
 * refinement of the same max-pooled envelope, not a different picture.
 *
 * Live (recording) peaks are a separate, time-indexed stream
 * (live_peaks.js PEAKS_PER_SECOND); the renderer stretches either array
 * over the take's width, so the commit hand-over is density-free.
 */

export const COMMITTED_PEAKS_PER_SECOND = 200;
export const MIN_PEAKS = 800;
export const MAX_PEAKS = 32768;

/**
 * The peak count to request for a take of `durationSamples` at
 * `sampleRate`: clamp(round(seconds × COMMITTED_PEAKS_PER_SECOND), MIN, MAX).
 * An unknown length or rate answers MIN_PEAKS.
 */
export function peakCountFor(durationSamples, sampleRate) {
    const d = Number(durationSamples);
    const sr = Number(sampleRate);
    if (!(d > 0) || !(sr > 0)) return MIN_PEAKS;
    const n = Math.round((d / sr) * COMMITTED_PEAKS_PER_SECOND);
    return Math.min(MAX_PEAKS, Math.max(MIN_PEAKS, n));
}
