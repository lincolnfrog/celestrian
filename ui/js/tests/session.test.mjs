/**
 * Save / Load — mock backend behavior (mirrors AudioEngine::session_io).
 * The mock keeps the bundle in memory; the observable contract is a
 * round-trip that restores the saved graph and clears undo history —
 * and a load with NOTHING saved that refuses without touching anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';

const rootIds = () => getState().nodes.map(n => n.id);

// Declared FIRST on purpose: node:test runs a file's tests in order and
// each test file runs in a fresh process, so the mock's in-memory bundle
// (mockSavedSession) is guaranteed empty here — the only way to exercise
// the nothing-saved path, since saveSession can never be un-called.
test('load with nothing saved refuses and leaves everything untouched', async () => {
    loadScenario('empty');
    await callNative('createNode', 'clip', '');
    const before = rootIds();
    const undoBefore = getState().canUndo;

    const ok = await callNative('loadSession', '');
    assert.equal(ok, false, 'nothing saved: load returns false');
    assert.deepEqual(rootIds(), before, 'graph untouched by the failed load');
    assert.equal(getState().canUndo, undoBefore,
        'undo history untouched (only a SUCCESSFUL load clears it)');
});

test('save → mutate → load restores the saved graph', async () => {
    loadScenario('empty');
    const a = await callNative('createNode', 'clip', '');
    const b = await callNative('createNode', 'clip', '');
    await callNative('renameNode', a, 'Alpha');

    assert.equal(await callNative('saveSession', ''), true, 'save ok');

    // Mutate away from the saved state.
    await callNative('deleteNode', b);
    await callNative('renameNode', a, 'Changed');
    assert.deepEqual(rootIds(), [a], 'mutated: one node, renamed');

    assert.equal(await callNative('loadSession', ''), true, 'load ok');
    assert.deepEqual(rootIds(), [a, b], 'both nodes restored');
    assert.equal(getState().nodes[0].name, 'Alpha', 'saved name restored');
    assert.equal(getState().canUndo, false, 'undo history cleared on load');
});
