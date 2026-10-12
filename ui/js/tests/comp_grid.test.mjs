/**
 * THE COMP'S CELLS LIE WHERE THE ENGINE PLAYS THEM (docs/takes.md §3).
 * A comp is authored on the Q grid as it lay then, and the engine keeps
 * that grid: it publishes `compCellLen` (the cell length, samples) and
 * `compOffset` (where cell 0 starts in the take, samples) beside `comp`
 * — cell k covers [compOffset + k·compCellLen, + compCellLen). A change
 * of Q leaves the stored length behind; a lock-collapse slides the
 * offset with the content. The lane draws the cells from those, and the
 * editor's grid — what a click authors — is the current Q grid.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { compOnGrid, compSpans, compTakeAt, regridComp, compLayout, takeHue }
    from '../comp_model.js';
import { SCENE_Q as Q, clip, state, laneOf } from './helpers.mjs';

const grid = lane => [lane.compCells, lane.compCellQ, lane.compOffsetQ];

test('the lane carries the published grid; without one, Q cells from the take\'s zero', () => {
    // Authored at this Q: on the editor's grid.
    const fresh = clip(4, { takes: 2, comp: [0, -1, 0, -1], compCellLen: Q, compOffset: 0 });
    // Authored when Q was half what it is now: eight half-Q cells.
    const stale = clip(4, { takes: 2, comp: [0, -1, 0, -1, -1, -1, -1, 0],
                            compCellLen: Q / 2, compOffset: 0 });
    // Slid by a lock-collapse that trimmed 2.5Q off the take's head.
    const slid = clip(2, { takes: 2, comp: [-1, -1, 0, 0, -1, -1, -1, -1],
                           compCellLen: Q, compOffset: -2.5 * Q });
    // A state that publishes neither key, and a clip with no comp (the
    // engine publishes 0 and 0).
    const bare = clip(4, { takes: 2, comp: [0, -1, 0, -1] });
    const none = clip(3, { takes: 2, comp: [], compCellLen: 0, compOffset: 0 });
    const vm = deriveViewModel(state([fresh, stale, slid, bare, none]));
    assert.deepEqual(grid(laneOf(vm, fresh.id)), [4, 1, 0]);
    assert.deepEqual(grid(laneOf(vm, stale.id)), [4, 0.5, 0],
        'the editor draws 4 cells; the comp sounds on 8 halves');
    assert.deepEqual(grid(laneOf(vm, slid.id)), [2, 1, -2.5]);
    assert.deepEqual(grid(laneOf(vm, bare.id)), [4, 1, 0]);
    assert.deepEqual(grid(laneOf(vm, none.id)), [3, 1, 0]);
});

test('compSpans: each cell where it sounds, clipped to the take', () => {
    const spans = (...a) => compSpans(...a).map(s => [s.cell, s.startQ, s.endQ]);
    assert.deepEqual(spans(4, 1, 0, 4), [[0, 0, 1], [1, 1, 2], [2, 2, 3], [3, 3, 4]]);
    assert.deepEqual(spans(4, 0.5, 0, 4),
        [[0, 0, 0.5], [1, 0.5, 1], [2, 1, 1.5], [3, 1.5, 2]],
        'cells authored at a shorter Q cover the take\'s head only');
    assert.deepEqual(spans(4, 2, 0, 4), [[0, 0, 2], [1, 2, 4]],
        'cells authored at a longer Q: the ones past the take are not drawn');
    assert.deepEqual(spans(8, 1, -2.5, 2), [[2, 0, 0.5], [3, 0.5, 1.5], [4, 1.5, 2]],
        'a slid grid: the edge cells are clipped, the rest lie outside');
    assert.deepEqual(spans(4, 1, 0, 3.5), [[0, 0, 1], [1, 1, 2], [2, 2, 3], [3, 3, 3.5]],
        'a take that ends inside a cell');
    assert.deepEqual(spans(0, 1, 0, 4), []);
    assert.deepEqual(spans(4, 0, 0, 4), [], 'no cell length: no cells');
});

test('compTakeAt: the take that sounds at a position of the take', () => {
    const comp = [0, -1, 1, -1];
    assert.equal(compTakeAt(comp, 1, 0, 0.5), 0);
    assert.equal(compTakeAt(comp, 1, 0, 1), -1);
    assert.equal(compTakeAt(comp, 1, 0, 2.99), 1);
    assert.equal(compTakeAt(comp, 1, 0, 7), -1, 'past the last cell: the active take');
    assert.equal(compTakeAt(comp, 1, 1.5, 1), -1, 'before the first cell: the active take');
    assert.equal(compTakeAt(comp, 1, 1.5, 1.5), 0);
    assert.equal(compTakeAt(comp, 0.5, 0, 1.25), 1);
    assert.equal(compTakeAt([], 1, 0, 0), -1);
});

test('the editor\'s grid: on it, the comp as stored; off it, re-read cell by cell', () => {
    assert.equal(compOnGrid(1, 0), true);
    assert.equal(compOnGrid(0.5, 0), false);
    assert.equal(compOnGrid(1, -2.5), false);
    assert.equal(compOnGrid(1, 1e-12), true, 'float noise is no offset');
    // Each editor cell names the take sounding at its start.
    assert.deepEqual(regridComp([0, -1, 0, -1, -1, -1, -1, 0], 0.5, 0, 4), [0, 0, -1, -1]);
    assert.deepEqual(regridComp([-1, -1, 0, 0, -1, -1, -1, -1], 1, -2.5, 2), [0, 0]);
    assert.deepEqual(regridComp([0, 1], 2, 0, 4), [0, 0, 1, 1]);
    assert.deepEqual(regridComp([0, -1, 0, -1], 1, 0, 4), [0, -1, 0, -1], 'on the grid: itself');
});

const layout = o => compLayout(o).map(c =>
    [c.cell, c.startQ, c.endQ, c.named, c.tint ? c.tint.take : null, c.editing]);

test('at rest the lane draws the cells that name another take, where they sound', () => {
    const lane = { comp: [0, -1, 0, -1], cells: 4, cellQ: 1, offsetQ: 0, extentQ: 4,
                   activeTake: 1, compMode: false };
    assert.deepEqual(layout(lane), [[0, 0, 1, 0, 0, false], [2, 2, 3, 0, 0, false]]);
    // The same comp after Q doubled: the editor would draw 2 cells of
    // the 4-old-Q take, but the engine still plays four half-Q cells.
    assert.deepEqual(layout({ ...lane, cells: 2, cellQ: 0.5, extentQ: 2 }),
        [[0, 0, 0.5, 0, 0, false], [2, 1, 1.5, 0, 0, false]]);
    // Slid by a collapse: cell 2 is cut by the take's head.
    assert.deepEqual(layout({ comp: [-1, -1, 0, 0, -1, -1, -1, -1], cells: 2, cellQ: 1,
                              offsetQ: -2.5, extentQ: 2, activeTake: 1, compMode: false }),
        [[2, 0, 0.5, 0, 0, false], [3, 0.5, 1.5, 0, 0, false]]);
    assert.deepEqual(layout({ ...lane, comp: [] }), [], 'no comp, no cells');
});

test('a cell\'s slice is the part of the take it covers', () => {
    const frac = o => compLayout(o).map(c => [c.from, c.to]);
    assert.deepEqual(frac({ comp: [0, 0], cells: 2, cellQ: 1, offsetQ: 0, extentQ: 2,
                            activeTake: 1, compMode: false }), [[0, 0.5], [0.5, 1]]);
    // A 3.5Q take: its last cell is half a Q, a seventh of the take.
    const cells = frac({ comp: [0, 0, 0, 0], cells: 4, cellQ: 1, offsetQ: 0, extentQ: 3.5,
                         activeTake: 1, compMode: false });
    assert.deepEqual(cells[3], [3 / 3.5, 1]);
    assert.deepEqual(cells[0], [0, 1 / 3.5]);
});

test('comp mode on the editor\'s grid: every cell, once — band, badge, tint', () => {
    const lane = { comp: [0, -1], cells: 3, cellQ: 1, offsetQ: 0, extentQ: 2.5,
                   activeTake: 1, compMode: true };
    assert.deepEqual(layout(lane), [
        [0, 0, 1, 0, 0, true], [1, 1, 2, -1, null, true], [2, 2, 2.5, -1, null, true]]);
    assert.deepEqual(layout({ ...lane, comp: [] }),
        [[0, 0, 1, -1, null, true], [1, 1, 2, -1, null, true], [2, 2, 2.5, -1, null, true]],
        'no comp yet: the grid a click authors on');
    assert.equal(compLayout(lane)[0].tint.hue, takeHue(0));
});

test('comp mode off the editor\'s grid: what sounds, then the cells a click authors', () => {
    // Four half-Q cells [T1 · T1 ·] over the head of a 2Q take.
    const cells = layout({ comp: [0, -1, 0, -1], cells: 2, cellQ: 0.5, offsetQ: 0,
                           extentQ: 2, activeTake: 1, compMode: true });
    assert.deepEqual(cells, [
        // what sounds, exactly: inert tints
        [0, 0, 0.5, 0, 0, false], [2, 1, 1.5, 0, 0, false],
        // the editor's cells: each names the take sounding at its start
        [0, 0, 1, 0, null, true], [1, 1, 2, 0, null, true]]);
});

/* ---- the lane's overlay (session_view/comp_cells.js) ---- */

