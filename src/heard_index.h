#pragma once

#include <cstdint>

#include "clip_node.h"
#include "stack_node.h"
#include "time_map.h"

/**
 * heard_index.h — "which inner position sounds at clock t", stated ONCE
 * for every node (composition.md §2, Q18).
 *
 * The one equation, for a node with origin O, active map m (else the
 * full span [0, D)), period P = m.period() and a0 = m.mapOffset(0):
 *
 *   inner(t) = m.mapOffset((t − O − a0) mod P)
 *
 * A clip reads content[base + inner(t)]; a stack hands its children
 * t_child = O + inner(t). These are the equations the audio thread runs
 * (clip_node.cc render, stack_node.cc childContext), lifted to the
 * message thread so every phase-preserving solver (the Q13 definer
 * trims — clip AND stack, one path — and the continuity re-anchor)
 * reads the truth instead of a copy, and so a golden test can compare
 * them against the render (tests/content_frame_tests.cc).
 */
namespace celestrian::heard {

/** timing::posMod, with "no modulus" reading as 0 (a fold with no
 * period has no position). */
inline int64_t posMod(int64_t a, int64_t m) {
  return m > 0 ? timing::posMod(a, m) : 0;
}

/** A node's effective map: its active map, else its whole inner span
 * (a clip's take; a stack's inner cycle). */
inline timing::TimeMap effectiveMap(const AudioNode& node) {
  const timing::TimeMap m = node.activeTimeMap();
  return m.active() ? m : timing::TimeMap::single(0, node.getIntrinsicDuration());
}

/** THE NODE EQUATION: the inner position a node presents at monotonic
 * clock `t` — for a clip, its content index; for a stack, the offset of
 * the child clock from the stack's origin. Uses the message-thread
 * origin (`origin_samples`). An UNANCHORED stack (no content yet) is
 * measured from `fallback_origin` (its received cycle top). */
inline int64_t nodeInner(const AudioNode& node, int64_t t,
                         int64_t fallback_origin = 0) {
  const timing::TimeMap m = effectiveMap(node);
  const int64_t period = m.period();
  if (period <= 0) return 0;
  const bool anchored =
      node.getNodeType() == NodeType::Clip || node.isAnchored();
  const int64_t org = anchored ? node.origin_samples.load() : fallback_origin;
  return m.mapOffset(posMod(t - org - m.mapOffset(0), period));
}

/** THE CLIP EQUATION (clip_node.cc render): the content sample a clip
 * renders at `t` — nodeInner on a leaf. */
inline int64_t clipHeardIndex(const ClipNode& clip, int64_t t) {
  return nodeInner(clip, t);
}

/** THE GROUP EQUATION (stack_node.cc childContext + the clip law): the
 * content sample a member of a stack renders at `t` — the stack maps
 * the clock to `O + inner(t)` and the member reads that origin-relative.
 * With no active stack map this is the clip equation. `fallback_epoch`
 * is the frame an unanchored stack measures from. */
inline int64_t memberHeardIndex(const StackNode& stack, const ClipNode& member,
                                int64_t t, int64_t fallback_epoch) {
  const timing::TimeMap map = stack.activeTimeMap();
  if (!map.active() || map.period() <= 0) return clipHeardIndex(member, t);
  const int64_t O = stack.isAnchored() ? stack.origin_samples.load()
                                       : fallback_epoch;
  return clipHeardIndex(member, O + nodeInner(stack, t, fallback_epoch));
}

/** Fold an inner position into a single window [start, start+len):
 * the position that keeps sounding when the window moves (the definer
 * trims). */
inline int64_t foldIntoWindow(int64_t p, int64_t start, int64_t len) {
  return len > 0 ? start + posMod(p - start, len) : start;
}

/** The origin that makes a node present inner position `p` at clock
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
