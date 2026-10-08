/**
 * THE SWAP PREVIEW'S TOP IS THE ENGINE'S ANSWER (splice_handles
 * topAfterSwap; pending_edits answered) — mock parity through the real
 * view model.
 *
 * A lane splice drag previews its landing locally: the segments, and
 * the top the engine will store once the swap lands (the reconcile:
 * kept while the new region plays it, else the new region start). The
 * preview is dropped when the polled node MATCHES it — every part.
 *
 * Since 2026-09-29 a loop that slots into the frame shows its ↺ where
 * it STARTS PLAYING (the sample at the frame's top, view_model
 * topFields), which is not the engine's top. Predicted from the ↺ as
 * shown, the preview's top never matched the commit's answer: the
 * preview outlived it by the whole hold cap (COMMIT_HOLD_MAX_MS), and
 * an undo, a nudge or a panel edit made meanwhile did not show on the
 * lane (field audit 2026-10-01: ⌘Z right after a splice drag on clip 3
 * showed 1.5 s late).
 *
 * What this pins:
 *   (a) the lane carries BOTH tops: `topQ` (the ↺ as shown) and
 *       `storedTopQ` (the engine's effective top), equal on the loop
 *       that places the frame and — here — different on the one that
 *       slots in;
 *   (b) the swap predicts from the engine's top: for a slide that keeps
 *       it, one that drops it, and a cell cut, the prediction equals
 *       the `loopTop` the mock publishes after the commit;
 *   (c) so the preview is ANSWERED by the very next poll.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, pauseTransport } from '../mock_backend.js';
import { state } from '../mock/state.js';
import { deriveViewModel } from '../view_model.js';
import { bandState } from '../session_view/map_core.js';
import { topAfterSwap } from '../session_view/splice_handles.js';
import { setPendingEdit, clearAllPendingEdits, hasPendingEdits, pendingEditsFor }
    from '../session_view/pending_edits.js';
import { MOCK_Q as Q, nodeById, recordTake } from './helpers.mjs';

const pub = id => nodeById(id, getState().nodes);
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

/** A 1Q definer; B, a 12Q take looped to [4, 8) — the first loop longer
 * than Q, so it places the frame; C, a 16Q take looped to [6, 10), which
 * slots in. The clock is held still: no continuity re-anchor. */
async function island() {
    loadScenario('empty');
    const a = await recordTake('', Q, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 12 * Q);
    const c = await recordTake('', 16 * Q);
    pauseTransport();
    state.isPlaying = false;
    await callNative('setLoopPoints', b, 4 * Q, 8 * Q);
    await callNative('setLoopPoints', c, 6 * Q, 10 * Q);
    return { a, b, c };
}

test('(a) the lane carries the ↺ as shown AND the engine\'s top', async () => {
    const { b, c } = await island();
    const vm = deriveViewModel(getState());
    const B = laneOf(vm, b);
    const C = laneOf(vm, c);
    assert.equal(B.storedTopQ, pub(b).loopTop / Q, 'the placer: the published top');
    assert.equal(B.topQ, B.storedTopQ, '…which IS its ↺');
    assert.equal(C.storedTopQ, pub(c).loopTop / Q, 'slotted in: the published top');
    assert.equal(C.storedTopQ, 6, '…its region start (never moved)');
    assert.notEqual(C.topQ, C.storedTopQ,
        'its ↺ shows where it starts playing — another sample (the fixture must ' +
        'keep C off the frame\'s top for this test to mean anything)');
    assert.ok(Math.abs(C.topHeardQ) < 1e-9, 'the ↺ at the frame\'s left edge');
});

for (const [name, segsQ] of [
    ['a slide that still plays the engine\'s top', [[5, 9]]],
    ['a slide that drops it', [[8, 12]]],
    ['a cell cut over the ↺ as shown', [[6, 7], [8, 10]]],
]) {
    test(`(b) ${name}: the prediction is the top the commit publishes`, async () => {
        const { c } = await island();
        const vm = deriveViewModel(getState());
        const C = laneOf(vm, c);
        const st = bandState(C, vm, vm.cycleQ);
        const predicted = topAfterSwap(C, st)(segsQ);
        const flat = segsQ.flat().map(q => q * Q);
        await callNative('setSegments', c, flat);
        assert.equal(pub(c).loopTop, predicted, 'predicted = published');

        // (c) the preview the drag left is answered by the next poll.
        clearAllPendingEdits();
        setPendingEdit(c, { segments: flat, top: predicted }, 1000);
        const poll = getState();
        const left = pendingEditsFor(id => nodeById(id, poll.nodes),
            poll.islandZero ?? 0, 1050, false);
        assert.equal(left, null, 'no preview survives the answering poll');
        assert.equal(hasPendingEdits(), false);
    });
}

test('(b) predicted from the ↺ as shown, the preview would never be answered', async () => {
    // The bug this file exists for, stated as a property of the fixture:
    // the two tops disagree after a swap, so only the engine's own can
    // predict the commit.
    const { c } = await island();
    const vm = deriveViewModel(getState());
    const C = laneOf(vm, c);
    const st = bandState(C, vm, vm.cycleQ);
    const shown = topAfterSwap({ ...C, storedTopQ: C.topQ }, st)([[5, 9]]);
    await callNative('setSegments', c, [5 * Q, 9 * Q]);
    assert.notEqual(pub(c).loopTop, shown);
});
