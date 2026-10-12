/**
 * QTime — exact rational musical time in units of the island quantum Q.
 * The JS mirror of src/qtime.h (which carries the design notes: Q12,
 * design_language.md §5); both are pinned to shared/timing_golden.json
 * (ui/js/tests/qtime_golden.test.mjs, tests/qtime_tests.cc).
 *
 * Precision: every intermediate must stay below 2^53 —
 * |2·num·qSamples + den| in toSamples is the largest. Denominators are
 * tiny in musical use and num is bounded by the session length in Q;
 * floorDiv also corrects float rounding at integer boundaries.
 *
 * qEq, qCmp, qAdd, qSub and qLcm complete the mirror; only the golden
 * test calls them.
 */

import { gcd } from './math_utils.js';

/**
 * @typedef {{num: number, den: number}} QTime  (num/den)·Q. Invariants:
 *     den > 0, gcd(|num|, den) = 1, zero is {0, 1}.
 */

/**
 * Normalizing constructor: den > 0, lowest terms, canonical zero. TOTAL
 * like the C++ one: qtime(n, 0) is zero ("no musical value"), not an
 * error.
 *
 * @param {number} num  integer, any sign
 * @param {number} den  integer, any sign
 * @returns {QTime}
 */
export function qtime(num, den) {
    if (den === 0 || num === 0) return { num: 0, den: 1 };
    if (den < 0) { num = -num; den = -den; }
    const g = gcd(Math.abs(num), den);
    return { num: num / g, den: den / g };
}

/** Exact equality: every QTime is normalized, so comparing fields IS
 * comparing values. */
export function qEq(a, b) {
    return a.num === b.num && a.den === b.den;
}

/** Three-way compare: −1, 0, +1 as a <, ==, > b. */
export function qCmp(a, b) {
    const lhs = a.num * b.den;
    const rhs = b.num * a.den;
    return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
}

/** a + b, exact, in lowest terms. */
export function qAdd(a, b) {
    return qtime(a.num * b.den + b.num * a.den, a.den * b.den);
}

/** a − b, exact, in lowest terms. */
export function qSub(a, b) {
    return qtime(a.num * b.den - b.num * a.den, a.den * b.den);
}

/** Rational LCM of two positive periods:
 * lcm(a.num, b.num) / gcd(a.den, b.den). The other argument when either
 * is zero. */
export function qLcm(a, b) {
    if (a.num === 0) return b;
    if (b.num === 0) return a;
    const g = gcd(Math.abs(a.num), Math.abs(b.num));
    return qtime((a.num / g) * b.num, gcd(a.den, b.den));
}

/** Integer floor division, b > 0. Float division can land a hair on the
 * wrong side of an integer; the remainder check repairs it. */
function floorDiv(a, b) {
    let q = Math.floor(a / b);
    const r = a - q * b;
    if (r < 0) q -= 1;
    else if (r >= b) q += 1;
    return q;
}

/**
 * THE ROUNDING LAW (Q12, D-T4): QTime → samples at the island's exchange
 * rate. Nearest sample; exact halves round toward +∞:
 * floor((2·num·qSamples + den) / (2·den)), as in C++.
 */
export function toSamples(t, qSamples) {
    if (qSamples <= 0) return 0;
    return floorDiv(2 * t.num * qSamples + t.den, 2 * t.den);
}

/** samples → QTime, EXACT: toSamples(fromSamples(s, Q), Q) === s for
 * every integer s. */
export function fromSamples(samples, qSamples) {
    if (qSamples <= 0) return { num: 0, den: 1 };
    return qtime(samples, qSamples);
}
