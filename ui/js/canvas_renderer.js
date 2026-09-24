/**
 * Waveform renderer — Tape Room (docs/session_view.md §3).
 *
 * Draws a filled, vertically symmetric envelope (not per-peak bars):
 * peaks are MAX-POOLED into one value per CSS pixel column, so the
 * same content renders identically at any tile width (per-bar drawing
 * aliased — ghost tiles of the same take looked like different audio).
 * DPR-aware: the backing store is devicePixelRatio× the CSS size (see
 * theme.fitCanvas), so waveforms are crisp on retina displays; all
 * drawing here is in CSS-pixel space.
 *
 * Palette lives in theme.js (TAPE / COMPOSITE / ECHO), the single
 * source kept in lockstep with css/session.css :root.
 *
 * Two column samplers feed ONE envelope renderer (drawEnvelope):
 * poolColumns (a whole peaks array, fit or fixed scale) and
 * mappedColumns (a heard tile: each column through the time map).
 */

import { TAPE, COMPOSITE, ECHO, fitCanvas } from './theme.js';
import { mapOffset, mapPeriod, seamDistance } from './time_map.js';
import { posMod } from './math_utils.js';

/** Peak value at index i as a clean absolute number (peaks may arrive
 *  as strings from JSON; NaN reads as silence). */
function peakAbs(peaks, i) {
    return Math.abs(parseFloat(peaks[i]) || 0);
}

/* A column edge within this many PEAKS of a bin edge IS that edge. The
 * same raw position computed two ways (before and after a map slide:
 * s + h vs (s + δ) + (h − δ)) differs in the last float bits, and a
 * floor/ceil flip there would change a column nothing moved — the
 * heard-tile invariant (heard_tile_sampler.test.mjs) is exact only
 * with this tolerance. A millionth of a peak is far below a pixel. */
const EDGE_EPS_PEAKS = 1e-6;
/* A heard piece thinner than this (in fractions of the take) is a
 * float sliver at a seam, not material: skipped, and the walk steps
 * past it by at least this much so it always makes progress. */
const PIECE_EPS = 1e-12;

/**
 * THE POOLING KERNEL — one column's value over the peaks range
 * [lo, hi) in fractional peak indices (peak i covers [i, i + 1)).
 * Downsampling (≥ 1 peak): the max over every peak the range touches.
 * Upsampling (< 1 peak): linear interpolation at `lo` (committed
 * material), or with `nearest` the peak `lo` sits in (live bars — see
 * poolColumns' fixed scale). A range starting at or past the end
 * reads as silence (a fixed-scale canvas wider than its content).
 * Shared by poolColumns and mappedColumns, so a heard tile and the
 * whole take pool identically.
 */
function poolRange(peaks, lo, hi, nearest = false) {
    const n = peaks.length;
    if (lo >= n) return 0;
    if (hi - lo >= 1 - EDGE_EPS_PEAKS) {
        let v = 0;
        const i1 = Math.min(n, Math.ceil(hi - EDGE_EPS_PEAKS));
        for (let i = Math.max(0, Math.floor(lo + EDGE_EPS_PEAKS)); i < i1; i++) {
            const p = peakAbs(peaks, i);
            if (p > v) v = p;
        }
        return v;
    }
    const i = Math.max(0, Math.min(n - 1, Math.floor(lo + EDGE_EPS_PEAKS)));
    // Fixed scale upsampling: NEAREST only. Interpolating toward the
    // next peak changes the edge column when that peak later arrives —
    // the last visible sliver of the live bar wiggled.
    if (nearest) return peakAbs(peaks, i);
    // Fit upsampling (committed, at rest): linear interpolation
    const j = Math.min(n - 1, i + 1);
    const t = Math.max(0, Math.min(1, lo - i));
    const a = peakAbs(peaks, i);
    return a + (peakAbs(peaks, j) - a) * t;
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
        cols[x] = Math.min(1, poolRange(peaks, lo, hi, fixed));
    }
    return cols;
}

