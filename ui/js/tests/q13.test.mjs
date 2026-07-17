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
