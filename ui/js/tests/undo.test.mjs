/**
 * The undo log where the differential suite does not reach it
 * (ui/differential/ holds undo and redo of every verb, and a cancelled
 * drag, to the engine): a cleared window's bypass, and the cancels of
 * cancelGesture no journey drives — a gesture that has ended, a re-time
 * with a top, a cancel under a live take.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, pauseTransport }
    from '../mock_backend.js';
import { findNode } from '../mock/state.js';
import { MOCK_Q as Q, recordTake } from './helpers.mjs';
import { published as pub } from './mock_scene.mjs';

/** A 1Q definer and an 8Q take looped to [2, 6), the clock held still
 * (a map edit then moves nothing but the map). Returns the take's id. */
async function loopedTake() {
    loadScenario('empty');
    await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const id = await recordTake('', 8 * Q);
    pauseTransport();
    await callNative('setLoopPoints', id, 2 * Q, 6 * Q);
    return id;
}
const loop = id => [pub(id).loopStart / Q, pub(id).loopEnd / Q];

/* "Whole" drops a stale bypass (engine rule: edit_geometry.cc bypassRider,
 * Edit::restoresBypass): a window bypassed, then cleared (loop points
 * 0, 0), then drawn anew is ACTIVE — and undo of the clear puts the
 * flag back with the geometry. */
test('a cleared window drops its bypass; undo of the clear restores it with the geometry', async () => {
    const id = await loopedTake();
    assert.equal(pub(id).windowActive, true);
    await callNative('toggleLoopWindow', id);
    assert.equal(pub(id).loopBypassed, true);
    await callNative('setLoopPoints', id, 0, 0);          // whole
    assert.equal(pub(id).loopBypassed, false, 'the clear drops the stale bypass');
    assert.equal(pub(id).windowActive, false, 'no window');
    await callNative('setLoopPoints', id, 3 * Q, 7 * Q);  // a new region
    assert.equal(pub(id).windowActive, true, 'the new window sounds');
    await callNative('undo');                             // the new region
    await callNative('undo');                             // the clear
    assert.equal(pub(id).loopBypassed, true, 'undo restores the bypass with the geometry');
    assert.deepEqual(loop(id), [2, 6]);
});

test('a cancel of a gesture that logged nothing, or of another node\'s, changes nothing', async () => {
    const id = await loopedTake();
    const other = getState().nodes[0].id;
    // The first commit of a whole-Q drag is usually an identity: the
    // gesture is open, nothing is logged.
    await callNative('setLoopPoints', id, 2 * Q, 6 * Q);
    assert.equal(await callNative('cancelGesture', id), true,
        'nothing to take back: the node is as the drag found it');
    assert.deepEqual(loop(id), [2, 6]);
    await callNative('undo');
    assert.deepEqual(loop(id), [0, 0], 'the stack was not touched');
    await callNative('redo');
    // Another node's gesture is not this node's to cancel.
    await callNative('setLoopPoints', id, 3 * Q, 7 * Q);
    assert.equal(await callNative('cancelGesture', other), false);
    assert.deepEqual(loop(id), [3, 7]);
    // A gesture that has ENDED (another step was logged) cannot be
    // cancelled: the step on top is not its own.
    await callNative('renameNode', id, 'Keys');
    assert.equal(await callNative('cancelGesture', id), false);
    assert.equal(pub(id).name, 'Keys');
    assert.deepEqual(loop(id), [3, 7]);
});

test('a cancelled re-time puts back origin, re-time and top — an unset top unset', async () => {
    // A PLAIN loop (no map edit yet): its top was never stored.
    loadScenario('empty');
    await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const id = await recordTake('', 8 * Q);
    pauseTransport();
    assert.equal(findNode(id).storedTop ?? null, null, 'never set');
    const before = { origin: pub(id).origin, retime: pub(id).retime, top: pub(id).loopTop };
    assert.equal(before.top, 0, 'an unset top reads the take\'s start');
    const steps = getState().canUndo;
    await callNative('setTiming', id, Q, 3 * Q);                 // opens: +1Q, top on raw 3
    await callNative('setTiming', id, Q / 2, 4 * Q, true);       // live
    assert.equal(pub(id).retime, 1.5 * Q);
    assert.equal(pub(id).loopTop, 4 * Q);
    assert.equal(await callNative('cancelGesture', id), true);
    assert.deepEqual({ origin: pub(id).origin, retime: pub(id).retime, top: pub(id).loopTop },
        before);
    // …and the STORED top is unset again — a restore-by-commit could
    // only store it at the sample it showed (the verb has no "unset").
    assert.equal(findNode(id).storedTop ?? null, null);
    assert.equal(getState().canUndo, steps, 'no step of the drag\'s');
    await callNative('undo');
    assert.equal(pub(id).duration || 0, 0, 'the step on top is the take itself');
});

test('a cancel is refused under a live take, like undo', async () => {
    const id = await loopedTake();
    await callNative('setLoopPoints', id, 3 * Q, 7 * Q);
    const rec = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', rec);
    assert.equal(await callNative('cancelGesture', id), false);
    assert.deepEqual(loop(id), [3, 7], 'the step stands');
    await callNative('stopRecordingInNode', rec);
});
