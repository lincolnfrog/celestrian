/**
 * THE TOP AND THE TIMING ON A LANE (view_model topFields / retimeable;
 * loop_selection.md §9, the Phase 2 VM contract).
 *
 * Every clip and group lane carries:
 *   topQ       the effective top, raw Q of the take;
 *   topHeardQ  the ↺'s first heard position from the frame zero, in
 *              [0, S) — S the loop period;
 *   retimeQ    `retime` ÷ Q, 0 when absent (as played, or an engine
 *              that publishes none);
 *   canRetime  a committed looping clip, not the Q-definer (nor a mic
 *              of the definer stack), not a one-shot, not recording or
 *              armed, Q established, not shown through an enclosing
 *              map, not in comp mode, not under the recording gate;
 *   retimeLocked  all of that but for the recording gate: its ↺ draws
 *              inert (a plain 1Q loop's too — the map chrome's bandLocked
 *              needs a ≥ 2Q take).
 * The splice / ↺ handles (workstream C) read nothing else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { SCENE_Q as Q, PERF } from './helpers.mjs';

const clip = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: Math.round(originQ * Q),
    duration: Math.round(durationQ * Q), effectiveQuantum: Q,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false,
    periodSource: 'own', ...extra,
});
const windowed = (id, originQ, durationQ, [aQ, bQ], extra = {}) =>
    clip(id, originQ, durationQ, {
        loopStart: Math.round(aQ * Q), loopEnd: Math.round(bQ * Q),
        windowActive: true, ...extra,
    });
const island = (nodes, extra = {}) => ({
    id: 'root', type: 'stack', quantum: Q, islandZero: 0, definerId: '',
    isPlaying: true, masterPos: 0, islandPos: Math.round(4.3 * Q),
    perf: PERF, nodes, ...extra,
});
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id && l.kind !== 'fx');

test('a committed looping clip can be re-timed; its fields read the node', () => {
    const vm = deriveViewModel(island([clip('A', 0, 4),
        windowed('B', 2.5, 12, [6, 10], { loopTop: 7 * Q, retime: Q / 2 })]));
    const b = laneOf(vm, 'B');
    assert.equal(b.canRetime, true);
    assert.equal(b.topQ, 7);
    assert.equal(b.retimeQ, 0.5);
    // The ↺ sounds at 2.5 + 6 + 1 = 9.5Q: 1.5Q into the 4Q frame at 8Q
    // (the zero seats on A's bar line at or before B's top).
    assert.equal(vm.frameZero, 8 * Q);
    assert.ok(Math.abs(b.topHeardQ - 1.5) < 1e-9, `topHeardQ ${b.topHeardQ}`);
    assert.ok(b.topHeardQ >= 0 && b.topHeardQ < b.periodQ, 'within one period');
    const a = laneOf(vm, 'A');
    assert.equal(a.retimeQ, 0, 'no retime published: as played');
    assert.equal(a.topQ, 0, 'an unmapped take\'s top: raw 0');
});

test('the Q-definer and the definer stack\'s mics are never re-timed', () => {
    // The sole committed clip IS the definer (provisional trim view).
    const sole = deriveViewModel(island([clip('D', 0, 3, { loopTop: Q })],
                                        { definerId: 'D' }));
    const d = laneOf(sole, 'D');
    assert.equal(d.isQDefiner, true);
    assert.equal(d.canRetime, false);
    assert.equal(d.topQ, 1);
    assert.equal(d.topHeardQ, 1, 'the trim view draws the buffer from 0');
    // Its window bypassed, the definer draws as an ordinary lane — and
    // is still the definer.
    const bypassed = deriveViewModel(island([windowed('D', 0, 3, [0, 2],
        { loopBypassed: true, windowActive: false })], { definerId: 'D' }));
    assert.equal(laneOf(bypassed, 'D').isQDefiner, undefined);
    assert.equal(laneOf(bypassed, 'D').canRetime, false);
    // A group-recorded kit (one take, two mics) defines Q as a stack.
    const kit = (extra = {}) => island([{
        id: 'K', name: 'K', type: 'stack', anchored: true, origin: 0,
        effectiveQuantum: Q, nodes: [clip('m1', 0, 4), clip('m2', 0, 4)], ...extra,
    }], { definerId: 'K' });
    const trim = deriveViewModel(kit());
    assert.equal(laneOf(trim, 'm1').definerMember, true);
    assert.equal(laneOf(trim, 'm1').canRetime, false);
    assert.equal(laneOf(trim, 'K').canRetime, false);
    const kitBypassed = deriveViewModel(kit({ loopStart: 0, loopEnd: 2 * Q,
        loopBypassed: true, windowActive: false }));
    assert.equal(laneOf(kitBypassed, 'm1').definerMember, undefined,
        'drawn as an ordinary member');
    assert.equal(laneOf(kitBypassed, 'm1').canRetime, false, '…still a definer mic');
});

test('one-shots, live and armed takes, and the recording gate: no re-time', () => {
    const shot = deriveViewModel(island([clip('A', 0, 4),
        clip('S', 1, 1, { periodSource: 'context' })]));
    assert.equal(laneOf(shot, 'S').canRetime, false, 'a one-shot\'s offset IS its placement');
    assert.equal(laneOf(shot, 'A').canRetime, true);
    const armed = deriveViewModel(island([clip('A', 0, 4), clip('B', 2, 4),
        clip('R', 0, 0, { isPendingStart: true })]));
    assert.equal(armed.mapEditsLocked, true);
    assert.equal(laneOf(armed, 'B').canRetime, false, 'the recording gate');
    const live = deriveViewModel(island([clip('A', 0, 4), clip('B', 2, 4),
        clip('R', 4, 0.5, { isRecording: true })]));
    assert.equal(laneOf(live, 'B').canRetime, false);
    assert.equal(laneOf(live, 'R').canRetime, false, 'the take itself');
    assert.equal(laneOf(live, 'R').retimeQ, 0);
});

test('the recording gate alone: retimeLocked — the ↺ draws inert until the take finishes', () => {
    const vm = deriveViewModel(island([clip('A', 0, 1), clip('B', 2, 4),
        clip('S', 1, 1, { periodSource: 'context' }),
        clip('C', 0, 4, { isPendingStart: true }),   // a slot armed for a new take
        clip('R', 4, 0.5, { isRecording: true })]));
    assert.equal(vm.mapEditsLocked, true);
    for (const id of ['A', 'B', 'C']) {
        assert.equal(laneOf(vm, id).canRetime, false, id);
        assert.equal(laneOf(vm, id).retimeLocked, true, id + ': the gate alone holds it');
    }
    assert.equal(laneOf(vm, 'A').bandLocked, false,
        'a 1Q take has no map chrome for the gate to hold — its ↺ it still has');
    assert.equal(laneOf(vm, 'S').retimeLocked, false, 'a one-shot: never');
    assert.equal(laneOf(vm, 'R').retimeLocked, false, 'the take itself: never');
    // No gate: live, not locked.
    const free = deriveViewModel(island([clip('A', 0, 1), clip('B', 2, 4)]));
    assert.equal(laneOf(free, 'B').canRetime, true);
    assert.equal(laneOf(free, 'B').retimeLocked, false);
});

test('before Q exists nothing is re-timed', () => {
    const vm = deriveViewModel(island([clip('A', 0, 4)], { quantum: 0 }));
    assert.equal(vm.qEstablished, true, '(a fixture Q falls back to the min over nodes)');
    const pre = deriveViewModel(island([{ ...clip('A', 0, 4), effectiveQuantum: 1,
                                          duration: 0 }], { quantum: 0 }));
    assert.equal(pre.qEstablished, false);
    assert.equal(laneOf(pre, 'A').canRetime, false);
});

test('through an enclosing map and in comp mode: the parent / the comp own the lane', () => {
    const member = clip('m', 0, 8);
    const s = island([clip('A', 0, 4), {
        id: 'G', name: 'G', type: 'stack', anchored: true, origin: 0,
        effectiveQuantum: Q, nodes: [member, clip('n', 0, 4)],
        loopStart: 2 * Q, loopEnd: 6 * Q, windowActive: true, loopBypassed: false,
    }]);
    const vm = deriveViewModel(s);
    const m = laneOf(vm, 'm');
    assert.equal(m.underMap, true);
    assert.equal(m.canRetime, false, 'no ↺ on a lane the parent map owns');
    const g = laneOf(vm, 'G');
    assert.equal(g.canRetime, false, 'groups are never re-timed');
    assert.equal(g.topQ, 2, 'the group\'s top: its region start');
    assert.equal(g.retimeQ, 0);
    const comp = deriveViewModel(island([clip('A', 0, 4),
        windowed('B', 2, 12, [6, 10])]), { compMode: new Set(['B']) });
    assert.equal(laneOf(comp, 'B').windowEditing, true);
    assert.equal(laneOf(comp, 'B').canRetime, false, 'comp mode edits takes, not time');
    // A PLAIN clip keeps its lane in comp mode (the cells sit over its
    // take tile) — and still no re-time: the cells own the tile.
    const plain = deriveViewModel(island([clip('A', 0, 4), clip('P', 2, 4)]),
        { compMode: new Set(['P']) });
    assert.equal(laneOf(plain, 'P').compMode, true);
    assert.equal(laneOf(plain, 'P').windowEditing, undefined);
    assert.equal(laneOf(plain, 'P').canRetime, false);
    assert.equal(laneOf(plain, 'P').retimeLocked, false);
});
