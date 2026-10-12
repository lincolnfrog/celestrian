/**
 * A ONE-SHOT IS DRAWN WHERE IT SOUNDS (Q5; composition.md §9).
 *
 * The engine's law (src/clip_node.cc render, src/stack_node.cc
 * scopeFacts): a one-shot folds on its SCOPE'S CYCLE from origin + a0 —
 * its shot (its active map, else its own period) sounds once per cycle
 * and the remainder rests; a one-shot GROUP folds its children's clock
 * the same way, so they restart with every firing and are silent in its
 * rest, at any depth.
 *
 * Each case states the tiles by hand, then sweeps the frame comparing
 * what the lane DRAWS at x (the view's sampler law: lane_body tileSpan +
 * canvas_renderer mappedColumns) with what SOUNDS at x (time_map.innerAt
 * / stackFold, the engine's golden-pinned twins).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { posMod } from '../math_utils.js';
import { innerAt, stackFold, singleSegment, mapPeriod, mapOffset,
         publishedMap, nodeWindowActive } from '../time_map.js';
import { ownPeriod, scopeCycleOf } from '../period_law.js';
import { publishedLaw } from '../vm/published.js';
import { deriveViewModel } from '../view_model.js';

const Q = 1000;

const clip = (id, originQ, durQ, extra = {}) => ({
    id, type: 'clip', name: id, origin: Math.round(originQ * Q),
    duration: Math.round(durQ * Q), loopStart: 0, loopEnd: 0,
    windowActive: false, loopBypassed: false, isRecording: false,
    isPendingStart: false, periodSource: 'own', ...extra,
});
const windowed = (id, originQ, durQ, [a, b], extra = {}) =>
    clip(id, originQ, durQ, { loopStart: a * Q, loopEnd: b * Q,
                              windowActive: true, ...extra });
const cutMap = (id, originQ, durQ, segsQ, extra = {}) =>
    clip(id, originQ, durQ, { segments: segsQ.flat().map(q => q * Q),
                              windowActive: true, ...extra });
const stack = (id, originQ, nodes, extra = {}) => ({
    id, type: 'stack', name: id, nodes, origin: Math.round(originQ * Q),
    anchored: true, loopStart: 0, loopEnd: 0, windowActive: false,
    loopBypassed: false, isRecording: false, periodSource: 'own', ...extra,
});
const ONE_SHOT = { periodSource: 'context' };
const island = (nodes, extra = {}) => ({
    id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
    definerId: '', nodes, ...extra,
});
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);
const tiles = lane => lane.reps.map(r => [r.startQ, r.endQ]);

/* ---- what SOUNDS: the descent, as the engine walks it ---- */

/** A node's active map, in samples (empty = none). */
const activeMap = n => (nodeWindowActive(n) ? publishedMap(n) : { segs: [] });

/**
 * What node `id` plays at clock `t` (samples): the raw position of its
 * own material, or 'rest'. The walk from the root: each stack folds the
 * clock it receives (stackFold over its own period and the cycle it was
 * handed) and hands its children its scope cycle.
 */
function soundsAt(state, id, t) {
    const law = publishedLaw(state.quantum);
    const rootCycle = scopeCycleOf({ type: 'stack', nodes: state.nodes }, law,
                                   state.quantum);
    const walk = (nodes, clock, cycle) => {
        for (const n of nodes) {
            const oneShot = n.periodSource === 'context';
            const map = activeMap(n);
            if (n.type !== 'stack') {
                if (n.id !== id) continue;
                const eff = map.segs.length ? map : singleSegment(0, n.duration);
                const f = stackFold(map, oneShot, n.duration, cycle);
                const at = innerAt(clock, n.origin, eff,
                                   f.oneShot ? f.fold : mapPeriod(eff));
                return at.rest ? 'rest' : at.inner;
            }
            const f = stackFold(map, oneShot, ownPeriod(n, law), cycle);
            let inner = clock - n.origin, rest = false;
            if (f.folds) {
                const at = innerAt(clock, n.origin, f.eff, f.fold);
                inner = at.inner;
                rest = at.rest;
            }
            if (n.id === id) return rest ? 'rest' : inner;
            const below = rest ? null
                : walk(n.nodes, n.origin + inner, scopeCycleOf(n, law, cycle));
            if (below !== undefined && below !== null) return below;
            if (rest && contains(n, id)) return 'rest';
        }
        return undefined;
    };
    return walk(state.nodes, t, rootCycle);
}
const contains = (n, id) =>
    (n.nodes || []).some(c => c.id === id || contains(c, id));

