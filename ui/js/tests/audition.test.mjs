/**
 * THE STEP AUDITION — mock twin (docs/sequencer.md §11.2; C++ twin:
 * the "audition" sections of tests/sequencer_tests.cc). Pins:
 *
 *  - auditionStep(id, i) makes the holder's window the step's span,
 *    DERIVED (it follows a resize), published over the base fields
 *    (windowActive/loopStart/loopEnd) and as sequence.auditionStep;
 *  - the heard cycle becomes the step (map over sequence — S9);
 *  - the VM keeps the FRAME = the song and maps the cursor into the
 *    step (vm.loopStartQ / vm.rootWindow);
 *  - a shape change (delete) clears it; a resize keeps it; −1 stops;
 *  - it is NOT undoable (a monitoring gesture);
 *  - S18: a take recorded into a looping step is a STEP-SIZED part
 *    (duration = step length, no song-length silence), anchored at the
 *    step top.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, nodeById } from './helpers.mjs';

const opts = { fxOpen: new Set(), windowEdit: new Set(),
               pinFrameQ: null, pinFoldQ: null };

async function seedSong() {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 2000);
    const Q = getState().quantum;
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'intro', len: 2 * Q }, { name: 'chorus', len: 4 * Q },
                { name: 'out', len: 2 * Q }],
        gates: { [a]: [true, true, false] },
    });
    return { a, b, Q };
}

test('auditionStep: derived window, heard cycle = the step, frame = the song', async () => {
    const { Q } = await seedSong();
    assert.equal(deriveViewModel(getState(), opts).cycleQ, 8, 'the song');

    await callNative('auditionStep', 'mock-root', 1);
    const st = getState();
    assert.equal(st.sequence.auditionStep, 1, 'published on the sequence');
    assert.equal(st.windowActive, true, 'root window active (derived)');
    assert.equal(st.loopStart, 2 * Q, 'window start = step top');
    assert.equal(st.loopEnd, 6 * Q, 'window end = step end');

    const vm = deriveViewModel(st, opts);
    assert.equal(vm.cycleQ, 8, 'FRAME stays the song');
    assert.equal(vm.loopCycleQ, 4, 'the AUDIBLE cycle is the step');
    assert.equal(vm.loopStartQ, 2, 'cursor mapped into the step');
    assert.deepEqual(vm.rootWindow, { startQ: 2, endQ: 6, step: 1 });
    assert.equal(vm.rootSeq.auditionStep, 1);

    // The transport wraps on the step: advance 5Q → 1Q into the step.
    advanceBy(5 * Q);
    const vm2 = deriveViewModel(getState(), opts);
    assert.ok(vm2.playheadQ >= 2 && vm2.playheadQ < 6,
        'playhead stays inside the looping step: ' + vm2.playheadQ);
});

test('auditionStep follows a resize, clears on a delete, −1 stops, not undoable', async () => {
    const { Q } = await seedSong();
    const canUndoBefore = getState().canUndo;
    await callNative('auditionStep', 'mock-root', 2);
    assert.equal(getState().loopStart, 6 * Q);
    assert.equal(getState().canUndo, canUndoBefore, 'no undo step recorded');

    // Resize step 1 (same count): the audition follows.
    const s = getState().sequence;
    await callNative('setSequence', 'mock-root', {
        steps: [s.steps[0], { ...s.steps[1], len: 6 * Q }, s.steps[2]],
        gates: s.gates,
    });
    assert.equal(getState().sequence.auditionStep, 2, 'index kept');
    assert.equal(getState().loopStart, 8 * Q, 'window moved with the resize');

    // Delete a step (shape change): cleared.
    const s2 = getState().sequence;
    await callNative('setSequence', 'mock-root', {
        steps: [s2.steps[0], s2.steps[1]], gates: {},
    });
    assert.equal(getState().sequence.auditionStep, -1, 'cleared on delete');
    assert.equal(getState().windowActive, false);

    await callNative('auditionStep', 'mock-root', 0);
    assert.equal(getState().windowActive, true);
    await callNative('auditionStep', 'mock-root', -1);
    assert.equal(getState().windowActive, false, '−1 stops');
    assert.equal(getState().sequence.auditionStep, -1);

    // Out-of-range is refused.
    await callNative('auditionStep', 'mock-root', 7);
    assert.equal(getState().windowActive, false);
});

test('bypassing the sequence drops the audition (derived, never authored)', async () => {
    await seedSong();
    await callNative('auditionStep', 'mock-root', 1);
    await callNative('toggleSequence', 'mock-root');
    const st = getState();
    assert.equal(st.windowActive, false, 'no window without the sequence');
    assert.equal(st.sequence.auditionStep, -1, 'published as none');
    await callNative('toggleSequence', 'mock-root');
    assert.equal(getState().windowActive, true, 'and it is back with the sequence');
});

test('S18: a take into a looping step is a step-sized part at the step top', async () => {
    const { Q } = await seedSong();
    await callNative('auditionStep', 'mock-root', 1);   // chorus: [2Q, 6Q)
    const id = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', id);
    advanceBy(3 * Q);       // inside the 4Q step: the cap lets it run
    await callNative('stopRecordingInNode', id);
    advanceBy(2 * Q);
    const clip = nodeById(id, getState().nodes);
    assert.ok(!clip.isRecording, 'committed');
    assert.equal(clip.duration, 4 * Q,
        'C = the step length (a PART, not a song-length clip with silence)');
    const rel = ((clip.origin - getState().islandEpoch) % (8 * Q) + 8 * Q) % (8 * Q);
    assert.ok(rel >= 2 * Q && rel < 6 * Q && rel % Q === 0,
        'anchored on a Q boundary inside the step, in song coordinates: ' + rel);
    assert.equal(getState().sequence.auditionStep, 1, 'the loop stays on after commit');
    assert.equal(deriveViewModel(getState(), opts).cycleQ, 8,
        'the song frame is unchanged (no silence-padded 8Q take)');
});

test('a group stack audition: derived window on the group, not undoable', async () => {
    loadScenario('stack-with-clips');
    const st0 = getState();
    const g = st0.nodes.find(n => n.type === 'stack');
    const Q = st0.quantum || deriveViewModel(st0, opts).quantum;
    await callNative('setSequence', g.id, {
        steps: [{ name: 'A', len: 2 * Q }, { name: 'B', len: 2 * Q }],
        gates: {},
    });
    const undoBefore = getState().canUndo;
    await callNative('auditionStep', g.id, 1);
    const gn = nodeById(g.id, getState().nodes);
    assert.equal(gn.windowActive, true);
    assert.equal(gn.loopStart, 2 * Q);
    assert.equal(gn.loopEnd, 4 * Q);
    assert.equal(gn.sequence.auditionStep, 1);
    assert.equal(getState().canUndo, undoBefore, 'not undoable');
    const vm = deriveViewModel(getState(), opts);
    const lane = vm.lanes.find(l => l.id === g.id);
    assert.equal(lane.seq.auditionStep, 1, 'lane chip fact');
    // Step 3 (§12.2): the group lane tiles in SONG coordinates now, so
    // the derived brackets land where they mean.
    assert.equal(lane.periodQ, 4, 'the group lane tiles at its song length');
    assert.deepEqual([lane.window.startQ, lane.window.endQ, lane.window.active],
        [2, 4, true], 'nested audition brackets drawn at the step');
    await callNative('auditionStep', g.id, -1);
    assert.equal(nodeById(g.id, getState().nodes).windowActive, false);
});

test('S16: a window authored over the song is SUSPENDED while the sequence is off', async () => {
    loadScenario('stack-with-clips');
    const st0 = getState();
    const g = st0.nodes.find(n => n.type === 'stack');
    const Q = st0.quantum || deriveViewModel(st0, opts).quantum;
    // No sequence: intrinsic domain, an ordinary window.
    await callNative('setLoopPoints', g.id, 0, 1 * Q);
    assert.equal(nodeById(g.id, getState().nodes).windowDomain, 'intrinsic');
    // A sequence, then a window authored over it: sequence domain.
    await callNative('setSequence', g.id, {
        steps: [{ name: 'A', len: 2 * Q }, { name: 'B', len: 2 * Q }], gates: {},
    });
    await callNative('setLoopPoints', g.id, 1 * Q, 3 * Q);
    let gn = nodeById(g.id, getState().nodes);
    assert.equal(gn.windowDomain, 'sequence');
    assert.equal(gn.windowActive, true);
    assert.equal(gn.windowSuspended, false);
    // Bypass the sequence: suspended — no map, geometry kept (I9).
    await callNative('toggleSequence', g.id);
    gn = nodeById(g.id, getState().nodes);
    assert.equal(gn.windowSuspended, true);
    assert.equal(gn.windowActive, false);
    assert.equal(gn.loopStart, 1 * Q, 'geometry kept');
    const lane = deriveViewModel(getState(), opts).lanes.find(l => l.id === g.id);
    assert.equal(lane.window.suspended, true, 'the VM says why');
    // Back on: it returns.
    await callNative('toggleSequence', g.id);
    gn = nodeById(g.id, getState().nodes);
    assert.equal(gn.windowActive, true);
    assert.equal(gn.windowSuspended, false);
});
