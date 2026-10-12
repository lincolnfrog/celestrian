/**
 * Waveform and MIDI tile renderer (docs/session_view.md §3).
 *
 * A waveform is a filled, vertically symmetric envelope: peaks are
 * max-pooled into one value per CSS pixel column, so the same content
 * draws identically at any tile width. Two column samplers feed ONE
 * envelope renderer (drawEnvelope): poolColumns (a whole peaks array)
 * and mappedColumns (a heard tile, each column through the time map).
 * All drawing is in CSS pixels (theme.fitCanvas); the palette is
 * theme.js.
 */

import { TAPE, COMPOSITE, ECHO, fitCanvas } from './theme.js';
import { mapOffset, mapPeriod, seamDistance } from './time_map.js';
import { posMod } from './math_utils.js';
import { boostForMax } from './display_boost.js';
import { MIDDLE_OCTAVE } from './midi_notes.js';

/** Peak i as a clean magnitude (peaks may arrive as strings from JSON;
 * NaN reads as silence). */
function peakAbs(peaks, i) {
    return Math.abs(parseFloat(peaks[i]) || 0);
}

/* A column edge within this many PEAKS of a bin edge is that edge. The
 * same raw position computed two ways (before and after a map slide)
 * differs in the last float bits, and a floor/ceil flip there would
 * change a column nothing moved. Far below a pixel. */
const EDGE_EPS_PEAKS = 1e-6;
/* A heard piece thinner than this (fractions of the take) is a float
 * sliver at a seam, not material: skipped, and the walk steps past it
 * by at least this much so it always makes progress. */
const PIECE_EPS = 1e-12;

/**
 * THE POOLING KERNEL: one column's value over the peaks range [lo, hi)
 * in fractional peak indices (peak i covers [i, i + 1)). A range of a
 * peak or more is the max over every peak it touches. A narrower one is
 * a linear interpolation at `lo` — or, with `nearest`, the peak `lo`
 * sits in: a live bar must not interpolate toward a peak that has not
 * arrived, or its last column changes when it does. A range starting
 * past the end reads as silence.
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
    if (nearest) return peakAbs(peaks, i);
    const j = Math.min(n - 1, i + 1);
    const t = Math.max(0, Math.min(1, lo - i));
    const a = peakAbs(peaks, i);
    return a + (peakAbs(peaks, j) - a) * t;
}

/**
 * One pooled value per CSS pixel column of a whole peaks array.
 *
 * FIT (no pxPerPeak): column x covers peaks [x/W·n, (x+1)/W·n) — for
 * committed clips, drawn once at rest.
 *
 * FIXED SCALE (pxPerPeak = p): column x covers [x/p, (x+1)/p), a
 * function of p only. Required for LIVE bars: under fit the mapping
 * moves with the growing peak count, so every drawn column would shift
 * on every poll. At a fixed scale new content appends and earlier
 * content never remaps (waveform_stability.test.mjs).
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
 * THE HEARD-TILE SAMPLER: one pooled value per CSS column of a tile
 * that draws a MAPPED slice of a take. Each column is a span of the
 * tile's period phase; its heard span walks the map piece by piece
 * (time_map.js mapOffset / seamDistance) and pools the raw material
 * with FRACTIONAL edges — nothing is cut, rotated or refit in whole
 * peaks. So a column depends only on the material its own heard span
 * selects, and a map slide changes exactly the columns its seam crosses
 * (heard_tile_sampler.test.mjs).
 *
 * @param {ArrayLike<number|string>} peaks the take's FULL peaks array
 * @param {number} cssW column count (CSS px)
 * @param {Object} m
 * @param {Array<[number, number]>} m.src content ranges, fractions of
 *     the raw take, in heard order (a rep's srcSegs)
 * @param {number} [m.rotFrac] where the loop's heard top sits in the
 *     period (a rep's srcTopFrac); 0 = the top at phase 0
 * @param {number} [m.u0] the tile's left edge in PERIODS on the tile
 *     grid (startQ / P)
 * @param {number} [m.u1] its right edge (endQ / P): a full tile spans
 *     one period; a tile clipped by the frame shows the leading part of
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

// Envelope geometry.
const AMP_FRAC = 0.46;   // half-height as a fraction of the canvas: a
                         // full-scale peak stops short of the tile border
const FLOOR_PX = 0.75;   // minimum half-height: silent-but-present audio
                         // stays visible as a hairline spine
const SHAPE_EXP = 0.65;  // perceptual exponent lifting quiet detail

// The CSS size of a canvas with no layout (detached, display:none): a
// typical tile. NEVER canvas.width/height — that is the backing store,
// already css×dpr, so each redraw would inflate the size by another dpr.
const DEFAULT_CSS_W = 200;
const DEFAULT_CSS_H = 60;

/**
 * @typedef {Object} DrawWaveformOptions
 * @property {number} [cssWidth] CSS-pixel width (default: the canvas's
 *     layout width, then DEFAULT_CSS_W)
 * @property {number} [cssHeight] CSS-pixel height (likewise)
 * @property {boolean} [isComposite] the group mixdown's tone
 * @property {boolean} [isEcho] the ghost-tile tone; wins over isComposite
 * @property {number} [pxPerPeak] fixed horizontal scale in px per peak.
 *     REQUIRED for live bars (poolColumns); omit for committed clips
 * @property {number} [fixedBoost] the display boost to draw at
 *     (peaksBoost for a committed take, live_peaks.liveBoost for a live
 *     bar); omitted, the canvas normalizes to its own columns
 * @property {boolean} [normalize] false draws raw amplitudes
 */

