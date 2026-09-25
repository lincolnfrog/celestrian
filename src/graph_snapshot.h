#pragma once

/**
 * Whole-graph immutable structure snapshot.
 *
 * The message thread builds a snapshot after every STRUCTURAL mutation
 * (AudioEngine::publishGraph); the audio thread loads ONE pointer per
 * callback (ProcessContext.snap) and traverses integer indices. This
 * gives:
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
 * loop points, origins, fx params) are per-node atomics. The snapshot
 * pins STRUCTURE, not state — so a mid-version
 * commit (a clip's duration landing on the audio thread) needs no
 * republish, which is also the "live take stays outside the snapshot"
 * carve-out.
 *
 * Everything in this header except buildGraphSnapshot is audio-thread
 * safe: plain reads, no allocation, bounded recursion over the tree.
 */

#include <cstdint>
#include <vector>

#include "period_law.h"
#include "stack_node.h"
#include "timing.h"

namespace celestrian {

struct GraphSnapshot {
  struct Entry {
    AudioNode* node = nullptr;
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
inline GraphSnapshot* buildGraphSnapshot(AudioNode& root) {
  auto* snap = new GraphSnapshot();
  // Recursive lambda via explicit stack-free structure: simple DFS.
  struct Builder {
    GraphSnapshot& s;
    int visit(AudioNode& n, int parentIdx) {
      const int idx = (int)s.entries.size();
      s.entries.push_back({&n, n.getNodeType(), parentIdx, 0, 0});
      if (n.getNodeType() == NodeType::Stack) {
        auto& stack = static_cast<StackNode&>(n);
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
inline int64_t snapIntrinsicDuration(const GraphSnapshot& s, int idx) {
  const auto& e = s.entries[(size_t)idx];
  if (e.type == NodeType::Clip) return e.node->getIntrinsicDuration();
  int64_t composite = 0;
  for (int k = 0; k < e.childCount; ++k) {
    const int child = s.childAt(idx, k);
    // ONE-SHOTS are excluded from composition (Q5): their period is the
    // context cycle, so they adopt the scope's cycle rather than extend
    // it — a composite stays honestly periodic in the fold of its
    // LOOPING content (I1).
    if (s.entries[(size_t)child].node->periodFromContext()) continue;
    composite = timing::foldPeriod(composite, snapIntrinsicDuration(s, child));
  }
  return composite;
}

/** THE PERIOD LAW's snapshot provider (period_law.h): handles are entry
 * indices, children come from the packed spans; `quantum` is the island
 * Q the drift clause judges against (0 = no grid, nothing drifts).
 * Audio-thread safe. */
struct SnapProvider {
  const GraphSnapshot& s;
  int64_t quantum = 0;
  using Handle = int;
  const AudioNode& node(Handle h) const { return *s.entries[(size_t)h].node; }
  template <typename F>
  void forEachChild(Handle h, F&& f) const {
    const auto& e = s.entries[(size_t)h];
    for (int k = 0; k < e.childCount; ++k) f(s.childAt(h, k));
  }
};

/** The OWN period of the subtree at `idx` (period_law::ownPeriod over
 * the snapshot): an active map's period, else the song, else a clip's
 * duration or a stack's LCM of its children's contributions — judged
 * against the island `quantum` (a drifting child contributes nothing;
 * 0 judges nothing). */
inline int64_t snapEffectivePeriod(const GraphSnapshot& s, int idx,
                                   int64_t quantum = 0) {
  return period_law::ownPeriod(SnapProvider{s, quantum}, idx);
}

/** What the subtree at `idx` hands its parent's fold (0 for a one-shot,
 * and for a node that drifts against the island `quantum`). */
inline int64_t snapPeriodContribution(const GraphSnapshot& s, int idx,
                                      int64_t quantum = 0) {
  return period_law::contribution(SnapProvider{s, quantum}, idx);
}

/** The audible island cycle the transport wraps on (E-C):
 * lcm(quantum, own period of the root), `fallback` standing in for Q
 * before it exists. Drifting nodes extend nothing (Q22). */
inline int64_t snapEffectiveCycle(const GraphSnapshot& s, int64_t quantum,
                                  int64_t fallback) {
  return period_law::islandCycle(SnapProvider{s, quantum}, 0, quantum, fallback);
}

/** Solo audibility (Q16 canon — island-wide, additive, fractal): is
 * the entry, or any ancestor, soloed? Index walk over parent indices
 * (the audio thread never walks parent pointers — the message thread
 * reparents); the per-node flag is an atomic, so no republish rides a
 * solo toggle. */
inline bool snapIsUnderSolo(const GraphSnapshot& s, int idx) {
  for (int i = idx; i >= 0; i = s.entries[(size_t)i].parent) {
    if (s.entries[(size_t)i].node->is_soloed.load()) return true;
  }
  return false;
}

/** Any solo anywhere in the island (the any_solo context flag): a
 * per-callback scan of the entry list — entries are tens, not
 * thousands, and the flags are atomics, so this stays allocation- and
 * lock-free. Additive by construction: the scan doesn't care how many
 * solos are lit. */
inline bool snapAnySolo(const GraphSnapshot& s) {
  for (const auto& e : s.entries) {
    if (e.node->is_soloed.load()) return true;
  }
  return false;
}

}  // namespace celestrian
