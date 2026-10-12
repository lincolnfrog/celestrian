/**
 * Group arm (Q7) — the two stops the differential suite does not drive
 * (ui/differential/ holds the group arm itself to the engine: one
 * origin, one duration, only the empty members, a committed clip
 * refused):
 *
 *  - the root id acts as a stack over the whole graph (the R key's
 *    selection-proof stop);
 *  - stopping a still-pending group cancels the whole set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { MOCK_Q as Q, nodeById } from './helpers.mjs';

const findN = id => nodeById(id, getState().nodes);

/** Build a stack with `n` empty member clips; returns [stackId, ids]. */
async function buildStack(n) {
    const stackId = await callNative('createNode', 'stack', '');
    const ids = [];
    for (let i = 0; i < n; ++i) {
        ids.push(await callNative('createNode', 'clip', stackId));
    }
    return [stackId, ids];
}

test('the root id stops every live take (the R key\'s stop)', async () => {
    loadScenario('empty');
    const [stackId, ids] = await buildStack(2);
    await callNative('startRecordingInNode', stackId);
    advanceBy(Q - 100);
    await callNative('stopRecordingInNode', 'mock-root');
    advanceBy(200);

    for (const id of ids) {
        const n = findN(id);
        assert.equal(n.isRecording, false, `${id} stopped via root`);
        assert.equal(n.duration, Q - 100,
            'a first take ends at the length it had when asked, not at the callback\'s');
    }
    assert.equal(getState().quantum, Q - 100, 'Q from the shared take');
});

test('group stop while pending cancels the whole set', async () => {
    loadScenario('empty');
    // Establish Q first so a group arm PENDS.
    const [stackId, [baseId]] = await buildStack(1);
    await callNative('startRecordingInNode', stackId);
    advanceBy(Q);
    await callNative('stopRecordingInNode', stackId);

    const b = await callNative('createNode', 'clip', stackId);
    const c = await callNative('createNode', 'clip', stackId);
    advanceBy(Q / 4);  // mid-cycle → the arm pends
    await callNative('startRecordingInNode', stackId);
    assert.equal(findN(b).isPendingStart, true, 'B pends');

    await callNative('stopRecordingInNode', stackId);  // before the boundary
    for (const id of [b, c]) {
        const n = findN(id);
        assert.equal(!!n.isRecording, false, `${id} back to idle`);
        assert.equal(!!n.isPendingStart, false, `${id} un-armed`);
        assert.equal(n.duration || 0, 0, `${id} has no content`);
    }
    assert.equal(findN(baseId).duration, Q, 'base untouched by the cancel');
});
