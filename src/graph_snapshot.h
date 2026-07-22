#pragma once

/**
 * Whole-graph immutable structure snapshot — unification_audit.md §2.2 /
 * tasks.md Tier 3 Step 3 ("one atomic swap replaces per-stack snapshots
 * + reclaimer plumbing").
 *
 * The message thread builds a snapshot after every STRUCTURAL mutation
 * (AudioEngine::publishGraph); the audio thread loads ONE pointer per
 * callback (ProcessContext.snap) and traverses integer indices. This
 * buys, over the old per-stack child snapshots:
 *
 *   - whole-callback structural consistency (one load, not one per
 *     stack per block),
 *   - no audio-thread parent walks (parent indices live here; island
 *     facts ride ProcessContext),
 *   - one lifetime domain: nodes referenced by a snapshot outlive it
 *     via the engine reclaimer (retire order: publish the successor
 *     first, then retire the old snapshot / removed nodes — the
 *     2-callback grace covers any in-flight reader).
 *
 * Node OBJECTS stay mutable in place: continuous facts (durations,
 * loop points, origins, fx params) are per-node atomics, exactly as
 * before. The snapshot pins STRUCTURE, not state — so a mid-version
 * commit (a clip's duration landing on the audio thread) needs no
 * republish, which is also the "live take stays outside the snapshot"
 * carve-out.
 *
 * Everything in this header except buildGraphSnapshot is audio-thread
 * safe: plain reads, no allocation, bounded recursion over the tree.
 */

#include <cstdint>
#include <vector>

#include "stack_node.h"
#include "timing.h"

namespace celestrian {

struct GraphSnapshot {
  struct Entry {
    AudioNode *node = nullptr;
    NodeType type = NodeType::Unknown;  // cached: no virtual on audio thread
    int parent = -1;                    // entry index; -1 at the root
    int childBegin = 0;                 // span into child_indices
    int childCount = 0;
  };
  std::vector<Entry> entries;      // entries[0] is the root
  std::vector<int> child_indices;  // every stack's children, packed

  int childAt(int entryIdx, int k) const {
    return child_indices[(size_t)(entries[(size_t)entryIdx].childBegin + k)];
  }
};

/** Build a snapshot of the CURRENT ownership tree. Message thread only
 * (reads StackNode::ownedChildren, allocates). The caller owns the
 * result and retires superseded snapshots through the reclaimer. */
inline GraphSnapshot *buildGraphSnapshot(AudioNode &root) {
  auto *snap = new GraphSnapshot();
  // Recursive lambda via explicit stack-free structure: simple DFS.
  struct Builder {
    GraphSnapshot &s;
    int visit(AudioNode &n, int parentIdx) {
      const int idx = (int)s.entries.size();
      s.entries.push_back({&n, n.getNodeType(), parentIdx, 0, 0});
      if (n.getNodeType() == NodeType::Stack) {
        auto &stack = static_cast<StackNode &>(n);
        // Two passes: children spans must be contiguous in
        // child_indices, but child subtrees interleave — so reserve the
        // span first, then fill as subtrees are visited.
        const int begin = (int)s.child_indices.size();
        const int count = (int)stack.ownedChildren().size();
        s.entries[(size_t)idx].childBegin = begin;
        s.entries[(size_t)idx].childCount = count;
        for (int k = 0; k < count; ++k) s.child_indices.push_back(-1);
        for (int k = 0; k < count; ++k) {
          s.child_indices[(size_t)(begin + k)] =
              visit(*stack.ownedChildren()[(size_t)k], idx);
        }
      }
      return idx;
    }
  } b{*snap};
  b.visit(root, -1);
  return snap;
}

/** Composite duration of the subtree at `idx` (clips: stored duration;
 * stacks: LCM of children — recording.md "Nested Stacks and Composite
 * Duration"). The snapshot-space twin of the node virtuals, safe on the
 * audio thread. */
inline int64_t snapIntrinsicDuration(const GraphSnapshot &s, int idx) {
  const auto &e = s.entries[(size_t)idx];
  if (e.type == NodeType::Clip) return e.node->getIntrinsicDuration();
  int64_t composite = 0;
  for (int k = 0; k < e.childCount; ++k) {
    const int64_t d = snapIntrinsicDuration(s, s.childAt(idx, k));
    if (d > 0) composite = composite == 0 ? d : timing::lcm(composite, d);
  }
  return composite;
}

/** Effective (audible, E-C) period of the subtree at `idx`: an ACTIVE
 * window wins at any level; otherwise clips contribute their duration
 * and stacks the LCM of children's effective periods. */
inline int64_t snapEffectivePeriod(const GraphSnapshot &s, int idx) {
  const auto &e = s.entries[(size_t)idx];
  if (const timing::TimeMap map = e.node->activeTimeMap(); map.active()) {
    return map.period();
  }
  if (e.type == NodeType::Clip) return e.node->getIntrinsicDuration();
  int64_t composite = 0;
  for (int k = 0; k < e.childCount; ++k) {
    const int64_t p = snapEffectivePeriod(s, s.childAt(idx, k));
    if (p > 0) composite = composite == 0 ? p : timing::lcm(composite, p);
  }
  return composite;
}

/** The audible island cycle the transport wraps on (E-C):
 * lcm(quantum, effective period of the root). */
inline int64_t snapEffectiveCycle(const GraphSnapshot &s, int64_t quantum,
                                  int64_t fallback) {
  if (quantum <= 0) quantum = fallback;
  const int64_t p = snapEffectivePeriod(s, 0);
  return p > 0 ? timing::lcm(quantum, p) : quantum;
}

/** Solo audibility: is the entry (or any ancestor) the soloed node?
 * Index walk — replaces the audio-thread parent-pointer chain. */
inline bool snapIsUnderSolo(const GraphSnapshot &s, int idx,
                            const AudioNode *solo) {
  for (int i = idx; i >= 0; i = s.entries[(size_t)i].parent) {
    if (s.entries[(size_t)i].node == solo) return true;
  }
  return false;
}

}  // namespace celestrian
