/**
 * Live-peaks drift test (field report 2026-07-10: "the waveform kind of
 * migrates from left to right as I record").
 *
 * The invariant: a peak's position in the array is a pure function of
 * WHEN it happened (duration at capture), never of how many polls the
 * UI managed to run. We simulate a loud transient at a fixed moment and
 * poll the rest with heavy jitter — its relative position must be
 * identical under any poll cadence (per-poll pushing fails this: every
 * missed poll shifts all content).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { appendLivePeak, liveBoost, PEAKS_PER_SECOND } from '../live_peaks.js';
import { makeLcg } from './helpers.mjs';

const SR = 48000;

/** Simulate a recording session; pollTimes = durations (s) polled at. */
function simulate(pollTimes, transientAt) {
    const arr = [];
    for (const t of pollTimes) {
        const loud = Math.abs(t - transientAt) < 0.026; // the marker hit
        appendLivePeak(arr, t * SR, SR, loud ? 1.0 : 0.1);
    }
    return arr;
}

function markerPosition(arr) {
    let max = 0, idx = -1;
    arr.forEach((v, i) => { if (v > max) { max = v; idx = i; } });
    return idx; // absolute slot of the transient
}

test('a transient stays put under any poll cadence (no drift)', () => {
    const transientAt = 1.0; // seconds into the take; take runs 4s
    const steady = [];
    for (let t = 0.02; t <= 4; t += 0.05) steady.push(+t.toFixed(3));

    // Jittery: same 4s of audio, but 60% of polls dropped and irregular
    const rnd = makeLcg(42);
    const jittery = steady.filter((t, i) =>
        Math.abs(t - transientAt) < 0.026 || rnd() > 0.6);

    const a = simulate(steady, transientAt);
    const b = simulate(jittery, transientAt);

    // Array length is proportional to the LAST POLLED TIME, not to how
    // many polls ran (per-poll pushing gives length ∝ poll count)
    const lenFor = polls => Math.floor(polls[polls.length - 1] * PEAKS_PER_SECOND) + 1;
    assert.equal(a.length, lenFor(steady), `steady len ${a.length}`);
    assert.equal(b.length, lenFor(jittery), `jittery len ${b.length}`);

    // The transient sits at the same ABSOLUTE index in both runs — its
    // time slot — regardless of cadence. Under per-poll pushing the
    // jittery run's marker lands at a completely different index.
    const ia = markerPosition(a);
    const ib = markerPosition(b);
    assert.equal(ia, ib, `drift: index ${ia} vs ${ib}`);
    assert.ok(Math.abs(ia - transientAt * PEAKS_PER_SECOND) <= 2,
        `marker at slot ${ia}, expected ≈${transientAt * PEAKS_PER_SECOND}`);
});

test('liveBoost ratchets down smoothly and CONVERGES to the committed boost', () => {
    // A take that gets louder over time: the running max only rises, so
    // the boost target only falls — no oscillation possible
    let boost;
    const peaks = [0.1];
    const seen = [];
    for (let i = 0; i < 60; i++) {
        if (i === 10) peaks.push(0.4);   // louder section arrives
        if (i === 30) peaks.push(0.8);   // loudest hit
        boost = liveBoost(boost, peaks);
        seen.push(boost);
    }
    // Monotone non-increasing after each new max (never pumps back up)
    for (let i = 1; i < seen.length; i++) {
        assert.ok(seen[i] <= seen[i - 1] + 1e-12, `pump at ${i}`);
    }
    // Converges to the committed renderer's boost: 0.95 / max
    assert.ok(Math.abs(boost - 0.95 / 0.8) < 0.01,
        `boost ${boost} vs committed ${0.95 / 0.8}`);
    // Quiet takes cap at 8× (matching the committed cap)
    assert.equal(liveBoost(undefined, [0.001]), 8);
});

test('same-index polls max-pool; gaps sustain the PREVIOUS value', () => {
    const arr = [];
    appendLivePeak(arr, 0, SR, 0.3);
    appendLivePeak(arr, 0.001 * SR, SR, 0.9); // same 20ms slot: keep the max
    assert.equal(arr[0], 0.9);
    appendLivePeak(arr, 0.2 * SR, SR, 0.5);   // 10 slots later
    assert.equal(arr.length, Math.floor(0.2 * PEAKS_PER_SECOND) + 1);
    // Gap slots sustain 0.9 (a new transient must not smear backwards);
    // the new value lands exactly at its own time slot
    assert.ok(arr.slice(1, -1).every(v => v === 0.9));
    assert.equal(arr[arr.length - 1], 0.5);
});
