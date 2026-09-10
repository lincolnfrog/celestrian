/**
 * MEMBERS UNDER A GROUP'S WINDOW draw the slice the map selects of
 * THEIR take, in the frame the group's tiles use.
 *
 * Three laws, all found by the engine e2e harness (2026-09-09, the
 * groups journeys — the mock never showed them because its fixtures
 * put every group's origin at the epoch):
 *  1. the slice is measured from the GROUP'S origin (Q18), not the
 *     epoch: a group anchored 1Q past the epoch with a [1Q, 3Q) window
 *     plays its member's content [1Q, 3Q) (engine: t' = O + inner,
 *     content = t' − origin) — the lane drew [2Q, 4Q);
 *  2. the members carry the GROUP'S ROTATION (srcTopFrac = the group's
 *     heard top over the map period), as the group lane does — a group
 *     whose heard top sits off the frame top drew every member a whole
 *     heard-top early;
 *  3. a member with a window of ITS OWN inside a windowed group shows
 *     the COMPOSED slice: the group's inner positions folded through
 *     the member's map (the lane used to ignore the group's map).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';

const Q = 1000;
const clip = (id, origin, duration, extra = {}) => ({
    id, name: id, type: 'clip', duration, origin, effectiveQuantum: Q,
    isRecording: false, isPlaying: true, isMuted: false, isSoloed: false,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    periodSource: 'own', contextCycle: 4 * Q, playhead: 0, ...extra,
});

function island(groupOrigin, { loop = [Q, 3 * Q], member = {} } = {}) {
    return {
        id: 'root', type: 'stack', quantum: Q, islandEpoch: 2 * Q,
        isPlaying: true, masterPos: 0, islandPos: 0,
        nodes: [
            clip('c1', 0, Q),
            {
                id: 'g', name: 'g', type: 'stack', anchored: true, origin: groupOrigin,
                windowActive: true, loopStart: loop[0], loopEnd: loop[1], loopBypassed: false,
                periodSource: 'own', effectiveQuantum: Q, duration: 0,
                nodes: [clip('m', groupOrigin, 4 * Q, member)],
            },
        ],
    };
}

const opts = { fxOpen: new Set(), windowEdit: new Set() };
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

test('1. the slice is measured from the GROUP origin', () => {
    // Group (and its sole member) anchored 1Q past the epoch: the map's
    // [1Q, 3Q) selects the member's OWN [1Q, 3Q) — origins coincide.
    const m = laneOf(deriveViewModel(island(3 * Q), opts), 'm');
    assert.equal(m.underMap, true);
    assert.deepEqual(m.reps[0].srcSegs, [[0.25, 0.75]],
        'the member shows content [1Q, 3Q) of its 4Q take');
    // At the epoch the answer is the same (the old code agreed only here).
    assert.deepEqual(laneOf(deriveViewModel(island(2 * Q), opts), 'm').reps[0].srcSegs,
        [[0.25, 0.75]]);
});

test('1b. a member whose origin trails the group by 1Q shows the slice shifted by 1Q', () => {
    const st = island(3 * Q);
    st.nodes[1].nodes[0].origin = 4 * Q;   // member recorded 1Q after the group's zero
    const m = laneOf(deriveViewModel(st, opts), 'm');
    // Map inner [1Q, 3Q) → member content [0, 2Q).
    assert.deepEqual(m.reps[0].srcSegs, [[0, 0.5]]);
});

test('2. members carry the group\'s rotation (its heard top over the map period)', () => {
    // Group at epoch − 8Q… here: origin 0 = epoch − 2Q, window [1Q, 3Q):
    // heard top = posMod(−2 + 1, 2) = 1Q → srcTopFrac 0.5 on the group
    // lane AND on its member.
    const vm = deriveViewModel(island(0), opts);
    const g = laneOf(vm, 'g'), m = laneOf(vm, 'm');
    assert.equal(g.reps[0].srcTopFrac, 0.5, 'the group lane rotates by its heard top');
    assert.equal(m.reps[0].srcTopFrac, 0.5, 'the member rotates with it');
    assert.equal(m.takeStartQ, 1, 'the member\'s heard top is the group\'s');
    // A group whose heard top IS the frame top: no rotation anywhere.
    const vm0 = deriveViewModel(island(3 * Q), opts);
    assert.equal(laneOf(vm0, 'g').reps[0].srcTopFrac, 0);
    assert.equal(laneOf(vm0, 'm').reps[0].srcTopFrac, 0);
});

test('3. nested maps: a member\'s own window inside a windowed group composes', () => {
    // Group window [0, 1Q) over a member windowed to [1Q, 3Q) (period
    // 2Q), member origin = group origin. THE ANCHORING LAW: the member's
    // map plays from origin + 1Q, so group-inner x ∈ [0, 1Q) is the
    // member's heard offset (x − 1Q) mod 2Q = x + 1Q → content 2Q + x:
    // the slice [2Q, 3Q) (engine: content 2.237Q at group-inner 0.237Q).
    const st = island(3 * Q, { loop: [0, Q],
                               member: { windowActive: true, loopStart: Q, loopEnd: 3 * Q } });
    const m = laneOf(deriveViewModel(st, opts), 'm');
    assert.equal(m.underMap, true);
    assert.deepEqual(m.reps[0].srcSegs, [[0.5, 0.75]],
        'group-inner [0, 1Q) through the member\'s [1Q, 3Q) window = content [2Q, 3Q)');
    assert.equal(m.windowChipQ, 2, 'the member keeps its own window chip');
    // Group window [0, 3Q) over the same member: [2Q, 3Q) first, then
    // the member's window from its top, [1Q, 3Q).
    const st2 = island(3 * Q, { loop: [0, 3 * Q],
                                member: { windowActive: true, loopStart: Q, loopEnd: 3 * Q } });
    const m2 = laneOf(deriveViewModel(st2, opts), 'm');
    assert.deepEqual(m2.reps[0].srcSegs, [[0.5, 0.75], [0.25, 0.75]]);
});
