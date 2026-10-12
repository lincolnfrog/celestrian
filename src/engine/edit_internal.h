#pragma once

// Helpers shared by the edit appliers (engine/edit_*.cc) and the log
// (engine/edit_log.cc). Message thread only; not part of the engine's
// public surface.

#include "../audio_node.h"
#include "../edit.h"
#include "../stack_node.h"

namespace celestrian::edit_internal {

/** Is `node` the node `holder` itself, or anywhere in its subtree? */
inline bool isWithin(const AudioNode* node, const AudioNode* holder) {
  for (; node != nullptr; node = node->getParent()) {
    if (node == holder) return true;
  }
  return false;
}

/** The inverse takes the island's (Q, zero) as they are now. */
inline void captureIsland(const StackNode& root, Edit& inv) {
  inv.setsIsland = true;
  inv.iq = root.getQuantum();
  inv.izero = root.getZero();
}

/** SWAP ONE FACT of the node an edit names: the inverse is the same kind
 * holding the value `get` found in `slot`, and the edit's own value goes
 * live through `set`. Nop when `found` is not a `Node`. */
template <typename Node, typename Value, typename Get, typename Set>
Edit swapFact(AudioNode* found, const Edit& e, Value Edit::*slot, Get get,
              Set set) {
  auto* node = dynamic_cast<Node*>(found);
  if (node == nullptr) return {};
  Edit inv(e.kind);
  inv.uuid = e.uuid;
  inv.*slot = get(*node);
  set(*node, e.*slot);
  return inv;
}

}  // namespace celestrian::edit_internal
