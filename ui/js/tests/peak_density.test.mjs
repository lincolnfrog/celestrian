/**
 * Waveform PEAK DENSITY (navigation N7, 2026-09-22).
 *
 * (1) The request: app.js asks for peaks by the take's LENGTH
 *     (peak_density.js peakCountFor), not a flat 800 — a 56Q take got
 *     ~14 peaks per Q, so any zoom drew a blob.
 * (2) The buckets: peak i of n covers [⌊i·D/n⌋, ⌊(i+1)·D/n⌋) — the
 *     engine's ClipNode::peakBucket and its mock twin agree on the
 *     shared golden (`peak_bucket_cases`, also run by
 *     tests/timing_golden_tests.cc). The floor-divided window it
 *     replaced dropped the `D mod n` tail and slid every peak early.
 * (3) The mock's peaks max-pool its content over those buckets, so a
 *     denser request refines the same envelope: peak i of n is the max
 *     of peaks 2i and 2i+1 of 2n.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { peakCountFor, COMMITTED_PEAKS_PER_SECOND, MIN_PEAKS, MAX_PEAKS }
    from '../peak_density.js';
import { peakBucket, takePeaks } from '../mock/waveform.js';
import { callNative, loadScenario } from '../mock_backend.js';
import { loadSharedJson, recordTake } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

test('peakCountFor: 200 peaks per second of take, clamped [800, 32768]', () => {
    const sr = 44100;
    assert.equal(COMMITTED_PEAKS_PER_SECOND, 200);
    // A 56Q take at a 1.47 s Q (the field case): ~82 s → 16464 peaks,
    // ≈294 per Q instead of ≈14.
    const q = Math.round(1.47 * sr);
    const n56 = peakCountFor(56 * q, sr);
    assert.equal(n56, Math.round((56 * q / sr) * 200));
    assert.ok(n56 / 56 > 250, `≈300 peaks per Q (got ${n56 / 56})`);
    // Short takes keep the old floor; very long ones stop at the cap.
    assert.equal(peakCountFor(sr, sr), MIN_PEAKS, '1 s → the floor');
    assert.equal(peakCountFor(4 * sr, sr), 800, '4 s → exactly 800');
    assert.equal(peakCountFor(5 * sr, sr), 1000, '5 s → 1000');
    assert.equal(peakCountFor(3600 * sr, sr), MAX_PEAKS, 'an hour → the cap');
    // The rate matters: the same samples at 48 kHz are shorter.
    assert.equal(peakCountFor(48000 * 10, 48000), 2000);
    // Unknowns answer the floor, never NaN.
    for (const [d, r] of [[0, sr], [-5, sr], [sr * 10, 0], [undefined, sr], [sr, NaN]]) {
        assert.equal(peakCountFor(d, r), MIN_PEAKS, `(${d}, ${r}) → floor`);
    }
});

test('golden: peakBucket (engine ClipNode::peakBucket)', () => {
    for (const c of golden.peak_bucket_cases) {
        for (const [i, start, end] of c.buckets) {
            assert.deepEqual(peakBucket(i, c.total, c.n), { start, end },
                `bucket ${i} of ${c.n} over ${c.total}`);
        }
    }
});

test('peakBucket: gap-free, the last bucket reaches the end, no drift', () => {
    for (const [total, n] of [[1000, 300], [3600000, 16384], [44100 * 82, 16464], [7, 3]]) {
        let prev = 0;
        for (let i = 0; i < n; i++) {
            const { start, end } = peakBucket(i, total, n);
            assert.equal(start, prev, `bucket ${i} starts where ${i - 1} ended`);
            assert.ok(end > start, 'never empty');
            // No drift: bucket i sits at i/n of the take, within a sample.
            assert.ok(Math.abs(start - (i * total) / n) < 1, `bucket ${i} on its place`);
            prev = end;
        }
        assert.equal(prev, total, `${n} buckets cover all ${total} samples`);
    }
    // n > total: one sample each, never past the take.
    for (let i = 0; i < 8; i++) {
        const { start, end } = peakBucket(i, 3, 8);
        assert.equal(end - start, 1);
        assert.ok(end <= 3);
    }
});

test('mock peaks: a denser request refines the same max-pooled envelope', () => {
    const node = { type: 'clip', duration: 123457, takes: [{ seed: 0.7 }] };
    const coarse = takePeaks(node, 0, 800);
    const fine = takePeaks(node, 0, 1600);
    assert.equal(coarse.length, 800);
    assert.equal(fine.length, 1600);
    for (let i = 0; i < 800; i++) {
        assert.ok(Math.abs(coarse[i] - Math.max(fine[2 * i], fine[2 * i + 1])) < 1e-12,
            `peak ${i} of 800 = max(peaks ${2 * i}, ${2 * i + 1} of 1600)`);
    }
    // The last peak covers the take's end: the envelope at the final sample.
    const total = node.duration;
    const last = 0.5 + 0.4 * Math.sin(((total - 1) / total) * Math.PI * 4 + 0.7);
    assert.ok(coarse[799] >= last - 1e-12, 'the tail is in the last bucket');
    // Every value is a real envelope value (the swell stays in [0.1, 0.9]).
    assert.ok(fine.every(v => v >= 0.1 - 1e-12 && v <= 0.9 + 1e-12));
});

test('mock getWaveform / getTakeWaveform answer the requested density', async () => {
    loadScenario('empty');
    const id = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    for (const n of [800, 2000, 32768]) {
        assert.equal((await callNative('getWaveform', id, n)).length, n);
        assert.equal((await callNative('getTakeWaveform', id, 0, n)).length, n);
    }
    assert.deepEqual(await callNative('getWaveform', id, 1000),
        await callNative('getTakeWaveform', id, 0, 1000), 'the active take');
});