/* ---- what the lane DRAWS ---- */

/** The raw position (Q) the lane draws at frame position `x`, or
 * 'rest': the tile under x, sampled as the view samples it. */
function drawnAt(lane, x) {
    const rep = lane.reps.find(r => x >= r.startQ && x < r.endQ);
    if (!rep) return 'rest';
    const extentQ = lane.contentQ || lane.bandTotalQ || lane.intrinsicQ;
    if (!rep.srcSegs) {
        return ((x - rep.startQ) / (rep.endQ - rep.startQ)) * extentQ;
    }
    const src = { segs: rep.srcSegs };
    const h = posMod(x / lane.periodQ - (rep.srcTopFrac || 0), 1) * mapPeriod(src);
    return mapOffset(src, h) * extentQ;
}

/** Sweep the frame: the lane draws what sounds, and rests where nothing
 * does. Probes sit off every tile edge. */
function assertDrawnAsHeard(state, vm, id, name) {
    const lane = laneOf(vm, id);
    for (let i = 0; i < vm.cycleQ * 16; i++) {
        const x = (i + 0.5) / 16;
        const want = soundsAt(state, id, vm.frameZero + x * Q);
        const got = drawnAt(lane, x);
        if (want === 'rest' || got === 'rest') {
            assert.equal(got, want, `${name}: ${id} at ${x}Q`);
        } else {
            assert.ok(Math.abs(got - want / Q) < 1e-6,
                `${name}: ${id} at ${x}Q draws ${got}Q, sounds ${want / Q}Q`);
        }
    }
}

/** Where a one-shot's edge grips sit (session_view/map_bands.js
 * appendTrimGrips reads exactly these two lane fields). */
function gripsOf(lane, cycleQ) {
    const start = lane.takeStartQ % cycleQ;
    const end = start + Math.min(lane.bandPeriodQ, cycleQ);
    return [start, end <= cycleQ + 1e-9 ? Math.min(end, cycleQ) : end % cycleQ];
}

/* ---- the clip ---- */

test('a windowed one-shot whose shot crosses the frame\'s end', () => {
    // A 12Q take looped to [2Q, 6Q), anchored at 4Q, in an 8Q frame:
    // its content starts sounding at origin + a0 = 6Q and runs 4Q.
    const state = island([clip('a', 0, 1), clip('c', 0, 8),
                          windowed('b', 4, 12, [2, 6], ONE_SHOT)]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 8);
    const b = laneOf(vm, 'b');
    assert.deepEqual(tiles(b), [[0, 2], [6, 8]]);
    assert.equal(b.takeStartQ, 6, 'the shot\'s top');
    assert.equal(b.shotEveryQ, 8, 'once per scope cycle');
    assert.deepEqual(gripsOf(b, vm.cycleQ), [6, 2], 'the grips hug the shot');
    assert.deepEqual([b.periodQ, b.windowChipQ, b.bandPeriodQ], [4, 4, 4]);
    assert.deepEqual(b.bandSegs, [[2, 6]]);
    assert.ok(b.reps.every(r => !r.ghost),
        'one firing: its tail at the frame\'s start is no repetition');
    assertDrawnAsHeard(state, vm, 'b', 'window');
    // The same take windowed to [4Q, 8Q) starts sounding at 8Q ≡ 0.
    const state2 = island([clip('a', 0, 1), clip('c', 0, 8),
                           windowed('b', 4, 12, [4, 8], ONE_SHOT)]);
    const vm2 = deriveViewModel(state2);
    assert.deepEqual(tiles(laneOf(vm2, 'b')), [[0, 4]]);
    assert.equal(laneOf(vm2, 'b').takeStartQ, 0);
    assertDrawnAsHeard(state2, vm2, 'b', 'window at the top');
});