/**
 * THE HEARD-TILE SAMPLER (loop-region phase 1, 2026-09-23; flash-chrome
 * F2 / seam-model SM-7): one pooled value per CSS px column of a tile
 * that draws a MAPPED slice of a take — a heard tile's window content
 * with its loop top rotated in, or any raw range of the take.
 *
 * Each column is a span of the tile's PERIOD PHASE; its heard offset is
 * (phase − rotFrac) mod 1 of the map period, and the map carries that
 * to raw take positions — mapOffset / seamDistance, the heard view's
 * own mapping (time_map.js), walked piece by piece when the column
 * straddles a seam. The raw pieces pool with FRACTIONAL edges
 * (poolRange). Nothing is sliced, rotated or refit in whole peaks: the
 * old renderer cut srcSegs at floor/ceil peaks, rotated by a rounded
 * peak count and stretched the result over the tile, so a sub-peak
 * edit flipped the peak count (re-stretching the tile) and the rounding
 * (every feature jumped ½–1 peak, ~11 px at the field's 156 px/Q) — the
 * whole lane lurched on every live commit.
 *
 * THE INVARIANT this buys (heard_tile_sampler.test.mjs): a column
 * depends only on the raw material its own heard span selects, so a map
 * SLIDE changes exactly the columns its swept seam passes over — the
 * rest of the lane stays put (to float noise, far below a pixel).
 *
 * @param {ArrayLike<number|string>} peaks the take's FULL peaks array
 *     (uniform over the raw take, fractions [0, 1))
 * @param {number} cssW column count (CSS px)
 * @param {Object} m
 * @param {Array<[number, number]>} m.src content ranges, fractions of
 *     the raw take, in heard order (a rep's srcSegs)
 * @param {number} [m.rotFrac] where the loop's heard top sits in the
 *     period (a rep's srcTopFrac); 0 = the top at phase 0
 * @param {number} [m.u0] the tile's left edge in PERIODS on the tile
 *     grid (startQ / P — heard tiles tile from the frame's 0)
 * @param {number} [m.u1] its right edge (endQ / P): a full tile spans
 *     one period; a tile clipped by the frame shows the LEADING part of
 *     its period, never the whole period squeezed in
 * @returns {Float32Array} cssW values in [0, 1]
 */
