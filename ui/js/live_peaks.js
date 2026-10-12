/**
 * Live recording peaks, TIME-INDEXED (docs/session_view.md): each
 * level lands at the index its position in the take names
 * (PEAKS_PER_SECOND resolution), so where a peak sits in the array —
 * and on screen — is a function of WHEN it happened, not of how often
 * the poll ran. One peak pushed per poll would tie the waveform's
 * geometry to the poll cadence, and it would drift sideways whenever
 * polls jitter or drop.
 */

import { boostForMax } from './display_boost.js';
import { FALLBACK_SAMPLE_RATE } from './sample_rate.js';

export const PEAKS_PER_SECOND = 50;

/** How far a live bar's boost moves toward its target per poll. */
const BOOST_EASE = 0.3;

/**
 * The display boost for a LIVE waveform, eased from `prevBoost`. The
 * running max of a take only rises, so its target boost
 * (display_boost.js) only falls: easing toward it never pumps the
 * waveform when a louder peak arrives, and it settles on the value the
 * committed tile is drawn at, so the commit does not pop.
 */
export function liveBoost(prevBoost, peaks) {
    let max = 0;
    for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
    const target = boostForMax(max);
    if (prevBoost === undefined || prevBoost === null) return target;
    return prevBoost + (target - prevBoost) * BOOST_EASE;
}

/**
 * Record `peak` as the level at `durationSamples` into the take.
 * Polls landing on one index max-pool; skipped indices sustain the
 * PREVIOUS level (the new one would smear a fresh transient backwards).
 * Mutates and returns `arr`.
 */
export function appendLivePeak(arr, durationSamples, sampleRate, peak) {
    const sr = sampleRate > 0 ? sampleRate : FALLBACK_SAMPLE_RATE;
    const p = Math.min(1, Math.abs(peak) || 0);
    const idx = Math.max(0, Math.floor((durationSamples / sr) * PEAKS_PER_SECOND));
    const last = arr.length ? arr[arr.length - 1] : 0;
    while (arr.length < idx) arr.push(last);
    if (arr.length === idx) arr.push(p);
    else arr[idx] = Math.max(arr[idx], p);
    return arr;
}
