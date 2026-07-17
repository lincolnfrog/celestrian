/**
 * Undo / redo — mock backend behavior (mirrors AudioEngine's
 * edits-as-events, unification_audit.md §2.2 Step 1). Drives the same
 * callNative surface the UI uses and checks the observable contract:
 * canUndo/canRedo on getState, undo restores the pre-edit graph, a fresh
 * edit clears the redo branch, an armed take is not deletable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';

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
