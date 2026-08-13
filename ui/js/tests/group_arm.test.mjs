/**
 * Group arm (Q7) — mock backend parity with the engine's fractal
 * record verb (AudioEngine::startRecordingInNode / stopRecordingInNode,
 * tests/group_arm_tests.cc is the C++ twin):
 *
 *  - a stack target arms every EMPTY clip beneath it in ONE call
 *    ("one performance, N microphones");
 *  - arm targets emptiness: committed members just play, direct arms on
 *    committed clips are refused (re-recording is the *takes* feature);
 *  - I2 simultaneity: the group shares one arm target and ONE committed
 *    duration — including the first-take case, where the first commit
 *    establishes Q and must not flip its siblings onto the
 *    awaiting-stop path;
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

test('I2: first-take group arm — one origin, one duration, one Q', async () => {
    loadScenario('empty');
    const [stackId, ids] = await buildStack(3);

    await callNative('startRecordingInNode', stackId);  // ONE call arms all
    for (const id of ids) {
        assert.equal(findN(id).isRecording, true, `${id} armed by group arm`);
    }

    advanceBy(Q);
    await callNative('stopRecordingInNode', stackId);   // ONE call stops all

    const d0 = findN(ids[0]).duration;
    const o0 = findN(ids[0]).origin;
    assert.equal(d0, Q, 'first-take duration defines Q');
    for (const id of ids) {
        const n = findN(id);
        assert.equal(n.isRecording, false, `${id} committed`);
        assert.equal(n.duration, d0, 'I2: one committed duration');
        assert.equal(n.origin, o0, 'I2: one origin');
    }
    assert.equal(getState().quantum, d0, 'island Q established once');
});

test('Q7: arm targets emptiness — committed member just plays', async () => {
    loadScenario('empty');
    const [stackId, [baseId]] = await buildStack(1);

    // Take 1 establishes Q.
    await callNative('startRecordingInNode', stackId);
    advanceBy(Q);
    await callNative('stopRecordingInNode', stackId);
    assert.equal(findN(baseId).duration, Q, 'base committed at 1Q');

    // Two empty members join; group-arm mid-cycle (Q11 pends to 2Q).
    const b = await callNative('createNode', 'clip', stackId);
    const c = await callNative('createNode', 'clip', stackId);
    advanceBy(Q / 2);  // t = 1.5Q
    await callNative('startRecordingInNode', stackId);

    assert.equal(!!findN(baseId).isRecording, false,
        'committed member NOT re-armed');
    assert.equal(findN(b).isPendingStart, true, 'empty member B pends');
    assert.equal(findN(c).isPendingStart, true, 'empty member C pends');

    advanceBy(Q / 2);        // boundary: both begin capture at 2Q
    advanceBy(Q - 200);      // just short of 1Q captured
    await callNative('stopRecordingInNode', stackId);
    advanceBy(400);          // cross the stop boundary → commit

    const nb = findN(b), nc = findN(c);
    assert.equal(nb.isRecording, false, 'B committed');
    assert.equal(nc.isRecording, false, 'C committed');
    assert.equal(nb.duration, Q, 'group take padded to the 1Q boundary');
    assert.equal(nc.duration, nb.duration, 'I2: one committed duration');
    assert.equal(nc.origin, nb.origin, 'I2: one origin');
    assert.equal(nb.origin, 2 * Q, 'anchored at the shared 2Q boundary (Q11)');
    assert.equal(findN(baseId).duration, Q, 'committed member untouched');
});

test('direct arm on a committed clip is refused (takes ≠ arm)', async () => {
    loadScenario('empty');
    const [stackId, [baseId]] = await buildStack(1);
    await callNative('startRecordingInNode', stackId);
    advanceBy(Q);
    await callNative('stopRecordingInNode', stackId);

    await callNative('startRecordingInNode', baseId);
    const n = findN(baseId);
    assert.equal(!!n.isRecording, false, 'committed clip stays idle');
    assert.equal(n.duration, Q, 'content untouched');
});

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
        assert.equal(n.duration, Q - 100, 'first-take immediate commit');
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
