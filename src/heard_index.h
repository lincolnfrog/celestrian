#pragma once

#include <cstdint>

#include "clip_node.h"
#include "stack_node.h"
#include "time_map.h"

/**
 * heard_index.h — "which buffer sample sounds at clock t", stated ONCE.
 *
 * Every phase-preserving solver (the Q13 clip re-trim, the definer
 * stack re-trim, the multi-segment re-trim, the two-anchor continuity
 * rider) used to restate the playback equation by hand in its own
 * frame — and two of them drifted (docs/loop_region_audit.md §1.1,
 * §1.5). These are the equations the audio thread actually runs
 * (clip_node.cc render, stack_node.cc childContext), lifted to the
 * message thread so the solvers read the truth instead of a copy, and
 * so a golden test can compare them against the render
 * (tests/content_frame_tests.cc, "the solver equals the render").
 */
namespace celestrian::heard {

inline int64_t posMod(int64_t a, int64_t m) {
  return m > 0 ? ((a % m) + m) % m : 0;
}

/** A clip's effective map: its active map, else the whole take. */
inline timing::TimeMap effectiveMap(const ClipNode& clip) {
  const timing::TimeMap m = clip.activeTimeMap();
  return m.active() ? m : timing::TimeMap::single(0, clip.getIntrinsicDuration());
}

/** THE CLIP EQUATION (clip_node.cc): the content sample a clip renders
 * at monotonic clock `t` — `mapOffset((t − origin − mapOffset(0)) mod
 * period)`; the un-mapped case reduces to `(t − origin) mod dur`.
 * Uses the message-thread origin (`origin_samples`). */
inline int64_t clipHeardIndex(const ClipNode& clip, int64_t t) {
  const timing::TimeMap m = effectiveMap(clip);
  const int64_t period = m.period();
  if (period <= 0) return 0;
  const int64_t org = clip.origin_samples.load();
  return m.mapOffset(posMod(t - org - m.mapOffset(0), period));
}

/** THE GROUP EQUATION (stack_node.cc childContext + the clip equation):
 * the content sample a whole member of a windowed stack renders at `t`
 * — the stack maps the received clock to `epoch + mapOffset(t − epoch)`
 * and the member reads that origin-relative. With no active stack map
 * this is the clip equation. */
inline int64_t memberHeardIndex(const StackNode& stack, const ClipNode& member,
                                int64_t t, int64_t epoch) {
  const timing::TimeMap map = stack.activeTimeMap();
  const int64_t t_child =
      map.active() && map.period() > 0 ? epoch + map.mapOffset(t - epoch) : t;
  return clipHeardIndex(member, t_child);
}

/** Fold a content position into a single window [start, start+len):
 * the sample that keeps sounding when the window moves (the sole-clip
 * and definer-stack trims). */
inline int64_t foldIntoWindow(int64_t p, int64_t start, int64_t len) {
  return len > 0 ? start + posMod(p - start, len) : start;
}

/** The origin that makes a clip render content sample `p` at clock
 * `t0` under map `m`: `t0 − mapOffset(0) − heardOffsetOf(p)` — or, when
 * the new map no longer covers `p`, the old heard phase `fallback_h`
 * folded into the new period (the multi-segment rule). */
inline int64_t originForHeard(const timing::TimeMap& m, int64_t t0, int64_t p,
                              int64_t fallback_h) {
  const int64_t period = m.period();
  int64_t h = m.heardOffsetOf(p);
  if (h < 0) h = posMod(fallback_h, period);
  return t0 - m.mapOffset(0) - h;
}

}  // namespace celestrian::heard
