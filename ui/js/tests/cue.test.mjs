/**
 * CUE STEPS (docs/sequencer.md §3) — the Q6 serial primitive, as the
 * mock publishes it and the view model draws it:
 *
 *  - setSequence carries `cue` per step; it stores, publishes, and
 *    round-trips undo/redo;
 *  - the VM grid row exposes steps[i].cue (the S22 pip's data) and the
 *    lanes carry the cued spans (seqDims[].cueSegsQ — display honest:
 *    those spans replay the song top);
 *  - an authored window over a sequence with cued steps refuses the
 *    arm (multi-step composition, out of the ratified scope).
 *
 * A take recorded into a cued step, and the arm that auto-targets one
 * (S21), are held to the engine by the differential suite
 * (ui/differential/ seq/arm-inside-a-cued-step,
 * seq/arm-under-a-seated-root-song).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, nodeById } from './helpers.mjs';
import { seedTwoTracks } from './mock_scene.mjs';

/** Two takes; a verse|chorus song with the CHORUS CUED. */
async function seedCuedSong() {
    const { a, b, Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'verse', len: 2 * Q },
                { name: 'chorus', len: 2 * Q, cue: true }],
        gates: { [a]: [true, false] },
    });
    return { a, b, Q };
}

/** Song rel of the mock transport on the 4Q song. `islandPos` is the
 * RAW zero-relative clock (the published masterPos is a view: it folds
 * under an active window). */
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
    const vm = deriveViewModel(st, { seqOpen: new Set(['mock-root']) });
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

/** A group with two takes and a cued song — and, when `windowed`, an
 * AUTHORED window over the song (sequence-domain, S16). Arms a new clip
 * in it from the PLAIN step (inside the cued one the S21 auto-target
 * would win: the audition takes precedence over the window) and answers
 * whether the arm took. */
async function armInCuedGroup({ windowed }) {
    loadScenario('empty');
    const g = await callNative('createNode', 'stack', '');
    await recordTake(g, 1000, { stopEarly: 0, settle: 0 });
    await recordTake(g, 2000);
    const Q = getState().quantum;
    await callNative('setSequence', g, {
        steps: [{ name: 'one', len: 2 * Q },
                { name: 'two', len: 2 * Q, cue: true }],
        gates: {},
    });
    if (windowed) await callNative('setLoopPoints', g, 0, 2 * Q);
    advanceInto(Q, 0, 2 * Q);
    const id = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', id);
    const clip = nodeById(id, getState().nodes);
    return !!(clip.isRecording || clip.isPendingStart);
}

test('an authored window over cued steps refuses the arm', async () => {
    assert.equal(await armInCuedGroup({ windowed: false }), true,
        'the control: with no window the same arm takes');
    assert.equal(await armInCuedGroup({ windowed: true }), false,
        'refused: authored window over a sequence with cued steps');
});
