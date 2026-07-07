#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iterator>
#include <limits>

/**
 * Pure timing math for the Celestrian engine.
 *
 * This is the C++ half of the "single source of truth" for timing semantics.
 * The JS mirror is `ui/js/timeline_model.js`; both are pinned to the same
 * golden vectors in `shared/timing_golden.json` (see
 * tests/timing_golden_tests.cc and ui/js/tests/timeline_model_golden.test.mjs).
 *
 * Everything here is a free function over sample counts — no JUCE types, no
 * graph access, no side effects — so it is trivially unit-testable and safe
 * to call from the audio thread.
 */
namespace celestrian::timing {

/** Tolerance (fraction of Q) for snapping a committed duration to a clean
 * boundary. See docs/recording.md "Hysteresis-Based Snapping". */
constexpr double kHysteresisThreshold = 0.15;

/** Subdivisions of Q considered when committing/stopping short recordings. */
constexpr int kSubdivisions[] = {2, 4, 8};

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

/**
 * Where playback starts within a clip so that when the context phase equals
 * the recording start phase, the clip plays its first recorded sample.
 * docs/recording.md Example 2: duration=8Q, startPhase=2Q -> launch=6Q.
 */
inline int64_t launchPointFor(int64_t start_phase, int64_t duration) {
  if (duration <= 0) return 0;
  return (duration - (start_phase % duration)) % duration;
}

/**
 * Normalized playhead position (0..1) for a clip, given the master transport
 * position and the clip's launch offset.
 */
inline double playheadPercent(int64_t master_pos, int64_t launch_point,
                              int64_t duration) {
  if (duration <= 0) return 0.0;
  return (double)((master_pos + launch_point) % duration) / (double)duration;
}

/**
 * The boundary at which a stop request is honored: the next clean multiple of
 * Q, or — for short recordings (L < Q/2) — the smallest subdivision of Q that
 * is still ahead of the recorded length.
 */
inline int64_t nextStopBoundary(int64_t recorded_length, int64_t quantum) {
  int64_t next_b = ((recorded_length / quantum) + 1) * quantum;
  if (recorded_length < quantum / 2) {
    for (int d : kSubdivisions) {
      int64_t sub = quantum / d;
      if (sub > recorded_length && sub < next_b) next_b = sub;
    }
  }
  return next_b;
}

struct SnapResult {
  int64_t duration;  // Final committed duration (samples)
  int64_t loop_end;  // Loop region end (loop start is always 0 at commit)
  bool snapped;      // True if duration snapped to a clean boundary
};

/**
 * Hysteresis snap applied when a recording commits.
 *
 * Candidates are the floor/ceil multiples of Q plus the Q/2, Q/4, Q/8
 * subdivisions. If the closest candidate is within kHysteresisThreshold * Q,
 * the duration snaps to it. Otherwise the raw duration is kept and the loop
 * region is set to the previous clean multiple (or Q/2 if that would be 0).
 */
inline SnapResult snapCommittedDuration(int64_t recorded_length,
                                        int64_t quantum) {
  const int64_t L = recorded_length;
  const int64_t Q = quantum;
  if (Q <= 0) return {L, L, false};

  const int64_t floor_multiple = (L / Q) * Q;
  int64_t candidates[2 + std::size(kSubdivisions)] = {floor_multiple,
                                                      floor_multiple + Q};
  int num_candidates = 2;
  for (int d : kSubdivisions) {
    int64_t sub = Q / d;
    if (sub > 0) candidates[num_candidates++] = sub;
  }

  int64_t best = -1;
  int64_t min_diff = std::numeric_limits<int64_t>::max();
  for (int i = 0; i < num_candidates; ++i) {
    const int64_t b = candidates[i];
    if (b <= 0) continue;
    const int64_t diff = std::abs(L - b);
    if (diff < min_diff) {
      min_diff = diff;
      best = b;
    }
  }

  if (best != -1 && min_diff < (int64_t)(kHysteresisThreshold * (double)Q)) {
    return {best, best, true};
  }

  int64_t loop_end = (L / Q) * Q;
  if (loop_end == 0) loop_end = Q / 2;
  return {L, loop_end, false};
}

}  // namespace celestrian::timing
