/**
 * Map-editor algebra (time_maps.md §4 — CUT BANDS, owner-chosen
 * 2026-07-22): the sequencer's pure math.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeSegments, coveredSet, cutsOf, innerCuts, applyCut, healCut,
    cellCutAt, resizeCutTarget, slideCutTarget,
} from '../map_edit.js';

test('covered/cuts/inner helpers', () => {
    assert.deepEqual(normalizeSegments([[2, 3], [0, 1], [1, 2]]), [[0, 3]],
        'sorts and merges touching runs');
    assert.deepEqual(coveredSet([], 4), [[0, 4]], 'empty = full span');
    assert.deepEqual(cutsOf([[1, 2.3], [3.3, 4]], 4),
        [[0, 1], [2.3, 3.3]], 'all gaps, leading included');
    // Inner cuts exclude the leading/trailing gaps — those belong to
    // the window brackets.
    assert.deepEqual(innerCuts([[1, 2.3], [3.3, 4]], 4), [[2.3, 3.3]],
        'leading gap is bracket territory, not a band');
    assert.deepEqual(innerCuts([[0, 1], [2, 3], [3.5, 4]], 4),
        [[1, 2], [3, 3.5]], 'multiple inner bands');
});

test('cellCutAt: double-click creates a cell-snapped 1Q cut', () => {
    assert.deepEqual(cellCutAt(2.7, 4), [2, 3]);
    assert.deepEqual(cellCutAt(0.01, 4), [0, 1]);
    assert.deepEqual(cellCutAt(3.99, 4), [3, 4]);
});

test('applyCut / healCut: place, split, heal, refusals', () => {
    assert.deepEqual(applyCut(null, 1, 2, 4), [[0, 1], [2, 4]],
        'cut Q2 out of the full span');
    assert.deepEqual(applyCut([[0, 4]], 1.5, 2.5, 4), [[0, 1.5], [2.5, 4]],
        'a cut inside a segment splits it');
    assert.deepEqual(applyCut([[0, 1], [2, 4]], 0.5, 2.5, 4),
        [[0, 0.5], [2.5, 4]], 'a cut across a seam trims both sides');
    assert.equal(applyCut([[1, 2]], 0, 4, 4), null,
        'cutting everything refuses');
    assert.deepEqual(healCut([[0, 1.5], [2.5, 4]], 1.5, 2.5, 4), [],
        'healing the only cut restores no-map (full-span symmetry)');
    assert.deepEqual(healCut([[0, 1], [2, 3.4], [3.6, 4]], 3.4, 3.6, 4),
        [[0, 1], [2, 4]], 'healing one of several merges neighbours');
    const many = [];
    for (let i = 0; i < 9; i++) many.push([i * 2, i * 2 + 1]);
    assert.equal(applyCut(many, 0.25, 0.5, 18), null,
        'segment-count guard refuses');
});

test('resizeCutTarget: linked kQ edges, Alt frees with ⚠', () => {
    // Pull the end of a 1Q cut from 2.98 to 3.58: raw length 1.6 snaps
    // to 2Q — the START edge holds (linked edges).
    let t = resizeCutTarget({ cut: [1.98, 2.98], edge: 'end', rawQ: 3.58, maxQ: 4 });
    assert.equal(t.inQ, 1.98);
    assert.ok(Math.abs(t.outQ - 3.98) < 1e-9, 'end lands at start + 2Q');
    assert.equal(t.coherent, true);
    // Start-edge resize snaps against the held END edge (1.6Q → 2Q).
    t = resizeCutTarget({ cut: [2, 3], edge: 'start', rawQ: 1.4, maxQ: 4 });
    assert.ok(Math.abs(t.inQ - 1) < 1e-9, 'raw 1.6Q rounds to 2Q; end holds');
    // Alt: free length, flagged.
    t = resizeCutTarget({ cut: [2, 3], edge: 'end', rawQ: 3.37, maxQ: 4, free: true });
    assert.ok(Math.abs(t.lenQ - 1.37) < 1e-9);
    assert.equal(t.coherent, false, 'the ⚠ badge case');
    // Clamped to the span.
    t = resizeCutTarget({ cut: [3, 4], edge: 'end', rawQ: 9, maxQ: 4 });
    assert.equal(t.outQ, 4);
});

test('slideCutTarget: free position, length held, clamped', () => {
    let t = slideCutTarget({ cut: [2.3, 3.3], rawStartQ: 1.98, maxQ: 4 });
    assert.deepEqual([t.inQ, t.outQ], [1.98, 2.98], 'slides off-grid freely');
    assert.equal(t.coherent, true, '1Q length stays groove-transparent');
    t = slideCutTarget({ cut: [1, 2], rawStartQ: 3.7, maxQ: 4 });
    assert.deepEqual([t.inQ, t.outQ], [3, 4], 'clamped at the far edge');
});
