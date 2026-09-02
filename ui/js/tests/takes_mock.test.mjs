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
 *  (g) save → mutate → load restores takes, active and comp.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { recordTake, nodeById } from './helpers.mjs';

const clip = id => nodeById(id, getState().nodes);
/** The RAW clock (the published masterPos is the folded view;
 * pendingStartAt is raw). */
const rawClock = () => { const s = getState(); return s.islandPos + s.islandEpoch; };

/** Arm a new take on `id` from a MID-period clock, pin the arm rule,
 * drive it to its auto-finish; returns the arm target. */
async function newTakeAndFinish(id) {
    const before = clip(id);
    const raw = rawClock();
    await callNative('newTake', id);
    const armed = clip(id);
    assert.equal(armed.isRecording, true, 'armed');
    assert.equal(armed.isPendingStart, true, 'waits for the slot top');
    const at = armed.pendingStartAt;
    assert.equal((at - (before.origin || 0)) % before.duration, 0,
        'arm target: t == origin (mod period)');
    assert.ok(at > raw, 'the NEXT top');
    advanceBy(at - raw);          // capture begins at the top
    advanceBy(before.duration);   // exactly one period: auto-finish
    const done = clip(id);
    assert.equal(done.isRecording, false, 'auto-finished');
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
