/**
 * A take's undo step where the differential suite does not drive it
 * (ui/differential/ undoes a first take, a second take and a cancelled
 * arm against the engine):
 *
 *  - a Q7 group take is ONE step;
 *  - S19 auto-gate: a take into a looping step gates ON there / OFF
 *    elsewhere, and one undo removes take + gates; a deeper take is
 *    not auto-gated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { recordTake, nodeById } from './helpers.mjs';

test('Q7 group take = one undo step', async () => {
    loadScenario('empty');
    const g = await callNative('createNode', 'stack', '');
    const a = await callNative('createNode', 'clip', g);
    const b = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', g);
    advanceBy(1000);
    await callNative('stopRecordingInNode', g);
    advanceBy(100);
    assert.ok(nodeById(a, getState().nodes).duration > 0 &&
              nodeById(b, getState().nodes).duration > 0, 'both committed');
    await callNative('undo');
    assert.equal(nodeById(a, getState().nodes).duration, 0, 'one undo strips A');
    assert.equal(nodeById(b, getState().nodes).duration, 0, '...and B');
    await callNative('redo');
    assert.ok(nodeById(a, getState().nodes).duration > 0, 'redo restores');
});

test('S19 auto-gate: one undo removes take + gates; deeper take ungated', async () => {
    loadScenario('empty');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const Q = getState().quantum;
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'intro', len: 2 * Q }, { name: 'chorus', len: 2 * Q }],
        gates: {},
    });
    await callNative('auditionStep', 'mock-root', 1);
    const c = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', c);
    advanceBy(6 * Q);
    advanceBy(100);
    let st = getState();
    assert.equal(nodeById(c, st.nodes).duration, 2 * Q, 'S18: step-sized');
    assert.deepEqual(st.sequence.gates[c], [false, true], 'auto-gated ON in the chorus only');
    assert.equal(st.sequence.gates[a], undefined, 'other rows untouched');
    await callNative('undo');
    st = getState();
    assert.equal(nodeById(c, st.nodes).duration, 0, 'one undo: take gone');
    assert.equal(st.sequence.gates[c], undefined, '...and its gates');
    await callNative('redo');
    st = getState();
    assert.equal(nodeById(c, st.nodes).duration, 2 * Q, 'redo: take back');
    assert.deepEqual(st.sequence.gates[c], [false, true], 'redo: gates back');

    // Deeper: a group's clip recorded under the ROOT audition.
    const g = await callNative('createNode', 'stack', '');
    const k = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', g);
    advanceBy(6 * Q);
    advanceBy(100);
    st = getState();
    assert.ok(nodeById(k, st.nodes).duration > 0, 'committed');
    assert.equal(st.sequence.gates[g], undefined, 'group row untouched (not a direct child take)');
});
