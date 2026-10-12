#pragma once

#include <cstdint>
#include <limits>

#include "qtime.h"

/**
 * The reified time-map (time_maps.md §2) — ONE implementation shared by
 * clips and stacks.
 *
 * A map is an ordered list of segments over a node's inner timeline,
 * anchored at the node's origin O (timing::innerAt, timing.h):
 *
 *   inner(t) = walk_segments((t − O − a0) mod fold),  a0 = mapOffset(0)
 *
 * Segments select INNER positions (offsets from O); the caller re-bases
 * the answer into absolute time by adding O (see the one-frame warning
 * in time_maps.md §2). A loop window is the single-segment case and a
 * cell/punch map the multi-segment one — both the same stored value
 * (AudioNode::storedMap / activeTimeMap). Every consumer of this type
 * is segment-general.
 *
 * Pure POD value math: no JUCE, no allocation, trivially copyable —
 * safe to carry by value in ProcessContext and to call on the audio
 * thread. The JS mirror is ui/js/time_map.js; both are pinned to the
 * `time_map_cases` golden vectors in shared/timing_golden.json.
 */
namespace celestrian::timing {

struct TimeMap {
  static constexpr int kMaxSegments = 8;

  /** Inner-time range [start, end) in samples. */
  struct Segment {
    int64_t start = 0;
    int64_t end = 0;
  };

  int n = 0;  // 0 = no active map (none/bypassed live on the node)
  Segment segs[kMaxSegments] = {};

  static TimeMap none() { return {}; }

  /** A loop window: one segment, empty when invalid. */
  static TimeMap single(int64_t start, int64_t end) {
    TimeMap m;
    if (end > start) {
      m.n = 1;
      m.segs[0] = {start, end};
    }
    return m;
  }

  bool active() const { return n > 0; }

  /** Heard-time length of one map pass: Σ (end − start). */
  int64_t period() const {
    int64_t p = 0;
    for (int i = 0; i < n; ++i) p += segs[i].end - segs[i].start;
    return p;
  }

  /**
   * walk_segments: a HEARD offset (any integer — folded mod period,
   * negatives included) → the inner-time offset it selects, relative to
   * the same frame the segments are expressed in. The caller re-bases
   * into absolute time by adding the node's origin.
   */
  int64_t mapOffset(int64_t heard_off) const {
    const int64_t p = period();
    if (p <= 0) return heard_off;
    heard_off = posMod(heard_off, p);
    for (int i = 0; i < n; ++i) {
      const int64_t len = segs[i].end - segs[i].start;
      if (heard_off < len) return segs[i].start + heard_off;
      heard_off -= len;
    }
    return segs[0].start;  // unreachable: heard_off < p by construction
  }

  /**
   * Inverse of mapOffset: the heard offset (within [0, period)) at
   * which the map visits inner position `inner`, or −1 when `inner`
   * lies outside every segment (unvisited). Each inner position is
   * visited at most once per pass (segments are disjoint), so the
   * inverse is well-defined where it exists.
   */
  int64_t heardOffsetOf(int64_t inner) const {
    int64_t heard = 0;
    for (int i = 0; i < n; ++i) {
      if (inner >= segs[i].start && inner < segs[i].end) {
        return heard + (inner - segs[i].start);
      }
      heard += segs[i].end - segs[i].start;
    }
    return -1;
  }

  /**
   * Samples from `heard_off` for which the map advances CONTINUOUSLY
   * (inner = mapOffset(heard_off) + i): the distance to the end of the
   * containing segment. Segment boundaries always count as seams even
   * when two segments happen to be inner-adjacent — splitting a
   * continuous run is harmless; missing a jump is not. Precondition:
   * active(); returns 0 otherwise.
   */
  int64_t seamDistance(int64_t heard_off) const {
    const int64_t p = period();
    if (p <= 0) return 0;
    heard_off = posMod(heard_off, p);
    for (int i = 0; i < n; ++i) {
      const int64_t len = segs[i].end - segs[i].start;
      if (heard_off < len) return len - heard_off;
      heard_off -= len;
    }
    return 0;  // unreachable
  }
};

// --- THE TOP (↺, loop_selection.md §9) -------------------------------
// A loop's TOP is where it reads as starting: a RAW inner position T,
// stored per node, clip or group (AudioNode::storedTop), sounding at
// origin + a0 + heardOffsetOf(T). Region edits swap what plays and keep
// the origin, so they never move the top's moment; they only decide
// whether the top survives — and STORE the answer (reconcileTop). Unset
// means a take never edited, whose top IS its region start until its
// first map edit stores one; no edit unsets a top. JS twins:
// ui/js/time_map.js keepsTop / reconcileTop / regionStart /
// effectiveTop; goldens: `top_reconcile_cases`, `effective_top_cases`.

/** An UNSET top. A sentinel no raw position can take: a dormant
 * re-expressed top may be negative (ClipNode::collapseContent). */
constexpr int64_t kNoTop = std::numeric_limits<int64_t>::min();

/** THE KEPT SET: whether raw position `t` is one the node's STORED map
 * plays — a segment holds it, or, with no map, the take (`duration`)
 * does. Bypass never enters: it toggles whether the region applies,
 * not what the region keeps (toggleLoopWindow leaves the top alone). */
inline bool keepsTop(const TimeMap& stored, int64_t duration, int64_t t) {
  if (t == kNoTop) return false;
  if (stored.n > 0) return stored.heardOffsetOf(t) >= 0;
  return t >= 0 && t < duration;
}

/** THE REGION START: the map's first start while the map is ACTIVE —
 * one window or many segments alike — else 0, the take's own start. A
 * bypassed map plays the whole take from its origin, so an unset top
 * reads there (its segments are still published; they do not play). */
inline int64_t regionStart(const TimeMap& stored, bool window_active) {
  return window_active && stored.n > 0 ? stored.segs[0].start : 0;
}

/** THE EFFECTIVE TOP (the published `loopTop`): the stored top when it
 * is set and kept, else the region start. */
inline int64_t effectiveTop(const TimeMap& stored, bool window_active,
                            int64_t duration, int64_t top) {
  return keepsTop(stored, duration, top) ? top
                                         : regionStart(stored, window_active);
}

/** THE RECONCILE RULE: after ANY map edit the top is STORED —
 * `top_before`, the EFFECTIVE top before the edit (the old geometry's
 * effectiveTop, or a live gesture's, AudioEngine::record), while the
 * new kept set (`stored`, the map AFTER the edit) still plays it;
 * otherwise the new region start, back on the splice. It must be
 * stored, never left unset: an unset top IS the region start, so it
 * would ride every later slide of the region instead of staying where
 * it was put. */
inline int64_t reconcileTop(const TimeMap& stored, bool window_active,
                            int64_t duration, int64_t top_before) {
  return effectiveTop(stored, window_active, duration, top_before);
}

}  // namespace celestrian::timing
