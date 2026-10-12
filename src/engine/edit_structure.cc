// AudioEngine — the STRUCTURE appliers: Insert, Remove, Move, Combine
// and Explode. A node that leaves the graph rides the inverse whole (the
// same object comes back on undo, uuid and state intact) and is retired
// only with its log entry (retireEdit). Message thread only.

#include "../audio_engine.h"

#include "../clip_node.h"
#include "../stack_node.h"
#include "edit_internal.h"
#include "engine_internal.h"

namespace {
using celestrian::AudioNode;
using celestrian::Edit;
using celestrian::StackNode;
using celestrian::edit_internal::captureIsland;
using celestrian::edit_internal::isWithin;

/** A subtree about to (re-)enter the graph takes the device's rate: the
 * log held it detached, out of the device-start sweep's reach
 * (AudioEngine::audioDeviceAboutToStart). Nothing runs these racks until
 * the node is inserted and published. */
void followRackRate(AudioNode& subtree, double rate) {
  celestrian::engine_internal::forEachNode(subtree, [rate](AudioNode& node) {
    node.fxChain()->followRate(rate);
    node.fxScope().followRate(rate);
  });
}
}  // namespace

Edit AudioEngine::applyInsert(Edit e) {
  auto* parent = dynamic_cast<StackNode*>(findNodeByUuid(e.parentUuid));
  if (!parent || !e.node) return {};
  Edit inv(Edit::Kind::Remove);
  inv.uuid = e.node->getUuid();
  // Undo of a delete that re-opened the definer (uuid2): it collapses
  // again, by the forward Collapse's own derivation — FIRST, on the graph
  // the re-open ran on (the deleted node still out), so the collapse
  // judges the same ancestors and leaves the re-open did.
  if (e.uuid2.isNotEmpty()) {
    if (auto* definer_node = findNodeByUuid(e.uuid2)) {
      CollapseFacts facts;
      collapseNode(*definer_node, facts);
    }
  }
  followRackRate(*e.node, currentSampleRateOrFallback());
  parent->insertChildAt(std::move(e.node), e.index);
  // Undo of a delete that emptied the island: the grid and the songs it
  // cleared come back with the content. The Remove that redoes it derives
  // the revert again, so the inverse carries no island payload.
  if (e.setsIsland) setIslandQuantum(e.iq, e.izero, inv);
  reinstallSequenceRiders(e);
  return inv;
}

Edit AudioEngine::applyRemove(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node || node == root_node.get()) return {};
  int index = -1;
  auto* parent = parentOf(node, &index);
  if (!parent || index < 0) return {};
  Edit inv(Edit::Kind::Insert);
  inv.parentUuid = parent->getUuid();
  inv.index = index;
  const int committed_before = islandCommittedClipCount();
  inv.node = parent->removeChild(index);  // detached, owned by the inverse
  const bool removed_content = islandCommittedClipCount() < committed_before;
  // Q IS NOT STICKY (Q13): a delete that leaves no committed content
  // leaves nothing to define Q — it reverts, and the old (Q, zero) and
  // the songs cleared with it ride the inverse.
  if (islandCommittedClipCount() == 0 && root_node->getQuantum() != 0) {
    captureIsland(*root_node, inv);
    setIslandQuantum(0, 0, inv);
  }
  // A delete that removed content may leave a lock-collapsed definer as
  // the island's sole content: it re-opens (reopenCollapsed), and the
  // inverse names it so undo collapses it again.
  if (auto* definer_node =
          removed_content ? celestrian::engine_internal::definer(*root_node)
                          : nullptr;
      definer_node != nullptr && reopenCollapsed(*definer_node)) {
    inv.uuid2 = definer_node->getUuid();
  }
  return inv;
}

Edit AudioEngine::applyMove(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  auto* new_parent = dynamic_cast<StackNode*>(findNodeByUuid(e.parentUuid));
  if (!node || !new_parent || node == root_node.get()) return {};
  // The destination must not lie inside the moved subtree: a stack
  // inserted into its own descendant owns itself, and the parent walks
  // (rootNode, the origin lift) never terminate.
  if (isWithin(new_parent, node)) return {};
  int old_index = -1;
  auto* old_parent = parentOf(node, &old_index);
  if (!old_parent || old_index < 0) return {};
  new_parent->insertChildAt(old_parent->removeChild(old_index), e.index);
  Edit inv(Edit::Kind::Move);
  inv.uuid = e.uuid;
  inv.parentUuid = old_parent->getUuid();
  inv.index = old_index;
  return inv;
}

