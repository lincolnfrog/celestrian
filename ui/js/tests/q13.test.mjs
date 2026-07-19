/**
 * Q13 provisional-Q mutability — UI-side parity (mock + view model).
 * The engine is pinned in tests/qtime_lock_tests.cc; this checks the
 * mock re-derives Q from the sole clip's window and the view model
 * surfaces the sole Q-definer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';

test('mock: sole committed clip window re-establishes Q', async () => {
    loadScenario('single-clip');            // one committed clip (clip-1)
    const before = getState().nodes[0].effectiveQuantum;
    assert.ok(before > 0, 'Q established by the sole clip');

    // Trim to half its length → Q := window length.
    await callNative('setLoopPoints', 'clip-1', 0, before / 2);
    assert.equal(getState().nodes[0].effectiveQuantum, before / 2,
        'Q re-established to the window length');
});

test('view model: exposes the sole Q-definer while provisional', () => {
    loadScenario('single-clip');
    const vm1 = deriveViewModel(getState());
    assert.equal(vm1.soleQDefinerId, 'clip-1', 'sole committed clip is the definer');
    const lane = vm1.lanes.find(l => l.id === 'clip-1');
    assert.equal(lane.isQDefiner, true, 'its lane is flagged');
});

test('mock: deleting the sole clip reverts Q (derived → fallback)', async () => {
    loadScenario('single-clip');
    await callNative('deleteNode', 'clip-1');
    const vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, null, 'no definer once empty');
    assert.equal(vm.qEstablished, false, 'Q reverts to unestablished');
});

// Provisional display: the definer frames its FULL buffer with the loop
// as a selection overlay — so trimming never hides the rest of the clip.
const perf = { sampleRate: 44100 };
const definerClip = () => ({
    id: 'c1', type: 'clip', name: 'A', duration: 200, effectiveQuantum: 100,
    loopStart: 20, loopEnd: 120, isRecording: false,
});

test('provisional definer frames the full buffer, loop as selection', () => {
    const vm = deriveViewModel({ nodes: [definerClip()], islandEpoch: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, true, 'provisional');
    // Frame = full buffer: cycleQ = duration/quantum = 200/100.
    assert.equal(vm.cycleQ, 2, 'frame spans the whole recorded buffer');
    const lane = vm.lanes.find(l => l.id === 'c1');
    assert.equal(lane.isQDefiner, true);
    assert.equal(lane.reps.length, 1, 'one full tile (no echoes)');
    assert.equal(lane.reps[0].startQ, 0);
    assert.equal(lane.reps[0].endQ, 2, 'tile spans the full buffer');
    assert.equal(lane.window.startQ, 0.2, 'selection start (loopStart/quantum)');
    assert.equal(lane.window.endQ, 1.2, 'selection end (loopEnd/quantum)');
});

test('a 2nd committed clip LOCKS: definer collapses to normal rendering', () => {
    const c2 = { id: 'c2', type: 'clip', name: 'B', duration: 100,
                 effectiveQuantum: 100, loopStart: 0, loopEnd: 0, isRecording: false };
    const vm = deriveViewModel({ nodes: [definerClip(), c2], islandEpoch: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, false, 'locked with 2 committed clips');
    assert.equal(vm.soleQDefinerId, null, 'no sole definer');
});

test('a clip RECORDING (armed 2nd take) suspends the provisional view', () => {
    const rec = { id: 'c2', type: 'clip', name: 'B', duration: 0,
                  effectiveQuantum: 0, isRecording: true };
    const vm = deriveViewModel({ nodes: [definerClip(), rec], islandEpoch: 0, masterPos: 0, perf });
    // c1 is still the sole COMMITTED clip, but recording suspends the
    // full-buffer view (we're transitioning to locked).
    assert.equal(vm.soleQDefinerId, 'c1', 'c1 still the sole committed clip');
    assert.equal(vm.provisionalDefiner, false, 'suspended while recording');
});
