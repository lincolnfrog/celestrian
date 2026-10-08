/**
 * TAKES AND COMPING — mock twin (docs/takes.md; C++ twin
 * tests/takes_tests.cc). Pins the mock's contract:
 *
 *  (a) newTake on a committed clip arms at the slot's next top
 *      (t ≡ origin mod duration), captures exactly one period and
 *      auto-finishes; duration/origin unchanged; takes 2, active 1;
 *      the active waveform is the new take's; a stop before the period
 *      CANCELS (nothing logged, the previous take stands);
 *  (b) selectTake back to 0 swaps the published waveform; undo/redo;
 *  (c) undo of a new take restores take 0 (count 1, never empty);
 *      redo re-appends;
 *  (d) deleteTake of the active falls back to a neighbour; the last
 *      take never deletes; undo brings the take back;
 *  (e) setComp on a 4Q slot publishes the cells; bad cell counts and
 *      indices are refused; undo/redo; refused mid-take;
 *  (g) save → mutate → load restores takes, active and comp;
 *  (h) the published shape of a take is the ENGINE's (armed =
 *      isPendingStart alone; capturing = the live captured length on
 *      `duration`, the slot's on `periodQ`) — and through it the view
 *      keeps its picture: the lane tiles the slot, the frame holds, a
 *      group keeps its period.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, nodeById } from './helpers.mjs';

const clip = id => nodeById(id, getState().nodes);
/** The RAW clock (the published masterPos is the folded view;
 * pendingStartAt is raw). */
const rawClock = () => { const s = getState(); return s.islandPos + s.islandZero; };

/** Arm a new take on `id` from a MID-period clock, pin the arm rule,
 * drive it to its auto-finish; returns the arm target. */
async function newTakeAndFinish(id) {
    const before = clip(id);
    const raw = rawClock();
    await callNative('newTake', id);
    // THE PUBLISHED SHAPE is the engine's (docs/takes.md §6; AudioNode /
    // ClipNode::getMetadata). ARMED is `isPendingStart` alone, and the
    // slot still publishes its own length.
    const armed = clip(id);
    assert.equal(armed.isPendingStart, true, 'armed: waits for the slot top');
    assert.equal(armed.isRecording, false, 'armed is not capturing');
    assert.equal(armed.duration, before.duration, 'pending: the slot\'s length');
    assert.deepEqual(armed.periodQ, before.periodQ, 'periodQ: the slot\'s');
    const at = armed.pendingStartAt;
    assert.equal((at - (before.origin || 0)) % before.duration, 0,
        'arm target: t == origin (mod period)');
    assert.ok(at > raw, 'the NEXT top');
    advanceBy(at - raw);          // capture begins at the top
    // CAPTURING: `duration` is the LIVE captured length — 0 at the
    // top, growing — and the slot's own rides `periodQ`.
    let live = clip(id);
    assert.equal(live.isRecording, true, 'capturing');
    assert.equal(live.isPendingStart, false);
    assert.equal(live.duration, 0, 'nothing captured yet');
    assert.deepEqual(live.periodQ, before.periodQ, 'the slot stands on periodQ');
    const part = Math.floor(before.duration / 4);
    advanceBy(part);
    live = clip(id);
    assert.equal(live.duration, part, 'the live captured length');
    assert.deepEqual(live.periodQ, before.periodQ);
    assert.equal('_retake' in live, false, 'the mock\'s bookkeeping stays private');
    advanceBy(before.duration - part);   // exactly one period: auto-finish
    const done = clip(id);
    assert.equal(done.isRecording, false, 'auto-finished');
    assert.equal(done.isPendingStart, false);
    assert.equal(done.duration, before.duration, 'the slot\'s length again');
    return at;
}

test('(a) newTake: slot-top arm, one-period cap, facts unchanged, cancel', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    let c = clip(id);
    assert.equal(c.takes, 1, 'one take');
    assert.equal(c.activeTake, 0);
    assert.deepEqual(c.comp, [], 'no comp');
    const w0 = await callNative('getWaveform', id, 40);
    const origin = c.origin, duration = c.duration;
    advanceBy(300);  // mid-period
    await newTakeAndFinish(id);
    c = clip(id);
    assert.equal(c.takes, 2, 'two takes');
    assert.equal(c.activeTake, 1, 'the new take is active');
    assert.equal(c.duration, duration, 'duration unchanged');
    assert.equal(c.origin, origin, 'origin unchanged');
    assert.equal(getState().quantum, 1000, 'Q unchanged');
    const w1 = await callNative('getWaveform', id, 40);
    assert.notDeepEqual(w1, w0, 'the active waveform is the new take');
    assert.deepEqual(await callNative('getTakeWaveform', id, 0, 40), w0, 'take 0 peaks');
    assert.deepEqual(await callNative('getTakeWaveform', id, 1, 40), w1, 'take 1 peaks');
    assert.deepEqual(await callNative('getTakeWaveform', id, 2, 40), [], 'no take 2');

    // Silence while the take is live, then a stop before the period CANCELS.
    const undoBefore = getState().canUndo;
    advanceBy(300);
    await callNative('newTake', id);
    assert.equal(clip(id).isPlaying, false, 'silent while the new take is live');
    const at = clip(id).pendingStartAt;
    advanceBy(at - rawClock() + 400);  // capturing, mid-period
    assert.equal(clip(id).isPendingStart, false, 'capturing');
    await callNative('stopRecordingInNode', id);
    c = clip(id);
    assert.equal(c.isRecording, false, 'cancelled');
    assert.equal(c.takes, 2, 'the list is as it was');
    assert.equal(c.activeTake, 1, 'the previous take stands');
    assert.equal(c.isPlaying, true, 'the slot sounds again');
    assert.equal(getState().canUndo, undoBefore, 'nothing logged');
});