export function mappedColumns(peaks, cssW, { src, rotFrac = 0, u0 = 0, u1 = 1 }) {
    const cols = new Float32Array(cssW);
    const n = peaks ? peaks.length : 0;
    const map = { segs: src || [] };
    const total = mapPeriod(map);  // the period, in fractions of the take
    if (!n || !(total > 0) || !(cssW > 0)) return cols;
    const du = (u1 - u0) / cssW;   // periods per column
    const w = du * total;          // one column's heard span
    for (let x = 0; x < cssW; x++) {
        let h = posMod(u0 + x * du - rotFrac, 1) * total;
        let left = w;
        let v = 0;
        while (left > PIECE_EPS) {
            const run = seamDistance(map, h);
            const step = Math.min(left, run);
            if (step > PIECE_EPS) {
                const r = mapOffset(map, h) * n;
                const p = poolRange(peaks, r, r + step * n);
                if (p > v) v = p;
            }
            const adv = Math.max(step, PIECE_EPS);
            h += adv;
            left -= adv;
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
 * ONE DISPLAY GAIN PER TAKE (loop-region phase 1, 2026-09-23): the
 * auto boost drawWaveform would pick for the WHOLE peaks array, cached
 * per array identity. Every surface that draws a slice of a take —
 * heard tiles, the reveal, the region panel at any zoom — passes this
 * as `fixedBoost`, so a slice never rescales against its own loudest
 * peak (the "breathing" waveform of the field video).
 *
 * @param {ArrayLike<number|string>} peaks the take's full peaks array
 * @returns {number} the boost to pass as opts.fixedBoost
 */
const boostCache = new WeakMap();
export function peaksBoost(peaks) {
    if (!peaks || !peaks.length) return 1;
    const hit = boostCache.get(peaks);
    if (hit !== undefined) return hit;
    let maxV = 0;
    for (let i = 0; i < peaks.length; i++) {
        const v = +peaks[i];
        if (v > maxV) maxV = v;
    }
    const b = maxV > 0 ? Math.min(NORM_TARGET / maxV, NORM_MAX_BOOST) : 1;
    boostCache.set(peaks, b);
    return b;
}

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
    const cols = peaks && peaks.length
        ? poolColumns(peaks, canvasCssSize(canvas, opts).cssW, opts.pxPerPeak)
        : null;
    drawEnvelope(canvas, cols, opts);
}

/**
 * The CSS-px size a canvas draws at: the explicit option, else its
 * layout size, else the default footprint — NEVER canvas.width/height
 * (the backing store, already css×dpr; see DEFAULT_CSS_W). Samplers
 * size their column arrays with this, so columns and canvas agree.
 * ROUNDED, as every caller sizes the canvas element
 * (`style.width = Math.round(cssW) + 'px'`): one column per CSS px, and
 * a tile width carrying float noise (623.9999999 px for a 4Q tile at
 * 156 px/Q) never loses a column — flooring re-mapped every column of
 * the tile, a lurch of its own.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{cssWidth?: number, cssHeight?: number}} [opts]
 * @returns {{cssW: number, cssH: number}}
 */
export function canvasCssSize(canvas, opts = {}) {
    return {
        cssW: Math.max(2, Math.round(
            opts.cssWidth || canvas.clientWidth || DEFAULT_CSS_W)),
        cssH: Math.max(2, Math.floor(
            opts.cssHeight || canvas.clientHeight || DEFAULT_CSS_H)),
    };
}

/**
 * The display boost for a set of pooled columns: `fixedBoost` when the
 * caller supplies one (live bars: live_peaks.liveBoost; committed
 * tiles: peaksBoost — one gain per take), else the columns' own
 * maximum scaled to NORM_TARGET (capped at NORM_MAX_BOOST), else 1
 * with `normalize: false`.
 *
 * DISPLAY NORMALIZATION: waveforms show SHAPE, meters show level —
 * real takes at sane input gain would draw as invisible hairlines if
 * amplitude mapped linearly. LIVE bars pass fixedBoost (a smoothed
 * ratchet) — re-normalizing against a running max inside each draw
 * rescaled the whole waveform whenever a louder peak arrived (the
 * recording "pump"), and drawing un-normalized popped at commit
 * instead. The self-normalizing branch is right only for a canvas that
 * shows a WHOLE array; a slice normalized to its own loudest peak
 * breathes as the slice moves (peaksBoost). Exported for the tests.
 */
export function envelopeBoost(cols, opts = {}) {
    if (typeof opts.fixedBoost === 'number') return opts.fixedBoost;
    if (opts.normalize === false) return 1;
    let maxV = 0;
    for (let x = 0; x < cols.length; x++) if (cols[x] > maxV) maxV = cols[x];
    return maxV > 0 ? Math.min(NORM_TARGET / maxV, NORM_MAX_BOOST) : 1;
}

/**
 * Pooled columns → the drawn envelope heights (fractions of AMP):
 * boost, the gentle perceptual exponent (SHAPE_EXP lifts quiet
 * detail), then the CONNECTED-envelope smoothing (design handoff rule
 * 6): a 3-point moving average joins the max-pooled columns into one
 * continuous shape without losing bar-level detail — "do not
 * oversmooth into blobs". Runs AFTER pooling/normalization so
 * poolColumns' append-stability contract (fixed-scale live bars) is
 * untouched: a new column only re-shades its immediate neighbor, it
 * never remaps old content (and a heard tile's swept sliver re-shades
 * at most one column either side). Pure; exported for the tests.
 *
 * @param {Float32Array} cols pooled amplitudes in [0, 1]
 * @param {number} boost the display boost (envelopeBoost)
 * @returns {Float32Array} smoothed heights, one per column
 */
export function shapeColumns(cols, boost) {
    const W = cols.length;
    const shaped = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        shaped[x] = Math.pow(Math.min(1, cols[x] * boost), SHAPE_EXP);
    }
    const sm = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        const a = x > 0 ? shaped[x - 1] : shaped[x];
        const b = x < W - 1 ? shaped[x + 1] : shaped[x];
        sm[x] = (a + shaped[x] + b) / 3;
    }
    return sm;
}

