/**
 * Waveform renderer — Tape Room (docs/ui_overhaul.md §3).
 *
 * Draws a filled, vertically symmetric envelope (not per-peak bars):
 * peaks are MAX-POOLED into one value per device pixel column, so the
 * same content renders identically at any tile width (per-bar drawing
 * aliased — ghost tiles of the same take looked like different audio).
 * DPR-aware: the backing store is devicePixelRatio× the CSS size (see
 * theme.fitCanvas), so waveforms are crisp on retina displays; all
 * drawing here is in CSS-pixel space.
 *
 * Palette lives in theme.js (TAPE / COMPOSITE / ECHO), the single
 * source kept in lockstep with css/session.css :root.
 */

import { TAPE, COMPOSITE, ECHO, fitCanvas } from './theme.js';

/** Peak value at index i as a clean absolute number (peaks may arrive
 *  as strings from JSON; NaN reads as silence). */
function peakAbs(peaks, i) {
    return Math.abs(parseFloat(peaks[i]) || 0);
}

/**
 * One envelope value per CSS pixel column, max-pooled over the peaks
 * that column covers (or interpolated when upsampling). Two mappings:
 *
 * FIT (pxPerPeak omitted): column x covers peaks [x/W·n, (x+1)/W·n) —
 * right for COMMITTED clips, whose peaks are drawn once at rest.
 *
 * FIXED SCALE (pxPerPeak = p): column x covers peaks [x/p, (x+1)/p) — a
 * function of p ONLY, never of the peak count. Required for LIVE bars:
 * under fit mapping, W = round(n·p) makes W/n wobble as n grows, so
 * every drawn column would shift sub-pixel on every poll — a
 * left/right jitter on the recording waveform, worst when p shrinks
 * after a frame extension. With fixed scale, a peak's pixels are
 * immutable for the life of the take: new content appends, earlier
 * content never remaps.
 *
 * Exported for the append-stability unit test.
 */
export function poolColumns(peaks, cssW, pxPerPeak) {
    const n = peaks.length;
    const cols = new Float32Array(cssW);
    const fixed = pxPerPeak > 0;
    for (let x = 0; x < cssW; x++) {
        const lo = fixed ? x / pxPerPeak : (x / cssW) * n;
        const hi = fixed ? (x + 1) / pxPerPeak : ((x + 1) / cssW) * n;
        let v = 0;
        if (lo >= n) {
            cols[x] = 0; // fixed-scale trailing edge (canvas ≥ content)
            continue;
        }
        if (hi - lo >= 1) {
            for (let i = Math.floor(lo); i < Math.min(n, Math.ceil(hi)); i++) {
                const p = peakAbs(peaks, i);
                if (p > v) v = p;
            }
        } else if (fixed) {
            // Fixed scale upsampling: NEAREST only. Interpolating toward
            // the next peak changes the edge column when that peak later
            // arrives — the last visible sliver of the live bar wiggled.
            v = peakAbs(peaks, Math.min(n - 1, Math.floor(lo)));
        } else {
            // Fit upsampling (committed, at rest): linear interpolation
            const i = Math.min(n - 1, Math.floor(lo));
            const j = Math.min(n - 1, i + 1);
            const t = lo - i;
            const a = peakAbs(peaks, i);
            const b = peakAbs(peaks, j);
            v = a + (b - a) * t;
        }
        cols[x] = Math.min(1, v);
    }
    return cols;
}

// Envelope geometry + display-normalization tuning.
// AMP_FRAC: envelope half-height as a fraction of the canvas height —
//   0.46 leaves a small margin so a full-scale peak never kisses the
//   tile border.
// FLOOR_PX: minimum half-height in px — silent-but-present audio stays
//   visible as a hairline spine.
// SHAPE_EXP: gentle perceptual exponent (v^0.65) lifting quiet detail.
// NORM_TARGET: normalization scales the clip's own maximum to this
//   (0.95, not 1.0 — headroom against the smoothing pass overshooting).
// NORM_MAX_BOOST: normalization boost cap — silence stays flat instead
//   of amplifying noise floor to full scale.
const AMP_FRAC = 0.46;
const FLOOR_PX = 0.75;
const SHAPE_EXP = 0.65;
const NORM_TARGET = 0.95;
const NORM_MAX_BOOST = 8;

// Fallback CSS size for a canvas with no layout (detached, or
// display:none): a typical tile footprint. NEVER fall back to
// canvas.width/height — that is the BACKING store, already css×dpr
// from the previous draw, so each redraw of a detached canvas would
// inflate the "CSS" size by another dpr factor on retina.
const DEFAULT_CSS_W = 200;
const DEFAULT_CSS_H = 60;

