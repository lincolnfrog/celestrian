/**
 * Mock epoch re-base parity (mirrors AudioEngine — test_harness.md
 * gotcha 10). The engine re-bases the island epoch ONLY when the cycle
 * GREW (new_cycle > view_lcm_before_) as a simple extension. The mock
 * once compared against the QUANTUM instead, re-basing on every commit —
 * which rotated all lanes at each stop ("shifting left/right when you
 * finish recording" — field 2026-07-10).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    callNative, getState, loadScenario, setMasterPos,
} from '../mock_backend.js';

const Q = 44100;

async function recordTake(parentId, fromRaw, lengthSamples) {
    const id = await callNative('createNode', 'clip', parentId);
    setMasterPos(fromRaw);
    await callNative('startRecordingInNode', id);
    setMasterPos(fromRaw + lengthSamples);
    await callNative('stopRecordingInNode', id);
    return id;
}

test('epoch re-bases only when the cycle GROWS (engine parity)', async () => {
    loadScenario('empty');
    const stackId = await callNative('createNode', 'stack', '');

    // Take 1 establishes Q (1Q): no prior cycle → no re-base
    await recordTake(stackId, 0, Q);
    assert.equal(getState().islandEpoch, 0);

    // Take 2 grows the cycle 1Q → 4Q (simple extension): epoch re-bases
    // to the take's origin
    await recordTake(stackId, 5 * Q, 4 * Q);
    assert.equal(getState().islandEpoch, 5 * Q);

    // Take 3 fits inside the 4Q cycle (no growth): epoch MUST NOT move —
    // the buggy quantum-comparison re-based here and rotated every lane
    await recordTake(stackId, 13 * Q, Q);
    assert.equal(getState().islandEpoch, 5 * Q);
});
