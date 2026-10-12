// AudioEngine — the GEOMETRY appliers: a node's map (LoopPoints,
// Segments, LoopBypass), the lock-collapse and its splice (Collapse), the
// re-time (Timing) and the Q hand-off (Definer), with what rides them:
// the top, the bypass, the window domain, member windows, the origin and
// the island's (Q, zero). Message thread only.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "edit_internal.h"
#include "engine_internal.h"

namespace {
using celestrian::AudioNode;
using celestrian::ClipNode;
using celestrian::Edit;
using celestrian::StackNode;
using celestrian::edit_internal::captureIsland;
using celestrian::edit_internal::swapFact;
using celestrian::timing::TimeMap;

/** S16 (sequencer.md §11.8): a map edit on a STACK stamps the window's
 * domain — the sequence timeline when authored over an active sequence,
 * or the edit's explicit stamp (an inverse) — and the inverse captures
 * the old stamp. A clip has no sequence. */
void stampWindowDomain(AudioNode* node, const Edit& e, Edit& inv) {
  auto* stack = dynamic_cast<StackNode*>(node);
  if (stack == nullptr) return;
  inv.window_domain = (int)stack->windowDomain();
  const int fresh = e.window_domain >= 0
                        ? e.window_domain
                        : (stack->activeSequence() != nullptr ? 1 : 0);
  stack->setWindowDomain((StackNode::WindowDomain)fresh);
}

/** THE TOP RIDES THE MAP (loop_selection.md §9), clip or group: call
 * right after a map edit has set `node`'s geometry, with the EFFECTIVE
 * top read before it (`top_before` — a top never stored reconciles from
 * where it showed). The inverse takes the old stored top; then the top is
 * set exactly (`setsTop`: an inverse) or RECONCILED and stored — kept
 * while the new map plays it, else the new region start. A live commit
 * reconciles from the base its gesture started with (`topBase`), which
 * the gesture's entry holds for the commits after it (record), so a drag
 * that sweeps past the top and back keeps it. */
void reconcileTopRider(AudioNode* node, const Edit& e, Edit& inv,
                       int64_t top_before) {
  inv.setsTop = true;
  inv.itop = node->storedTop();
  if (e.setsTop) {
    node->setStoredTop(e.itop);
    return;
  }
  const int64_t base = e.hasTopBase ? e.topBase : top_before;
  inv.hasTopBase = true;
  inv.topBase = base;
  node->setStoredTop(celestrian::timing::reconcileTop(
      node->storedMap(), node->isLoopWindowActive(),
      node->getIntrinsicDuration(), base));
}

/** THE BYPASS RIDES THE MAP: call right after a map edit has set `node`'s
 * geometry. The inverse takes the bypass flag; then the flag is set
 * exactly (`restoresBypass`: an inverse), or drops with a geometry the
 * edit cleared — whole is no window, and one left bypassed would make the
 * next window drawn silently inert. */
void bypassRider(AudioNode* node, const Edit& e, Edit& inv) {
  inv.restoresBypass = true;
  inv.bypassed = node->isLoopWindowBypassed();
  if (e.restoresBypass) {
    node->setLoopWindowBypassed(e.bypassed);
  } else if (node->storedMap().n == 0) {
    node->setLoopWindowBypassed(false);
  }
}

/** The LEAVES a lock-collapse acts on: a clip is its own; a stack's are
 * its committed direct clip members, the one take they were recorded
 * as. */
std::vector<ClipNode*> collapseLeaves(AudioNode& node) {
  if (auto* clip = dynamic_cast<ClipNode*>(&node)) return {clip};
  std::vector<ClipNode*> leaves;
  if (auto* stack = dynamic_cast<StackNode*>(&node)) {
    for (const auto& child : stack->ownedChildren()) {
      auto* clip = dynamic_cast<ClipNode*>(child.get());
      if (clip != nullptr && clip->getIntrinsicDuration() > 0) {
        leaves.push_back(clip);
      }
    }
  }
  return leaves;
}

/** Every sequence in the island, copied into `inv`'s riders. */
void captureSequences(StackNode& root, Edit& inv) {
  celestrian::engine_internal::forEachStack(root, [&inv](StackNode& stack) {
    const celestrian::Sequence* seq = stack.sequencePtr();
    if (seq == nullptr) return;
    Edit::SeqRider rider;
    rider.uuid = stack.getUuid();
    rider.seq = std::make_unique<celestrian::Sequence>(*seq);
    inv.seq_riders.push_back(std::move(rider));
  });
}
}  // namespace

