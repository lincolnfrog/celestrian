/**
 * TAKES ARE UNDOABLE — mock twin (docs/sequencer.md §11.5; C++ twin
 * tests/take_undo_tests.cc). Pins the mock's contract:
 *
 *  - a committed take is ONE undo step, logged at commit (not at arm);
 *    undo empties the clip and reverts the grid the first take
 *    established; redo restores;
 *  - a Q7 group take is one step;
 *  - a later edit orders AFTER the take (rename → first undo = rename);
 *  - a cancelled arm logs nothing;
 *  - S19 auto-gate: a take into a looping step gates ON there / OFF
 *    elsewhere, and one undo removes take + gates; a deeper take is
 *    not auto-gated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { recordTake, nodeById } from './helpers.mjs';

test('first take: one undo step; undo empties + reverts Q; redo restores', async () => {
    loadScenario('empty');
    assert.equal(getState().canUndo, false);
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const st = getState();
    assert.equal(st.quantum, 1000, 'Q established');
    assert.equal(st.canUndo, true, 'the take is an undo step');
    await callNative('undo');
    const c = nodeById(id, getState().nodes);
    assert.equal(c.duration, 0, 'undo: the clip is empty');
    assert.equal(getState().quantum, 0, 'undo: the grid reverted');
    await callNative('redo');
    assert.equal(nodeById(id, getState().nodes).duration, 1000, 'redo: content back');
    assert.equal(getState().quantum, 1000, 'redo: grid back');
});

test('take 2 then rename: first undo is the rename, second is the take', async () => {
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const ep0 = getState().islandEpoch;
    advanceBy(1500);
    const b = await recordTake('', 2000);
    advanceBy(3000);  // the arm waited for a boundary; let the stop land
    const dur = nodeById(b, getState().nodes).duration;
    assert.ok(dur > 0 && !nodeById(b, getState().nodes).isRecording, 'take 2 committed');
    await callNative('renameNode', b, 'solo');
    await callNative('undo');
    assert.equal(nodeById(b, getState().nodes).name !== 'solo', true, 'rename undone');
    assert.equal(nodeById(b, getState().nodes).duration, dur, 'take 2 stands');
    await callNative('undo');
    assert.equal(nodeById(b, getState().nodes).duration, 0, 'take 2 stripped');
    assert.equal(getState().islandEpoch, ep0, 'pre-take epoch restored');
    assert.equal(getState().quantum, 1000, 'Q untouched');
});

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

test('a cancelled arm logs nothing', async () => {
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const id = await callNative('createNode', 'clip', '');
    const undoBefore = getState().canUndo;
    advanceBy(300);  // mid-Q: the arm waits for the next boundary
    await callNative('startRecordingInNode', id);
    assert.equal(nodeById(id, getState().nodes).isPendingStart, true, 'armed, pending');
    await callNative('stopRecordingInNode', id);  // before the boundary → cancel
    assert.equal(nodeById(id, getState().nodes).isRecording, false);
    assert.equal(getState().canUndo, undoBefore);
    await callNative('undo');  // = the createNode
    assert.equal(nodeById(id, getState().nodes), null, 'undo removed the node — no take entry sat above it');
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
