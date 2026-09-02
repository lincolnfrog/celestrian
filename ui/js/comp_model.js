/**
 * The comp model (docs/takes.md §3), pure: the per-cell cycle rule a
 * click applies, the normalization the engine expects, and the
 * per-take tint the lane draws. No DOM — session_view/comp_cells.js
 * renders it, tests/takes_ui.test.mjs pins it.
 *
 * A comp is one take index per Q cell of the slot (cells =
 * ceil(period / Q)); −1 names the active take; [] is "no comp".
 */

/** Hues for takes other than the active one (badge + slice tint).
 * Take k draws in TAKE_PALETTE[k % length]; the badge carries the
 * number, so hue is a glance aid, never the only carrier. */
export const TAKE_PALETTE = Object.freeze([
    '#5fc9d8',  // cyan
    '#c48be0',  // violet
    '#8fd18a',  // green
    '#f0a5b8',  // pink
    '#e8d16a',  // yellow
    '#7fa4f0',  // blue
]);

/** The hue take k draws in. */
export const takeHue = k => TAKE_PALETTE[((k % TAKE_PALETTE.length) +
    TAKE_PALETTE.length) % TAKE_PALETTE.length];

/**
 * One click on a cell: −1 → 0 → 1 … → takes−1 → −1. A slot with one
 * take cycles −1 → 0 → −1 (choosing the only take is choosing the
 * active one; the badge still says so).
 */
export function cycleCell(current, takes) {
    const n = Math.max(1, takes | 0);
    if (current < 0) return 0;
    if (current >= n - 1) return -1;
    return current + 1;
}

/**
 * The cells a click on cell `index` commits: the current comp
 * widened to `cells` entries (absent cells are −1), the clicked cell
 * cycled, and the all-active result normalized to [] (the engine's
 * "no comp" — an explicit all-−1 array would be a comp naming nothing).
 */
export function cycleComp(comp, cells, index, takes) {
    const out = [];
    for (let i = 0; i < cells; i++) {
        const c = Array.isArray(comp) && i < comp.length ? comp[i] : -1;
        out.push(typeof c === 'number' ? c : -1);
    }
    if (index < 0 || index >= cells) return out.every(c => c < 0) ? [] : out;
    out[index] = cycleCell(out[index], takes);
    return out.every(c => c < 0) ? [] : out;
}

/**
 * Per-cell tint: the hue of the take a cell names when that take is
 * NOT the active one (a cell naming the active take, explicitly or as
 * −1, draws what the tile already shows — no tint). Returns one entry
 * per cell: { take, hue } or null.
 */
export function compCellTints(comp, cells, activeTake) {
    const out = [];
    for (let i = 0; i < cells; i++) {
        const c = Array.isArray(comp) && i < comp.length ? comp[i] : -1;
        out.push(c >= 0 && c !== activeTake ? { take: c, hue: takeHue(c) } : null);
    }
    return out;
}

/** The badge a cell wears in comp mode: `T<k+1>`, or `·` for −1. */
export const compBadge = c => (c >= 0 ? 'T' + (c + 1) : '·');
