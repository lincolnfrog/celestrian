/**
 * Effect visualization geometry (fx_viz.js) — the pure parts.
 * The EQ curve must agree with the engine's RBJ biquads: same formulas,
 * same bands, so the drawn curve IS what the audio does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    eqResponseDb, logFreqs, echoTaps, reverbTailSeconds, holdSpectrum,
} from '../fx_viz.js';

test('eqResponseDb: flat gains → flat 0 dB curve', () => {
    const dbs = eqResponseDb(logFreqs(16), { low: 0, mid: 0, high: 0 });
    dbs.forEach(db => assert.ok(Math.abs(db) < 0.01, `flat, got ${db}`));
});

test('eqResponseDb: +12 low shelf lifts the lows, leaves the highs', () => {
    const freqs = [40, 6000, 15000];
    const dbs = eqResponseDb(freqs, { low: 12, mid: 0, high: 0 });
    assert.ok(dbs[0] > 10.5, `40 Hz boosted ~12 dB, got ${dbs[0]}`);
    assert.ok(Math.abs(dbs[1]) < 1.5, `6 kHz untouched, got ${dbs[1]}`);
    assert.ok(Math.abs(dbs[2]) < 1.0, `15 kHz untouched, got ${dbs[2]}`);
});

test('eqResponseDb: −12 mid peak notches 1 kHz symmetrically', () => {
    const dbs = eqResponseDb([1000], { low: 0, mid: -12, high: 0 });
    assert.ok(dbs[0] < -10.5, `1 kHz cut ~12 dB, got ${dbs[0]}`);
});

test('echoTaps: dry pulse then geometric repeats at k·time', () => {
    const taps = echoTaps({ time: 0.5, feedback: 0.5, mix: 0.8 });
    assert.deepEqual(taps[0], { t: 0, h: 1, dry: true });
    assert.equal(taps[1].t, 0.5);
    assert.equal(taps[1].h, 0.8);            // first repeat = mix
    assert.equal(taps[2].h, 0.4);            // then ×feedback
    assert.ok(taps.every(t => t.t <= 4), 'inside the horizon');
    assert.ok(taps[taps.length - 1].h >= 0.02, 'terminates below audibility');
});

test('echoTaps: zero mix → dry pulse only', () => {
    assert.equal(echoTaps({ time: 0.5, feedback: 0.5, mix: 0 }).length, 1);
});

test('holdSpectrum: rises fast, falls slowly — silence cannot drag it down', () => {
    // First observation seeds the mark outright
    let mark = holdSpectrum(null, [0.5, 0.2]);
    assert.deepEqual(mark, [0.5, 0.2]);

    // RISE: a new peak registers in a couple of polls (half the gap each)
    mark = holdSpectrum(mark, [1.0, 0.2]);
    assert.ok(Math.abs(mark[0] - 0.75) < 1e-9, `rise closes 50%, got ${mark[0]}`);
    mark = holdSpectrum(mark, [1.0, 0.2]);
    assert.ok(mark[0] > 0.87, `two polls near the peak, got ${mark[0]}`);

    // FALL — the motivating case: a SILENT stretch barely moves the
    // line. One second of silence (20 polls at fall 0.01) keeps >80%
    let held = [...mark];
    for (let i = 0; i < 20; i++) held = holdSpectrum(held, [0, 0]);
    assert.ok(held[0] > mark[0] * 0.8,
        `1s of silence keeps the shape, got ${held[0]} of ${mark[0]}`);
    // …while sustained silence does eventually relax it (~5s tau):
    // 100 polls ≈ 5s → down to ~1/e
    for (let i = 0; i < 80; i++) held = holdSpectrum(held, [0, 0]);
    assert.ok(held[0] < mark[0] * 0.45 && held[0] > mark[0] * 0.25,
        `5s tau decay, got ${held[0]} of ${mark[0]}`);

    // Null polls (scope closed) are identity; bin-count change reseeds
    assert.equal(holdSpectrum(held, null), held);
    assert.deepEqual(holdSpectrum(held, [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
});

test('reverbTailSeconds: grows with size, shrinks with damping', () => {
    const small = reverbTailSeconds({ size: 0.1, damp: 0.5 });
    const big = reverbTailSeconds({ size: 0.9, damp: 0.5 });
    const damped = reverbTailSeconds({ size: 0.9, damp: 1.0 });
    assert.ok(big > small, 'bigger room, longer tail');
    assert.ok(damped < big, 'more damping, shorter tail');
    assert.ok(small > 0, 'always positive');
});
