/**
 * Mock-driven scene prologues. This module imports the mock backend
 * statically (helpers.mjs never does): import it only from tests that
 * drive the mock.
 */

import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, pauseTransport }
    from '../mock_backend.js';
import { state } from '../mock/state.js';
import { MOCK_Q, nodeById, recordTake } from './helpers.mjs';

/** The node `id` as the mock publishes it now. */
export const published = id => nodeById(id, getState().nodes);

/** An empty session, then one top-level take per length (samples), the
 *  first establishing Q. Answers the takes' ids in order. */
export async function recordIsland(...lengths) {
    loadScenario('empty');
    const ids = [];
    for (const len of lengths) {
        ids.push(await recordTake('', len,
            ids.length ? undefined : { stopEarly: 0, settle: 0 }));
    }
    return ids;
}

/** Two top-level takes, 1Q and 2Q at Q = 1000. */
export async function seedTwoTracks() {
    const [a, b] = await recordIsland(1000, 2000);
    return { a, b, Q: getState().quantum };
}

/** A group take: `n` mics under one new stack in `parentId`, one
 *  performance of `lenQ` mock quantums. With a Q already established,
 *  stop just short and settle across the boundary, as recordTake does. */
export async function recordGroupTake(n, lenQ, parentId = '',
                                      { stopEarly = 0, settle = 0 } = {}) {
    const stackId = await callNative('createNode', 'stack', parentId);
    const ids = [];
    for (let i = 0; i < n; ++i) ids.push(await callNative('createNode', 'clip', stackId));
    await callNative('startRecordingInNode', stackId);
    advanceBy(lenQ * MOCK_Q - stopEarly);
    await callNative('stopRecordingInNode', stackId);
    advanceBy(settle);  // the audio callback that takes the stop up
    return { stackId, ids };
}

/** Arm a new top-level take in the loaded scenario, run `probe` while
 *  it is live, then stop it: the stop is asked, and one audio callback
 *  over no samples takes it up. */
export async function underLiveTake(probe) {
    const id = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', id);
    assert.ok(published(id).isRecording, 'the take is live');
    await probe();
    await callNative('stopRecordingInNode', id);
    advanceBy(0);
}

/** Hold the clock where it is. Stopped (the default), a map edit never
 *  re-anchors, so every origin move is the verb's own; `playing` keeps
 *  the transport reading as rolling without advancing it. */
export function holdStill({ playing = false } = {}) {
    pauseTransport();
    state.isPlaying = playing;
}