test('(b) selectTake swaps the active take; undo/redo of the selection', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const w0 = await callNative('getWaveform', id, 40);
    advanceBy(300);
    await newTakeAndFinish(id);
    const w1 = await callNative('getWaveform', id, 40);
    await callNative('selectTake', id, 0);
    assert.equal(clip(id).activeTake, 0, 'take 0 selected');
    assert.deepEqual(await callNative('getWaveform', id, 40), w0, 'take 0 draws');
    await callNative('undo');
    assert.equal(clip(id).activeTake, 1, 'undo: take 1 active');
    assert.deepEqual(await callNative('getWaveform', id, 40), w1);
    await callNative('redo');
    assert.equal(clip(id).activeTake, 0, 'redo: take 0');
    const canUndo = getState().canUndo;
    await callNative('selectTake', id, 5);
    assert.equal(clip(id).activeTake, 0, 'out of range: refused');
    assert.equal(getState().canUndo, canUndo, 'a refusal records nothing');
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

test('(d) deleteTake of the active falls back to a neighbour; undoable; last take stays', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    advanceBy(300);
    await newTakeAndFinish(id);
    const w1 = await callNative('getTakeWaveform', id, 1, 40);
    await callNative('deleteTake', id, 1);
    let c = clip(id);
    assert.equal(c.takes, 1, 'one take left');
    assert.equal(c.activeTake, 0, 'the neighbour became active');
    const canUndo = getState().canUndo;
    await callNative('deleteTake', id, 0);
    assert.equal(clip(id).takes, 1, 'the last take never deletes');
    assert.equal(getState().canUndo, canUndo, '...and records nothing');
    await callNative('undo');
    c = clip(id);
    assert.equal(c.takes, 2, 'undo: take 1 is back');
    assert.equal(c.activeTake, 1, '...and active again');
    assert.deepEqual(await callNative('getTakeWaveform', id, 1, 40), w1, 'same take');
});

test('(e) setComp on a 4Q slot: cells publish; refusals; undo/redo; mid-take refusal', async () => {
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    advanceBy(500);
    const id = await recordTake('', 4000);
    advanceBy(2000);
    assert.equal(clip(id).duration, 4000, 'a 4Q slot');
    advanceBy(300);
    await newTakeAndFinish(id);
    assert.equal(clip(id).takes, 2);
    await callNative('setComp', id, [0, 1, 0, 1]);
    assert.deepEqual(clip(id).comp, [0, 1, 0, 1], 'comp published');
    const canUndo = getState().canUndo;
    await callNative('setComp', id, [0, 1, 0]);
    assert.deepEqual(clip(id).comp, [0, 1, 0, 1], 'wrong cell count refused');
    await callNative('setComp', id, [0, 1, 0, 7]);
    assert.deepEqual(clip(id).comp, [0, 1, 0, 1], 'out-of-range take refused');
    assert.equal(getState().canUndo, canUndo, 'refusals record nothing');
    await callNative('undo');
    assert.deepEqual(clip(id).comp, [], 'undo: no comp');
    await callNative('redo');
    assert.deepEqual(clip(id).comp, [0, 1, 0, 1], 'redo: comp back');
    // Deleting a comped take renumbers the cells; undo restores them.
    await callNative('setComp', id, [1, 0, 1, 0]);
    await callNative('deleteTake', id, 0);
    assert.ok(clip(id).comp.every(c => c <= 0), 'cells never name a missing take');
    await callNative('undo');
    assert.deepEqual(clip(id).comp, [1, 0, 1, 0], 'undo: comp back');
    // Mid-take: the comp is refused while a take is live.
    advanceBy(300);
    await callNative('newTake', id);
    await callNative('setComp', id, []);
    assert.deepEqual(clip(id).comp, [1, 0, 1, 0], 'refused mid-take');
    await callNative('stopRecordingInNode', id);
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
    // The integration the 2026-10-01 audit lacked. The mock used to keep
    // the slot's `duration` (and publish no `periodQ`) all through a new
    // take, so the view never met the engine's shape here — `duration`
    // the LIVE captured length — and three view bugs passed every suite:
    // the lane re-tiled at the captured length, the frame collapsed and
    // regrew, a group's lane re-tiled at Q.
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
    const at = clip(m1).pendingStartAt;
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
