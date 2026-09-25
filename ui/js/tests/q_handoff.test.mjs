/**
 * HANDING Q TO A TRACK (Q22) — the mock verb and the view model. The
 * owner's story: an arhythmic keyboard loop set Q; a long drum take was
 * recorded over it; Q is handed to the drums, their loop is trimmed to
 * the drummer's bars, and the keyboard keeps playing exactly as
 * recorded — drifting (↯) against the new grid. The engine twin is
 * tests/definer_handoff_tests.cc.
 *
 * Scenario 'keys-then-drums' (Q = MOCK_Q): keys [origin 0, 1Q], drums
 * [origin 2Q, 5Q].
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, setIsPlaying, setMasterPos }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import {
    periodDrifts, publishedNodeDrifts, driftsByRoundingOnly, subdivisionSamples,
} from '../timeline_model.js';
import { findNode } from '../mock/state.js';
import { MOCK_Q as Q, PERF as perf, nodeById, recordTake } from './helpers.mjs';

const at = x => Math.round(x * Q);
const node = id => nodeById(id, getState().nodes);

test('periodDrifts: whole multiples and exact divisors cohere; the rest drift', () => {
    assert.equal(periodDrifts(2000, 1000), false, 'a multiple');
    assert.equal(periodDrifts(250, 1000), false, 'a divisor');
    assert.equal(periodDrifts(1300, 1000), true, 'neither');
    assert.equal(periodDrifts(1300, 0), false, 'no Q, no drift');
    assert.equal(publishedNodeDrifts({ type: 'clip', duration: 1300 }, 1000), true);
    assert.equal(publishedNodeDrifts({ type: 'clip', duration: 1300,
        periodSource: 'context' }, 1000), false, 'a one-shot never drifts');
    assert.equal(publishedNodeDrifts({ type: 'clip', duration: 4000,
        loopStart: 0, loopEnd: 1000, windowActive: true }, 1000), false,
        'a clip drifts by what it plays (its window), not its take');
});

test('a short take at a subdivision that Q does not divide drifts by rounding only — no badge', () => {
    const q = 44100;  // odd multiple of 4: Q/8 rounds to 5513
    const stab = { id: 's', type: 'clip', duration: subdivisionSamples(q, 8) };
    assert.equal(publishedNodeDrifts(stab, q), true,
        'it does drift (4 samples a Q), so it folds into nothing');
    assert.equal(driftsByRoundingOnly(stab, q), true, 'but only by rounding');
    const keys = { id: 'k', type: 'clip', duration: Math.round(0.4 * q) };
    assert.equal(driftsByRoundingOnly(keys, q), false, 'a real mismatch is badged');
    const vm = deriveViewModel({ quantum: q, islandZero: 0, masterPos: 0, perf,
        nodes: [{ id: 'a', type: 'clip', duration: q, origin: 0 }, stab, keys] });
    const lane = id => vm.lanes.find(l => l.id === id);
    assert.equal(lane('s').drifting, true);
    assert.equal(lane('s').driftShown, false);
    assert.equal(lane('k').driftShown, true);
});

test('setDefiner: Q becomes the drums loop, the zero its top — nothing moves', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    const s = getState();
    assert.equal(s.quantum, at(5), 'Q := the drums loop (the whole 5Q take)');
    assert.equal(s.islandZero, at(2), 'zero := the drums loop top');
    assert.equal(s.definerId, 'drums', 'the drums define Q (published)');
    assert.equal(node('drums').origin, at(2), 'no origin moved');
    assert.equal(node('keys').origin, 0);
    assert.equal(node('keys').duration, at(1), 'no content moved');
    // The keys still fit (Q/5): nothing drifts yet.
    const vm = deriveViewModel(getState());
    assert.equal(vm.lanes.find(l => l.id === 'keys').drifting, false);
});

test('setDefiner is ONE undo step; an identity records nothing', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setDefiner', 'drums');  // identity: refused silently
    await callNative('undo');
    const s = getState();
    assert.equal(s.quantum, at(1), 'Q back to the keys loop');
    assert.equal(s.islandZero, 0);
    assert.equal(s.definerId, '', 'two takes, no designation: Q is locked');
});

test('refusals record nothing', async () => {
    loadScenario('empty');
    const id = await callNative('createNode', 'clip', '');
    await callNative('setDefiner', id);
    assert.equal(getState().quantum, 0, 'no Q yet: nothing to hand over');

    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'nope');
    await callNative('setPeriodSource', 'keys', 'context');
    await callNative('setDefiner', 'keys');
    assert.equal(getState().definerId, '', 'a one-shot never takes Q');
    assert.equal(getState().quantum, at(1));
});

test("the handed-Q definer trims like a first take, keeping its timing beside the keys", async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    // Playing, mid-loop: a sole definer would re-anchor its origin; beside
    // other tracks the drums keep theirs (nothing re-times, P1).
    setIsPlaying(true);
    setMasterPos(at(4.25));
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    const s = getState();
    assert.equal(s.quantum, at(2.4), 'Q := the trimmed loop — free, sub-Q');
    assert.equal(s.islandZero, at(2) + at(0.7), 'zero := origin + region start');
    assert.equal(node('drums').origin, at(2), 'the drums keep their origin');
    assert.equal(node('drums').loopStart, at(0.7), 'not refused by coherence');
});

test('keys that no longer fit DRIFT: out of the frame and the seat, drawn per pass', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    // Lock the hand-off with a new take so the lanes rest in the heard view.
    await recordTake('', at(2.4), { stopEarly: 100, settle: at(2.4) });
    const s = getState();
    assert.equal(s.definerId, '', 'the next take locked the hand-off');
    const vm = deriveViewModel(s);
    assert.equal(vm.provisionalDefiner, false);
    const keys = vm.lanes.find(l => l.id === 'keys');
    assert.equal(keys.drifting, true, 'the keys are ↯');
    assert.ok(Number.isInteger(vm.lcmQ) && vm.lcmQ >= 1 && vm.lcmQ <= 2,
        'the frame is the drum grid, never lcm(1Q, 2.4Q) = 12 keys-Q: ' + vm.lcmQ);
    // The keys' tiles are drawn from the pass the cursor is in: advance a
    // whole frame and the keys land differently (2.4Q mod 1Q ≠ 0).
    const offsetOf = st => {
        const v = deriveViewModel(st);
        const k = v.lanes.find(l => l.id === 'keys');
        const first = k.reps.find(r => !r.wrapped) || k.reps[0];
        return { firstQ: first.startQ, periodQ: k.periodQ, frame: v.cycleQ * v.quantum };
    };
    const a = offsetOf(getState());
    setMasterPos(getState().islandPos + (getState().islandZero || 0) + a.frame);
    const b = offsetOf(getState());
    assert.ok(Math.abs(a.firstQ - b.firstQ) > 1e-6,
        'a drifting lane re-lines-up every pass (' + a.firstQ + ' vs ' + b.firstQ + ')');
});

test('the lock at the next take clears the designation; undo brings it back', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    const bass = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', bass);
    // The drums lock-collapsed to their loop (the take IS the window).
    assert.equal(node('drums').duration, at(2.4));
    assert.equal(node('drums').origin, at(2.7), 'origin → the loop top');
    await callNative('stopRecordingInNode', bass);  // cancel the pending arm
    await callNative('undo');  // the designation clear
    assert.equal(getState().definerId, 'drums', 'the hand-off re-opens');
    await callNative('undo');  // the lock-collapse
    assert.equal(node('drums').duration, at(5), 'the whole take is back');
    assert.equal(node('drums').loopStart, at(0.7));
});

test('handing Q BACK to a lock-collapsed track uncollapses it', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    await recordTake('', at(2.4), { stopEarly: 100, settle: at(2.4) });
    assert.equal(node('drums').duration, at(2.4), 'collapsed at the lock');
    await callNative('setDefiner', 'drums');
    const d = node('drums');
    assert.equal(d.duration, at(5), 'the whole take is back');
    assert.equal(d.loopStart, at(0.7), 'with the old trim as its window');
    assert.equal(d.loopEnd, at(3.1));
    assert.equal(getState().quantum, at(2.4), 'Q unchanged — audio-neutral');
    assert.equal(getState().islandZero, at(2.7));
});

test('a region drawn since the lock survives a hand-off: no re-open over it', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    await recordTake('', at(2.4), { stopEarly: 100, settle: at(2.4) });
    const q = getState().quantum;               // the drums loop, locked
    await callNative('setLoopPoints', 'drums', 0, q / 2);  // a coherent half
    await callNative('setDefiner', 'drums');
    const d = node('drums');
    assert.equal(d.duration, q, 'still the collapsed take');
    assert.equal(d.loopEnd, q / 2, 'the half-loop region stands');
    assert.equal(getState().quantum, q / 2, 'Q := the region it plays');
});

test('a designation naming a deleted track is inert at the next arm', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('deleteNode', 'drums');
    const bass = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', bass);
    await callNative('stopRecordingInNode', bass);  // cancel the pending arm
    await callNative('undo');                        // the create
    await callNative('undo');                        // the delete
    assert.equal(getState().definerId, 'drums',
        'the delete undone, the hand-off stands — no clear was logged');
});

test('the warp guard: nothing under a one-shot group takes Q', async () => {
    loadScenario('keys-then-drums');
    const g = await callNative('createNode', 'stack', '');
    await callNative('reorderNode', 'keys', g, 0);
    const group = findNode(g);
    group.periodSource = 'context';  // the live mock node (a one-shot group)
    const vm = deriveViewModel(getState());
    assert.equal(vm.lanes.find(l => l.id === 'keys').canDefine, false, 'no offer');
    await callNative('setDefiner', 'keys');
    assert.equal(getState().definerId, '', 'the mock refuses it too');
});

test('view model: the Q lamp offers the hand-off on eligible lanes only', () => {
    loadScenario('keys-then-drums');
    const vm = deriveViewModel(getState());
    const lane = id => vm.lanes.find(l => l.id === id);
    assert.equal(lane('keys').canDefine, true);
    assert.equal(lane('drums').canDefine, true);
    // A windowed group remaps time: nothing beneath it can take Q.
    const s = getState();
    const g = { id: 'g', type: 'stack', anchored: true, origin: 0,
                loopStart: 0, loopEnd: Q, windowActive: true,
                nodes: [s.nodes[0]] };
    const vm2 = deriveViewModel({ ...s, nodes: [g, s.nodes[1]] });
    assert.equal(vm2.lanes.find(l => l.id === 'keys').canDefine, false,
        'the warp guard');
});

test('trim view WITH COMPANY: the cursor sweeps one drum loop; the others show this pass', async () => {
    loadScenario('keys-then-drums');
    await callNative('setDefiner', 'drums');
    await callNative('setLoopPoints', 'drums', at(0.7), at(3.1));
    setMasterPos(at(2.7) + at(2.4) + at(0.5));  // half a Q into the 2nd drum pass
    const vm = deriveViewModel(getState());
    assert.equal(vm.provisionalDefiner, true, 'the drums trim like a first take');
    assert.equal(vm.trimCompany, true);
    assert.ok(Math.abs(vm.loopCycleQ - 1) < 1e-9, 'the cursor folds on the drum loop');
    const selStartQ = at(0.7) / vm.quantum;
    assert.ok(Math.abs(vm.playheadQ - (selStartQ + at(0.5) / vm.quantum)) < 1e-6,
        'cursor = selection start + phase in the loop');
    const keys = vm.lanes.find(l => l.id === 'keys');
    assert.deepEqual(keys.trimSel, { startQ: vm.lanes.find(l => l.id === 'drums').window.startQ,
                                     endQ: vm.lanes.find(l => l.id === 'drums').window.endQ });
    // The keys lane under the cursor shows what sounds now: its tile
    // grid is anchored at the pass zero (island time at x = 0).
    const tileEdge = keys.reps.map(r => r.startQ).find(x => x > 0);
    const passZero = vm.passZero;
    const edgeTime = passZero + tileEdge * vm.quantum;
    assert.equal(((Math.round(edgeTime) % Q) + Q) % Q, 0,
        'a keys tile edge sits where a keys loop begins in island time');
});
