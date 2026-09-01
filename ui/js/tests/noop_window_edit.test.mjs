/* IDENTITY WINDOW EDITS RECORD NOTHING (audit 2026-08-31 U3/F-C,
 * regression form of the fresh-audit probe): a zero-movement bracket
 * click used to re-commit the unchanged window — stacking a no-op
 * undo step and destroying the redo branch. Now the gesture layer
 * skips the commit (window_edit.js), AND the backend treats an
 * identity setLoopPoints as a no-op (engine parity), AND a refused
 * edit preserves redo (undo.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callNative, getState, loadScenario } from '../mock_backend.js';

test('identity setLoopPoints records nothing and keeps redo', async () => {
    loadScenario('single-clip');
    const dur = getState().nodes[0].duration;
    const q = getState().nodes[0].effectiveQuantum;
    // Real commits always leave a full-span window; the fixture doesn't
    // — establish it so the pre-trim state matches production.
    await callNative('setLoopPoints', 'clip-1', 0, dur);
    await callNative('setLoopPoints', 'clip-1', 0, q / 2);  // a real trim
    await callNative('undo');
    assert.equal(getState().canRedo, true, 'redo branch exists after undo');
    const { loopStart, loopEnd } = getState().nodes[0];
    const undoDepthBefore = getState().canUndo;
    // The zero-movement bracket click: same values back.
    await callNative('setLoopPoints', 'clip-1', loopStart || 0, loopEnd || q);
    assert.equal(getState().canRedo, true,
        'a no-op edit must not destroy the redo branch');
    assert.equal(getState().canUndo, undoDepthBefore,
        'and must not stack an undo step');
    // Redo still works — the trim comes back.
    await callNative('redo');
    assert.equal(getState().nodes[0].loopEnd, q / 2, 'redo restored the trim');
});

test('a refused edit also keeps redo (F-C)', async () => {
    loadScenario('single-clip');
    const q = getState().nodes[0].effectiveQuantum;
    await callNative('setLoopPoints', 'clip-1', 0, q / 2);
    await callNative('undo');
    assert.equal(getState().canRedo, true);
    // Unknown node = a refusal: nothing recorded, redo survives.
    await callNative('setLoopPoints', 'no-such-node', 0, q);
    assert.equal(getState().canRedo, true,
        'a refusal must not destroy the redo branch');
});