// --- Riders -----------------------------------------------------------

void AudioEngine::applyWindowRiders(const Edit& e, Edit& inv) {
  for (const auto& rider : e.windows) {
    auto* node = findNodeByUuid(rider.uuid);
    if (node == nullptr) continue;
    // The inverse rider holds the node's RAW geometry, whatever its
    // shape, and its stored top.
    Edit::WindowRider back;
    back.uuid = rider.uuid;
    back.start = node->getLoopStart();
    back.end = node->getLoopEnd();
    back.setsMap = true;
    back.tmap = node->storedMap();
    const int64_t top_before = node->effectiveTop();
    back.setsTop = true;
    back.top = node->storedTop();
    inv.windows.push_back(std::move(back));
    if (rider.setsMap && rider.tmap.n >= 2) {
      node->setMap(rider.tmap);
    } else {
      node->setLoopPoints(rider.start, rider.end);
    }
    // The node's top rides its map as the edit's own does.
    node->setStoredTop(rider.setsTop
                           ? rider.top
                           : celestrian::timing::reconcileTop(
                                 node->storedMap(), node->isLoopWindowActive(),
                                 node->getIntrinsicDuration(), top_before));
  }
}

void AudioEngine::liftAncestorsGated(AudioNode& node, int64_t delta,
                                     uint32_t gate) {
  // AN ANCESTOR IS ANCHORED ON THE NODE while the node's subtree holds
  // all of its committed content: its origin is that content's, and
  // follows it. One that holds other content is anchored on that too —
  // its inner timeline is theirs, and a move of this one member re-times
  // nothing in it — so it stays, and so does everything above it.
  const int inside = celestrian::engine_internal::countCommittedClips(node);
  for (auto* p = node.getParent(); p != nullptr; p = p->getParent()) {
    if (celestrian::engine_internal::countCommittedClips(*p) != inside) break;
    if (p->isAnchored()) {
      p->setOriginGated(p->origin_samples.load() + delta, gate);
    }
  }
}

void AudioEngine::applySetsIsland(Edit& e, Edit& inv, uint32_t generation) {
  if (!e.setsIsland) return;
  captureIsland(*root_node, inv);
  // A Q → Q' re-establishment rescales every song, rounding each length:
  // the inverse holds the songs as they are now and puts them back whole
  // after its own rescale.
  if (inv.iq > 0 && e.iq > 0 && e.iq != inv.iq) {
    captureSequences(*root_node, inv);
  }
  setIslandQuantum(e.iq, e.izero, inv, generation);
  reinstallSequenceRiders(e);
}

void AudioEngine::applyOriginAndIsland(AudioNode& node, Edit& e, Edit& inv) {
  // A re-anchored origin is GATED on a fresh island generation, and the
  // island facts that name the generation publish after it — so the
  // origins and the zero land in the same block.
  const uint32_t generation =
      e.setsOrigin ? root_node->nextIslandGeneration() : 0;
  applySetsOrigin(node, e, inv, generation);
  if (e.setsIsland) {
    applySetsIsland(e, inv, generation);
  } else if (generation != 0) {
    root_node->setIslandFacts(root_node->getQuantum(), root_node->getZero(),
                              generation);
  }
}

// --- The map ----------------------------------------------------------

Edit AudioEngine::applyLoopPoints(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node) return {};
  // The inverse holds the RAW old map, whatever its shape: a window that
  // replaced a cell map puts the cell map back.
  Edit inv(Edit::Kind::LoopPoints);
  inv.uuid = e.uuid;
  inv.i1 = node->getLoopStart();
  inv.i2 = node->getLoopEnd();
  inv.setsMap = true;
  inv.tmap = node->storedMap();
  const int64_t top_before = node->effectiveTop();
  // The domain is stamped BEFORE the top reconciles (here and in
  // applySegments): a window re-drawn while its song is off is in force
  // from this edit on, and the top lands on the region as it now plays.
  stampWindowDomain(node, e, inv);
  if (e.setsMap && e.tmap.n >= 2) {
    node->setMap(e.tmap);
  } else {
    node->setLoopPoints(e.i1, e.i2);
  }
  reconcileTopRider(node, e, inv, top_before);
  bypassRider(node, e, inv);
  applyWindowRiders(e, inv);
  applyOriginAndIsland(*node, e, inv);
  return inv;
}

