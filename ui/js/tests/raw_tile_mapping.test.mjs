/**
 * A RAW TILE DRAWS THE PART OF ITS TAKE THAT SOUNDS UNDER IT. A plain
 * loop tiles the frame from its own origin, so a tile can straddle the
 * frame's end: the frame cuts it in two pieces, each showing only its
 * share of the take. Measured at the seam the lane paints through
 * (session_view/lane_body.js tileMap, then the renderer's column
 * samplers) against what the engine plays there (time_map.innerAt).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
    addEventListener() {}, removeEventListener() {},
};
globalThis.document = globalThis.document || {
    activeElement: null, getElementById() { return null; },
    querySelectorAll() { return []; },
};

const { tileMap, tileCssWidth } = await import('../session_view/lane_body.js');
const { mappedColumns, poolColumns } = await import('../canvas_renderer.js');
const { innerAt, singleSegment } = await import('../time_map.js');
const { deriveViewModel, unrollReps } = await import('../view_model.js');

const Q = 1000;
const clip = (id, originQ, durQ, extra = {}) => ({
    id, type: 'clip', name: id, origin: Math.round(originQ * Q),
    duration: Math.round(durQ * Q), loopStart: 0, loopEnd: 0,
    windowActive: false, loopBypassed: false, isRecording: false,
    isPendingStart: false, periodSource: 'own', ...extra,
});
const stack = (id, originQ, nodes) => ({
    id, type: 'stack', name: id, nodes, origin: Math.round(originQ * Q),
    anchored: true, loopStart: 0, loopEnd: 0, windowActive: false,
    loopBypassed: false, isRecording: false, periodSource: 'own',
});
const island = (nodes, extra = {}) => ({
    id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
    definerId: '', nodes, ...extra,
});
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

/** A take whose peak i is its own position: the value a column paints
 * says which part of the take it shows. */
const RAMP_PEAKS = 4096;
const ramp = Float32Array.from({ length: RAMP_PEAKS }, (_, i) => (i + 1) / RAMP_PEAKS);

/** The columns the lane paints for one committed tile (lane_body
 * drawRepCanvas): through the tile's mapping, or — a tile with none —
 * the whole take pooled to the tile's width. */
function paintedColumns(peaks, rep, lane, cssW) {
    const map = tileMap(rep, lane.periodQ || lane.intrinsicQ);
    return map ? mappedColumns(peaks, cssW, map) : poolColumns(peaks, cssW);
}

/** Every column of every tile paints the take position that sounds at
 * its place in the frame. `periodS`: the loop's period, samples. */
function assertPaintsWhatSounds(vm, lane, origin, periodS, name) {
    const BODY_W = 1024;
    const whole = singleSegment(0, periodS);
    assert.ok(lane.reps.length > 0, `${name}: has tiles`);
    for (const rep of lane.reps) {
        const cssW = Math.round(tileCssWidth(BODY_W, rep, vm.cycleQ));
        const cols = paintedColumns(ramp, rep, lane, cssW);
        const span = (rep.endQ - rep.startQ) / cssW;  // Q per column
        for (let x = 0; x < cssW; x++) {
            // The column's right edge: a column max-pools its span of the
            // ramp, so it paints the position at that edge.
            const t = vm.frameZero + (rep.startQ + (x + 1) * span) * Q - 1e-6;
            const want = (innerAt(t, origin, whole, periodS).inner + 1e-6) / periodS;
            assert.ok(Math.abs(cols[x] - want) < 2 / cssW + 2 / RAMP_PEAKS,
                `${name}: tile [${rep.startQ}, ${rep.endQ}) column ${x} of ${cssW} ` +
                `paints ${cols[x].toFixed(4)} of the take; ${want.toFixed(4)} sounds there`);
        }
    }
}

test('a plain loop whose tile the frame cuts: each piece shows its share of the take', () => {
    // A 1Q loop, a 4Q loop from 0 (it places the frame) and a 4Q loop
    // performed 2Q in: its tile straddles the frame's end.
    const vm = deriveViewModel(island([clip('a', 0, 1), clip('b', 0, 4), clip('c', 2, 4)]));
    assert.equal(vm.cycleQ, 4);
    const c = laneOf(vm, 'c');
    assert.deepEqual(c.reps.map(r => [r.startQ, r.endQ, r.wrapped]),
        [[0, 2, true], [2, 4, true]], 'premise: two pieces of one tile');
    assertPaintsWhatSounds(vm, c, 2 * Q, 4 * Q, 'the straddling loop');
    // The loop the frame does not cut is the same picture as ever.
    assertPaintsWhatSounds(vm, laneOf(vm, 'b'), 0, 4 * Q, 'the placer');
});

