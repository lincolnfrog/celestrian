/**
 * THE DISPLAY BOOST. Waveforms show shape, meters show level: a take
 * at sane input gain would draw as a hairline if amplitude mapped
 * linearly, so every waveform is drawn scaled until its loudest peak
 * reaches NORM_TARGET of full height.
 *
 * One rule for committed tiles (canvas_renderer.js) and the live bar
 * (live_peaks.js): the live ratchet settles on the committed boost only
 * because both read it here.
 */

/** The height the loudest peak is drawn at — short of full scale, as
 * headroom for the envelope's smoothing pass. */
export const NORM_TARGET = 0.95;

/** The most a waveform is scaled: past this the picture is amplified
 * noise floor, and silence must stay flat. */
export const NORM_MAX_BOOST = 8;

/** The boost for content whose loudest peak is `max`; 1 for silence. */
export function boostForMax(max) {
    return max > 0 ? Math.min(NORM_TARGET / max, NORM_MAX_BOOST) : 1;
}
