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
    callNative, getState, loadScenario, advanceBy,
} from '../mock_backend.js';
// helpers.recordTake's defaults (stopEarly 100, settle 100) are exactly
// this file's old local builder: stop mid-Q, then reach the boundary so
// the commit lands at lengthSamples and raw sits on a boundary (Q11).
import { recordTake, Q44 as Q } from './helpers.mjs';

test('epoch re-bases only when the cycle GROWS (engine parity)', async () => {
    loadScenario('empty');
    const stackId = await callNative('createNode', 'stack', '');

    // Take 1 establishes Q (1Q): no prior Q → immediate commit at raw
    const a = await callNative('createNode', 'clip', stackId);
    await callNative('startRecordingInNode', a); // resets transport to 0
    advanceBy(Q);
    await callNative('stopRecordingInNode', a);
    assert.equal(getState().islandEpoch, 0);

    // Loop a while, then take 2 grows the cycle 1Q → 4Q (simple
    // extension): epoch re-bases to the take's origin (raw 5Q)
    advanceBy(4 * Q);
    await recordTake(stackId, 4 * Q);
    assert.equal(getState().islandEpoch, 5 * Q);

    // Take 3 fits inside the 4Q cycle (no growth): epoch MUST NOT move —
    // the buggy quantum-comparison re-based here and rotated every lane
    await recordTake(stackId, Q);
    assert.equal(getState().islandEpoch, 5 * Q);

    // The awaiting-stop path committed exact lengths
    const clips = getState().nodes[0].nodes;
    assert.deepEqual(clips.map(c => c.duration), [Q, 4 * Q, Q]);
});
