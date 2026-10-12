/**
 * The comp model (docs/takes.md §3), pure: the per-cell cycle rule a
 * click applies, the normalization the engine expects, the per-take
 * tint and the cells a lane draws. No DOM — session_view/comp_cells.js
 * renders it; tests/takes_ui.test.mjs and tests/comp_grid.test.mjs pin
 * it.
 *
 * A comp is one take index per Q cell of the slot (cells =
 * ceil(period / Q)); −1 names the active take; [] is "no comp".
 *
 * TWO GRIDS. A comp SOUNDS on the grid it was authored on, which the
 * engine keeps and publishes: cell k covers [offsetQ + k·cellQ, +cellQ)
 * of the take. The EDITOR's grid — what a click authors — is the Q grid
 * as it lies now: one cell per Q from the take's zero. They are one
 * grid until Q changes under a comp or a lock-collapse slides it.
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
 * A cell's tint: the hue of the take it names when that take is NOT the
 * active one (a cell naming the active take, explicitly or as −1, draws
 * what the tile already shows — no tint). { take, hue } or null.
 */
const tintOf = (named, activeTake) => (named >= 0 && named !== activeTake
    ? { take: named, hue: takeHue(named) } : null);

/** The badge a cell wears in comp mode: `T<k+1>`, or `·` for −1. */
export const compBadge = c => (c >= 0 ? 'T' + (c + 1) : '·');

/* ---- the two grids ---- */

/** Float noise allowed in a grid's cell length and offset, Q. */
const GRID_EPS = 1e-9;

/** Is the grid a comp sounds on the editor's — Q cells from the take's
 * zero? */
export function compOnGrid(cellQ, offsetQ) {
    return Math.abs(cellQ - 1) < GRID_EPS && Math.abs(offsetQ) < GRID_EPS;
}

/**
 * Where a comp's `count` cells sound over a take `extentQ` long, in Q of
 * the take: cell k at [offsetQ + k·cellQ, + cellQ), clipped to the take;
 * a cell that lies outside it is left out.
 *
 * @returns {Array<{cell: number, startQ: number, endQ: number}>}
 */
export function compSpans(count, cellQ, offsetQ, extentQ) {
    const out = [];
    if (!(cellQ > 0)) return out;
    for (let k = 0; k < count; k++) {
        const startQ = Math.max(0, offsetQ + k * cellQ);
        const endQ = Math.min(extentQ, offsetQ + (k + 1) * cellQ);
        if (endQ - startQ > GRID_EPS) out.push({ cell: k, startQ, endQ });
    }
    return out;
}

/** The take a comp names at `q` of the take; −1 (the active take) where
 * no cell lies. */
export function compTakeAt(comp, cellQ, offsetQ, q) {
    if (!Array.isArray(comp) || !(cellQ > 0)) return -1;
    const k = Math.floor((q - offsetQ) / cellQ + GRID_EPS);
    const c = k >= 0 && k < comp.length ? comp[k] : -1;
    return typeof c === 'number' ? c : -1;
}

/** A comp read onto the editor's grid of `cells` Q cells: each names the
 * take that sounds at its start. */
export function regridComp(comp, cellQ, offsetQ, cells) {
    const out = [];
    for (let i = 0; i < cells; i++) out.push(compTakeAt(comp, cellQ, offsetQ, i));
    return out;
}

/**
 * THE CELLS A LANE DRAWS, in Q of the take.
 *
 * At rest: the cells naming a take other than the active one, where
 * they sound. In comp mode: every cell of the editor's grid, each a
 * band a click cycles (`editing`). While the comp sounds on another
 * grid the two are drawn apart — what sounds first, as at rest, then
 * the editor's cells naming what a click would author (regridComp).
 *
 * @param {Object} o  { comp, cells (the editor's count), cellQ, offsetQ
 *     (the grid the comp sounds on), extentQ (the take), activeTake,
 *     compMode }
 * @returns {Array<{cell: number, startQ: number, endQ: number,
 *     named: number, tint: ?{take: number, hue: string},
 *     editing: boolean, from: number, to: number}>}  `cell` indexes the
 *     grid the entry lies on; `named` the take it names (−1 = active);
 *     `from` / `to` its span as fractions of the take
 */
export function compLayout({ comp, cells, cellQ, offsetQ, extentQ, activeTake,
                             compMode }) {
    const list = Array.isArray(comp) ? comp : [];
    const nameOf = k => (k < list.length && typeof list[k] === 'number' ? list[k] : -1);
    const entry = ({ cell, startQ, endQ }, named, editing, tinted) => ({
        cell, startQ, endQ, named, editing,
        tint: tinted ? tintOf(named, activeTake) : null,
        from: startQ / extentQ, to: endQ / extentQ,
    });
    if (compOnGrid(cellQ, offsetQ)) {
        return compSpans(cells, 1, 0, extentQ)
            .map(s => entry(s, nameOf(s.cell), !!compMode, true))
            .filter(c => c.editing || c.tint);
    }
    const sounding = compSpans(list.length, cellQ, offsetQ, extentQ)
        .map(s => entry(s, nameOf(s.cell), false, true))
        .filter(c => c.tint);
    if (!compMode) return sounding;
    const authored = regridComp(list, cellQ, offsetQ, cells);
    return sounding.concat(compSpans(cells, 1, 0, extentQ)
        .map(s => entry(s, authored[s.cell], true, false)));
}
