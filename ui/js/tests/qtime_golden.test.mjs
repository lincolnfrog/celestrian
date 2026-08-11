/**
 * QTime Golden Vector + Property Test (JS side)
 *
 * Runs ui/js/qtime.js against the qtime_* sections of
 * shared/timing_golden.json — the same vectors tests/qtime_tests.cc runs
 * against src/qtime.h. If both suites pass, the JS and C++ rational-time
 * math (including THE rounding law) agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    qtime, qEq, qCmp, qAdd, qSub, qLcm, toSamples, fromSamples
} from '../qtime.js';
import { loadSharedJson, MOCK_Q } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

test('normalization invariants', () => {
    assert.ok(qEq(qtime(2, 4), { num: 1, den: 2 }), '2/4 -> 1/2');
    assert.ok(qEq(qtime(3, -6), { num: -1, den: 2 }), '3/-6 -> -1/2 (den > 0)');
    assert.ok(qEq(qtime(-3, -6), { num: 1, den: 2 }), '-3/-6 -> 1/2');
    assert.ok(qEq(qtime(0, 5), { num: 0, den: 1 }), '0/5 -> canonical zero');
    assert.ok(qEq(qtime(7, 0), { num: 0, den: 1 }), 'den 0 -> canonical zero (guard)');
});

test('golden: toSamples (THE rounding law)', () => {
    for (const c of golden.qtime_to_samples_cases) {
        assert.equal(toSamples(qtime(c.num, c.den), c.qSamples), c.expected, c.name);
    }
});

test('golden: fromSamples', () => {
    for (const c of golden.qtime_from_samples_cases) {
        const t = fromSamples(c.samples, c.qSamples);
        assert.equal(t.num, c.expectedNum, `${c.name} (num)`);
        assert.equal(t.den, c.expectedDen, `${c.name} (den)`);
    }
});

test('golden: qLcm', () => {
    for (const c of golden.qtime_lcm_cases) {
        const r = qLcm(qtime(c.aNum, c.aDen), qtime(c.bNum, c.bDen));
        assert.equal(r.num, c.expectedNum, `${c.name} (num)`);
        assert.equal(r.den, c.expectedDen, `${c.name} (den)`);
    }
});

test('golden: arithmetic', () => {
    for (const c of golden.qtime_arith_cases) {
        const a = qtime(c.aNum, c.aDen);
        const b = qtime(c.bNum, c.bDen);
        const r = c.op === 'add' ? qAdd(a, b) : qSub(a, b);
        assert.equal(r.num, c.expectedNum, `${c.name} (num)`);
        assert.equal(r.den, c.expectedDen, `${c.name} (den)`);
    }
});

test('round-trip toSamples(fromSamples(s)) === s exactly', () => {
    // A deliberate spread of rates INCLUDING the mock's own — the
    // rounding law must hold at every one, prime denominators included.
    for (const q of [...new Set([MOCK_Q, 44100, 44101, 48000, 96000, 12345])]) {
        for (let s = -3; s <= 3; ++s) {
            for (const b of [0, 1, Math.floor(q / 8), Math.floor(q / 3), q - 1, q, 7 * q + 13]) {
                const samples = b + s;
                assert.equal(toSamples(fromSamples(samples, q), q), samples,
                    `round trip s=${samples} q=${q}`);
            }
        }
    }
});

test('monotonicity of the rounding law', () => {
    const q = 44101;
    let prev = toSamples(qtime(-48, 24), q);
    for (let n = -47; n <= 96; ++n) {
        const cur = toSamples(qtime(n, 24), q);
        assert.ok(cur >= prev, `monotonicity broken at n=${n}: ${cur} < ${prev}`);
        prev = cur;
    }
});

test('tie rule — exact halves round toward +inf', () => {
    const q = MOCK_Q;
    for (const k of [0, 5, -6, Math.floor(q / 2) - 1]) {
        // (2k+1)/(2q) Q at rate q is exactly k + 0.5 samples.
        assert.equal(toSamples(qtime(2 * k + 1, 2 * q), q), k + 1,
            `tie at k=${k} rounds up`);
    }
});

test('qCmp is exact', () => {
    assert.ok(qCmp(qtime(1, 3), qtime(1, 2)) < 0, '1/3 < 1/2');
    assert.equal(qCmp(qtime(2, 4), qtime(1, 2)), 0, '2/4 == 1/2');
    assert.ok(qCmp(qtime(-1, 2), qtime(-2, 3)) > 0, '-1/2 > -2/3');
});
