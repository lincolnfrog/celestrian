/**
 * A GROUP LANE'S COMPOSITE spans the lane's own raw extent
 * (session_view/lane_body.js compositeExtent): the tiles the view model
 * lays out, and the slices a heard tile draws (`srcSegs`, fractions of
 * that extent), index into it — so the two are one number, the lane's.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = globalThis.document || { createElement: () => ({}) };

const { compositeExtent } = await import('../session_view/lane_body.js');
const { deriveViewModel } = await import('../view_model.js');

const Q = 1000;
const clip = (id, lenQ, extra = {}) => ({
    id, type: 'clip', name: id, duration: lenQ * Q, origin: 0,
    effectiveQuantum: Q, loopStart: 0, loopEnd: 0, isRecording: false,
    isPendingStart: false, periodSource: 'own', ...extra });
const group = (nodes, extra = {}) => ({
    id: 'g', type: 'stack', name: 'G', nodes, origin: 0, effectiveQuantum: Q,
    loopStart: 0, loopEnd: 0, periodSource: 'own', ...extra });
const island = (nodes, extra = {}) => ({
    id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
    nodes, perf: { sampleRate: 48000 }, ...extra });

function laneAndExtent(state, opts) {
    const vm = deriveViewModel(state, opts);
    const lane = vm.lanes.find(l => l.id === 'g');
    return { lane, extent: compositeExtent(lane, state.nodes[0], vm.quantum) };
}

test('a plain group: the composite spans its inner cycle', () => {
    const { lane, extent } = laneAndExtent(
        island([group([clip('a', 2), clip('b', 3), clip('c', 1)])]));
    assert.equal(lane.intrinsicQ, 6);
    assert.equal(extent, 6 * Q);
});

test('a windowed group: the heard tiles\' slices index the same span', () => {
    const { lane, extent } = laneAndExtent(island([group(
        [clip('a', 2), clip('b', 3), clip('c', 1)],
        { loopStart: 2 * Q, loopEnd: 5 * Q, windowActive: true })]));
    assert.equal(lane.windowChipQ, 3, 'the heard view');
    assert.equal(extent, 6 * Q, 'the raw inner cycle, not the window');
    assert.deepEqual(lane.reps[0].srcSegs, [[2 / 6, 5 / 6]]);
});

test('a definer stack: the composite is the one take', () => {
    const { lane, extent } = laneAndExtent(island(
        [group([clip('m1', 2.5), clip('m2', 2.5)])],
        { quantum: 2.5 * Q, definerId: 'g' }));
    assert.equal(lane.isQDefiner, true);
    assert.equal(extent, 2.5 * Q);
});

test('a member re-taking: the composite keeps the span the lane still tiles', () => {
    // A 1Q loop and a 4Q loop; the 4Q one is taking a new take, 1.3Q in.
    const retaking = clip('long', 1.3, {
        isRecording: true, periodQ: { num: 4, den: 1 } });
    const { lane, extent } = laneAndExtent(
        island([group([clip('short', 1), retaking])]),
        { retakes: new Set(['long']) });
    assert.equal(lane.reps[0].endQ - lane.reps[0].startQ, 4,
        'the group still tiles at the loop it will be again');
    assert.equal(extent, 4 * Q, 'and the composite spans that tile');
});
