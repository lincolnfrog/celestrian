/**
 * Canvas palette + DPR canvas fitting — the single source of truth for
 * every 2D-canvas painter (canvas_renderer.js, fx_viz.js).
 *
 * These constants MIRROR the CSS custom properties in css/session.css
 * :root and must be kept in LOCKSTEP by hand: canvas code cannot read
 * CSS variables at runtime because the node unit tests (fx_viz.test.mjs,
 * waveform_stability.test.mjs) import these modules with no DOM. The
 * pairs:
 *
 *   TAPE.mid / AMBER  ↔  --amber        #e8a13c  (material / active audio)
 *   COMPOSITE.mid     ↔  --amber-group  #f2d78f  (group composite mixdown)
 *   ECHO.mid          ↔  --cyan         #5fc9d8  (echoes / monitoring)
 *   CREAM             ↔  --text family  (#d7dce2) — the fx cards' durable
 *                        spectrum line, warmed to rgba(239,230,216,·)
 *   REC               ↔  --record family (#b93e24/--record-hi #e06248) —
 *                        fx cards use #d94f30, tuned for 1.5px dashes
 *   GRID              ↔  --grid #2b2e33 — fx cards use the warmer
 *                        #322920 against the amber-lit card face
 *   DIM               ↔  (no :root twin) muted tape tone for dry pulses
 *
 * The .top/.bottom members of each tone triple are hand-derived shades
 * of the .mid for the waveform's vertical gradient. If a :root value
 * above moves, move the matching constant here in the same commit.
 */

// Dark tape theme (design handoff, theme-dark-tape.css): amber carries
// MATERIAL. The group composite is a clearly LIGHTER, creamier gold —
// a gold near the track amber reads as identical on real screens, so
// the composite pushes toward cream: same warm family (colorblind-safe:
// the contrast
// is lightness, not hue), unmistakably the group's mixdown at a glance.
export const TAPE = { top: '#f0b45a', mid: '#e8a13c', bottom: '#c9871f' };
export const COMPOSITE = { top: '#f9ecc0', mid: '#f2d78f', bottom: '#dcbb60' };
// Echo tone ("ghosts show what SOUNDS"):
// EVERY ghost tile is an audible repetition — of the full take or of a
// window segment — and draws in this cool tone. Warm tape hues are
// reserved for MATERIAL (the take tile, the live bar, the composite),
// so "echo of sound" and "muted original material" can never be
// confused anywhere in the timeline. Now the theme's colorblind-safe
// cyan (--cyan); the tile's CSS opacity supplies the echo transparency.
export const ECHO = { top: '#84d6e2', mid: '#5fc9d8', bottom: '#3f9fb0' };

// Flat tokens for the fx-card painters (fx_viz.js).
export const AMBER = '#e8a13c';
export const REC = '#d94f30';
export const DIM = '#93826d';
export const GRID = '#322920';
export const CREAM = 'rgba(239, 230, 216, 0.8)';

/**
 * '#rrggbb' → 'rgba(r, g, b, a)'. Lets painters derive translucent
 * fills from the flat tokens above instead of hardcoding channel
 * triples that silently drift when the palette moves.
 *
 * @param {string} hex six-digit '#rrggbb' color
 * @param {number} alpha 0..1 opacity
 * @returns {string} CSS 'rgba(r, g, b, a)' string
 */
export function rgbaOf(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The one DPR fit. Sizes the backing store to css×devicePixelRatio
 * (only when it changed — resizing clears a canvas), sets the transform
 * so ALL subsequent drawing is in CSS-pixel coordinates, and clears.
 * Under node (no window) the DPR is 1, so geometry stays deterministic
 * for tests. Sizes are floored to integers and clamped to a 2px
 * minimum so a degenerate rect can never produce a zero-sized canvas.
 *
 * @param {HTMLCanvasElement} canvas target canvas
 * @param {number} cssW desired width in CSS pixels
 * @param {number} cssH desired height in CSS pixels
 * @returns {{ctx: CanvasRenderingContext2D, w: number, h: number}}
 *     context plus the clamped size — both in CSS-pixel space
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
