#pragma once

/**
 * Whole-graph immutable structure snapshot — the audio thread's only
 * view of structure (AudioNode's threading note). The message thread
 * builds one after every STRUCTURAL mutation (AudioEngine::publishGraph)
 * and the audio thread loads ONE pointer per callback
 * (ProcessContext::snap) and traverses integer indices, so structure is
 * consistent for the whole callback: a load per stack could straddle a
 * republish.
 *
 * Lifetime: nodes referenced by a snapshot outlive it through the
 * engine reclaimer — publish the successor first, then retire the old
 * snapshot and the removed nodes.
 *
 * The snapshot pins STRUCTURE, not state: durations, loop points,
 * origins and fx params are per-node atomics, so a commit landing on
 * the audio thread needs no republish.
 *
 * Everything in this header except buildGraphSnapshot is audio-thread
 * safe: plain reads, no allocation, bounded recursion over the tree.
 */

#include <cstdint>
#include <vector>

#include "period_law.h"
#include "stack_node.h"

namespace celestrian {

struct GraphSnapshot {
  struct Entry {
    AudioNode* node = nullptr;
    int parent = -1;     // entry index; -1 at the root
    int childBegin = 0;  // span into child_indices
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
  struct Builder {
    GraphSnapshot& s;
    int visit(AudioNode& n, int parentIdx) {
      const int idx = (int)s.entries.size();
      s.entries.push_back({&n, parentIdx, 0, 0});
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
 * the snapshot), judged against the island `quantum` (0 judges
 * nothing). */
inline int64_t snapEffectivePeriod(const GraphSnapshot& s, int idx,
                                   int64_t quantum = 0) {
  return period_law::ownPeriod(SnapProvider{s, quantum}, idx);
}

/** What the subtree at `idx` hands its parent's fold
 * (period_law::contribution over the snapshot). */
inline int64_t snapPeriodContribution(const GraphSnapshot& s, int idx,
                                      int64_t quantum = 0) {
  return period_law::contribution(SnapProvider{s, quantum}, idx);
}

/** The island cycle the transport wraps on (period_law::islandCycle
 * over the snapshot), `fallback` standing in for Q before it exists. */
inline int64_t snapEffectiveCycle(const GraphSnapshot& s, int64_t quantum,
                                  int64_t fallback) {
  return period_law::islandCycle(SnapProvider{s, quantum}, 0, quantum, fallback);
}

/** Solo audibility (Q16, AudioNode::is_soloed): is the entry, or any
 * ancestor, soloed? */
inline bool snapIsUnderSolo(const GraphSnapshot& s, int idx) {
  for (int i = idx; i >= 0; i = s.entries[(size_t)i].parent) {
    if (s.entries[(size_t)i].node->is_soloed.load()) return true;
  }
  return false;
}

/** Any solo anywhere in the island (ProcessContext::any_solo): one scan
 * of the entry list per callback. */
inline bool snapAnySolo(const GraphSnapshot& s) {
  for (const auto& e : s.entries) {
    if (e.node->is_soloed.load()) return true;
  }
  return false;
}

}  // namespace celestrian
