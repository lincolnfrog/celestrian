#pragma once

#include <cstdint>

#include "clip_node.h"
#include "period_law.h"
#include "stack_node.h"
#include "time_map.h"
#include "timing.h"

/**
 * heard_index.h — "which inner position sounds at clock t", the
 * MESSAGE-THREAD twin of the audio thread's descent (composition.md §2,
 * Q18), built on the one equation (timing::innerAt).
 *
 * The audio thread answers the question in two steps: each stack
 * ancestor hands its children a clock (StackNode::childContext — its
 * map or one-shot fold applied at its own origin, its scope for the
 * children, a cued step's re-base), and the node then reads its own
 * inner position from the clock it RECEIVED. This header restates
 * exactly that walk (receivedAt) and that read (ownInnerAt) so every
 * phase-preserving solver (the Q13 definer trims, the continuity
 * re-anchor) reads the truth at ANY depth instead of a depth-1 copy,
 * and so a golden test can compare it against the render
 * (tests/content_frame_tests.cc).
 */
namespace celestrian::heard {

using timing::posMod;

/** What a node receives besides the clock: the frame it is measured
 * from and the cycle a one-shot rests against (ProcessContext's
 * cycle_epoch / context_cycle / quantum). */
struct Scope {
  int64_t cycle_epoch = 0;
  int64_t context_cycle = 0;
  int64_t quantum = 0;
};

/** The clock a node receives, and the scope it receives it in. */
struct Received {
  int64_t clock = 0;
  Scope scope;
};

/** A node's effective map: its active map, else its whole inner span
 * (a clip's take; a stack's inner cycle). */
inline timing::TimeMap effectiveMap(const AudioNode& node) {
  const timing::TimeMap m = node.activeTimeMap();
  return m.active() ? m : timing::TimeMap::single(0, node.getIntrinsicDuration());
}

/** The origin a node measures from (StackNode::frameOrigin's twin): its
 * own origin once anchored — a clip always is — else the received
 * cycle top (an empty stack). */
inline int64_t frameOriginOf(const AudioNode& node, const Scope& scope) {
  return node.isAnchored() ? node.origin_samples.load() : scope.cycle_epoch;
}

/** THE NODE EQUATION at the node's RECEIVED clock: for a clip, the
 * content index that sounds; for a stack, the offset of the child clock
 * from the stack's origin. A one-shot folds on the scope's context
 * cycle (innerAt clamps a cycle no longer than the shot to the shot). */
inline timing::InnerAt ownInnerAt(const AudioNode& node,
                                  int64_t received_clock,
                                  const Scope& scope) {
  const timing::TimeMap m = effectiveMap(node);
  if (m.period() <= 0) return {};
  const int64_t fold =
      node.periodFromContext() ? scope.context_cycle : m.period();
  return timing::innerAt(received_clock, frameOriginOf(node, scope), m, fold);
}

/** The scope a stack hands its children — StackNode::childContext's
 * context-cycle law: an active map's period ▸ the song ▸ lcm(Q, the
 * LOOPING children's effective periods) ▸ the received cycle. */
inline Scope childScopeOf(const StackNode& stack, const Scope& scope,
                          int64_t O, const timing::TimeMap& map) {
  Scope child = scope;
  if (map.active()) {
    child.cycle_epoch = O + map.mapOffset(0);
    child.context_cycle = map.period();
    return child;
  }
  if (const Sequence* seq = stack.activeSequence()) {
    child.context_cycle = seq->total;
    return child;
  }
  // The stack's own period by THE PERIOD LAW (no map, no song: the LCM
  // of its looping children's contributions).
  if (const int64_t own = period_law::ownPeriodOf(stack); own > 0) {
    child.context_cycle =
        scope.quantum > 0 ? timing::lcm(scope.quantum, own) : own;
  }
  return child;
}

/** A stack's clock after its OWN fold (StackNode::childContext's first
 * step): the received clock itself for a plain looping stack, else
 * O + inner(t) under its active map or its one-shot's context-cycle
 * fold. This is the clock its song is read at and its children hear
 * before any cue re-base. */
inline int64_t foldedClockAt(const StackNode& stack, const Received& r,
                             int64_t O, const timing::TimeMap& map) {
  const int64_t shot =
      map.active() ? map.period() : stack.getIntrinsicDuration();
  const bool one_shot = stack.periodFromContext() && shot > 0 &&
                        r.scope.context_cycle > shot;
  if (!map.active() && !one_shot) return r.clock;
  const timing::TimeMap eff =
      map.active() ? map : timing::TimeMap::single(0, shot);
  return O + timing::innerAt(r.clock, O, eff,
                             one_shot ? r.scope.context_cycle : eff.period())
                 .inner;
}

/** THE SONG POSITION a sequenced stack reads at its received clock —
 * the message-thread twin of StackNode::childContext's cue lookup: the
 * folded clock measured from the stack's OWN frame origin (Q18: a
 * group's origin; the root's, anchored at the zero its song was
 * authored on — docs/frame.md §4), wrapped on the song. −1 when the
 * stack has no active sequence. */
inline int64_t songPositionAt(const StackNode& stack, const Received& r) {
  const Sequence* seq = stack.activeSequence();
  if (seq == nullptr || seq->total <= 0) return -1;
  const int64_t O = frameOriginOf(stack, r.scope);
  return seq->fold(foldedClockAt(stack, r, O, stack.activeTimeMap()) - O);
}

/** THE DESCENT: what `node` receives at transport clock `t` — the
 * root→node walk applying, per stack ancestor, exactly what
 * StackNode::childContext does: the one equation on the clock (an
 * active map, or a one-shot's context-cycle fold, at the stack's frame
 * origin), the child scope, and a cued step's re-base to the step top.
 * `root_scope` is the island frame (AudioEngine::rootScope). A plain
 * looping stack with no geometry passes the clock through. */
inline Received receivedAt(const AudioNode& node, int64_t t,
                           const Scope& root_scope) {
  constexpr int kMaxDepth = 64;
  const AudioNode* chain[kMaxDepth];
  int depth = 0;
  for (const AudioNode* p = node.getParent(); p != nullptr && depth < kMaxDepth;
       p = p->getParent()) {
    chain[depth++] = p;
  }
  Received r;
  r.clock = t;
  r.scope = root_scope;
  for (int i = depth - 1; i >= 0; --i) {
    const auto* stack = dynamic_cast<const StackNode*>(chain[i]);
    if (stack == nullptr) continue;
    const timing::TimeMap map = stack->activeTimeMap();
    const int64_t O = frameOriginOf(*stack, r.scope);
    Scope child = childScopeOf(*stack, r.scope, O, map);
    int64_t clock = foldedClockAt(*stack, r, O, map);
    // CUE STEPS (docs/sequencer.md §3): a cued VISIT re-bases the
    // subtree's frame to the step top; the child frame's cycle top is
    // the stack's origin again.
    if (const Sequence* seq = stack->activeSequence();
        seq != nullptr && seq->any_cue && seq->total > 0) {
      const int64_t srel = seq->fold(clock - O);
      const int k = seq->visitAt(srel);
      if (seq->cueOfVisit(k)) {
        clock = O + (srel - seq->bounds[k]);
        child.cycle_epoch = O;
      }
    }
    r.clock = clock;
    r.scope = child;
  }
  return r;
}

/** THE NODE EQUATION at transport clock `t`, composed through every
 * ancestor: ownInnerAt(node, receivedAt(node, t)). */
inline timing::InnerAt nodeInnerAt(const AudioNode& node, int64_t t,
                                   const Scope& root_scope) {
  const Received r = receivedAt(node, t, root_scope);
  return ownInnerAt(node, r.clock, r.scope);
}

/** The inner position `node` presents at transport clock `t` (a clip:
 * its content index; a stack: its child clock's offset from its
 * origin). In a one-shot's rest this is the rest phase — check
 * nodeInnerAt(...).rest when that matters. */
inline int64_t nodeInner(const AudioNode& node, int64_t t,
                         const Scope& root_scope) {
  return nodeInnerAt(node, t, root_scope).inner;
}

/** Fold an inner position into a single window [start, start+len):
 * the position that keeps sounding when the window moves (the definer
 * trims). */
inline int64_t foldIntoWindow(int64_t p, int64_t start, int64_t len) {
  return len > 0 ? start + posMod(p - start, len) : start;
}

/** The origin that makes a node present inner position `p` at its
 * received clock `t0` under map `m`: `t0 − mapOffset(0) −
 * heardOffsetOf(p)` — or, when the new map no longer covers `p`, the
 * old heard phase `fallback_h` folded into the new period (the
 * multi-segment rule). */
inline int64_t originForHeard(const timing::TimeMap& m, int64_t t0, int64_t p,
                              int64_t fallback_h) {
  const int64_t period = m.period();
  int64_t h = m.heardOffsetOf(p);
  if (h < 0) h = period > 0 ? posMod(fallback_h, period) : 0;
  return t0 - m.mapOffset(0) - h;
}

}  // namespace celestrian::heard
