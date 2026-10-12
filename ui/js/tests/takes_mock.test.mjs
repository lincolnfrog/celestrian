/**
 * TAKES AND COMPING (docs/takes.md). The take list as the mock
 * publishes it — the arm at the slot's top, the one-period cap, select,
 * delete, comp, their refusals and their undo — is held to the engine
 * by the differential suite (ui/differential/ takes/*). Here, what that
 * suite does not compare or drive:
 *
 *  (a) CONTENT: each take keeps its own peaks, and the active take's
 *      draw — through a select, its undo, a delete and its undo;
 *  (c) undo of a new take restores take 0 (count 1, never empty);
 *      redo re-appends;
 *  (g) save → mutate → load restores takes, active and comp;
 *  (h) the VIEW through a new take, on the state the mock publishes
 *      (armed = isPendingStart alone; capturing = the live captured
 *      length on `duration`, the slot's on `periodQ`): the lane tiles
 *      the slot, the frame holds, a group keeps its period.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { findNode } from '../mock/state.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, nodeById } from './helpers.mjs';

const clip = id => nodeById(id, getState().nodes);
/** The RAW clock (the published masterPos is the folded view;
 * pendingStartAt is raw). */
const rawClock = () => { const s = getState(); return s.islandPos + s.islandZero; };

/** A new take of `id`, armed from a mid-period clock and driven through
 * its one period to the auto-finish. */
async function newTakeAndFinish(id) {
    const before = clip(id);
    await callNative('newTake', id);
    advanceBy(findNode(id).pendingStartAt - rawClock());   // capture begins at the slot top
    advanceBy(before.duration);                            // exactly one period
    assert.equal(clip(id).isRecording, false, 'auto-finished');
    assert.equal(clip(id).takes, before.takes + 1, 'a take more');
}

test('(a) content: each take keeps its own peaks; the active one draws — ' +
     'through a select, its undo, a delete and its undo', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const drawn = () => callNative('getWaveform', id, 40);
    const takePeaks = i => callNative('getTakeWaveform', id, i, 40);
    const w0 = await drawn();
    advanceBy(300);  // mid-period
    await newTakeAndFinish(id);
    const w1 = await drawn();
    assert.notDeepEqual(w1, w0, 'the active waveform is the new take');
    assert.deepEqual(await takePeaks(0), w0, 'take 0 peaks');
    assert.deepEqual(await takePeaks(1), w1, 'take 1 peaks');
    assert.deepEqual(await takePeaks(2), [], 'no take 2');

    await callNative('selectTake', id, 0);
    assert.deepEqual(await drawn(), w0, 'take 0 draws');
    await callNative('undo');
    assert.deepEqual(await drawn(), w1, 'undo: take 1 draws');

    await callNative('deleteTake', id, 1);
    await callNative('undo');
    assert.deepEqual(await takePeaks(1), w1, 'undo of the delete: the same take');
});

test('(c) undo of a new take restores take 0 (count 1); redo re-appends', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    advanceBy(300);
    await newTakeAndFinish(id);
    await callNative('undo');
    let c = clip(id);
    assert.equal(c.takes, 1, 'undo: one take');
    assert.equal(c.activeTake, 0, 'undo: take 0 active');
    assert.equal(c.duration, 1000, 'never an empty clip');
    await callNative('redo');
    c = clip(id);
    assert.equal(c.takes, 2, 'redo: two takes');
    assert.equal(c.activeTake, 1, 'redo: take 1 active');
    await callNative('undo');
    await callNative('undo');
    assert.equal(clip(id).duration, 0, 'the next entry down is take 0 itself');
});

test('(g) save -> mutate -> load restores takes, active and comp', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    advanceBy(300);
    await newTakeAndFinish(id);
    await callNative('selectTake', id, 0);
    await callNative('setComp', id, [1]);
    assert.equal(await callNative('saveSession', ''), true, 'save');
    await callNative('deleteTake', id, 1);
    assert.equal(clip(id).takes, 1, 'mutated');
    assert.equal(await callNative('loadSession', ''), true, 'load');
    const c = clip(id);
    assert.equal(c.takes, 2, 'takes restored');
    assert.equal(c.activeTake, 0, 'active restored');
    assert.deepEqual(c.comp, [1], 'comp restored');
});

/* ---------- the view through a new take ---------- */

/** A take of `len` samples on `target` (a clip, or a group: every
 * mic), once Q exists: the arm waits for its boundary, the stop lands
 * on one. `probe` is a clip the take captures into. */
