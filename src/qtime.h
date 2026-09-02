#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <limits>

#if !defined(__SIZEOF_INT128__)
#include <intrin.h>  // MSVC: _umul128 / _div128 for the Int128 fallback below
#endif

/**
 * QTime — exact rational musical time in units of the island quantum Q.
 *
 * Q12 (design_language.md §5): musical facts — origins as offsets from the
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

// ---------------------------------------------------------------------------
// Portable 128-bit signed intermediate.
//
// The rational-time math below needs a wider-than-64-bit intermediate for a
// handful of overflow-safe operations (cross-multiply compares in qcmp; the
// 2·num·q_samples product and floor-division in toSamples). Clang and GCC
// provide native __int128; MSVC does not, so we supply a minimal fallback
// backed by MSVC's 128-bit intrinsics. int128_t is the alias used everywhere
// below, so the two paths are otherwise identical.
// ---------------------------------------------------------------------------
#if defined(__SIZEOF_INT128__)
using int128_t = __int128;  // GCC/Clang: native, zero-cost
#else
namespace detail {
// Two's-complement signed 128-bit. Only the operations qtime.h actually uses
// are implemented. Division assumes the divisor fits in int64 (true for every
// call site here: divisors are 2·den with den a small positive int64).
struct Int128 {
  uint64_t lo = 0;
  int64_t hi = 0;

  Int128() = default;
  Int128(int64_t v) : lo(static_cast<uint64_t>(v)), hi(v < 0 ? -1 : 0) {}
  Int128(int64_t high, uint64_t low) : lo(low), hi(high) {}

  explicit operator int64_t() const { return static_cast<int64_t>(lo); }
};

inline bool operator<(Int128 a, Int128 b) {
  return a.hi != b.hi ? a.hi < b.hi : a.lo < b.lo;
}
inline bool operator>(Int128 a, Int128 b) { return b < a; }
inline bool operator!=(Int128 a, Int128 b) {
  return a.hi != b.hi || a.lo != b.lo;
}
inline bool operator==(Int128 a, Int128 b) { return !(a != b); }

inline Int128 operator+(Int128 a, Int128 b) {
  const uint64_t lo = a.lo + b.lo;
  const int64_t hi = a.hi + b.hi + (lo < a.lo ? 1 : 0);  // carry
  return Int128(hi, lo);
}

inline Int128 operator-(Int128 a, Int128 b) {
  const uint64_t lo = a.lo - b.lo;
  const int64_t hi = a.hi - b.hi - (a.lo < b.lo ? 1 : 0);  // borrow
  return Int128(hi, lo);
}

// Low 128 bits of the product. Computing modulo 2^128 on the two's-complement
// representations yields the correct signed result.
inline Int128 operator*(Int128 a, Int128 b) {
  uint64_t hh;
  const uint64_t lo = _umul128(a.lo, b.lo, &hh);
  const uint64_t hi = hh + a.lo * static_cast<uint64_t>(b.hi) +
                      static_cast<uint64_t>(a.hi) * b.lo;
  return Int128(static_cast<int64_t>(hi), lo);
}

// Signed 128/64 division (divisor fits int64; quotient fits int64 at all call
// sites). Truncates toward zero, matching native __int128 '/' and '%'.
inline Int128 operator/(Int128 a, Int128 b) {
  int64_t remainder;
  const int64_t q = _div128(a.hi, static_cast<int64_t>(a.lo),
                            static_cast<int64_t>(b.lo), &remainder);
  return Int128(q);
}

inline Int128 operator%(Int128 a, Int128 b) {
  int64_t remainder;
  _div128(a.hi, static_cast<int64_t>(a.lo), static_cast<int64_t>(b.lo),
          &remainder);
  return Int128(remainder);
}
}  // namespace detail
using int128_t = detail::Int128;  // MSVC fallback
#endif

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

/** Least common multiple. Returns the larger value if either is zero.
 * Saturates at int64 max instead of overflowing: composite-duration
 * folds treat 0 as "empty accumulator", so a wrapped-to-0 (or negative)
 * LCM would silently discard every prior child; several coprime
 * unsnapped takes can push the true LCM past 2^63. */
inline int64_t lcm(int64_t a, int64_t b) {
  if (a == 0 || b == 0) return std::max(a, b);
  const int128_t wide = int128_t(a / gcd(a, b)) * int128_t(b);
  if (wide > int128_t(std::numeric_limits<int64_t>::max())) {
    return std::numeric_limits<int64_t>::max();
  }
  return (int64_t)wide;
}

namespace detail {
/** Floor division for int128_t (C++ '/' truncates toward zero). */
inline int64_t floordiv128(int128_t a, int128_t b) {
  int128_t q = a / b;
  const int128_t r = a % b;
  if (r != 0 && ((r < 0) != (b < 0))) q = q - int128_t(1);
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
  const int128_t lhs = (int128_t)a.num * b.den;
  const int128_t rhs = (int128_t)b.num * a.den;
  return lhs < rhs ? -1 : (lhs > rhs ? 1 : 0);
}

inline QTime qadd(QTime a, QTime b) {
  return qtime(a.num * b.den + b.num * a.den, a.den * b.den);
}

inline QTime qsub(QTime a, QTime b) {
  return qtime(a.num * b.den - b.num * a.den, a.den * b.den);
}

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
 * THE rounding law (Q12): QTime → samples at the island's
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
  const int128_t n2 = (int128_t)2 * t.num * q_samples + t.den;
  const int128_t d2 = (int128_t)2 * t.den;
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