/**
 * THE ENVELOPE RENDERER — every waveform in the app draws through
 * here: `cols` holds one pooled amplitude per CSS px column of the
 * canvas (poolColumns for a whole array, mappedColumns for a heard
 * tile), shaded as the filled symmetric envelope with the tone's
 * vertical gradient and a hairline floor (FLOOR_PX). Null/empty `cols`
 * draws the quiet centre hairline (no content yet).
 *
 * @param {HTMLCanvasElement} canvas target (backing store resized to fit)
 * @param {?Float32Array} cols pooled amplitudes, canvasCssSize().cssW long
 * @param {DrawWaveformOptions} [opts] size, tone and boost options
 */
export function drawEnvelope(canvas, cols, opts = {}) {
    if (!canvas) return;
    const { cssW, cssH } = canvasCssSize(canvas, opts);
    const { ctx } = fitCanvas(canvas, cssW, cssH);
    const tone = opts.isEcho ? ECHO : (opts.isComposite ? COMPOSITE : TAPE);
    const midY = cssH / 2;

    if (!cols || cols.length === 0) {
        ctx.fillStyle = tone.mid;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(0, midY - 0.5, cssW, 1);
        ctx.globalAlpha = 1;
        return;
    }

    const sm = shapeColumns(cols, envelopeBoost(cols, opts));
    const W = Math.min(cssW, sm.length);
    const amp = cssH * AMP_FRAC;
    const grad = ctx.createLinearGradient(0, midY - amp, 0, midY + amp);
    grad.addColorStop(0, tone.top);
    grad.addColorStop(0.5, tone.mid);
    grad.addColorStop(1, tone.bottom);
    ctx.fillStyle = grad;

    ctx.beginPath();
    ctx.moveTo(0, midY - Math.max(FLOOR_PX, sm[0] * amp));
    for (let x = 1; x < W; x++) {
        ctx.lineTo(x, midY - Math.max(FLOOR_PX, sm[x] * amp));
    }
    for (let x = W - 1; x >= 0; x--) {
        ctx.lineTo(x, midY + Math.max(FLOOR_PX, sm[x] * amp));
    }
    ctx.closePath();
    ctx.fill();
}

/* MIDI tile geometry: a note bar fills this fraction of its pitch row
 * (the rest is the gap between adjacent semitones), never thinner than
 * MIDI_BAR_MIN_PX; velocity maps to alpha between the two bounds. */
const MIDI_BAR_ROW_FRAC = 0.8;
const MIDI_BAR_MIN_PX = 1.5;
const MIDI_ALPHA_FLOOR = 0.35;
/* The velocity lane under the piano roll: a hairline gap, then one
 * stem per note onset whose height is its velocity, capped by a small
 * head so a soft note still reads as a note. */
const MIDI_VEL_GAP_PX = 2;
const MIDI_VEL_STEM_PX = 1.5;
const MIDI_VEL_HEAD_PX = 3;
const MIDI_VEL_BASE_ALPHA = 0.18;
/* Below this lane height the stems are noise: the roll takes it all. */
const MIDI_VEL_MIN_PX = 8;
/* The share of a MIDI tile the velocity lane takes (lane tiles and the
 * region panel alike, so the two read as one picture). */
export const MIDI_VELOCITY_LANE = 0.28;

