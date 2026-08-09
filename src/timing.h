#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iterator>
#include <limits>

#include "qtime.h"
#include "time_map.h"

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

// gcd/lcm moved to qtime.h (the foundation layer); still exposed in
// this namespace via the include above.

/**
 * One step of the composite-period fold shared by every LCM composition
 * site (StackNode::getIntrinsicDuration / getEffectivePeriod, their
 * snapshot twins in graph_snapshot.h, and the context-cycle fold):
 * 0 is the empty accumulator, non-positive contributions are skipped.
 * Centralized so the accumulate rule cannot drift between the node-side
 * and snapshot-side folds. (The Q5 one-shot EXCLUSION stays at each
 * call site — it is a property of the child, not of the fold.)
 */
inline int64_t foldPeriod(int64_t composite, int64_t next) {
  if (next <= 0) return composite;
  return composite == 0 ? next : lcm(composite, next);
}

/**
 * A Q subdivision boundary in samples, through THE rounding law
 * (qtime.h): toSamples(1/d · Q). Replaces the bare integer division
 * `quantum / d`, which silently floored when Q wasn't divisible —
 * capture and playback must round identically (Q12 / D-T4).
 */
inline int64_t subdivisionSamples(int64_t quantum, int denominator) {
  return toSamples(qtime(1, denominator), quantum);
}

// === The physical/musical boundary (Q12 / D-T3) ===
//
// PHYSICAL facts stay in samples: the monotonic clock t, the epoch (a
// clock timestamp), pre-record ring indices, buffer lengths, the
// calibration constant C, and the island exchange rate `q_samples`
// (samples per 1Q) itself. MUSICAL facts are QTime rationals of Q — a
// clip's origin as an OFFSET FROM THE EPOCH, its period, its window
// segments, arm targets, and Q subdivisions.
//
// The RT hot path stores the musical facts as sample atomics (owner
// ruling: QTime-on-node defers to the immutable-root step); the helpers
// below project those atomics onto the musical frame for the
// metadata/persistence boundary, so the UI and the save format are
// device-independent. THE RULE: no engine code converts musical↔samples
// except through toSamples / fromSamples / subdivisionSamples — never a
// bare `x / quantum`, which silently floors (the bug D-T4 closed).

/**
 * A clip's origin as a musical offset from the island epoch (D-T3).
 * `origin_samples` is stored ABSOLUTE (performance-clock frame); the
 * musical fact is (origin − epoch) / q_samples · Q. Exact by
 * construction (fromSamples never rounds). An unsnapped or
 * context-relative origin yields an ugly-but-exact rational (D-T5) —
 * that is correct, not a defect: QTime says where content BELONGS.
 */
inline QTime originQ(int64_t origin_samples, int64_t epoch_samples,
                     int64_t q_samples) {
  return fromSamples(origin_samples - epoch_samples, q_samples);
}

/** A period / duration as musical time (D-T3). */
inline QTime periodQ(int64_t duration_samples, int64_t q_samples) {
  return fromSamples(duration_samples, q_samples);
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
  if (recorded_length < subdivisionSamples(quantum, 2)) {
    for (int d : kSubdivisions) {
      int64_t sub = subdivisionSamples(quantum, d);
      if (sub > recorded_length && sub < next_b) next_b = sub;
    }
  }
  return next_b;
}

/**
 * The arm target (Q11 ruling): the next Q boundary at/after the
 * epoch-relative position `rel` (a position exactly ON a boundary is its
 * own target). Boundaries live on the CONTEXT loop's grid — the grid the
 * performer hears restarts at each context top, so when the context is
 * not a Q multiple (unsnapped takes) the boundary set is
 * context-cycle-relative, not global.
 *
 * Callers pass the HEARD (latency-compensated) position: a click
 * shortly before a boundary compensates back onto it, which is the
 * whole of the "pickup"/anticipatory behavior (E-A). A deferral window
 * that once existed on top of this was deleted 2026-07-16 — it added
 * nothing and overshot the take by a full Q when compensation was
 * small.
 */
inline int64_t armTarget(int64_t rel, int64_t quantum, int64_t context_loop) {
  if (rel < 0) rel = 0;
  if (quantum <= 0) return rel;
  if (context_loop <= 0) context_loop = quantum;

  if (context_loop == quantum) {
    // Single-clip context: the pure Q grid.
    if (rel % quantum == 0) return rel;
    return (rel / quantum + 1) * quantum;
  }

  // Multi-clip context: snap the position WITHIN the heard cycle
  // forward to its next Q mark, then re-base into the current cycle
  // iteration. A mark at/past the context top means "the top of the
  // NEXT cycle" — the heard grid restarts there, so an unsnapped
  // context's final partial Q arms at the top itself (folding it
  // `% context_loop` put the boundary in the PAST — latent bug fixed
  // with the through-window vectors, phase 2).
  const int64_t effective = rel % context_loop;
  const int64_t next_visual = (effective % quantum == 0)
                                  ? effective
                                  : (effective / quantum + 1) * quantum;
  const int64_t loop_base = (rel / context_loop) * context_loop;
  const int64_t offset =
      next_visual >= context_loop ? context_loop : next_visual;
  return loop_base + offset;
}

/**
 * Capture-fold for a take recorded THROUGH an active map (time_maps.md
 * §3): the buffer destination index for heard-elapsed sample `heard_i`
 * of a take anchored at heard offset `anchor_off` within the map
 * period. Content index 0 is the take's origin (= the anchor's inner
 * position); later samples land wherever the mapped clock names,
 * folded into the dense [0, commit_cycle) buffer — silence stays in
 * unvisited regions by construction. Segment-general: each map seam
 * jumps the destination; the single-segment window degenerates to one
 * seam at (period − anchor_off) with the tail landing at
 * [commit_cycle − anchor_off, commit_cycle).
 *
 * Precondition: 0 ≤ heard_i < map.period() (the one-period cap) and
 * map.period() ≤ commit_cycle.
 */
inline int64_t throughMapDest(int64_t heard_i, int64_t anchor_off,
                              const TimeMap& map, int64_t commit_cycle) {
  const int64_t origin_inner = map.mapOffset(anchor_off);
  const int64_t inner = map.mapOffset(anchor_off + heard_i);
  int64_t d = inner - origin_inner;
  if (commit_cycle > 0) d = ((d % commit_cycle) + commit_cycle) % commit_cycle;
  return d;
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
    int64_t sub = subdivisionSamples(Q, d);
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
  if (loop_end == 0) loop_end = subdivisionSamples(Q, 2);
  return {L, loop_end, false};
}

}  // namespace celestrian::timing