/**
 * @typedef {Object} DrawWaveformOptions
 * @property {number} [cssWidth] CSS-pixel width to draw at (defaults to
 *     the canvas's current layout width, then DEFAULT_CSS_W)
 * @property {number} [cssHeight] CSS-pixel height (defaults to layout
 *     height, then DEFAULT_CSS_H)
 * @property {boolean} [isComposite] lighter, creamier gold tone — the
 *     group's mixdown (theme.COMPOSITE)
 * @property {boolean} [isEcho] cool cyan tone for ghost tiles — audible
 *     repetitions, never material (theme.ECHO); wins over isComposite
 * @property {number} [pxPerPeak] fixed horizontal scale in px per peak.
 *     REQUIRED for live bars (append stability — see poolColumns);
 *     omit for committed clips, which fit to the canvas width.
 * @property {number} [fixedBoost] externally smoothed normalization
 *     boost (live_peaks.liveBoost) — live bars pass this so the shape
 *     doesn't "pump" when a louder peak arrives mid-take
 * @property {boolean} [normalize] set false to draw raw amplitudes
 *     (no per-clip normalization); default true
 */

/**
 * Draw the envelope for `peaks` into `canvas`.
 *
 * @param {HTMLCanvasElement} canvas target (backing store is resized
 *     to fit; drawing happens in CSS-pixel space)
 * @param {ArrayLike<number|string>} peaks peak amplitudes 0..1
 * @param {DrawWaveformOptions} [opts]
 */
export function drawWaveform(canvas, peaks, opts = {}) {
    if (!canvas) return;

    const cssW = Math.max(2, Math.floor(
        opts.cssWidth || canvas.clientWidth || DEFAULT_CSS_W));
    const cssH = Math.max(2, Math.floor(
        opts.cssHeight || canvas.clientHeight || DEFAULT_CSS_H));

    const { ctx } = fitCanvas(canvas, cssW, cssH);

    const tone = opts.isEcho ? ECHO : (opts.isComposite ? COMPOSITE : TAPE);
    const midY = cssH / 2;

    if (!peaks || peaks.length === 0) {
        ctx.fillStyle = tone.mid;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(0, midY - 0.5, cssW, 1);
        ctx.globalAlpha = 1;
        return;
    }

    const cols = poolColumns(peaks, cssW, opts.pxPerPeak);

    // DISPLAY NORMALIZATION: waveforms show SHAPE, meters show level —
    // real takes at sane input gain would draw as invisible hairlines
    // if amplitude mapped linearly. Scale the
    // clip to its own peak (boost capped at NORM_MAX_BOOST so silence
    // stays flat) with a gentle perceptual exponent to lift quiet detail.
    // LIVE bars pass fixedBoost (a smoothed ratchet, live_peaks.liveBoost)
    // — re-normalizing against a running max inside each draw rescaled
    // the whole waveform whenever a louder peak arrived (the recording
    // "pump"), and drawing un-normalized popped at commit instead.
    let boost = 1;
    if (typeof opts.fixedBoost === 'number') {
        boost = opts.fixedBoost;
    } else if (opts.normalize !== false) {
        let maxV = 0;
        for (let x = 0; x < cssW; x++) if (cols[x] > maxV) maxV = cols[x];
        boost = maxV > 0 ? Math.min(NORM_TARGET / maxV, NORM_MAX_BOOST) : 1;
    }
    for (let x = 0; x < cssW; x++) {
        cols[x] = Math.pow(Math.min(1, cols[x] * boost), SHAPE_EXP);
    }

    // CONNECTED envelope (design handoff rule 6): a 3-point moving
    // average joins the max-pooled columns into one continuous shape
    // without losing bar-level detail — "do not oversmooth into blobs".
    // Runs AFTER pooling/normalization so poolColumns' append-stability
    // contract (fixed-scale live bars) is untouched: a new column only
    // re-shades its immediate neighbor, it never remaps old content.
    const sm = new Float32Array(cssW);
    for (let x = 0; x < cssW; x++) {
        const a = x > 0 ? cols[x - 1] : cols[x];
        const b = x < cssW - 1 ? cols[x + 1] : cols[x];
        sm[x] = (a + cols[x] + b) / 3;
    }

    // Filled symmetric envelope with a hairline floor (FLOOR_PX).
    const amp = cssH * AMP_FRAC;
    const grad = ctx.createLinearGradient(0, midY - amp, 0, midY + amp);
    grad.addColorStop(0, tone.top);
    grad.addColorStop(0.5, tone.mid);
    grad.addColorStop(1, tone.bottom);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(0, midY - Math.max(FLOOR_PX, sm[0] * amp));
    for (let x = 1; x < cssW; x++) {
        ctx.lineTo(x, midY - Math.max(FLOOR_PX, sm[x] * amp));
    }
    for (let x = cssW - 1; x >= 0; x--) {
        ctx.lineTo(x, midY + Math.max(FLOOR_PX, sm[x] * amp));
    }
    ctx.closePath();
    ctx.fill();
}
