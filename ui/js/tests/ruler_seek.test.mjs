/**
 * Ruler scrub (owner ruling 2026-08-27) — the two halves of the seek:
 *
 *   1. seekTargetFromFrac (session_view/ruler_seek.js): the pure
 *      display→engine mapping — pointer fraction of the ruler to a
 *      seekTransport target, clamped into the audible loop's span
 *      (one rule for plain playback, trim view, and auditions).
 *   2. The mock's seekTransport (mock/transport.js, engine parity):
 *      a PHASE ADVANCE (docs/frame.md) — the island's zero and every
 *      origin move back by it; the monotonic clock is never touched
 *      (kernel.md) — corrected for the clock since the poll it was
 *      computed against (`atClock`), and REFUSED while any take is
 *      live or armed. seek.js turns the ruler's target phase into it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { seekTargetFromFrac } from '../session_view/ruler_seek.js';
import { seekDelta } from '../seek.js';
import {
    callNative, getState, loadScenario, advanceBy,
} from '../mock_backend.js';
import { MOCK_Q as Q } from './helpers.mjs';

const near = (a, b, msg) =>
    assert.ok(Math.abs(a - b) < 1e-6, msg + ` (got ${a}, want ${b})`);

/* ---------- 1. the pure display→engine mapping ---------- */

test('plain frame: fraction maps linearly, clamped to the frame', () => {
    const vm = { qEstablished: true, quantum: Q, cycleQ: 4,
                 loopStartQ: 0, loopCycleQ: 4 };
    const mid = seekTargetFromFrac(0.5, vm);
    near(mid.samples, 2 * Q, 'mid-frame target');
    near(mid.displayQ, 2, 'mid-frame display');

    // Drags past the edges clamp — never negative, never past the end
    near(seekTargetFromFrac(-0.2, vm).samples, 0, 'clamped below');
    const end = seekTargetFromFrac(1.4, vm);
    near(end.samples, 4 * Q, 'clamped above (engine folds cycle to 0)');
    near(end.displayQ, 0, 'the frame end displays as the top');
});

test('audition bracket: clicks clamp INTO the span (owner ruling)', () => {
    // A 1Q step bracketed at [2Q, 3Q) of a 4Q song (root audition /
    // sole-group audition shape: loopStartQ + loopCycleQ describe it).
    const vm = { qEstablished: true, quantum: Q, cycleQ: 4,
                 loopStartQ: 2, loopCycleQ: 1 };
    // Before the bracket → its start (the audition survives the click)
    const before = seekTargetFromFrac(0.25, vm);
    near(before.samples, 0, 'clamped to the step top');
    near(before.displayQ, 2, 'displays at the bracket start');
    // Inside the bracket → the offset into the step
    const inside = seekTargetFromFrac(2.5 / 4, vm);
    near(inside.samples, 0.5 * Q, 'step-relative target');
    near(inside.displayQ, 2.5, 'displays under the pointer');
    // After the bracket → its end (folds to the step top)
    const after = seekTargetFromFrac(1, vm);
    near(after.samples, 1 * Q, 'clamped to the step end');
    near(after.displayQ, 2, 'the step end displays as its top');
});

test('no frame yet → no target', () => {
    assert.equal(seekTargetFromFrac(0.5, null), null);
    assert.equal(seekTargetFromFrac(0.5,
        { qEstablished: false, quantum: Q, cycleQ: 4 }), null);
    assert.equal(seekTargetFromFrac(NaN,
        { qEstablished: true, quantum: Q, cycleQ: 4, loopCycleQ: 4 }), null);
});

/* ---------- 2. the mock backend (engine parity) ---------- */

test('a seek advances the phase by moving the zero and every origin; the monotonic clock never moves', async () => {
    loadScenario('example-1q-4q'); // committed island, cycle 4Q
    // The raw monotonic clock, reconstructed from the published pair
    // (islandPos = raw − zero, so raw = islandPos + zero).
    const s0 = getState();
    const rawBefore = s0.islandPos + s0.islandZero;
    const origins0 = s0.nodes.map(n => n.origin);
    // The view's arithmetic (seek.js): the advance that lands 2.5Q.
    const frame = { rawClock: rawBefore, zero: s0.islandZero, loopSamples: 4 * Q };
    const delta = seekDelta(2.5 * Q, frame);
    const ok = await callNative('seekTransport', delta, rawBefore);
    assert.deepEqual(ok, { advance: delta, clock: rawBefore },
        'the backend answers what it applied, and when');
    const s = getState();
    near(s.masterPos, 2.5 * Q, 'published view reads the seek');
    near(s.islandPos + s.islandZero, rawBefore,
        'the monotonic clock itself never moved (kernel.md)');
    near(s.islandZero - s0.islandZero, -delta, 'the zero moved back by the advance');
    s.nodes.forEach((n, i) => near(n.origin - origins0[i], -delta,
        'every origin rode the zero (placement invariant)'));

    // Playback continues FROM the seek (phase, not a reset)
    advanceBy(Q);
    near(getState().masterPos, 3.5 * Q, 'advance rides the new phase');
});

test('the advance corrects for the clock since the poll (atClock)', async () => {
    loadScenario('example-1q-4q'); // cycle 4Q
    const s0 = getState();
    const raw0 = s0.islandPos + s0.islandZero;
    const frame = { rawClock: raw0, zero: s0.islandZero, loopSamples: 4 * Q };
    const delta = seekDelta(Q, frame);
    // The clock runs on between the poll and the seek…
    advanceBy(Q / 3);
    const applied = await callNative('seekTransport', delta, raw0);
    near(getState().masterPos, Q, '…and the phase still lands where the view meant');
    near(applied.advance, delta - Q / 3, 'the answer is the corrected advance');
    // Without atClock the advance is taken as of now.
    assert.ok(await callNative('seekTransport', Q));
    near(getState().masterPos, 2 * Q, 'a bare advance moves the phase from where it is');
});

test('any advance folds on the audible cycle; a zero advance is a no-op', async () => {
    loadScenario('example-1q-4q'); // cycle 4Q
    const p0 = getState().masterPos;
    assert.ok(await callNative('seekTransport', 5 * Q));
    near(getState().masterPos, (p0 + Q) % (4 * Q), '5Q advances one Q on a 4Q cycle');
    assert.ok(await callNative('seekTransport', -Q));
    near(getState().masterPos, p0, 'a negative advance moves back');
    const z = getState().islandZero;
    assert.deepEqual(await callNative('seekTransport', 0),
        { advance: 0, clock: getState().islandPos + z }, 'zero advance: answered');
    assert.equal(getState().islandZero, z, 'zero advance: nothing moves');
});

test('refused while a take is live or armed (engine rule)', async () => {
    loadScenario('empty');
    const stackId = await callNative('createNode', 'stack', '');
    const clip = await callNative('createNode', 'clip', stackId);
    await callNative('startRecordingInNode', clip);
    assert.equal(await callNative('seekTransport', Q), false,
        'live take: seek refused');
    advanceBy(Q);
    await callNative('stopRecordingInNode', clip);
    assert.ok(await callNative('seekTransport', 0),
        'take settled: seek allowed again');
});
