#pragma once

#include <cstdint>

#include "stack_node.h"
#include "timing.h"

/**
 * THE PERIOD LAW (composition.md §3, I12), stated ONCE with two
 * providers:
 *
 *   own(node)          = map ▸ active sequence ▸ (clip: D | stack: LCM of
 *                        the children's contributions)
 *   contribution(node) = (one-shot || skipped) ? 0 : own(node)
 *
 * A node's OWN period is what it plays — an active map's period, else
 * its song, else its content (a clip's take; a stack's composite of what
 * its children hand it). What it CONTRIBUTES to its parent's fold is its
 * own period, unless it is a ONE-SHOT (Q5: it adopts the scope's cycle
 * and never extends it — its shot IS its own period, D2-5 ruling (a)) or
 * the node the fold is judged against (`skip`, "everyone else").
 *
 * The island cycle is lcm(Q, own(root)) — Q falling back to one second
 * of samples before Q exists (the pre-Q island cycle, composition.md
 * §3).
 *
 * PROVIDERS: the same template runs over the ownership tree (message
 * thread — `TreeProvider`, handles are node pointers) and over the
 * immutable graph snapshot (audio thread — `SnapProvider` in
 * graph_snapshot.h, handles are entry indices). Neither restates the
 * law; a stack and a clip, a thread and its twin, cannot fold
 * differently by construction. JS twin: ui/js/timeline_model.js
 * ownPeriod / periodContribution / islandCycle; golden:
 * `period_law_cases` (tree fixtures) in shared/timing_golden.json.
 */
namespace celestrian::period_law {

template <typename Provider>
int64_t ownPeriod(const Provider& p, typename Provider::Handle h,
                  const AudioNode* skip = nullptr);

/** What `h` hands its parent's fold. */
template <typename Provider>
int64_t contribution(const Provider& p, typename Provider::Handle h,
                     const AudioNode* skip = nullptr) {
  const AudioNode& node = p.node(h);
  if (&node == skip || node.periodFromContext()) return 0;
  return ownPeriod(p, h, skip);
}

/** What `h` plays. */
template <typename Provider>
int64_t ownPeriod(const Provider& p, typename Provider::Handle h,
                  const AudioNode* skip) {
  const AudioNode& node = p.node(h);
  if (const timing::TimeMap map = node.activeTimeMap(); map.active()) {
    return map.period();
  }
  if (const int64_t seq_len = node.activeSequenceLen(); seq_len > 0) {
    return seq_len;
  }
  if (node.getNodeType() == NodeType::Clip) return node.getIntrinsicDuration();
  int64_t composite = 0;
  p.forEachChild(h, [&](typename Provider::Handle child) {
    composite = timing::foldPeriod(composite, contribution(p, child, skip));
  });
  return composite;
}

/** The island cycle the transport wraps on (E-C): lcm(Q, own(root)),
 * with `fallback` (one second of samples) standing in for Q before it
 * exists. */
template <typename Provider>
int64_t islandCycle(const Provider& p, typename Provider::Handle root,
                    int64_t quantum, int64_t fallback) {
  if (quantum <= 0) quantum = fallback;
  const int64_t own = ownPeriod(p, root);
  return own > 0 ? timing::lcm(quantum, own) : quantum;
}

/** The ownership-tree provider (message thread only: walks
 * StackNode::ownedChildren). */
struct TreeProvider {
  using Handle = const AudioNode*;
  const AudioNode& node(Handle h) const { return *h; }
  template <typename F>
  void forEachChild(Handle h, F&& f) const {
    if (h->getNodeType() != NodeType::Stack) return;
    for (const auto& child : static_cast<const StackNode*>(h)->ownedChildren()) {
      f(child.get());
    }
  }
};

/** Message-thread conveniences over the tree provider. */
inline int64_t ownPeriodOf(const AudioNode& node,
                           const AudioNode* skip = nullptr) {
  return ownPeriod(TreeProvider{}, &node, skip);
}
inline int64_t contributionOf(const AudioNode& node,
                              const AudioNode* skip = nullptr) {
  return contribution(TreeProvider{}, &node, skip);
}

}  // namespace celestrian::period_law
