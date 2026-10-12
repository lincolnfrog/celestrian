/**
 * COMP CELLS (docs/takes.md §3) in the segment editor's grammar: bands
 * over the take tile, laid out by comp_model.compLayout. At rest only
 * cells naming a take OTHER than the active one render — tinted in that
 * take's hue with the take's waveform slice drawn over the cell, where
 * the engine plays it, so the composite reads at a glance. In COMP MODE
 * (view state) every Q cell of the take renders as a dim band with a
 * badge (`T<k+1>`, `·` for the active take); a click cycles the cell
 * (comp_model.cycleComp) and commits ONE setComp — one undo step per
 * click. Cells are rebuilt with the overlay (keyed on the comp); their
 * slice canvases are patched per poll because take peaks arrive
 * asynchronously.
 */

import { ctx } from './context.js';
import { el, pct } from './sv_util.js';
import { drawWaveform } from '../canvas_renderer.js';
import { cycleComp, compBadge, compLayout, compOnGrid, regridComp }
    from '../comp_model.js';
import { COMMIT_HOLD_MAX_MS } from './gesture.js';

/* Cells never render thinner than this (px). */
const MIN_CELL_PX = 2;

const sameCells = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((c, i) => c === b[i]);

/** The grid the lane's comp sounds on (vm/lane_common.js takeFields). */
const soundingGrid = lane => ({
    cellQ: lane.compCellQ > 0 ? lane.compCellQ : 1,
    offsetQ: lane.compOffsetQ || 0,
});

/** The comp a click cycles FROM: the cells this body last committed
 * while the engine has not published them yet (two clicks inside one
 * poll must compose, not clobber) — for the commit cap at most: a
 * refusal never publishes them — else the published comp, read onto the
 * editor's grid when it sounds on another (the engine authors every
 * setComp on the Q grid as it lies now). */
function baseComp(body, lane) {
    const p = body._compPending;
    if (p && p.laneId === lane.id && Date.now() - p.at < COMMIT_HOLD_MAX_MS &&
        !sameCells(p.cells, lane.comp)) {
        return p.cells;
    }
    body._compPending = null;
    const { cellQ, offsetQ } = soundingGrid(lane);
    return compOnGrid(cellQ, offsetQ) ? lane.comp
        : regridComp(lane.comp, cellQ, offsetQ, lane.compCells || 0);
}

/** Append the lane's comp cells to the overlay `o`. Cells sit on the
 * lane's content-frame origin (takeStartQ), clipped to the slot's
 * extent. */
export function appendCompCells(o, lane, body, cycleQ) {
    const cells = lane.compCells || 0;
    if (!(cells > 0) || lane.kind !== 'clip' || lane.recording) return;
    const anchorQ = lane.takeStartQ || 0;
    const layout = compLayout({
        comp: lane.comp, cells, ...soundingGrid(lane),
        extentQ: lane.intrinsicQ || cells, activeTake: lane.activeTake,
        compMode: !!lane.compMode,
    });
    for (const c of layout) {
        const startQ = anchorQ + c.startQ;
        const endQ = anchorQ + c.endQ;
        if (endQ <= startQ || startQ >= cycleQ) continue;
        const cell = el('div', 'comp-cell' +
            (c.editing ? ' editing' : '') + (c.tint ? ' tint' : ''));
        cell.dataset.cell = String(c.cell);
        cell.dataset.take = String(c.named);
        cell.style.left = pct(startQ, cycleQ);
        cell.style.width = pct(Math.min(endQ, cycleQ) - startQ, cycleQ);
        if (c.tint) {
            cell.style.setProperty('--take-hue', c.tint.hue);
            // The slice: that take's peaks over this cell's span of the
            // slot (drawn in patchCompCanvases once the cache answers).
            const canvas = document.createElement('canvas');
            canvas.className = 'comp-slice';
            cell._slice = { take: c.tint.take, from: c.from, to: c.to };
            cell.appendChild(canvas);
        }
        cell.appendChild(el('div', 'comp-badge mono', {
            textContent: compBadge(c.named),
            title: c.named >= 0
                ? 'Take ' + (c.named + 1) + ' sounds in this cell'
                : 'The active take sounds here' }));
        if (c.editing) {
            cell.title = 'Click: cycle which take sounds in this Q (⌘Z undoes)';
            cell.addEventListener('click', e => {
                e.stopPropagation();
                const next = cycleComp(baseComp(body, lane), cells, c.cell, lane.takes);
                body._compPending = { laneId: lane.id, cells: next, at: Date.now() };
                ctx.cb.onSetComp(lane.id, next);
            });
        }
        o.appendChild(cell);
    }
    if (lane.compMode) {
        const done = el('div', 'win-chip comp-done-chip toggle', {
            textContent: 'comp · done',
            title: 'Close the comp editor (Esc) — the comp stays' });
        done.addEventListener('click', () => ctx.cb.onCompMode(lane.id, false));
        o.appendChild(done);
    }
}

/** Draw every tinted cell's slice whose take peaks are cached; a cell
 * draws once per peaks identity (the cache hands the same array back).
 * `bodyH` is the take tile's own waveform height (lane_body), and the
 * stylesheet insets the slice as it insets the tile (.comp-slice), so
 * the slice sits exactly over the tile's waveform. */
export function patchCompCanvases(overlay, lane, aux, bodyW, bodyH) {
    if (!aux || typeof aux.takePeaks !== 'function') return;
    overlay.querySelectorAll('.comp-cell.tint').forEach(cell => {
        const s = cell._slice;
        const canvas = cell.firstElementChild;
        if (!s || !canvas) return;
        const peaks = aux.takePeaks(lane.id, s.take);
        if (!peaks || !peaks.length || cell._peaksRef === peaks) return;
        cell._peaksRef = peaks;
        const n = peaks.length;
        const a = Math.max(0, Math.floor(s.from * n));
        const b = Math.min(n, Math.max(a + 1, Math.ceil(s.to * n)));
        const cssW = Math.max(MIN_CELL_PX,
            bodyW * (parseFloat(cell.style.width) / 100));
        canvas.style.width = Math.round(cssW) + 'px';
        drawWaveform(canvas, peaks.slice(a, b), { cssWidth: cssW, cssHeight: bodyH });
    });
}

/** The overlay-key contribution: everything a rebuild must follow. */
export function compKey(lane) {
    return [lane.comp || null, lane.compCells || 0, soundingGrid(lane),
            !!lane.compMode, lane.activeTake || 0, lane.takes || 0];
}