Edit AudioEngine::applySegments(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node) return {};
  // The inverse holds the RAW old map — never activeTimeMap(), which
  // reads empty under a bypass and would lose a bypassed node's geometry.
  Edit inv(Edit::Kind::Segments);
  inv.uuid = e.uuid;
  inv.setsMap = true;
  inv.tmap = node->storedMap();
  const int64_t top_before = node->effectiveTop();
  stampWindowDomain(node, e, inv);
  node->setMap(e.tmap);
  reconcileTopRider(node, e, inv, top_before);
  bypassRider(node, e, inv);
  applyWindowRiders(e, inv);
  applyOriginAndIsland(*node, e, inv);
  return inv;
}

Edit AudioEngine::applyLoopBypass(Edit e) {
  // The stored top stays: a bypass toggles whether the map applies, not
  // what it keeps.
  return swapFact<AudioNode>(
      findNodeByUuid(e.uuid), e, &Edit::b1,
      [](AudioNode& node) { return node.isLoopWindowBypassed(); },
      [](AudioNode& node, bool bypassed) {
        node.setLoopWindowBypassed(bypassed);
      });
}

// --- The lock-collapse ------------------------------------------------

// Q13 LOCK-COLLAPSE (composition.md §5; one law for a clip and a stack):
// a window on the island's definer is a trim made before the lock, and
// at the next arm it BECOMES the take. The leaves under the node
// (collapseLeaves) keep the window's material as their whole content;
// the node and its subtree move by the window start, so the window's top
// is their origin; the ancestors anchored on the node follow
// (liftAncestorsGated); the window is consumed.
// Audio-neutral — inner s + ((t − O − s) mod len) before is base s +
// ((t − (O + s)) mod len) after — and (Q, zero) stay: the trim already
// established them. Without it an incommensurate buffer would stay alive
// under every boundary computation of the takes that follow.
bool AudioEngine::collapseNode(AudioNode& node, CollapseFacts& facts) {
  // The STORED window only: a step audition overrides activeTimeMap(),
  // and collapsing to that would make a monitoring gesture the take. A
  // cell map is not a single window — a clip's splices (spliceAtLock), a
  // stack's is nothing to collapse.
  if (node.isLoopWindowBypassed() || node.hasSegmentMap()) return false;
  const auto leaves = collapseLeaves(node);
  if (leaves.empty()) return false;
  const int64_t duration = leaves[0]->getIntrinsicDuration();
  for (auto* leaf : leaves) {
    if (leaf->getIntrinsicDuration() != duration) return false;  // not one take
  }
  const int64_t start = std::max<int64_t>(0, node.getLoopStart());
  const int64_t end = std::min(node.getLoopEnd(), duration);
  const int64_t length = end - start;
  // No window, or one spanning the whole take: nothing to collapse.
  if (length <= 0 || (start == 0 && end >= duration)) return false;
  for (auto* leaf : leaves) leaf->collapseContent(start, length);
  // A group's own top is the same raw sample, `start` earlier in the new
  // take (a clip's rides inside collapseContent).
  if (node.getNodeType() == celestrian::NodeType::Stack) {
    if (const int64_t top = node.storedTop();
        top != celestrian::timing::kNoTop) {
      node.setStoredTop(top - start);
    }
  }
  shiftOriginsGated(node, start, 0);
  liftAncestorsGated(node, start, 0);
  node.setLoopPoints(0, 0);
  facts.shift = start;
  facts.old_duration = duration;
  facts.win_start = start;
  facts.win_end = end;
  return true;
}

