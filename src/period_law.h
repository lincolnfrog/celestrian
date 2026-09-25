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
 *   contribution(node) = (one-shot || skipped || DRIFTS) ? 0 : own(node)
 *
 * A node's OWN period is what it plays — an active map's period, else
 * its song, else its content (a clip's take; a stack's composite of what
 * its children hand it). What it CONTRIBUTES to its parent's fold is its
 * own period, unless it is a ONE-SHOT (Q5: it adopts the scope's cycle
 * and never extends it — its shot IS its own period, D2-5 ruling (a)),
 * the node the fold is judged against (`skip`, "everyone else"), or it
 * DRIFTS (Q22, below).
 *
 * THE DRIFT CLAUSE (Q22, ruling (a)): a node whose own period is neither
 * a whole multiple nor an exact divisor of the island Q cannot share a
 * finite cycle with the grid. It keeps playing exactly as recorded (its
 * render folds on its own period from its own origin — nothing here
 * touches it) and drifts against the grid, each pass lining up
 * differently; it contributes NOTHING to any fold, exactly like a
 * one-shot, so it never extends a cycle (no LCM blow-up). A node holding
 * an ACTIVE SEQUENCE is exempt, map or not (S10: free step lengths are a
 * deliberate drifting pass, and a step audition's derived map is a step
 * of that song). The providers carry the island Q (`quantum`); 0 — no
 * grid — judges nothing.
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
 * ownPeriod / periodContribution / periodDrifts / islandCycle; golden:
 * `period_law_cases` (tree fixtures) in shared/timing_golden.json.
 */
namespace celestrian::period_law {

template <typename Provider>
int64_t ownPeriod(const Provider& p, typename Provider::Handle h,
                  const AudioNode* skip = nullptr);

/** THE DRIFT PREDICATE on a period (Q22): neither a whole multiple nor
 * an exact divisor of `quantum`. False with no grid (quantum <= 0) and
 * for an empty period. */
inline bool periodDrifts(int64_t period, int64_t quantum) {
  return quantum > 0 && period > 0 && period % quantum != 0 &&
         quantum % period != 0;
}

/** Does `node`, whose own period is `own`, DRIFT against `quantum`? A
 * node holding an active song is exempt (S10). */
inline bool ownDrifts(const AudioNode& node, int64_t own, int64_t quantum) {
  return node.activeSequenceLen() == 0 && periodDrifts(own, quantum);
}

/** What `h` hands its parent's fold. */
template <typename Provider>
int64_t contribution(const Provider& p, typename Provider::Handle h,
                     const AudioNode* skip = nullptr) {
  const AudioNode& node = p.node(h);
  if (&node == skip || node.periodFromContext()) return 0;
  const int64_t own = ownPeriod(p, h, skip);
  return ownDrifts(node, own, p.quantum) ? 0 : own;
}

/** Does `h` DRIFT under the provider's island Q? A one-shot never does —
 * it contributes nothing for its own reason. */
template <typename Provider>
bool drifts(const Provider& p, typename Provider::Handle h) {
  const AudioNode& node = p.node(h);
  if (node.periodFromContext()) return false;
  return ownDrifts(node, ownPeriod(p, h), p.quantum);
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
 * StackNode::ownedChildren). `quantum` is the island Q the drift clause
 * judges against (0 = no grid, nothing drifts). */
struct TreeProvider {
  int64_t quantum = 0;
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

/** Message-thread conveniences over the tree provider, judged against
 * the node's island Q (AudioNode::getEffectiveQuantum). */
inline int64_t ownPeriodOf(const AudioNode& node,
                           const AudioNode* skip = nullptr) {
  return ownPeriod(TreeProvider{node.getEffectiveQuantum()}, &node, skip);
}
inline int64_t contributionOf(const AudioNode& node,
                              const AudioNode* skip = nullptr) {
  return contribution(TreeProvider{node.getEffectiveQuantum()}, &node, skip);
}
/** The same, judged against an explicit `quantum` (0 = no drift clause:
 * the period the node plays on a grid of its own — what a Q hand-off
 * establishes, Q22). */
inline int64_t ownPeriodOf(const AudioNode& node, const AudioNode* skip,
                           int64_t quantum) {
  return ownPeriod(TreeProvider{quantum}, &node, skip);
}
inline int64_t contributionOf(const AudioNode& node, const AudioNode* skip,
                              int64_t quantum) {
  return contribution(TreeProvider{quantum}, &node, skip);
}

}  // namespace celestrian::period_law
