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

const Q = 44100;

/**
 * Record a take of exactly `lengthSamples`: drive most of it, request
 * the stop mid-Q, then run to the boundary — mirroring the engine's
 * AWAITING-STOP (stops always pad forward, owner ruling 2026-07-10).
 */
async function recordTake(parentId, lengthSamples) {
    const id = await callNative('createNode', 'clip', parentId);
    await callNative('startRecordingInNode', id); // raw on a boundary → immediate
    advanceBy(lengthSamples - 100);
    await callNative('stopRecordingInNode', id);
    // Reach the boundary EXACTLY: commit at lengthSamples, and raw lands
    // on a boundary so the next arm starts immediately (Q11 pending)
    advanceBy(100);
    return id;
}

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