/**
 * @typedef {Object} DrawMidiTileOptions
 * @property {number} [cssWidth] CSS-pixel width (defaults like drawWaveform)
 * @property {number} [cssHeight] CSS-pixel height
 * @property {boolean} [isEcho] cool cyan tone for ghost tiles (audible
 *     repetitions, never material — theme.ECHO)
 * @property {{lo: number, hi: number}} range the pitch range the tile
 *     maps over its height (midi_notes.fitPitchRange of the WHOLE take,
 *     so every rep of one take shares one vertical scale)
 * @property {number} [velocityLane] fraction of the height given to a
 *     velocity lane under the roll (0 / omitted = roll only)
 */

/**
 * Draw a MIDI clip's tile: one bar per note — pitch → row over the
 * tile's height (the compact range fit), length → width, velocity →
 * alpha — in the tape hue (echo tone for ghosts). With `velocityLane`
 * the roll yields the bottom of the tile to a velocity lane (one stem
 * per onset, height = velocity). `notes` are already
 * sliced into tile fractions (midi_notes.sliceNotesToTile): the audio
 * tile's mapping (srcSegs, rotation, the tile's window onto its
 * period — mappedColumns' exact fractions) ran before this, so
 * windows, cuts and comps apply here exactly as they do to peaks.
 *
 * @param {HTMLCanvasElement} canvas target
 * @param {Array<{f0: number, f1: number, note: number, vel: number}>} notes
 * @param {DrawMidiTileOptions} opts
 */
export function drawMidiTile(canvas, notes, opts = {}) {
    if (!canvas) return;
    const { cssW, cssH } = canvasCssSize(canvas, opts);
    const { ctx } = fitCanvas(canvas, cssW, cssH);
    const tone = opts.isEcho ? ECHO : TAPE;
    if (!notes || !notes.length) {
        ctx.fillStyle = tone.mid;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(0, cssH / 2 - 0.5, cssW, 1);
        ctx.globalAlpha = 1;
        return;
    }
    // Two lanes: the piano roll on top, velocity stems beneath.
    let velH = Math.floor(cssH * Math.max(0, Math.min(0.5, opts.velocityLane || 0)));
    if (velH < MIDI_VEL_MIN_PX) velH = 0;
    const rollH = velH ? cssH - velH - MIDI_VEL_GAP_PX : cssH;
    const range = opts.range || { lo: 54, hi: 66 };
    const rows = Math.max(1, range.hi - range.lo + 1);
    const rowH = rollH / rows;
    const barH = Math.max(MIDI_BAR_MIN_PX, rowH * MIDI_BAR_ROW_FRAC);
    ctx.fillStyle = tone.mid;
    for (const n of notes) {
        const x0 = n.f0 * cssW;
        const x1 = Math.max(x0 + 1, n.f1 * cssW);
        // Row `note - lo` counts up from the roll's bottom edge.
        const rowTop = rollH - (n.note - range.lo + 1) * rowH;
        const y = rowTop + (rowH - barH) / 2;
        ctx.globalAlpha = MIDI_ALPHA_FLOOR + (1 - MIDI_ALPHA_FLOOR) * velFrac(n);
        ctx.fillRect(x0, y, x1 - x0, barH);
    }
    if (velH) {
        const base = cssH;  // stems stand on the bottom edge
        ctx.globalAlpha = MIDI_VEL_BASE_ALPHA;
        ctx.fillRect(0, cssH - velH - MIDI_VEL_GAP_PX / 2 - 0.5, cssW, 1);
        ctx.globalAlpha = 1;
        for (const n of notes) {
            if (n.onset === false) continue;  // one stem per note, at its onset
            const x = n.f0 * cssW;
            const h = Math.max(MIDI_VEL_HEAD_PX, velFrac(n) * velH);
            ctx.fillRect(x, base - h, MIDI_VEL_STEM_PX, h);
            ctx.fillRect(x - (MIDI_VEL_HEAD_PX - MIDI_VEL_STEM_PX) / 2, base - h,
                         MIDI_VEL_HEAD_PX, MIDI_VEL_HEAD_PX);
        }
    }
    ctx.globalAlpha = 1;
}

/** A note's velocity as [0, 1]. */
function velFrac(n) {
    return Math.max(0, Math.min(127, n.vel || 0)) / 127;
}
