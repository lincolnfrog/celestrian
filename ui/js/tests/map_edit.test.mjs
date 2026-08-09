/**
 * Map-editor algebra (time_maps.md §4 — CUT BANDS, owner-chosen
 * 2026-07-22): the sequencer's pure math.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeSegments, coveredSet, cutsOf, innerCuts, applyCut, healCut,
    cellCutAt, resizeCutTarget, slideCutTarget,
    segsPeriod, trimBoundTo, trimBoundForPeriod, cutBounds,
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

test('resizeCutTarget: linked kQ edges, always whole (no free mode)', () => {
    // Pull the end of a 1Q cut from 2.98 to 3.58: raw length 1.6 snaps
    // to 2Q — the START edge holds (linked edges).
    let t = resizeCutTarget({ cut: [1.98, 2.98], edge: 'end', rawQ: 3.58, maxQ: 4 });
    assert.equal(t.inQ, 1.98);
    assert.ok(Math.abs(t.outQ - 3.98) < 1e-9, 'end lands at start + 2Q');
    assert.equal(t.coherent, true);
    // Start-edge resize snaps against the held END edge (1.6Q → 2Q).
    t = resizeCutTarget({ cut: [2, 3], edge: 'start', rawQ: 1.4, maxQ: 4 });
    assert.ok(Math.abs(t.inQ - 1) < 1e-9, 'raw 1.6Q rounds to 2Q; end holds');
    // Owner ruling 2026-08-09: the ⌥-free escape hatch is GONE — a raw
    // 1.37Q pull snaps to 1Q, coherent, always.
    t = resizeCutTarget({ cut: [2, 3], edge: 'end', rawQ: 3.37, maxQ: 4 });
    assert.ok(Math.abs(t.lenQ - 1) < 1e-9, 'no free lengths, ever');
    assert.equal(t.coherent, true);
    // Clamped to the span (room caps the whole-Q length).
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

/* Owner ruling 2026-08-09 (categorical coherence): a cut may only meet
 * a neighbouring gap at EXACT adjacency — fractional overlap minted
 * fractional periods (removing 0.8Q of kept material from a whole
 * grid). cutBounds is the clamp; these pin it. */
test('cutBounds + collision clamps keep periods whole', () => {
    // A window'd take: leading gap [0,1), cut [1.5,2.5), totalQ 4.
    const segs = [[1, 1.5], [2.5, 4]];
    const [lo, hi] = cutBounds(segs, [1.5, 2.5], 4);
    assert.deepEqual([lo, hi], [1, 4],
        'the healed kept segment around the cut');

    // Sliding toward the leading gap stops at exact adjacency (1.0),
    // never fractionally overlapping it.
    let t = slideCutTarget({ cut: [1.5, 2.5], rawStartQ: 0.3, maxQ: 4,
                             loQ: lo, hiQ: hi });
    assert.deepEqual([t.inQ, t.outQ], [1, 2],
        'slide clamps to the kept neighbourhood');
    // Adjacency merge stays whole: gaps [0,1) ∪ [1,2) remove exactly 2Q.
    const merged = applyCut(healCut(segs, 1.5, 2.5, 4), t.inQ, t.outQ, 4);
    const p = segsPeriod(merged, 4);
    assert.ok(Math.abs(p - Math.round(p)) < 1e-9, 'merged period whole');

    // Two inner cuts: resizing one toward the other is capped by the
    // room between them (whole Qs only), so it can abut but not lap.
    const two = [[0, 1.2], [2.2, 3.2], [4.2, 6]];  // cuts at [1.2,2.2), [3.2,4.2)
    const [lo2, hi2] = cutBounds(two, [1.2, 2.2], 6);
    assert.deepEqual([lo2, hi2], [0, 3.2]);
    t = resizeCutTarget({ cut: [1.2, 2.2], edge: 'end', rawQ: 3.9, maxQ: 6,
                          loQ: lo2, hiQ: hi2 });
    assert.ok(t.outQ <= hi2 + 1e-9, 'cannot lap the next cut');
    assert.ok(Math.abs(t.lenQ - Math.round(t.lenQ)) < 1e-9,
        'capped length is still whole');
});

test('trimBoundTo: outer bounds heal reveals / cut consumes', () => {
    assert.deepEqual(trimBoundTo(null, 'end', 2, 3), [[0, 2]],
        'trim the full span in');
    assert.deepEqual(trimBoundTo([[0, 2]], 'end', 3, 3), [],
        'trim back out heals to no-map');
    assert.deepEqual(trimBoundTo([[1, 3]], 'start', 2, 3), [[2, 3]]);
    assert.equal(trimBoundTo([[1, 2]], 'end', 1, 3), null,
        'nothing would sound: refusal');
});

/* THE 2026-08-08 FIELD VIDEO (LCM explosion): a 1Q cut slid off-grid
 * to [1.35, 2.35) in a 3Q take, then the loop end trimmed. Snapping
 * the BOUND to whole Qs committed a fractional PERIOD (0.65Q…), and
 * lcm(quantum, period) exploded the cycle to 66187Q. The law: trims
 * snap the PERIOD; the bound lands wherever that period lives. */
test('trimBoundForPeriod: period-coherent trim over a free-slid cut', () => {
    const segs = [[0, 1.35], [2.35, 3]];  // 1Q cut slid to 1.35

    // Pointer near the old end proposes ~1.65Q → target 2Q → the bound
    // must land at totalQ (the full kept set IS 2Q).
    let b = trimBoundForPeriod(segs, 'end', 2, 3);
    assert.ok(Math.abs(b - 3) < 1e-9, 'period 2Q lives at the far edge');
    assert.equal(segsPeriod(trimBoundTo(segs, 'end', b, 3), 3), 2);

    // Target 1Q: slope-1 walk inside the first segment → bound at 1.
    b = trimBoundForPeriod(segs, 'end', 1, 3);
    assert.ok(Math.abs(b - 1) < 1e-9);
    assert.equal(segsPeriod(trimBoundTo(segs, 'end', b, 3), 3), 1);

    // Start edge, target 1Q: walked from the right (the 0.65Q tail
    // counts first), the bound lands at 1.0 — kept [1, 1.35] ∪ [2.35, 3]
    // = 0.35 + 0.65 = exactly 1Q. A whole-BOUND snap would have given
    // 1.65Q or 0.65Q; only the period walk finds this.
    b = trimBoundForPeriod(segs, 'start', 1, 3);
    const got = segsPeriod(trimBoundTo(segs, 'start', b, 3), 3);
    assert.ok(Math.abs(got - 1) < 1e-9,
        'whatever bound it picks, the PERIOD is whole');

    // Every whole target over every edge yields a whole period — the
    // invariant the engine's cycle LCM depends on.
    for (const edge of ['start', 'end']) {
        for (let P = 1; P <= 3; P++) {
            const bb = trimBoundForPeriod(segs, edge, P, 3);
            const next = trimBoundTo(segs, edge, bb, 3);
            if (next === null) continue;  // refusal is fine; fractional is not
            const p = segsPeriod(next, 3);
            assert.ok(Math.abs(p - Math.round(p)) < 1e-9,
                `${edge} target ${P}Q → period ${p} must be whole`);
        }
    }

    // Unclamped heal past the take end is impossible: bounds clamp to
    // the span, and the target clamps to the largest reachable whole Q.
    b = trimBoundForPeriod([[0.5, 1.35], [2.35, 2.5]], 'end', 5, 3);
    assert.ok(b <= 3 + 1e-9);
});
