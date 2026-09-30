/**
 * PLAY START (play_start.js; session_view.md display law 15)
 * — Space / ▶ plays FROM the play start and stop
 * returns the playhead TO it. Pins, over the mock backend:
 *
 *  - by default the play start is the top: play from mid-cycle starts
 *    at 0, and stop snaps the playhead back to 0;
 *  - a ruler seek moves it: play and stop both land there;
 *  - seeking back to the top restores the default;
 *  - it is per project (another project id reads the top);
 *  - pre-Q there is no frame: the toggle runs alone, no seek is sent;
 *  - the play start is a PHASE, converted to the engine's phase ADVANCE
 *    against the latest poll's frame facts (seek.js, docs/frame.md),
 *    naming the polled clock so a stale poll still lands exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    notePlayStart, notePlayStartTransport, playStartFor, togglePlayFromStart,
} from '../play_start.js';
import { seekDelta } from '../seek.js';
import { posMod } from '../math_utils.js';
import { deriveViewModel } from '../view_model.js';
import {
    callNative, getState, loadScenario, advanceBy,
} from '../mock_backend.js';
import { MOCK_Q as Q } from './helpers.mjs';

const PID = 'proj-a';

const near = (a, b, msg) =>
    assert.ok(Math.abs(a - b) < 1e-6, msg + ` (got ${a}, want ${b})`);

/** The published playhead (a poll while playing adds one mock tick). */
const pos = () => getState().masterPos;

/** The frame facts the app's poll would feed (app.js startPolling). */
function frameNow(opts = {}) {
    const st = getState();
    const vm = deriveViewModel(st, opts);
    return { rawClock: st.islandPos + st.islandZero, zero: vm.frameZero,
             seat: vm.seatedZero,
             loopSamples: (vm.loopCycleQ > 0 ? vm.loopCycleQ : vm.cycleQ) * vm.quantum };
}

/** Park the playhead at `phase` the way a ruler seek would. */
async function parkAt(phase) {
    const f = frameNow();
    assert.ok(await callNative('seekTransport', seekDelta(phase, f), f.rawClock));
}

function freshIsland() {
    loadScenario('example-1q-4q'); // committed island, cycle 4Q
    notePlayStart('', 0);
    notePlayStartTransport(getState().isPlaying, true, frameNow());
}

test('default: play starts at the top; stop returns there', async () => {
    freshIsland();
    // Park the playhead mid-cycle the way a pause would leave it.
    await parkAt(2.5 * Q);
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true, frameNow());

    await togglePlayFromStart(callNative, PID);  // play
    assert.equal(getState().isPlaying, true, 'playing');
    advanceBy(Q / 2);
    assert.ok(pos() < Q, 'played from the top, not from 2.5Q');
    // The app polls between play and stop: the frame facts refresh
    // (the play-seek moved the zero).
    notePlayStartTransport(true, true, frameNow());

    await togglePlayFromStart(callNative, PID);  // stop
    assert.equal(getState().isPlaying, false, 'stopped');
    near(pos(), 0, 'stop returned the playhead to the top');
});

test('a ruler seek moves the play start; play and stop land there', async () => {
    freshIsland();
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true, frameNow());
    notePlayStart(PID, 2 * Q);  // the ruler click (app.js onSeek)

    await togglePlayFromStart(callNative, PID);  // play
    advanceBy(Q / 4);
    const playing = pos();
    assert.ok(playing >= 2 * Q && playing < 3 * Q,
        `played from 2Q (got ${playing / Q}Q)`);

    // A poll lands between play and stop; the clock then runs on past
    // that poll before the stop — naming the polled clock lands the
    // return exactly.
    notePlayStartTransport(true, true, frameNow());
    advanceBy(Q / 8);
    await togglePlayFromStart(callNative, PID);  // stop
    near(pos(), 2 * Q, 'stop returned to the ruler position');
});

