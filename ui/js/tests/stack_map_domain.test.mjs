/**
 * THE DOMAIN A GROUP'S MAP SELECTS OVER is the engine's raw inner cycle
 * (StackNode::getIntrinsicDuration: the LCM of its looping children's
 * raw extents, whatever they play) — setLoopPoints / setSegments refuse
 * only what lies past it. The cycle a group PLAYS can be shorter: a
 * child's own window shortens it. A group window between the two is an
 * active map the engine folds on, so its lane shows it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { rawInnerCycle, intrinsicPeriod } from '../vm/published.js';
import { deriveViewModel } from '../view_model.js';
import { SCENE_Q as Q, clipAt, groupAt, island } from './helpers.mjs';

const clip = (id, durQ, extra) => clipAt(id, 0, durQ, extra);
const stack = (id, nodes, extra) => groupAt(id, 0, nodes, extra);
const win = (a, b) => ({ loopStart: a * Q, loopEnd: b * Q, windowActive: true });
const laneOf = (state, id) => deriveViewModel(state).lanes.find(l => l.id === id);

test('the raw inner cycle: looping children\'s raw extents, whatever they play', () => {
    assert.equal(rawInnerCycle(stack('g', [clip('a', 2), clip('b', 3)])), 6 * Q);
    assert.equal(rawInnerCycle(stack('g', [clip('a', 8, win(0, 2)), clip('b', 2)])),
        8 * Q, 'a child\'s window does not shorten it');
    assert.equal(rawInnerCycle(stack('g', [clip('a', 2),
        clip('s', 3, { periodSource: 'context' })])), 2 * Q, 'a one-shot adds nothing');
    assert.equal(rawInnerCycle(stack('g', [clip('d', 1.3), clip('b', 2)])), 26 * Q,
        'nor does drift excuse a child');
    assert.equal(rawInnerCycle(stack('g', [stack('s', [clip('k', 1)],
        { sequence: { steps: [{ len: 8 * Q }] } })])), Q, 'a song is no raw extent');
    assert.equal(rawInnerCycle(stack('g', [])), 0);
    assert.equal(rawInnerCycle(stack('g', [clip('h', 0.5)])), Q / 2, 'unseeded by Q');
    // What the group PLAYS, as its lane tiles it, is the fold of what its
    // children play.
    assert.equal(intrinsicPeriod(
        stack('g', [clip('a', 8, win(0, 2)), clip('b', 2)]), Q), 2 * Q);
});

test('a group window past the cycle the group plays is still its map', () => {
    // An 8Q take windowed to 2Q beside a 2Q loop: the group plays a 2Q
    // cycle, and its own window [0, 4Q) is a map the engine folds on —
    // the island cycles on 4Q.
    const g = stack('g', [clip('a', 8, win(0, 2)), clip('b', 2)], win(0, 4));
    const vm = deriveViewModel(island([g]));
    assert.equal(vm.cycleQ, 4, 'the map sets the frame');
    const lane = vm.lanes.find(l => l.id === 'g');
    assert.equal(lane.windowChipQ, 4, 'the lane wears the map');
    assert.equal(lane.periodQ, 4);
    assert.deepEqual(lane.bandSegs, [[0, 4]]);
    assert.equal(lane.bandTotalQ, 8, 'over the extent the map selects from');
    assert.deepEqual(lane.reps.map(r => [r.startQ, r.endQ, r.srcSegs]),
        [[0, 4, [[0, 0.5]]]], 'one tile: the first half of that extent');
    // Its members are shown through it: two passes of the 2Q window.
    const a = vm.lanes.find(l => l.id === 'a');
    assert.equal(a.underMap, true);
    assert.deepEqual(a.reps[0].srcSegs, [[0, 0.25], [0, 0.25]]);
});

test('a group window that spans the whole domain is no map to show', () => {
    const g = stack('g', [clip('a', 8), clip('b', 2)], win(0, 8));
    const lane = laneOf(island([g]), 'g');
    assert.ok(!lane.windowChipQ, 'no chip');
    assert.equal(lane.window, null);
    assert.equal(lane.periodQ, 8);
});

test('with no map on it a group\'s lane keeps the cycle it plays', () => {
    const lane = laneOf(island([stack('g', [clip('a', 8, win(0, 2)), clip('b', 2)])]), 'g');
    assert.deepEqual([lane.periodQ, lane.intrinsicQ, lane.bandTotalQ], [2, 2, 2]);
    assert.deepEqual(lane.reps.map(r => [r.startQ, r.endQ]), [[0, 2]]);
});