/**
 * ONE DISPLAY GAIN PER TAKE: the boost for a WHOLE peaks array
 * (display_boost.js), cached by array identity. Every surface that
 * draws a slice of a take passes it as `fixedBoost` — a slice
 * normalized to its own loudest peak rescales as the slice moves.
 * Pass committed arrays only: a live array is mutated in place, and its
 * cached boost would go stale.
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
    const b = boostForMax(maxV);
    boostCache.set(peaks, b);
    return b;
}

/** Draw the envelope of a whole `peaks` array (amplitudes 0..1) into
 * `canvas`. */
export function drawWaveform(canvas, peaks, opts = {}) {
    if (!canvas) return;
    const cols = peaks && peaks.length
        ? poolColumns(peaks, canvasCssSize(canvas, opts).cssW, opts.pxPerPeak)
        : null;
    drawEnvelope(canvas, cols, opts);
}

/**
 * The CSS-px size a canvas draws at: the explicit option, else its
 * layout size, else the default (see DEFAULT_CSS_W). Samplers size
 * their column arrays with this, so columns and canvas agree. The
 * width is ROUNDED, as every caller sizes the element: a tile width
 * carrying float noise (623.9999999 px) must not lose a column, which
 * would remap every column of the tile.
 *
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

/** The display boost for a set of pooled columns: `fixedBoost` when
 * given, 1 with `normalize: false`, else the columns' own
 * (display_boost.js) — right only for a canvas showing a WHOLE array
 * at rest (peaksBoost says why). */
export function envelopeBoost(cols, opts = {}) {
    if (typeof opts.fixedBoost === 'number') return opts.fixedBoost;
    if (opts.normalize === false) return 1;
    let maxV = 0;
    for (let x = 0; x < cols.length; x++) if (cols[x] > maxV) maxV = cols[x];
    return boostForMax(maxV);
}

/**
 * Pooled columns → drawn heights (fractions of the amplitude): the
 * boost, the perceptual exponent, then a 3-point moving average that
 * joins the columns into one connected shape without blurring it. The
 * smoothing runs AFTER pooling, so a new or changed column re-shades
 * only its immediate neighbours and never remaps old content.
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
 * THE ENVELOPE RENDERER — every waveform draws through here. `cols`
 * holds one pooled amplitude per CSS px column (poolColumns or
 * mappedColumns), shaded as the filled symmetric envelope in the tone's
 * vertical gradient. Null or empty `cols` draws the quiet centre
 * hairline (no content yet).
 *
 * @param {HTMLCanvasElement} canvas target (backing store resized to fit)
 * @param {?Float32Array} cols pooled amplitudes, canvasCssSize().cssW long
 * @param {DrawWaveformOptions} [opts]
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

/* MIDI tile geometry: a note bar fills this fraction of its pitch row,
 * never thinner than MIDI_BAR_MIN_PX; velocity maps to alpha from
 * MIDI_ALPHA_FLOOR up. */
const MIDI_BAR_ROW_FRAC = 0.8;
const MIDI_BAR_MIN_PX = 1.5;
const MIDI_ALPHA_FLOOR = 0.35;
/* The velocity lane under the roll: a hairline gap, then one stem per
 * note onset whose height is its velocity, capped by a small head so a
 * soft note still reads as a note. */
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
 * @property {boolean} [isEcho] the ghost-tile tone
 * @property {{lo: number, hi: number}} range the pitch range mapped
 *     over the tile's height (midi_notes.fitPitchRange of the WHOLE
 *     take, so every rep of one take shares one vertical scale)
 * @property {number} [velocityLane] fraction of the height given to a
 *     velocity lane under the roll (0 / omitted = roll only)
 */

/**
 * Draw a MIDI clip's tile: one bar per note — pitch → row, length →
 * width, velocity → alpha — and, with `velocityLane`, one velocity stem
 * per onset beneath. `notes` are already sliced into tile fractions
 * (midi_notes.sliceNotesToTile, the audio tile's mapping), so windows,
 * cuts and comps apply here exactly as they do to peaks.
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
    let velH = Math.floor(cssH * Math.max(0, Math.min(0.5, opts.velocityLane || 0)));
    if (velH < MIDI_VEL_MIN_PX) velH = 0;
    const rollH = velH ? cssH - velH - MIDI_VEL_GAP_PX : cssH;
    const range = opts.range || MIDDLE_OCTAVE;
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
