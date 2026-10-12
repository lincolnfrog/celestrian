/**
 * THE WINDOW CURSOR OF A GROUP UNDER A STEP AUDITION (session_view.md,
 * "the window cursor": an amber heard-time playhead inside active
 * brackets, read from the engine-published window phase on `playhead`).
 * A step audition is a derived one-segment window on its stack
 * (sequencer.md §11.2): the group's lane keeps the song, wears the
 * step's brackets, and its cursor sweeps the step — at the phase the
 * backend publishes for the stack, exactly as a clip's does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { SCENE_Q as Q, clipAt, groupAt, island, laneOf } from './helpers.mjs';

const clip = (id, durQ, extra) => clipAt(id, 0, durQ, extra);
/** A group with an 8Q song of two 4Q steps over a 4Q loop. */
const song = (extra = {}) => groupAt('g', 0, [clip('k', 4)], {
    playhead: 0,
    sequence: { steps: [{ name: 'A', len: 4 * Q }, { name: 'B', len: 4 * Q }],
                bypassed: false, gates: {}, auditionStep: -1 },
    ...extra,
});

test('a group auditioning a step: its lane\'s cursor is at the published phase', () => {
    // Step B loops: the stack publishes its derived window [4Q, 8Q) and,
    // on `playhead`, how far through it the sound is.
    const auditioning = phase => song({
        loopStart: 4 * Q, loopEnd: 8 * Q, windowActive: true, playhead: phase,
        sequence: { ...song().sequence, auditionStep: 1 } });
    for (const phase of [0, 0.25, 0.9]) {
        // Beside another track the island cycles on, and nested one down.
        for (const nodes of [[auditioning(phase), clip('bed', 8)],
                             [{ ...song({ id: 'outer', sequence: undefined }),
                                nodes: [auditioning(phase)] }, clip('bed', 8)]]) {
            const lane = laneOf(deriveViewModel(island(nodes)), 'g');
            assert.equal(lane.periodQ, 8, 'the lane keeps the song');
            assert.deepEqual([lane.window.startQ, lane.window.endQ, lane.window.audition],
                [4, 8, true], 'it wears the step\'s brackets');
            assert.equal(lane.window.active, true);
            assert.equal(lane.windowPhase, phase, 'the cursor sweeps the step');
        }
    }
});

test('a group whose window does not sound has no phase to show', () => {
    const lane = nodes => laneOf(deriveViewModel(island(nodes)), 'g');
    // No audition: the song plays whole.
    assert.equal(lane([song({ playhead: 0.4 }), clip('bed', 8)]).windowPhase, 0);
    // A bypassed window over plain loops: brackets, no cursor.
    const bypassed = song({ sequence: undefined, loopStart: 0, loopEnd: 2 * Q,
                            loopBypassed: true, playhead: 0.4 });
    const b = lane([bypassed, clip('bed', 4)]);
    assert.equal(b.window.bypassed, true, 'premise');
    assert.equal(b.windowPhase, 0);
});
