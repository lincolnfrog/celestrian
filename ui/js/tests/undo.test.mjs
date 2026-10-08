/**
 * Undo / redo — mock backend behavior (mirrors AudioEngine's
 * edits-as-events, unification_audit.md §2.2 Step 1). Drives the same
 * callNative surface the UI uses and checks the observable contract:
 * canUndo/canRedo on getState, undo restores the pre-edit graph, a fresh
 * edit clears the redo branch, an armed take is not deletable — and a
 * CANCELLED drag (cancelGesture) leaves the log as it found it: its
 * step dropped, the redo branch it invalidated back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, pauseTransport }
    from '../mock_backend.js';
import { findNode } from '../mock/state.js';
import { MOCK_Q as Q, nodeById, recordTake } from './helpers.mjs';

const rootIds = () => getState().nodes.map(n => n.id);

test('create → undo removes → redo re-adds', async () => {
    loadScenario('empty');
    assert.equal(getState().canUndo, false, 'no undo initially');

    const id = await callNative('createNode', 'clip', '');
    assert.deepEqual(rootIds(), [id], 'one node after create');
    assert.equal(getState().canUndo, true, 'canUndo after create');

    await callNative('undo');
    assert.deepEqual(rootIds(), [], 'undo removed the node');
    assert.equal(getState().canRedo, true, 'canRedo after undo');

    await callNative('redo');
    assert.deepEqual(rootIds(), [id], 'redo restored the node');
});

test('delete → undo restores the node (name preserved)', async () => {
    loadScenario('empty');
    const id = await callNative('createNode', 'clip', '');
    await callNative('renameNode', id, 'Keep');

    await callNative('deleteNode', id);
    assert.deepEqual(rootIds(), [], 'deleted');

    await callNative('undo');
    assert.deepEqual(rootIds(), [id], 'restored by undo');
    assert.equal(getState().nodes[0].name, 'Keep', 'name preserved');
});

test('a fresh edit clears the redo branch', async () => {
    loadScenario('empty');
    await callNative('createNode', 'clip', '');
    await callNative('undo');
    assert.equal(getState().canRedo, true, 'redo available after undo');
    await callNative('createNode', 'stack', '');
    assert.equal(getState().canRedo, false, 'fresh edit cleared redo');
});

test('rename round-trips', async () => {
    loadScenario('empty');
    const id = await callNative('createNode', 'clip', '');
    await callNative('renameNode', id, 'A');
    await callNative('renameNode', id, 'B');
    assert.equal(getState().nodes[0].name, 'B');
    await callNative('undo');
    assert.equal(getState().nodes[0].name, 'A', 'undo → A');
});

/* ---------- a cancelled gesture (cancelGesture) ---------- */

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
const pub = id => nodeById(id, getState().nodes);
const loop = id => [pub(id).loopStart / Q, pub(id).loopEnd / Q];

test('a cancelled drag leaves the log as it found it: no undo step, redo back', async () => {
    const id = await loopedTake();
    // A redo branch to lose: rename, then undo it.
    await callNative('renameNode', id, 'Bass');
    await callNative('undo');
    assert.equal(pub(id).name !== 'Bass' && getState().canRedo, true, 'redo: the rename');
    // THE DRAG: its first commit opens the gesture, the live ones
    // coalesce into its one step.
    await callNative('setLoopPoints', id, 3 * Q, 7 * Q);          // opens, logs
    assert.equal(getState().canRedo, false, 'an edit invalidates redo — for now');
    await callNative('setLoopPoints', id, 4 * Q, 8 * Q, true);    // live
    assert.deepEqual(loop(id), [4, 8]);
    // ESCAPE.
    assert.equal(await callNative('cancelGesture', id), true);
    assert.deepEqual(loop(id), [2, 6], 'back where the gesture found it');
    assert.equal(getState().canRedo, true, 'the redo branch is back');
    await callNative('redo');
    assert.equal(pub(id).name, 'Bass', '…and it is the same branch');
    // The next ⌘Z undoes the rename, then the loop: no step is the
    // cancelled drag's.
    await callNative('undo');
    assert.notEqual(pub(id).name, 'Bass');
    await callNative('undo');
    assert.deepEqual(loop(id), [0, 0], 'the step before the drag: the loop itself');
});

test('a cancel of a gesture that logged nothing, or of another node\'s, changes nothing', async () => {
    const id = await loopedTake();
    const other = getState().nodes[0].id;
    // The first commit of a whole-Q drag is usually an identity: the
    // gesture is open, nothing is logged.
    await callNative('setLoopPoints', id, 2 * Q, 6 * Q);
    assert.equal(await callNative('cancelGesture', id), false);
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