void AudioEngine::uncollapseNode(AudioNode& node, int64_t shift,
                                 int64_t old_duration, int64_t win_start,
                                 int64_t win_end) {
  const bool is_stack = node.getNodeType() == celestrian::NodeType::Stack;
  for (auto* leaf : collapseLeaves(node)) {
    if (!leaf->isCollapsed()) continue;
    leaf->uncollapseContent(shift, old_duration);
    // A stack's members stay whole: the restored window is the stack's.
    if (is_stack) leaf->setLoopPoints(0, 0);
  }
  if (is_stack) {
    if (const int64_t top = node.storedTop();
        top != celestrian::timing::kNoTop) {
      node.setStoredTop(top + shift);
    }
  }
  shiftOriginsGated(node, -shift, 0);
  liftAncestorsGated(node, -shift, 0);
  node.setLoopPoints(win_start, win_end);
}

bool AudioEngine::reopenCollapsed(AudioNode& node) {
  // A lock-collapsed node RE-OPENS — the full takes return with the old
  // trim as the node's window, so the same loop plays and it can be
  // trimmed longer again — exactly when its leaves carry the collapse
  // marker (ClipNode::isCollapsed; never inferred from a take's overshoot
  // past its duration, which every snapped take has) and nothing was
  // authored on the node or its leaves since: geometry given after the
  // lock would be replaced by the old trim.
  const auto leaves = collapseLeaves(node);
  if (leaves.empty() || !leaves[0]->isCollapsed()) return false;
  if (node.storedMap().n > 0) return false;
  for (auto* leaf : leaves) {
    if (leaf->storedMap().n > 0) return false;
  }
  const int64_t unwound = leaves[0]->getContentBase();
  uncollapseNode(node, unwound, leaves[0]->collapsedFrom(), unwound,
                 unwound + leaves[0]->getIntrinsicDuration());
  return true;
}

void AudioEngine::spliceAtLock(ClipNode& clip, Edit& inv) {
  // A clip's CELL MAP collapses by a SPLICE: the kept cells become the
  // take, and the inverse owns everything the splice displaces — the
  // buffer (compacted to the heap first: a buffer referring to reserved
  // storage must not be the one an entry owns), every other take of the
  // slot, a MIDI take's notes — with the facts that put them back.
  const TimeMap map = clip.storedMap();
  compactClipToHeap(clip);
  inv.b1 = true;
  inv.setsMap = true;
  inv.tmap = map;
  // The pre-splice origin is an absolute: it rides `iorg`, which a seek
  // re-frames (shiftHistoryAbsolutes).
  inv.setsOrigin = true;
  inv.iorg = clip.origin_samples.load();
  inv.old_duration = clip.getIntrinsicDuration();
  inv.i1 = clip.getContentBase();
  inv.i2 = clip.recordedLength();
  inv.collapsed_from = clip.collapsedFrom();
  inv.setsTop = true;
  inv.itop = clip.storedTop();
  inv.cells = clip.compCells();
  inv.cell_len = clip.compCellLength();
  inv.cell_off = clip.compCellOffset();
  // The other takes and the notes splice BEFORE spliceToMap rewrites the
  // base they share.
  inv.other_takes = clip.spliceOtherTakesToMap(map);
  if (clip.contentKind() == ClipNode::ContentKind::Midi) {
    inv.midi = clip.spliceMidiToMap(map);
  }
  inv.buffer = clip.spliceToMap(map, &inv.other_takes);
  liftAncestorsGated(clip, map.mapOffset(0), 0);  // origin += a0 (Q18)
}

void AudioEngine::unspliceAtLock(ClipNode& clip, Edit& e) {
  const int64_t origin_before = clip.origin_samples.load();
  retireOwned(clip.unspliceFromMap(std::move(e.buffer), e.iorg, e.old_duration,
                                   e.i1, e.i2, e.collapsed_from,
                                   e.setsTop ? e.itop : clip.storedTop()));
  liftAncestorsGated(clip, clip.origin_samples.load() - origin_before, 0);
  if (e.midi) retireOwned(clip.unspliceMidi(std::move(e.midi)));
  for (auto& displaced : clip.unspliceOtherTakes(std::move(e.other_takes))) {
    retireOwned(std::move(displaced.buffer));
    retireOwned(std::move(displaced.midi));
  }
  clip.setMap(e.tmap);
  clip.setCompCells(e.cells, e.cell_len, e.cell_off);
}

