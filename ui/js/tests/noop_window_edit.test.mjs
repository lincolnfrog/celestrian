/* IDENTITY WINDOW EDITS RECORD NOTHING (audit 2026-08-31 U3/F-C,
 * regression form of the fresh-audit probe): a zero-movement bracket
 * click used to re-commit the unchanged window — stacking a no-op
 * undo step and destroying the redo branch. Now the gesture layer
 * skips the commit (window_edit.js), AND the backend treats an
 * identity setLoopPoints as a no-op (engine parity), AND a refused
 * edit preserves redo (undo.js). An identity multi-segment setSegments
 * records nothing the same way (2026-09-24). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { callNative, getState, loadScenario } from '../mock_backend.js';
import { findNode } from '../mock/state.js';
import { MOCK_Q, recordTake } from './helpers.mjs';

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

test('identity setSegments (the stored cell map again) records nothing: ' +
     'the undo stack and the redo branch stand, and a drag whose first ' +
     'commit it is still forms one undo step', async () => {
    // Engine twin: tests/time_map_record_tests.cc, the same sequence.
    const Q = MOCK_Q;
    loadScenario('empty');
    await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 8 * Q);
    // Two cells a Q apart, from `a` (the protocol's flat form): period 2Q.
    const cells = a => [a, a + Q, a + 2 * Q, a + 3 * Q];
    const map = () => (findNode(b).segments || []).flat();
    assert.deepEqual(map(), [], 'a fresh take: no map');
    await callNative('setSegments', b, cells(Q));      // step A
    await callNative('setSegments', b, cells(2 * Q));  // step B
    await callNative('undo');
    assert.equal(getState().canRedo, true, 'B waits on the redo branch');
    await callNative('setSegments', b, cells(Q));      // the stored map again
    assert.deepEqual(map(), cells(Q), 'the identity changed nothing');
    assert.equal(getState().canRedo, true, '…and kept the redo branch');
    await callNative('redo');
    assert.deepEqual(map(), cells(2 * Q), 'redo: B');
    await callNative('undo');
    await callNative('undo');
    assert.deepEqual(map(), [], "two undos reach A's own step: the identity stacked none");
    // A DRAG whose first commit is the identity opens its gesture anyway:
    // its live commits form ONE step, and a live commit that dwells on
    // the stored map records nothing.
    await callNative('redo');
    assert.deepEqual(map(), cells(Q), 'A again');
    await callNative('setSegments', b, cells(Q));  // the drag's first commit
    await callNative('setSegments', b, cells(2 * Q), true);
    await callNative('setSegments', b, cells(3 * Q), true);
    await callNative('setSegments', b, cells(3 * Q), true);  // dwelling
    assert.deepEqual(map(), cells(3 * Q), 'the drag landed');
    await callNative('undo');
    assert.deepEqual(map(), cells(Q), 'one undo takes the whole drag back');
    await callNative('undo');
    assert.deepEqual(map(), [], "…and the next is A's");
});
