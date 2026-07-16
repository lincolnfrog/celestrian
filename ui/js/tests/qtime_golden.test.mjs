/**
 * QTime Golden Vector + Property Test (JS side)
 *
 * Runs ui/js/qtime.js against the qtime_* sections of
 * shared/timing_golden.json — the same vectors tests/qtime_tests.cc runs
 * against src/qtime.h. If both suites pass, the JS and C++ rational-time
 * math (including THE rounding law) agree.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    qtime, qEq, qCmp, qAdd, qSub, qLcm, toSamples, fromSamples
} from '../qtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/timing_golden.json'), 'utf8'));

let failures = 0;
function check(actual, expected, name) {
    if (actual !== expected) {
        failures++;
        console.error(`  FAIL: ${name} — expected ${expected}, got ${actual}`);
    }
}

console.log('QTime: normalization invariants');
{
    check(qEq(qtime(2, 4), { num: 1, den: 2 }), true, '2/4 -> 1/2');
    check(qEq(qtime(3, -6), { num: -1, den: 2 }), true, '3/-6 -> -1/2 (den > 0)');
    check(qEq(qtime(-3, -6), { num: 1, den: 2 }), true, '-3/-6 -> 1/2');
    check(qEq(qtime(0, 5), { num: 0, den: 1 }), true, '0/5 -> canonical zero');
    check(qEq(qtime(7, 0), { num: 0, den: 1 }), true, 'den 0 -> canonical zero (guard)');
}

console.log('Golden: toSamples (THE rounding law)');
for (const c of golden.qtime_to_samples_cases) {
    check(toSamples(qtime(c.num, c.den), c.qSamples), c.expected, c.name);
}

console.log('Golden: fromSamples');
for (const c of golden.qtime_from_samples_cases) {
    const t = fromSamples(c.samples, c.qSamples);
    check(t.num, c.expectedNum, `${c.name} (num)`);
    check(t.den, c.expectedDen, `${c.name} (den)`);
}

console.log('Golden: qLcm');
for (const c of golden.qtime_lcm_cases) {
    const r = qLcm(qtime(c.aNum, c.aDen), qtime(c.bNum, c.bDen));
    check(r.num, c.expectedNum, `${c.name} (num)`);
    check(r.den, c.expectedDen, `${c.name} (den)`);
}

console.log('Golden: arithmetic');
for (const c of golden.qtime_arith_cases) {
    const a = qtime(c.aNum, c.aDen);
    const b = qtime(c.bNum, c.bDen);
    const r = c.op === 'add' ? qAdd(a, b) : qSub(a, b);
    check(r.num, c.expectedNum, `${c.name} (num)`);
    check(r.den, c.expectedDen, `${c.name} (den)`);
}

console.log('QTime: round-trip toSamples(fromSamples(s)) === s exactly');
{
    for (const q of [44100, 44101, 48000, 96000, 12345]) {
        for (let s = -3; s <= 3; ++s) {
            for (const b of [0, 1, Math.floor(q / 8), Math.floor(q / 3), q - 1, q, 7 * q + 13]) {
                const samples = b + s;
                check(toSamples(fromSamples(samples, q), q), samples,
                    `round trip s=${samples} q=${q}`);
            }
        }
    }
}

console.log('QTime: monotonicity of the rounding law');
{
    const q = 44101;
    let prev = toSamples(qtime(-48, 24), q);
    for (let n = -47; n <= 96; ++n) {
        const cur = toSamples(qtime(n, 24), q);
        if (cur < prev) {
            failures++;
            console.error(`  FAIL: monotonicity broken at n=${n}: ${cur} < ${prev}`);
        }
        prev = cur;
    }
}

console.log('QTime: tie rule — exact halves round toward +inf');
{
    const q = 44100;
    for (const k of [0, 5, -6, 22049]) {
        // (2k+1)/(2q) Q at rate q is exactly k + 0.5 samples.
        check(toSamples(qtime(2 * k + 1, 2 * q), q), k + 1, `tie at k=${k} rounds up`);
    }
}

console.log('QTime: qCmp is exact');
{
    check(qCmp(qtime(1, 3), qtime(1, 2)) < 0, true, '1/3 < 1/2');
    check(qCmp(qtime(2, 4), qtime(1, 2)), 0, '2/4 == 1/2');
    check(qCmp(qtime(-1, 2), qtime(-2, 3)) > 0, true, '-1/2 > -2/3');
}

if (failures === 0) {
    console.log('PASS: all QTime vectors and properties match qtime.js');
} else {
    console.error(`FAIL: ${failures} QTime mismatch(es)`);
    process.exitCode = 1;
}