test('seeking back to the top restores the default', async () => {
    freshIsland();
    if (getState().isPlaying) await callNative('togglePlayback');
    notePlayStartTransport(false, true, frameNow());
    notePlayStart(PID, 3 * Q);
    notePlayStart(PID, 0);  // click at the top

    await togglePlayFromStart(callNative, PID);  // play
    advanceBy(Q);
    notePlayStartTransport(true, true, frameNow());
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
    notePlayStartTransport(false, false, null);
    await togglePlayFromStart(fake, PID);
    await togglePlayFromStart(fake, PID);
    assert.deepEqual(calls, [['togglePlayback'], ['togglePlayback']]);
});

test('order: play seeks BEFORE resuming; stop pauses BEFORE returning', async () => {
    const calls = [];
    const fake = async (method, ...args) => { calls.push([method, ...args]); return true; };
    notePlayStart(PID, Q);
    // A frame at phase 0: the advance to the play start is Q, computed
    // against the polled clock (named, so the engine can correct).
    notePlayStartTransport(false, true, { rawClock: 8 * Q, zero: 8 * Q, loopSamples: 4 * Q });
    await togglePlayFromStart(fake, PID);  // play
    await togglePlayFromStart(fake, PID);  // stop (local flag flipped: no poll needed)
    assert.deepEqual(calls, [
        ['seekTransport', Q, 8 * Q], ['togglePlayback'],
        ['togglePlayback'], ['seekTransport', Q, 8 * Q],
    ]);
});

test('a pinned frame: the default play start is the SEAT, not ruler 0', async () => {
    // A frame pinned one Q off its seat (a drag's pin still up): the top
    // is where the loops' tops line up, so the play-seek measures from
    // the seat; a ruler-set start stays the spot drawn.
    const calls = [];
    const fake = async (method, ...args) => { calls.push([method, ...args]); return true; };
    notePlayStart(PID, 0);
    notePlayStartTransport(false, true,
        { rawClock: 8 * Q, zero: 8 * Q, seat: 9 * Q, loopSamples: 4 * Q });
    await togglePlayFromStart(fake, PID);  // play: seat phase 3Q → +1Q
    await togglePlayFromStart(fake, PID);  // stop
    notePlayStart(PID, 2 * Q);             // a ruler click: as drawn
    await togglePlayFromStart(fake, PID);  // play: drawn phase 0 → +2Q
    assert.deepEqual(calls, [
        ['seekTransport', Q, 8 * Q], ['togglePlayback'],
        ['togglePlayback'], ['seekTransport', Q, 8 * Q],
        ['seekTransport', 2 * Q, 8 * Q], ['togglePlayback'],
    ]);
    notePlayStart(PID, 0);
});

test('field: a loop trimmed from its left realigns at once and plays from its top', async () => {
    // keys 1Q at 0, drums 5Q at 2Q, trimmed to [3Q, 5Q): the ↺ now
    // sounds at 2Q + 3Q = 5Q. The drums — the first loop longer than Q —
    // place the frame, and with no edit hold it realigns at once (owner
    // 2026-09-29): the left edge IS the drums' ↺.
    loadScenario('keys-then-drums');
    notePlayStart('', 0);
    await callNative('setLoopPoints', 'drums', 3 * Q, 5 * Q);
    if (getState().isPlaying) await callNative('togglePlayback');
    const f = frameNow();
    assert.equal(f.zero, f.seat, 'the frame shown is the seat (no hold)');
    assert.equal(posMod(f.zero - 5 * Q, f.loopSamples), 0, '…on the drums’ ↺');
    notePlayStartTransport(false, true, f);
    const intoDrums = () => {
        const st = getState();
        const d = st.nodes.find(n => n.id === 'drums');
        return posMod(st.islandPos + st.islandZero - (d.origin + d.loopStart),
                      d.loopEnd - d.loopStart);
    };
    await togglePlayFromStart(callNative, PID);  // play
    // (a poll while playing adds one mock tick)
    assert.ok(intoDrums() < Q / 4, 'play starts at the drums’ top, not a Q in');
    advanceBy(Q / 2);
    notePlayStartTransport(true, true, frameNow());
    await togglePlayFromStart(callNative, PID);  // stop
    near(intoDrums(), 0, 'stop returns to the drums’ top');
});