async function takeInto(target, probe, len) {
    await callNative('startRecordingInNode', target);
    for (let i = 0; i < 4000 && !clip(probe).isRecording; i++) advanceBy(10);
    assert.equal(clip(probe).isRecording, true, 'the take is live');
    advanceBy(len - clip(probe).duration - 100);
    await callNative('stopRecordingInNode', target);
    advanceBy(200);
    assert.equal(clip(probe).duration, len, 'committed at ' + len);
}

test('(h) the VIEW through a new take, on the mock\'s published state: the ' +
     'lane tiles the slot, the frame holds, a group keeps its period', async () => {
    // The mock publishes a new take as the engine does — `duration` the
    // LIVE captured length, the slot's own on `periodQ` — so the view
    // meets that shape here: the lane must not re-tile at the captured
    // length, the frame must not collapse and regrow, a group's lane
    // must not re-tile at Q.
    loadScenario('empty');
    const Q = 1000;
    await recordTake('', Q, { stopEarly: 0, settle: 0 });   // Q := 1000
    const g = await callNative('createNode', 'stack', '');
    const m1 = await callNative('createNode', 'clip', g);
    const m2 = await callNative('createNode', 'clip', g);
    await takeInto(g, m1, 4 * Q);                           // a 4Q kit: the frame
    assert.equal(clip(m2).duration, 4 * Q, 'one take, both mics');

    const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);
    /** What must not change while the take runs. */
    const picture = vm => {
        const G = laneOf(vm, g);
        return { cycleQ: vm.cycleQ, lcmQ: vm.lcmQ, frameExtended: vm.frameExtended,
                 frameZero: vm.frameZero,
                 group: { periodQ: G.periodQ, intrinsicQ: G.intrinsicQ,
                          reps: G.reps.map(r => [r.startQ, r.endQ, !!r.ghost]) } };
    };
    const tiles = lane => lane.reps.map(r => [r.startQ, r.endQ]);
    const rest = deriveViewModel(getState());
    const want = picture(rest);
    assert.equal(want.cycleQ, 4, 'the kit alone makes the frame 4Q');
    assert.equal(want.group.periodQ, 4);
    const restTiles = tiles(laneOf(rest, m1));

    // ● on the group: a new take of both mics. The app infers "new
    // take" the way it does live (app.js trackRetakes): a committed
    // clip that goes hot.
    advanceBy(300);
    const before = new Map([m1, m2].map(id => [id, clip(id)]));
    await callNative('newTake', g);
    const hot = n => n.isRecording || n.isPendingStart;
    const retakes = new Set([m1, m2].filter(id =>
        hot(clip(id)) && !hot(before.get(id)) && before.get(id).duration > 0));
    assert.equal(retakes.size, 2, 'both mics are re-taking');
    const view = () => deriveViewModel(getState(), { retakes });

    // ARMED, waiting for the slot's top: nothing moved.
    let vm = view();
    assert.deepEqual(picture(vm), want, 'armed: the picture stands');
    assert.equal(vm.mapEditsLocked, true, 'the recording gate is up');

    // CAPTURING — at the top, a little in, most of the way.
    const at = findNode(m1).pendingStartAt;
    advanceBy(at - rawClock());
    for (const captured of [0, 260, 1760, 3760]) {
        advanceBy(captured - clip(m1).duration);
        assert.equal(clip(m1).duration, captured, 'published: the live captured length');
        vm = view();
        assert.deepEqual(picture(vm), want, `${captured} captured: the picture stands`);
        for (const id of [m1, m2]) {
            const lane = laneOf(vm, id);
            assert.equal(lane.retake, true, id + ' is a new take');
            assert.deepEqual(tiles(lane), restTiles, id + ': the slot\'s tiles');
            assert.ok(lane.reps.every(r => r.silent), id + ': silent under the bar');
            assert.equal(lane.intrinsicQ, 4, id + ': the slot\'s length');
            assert.ok(Math.abs(lane.recordingLengthQ - captured / Q) < 1e-6,
                `${id}: the bar runs from the slot top (${lane.recordingLengthQ})`);
        }
    }

    // COMMITTED: two takes each, and the picture it always was.
    advanceBy(4 * Q - clip(m1).duration);
    assert.equal(clip(m1).takes, 2);
    assert.equal(hot(clip(m1)), false);
    vm = deriveViewModel(getState());
    assert.deepEqual(picture(vm), want, 'committed: the same picture');
});
