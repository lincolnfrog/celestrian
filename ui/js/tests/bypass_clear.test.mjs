/**
 * "WHOLE" DROPS A STALE BYPASS (2026-09-10, found by scenario S34):
 * bypass a window, clear it (loop points 0, 0 — D4-7's "whole"), draw
 * a new one later: the new window must be ACTIVE. Before this, the
 * bypass flag survived the clear and the new region was silently
 * inert (the lane showed brackets; the whole take played). Mock twin
 * of the engine rule (edit_log.cc LoopPoints, Edit::restoresBypass);
 * undo puts the flag back with the geometry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { nodeById, recordTake } from './helpers.mjs';

test('bypass → clear → new window: active; undo of the clear restores the bypass', async () => {
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const c2 = await recordTake('', 4000);  // settles to its boundary
    await callNative('setLoopPoints', c2, 1000, 3000);
    assert.equal(nodeById(c2, getState().nodes).windowActive, true);
    await callNative('toggleLoopWindow', c2);
    assert.equal(nodeById(c2, getState().nodes).loopBypassed, true);
    await callNative('setLoopPoints', c2, 0, 0);          // whole
    let n = nodeById(c2, getState().nodes);
    assert.equal(n.loopBypassed, false, 'the clear drops the stale bypass');
    assert.equal(n.windowActive, false, 'no window');
    await callNative('setLoopPoints', c2, 2000, 4000);    // a new region
    n = nodeById(c2, getState().nodes);
    assert.equal(n.windowActive, true, 'the new window sounds');
    await callNative('undo');                            // the new region
    await callNative('undo');                            // the clear
    n = nodeById(c2, getState().nodes);
    assert.equal(n.loopBypassed, true, 'undo restores the bypass with the geometry');
    assert.deepEqual([n.loopStart, n.loopEnd], [1000, 3000]);
});