test('pieces of any size, and a short loop\'s repeats', () => {
    // A 3Q loop performed 7Q in, in a 12Q frame (beside a 4Q placer): a
    // 1Q tail, three whole tiles, a 2Q head.
    const vm = deriveViewModel(island([clip('a', 0, 1), clip('b', 0, 4), clip('c', 7, 3)]));
    assert.equal(vm.cycleQ, 12);
    const c = laneOf(vm, 'c');
    assert.deepEqual(c.reps.map(r => [r.startQ, r.endQ]),
        [[0, 1], [1, 4], [4, 7], [7, 10], [10, 12]], 'premise');
    assertPaintsWhatSounds(vm, c, 7 * Q, 3 * Q, 'the 3Q loop');
});

test('a group\'s raw tile the frame cuts shows its share of the composite', () => {
    // A 4Q group anchored 1Q in beside a 4Q placer: [0, 1) is the tail of
    // its cycle, [1, 4) the head.
    const g = stack('g', 1, [clip('k', 1, 4)]);
    const vm = deriveViewModel(island([clip('a', 0, 1), clip('b', 0, 4), g]));
    const lane = laneOf(vm, 'g');
    assert.deepEqual(lane.reps.map(r => [r.startQ, r.endQ]), [[0, 1], [1, 4]], 'premise');
    assertPaintsWhatSounds(vm, lane, 1 * Q, 4 * Q, 'the group');
});

test('a slot being re-taken: its silent tiles, cut by the frame, keep their share', () => {
    const slot = clip('c', 2, 0, { isRecording: true, duration: 500,
                                   periodQ: { num: 4, den: 1 }, takes: 1 });
    const vm = deriveViewModel(island([clip('a', 0, 1), clip('b', 0, 4), slot],
        { islandPos: 6500, masterPos: 2500 }));
    const lane = laneOf(vm, 'c');
    assert.deepEqual(lane.reps.map(r => [r.startQ, r.endQ, !!r.silent]),
        [[0, 2, true], [2, 4, true]], 'premise');
    assertPaintsWhatSounds(vm, lane, 2 * Q, 4 * Q, 'the slot');
});

test('an uncut raw tile paints what the whole take pooled to its width does', () => {
    // The mapping changes nothing where the frame cuts nothing: over a
    // sweep of periods, phases and widths the two samplers agree, column
    // for column, to the last bit or two of a float32 (a column wider
    // than a peak is interpolated, at a position computed two ways).
    const SAME = 1e-6;
    let seed = 12345;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const noise = Float32Array.from({ length: 1500 }, () => rand());
    let tiles = 0;
    for (const periodQ of [1, 2, 3, 0.5, 1.5, 3.7, 4.25, 7, 1 / 3, 2.2]) {
        for (const offsetQ of [0, 1, 2.5, 1.3, 0.37, 5.9, 13.1, -3.3, 1e-7, 100 / 3]) {
            const cycleQ = 24 * periodQ;
            for (const rep of unrollReps({ periodQ, offsetQ, cycleQ })) {
                if (rep.wrapped) continue;
                for (const cssW of [7, 64, 333, 1500, 2048]) {
                    const map = tileMap(rep, periodQ);
                    assert.ok(map, 'a raw tile carries its mapping');
                    const mapped = mappedColumns(noise, cssW, map);
                    const pooled = poolColumns(noise, cssW);
                    let apart = 0;
                    for (let x = 0; x < cssW; x++) {
                        apart = Math.max(apart, Math.abs(mapped[x] - pooled[x]));
                    }
                    assert.ok(apart < SAME, `period ${periodQ}Q at ${offsetQ}Q, tile ` +
                        `from ${rep.startQ}Q, ${cssW} px: ${apart} apart`);
                    tiles++;
                }
            }
        }
    }
    assert.ok(tiles > 5000, `the sweep ran (${tiles})`);
});