test('a one-shot with a cut map: the seam rides the shot', () => {
    // [2Q, 3Q) + [5Q, 8Q) of a 12Q take — 4Q kept — anchored at 3Q: the
    // shot starts at 5Q, its cut 1Q later, and its last Q wraps.
    const state = island([clip('c', 0, 8),
                          cutMap('b', 3, 12, [[2, 3], [5, 8]], ONE_SHOT)]);
    const vm = deriveViewModel(state);
    const b = laneOf(vm, 'b');
    assert.deepEqual(tiles(b), [[0, 1], [5, 8]]);
    assert.equal(b.takeStartQ, 5);
    assert.equal(b.mapMulti, true);
    assert.deepEqual(b.bandSegs, [[2, 3], [5, 8]]);
    assert.deepEqual(gripsOf(b, vm.cycleQ), [5, 1]);
    // The seam sits the first run's length after the shot's top
    // (map_bands appendSeamHandles: anchor + heard offset, wrapped).
    assert.equal(posMod(b.takeStartQ + 1, vm.cycleQ), 6);
    assert.equal(soundsAt(state, 'b', vm.frameZero + 5.99 * Q), 2990);
    assert.equal(soundsAt(state, 'b', vm.frameZero + 6 * Q), 5000);
    assertDrawnAsHeard(state, vm, 'b', 'cut map');
});

test('a shot that does not divide the frame: its wrapped tail is the tail', () => {
    // A 3Q window from 6Q of an 8Q frame: [6, 8) plays its first 2Q and
    // [0, 1) its last — not its first again.
    const state = island([clip('c', 0, 8), windowed('b', 5, 6, [1, 4], ONE_SHOT)]);
    const vm = deriveViewModel(state);
    const b = laneOf(vm, 'b');
    assert.deepEqual(tiles(b), [[0, 1], [6, 8]]);
    assert.ok(Math.abs(drawnAt(b, 0.5) - 3.5) < 1e-9, 'the head draws raw 3.5Q');
    assert.ok(Math.abs(drawnAt(b, 6.5) - 1.5) < 1e-9, 'the shot\'s top draws raw 1.5Q');
    assertDrawnAsHeard(state, vm, 'b', '3Q in 8Q');
});

test('a one-shot with no window: its take from its origin, wrapped', () => {
    const state = island([clip('c', 0, 8), clip('b', 7, 3, ONE_SHOT)]);
    const vm = deriveViewModel(state);
    const b = laneOf(vm, 'b');
    assert.deepEqual(tiles(b), [[0, 2], [7, 8]]);
    assert.equal(b.takeStartQ, 7);
    assert.equal(b.periodQ, 3);
    assertDrawnAsHeard(state, vm, 'b', 'no window');
    // Whatever cycle it was performed against, it fires where its
    // origin falls in the cycle it hears NOW.
    const state2 = island([clip('c', 0, 4),
                           clip('b', 5, 1, { ...ONE_SHOT, contextCycle: 8 * Q })]);
    const vm2 = deriveViewModel(state2);
    assert.deepEqual(tiles(laneOf(vm2, 'b')), [[1, 2]]);
    assertDrawnAsHeard(state2, vm2, 'b', 'a cycle that changed');
});

test('a scope cycle shorter than the frame: every firing, and the rests between', () => {
    // A 2Q loop sets its group's cycle; the frame is 4Q. The hit's 1Q
    // window starts sounding at 1.5Q of every 2Q.
    const g = stack('g', 0, [clip('two', 0, 2),
                             windowed('hit', 0.5, 4, [1, 2], ONE_SHOT)]);
    const state = island([g, clip('bed', 0, 4)]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 4);
    const hit = laneOf(vm, 'hit');
    assert.deepEqual(tiles(hit), [[0, 0.5], [1.5, 2.5], [3.5, 4]]);
    assert.deepEqual(hit.reps.map(r => r.ghost), [true, false, true],
        'the first firing is the take; the others repeat it');
    assert.equal(hit.takeStartQ, 1.5);
    assert.equal(hit.shotEveryQ, 2);
    assertDrawnAsHeard(state, vm, 'hit', 'echoes');
});