Edit AudioEngine::applyCombine(Edit e) {
  auto* dragged = findNodeByUuid(e.uuid);
  auto* target = findNodeByUuid(e.uuid2);
  if (!dragged || !target || dragged == target) return {};
  // Neither may hold the other (see applyMove): a group combined with
  // its own member would be inserted into itself, or wrap the stack its
  // member still names as its parent.
  if (isWithin(dragged, target) || isWithin(target, dragged)) return {};
  int dragged_index = -1, target_index = -1;
  auto* dragged_parent = parentOf(dragged, &dragged_index);
  auto* target_parent = parentOf(target, &target_index);
  if (!dragged_parent || !target_parent || dragged_index < 0 ||
      target_index < 0) {
    return {};
  }
  // The stack takes the target's slot — one to the left once a dragged
  // sibling ahead of it has left.
  const bool dragged_ahead =
      dragged_parent == target_parent && dragged_index < target_index;
  const int slot = target_index - (dragged_ahead ? 1 : 0);
  auto dragged_owned = dragged_parent->removeChild(dragged_index);
  auto target_owned = target_parent->removeChild(slot);
  // The redo of a Combine reuses the stack its Explode emptied (`node`),
  // so the group keeps its uuid, name, sequence, rack, mute and window
  // and later entries addressed to it still resolve. Only a fresh
  // combine builds a stack.
  std::unique_ptr<StackNode> new_stack;
  if (auto* reused = dynamic_cast<StackNode*>(e.node.get())) {
    e.node.release();
    new_stack.reset(reused);
  } else {
    new_stack = std::make_unique<StackNode>("Combined Stack");
  }
  followRackRate(*new_stack, currentSampleRateOrFallback());
  new_stack->addChild(std::move(target_owned));   // index 0
  new_stack->addChild(std::move(dragged_owned));  // index 1
  Edit inv(Edit::Kind::Explode);
  inv.uuid = new_stack->getUuid();
  inv.parentUuid = target_parent->getUuid();
  inv.index = target_index;
  inv.parentUuid2 = dragged_parent->getUuid();
  inv.index2 = dragged_index;
  target_parent->insertChildAt(std::move(new_stack), slot);
  return inv;
}

Edit AudioEngine::applyExplode(Edit e) {
  auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(e.uuid));
  if (!stack || stack->getNumChildren() != 2) return {};
  // Every destination resolves before anything is detached: a refusal
  // leaves the graph exactly as the published snapshot lists it.
  int stack_index = -1;
  auto* stack_parent = parentOf(stack, &stack_index);
  auto* target_parent = dynamic_cast<StackNode*>(findNodeByUuid(e.parentUuid));
  auto* dragged_parent =
      dynamic_cast<StackNode*>(findNodeByUuid(e.parentUuid2));
  if (!stack_parent || stack_index < 0 || !target_parent || !dragged_parent) {
    return {};
  }
  // The emptied stack leaves first and rides the inverse, so the Combine
  // that undoes this re-installs the same object.
  Edit inv(Edit::Kind::Combine);
  inv.node = stack_parent->removeChild(stack_index);
  auto target_owned = stack->removeChild(0);
  auto dragged_owned = stack->removeChild(0);
  inv.uuid = dragged_owned->getUuid();
  inv.uuid2 = target_owned->getUuid();
  // With the stack gone the indices are the slots the two children left:
  // the lower slot first reproduces a shared parent's arrangement
  // exactly, whatever sat between them.
  if (e.index <= e.index2) {
    target_parent->insertChildAt(std::move(target_owned), e.index);
    dragged_parent->insertChildAt(std::move(dragged_owned), e.index2);
  } else {
    dragged_parent->insertChildAt(std::move(dragged_owned), e.index2);
    target_parent->insertChildAt(std::move(target_owned), e.index);
  }
  return inv;
}
