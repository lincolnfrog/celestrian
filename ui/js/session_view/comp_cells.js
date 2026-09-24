/**
 * COMP CELLS (docs/takes.md §3) in the segment editor's grammar: one
 * band per Q cell of the slot over the take tile. At rest only cells
 * naming a take OTHER than the active one render — tinted in that
 * take's hue with the take's waveform slice drawn over the cell, so
 * the composite reads at a glance. In COMP MODE (view state) every
 * cell renders as a dim band with a badge (`T<k+1>`, `·` for the
 * active take); a click cycles the cell (comp_model.cycleComp) and
 * commits ONE setComp — one undo step per click. Cells are rebuilt
 * with the overlay (keyed on the comp); their slice canvases are
 * patched per poll because take peaks arrive asynchronously.
 */

import { ctx } from './context.js';
import { el, pct } from './sv_util.js';
import { drawWaveform } from '../canvas_renderer.js';
import { cycleComp, compCellTints, compBadge } from '../comp_model.js';

/* The tile's vertical inset (lane_body BODY_V_INSET_PX twin): the
 * slice canvas sits exactly over the tile's waveform. */
const CELL_V_INSET_PX = 3;
/* Cells never render thinner than this (px). */
const MIN_CELL_PX = 2;
/* A committed-but-unpublished comp is the base for the next click for
 * at most this long (a refusal never publishes it; the twin of
 * gesture.js's COMMIT_HOLD_MAX_MS). */
const PENDING_MAX_MS = 1500;

const sameCells = (a, b) => Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((c, i) => c === b[i]);

/** The comp a click cycles FROM: the cells this body last committed
 * while the engine has not published them yet (two clicks inside one
 * poll must compose, not clobber), else the published comp. */
function baseComp(body, lane) {
    const p = body._compPending;
    if (p && p.laneId === lane.id && Date.now() - p.at < PENDING_MAX_MS &&
        !sameCells(p.cells, lane.comp)) {
        return p.cells;
    }
    body._compPending = null;
    return lane.comp;
}

/** Append the lane's comp cells to the overlay `o`. Cells sit on the
 * lane's content-frame origin (takeStartQ), one Q each, clipped to
 * the slot's extent. */
export function appendCompCells(o, lane, vm, body, cycleQ) {
    const cells = lane.compCells || 0;
    if (!(cells > 0) || lane.kind !== 'clip' || lane.recording) return;
    const anchorQ = lane.takeStartQ || 0;
    const extentQ = lane.intrinsicQ || cells;
    const tints = compCellTints(lane.comp, cells, lane.activeTake);
    for (let i = 0; i < cells; i++) {
        const tint = tints[i];
        if (!lane.compMode && !tint) continue;
        const startQ = anchorQ + i;
        const endQ = anchorQ + Math.min(i + 1, extentQ);
        if (endQ <= startQ || startQ >= cycleQ) continue;
        const cell = el('div', 'comp-cell' +
            (lane.compMode ? ' editing' : '') + (tint ? ' tint' : ''));
        cell.dataset.cell = String(i);
        const named = Array.isArray(lane.comp) && i < lane.comp.length
            ? lane.comp[i] : -1;
        cell.dataset.take = String(named);
        cell.style.left = pct(startQ, cycleQ);
        cell.style.width = pct(Math.min(endQ, cycleQ) - startQ, cycleQ);
        if (tint) {
            cell.style.setProperty('--take-hue', tint.hue);
            // The slice: take k's peaks over this cell's span of the
            // slot (drawn in patchCompCanvases once the cache answers).
            const canvas = document.createElement('canvas');
            canvas.className = 'comp-slice';
            cell._slice = { take: tint.take, from: i / cells, to: (i + 1) / cells };
            cell.appendChild(canvas);
        }
        if (lane.compMode || tint) {
            const badge = el('div', 'comp-badge mono', {
                textContent: compBadge(named),
                title: named >= 0
                    ? 'Take ' + (named + 1) + ' sounds in this cell'
                    : 'The active take sounds here' });
            cell.appendChild(badge);
        }
        if (lane.compMode) {
            cell.title = 'Click: cycle which take sounds in this Q (⌘Z undoes)';
            cell.addEventListener('click', e => {
                e.stopPropagation();
                const next = cycleComp(baseComp(body, lane), cells, i, lane.takes);
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
 * draws once per peaks identity (the cache hands the same array back). */
export function patchCompCanvases(overlay, lane, aux, bodyW, bodyH, cycleQ) {
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
        const cssH = Math.max(2, bodyH - 2 * CELL_V_INSET_PX);
        canvas.style.width = Math.round(cssW) + 'px';
        canvas.style.height = Math.round(cssH) + 'px';
        drawWaveform(canvas, peaks.slice(a, b), { cssWidth: cssW, cssHeight: cssH });
    });
}

/** The overlay-key contribution: everything a rebuild must follow. */
export function compKey(lane) {
    return [lane.comp || null, lane.compCells || 0, !!lane.compMode,
            lane.activeTake || 0, lane.takes || 0];
}
