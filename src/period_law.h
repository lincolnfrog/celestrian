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
 * and never extends it — its shot IS its own period), the node the fold
 * is judged against (`skip`, "everyone else"), or it DRIFTS (below).
 *
 * THE DRIFT CLAUSE (Q22): a node whose own period is neither
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
 * §3). The cycle each stack hands its own children is `scopeCycle`,
 * stated beside it.
 *
 * PROVIDERS: the same template runs over the ownership tree (message
 * thread — `TreeProvider`, handles are node pointers) and over the
 * immutable graph snapshot (audio thread — `SnapProvider` in
 * graph_snapshot.h, handles are entry indices). Neither restates the
 * law; a stack and a clip, a thread and its twin, cannot fold
 * differently by construction. JS twin: ui/js/period_law.js ownPeriod /
 * periodContribution / periodDrifts / islandCycle; golden:
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

/** What `h` plays, from the node's active map and active song length as
 * the CALLER read them (`map`, `seq_len`). The audio thread reads a
 * stack's geometry once per phase and judges its period from that same
 * read, so the period and the clock it folds cannot come from two
 * different maps. */
template <typename Provider>
int64_t ownPeriodWith(const Provider& p, typename Provider::Handle h,
                      const timing::TimeMap& map, int64_t seq_len,
                      const AudioNode* skip = nullptr) {
  if (map.active()) return map.period();
  if (seq_len > 0) return seq_len;
  const AudioNode& node = p.node(h);
  if (node.getNodeType() == NodeType::Clip) return node.getIntrinsicDuration();
  int64_t composite = 0;
  p.forEachChild(h, [&](typename Provider::Handle child) {
    composite = timing::foldPeriod(composite, contribution(p, child, skip));
  });
  return composite;
}

/** What `h` plays. */
template <typename Provider>
int64_t ownPeriod(const Provider& p, typename Provider::Handle h,
                  const AudioNode* skip) {
  const AudioNode& node = p.node(h);
  return ownPeriodWith(p, h, node.activeTimeMap(), node.activeSequenceLen(),
                       skip);
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

/**
 * THE SCOPE CYCLE a stack hands its children (ProcessContext::
 * context_cycle — a one-shot child's period, and the grid a child take
 * wraps on), from the stack's `own` period:
 *
 *   authored (a map or a song sets `own`)  → own
 *   else own > 0                           → lcm(Q, own)
 *   else (no looping content)              → the cycle the stack received
 *
 * A stack's map pass or song is what its children listen to as it
 * stands; a plain stack's children listen to the fold of its looping
 * content on the island grid; a scope with nothing looping passes its
 * own scope's cycle on, so a one-shot inside an all-one-shot group still
 * sounds once per the enclosing cycle. JS twin: ui/js/period_law.js
 * scopeCycle; golden: `scope_cycle_cases`.
 */
inline int64_t scopeCycle(int64_t own, bool authored, int64_t quantum,
                          int64_t received) {
  if (own <= 0) return received;
  if (authored || quantum <= 0) return own;
  return timing::lcm(quantum, own);
}

/** The scope cycle of the stack at `h`, judged against the provider's
 * island Q. */
template <typename Provider>
int64_t scopeCycle(const Provider& p, typename Provider::Handle h,
                   int64_t received) {
  const AudioNode& node = p.node(h);
  const timing::TimeMap map = node.activeTimeMap();
  const int64_t seq_len = node.activeSequenceLen();
  return scopeCycle(ownPeriodWith(p, h, map, seq_len),
                    map.active() || seq_len > 0, p.quantum, received);
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

/** Message-thread convenience over the tree provider: the node's own
 * period, judged against its island Q (AudioNode::getEffectiveQuantum). */
inline int64_t ownPeriodOf(const AudioNode& node,
                           const AudioNode* skip = nullptr) {
  return ownPeriod(TreeProvider{node.getEffectiveQuantum()}, &node, skip);
}
/** The same, judged against an explicit `quantum` (0 = no drift clause:
 * the period the node plays on a grid of its own — what a Q hand-off
 * establishes, Q22). */
inline int64_t ownPeriodOf(const AudioNode& node, const AudioNode* skip,
                           int64_t quantum) {
  return ownPeriod(TreeProvider{quantum}, &node, skip);
}

}  // namespace celestrian::period_law