test('a cycle no longer than the shot: the one-shot is the plain loop', () => {
    const state = island([clip('c', 0, 4), clip('b', 1, 4, ONE_SHOT)]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 4);
    assert.deepEqual(tiles(laneOf(vm, 'b')), [[0, 1], [1, 4]]);
    assertDrawnAsHeard(state, vm, 'b', 'plain loop');
});

/* ---- the group ---- */

test('a windowed one-shot group fires its window at origin + a0', () => {
    // A 5Q mic in a kit windowed to [1Q, 4Q), over a 4Q bass: the shot
    // is the 3Q window, sounding from 1Q to the frame's end.
    const kit = stack('kit', 0, [clip('mic', 0, 5)],
        { ...ONE_SHOT, loopStart: Q, loopEnd: 4 * Q, windowActive: true });
    const state = island([clip('bass', 0, 4), kit]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 4);
    const k = laneOf(vm, 'kit');
    assert.deepEqual(tiles(k), [[1, 4]]);
    assert.equal(k.takeStartQ, 1);
    assert.equal(k.shotEveryQ, 4);
    assert.deepEqual([k.periodQ, k.windowChipQ], [3, 3]);
    assertDrawnAsHeard(state, vm, 'kit', 'windowed kit');
    assert.deepEqual(tiles(laneOf(vm, 'mic')), [[1, 4]]);
    assertDrawnAsHeard(state, vm, 'mic', 'windowed kit');
});

test('a one-shot group with a cut map: the cut closes up inside the shot', () => {
    // [0, 1Q) + [2Q, 4Q) of a 5Q mic, anchored 2Q into a 4Q cycle: the
    // 3Q shot runs [2, 4) and [0, 1), its seam at 3Q.
    const kit = stack('kit', 2, [clip('mic', 2, 5)],
        { ...ONE_SHOT, segments: [0, Q, 2 * Q, 4 * Q], windowActive: true });
    const state = island([clip('bass', 0, 4), kit]);
    const vm = deriveViewModel(state);
    const k = laneOf(vm, 'kit');
    assert.deepEqual(tiles(k), [[0, 1], [2, 4]]);
    assert.equal(k.takeStartQ, 2);
    assert.equal(k.mapMulti, true);
    assert.equal(soundsAt(state, 'mic', 2.5 * Q), 500);
    assert.equal(soundsAt(state, 'mic', 3.5 * Q), 2500, 'past the cut');
    assert.equal(soundsAt(state, 'mic', 0.5 * Q), 3500, 'the shot\'s tail');
    assert.equal(soundsAt(state, 'mic', 1.5 * Q), 'rest');
    assertDrawnAsHeard(state, vm, 'kit', 'cut kit');
    assert.deepEqual(tiles(laneOf(vm, 'mic')), [[0, 1], [2, 4]]);
    assertDrawnAsHeard(state, vm, 'mic', 'cut kit');
});

test('a one-shot group\'s members restart with every firing', () => {
    // A 3Q mic in a one-shot kit over a 4Q bass, the island's zero 16Q
    // after the kit's origin: the kit fires at the frame's top and the
    // mic plays from its own top — not from where 16Q of looping would
    // have left it.
    const kit = stack('kit', 0, [clip('mic', 0, 3)], ONE_SHOT);
    const state = island([clip('bass', 16, 4), kit], { islandZero: 16 * Q });
    const vm = deriveViewModel(state);
    assert.equal(vm.frameZero, 16 * Q);
    assert.deepEqual(tiles(laneOf(vm, 'kit')), [[0, 3]]);
    assert.deepEqual(tiles(laneOf(vm, 'mic')), [[0, 3]]);
    assert.equal(soundsAt(state, 'mic', 16 * Q), 0);
    assert.equal(soundsAt(state, 'mic', 19.5 * Q), 'rest');
    assertDrawnAsHeard(state, vm, 'mic', 'restart');
    assertDrawnAsHeard(state, vm, 'kit', 'restart');
});

