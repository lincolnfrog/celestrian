#pragma once

#include <cstdint>

/**
 * The reified time-map (time_maps.md §2) — ONE implementation shared by
 * clips and stacks, and the object the phase-3 cell/punch editor edits.
 *
 * A map is an ordered list of segments over a node's inner timeline:
 *
 *   m(t) = cycle_epoch + walk_segments((t − cycle_epoch) mod period)
 *
 * Segments select VIEW positions of the received cycle; the mapped time
 * stays in the received frame (the caller adds the epoch — see the
 * one-frame warning in time_maps.md §2). Today's loop window is the
 * single-segment case (AudioNode::activeTimeMap builds it from the
 * phase-1 atomics); multi-segment storage arrives with the phase-3
 * editor, but every consumer of this type is segment-general NOW.
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

  /** Today's loop window: one segment, empty when invalid. */
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
   * into absolute time by adding the received cycle_epoch.
   */
  int64_t mapOffset(int64_t heard_off) const {
    const int64_t p = period();
    if (p <= 0) return heard_off;
    heard_off = ((heard_off % p) + p) % p;
    for (int i = 0; i < n; ++i) {
      const int64_t len = segs[i].end - segs[i].start;
      if (heard_off < len) return segs[i].start + heard_off;
      heard_off -= len;
    }
    return segs[0].start;  // unreachable: heard_off < p by construction
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
    heard_off = ((heard_off % p) + p) % p;
    for (int i = 0; i < n; ++i) {
      const int64_t len = segs[i].end - segs[i].start;
      if (heard_off < len) return len - heard_off;
      heard_off -= len;
    }
    return 0;  // unreachable
  }
};

}  // namespace celestrian::timing
