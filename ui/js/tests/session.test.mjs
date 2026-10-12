/**
 * Load, where the differential suite does not reach it (its
 * session/save-load journey holds the round trip to the engine, and a
 * missing session's answer — but with an empty undo log): a load that
 * finds nothing saved at its path refuses and leaves the graph AND the
 * undo history as they were.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';

test('load with nothing saved refuses and leaves everything untouched', async () => {
    loadScenario('empty');
    await callNative('createNode', 'clip', '');
    const before = getState().nodes.map(n => n.id);
    assert.equal(getState().canUndo, true, 'a step to lose');

    assert.equal(await callNative('loadSession', '/never/saved'), false,
        'nothing saved there: load answers false');
    assert.deepEqual(getState().nodes.map(n => n.id), before, 'graph untouched by the failed load');
    assert.equal(getState().canUndo, true,
        'undo history untouched (only a SUCCESSFUL load clears it)');
});