test('everything beneath a one-shot group rests with it, at any depth', () => {
    // A 2Q shot (the pad) in a 4Q cycle: the nested group and the loop
    // inside it sound in the shot's 2Q and nowhere else.
    const kit = stack('kit', 0, [
        stack('sub', 0, [clip('tick', 0, 1)]),
        clip('pad', 0, 2),
    ], ONE_SHOT);
    const state = island([clip('bass', 0, 4), kit]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 4);
    assert.deepEqual(tiles(laneOf(vm, 'kit')), [[0, 2]]);
    assert.deepEqual(tiles(laneOf(vm, 'pad')), [[0, 2]]);
    assert.deepEqual(tiles(laneOf(vm, 'sub')), [[0, 1], [1, 2]]);
    assert.deepEqual(tiles(laneOf(vm, 'tick')), [[0, 1], [1, 2]]);
    for (const id of ['kit', 'pad', 'tick']) {
        assertDrawnAsHeard(state, vm, id, 'nested');
    }
});

test('a one-shot group whose shot crosses the frame\'s end: its members wrap with it', () => {
    // A 3Q kit anchored at 2Q of a 4Q cycle: [2, 4) and [0, 1).
    const kit = stack('kit', 2, [clip('mic', 2, 3), clip('tick', 2, 1)], ONE_SHOT);
    const state = island([clip('bass', 0, 4), kit]);
    const vm = deriveViewModel(state);
    assert.deepEqual(tiles(laneOf(vm, 'kit')), [[0, 1], [2, 4]]);
    assert.deepEqual(tiles(laneOf(vm, 'mic')), [[0, 1], [2, 4]]);
    assert.deepEqual(tiles(laneOf(vm, 'tick')), [[0, 1], [2, 3], [3, 4]]);
    assert.equal(laneOf(vm, 'mic').takeStartQ, 2);
    for (const id of ['kit', 'mic', 'tick']) {
        assertDrawnAsHeard(state, vm, id, 'wrapping kit');
    }
});

test('a one-shot group in a cycle shorter than the frame echoes whole', () => {
    // A 1Q kit in a group whose 2Q loop sets the cycle; the frame is 4Q.
    const kit = stack('kit', 0, [clip('mic', 0, 1)], ONE_SHOT);
    const state = island([stack('g', 0, [clip('two', 0, 2), kit]),
                          clip('bed', 0, 4)]);
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 4);
    assert.deepEqual(tiles(laneOf(vm, 'kit')), [[0, 1], [2, 3]]);
    assert.deepEqual(tiles(laneOf(vm, 'mic')), [[0, 1], [2, 3]]);
    assert.deepEqual(laneOf(vm, 'mic').reps.map(r => r.ghost), [false, true]);
    assertDrawnAsHeard(state, vm, 'mic', 'kit echoes');
});

test('a one-shot group with nothing looping in it fires nothing: its one-shots keep their own', () => {
    // The kit's own period is 0, so it folds nothing: each hit fires
    // once per the 4Q cycle the kit was handed, wherever its origin is.
    const kit = stack('kit', 0, [clip('kick', 0, 1, ONE_SHOT),
                                 clip('snare', 2, 1, ONE_SHOT)], ONE_SHOT);
    const state = island([clip('bass', 0, 4), kit]);
    const vm = deriveViewModel(state);
    assert.deepEqual(tiles(laneOf(vm, 'kick')), [[0, 1]]);
    assert.deepEqual(tiles(laneOf(vm, 'snare')), [[2, 3]]);
    assertDrawnAsHeard(state, vm, 'snare', 'empty kit');
});
