/**
 * Mock island-zero parity (mirrors AudioEngine — test_harness.md
 * gotcha 10). The island's zero is established by the first take and
 * NEVER moves at a commit (docs/frame.md): where a new take sits on
 * screen is seated by the view from the lanes, in the cycle it started
 * in. The mock once re-based the zero on every commit — which rotated
 * all lanes at each stop ("shifting left/right when you finish
 * recording" — field 2026-07-10) — and later on growth only; both are
 * gone with the frame's move into the view.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    callNative, getState, loadScenario, advanceBy,
} from '../mock_backend.js';
// helpers.recordTake's defaults (stopEarly 100, settle 100) are exactly
// this file's old local builder: stop mid-Q, then reach the boundary so
// the commit lands at lengthSamples and raw sits on a boundary (Q11).
import { recordTake, MOCK_Q as Q } from './helpers.mjs';

test('the island zero is the first take\'s origin and no commit moves it (engine parity)', async () => {
    loadScenario('empty');
    const stackId = await callNative('createNode', 'stack', '');

    // Take 1 establishes Q (1Q): no prior Q → immediate commit at raw
    const a = await callNative('createNode', 'clip', stackId);
    await callNative('startRecordingInNode', a); // resets transport to 0
    advanceBy(Q);
    await callNative('stopRecordingInNode', a);
    assert.equal(getState().islandZero, 0);

    // Loop a while, then take 2 grows the cycle 1Q → 4Q (simple
    // extension): the zero stays — the view seats the take at its own
    // top (docs/frame.md), nothing in the backend moves
    advanceBy(4 * Q);
    await recordTake(stackId, 4 * Q);
    assert.equal(getState().islandZero, 0);

    // Take 3 fits inside the 4Q cycle (no growth): still nothing moves
    await recordTake(stackId, Q);
    assert.equal(getState().islandZero, 0);

    // The awaiting-stop path committed exact lengths
    const clips = getState().nodes[0].nodes;
    assert.deepEqual(clips.map(c => c.duration), [Q, 4 * Q, Q]);
});
