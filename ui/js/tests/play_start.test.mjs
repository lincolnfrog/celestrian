/**
 * PLAY START (play_start.js; docs/tasks.md open question 5, owner
 * ruling 2026-09-10) — Space / ▶ plays FROM the play start and stop
 * returns the playhead TO it. Pins, over the mock backend:
 *
 *  - by default the play start is the top: play from mid-cycle starts
 *    at 0, and stop snaps the playhead back to 0;
 *  - a ruler seek moves it: play and stop both land there;
 *  - seeking back to the top restores the default;
 *  - it is per project (another project id reads the top);
 *  - pre-Q there is no frame: the toggle runs alone, no seek is sent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    notePlayStart, notePlayStartTransport, playStartFor, togglePlayFromStart,
} from '../play_start.js';
import {
    callNative, getState, loadScenario, advanceBy,
} from '../mock_backend.js';
import { MOCK_Q as Q } from './helpers.mjs';

const PID = 'proj-a';

const near = (a, b, msg) =>
    assert.ok(Math.abs(a - b) < 1e-6, msg + ` (got ${a}, want ${b})`);

/** The published playhead (a poll while playing adds one mock tick). */
const pos = () => getState().masterPos;

function freshIsland() {
    loadScenario('example-1q-4q'); // committed island, cycle 4Q
    notePlayStart('', 0);
    notePlayStartTransport(getState().isPlaying, true);
}

test('default: play starts at the top; stop returns there', async () => {
    freshIsland();
    // Park the playhead mid-cycle the way a pause would leave it.
    assert.equal(await callNative('seekTransport', 2.5 * Q), true);
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true);

    await togglePlayFromStart(callNative, PID);  // play
    assert.equal(getState().isPlaying, true, 'playing');
    advanceBy(Q / 2);
    assert.ok(pos() < Q, 'played from the top, not from 2.5Q');

    await togglePlayFromStart(callNative, PID);  // stop
    assert.equal(getState().isPlaying, false, 'stopped');
    near(pos(), 0, 'stop returned the playhead to the top');
});

test('a ruler seek moves the play start; play and stop land there', async () => {
    freshIsland();
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true);
    notePlayStart(PID, 2 * Q);  // the ruler click (app.js onSeek)

    await togglePlayFromStart(callNative, PID);  // play
    advanceBy(Q / 4);
    const playing = pos();
    assert.ok(playing >= 2 * Q && playing < 3 * Q,
        `played from 2Q (got ${playing / Q}Q)`);

    await togglePlayFromStart(callNative, PID);  // stop
    near(pos(), 2 * Q, 'stop returned to the ruler position');
});

test('seeking back to the top restores the default', async () => {
    freshIsland();
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true);
    notePlayStart(PID, 3 * Q);
    notePlayStart(PID, 0);  // click at the top

    await togglePlayFromStart(callNative, PID);  // play
    advanceBy(Q);
    await togglePlayFromStart(callNative, PID);  // stop
    near(pos(), 0, 'back to the top');
});

test('per project: another project reads the top', () => {
    notePlayStart(PID, 2 * Q);
    assert.equal(playStartFor(PID), 2 * Q);
    assert.equal(playStartFor('proj-b'), 0, 'a switched project starts at the top');
});

test('pre-Q: no frame to seek in — the toggle runs alone', async () => {
    const calls = [];
    const fake = async (method, ...args) => { calls.push([method, ...args]); return true; };
    notePlayStart(PID, 2 * Q);
    notePlayStartTransport(false, false);
    await togglePlayFromStart(fake, PID);
    await togglePlayFromStart(fake, PID);
    assert.deepEqual(calls, [['togglePlayback'], ['togglePlayback']]);
});

test('order: play seeks BEFORE resuming; stop pauses BEFORE returning', async () => {
    const calls = [];
    const fake = async (method, ...args) => { calls.push([method, ...args]); return true; };
    notePlayStart(PID, Q);
    notePlayStartTransport(false, true);
    await togglePlayFromStart(fake, PID);  // play
    await togglePlayFromStart(fake, PID);  // stop (local flag flipped: no poll needed)
    assert.deepEqual(calls, [
        ['seekTransport', Q], ['togglePlayback'],
        ['togglePlayback'], ['seekTransport', Q],
    ]);
});
