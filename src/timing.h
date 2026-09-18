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

// gcd/lcm live in qtime.h (the foundation layer), exposed in this
// namespace via the include above.

/**
 * THE RENDER EQUATION (composition.md §2, kernel.md §2), stated ONCE
 * for every node on either thread. For a node with origin O, effective
 * map m (its active map, else the whole inner span [0, D)), shot
 * S = m.period() (the span that sounds) and a0 = m.mapOffset(0):
 *
 *   h(t)     = (t − O − a0) mod F          the heard phase
 *   inner(t) = m.mapOffset(h)   (h < S)     the inner position that sounds
 *   rest     = h >= S                       the one-shot rest (nothing sounds)
 *
 * where F, the FOLD, is S for a looping node and the CONTEXT CYCLE for
 * a one-shot (Q5: the node sounds its shot once per scope cycle and
 * rests for the remainder). A clip reads content[base + inner(t)]; a
 * stack hands its children the clock O + inner(t). `run` is how many
 * samples from t the answer advances continuously (to the next map
 * seam, the end of the shot, or the end of the rest) — the block
 * splitter every consumer uses.
 *
 * Consumers: ClipNode render + renderMidi (via forEachContentRun) and
 * their playhead writes, StackNode::childContext / inRest /
 * forEachSeamRun / innerOf, heard::ownInner (the message-thread twin).
 * JS twin: ui/js/time_map.js innerAt. Golden: `inner_at_cases`.
 */
struct InnerAt {
  int64_t h = 0;      // heard phase in [0, fold)
  int64_t inner = 0;  // m.mapOffset(h) while sounding; h itself in the rest
  int64_t run = 1;    // continuity from t: seam / shot end / rest end
  bool rest = false;  // one-shot rest region (h >= shot)
};

/** @param map   the EFFECTIVE map — must be active (period > 0).
 *  @param fold  the phase modulus; anything below the shot reads as
 *               the shot (a looping node, or a context no longer than
 *               the content, is the plain loop equation). */
inline InnerAt innerAt(int64_t t, int64_t origin, const TimeMap& map,
                       int64_t fold) {
  InnerAt r;
  const int64_t shot = map.period();
  if (shot <= 0) return r;  // no content: the caller guards; stay total
  if (fold < shot) fold = shot;
  r.h = posMod(t - origin - map.mapOffset(0), fold);
  if (r.h >= shot) {
    r.rest = true;
    r.inner = r.h;  // nothing sounds; the child clock runs on linearly
    r.run = fold - r.h;
    return r;
  }
  r.inner = map.mapOffset(r.h);
  r.run = map.seamDistance(r.h);  // ≤ shot − h by construction
  if (r.run <= 0) r.run = 1;
  return r;
}

/**
 * THE CONTENT RUN SPLITTER: walk the block [t, t + n) as contiguous
 * content reads under the render equation. `body(i, run, at)` is
 * called per run with the block offset `i`, the run length and the
 * InnerAt at the run's first sample; a run never crosses a map seam,
 * the shot end, the rest end, or — with `cell_len > 0` (the comp,
 * docs/takes.md) — a Q-cell boundary of the inner position, so every
 * run reads ONE buffer. Bounded and allocation-free (the audio-thread
 * clip loops, audio and MIDI, are the two callers).
 */
template <typename Body>
inline void forEachContentRun(int64_t t, int n, int64_t origin,
                              const TimeMap& map, int64_t fold,
                              int64_t cell_len, Body&& body) {
  int i = 0;
  while (i < n) {
    const InnerAt at = innerAt(t + i, origin, map, fold);
    int64_t run = std::min<int64_t>(n - i, at.run);
    if (!at.rest && cell_len > 0) {
      const int64_t cell = at.inner / cell_len;
      run = std::min<int64_t>(run, (cell + 1) * cell_len - at.inner);
    }
    if (run <= 0) run = 1;
    body(i, (int)run, at);
    i += (int)run;
  }
}

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
 * (qtime.h): toSamples(1/d · Q). Never a bare `quantum / d`, which
 * silently floors when Q isn't divisible — capture and playback must
 * round identically (Q12).
 */
inline int64_t subdivisionSamples(int64_t quantum, int denominator) {
  return toSamples(qtime(1, denominator), quantum);
}

// === The physical/musical boundary (Q12) ===
//
// PHYSICAL facts stay in samples: the monotonic clock t, the zero (a
// clock timestamp), pre-record ring indices, buffer lengths, the
// calibration constant C, and the island exchange rate `q_samples`
// (samples per 1Q) itself. MUSICAL facts are QTime rationals of Q — a
// clip's origin as an OFFSET FROM THE ZERO, its period, its window
// segments, arm targets, and Q subdivisions.
//
// The RT hot path stores the musical facts as sample atomics; the
// helpers below project those atomics onto the musical frame for the
// metadata/persistence boundary, so the UI and the save format are
// device-independent. THE RULE: no engine code converts musical↔samples
// except through toSamples / fromSamples / subdivisionSamples — never a
// bare `x / quantum`, which silently floors.

/**
 * A clip's origin as a musical offset from the island zero.
 * `origin_samples` is stored ABSOLUTE (performance-clock frame); the
 * musical fact is (origin − zero) / q_samples · Q. Exact by
 * construction (fromSamples never rounds). An unsnapped or
 * context-relative origin yields an ugly-but-exact rational — that is
 * correct, not a defect: QTime says where content BELONGS.
 */
inline QTime originQ(int64_t origin_samples, int64_t zero_samples,
                     int64_t q_samples) {
  return fromSamples(origin_samples - zero_samples, q_samples);
}

/** A period / duration as musical time. */
inline QTime periodQ(int64_t duration_samples, int64_t q_samples) {
  return fromSamples(duration_samples, q_samples);
}

/**
 * Where playback starts within a clip so that a clip whose origin sits
 * `origin` samples into the frame plays its first recorded sample at
 * that moment (kernel.md: origin is THE timing fact; the launch point
 * is a projection of it). duration=8Q, origin=2Q -> launch=6Q.
 */
inline int64_t launchPointFor(int64_t origin, int64_t duration) {
  if (duration <= 0) return 0;
  return (duration - (origin % duration)) % duration;
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
 * zero-relative position `rel` (a position exactly ON a boundary is its
 * own target). Boundaries live on the CONTEXT loop's grid — the grid the
 * performer hears restarts at each context top, so when the context is
 * not a Q multiple (unsnapped takes) the boundary set is
 * context-cycle-relative, not global.
 *
 * Callers pass the HEARD (latency-compensated) position: a click
 * shortly before a boundary compensates back onto it, which is the
 * whole of the "pickup"/anticipatory behavior (E-A). No deferral
 * window sits on top of this: one overshoots the take by a full Q when
 * compensation is small.
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
  // `% context_loop` would put the boundary in the PAST; pinned by the
  // through-window golden vectors).
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
  d = posMod(d, commit_cycle);
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