/** A node that keeps what comp_cells writes on it. */
function fakeEl(tag) {
    const listeners = new Map();
    return {
        tag, className: '', dataset: {}, children: [],
        style: { setProperty(k, v) { this[k] = v; } },
        appendChild(c) { this.children.push(c); return c; },
        addEventListener(type, fn) { listeners.set(type, fn); },
        click() { listeners.get('click')?.({ stopPropagation() {} }); },
    };
}

test('the overlay: tints where the engine plays them; a click sends today\'s grid', async () => {
    globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
    globalThis.document = { createElement: fakeEl, getElementById: () => null,
                            querySelectorAll: () => [], activeElement: null };
    const { appendCompCells } = await import('../session_view/comp_cells.js');
    const { ctx } = await import('../session_view/context.js');
    const sent = [];
    ctx.cb = { onSetComp: (id, cells) => sent.push([id, cells]), onCompMode() {} };
    // A 2Q take whose tile starts 2Q into an 8Q frame; its comp was
    // authored when Q was half as long: [T1 · T1 ·] over its first Q.
    const lane = { id: 'c', kind: 'clip', recording: false, takeStartQ: 2, intrinsicQ: 2,
                   comp: [0, -1, 0, -1], compCells: 2, compCellQ: 0.5, compOffsetQ: 0,
                   activeTake: 1, takes: 2, compMode: false };
    const cellsOf = l => {
        const o = fakeEl('div');
        appendCompCells(o, l, {}, 8);
        return o.children.filter(c => c.className.includes('comp-cell'));
    };
    const drawn = c => [c.className, c.dataset.cell, c.dataset.take, c.style.left, c.style.width];
    assert.deepEqual(cellsOf(lane).map(drawn), [
        ['comp-cell tint', '0', '0', '25%', '6.25%'],
        ['comp-cell tint', '2', '0', '37.5%', '6.25%']]);
    assert.deepEqual(cellsOf(lane).map(c => c._slice),
        [{ take: 0, from: 0, to: 0.25 }, { take: 0, from: 0.5, to: 0.75 }]);

    const editing = cellsOf({ ...lane, compMode: true });
    assert.deepEqual(editing.map(drawn), [
        ['comp-cell tint', '0', '0', '25%', '6.25%'],
        ['comp-cell tint', '2', '0', '37.5%', '6.25%'],
        ['comp-cell editing', '0', '0', '25%', '12.5%'],
        ['comp-cell editing', '1', '0', '37.5%', '12.5%']]);
    // The engine authors every setComp on the Q grid as it lies now: the
    // click sends the comp re-read onto it, the clicked cell cycled.
    editing[3].click();
    assert.deepEqual(sent, [['c', [0, 1]]]);

    // On the editor's grid nothing is drawn twice, and a click cycles
    // the stored cell.
    sent.length = 0;
    const onGrid = cellsOf({ ...lane, comp: [0, -1], compCellQ: 1, compMode: true });
    assert.deepEqual(onGrid.map(drawn), [
        ['comp-cell editing tint', '0', '0', '25%', '12.5%'],
        ['comp-cell editing', '1', '-1', '37.5%', '12.5%']]);
    onGrid[1].click();
    assert.deepEqual(sent, [['c', [0, 0]]]);
});
