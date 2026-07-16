#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>

/**
 * QTime — exact rational musical time in units of the island quantum Q.
 *
 * Ruling Q12 (design_language.md §5; decision record in
 * unification_audit.md §4): musical facts — origins as offsets from the
 * island epoch, periods, window segments, arm targets, Q subdivisions —
 * are exact rationals of Q. Physical facts — the monotonic clock, epoch
 * timestamps, ring indices, buffer lengths, the calibration constant —
 * stay in samples. The island owns the exchange rate `q_samples`
 * (samples per 1Q, established at first commit; a Q re-trim before lock
 * re-establishes it — Q13). Conversion between the two worlds happens
 * ONLY through toSamples()/fromSamples() below, so there is exactly one
 * rounding law in the system.
 *
 * The JS mirror is `ui/js/qtime.js`; both are pinned to the same golden
 * vectors in `shared/timing_golden.json` (tests/qtime_tests.cc and
 * ui/js/tests/qtime_golden.test.mjs).
 *
 * Like timing.h: free functions over PODs — no JUCE types, no side
 * effects, audio-thread safe.
 */
namespace celestrian::timing {

/**
 * value = (num / den) · Q.
 * Invariants (established by qtime()): den > 0, gcd(|num|, den) = 1,
 * and zero is canonically {0, 1}. Denominators stay tiny in practice
 * (Q subdivisions 2/4/8 today; 3/5 with tuplets), so int64 arithmetic
 * with __int128 intermediates never overflows in musical use.
 */
struct QTime {
  int64_t num = 0;
  int64_t den = 1;
};

// gcd/lcm live here (the foundation layer); timing.h includes this
// header and re-exposes them under the same namespace.
inline int64_t gcd(int64_t a, int64_t b) {
  while (b != 0) {
    int64_t t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** Least common multiple. Returns the larger value if either is zero. */
inline int64_t lcm(int64_t a, int64_t b) {
  if (a == 0 || b == 0) return std::max(a, b);
  return (a / gcd(a, b)) * b;
}

namespace detail {
/** Floor division for __int128 (C++ '/' truncates toward zero). */
inline int64_t floordiv128(__int128 a, __int128 b) {
  __int128 q = a / b;
  const __int128 r = a % b;
  if (r != 0 && ((r < 0) != (b < 0))) --q;
  return (int64_t)q;
}
}  // namespace detail

/** Normalizing constructor: den > 0, lowest terms, canonical zero. */
inline QTime qtime(int64_t num, int64_t den) {
  if (den == 0 || num == 0) return {0, 1};
  if (den < 0) {
    num = -num;
    den = -den;
  }
  const int64_t g = gcd(std::llabs(num), den);
  return {num / g, den / g};
}

inline bool qeq(QTime a, QTime b) {
  return a.num == b.num && a.den == b.den;  // both normalized
}

/** Three-way compare: −1, 0, +1 as a <, ==, > b. Exact (no division). */
inline int qcmp(QTime a, QTime b) {
  const __int128 lhs = (__int128)a.num * b.den;
  const __int128 rhs = (__int128)b.num * a.den;
  return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
}

inline QTime qadd(QTime a, QTime b) {
  return qtime(a.num * b.den + b.num * a.den, a.den * b.den);
}

inline QTime qsub(QTime a, QTime b) {
  return qtime(a.num * b.den - b.num * a.den, a.den * b.den);
}

inline QTime qmulInt(QTime a, int64_t k) { return qtime(a.num * k, a.den); }

/**
 * Rational LCM of two positive periods: the smallest positive r such
 * that r/a and r/b are both integers. For a/b, c/d in lowest terms:
 * lcm(a, c) / gcd(b, d). This is what composite (stack) periods use —
 * the integer LCM in timing.h is the q_samples projection of this.
 * Returns the other argument if either is zero (mirrors timing::lcm).
 */
inline QTime qlcm(QTime a, QTime b) {
  if (a.num == 0) return b;
  if (b.num == 0) return a;
  return qtime(lcm(a.num, b.num), gcd(a.den, b.den));
}

/**
 * THE rounding law (Q12 / D-T4): QTime → samples at the island's
 * exchange rate. Round to the nearest sample; exact halves round toward
 * +∞ — boundaries err later, never earlier, consistent with the
 * "stop always records forward" ruling. Implemented as
 * floor((2·num·q_samples + den) / (2·den)) with mathematical floor, so
 * the law holds for negative values too.
 *
 * Every musical→physical conversion in the engine MUST go through this
 * function: capture and playback rounding identically is what preserves
 * I1 across the conversion.
 */
inline int64_t toSamples(QTime t, int64_t q_samples) {
  if (q_samples <= 0) return 0;
  const __int128 n2 = (__int128)2 * t.num * q_samples + t.den;
  const __int128 d2 = (__int128)2 * t.den;
  return detail::floordiv128(n2, d2);
}

/**
 * samples → QTime, EXACT (samples/q_samples is representable by
 * construction): fromSamples never rounds, so
 * toSamples(fromSamples(s, Q), Q) == s for every integer s.
 */
inline QTime fromSamples(int64_t samples, int64_t q_samples) {
  if (q_samples <= 0) return {0, 1};
  return qtime(samples, q_samples);
}

}  // namespace celestrian::timing
