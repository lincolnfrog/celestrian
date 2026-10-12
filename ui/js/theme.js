/**
 * Canvas palette + DPR canvas fitting: one source for every 2D-canvas
 * painter (canvas_renderer.js, fx_viz.js).
 *
 * The tones MIRROR custom properties in css/session.css :root. Canvas
 * code cannot read CSS variables (these modules also load under node,
 * with no DOM), so the pairs are kept by hand and pinned by
 * theme_palette.test.mjs:
 *
 *   TAPE.mid / AMBER  ↔  --amber        material, active audio
 *   COMPOSITE.mid     ↔  --amber-group  the group's composite mixdown
 *   ECHO.mid          ↔  --cyan         echoes, monitoring
 *
 * REC, GRID and CREAM are the fx cards' relatives of --record, --grid
 * and --text, tuned for the amber-lit card face; DIM has no :root
 * twin. The .top / .bottom of each tone are shades of its .mid for the
 * waveform's vertical gradient.
 */

// Amber carries MATERIAL. The composite is a clearly LIGHTER, creamier
// gold: one near the track amber reads as the same colour on real
// screens, and the contrast is lightness, not hue (colorblind-safe).
export const TAPE = { top: '#f0b45a', mid: '#e8a13c', bottom: '#c9871f' };
export const COMPOSITE = { top: '#f9ecc0', mid: '#f2d78f', bottom: '#dcbb60' };
// Every ghost tile is an audible repetition and draws in this cool
// tone; warm hues are kept for material, so an echo and muted original
// material cannot be confused. The tile's CSS opacity supplies the
// transparency.
export const ECHO = { top: '#84d6e2', mid: '#5fc9d8', bottom: '#3f9fb0' };

// Flat tokens for the fx-card painters (fx_viz.js).
export const AMBER = TAPE.mid;
export const REC = '#d94f30';
export const DIM = '#93826d';
export const GRID = '#322920';
export const CREAM = 'rgba(239, 230, 216, 0.8)';

/** '#rrggbb' at opacity `alpha` (0..1) → 'rgba(r, g, b, a)': painters
 * derive translucent fills from the tokens above, so no channel triple
 * is spelled twice. */
export function rgbaOf(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * THE DPR FIT. Sizes the backing store to css × devicePixelRatio (only
 * when it changed — resizing clears a canvas), sets the transform so
 * all drawing after it is in CSS pixels, and clears. Sizes are floored
 * and never below 2 px, so a degenerate rect cannot make a zero-sized
 * canvas. Under node the ratio is 1.
 *
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number}}
 *     the context and the size drawn at, in CSS pixels
 */
export function fitCanvas(canvas, cssW, cssH) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = Math.max(2, Math.floor(cssW || 0));
    const h = Math.max(2, Math.floor(cssH || 0));
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
}