Edit AudioEngine::applyCollapse(Edit e) {
  auto* node = findNodeByUuid(e.uuid);
  if (!node) return {};
  auto* clip = dynamic_cast<ClipNode*>(node);
  // The forward carries nothing and DERIVES from the node's map; its
  // inverse (b1) carries the raw facts that undo it, and that inverse's
  // own inverse is the bare forward again.
  Edit inv(Edit::Kind::Collapse);
  inv.uuid = e.uuid;
  if (!e.b1) {
    // A bypassed map is not in use: the take plays whole, so there is no
    // trim to make the take. The map stays stored, and bypassed.
    if (node->isLoopWindowBypassed()) return {};
    if (clip != nullptr && clip->hasSegmentMap()) {
      spliceAtLock(*clip, inv);
      return inv;
    }
    CollapseFacts facts;
    if (!collapseNode(*node, facts)) return {};
    inv.b1 = true;
    inv.shift = facts.shift;
    inv.old_duration = facts.old_duration;
    inv.win_start = facts.win_start;
    inv.win_end = facts.win_end;
  } else if (e.setsMap) {
    if (clip == nullptr) return {};
    unspliceAtLock(*clip, e);
  } else {
    uncollapseNode(*node, e.shift, e.old_duration, e.win_start, e.win_end);
  }
  return inv;
}

// --- The re-time and the Q hand-off -----------------------------------

Edit AudioEngine::applyTiming(Edit e) {
  // THE RE-TIME (loop_selection.md §9): the node's origin, re-time and
  // (optionally) top land as one edit, all ABSOLUTE values, so the
  // inverse is the same shape. The origin is a SHIFT on the gated path —
  // no continuity solve, no ancestor lift, and the edit carries no island
  // facts. A group's shift moves its whole subtree (applySetsOrigin), so
  // its members keep their placement inside it.
  auto* node = findNodeByUuid(e.uuid);
  if (!node || node == root_node.get()) return {};
  Edit inv(Edit::Kind::Timing);
  inv.uuid = e.uuid;
  inv.setsTop = true;
  inv.itop = node->storedTop();
  inv.setsRetime = true;
  inv.iretime = node->retime();
  applyOriginAndIsland(*node, e, inv);
  if (e.setsRetime) node->setRetime(e.iretime);
  if (e.setsTop) node->setStoredTop(e.itop);
  return inv;
}

Edit AudioEngine::applyDefiner(Edit e) {
  // THE Q HAND-OFF (Q22): the designation (`s1`) and the grid swap, each
  // captured into the inverse. With a node (`uuid`) the forward first
  // re-opens it if it was lock-collapsed, so its region can grow again,
  // and the inverse (b1) collapses it again. Without one it is the
  // designation alone: the lock that ends a hand-off (applyArmEdits).
  AudioNode* node = nullptr;
  if (e.uuid.isNotEmpty()) {
    node = findNodeByUuid(e.uuid);
    if (node == nullptr || node == root_node.get()) return {};
  }
  auto* clip = dynamic_cast<ClipNode*>(node);
  Edit inv(Edit::Kind::Definer);
  inv.uuid = e.uuid;
  // A clip's top is swapped on the take the re-open exposes, so it is
  // read and restored in the re-opened content's coordinates: after the
  // re-open, before the re-collapse.
  const auto swapTop = [&] {
    if (clip == nullptr || !e.setsTop) return;
    inv.setsTop = true;
    inv.itop = clip->storedTop();
    clip->setStoredTop(e.itop);
  };
  if (node != nullptr && e.b1) {
    swapTop();
    CollapseFacts facts;
    collapseNode(*node, facts);  // to the window the re-open restored
  } else if (node != nullptr) {
    if (reopenCollapsed(*node)) inv.b1 = true;
    swapTop();
  }
  inv.s1 = root_node->definerDesignation();
  root_node->setDefinerDesignation(e.s1);
  // No origin moves with the grid (a re-open's are ungated), so the facts
  // publish on the current generation.
  applySetsIsland(e, inv, 0);
  return inv;
}
