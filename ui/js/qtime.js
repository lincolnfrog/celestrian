/**
 * QTime — exact rational musical time in units of the island quantum Q
 * (JS side).
 *
 * Mirrors `src/qtime.h`; both are pinned to the same golden vectors in
 * `shared/timing_golden.json` (ui/js/tests/qtime_golden.test.mjs and
 * tests/qtime_tests.cc). See the C++ header for the full design notes
 * (ruling Q12, design_language.md §5).
 *
 * value = { num, den } meaning (num/den)·Q. Invariants: den > 0,
 * gcd(|num|, den) = 1, zero is canonically {0, 1}.
 *
 * Precision bound: all intermediates must stay below 2^53
 * (|2·num·qSamples + den| in toSamples is the largest). Denominators
 * are tiny in musical use (2/4/8, later 3/5) and num is bounded by the
 * session length in Q, so this holds by miles; floorDiv() additionally
 * self-corrects float rounding at integer boundaries.
 */

import { gcd } from './math_utils.js';

/**
 * Normalizing constructor: den > 0, lowest terms, canonical zero.
 * qtime(n, 0) returns the ZERO rational rather than throwing — a
 * degenerate denominator is treated as "no musical value", matching the
 * C++ side's total (never-throwing) constructor.
 *
 * @param {number} num  integer numerator (any sign)
 * @param {number} den  integer denominator (any sign; 0 → canonical zero)
 * @returns {{num: number, den: number}}  (num/den)·Q in lowest terms
 */
export function qtime(num, den) {
    if (den === 0 || num === 0) return { num: 0, den: 1 };
    if (den < 0) { num = -num; den = -den; }
    const g = gcd(Math.abs(num), den);
    return { num: num / g, den: den / g };
}

/**
 * Exact equality. Sound because every QTime is normalized at
 * construction — comparing fields IS comparing values.
 *
 * @param {{num: number, den: number}} a
 * @param {{num: number, den: number}} b
 * @returns {boolean}
 */
export function qEq(a, b) {
    return a.num === b.num && a.den === b.den; // both normalized
}

/** Three-way compare: −1, 0, +1 as a <, ==, > b. */
export function qCmp(a, b) {
    const lhs = a.num * b.den;
    const rhs = b.num * a.den;
    return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
}

/**
 * Exact rational sum, renormalized.
 *
 * @param {{num: number, den: number}} a
 * @param {{num: number, den: number}} b
 * @returns {{num: number, den: number}}  a + b in lowest terms
 */
export function qAdd(a, b) {
    return qtime(a.num * b.den + b.num * a.den, a.den * b.den);
}

/**
 * Exact rational difference, renormalized.
 *
 * @param {{num: number, den: number}} a
 * @param {{num: number, den: number}} b
 * @returns {{num: number, den: number}}  a − b in lowest terms
 */
export function qSub(a, b) {
    return qtime(a.num * b.den - b.num * a.den, a.den * b.den);
}

/**
 * Scale by an integer (k repetitions of a musical span). Currently
 * unimported on the JS side but KEPT deliberately: this module mirrors
 * the src/qtime.h API surface one-to-one, and the C++ side uses it.
 *
 * @param {{num: number, den: number}} a
 * @param {number} k  integer factor
 * @returns {{num: number, den: number}}  a · k in lowest terms
 */
export function qMulInt(a, k) { return qtime(a.num * k, a.den); }

/**
 * Rational LCM of two positive periods (lowest terms):
 * lcm(a.num, b.num) / gcd(a.den, b.den). Returns the other argument if
 * either is zero (mirrors timing::lcm / qlcm).
 */
export function qLcm(a, b) {
    if (a.num === 0) return b;
    if (b.num === 0) return a;
    const g = gcd(Math.abs(a.num), Math.abs(b.num));
    return qtime((a.num / g) * b.num, gcd(a.den, b.den));
}

/**
 * Integer floor division with self-correction: float division can land
 * a hair on the wrong side of an integer; the remainder check repairs
 * it. b must be > 0 (true for all callers here).
 */
function floorDiv(a, b) {
    let q = Math.floor(a / b);
    const r = a - q * b;
    if (r < 0) q -= 1;
    else if (r >= b) q += 1;
    return q;
}

/**
 * THE rounding law (Q12 / D-T4): QTime → samples at the island's
 * exchange rate. Nearest sample; exact halves round toward +∞.
 * floor((2·num·qSamples + den) / (2·den)) — identical to the C++ side.
 */
export function toSamples(t, qSamples) {
    if (qSamples <= 0) return 0;
    return floorDiv(2 * t.num * qSamples + t.den, 2 * t.den);
}

/**
 * samples → QTime, EXACT: toSamples(fromSamples(s, Q), Q) === s for
 * every integer s.
 */
export function fromSamples(samples, qSamples) {
    if (qSamples <= 0) return { num: 0, den: 1 };
    return qtime(samples, qSamples);
}
