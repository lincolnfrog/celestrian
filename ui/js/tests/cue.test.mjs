/**
 * CUE STEPS — mock + view-model twin (docs/sequencer.md §3; C++ twin:
 * the "CUE"/"S20"/"S21" sections of tests/sequencer_tests.cc). The Q6
 * serial primitive, ruled 2026-08-27 (S11 built; S20 micro-fade dip;
 * S21 arm-in-a-cued-step auto-targets it; S22 header pip). Pins:
 *
 *  - setSequence carries `cue` per step; it stores, publishes, and
 *    round-trips undo/redo;
 *  - the VM grid row exposes steps[i].cue (the S22 pip's data) and the
 *    lanes carry the cued spans (seqDims[].cueSegsQ — display honest:
 *    those spans replay the song top);
 *  - record INTO a cued step (audition, Mode 2) lands the take at the
 *    SONG TOP [0, stepLen) — where cue playback reads it — auto-gated
 *    into that step (S19 composes);
 *  - S21: arming with the playhead inside a cued step auto-engages the
 *    audition on that step; a plain step arms as Mode 1;
 *  - an authored window over a sequence with cued steps refuses the
 *    arm (multi-step composition, out of the ratified scope).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, nodeById } from './helpers.mjs';

const opts = { fxOpen: new Set(), windowEdit: new Set(),
               pinFrameQ: null, pinFoldQ: null };

/** Two takes; a verse|chorus song with the CHORUS CUED. */
async function seedCuedSong() {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 2000);
    const Q = getState().quantum;
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'verse', len: 2 * Q },
                { name: 'chorus', len: 2 * Q, cue: true }],
        gates: { [a]: [true, false] },
    });
    return { a, b, Q };
}

/** Song rel of the mock transport on the 4Q song. `islandPos` is the
 * RAW epoch-relative clock (published masterPos is a view - it folds
 * under active windows and froze one of these assertions). */
function songRel(Q) {
    const st = getState();
    const total = 4 * Q;
    return (((st.islandPos % total) + total) % total);
}

/** advance until song rel is inside [from, to) of the 4Q song. */
function advanceInto(Q, from, to) {
    for (let i = 0; i < 16; i++) {
        const rel = songRel(Q);
        if (rel >= from && rel < to) return;
        advanceBy(Math.round(Q / 4));
    }
    assert.fail('never reached the target span');
}

test('cue: stores, publishes, survives undo/redo; VM exposes it', async () => {
    const { a, Q } = await seedCuedSong();
    const st = getState();
    assert.deepEqual(st.sequence.steps.map(s => !!s.cue), [false, true],
        'the flag publishes per step');

    // The grid row (S22): the pip's data rides the VM.
    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['mock-root']) });
    const grid = vm.lanes.find(l => l.kind === 'seq');
    assert.ok(grid, 'grid row emitted');
    assert.deepEqual(grid.steps.map(s => !!s.cue), [false, true],
        'grid steps carry cue');

    // The lanes stay honest: the cued span marks EVERY child of the
    // scope (gated or not), tiled on the song period.
    const laneA = vm.lanes.find(l => l.id === a);
    assert.ok(laneA.seqDims && laneA.seqDims[0].cueSegsQ,
        'cued spans attach to the lane');
    assert.deepEqual(laneA.seqDims[0].cueSegsQ, [[2, 4]],
        'the chorus span [2Q, 4Q) is marked');

    // Undo removes the sequence edit; redo restores the flag.
    await callNative('undo');
    assert.equal(getState().sequence, undefined, 'undo clears');
    await callNative('redo');
    assert.deepEqual(getState().sequence.steps.map(s => !!s.cue),
        [false, true], 'redo restores cue');
});

test('record INTO a cued step lands at the SONG TOP, auto-gated', async () => {
    const { Q } = await seedCuedSong();
    await callNative('auditionStep', 'mock-root', 1);   // the cued chorus
    const id = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', id);
    advanceBy(3 * Q);       // past the 2Q cap: the step commits it
    await callNative('stopRecordingInNode', id);
    advanceBy(2 * Q);
    const clip = nodeById(id, getState().nodes);
    assert.ok(!clip.isRecording, 'committed');
    assert.equal(clip.duration, 2 * Q, 'a step-sized part (S18)');
    const rel = ((clip.origin - getState().islandEpoch) % (4 * Q) + 4 * Q)
        % (4 * Q);
    assert.ok(rel < 2 * Q && rel % Q === 0,
        'anchored at the SONG TOP - where cue playback reads it: ' + rel);
    assert.deepEqual(getState().sequence.gates[id], [false, true],
        'auto-gated into the cued step (S19 composes)');
});

test('S21: arm inside a cued step auto-targets it; a plain step does not',
    async () => {
    const { Q } = await seedCuedSong();
    assert.equal(getState().sequence.auditionStep, -1, 'no audition yet');

    // Into the CUED chorus [2Q, 4Q): the arm engages the audition.
    advanceInto(Q, 2 * Q + Math.round(Q / 2), 3 * Q + Math.round(Q / 2));
    const id = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', id);
    assert.equal(getState().sequence.auditionStep, 1,
        'S21: the arm auto-targeted the cued step');
    advanceBy(3 * Q);
    await callNative('stopRecordingInNode', id);
    advanceBy(2 * Q);
    const clip = nodeById(id, getState().nodes);
    assert.equal(clip.duration, 2 * Q, 'took the Mode-2 path (S18 part)');

    // Esc; into the PLAIN verse: no auto-target (honest Mode 1).
    await callNative('auditionStep', 'mock-root', -1);
    advanceInto(Q, Math.round(Q / 2), Q + Math.round(Q / 2));
    const id2 = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', id2);
    assert.equal(getState().sequence.auditionStep, -1,
        'a plain step arms as Mode 1 - no auto-target');
    await callNative('stopRecordingInNode', id2);
    advanceBy(3 * Q);
});

test('an authored window over cued steps refuses the arm', async () => {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    // A group with two takes and a cued sequence.
    const g = await callNative('createNode', 'stack', '');
    const a = await recordTake(g, 1000, { stopEarly: 0, settle: 0 });
    await recordTake(g, 2000);
    const Q = getState().quantum;
    await callNative('setSequence', g, {
        steps: [{ name: 'one', len: 2 * Q },
                { name: 'two', len: 2 * Q, cue: true }],
        gates: {},
    });
    // An AUTHORED window over the song (sequence-domain, S16).
    await callNative('setLoopPoints', g, 0, 2 * Q);
    // Arm from the PLAIN step (inside the cued one, S21 auto-target
    // would win: the audition takes precedence over the window).
    {
        const total = 4 * Q;
        for (let i = 0; i < 16; i++) {
            const rel = (((getState().islandPos % total) + total) % total);
            if (rel < 2 * Q) break;
            advanceBy(Math.round(Q / 4));
        }
    }
    const id = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', id);
    const clip = nodeById(id, getState().nodes);
    assert.ok(!clip.isRecording && !clip.isPendingStart,
        'refused: authored window over a sequence with cued steps');
    assert.ok(a, 'seed take exists');
});
