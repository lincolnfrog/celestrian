/**
 * Committed waveform DENSITY: how many peaks the UI asks the backend
 * for per take (getWaveform / getTakeWaveform). The count follows the
 * take's LENGTH — a flat count leaves a long take a few peaks per Q,
 * and any zoom draws an interpolated blob no fine edit can be judged
 * by.
 *
 * The backend buckets with proportional bounds (ClipNode::peakBucket,
 * mock waveform.js): bucket i covers [⌊i·D/n⌋, ⌊(i+1)·D/n⌋), so a
 * denser request refines the same max-pooled envelope rather than
 * drawing a different picture. Live peaks are a separate, time-indexed
 * stream (live_peaks.js); the renderer stretches either array over the
 * take's width.
 */

export const COMMITTED_PEAKS_PER_SECOND = 200;
export const MIN_PEAKS = 800;    // a short take's floor
export const MAX_PEAKS = 32768;  // one bridge payload stays bounded

/**
 * The peak count to request for a take of `durationSamples` at
 * `sampleRate`: seconds × COMMITTED_PEAKS_PER_SECOND, within [MIN_PEAKS,
 * MAX_PEAKS]. An unknown length or rate answers MIN_PEAKS.
 */
export function peakCountFor(durationSamples, sampleRate) {
    const d = Number(durationSamples);
    const sr = Number(sampleRate);
    if (!(d > 0) || !(sr > 0)) return MIN_PEAKS;
    const n = Math.round((d / sr) * COMMITTED_PEAKS_PER_SECOND);
    return Math.min(MAX_PEAKS, Math.max(MIN_PEAKS, n));
}
