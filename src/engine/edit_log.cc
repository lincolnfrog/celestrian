// AudioEngine — the EDIT LOG: applyEdit / applyEditImpl (one mutation
// per Edit kind, returning its inverse), the window-domain and window
// riders, the group lock-collapse pair, retirement of detached
// payloads, and the undo / redo stacks (record, pushUndo, undo, redo,
// deleteNode). Message thread only.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../dsp/vst3_slot.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"


// ===================================================================
// Edits-as-events: apply / undo / redo (unification_audit.md §2.2)
// Message thread only. applyEdit performs one mutation and returns its
// INVERSE (Nop if it could not apply); the undo stack is a list of
// inverses, redo a list of forwards. Symmetric per kind, so applying an
// inverse reproduces the forward (that is redo). The audio thread sees
// only the resulting atomics and snapshots, never the edits.
// ===================================================================

namespace {
using celestrian::Edit;
// A LIVE drag collapses into ONE undo step: seam/grip drags stream
// throttled map commits so the splice is AUDIBLE while dragging
// (time_maps.md), and every commit after the gesture's first arrives
// with Edit::live. When such a commit targets the same node as the top
// of the stack, the older inverse already restores further back, so
// the new one is dropped. OWNER RULING 2026-09-10: only live commits
// coalesce — two separate cut gestures on one lane, however close in
// time, are two undo steps (they used to merge unconditionally). A
// gesture's commits may change kind midway (a window becoming a
// segment override), so both map kinds pair.
bool isMapKind(Edit::Kind k) {
  return k == Edit::Kind::Segments || k == Edit::Kind::LoopPoints;
}
bool editsCoalesce(const Edit& top, const Edit& fresh, bool live) {
  if (!live || top.uuid != fresh.uuid) return false;
  return isMapKind(top.kind) && isMapKind(fresh.kind);
}
}  // namespace

void AudioEngine::liftAncestorsGated(celestrian::AudioNode& node,
                                     int64_t delta, uint32_t gate) {
  for (auto* p = node.getParent(); p != nullptr; p = p->getParent()) {
    if (p->isAnchored()) {
      p->setOriginGated(p->origin_samples.load() + delta, gate);
    }
  }
}

celestrian::Edit AudioEngine::applyEdit(celestrian::Edit e) {
  using K = celestrian::Edit::Kind;
  const K kind = e.kind;
  // Anchor riders (Q18): an undo/redo carries the exact anchoring the
  // settle below produced the first time.
  const bool content_edit =
      kind == K::Insert || kind == K::Remove || kind == K::Move ||
      kind == K::Combine || kind == K::Explode || kind == K::Take ||
      kind == K::Untake;
  const bool had_anchor_riders = !e.anchors.empty();
  celestrian::Edit anchor_riders_in;
  if (had_anchor_riders) anchor_riders_in.anchors = std::move(e.anchors);
  celestrian::Edit inv = applyEditImpl(std::move(e));
  if (inv.kind != K::Nop && content_edit) {
    if (had_anchor_riders) applyAnchorRiders(anchor_riders_in, inv);
    settleAnchors(inv);
  }
  // Structural mutations re-publish the whole-graph snapshot:
  // record/undo/redo all funnel through here, so this is the one place
  // topology changes become visible to the audio thread.
  if (inv.kind != K::Nop &&
      (kind == K::Insert || kind == K::Remove || kind == K::Move ||
       kind == K::Combine || kind == K::Explode)) {
    scrubNestedIslandFacts();
    publishGraph();
  }
  return inv;
}

namespace {
/** S16 (docs/sequencer.md §11.8): a window edit on a STACK stamps the
 * window's domain — sequence when authored over an active sequence
 * timeline (explicit on inverses) — and the inverse captures the old
 * stamp. Clips have no sequence: no-op. */
void stampWindowDomain(celestrian::AudioNode* node, const celestrian::Edit& e,
                       celestrian::Edit& inv) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(node);
  if (stack == nullptr) return;
  inv.window_domain = (int)stack->windowDomain();
  const int fresh = e.window_domain >= 0
                        ? e.window_domain
                        : (stack->activeSequence() != nullptr ? 1 : 0);
  stack->setWindowDomain((celestrian::StackNode::WindowDomain)fresh);
}

/** Apply an edit's WINDOW RIDERS (Edit::windows): set each named node's
 * single-window loop points, capturing the old ones into the inverse
 * so the riders undo with the edit. A node with a multi-segment
 * override is left alone (its map is not a single window). */
void applyWindowRiders(
    const std::function<celestrian::AudioNode*(const juce::String&)>& find,
    const celestrian::Edit& e, celestrian::Edit& inv) {
  for (const auto& r : e.windows) {
    auto* node = find(r.uuid);
    if (node == nullptr) continue;
    celestrian::Edit::WindowRider back;
    back.uuid = r.uuid;
    back.start = node->getLoopStart();
    back.end = node->getLoopEnd();
    // The inverse rider carries the member's RAW geometry, whatever its
    // shape — a cell map goes whole with the rest and comes back on undo.
    back.setsMap = true;
    back.tmap = node->storedMap();
    inv.windows.push_back(std::move(back));
    if (r.setsMap && r.tmap.n >= 2) {
      node->setMap(r.tmap);
    } else {
      node->setLoopPoints(r.start, r.end);
    }
  }
}

/** A take left the list at index k (docs/takes.md): comp cells naming
 * it fall back to the active take, cells above it renumber; a comp
 * naming nothing anymore clears. */
void dropTakeFromComp(celestrian::ClipNode& clip, int k) {
  std::vector<int> cells = clip.compCells();
  if (cells.empty()) return;
  bool any = false;
  for (int& c : cells) {
    if (c == k) c = -1;
    else if (c > k) --c;
    if (c >= 0) any = true;
  }
  if (any) clip.setCompCells(cells, clip.compCellLength());
  else clip.setCompCells({}, 0);
}

/** The definer STACK's committed direct members (one take). */
std::vector<celestrian::ClipNode*> stackMembers(celestrian::StackNode& stack) {
  std::vector<celestrian::ClipNode*> out;
  for (const auto& child : stack.ownedChildren()) {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(child.get());
    if (clip != nullptr && clip->getIntrinsicDuration() > 0) out.push_back(clip);
  }
  return out;
}

/** The LEAVES a lock-collapse acts on: a clip is its own leaf; a
 * stack's are its direct clip members (the one take they were
 * recorded as). */
std::vector<celestrian::ClipNode*> collapseLeaves(celestrian::AudioNode& node) {
  if (auto* clip = dynamic_cast<celestrian::ClipNode*>(&node)) return {clip};
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(&node)) {
    return stackMembers(*stack);
  }
  return {};
}
}  // namespace

bool AudioEngine::collapseNode(celestrian::AudioNode& node, CollapseFacts& f) {
  // RAW window atomics only: activeTimeMap() is overridden by a STEP
  // AUDITION's derived map — collapsing to that would make a monitoring
  // gesture the take and destroy the authored window. A multi-segment
  // map is not a single window: a clip's SPLICES (the applier's other
  // branch), a stack's is nothing to collapse.
  if (node.isLoopWindowBypassed() || node.hasSegmentMap()) return false;
  const auto leaves = collapseLeaves(node);
  if (leaves.empty()) return false;
  const int64_t D = leaves[0]->getIntrinsicDuration();
  for (auto* leaf : leaves) {
    if (leaf->getIntrinsicDuration() != D) return false;  // not one take
  }
  const int64_t s = std::max<int64_t>(0, node.getLoopStart());
  const int64_t e = std::min(node.getLoopEnd(), D);
  const int64_t len = e - s;
  // Full-span (or invalid) window: nothing to collapse.
  if (len <= 0 || (s == 0 && e >= D)) return false;
  // THE ONE ROW (composition.md §5): leaves keep the window's material
  // as their whole content; window top → origin for the node AND its
  // subtree (Q18 — a window anchors at its node's origin, so the
  // subtree moves together, no per-member riders); anchored ancestors
  // follow. Audio-neutral: inner s + ((t − O − s) mod len) before ==
  // base s + ((t − (O + s)) mod len) after.
  for (auto* leaf : leaves) leaf->collapseContent(s, len);
  shiftOriginsGated(node, s, 0);
  liftAncestorsGated(node, s, 0);
  // The window is consumed (the take IS the window now) — clip or stack.
  node.setLoopPoints(0, 0);
  f.shift = s;
  f.old_duration = D;
  f.win_start = s;
  f.win_end = e;
  return true;
}

void AudioEngine::uncollapseNode(celestrian::AudioNode& node, int64_t shift,
                                 int64_t old_duration, int64_t win_start,
                                 int64_t win_end) {
  const bool is_stack = node.getNodeType() == celestrian::NodeType::Stack;
  for (auto* leaf : collapseLeaves(node)) {
    if (!leaf->isCollapsed()) continue;
    leaf->uncollapseContent(shift, old_duration);
    // Members stay whole (no window); the restored window is the stack's.
    if (is_stack) leaf->setLoopPoints(0, 0);
  }
  shiftOriginsGated(node, -shift, 0);
  liftAncestorsGated(node, -shift, 0);
  node.setLoopPoints(win_start, win_end);
}

void AudioEngine::collapseDefinerAtArm(const celestrian::AudioNode* exclude) {
  // Q13 LOCK-COLLAPSE at arm: a provisionally trimmed definer — clip or
  // stack, one law — collapses to its window BEFORE the arm, so every
  // boundary computation (context loop, cycle snapshots, LCMs) sees an
  // ordinary whole-Q looper; an incommensurate buffer left alive would
  // poison them all (the next take anchors at origin − epoch ∉ Q·Z).
  // Undoable — ⌘Z restores the full buffer and the trim. The applier
  // records nothing when there is nothing to collapse.
  auto* d = celestrian::engine_internal::definer(*root_node);
  if (d == nullptr || d == exclude) return;
  celestrian::Edit e(celestrian::Edit::Kind::Collapse);
  e.uuid = d->getUuid();
  record(std::move(e));
}

celestrian::Edit AudioEngine::applyEditImpl(celestrian::Edit e) {
  using celestrian::AudioNode;
  using celestrian::StackNode;
  using K = Edit::Kind;
  auto find = [&](const juce::String& u) {
    return findNodeByUuid(root_node.get(), u);
  };
  auto asStack = [&](const juce::String& u) {
    return dynamic_cast<StackNode*>(find(u));
  };

  switch (e.kind) {
    case K::Insert: {
      auto* parent = asStack(e.parentUuid);
      if (!parent || !e.node) return {};
      const juce::String uid = e.node->getUuid();
      const bool restoreIsland = e.setsIsland;
      const int64_t iq = e.iq, iepoch = e.iepoch;
      parent->insertChildAt(std::move(e.node), e.index);
      // Restore the island grid this insert carries (undo of a
      // provisional-Q-revert delete). The Remove inverse re-derives the
      // revert on redo, so it needs no island payload.
      Edit inv(K::Remove);
      inv.uuid = uid;
      if (restoreIsland) setIslandQuantum(iq, iepoch, inv);
      // Undo of a clearing revert: the sequences come back with the clip.
      reinstallSequenceRiders(e);
      // Undo of a RE-OPENING delete (uuid2 = the definer that delete
      // uncollapsed): re-collapse it so the locked island is exactly as
      // it was. Same derivation as the forward Collapse (clip or stack,
      // one law); redo's Remove re-derives the uncollapse, so no
      // payload rides back.
      if (e.uuid2.isNotEmpty()) {
        if (auto* definer_node = find(e.uuid2)) {
          CollapseFacts f;
          collapseNode(*definer_node, f);
        }
      }
      return inv;
    }
    case K::Remove: {
      auto* node = find(e.uuid);
      if (!node || node == root_node.get()) return {};
      if (node->isArmedOrRecording()) return {};  // cancel is the verb
      int idx = -1;
      auto* parent = parentOf(node, &idx);
      if (!parent || idx < 0) return {};
      Edit inv(K::Insert);
      inv.parentUuid = parent->getUuid();
      inv.index = idx;
      const int committed_before = islandCommittedClipCount();
      inv.node = parent->removeChild(idx);  // non-retiring detach; owned here
      // A RE-OPEN happens only when this delete actually REMOVED
      // committed content and no take is in flight: deleting an
      // unrelated EMPTY clip mid-take must not uncollapse the definer
      // under the recorder (the arm-time cycle snapshots and the live
      // take's placement run against the definer's intrinsic length).
      const bool reopened = islandCommittedClipCount() < committed_before &&
                            !root_node->hasActiveTake();
      // Provisional Q revert (Q13 non-sticky): if this delete emptied the
      // island of committed content, Q is no longer defined by anything —
      // revert it, carrying the old (Q, epoch) so undo restores the grid
      // together with the clip. A delete that only drops 2→1 leaves Q
      // untouched (it just becomes re-mutable again — derived, no state).
      if (islandCommittedClipCount() == 0 && root_node->getQuantum() != 0) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        setIslandQuantum(0, 0, inv);  // + clears sequences into inv
      }
      // RE-OPEN ⟹ UNCOLLAPSE (companion of collapse-at-arm, Q13): if
      // this delete brought the island back down
      // to its sole take and that take was lock-collapsed (there is
      // trimmed-away material beyond its duration), restore the full
      // buffer with the old trim as the window — audio-neutral by
      // construction (the windowed playback of the restored buffer is
      // sample-identical), and the user can trim LONGER again. The
      // inverse Insert carries uuid2 so undo re-collapses with the
      // re-inserted take; redo re-derives the uncollapse right here.
      // "Was collapsed" is an explicit marker (ClipNode::isCollapsed),
      // never the `write_position > duration` overshoot — every snapped
      // take overshoots by up to a block, so that heuristic would
      // un-collapse ORDINARY takes to an off-grid recorded length.
      // One branch over THE DEFINER NODE (clip or stack — engine_internal::
      // definer): its leaves were lock-collapsed, so unwind ALL levels
      // from the markers — the full takes return with the old trim as
      // the node's window (audio-neutral; trimming longer possible
      // again).
      if (auto* d = reopened ? celestrian::engine_internal::definer(*root_node) : nullptr) {
        const auto leaves = collapseLeaves(*d);
        if (!leaves.empty() && leaves[0]->isCollapsed()) {
          const int64_t unwound = leaves[0]->getContentBase();
          uncollapseNode(*d, unwound, leaves[0]->collapsedFrom(), unwound,
                         unwound + leaves[0]->getIntrinsicDuration());
          inv.uuid2 = d->getUuid();
        }
      }
      return inv;
    }
    case K::Move: {
      auto* node = find(e.uuid);
      auto* newParent = asStack(e.parentUuid);
      if (!node || !newParent || node == root_node.get()) return {};
      // A hot clip (armed or capturing) is not movable: the detach/insert
      // pair would cycle the island's take counter through zero under the
      // live take (Remove refuses for the same reason — cancel is the verb).
      if (node->isArmedOrRecording()) return {};
      // The destination must not lie inside the moved subtree: inserting
      // a stack into its own descendant makes a self-owning cycle, and the
      // parent walks (rootNode, the origin lift) never terminate.
      for (const celestrian::AudioNode* p = newParent; p != nullptr;
           p = p->getParent()) {
        if (p == node) return {};
      }
      int oldIdx = -1;
      auto* oldParent = parentOf(node, &oldIdx);
      if (!oldParent || oldIdx < 0) return {};
      auto owned = oldParent->removeChild(oldIdx);
      newParent->insertChildAt(std::move(owned), e.index);
      Edit inv(K::Move);
      inv.uuid = e.uuid;
      inv.parentUuid = oldParent->getUuid();
      inv.index = oldIdx;
      return inv;
    }
    case K::Combine: {
      auto* dragged = find(e.uuid);
      auto* target = find(e.uuid2);
      if (!dragged || !target || dragged == target) return {};
      // Hot clips are not combinable (see Move): the detach would run the
      // island take counter through zero and register the live take on
      // the new stack's own counter, which nothing scrubs.
      if (dragged->isArmedOrRecording() || target->isArmedOrRecording()) {
        return {};
      }
      int draggedIdx = -1, targetIdx = -1;
      auto* draggedParent = parentOf(dragged, &draggedIdx);
      auto* targetParent = parentOf(target, &targetIdx);
      if (!draggedParent || !targetParent) return {};
      auto draggedOwned = draggedParent->removeChild(draggedIdx);
      // Target index may have shifted if it shared a parent with dragged.
      int tIdx = -1;
      auto* tParent = parentOf(target, &tIdx);
      auto targetOwned = tParent->removeChild(tIdx);
      // Combine/Explode are an inverse PAIR: a redo of a Combine (the
      // inverse of an Explode) reuses the very stack the Explode emptied
      // (carried in `e.node`, the Remove discipline) so the group keeps
      // its uuid, name, sequence, fx, mute and window — and every later
      // redo entry addressed to that uuid still resolves. Only a fresh
      // user Combine builds a new stack.
      std::unique_ptr<StackNode> newStack;
      if (e.node) {
        auto* raw = e.node.release();
        if (auto* reused = dynamic_cast<StackNode*>(raw)) {
          newStack.reset(reused);
        } else {
          delete raw;  // never a stack here; defensive
        }
      }
      if (!newStack) newStack = std::make_unique<StackNode>("Combined Stack");
      newStack->addChild(std::move(targetOwned));   // target first (index 0)
      newStack->addChild(std::move(draggedOwned));  // dragged second (index 1)
      const juce::String newUuid = newStack->getUuid();
      tParent->insertChildAt(std::move(newStack), tIdx);
      Edit inv(K::Explode);
      inv.uuid = newUuid;
      inv.parentUuid = targetParent->getUuid();  // child[0] restore
      inv.index = targetIdx;
      inv.parentUuid2 = draggedParent->getUuid();  // child[1] restore
      inv.index2 = draggedIdx;
      return inv;
    }
    case K::Explode: {
      auto* stack = asStack(e.uuid);
      if (!stack || stack->getNumChildren() != 2) return {};
      if (stack->isArmedOrRecording()) return {};  // a hot member (see Move)
      auto child0 = stack->removeChild(0);  // target
      auto child1 = stack->removeChild(0);  // dragged (now at 0)
      const juce::String draggedUuid = child1->getUuid();
      const juce::String targetUuid = child0->getUuid();
      auto* tParent = asStack(e.parentUuid);
      auto* dParent = asStack(e.parentUuid2);
      if (!tParent || !dParent) return {};
      // Reinsert in ascending index order so a shared parent reproduces
      // the exact original arrangement (inserting the lower slot first).
      const bool targetFirst = e.index <= e.index2;
      if (targetFirst) {
        tParent->insertChildAt(std::move(child0), e.index);
        dParent->insertChildAt(std::move(child1), e.index2);
      } else {
        dParent->insertChildAt(std::move(child1), e.index2);
        tParent->insertChildAt(std::move(child0), e.index);
      }
      // Detach the now-empty combined stack and hand it to the inverse
      // (the Remove discipline): the Combine that undoes this Explode
      // re-installs the SAME object, so the pair is a true inverse. The
      // subtree is retired only when its log entry is dropped — never
      // here, where an in-flight callback may still traverse it via the
      // outgoing graph snapshot.
      Edit inv(K::Combine);
      inv.uuid = draggedUuid;
      inv.uuid2 = targetUuid;
      int stackIdx = -1;
      if (auto* stackParent = parentOf(stack, &stackIdx);
          stackParent && stackIdx >= 0) {
        inv.node = stackParent->removeChild(stackIdx);
      }
      return inv;
    }
    case K::Rename: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Rename);
      inv.uuid = e.uuid;
      inv.s1 = node->getName();
      node->setName(e.s1);
      return inv;
    }
    case K::Mute: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Mute);
      inv.uuid = e.uuid;
      inv.b1 = node->is_muted.load();
      node->is_muted.store(e.b1);
      return inv;
    }
    case K::PeriodSource: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::PeriodSource);
      inv.uuid = e.uuid;
      inv.b1 = node->period_from_context_.load();
      node->period_from_context_.store(e.b1);
      return inv;
    }
    case K::LoopPoints: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopPoints);
      inv.uuid = e.uuid;
      inv.d1 = (double)node->getLoopStart();
      inv.d2 = (double)node->getLoopEnd();
      // An explicit single-window edit REPLACES a multi-segment
      // override (time_maps.md phase 3); the inverse carries the
      // removed map back (setsMap) so undo restores it.
      inv.setsMap = true;
      inv.tmap = node->storedMap();  // the RAW old geometry, any shape
      const bool clearing = !(e.setsMap && e.tmap.n >= 2) && (int64_t)e.d2 <= (int64_t)e.d1;
      if (e.setsMap && e.tmap.n >= 2) {
        node->setMap(e.tmap);  // undo path: the cell map comes back
      } else {
        node->setLoopPoints((int64_t)e.d1, (int64_t)e.d2);
      }
      // A CLEAR drops a stale bypass with the geometry (Edit::restoresBypass):
      // "whole" is no window, so nothing remains to bypass, and the next
      // window drawn must sound. The inverse puts the flag back.
      if (clearing && node->isLoopWindowBypassed()) {
        node->setLoopWindowBypassed(false);
        inv.restoresBypass = true;
      }
      if (e.restoresBypass) node->setLoopWindowBypassed(true);
      stampWindowDomain(node, e, inv);
      applyWindowRiders(find, e, inv);
      // Origins and epoch land in the SAME block (island generation) —
      // a setsOrigin re-anchor gates the same way.
      const uint32_t gen = e.setsOrigin ? root_node->nextIslandGeneration() : 0;
      applySetsOrigin(*node, e, inv, gen);
      // Q13 re-trim: if the forward edit carries an island re-establishment
      // (built by setLoopPoints when the target is the sole committed
      // clip), apply it and capture the old (Q, epoch) into the inverse so
      // undo restores the grid, not just the window.
      if (e.setsIsland) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        setIslandQuantum(e.iq, e.iepoch, inv, gen);
      } else if (gen != 0) {
        // Origins moved without the epoch: publish the generation so
        // the gated origins are adopted at the next block top.
        root_node->setIslandFacts(root_node->getQuantum(), root_node->getEpoch(), gen);
      }
      return inv;
    }
    case K::Collapse: {
      // Q13 LOCK-COLLAPSE (design_language.md Q13, composition.md §5 —
      // ONE row for clip and stack): the trim is a PRE-LOCK affordance.
      // When a take arms against a provisionally trimmed island, the
      // trimmed region BECOMES the take, as if it had been performed
      // exactly: the leaves under the definer node keep the window's
      // material as their whole content, the node's subtree moves by the
      // window start (window top → origin = the epoch), its ancestors
      // follow, the window is consumed. (Q, epoch) do not move: the
      // collapse lands exactly on the grid the trim established.
      auto* node = find(e.uuid);
      if (!node) return {};
      auto* clip = dynamic_cast<celestrian::ClipNode*>(node);
      Edit inv(K::Collapse);
      inv.uuid = e.uuid;
      if (!e.b1) {
        // MULTI-SEGMENT clip definer (phase 3): the collapse is a
        // SPLICE — the kept cells become the take; the inverse owns the
        // pre-splice buffer + map + facts (write-once safety, the
        // owned-subtree argument).
        if (const celestrian::timing::TimeMap mm =
                clip != nullptr ? clip->storedMap() : celestrian::timing::TimeMap();
            clip != nullptr && mm.n >= 2) {
          const celestrian::timing::TimeMap* m = &mm;
          // A referring (reserved-storage) buffer must not be the one
          // the inverse comes to own: compact to the heap first.
          compactClipToHeap(*clip);
          inv.b1 = true;
          inv.setsMap = true;
          inv.tmap = *m;
          // The pre-splice ORIGIN is an absolute: it rides `iorg` under
          // `setsOrigin`, the one slot shiftHistoryAbsolutes re-frames on
          // a seek. `iq` never holds an absolute.
          inv.setsOrigin = true;
          inv.iorg = clip->origin_samples.load();
          inv.old_duration = clip->getIntrinsicDuration();
          inv.d1 = (double)clip->getContentBase();
          inv.d2 = (double)clip->recordedLength();
          inv.collapsed_from = clip->collapsedFrom();  // the splice clears it
          // Every other take of the slot splices the same way (one
          // period, one base — docs/takes.md); the inverse owns their
          // pre-splice records. BEFORE spliceToMap rewrites the base.
          inv.other_takes = clip->spliceOtherTakesToMap(*m);
          // MIDI content splices its note sequence too (phase 5) —
          // BEFORE spliceToMap rewrites the shared facts (base).
          if (clip->contentKind() == celestrian::ClipNode::ContentKind::Midi)
            inv.midi = clip->spliceMidiToMap(*m);
          inv.buffer = clip->spliceToMap(*m);
          liftAncestorsGated(*clip, m->mapOffset(0), 0);  // Q18: origin += a0
          // spliceToMap left the geometry at the full span of the new take.
          return inv;
        }
        CollapseFacts f;
        if (!collapseNode(*node, f)) return {};
        inv.b1 = true;  // inverse = uncollapse, carrying the raw facts
        inv.shift = f.shift;
        inv.old_duration = f.old_duration;
        inv.win_start = f.win_start;
        inv.win_end = f.win_end;
      } else if (e.setsMap) {
        if (clip == nullptr) return {};
        // Un-splice: reinstall the pre-splice buffer + facts, retire
        // the displaced spliced buffer, and put the map back.
        const int64_t before_origin = clip->origin_samples.load();
        retireOwned(clip->unspliceFromMap(std::move(e.buffer), e.iorg,
                                          e.old_duration, (int64_t)e.d1,
                                          (int64_t)e.d2, e.collapsed_from));
        liftAncestorsGated(*clip, clip->origin_samples.load() - before_origin,
                           0);
        if (e.midi) retireOwned(clip->unspliceMidi(std::move(e.midi)));
        for (auto& d : clip->unspliceOtherTakes(std::move(e.other_takes))) {
          retireOwned(std::move(d.buffer));
          retireOwned(std::move(d.midi));
        }
        clip->setMap(e.tmap);
        // Inverse of the inverse: the parameterless forward re-derives
        // (the override is present again).
      } else {
        // Level undo: unwind exactly this collapse's shift.
        uncollapseNode(*node, e.shift, e.old_duration, e.win_start,
                       e.win_end);
        // inverse of the inverse: the parameterless forward re-derives.
      }
      return inv;
    }
    case K::LoopBypass: {
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::LoopBypass);
      inv.uuid = e.uuid;
      inv.b1 = node->isLoopWindowBypassed();
      node->setLoopWindowBypassed(e.b1);
      return inv;
    }
    case K::Segments: {
      // Multi-segment map (time_maps.md phase 3). Applied by
      // NORMALIZATION so undo round-trips through every state pair:
      // n≥2 installs an immutable override; n==1 writes the
      // single-window atomics (clearing the override); n==0 clears
      // both. The inverse captures the RAW old storage — never
      // activeTimeMap(), which reads empty under bypass and would
      // lose a bypassed node's geometry on undo.
      auto* node = find(e.uuid);
      if (!node) return {};
      Edit inv(K::Segments);
      inv.uuid = e.uuid;
      inv.setsMap = true;
      inv.tmap = node->storedMap();  // the RAW old geometry, any shape
      stampWindowDomain(node, e, inv);
      node->setMap(e.tmap);
      // Q13 riders (multi-segment definer re-trim): identical shape to
      // LoopPoints — the grid, the members and the phase re-anchor undo
      // atomically with the map (window/origin riders serve the
      // DEFINER-STACK twin).
      applyWindowRiders(find, e, inv);
      const uint32_t seg_gen =
          e.setsOrigin ? root_node->nextIslandGeneration() : 0;
      applySetsOrigin(*node, e, inv, seg_gen);
      if (e.setsIsland) {
        inv.setsIsland = true;
        inv.iq = root_node->getQuantum();
        inv.iepoch = root_node->getEpoch();
        setIslandQuantum(e.iq, e.iepoch, inv, seg_gen);
      } else if (seg_gen != 0) {
        root_node->setIslandFacts(root_node->getQuantum(),
                                  root_node->getEpoch(), seg_gen);
      }
      return inv;
    }
    case K::Sequence: {
      // The SEQUENCER (docs/sequencer.md): install/replace/clear the
      // stack's sequence by copy-swap-retire (the Segments/map
      // discipline). The inverse owns a copy of the RAW old sequence —
      // bypassed geometry survives undo, like Segments.
      auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid));
      if (!stack) return {};
      Edit inv(K::Sequence);
      inv.uuid = e.uuid;
      if (const celestrian::Sequence* old = stack->sequencePtr()) {
        inv.seq = std::make_unique<celestrian::Sequence>(*old);
      }
      const celestrian::Sequence* fresh =
          e.seq ? new celestrian::Sequence(*e.seq) : nullptr;
      // The step audition names a step by INDEX: it follows a resize
      // (same count) but cannot survive a shape change (a delete
      // would silently re-aim it at the neighbour) — clear it then.
      {
        const int before = inv.seq ? inv.seq->numSteps() : 0;
        const int after = fresh ? fresh->numSteps() : 0;
        if (before != after) stack->setAuditionStep(-1);
      }
      if (const celestrian::Sequence* old = stack->exchangeSequence(fresh)) {
        retireOwned(old);
      }
      return inv;
    }
    case K::Take:
    case K::Untake: {
      // TAKES ARE UNDOABLE (docs/sequencer.md §11.5). Untake strips the
      // named clips to empty, the inverse Take OWNING their content;
      // Take reinstalls it. Island (Q, epoch) ride via setsIsland in
      // both directions (the first take's establishment, a growth
      // re-base), captured into the inverse. An optional sequence rider
      // (`seq` + `b1`, the step-record auto-gate) swaps with the same
      // copy-swap-retire discipline so take + gates undo as one.
      if (root_node->hasActiveTake()) return {};  // never under a live take
      const bool strip = e.kind == K::Untake;
      Edit inv(strip ? K::Take : K::Untake);
      // Every named clip must exist and be idle, or the edit is a Nop
      // (a deleted clip's take is gone with it — Remove owns that).
      // A payload with a take index names a take of a multi-take slot
      // (docs/takes.md): Untake removes the LAST take, Take appends —
      // the slot itself keeps its content either way.
      std::vector<celestrian::ClipNode*> clips;
      for (const auto& tp : e.takes) {
        auto* clip = dynamic_cast<celestrian::ClipNode*>(find(tp.uuid));
        if (!clip || clip->isArmedOrRecording()) return {};
        if (tp.take_index >= 0) {
          if (clip->duration_samples.load() <= 0) return {};
          if (strip && (tp.take_index < 1 ||
                        clip->takeCount() != tp.take_index + 1))
            return {};
          if (!strip && clip->takeCount() != tp.take_index) return {};
        } else {
          if (strip && (clip->duration_samples.load() <= 0 ||
                        clip->takeCount() > 1))
            return {};
          if (!strip && clip->duration_samples.load() > 0) return {};
        }
        clips.push_back(clip);
      }
      // Island facts: capture current, then set the payload's.
      inv.setsIsland = true;
      inv.iq = root_node->getQuantum();
      inv.iepoch = root_node->getEpoch();
      for (size_t i = 0; i < clips.size(); ++i) {
        Edit::TakePayload& in = e.takes[i];
        Edit::TakePayload out;
        out.uuid = in.uuid;
        out.take_index = in.take_index;
        out.prev_active = in.prev_active;
        if (in.take_index >= 0) {
          celestrian::ClipNode& clip = *clips[i];
          if (strip) {
            // The comp rides the inverse; cells naming the removed
            // take fall back to the active one meanwhile.
            out.setsComp = true;
            out.cells = clip.compCells();
            out.cell_len = clip.compCellLength();
            if (in.prev_active >= 0 && in.prev_active != clip.activeTake())
              clip.selectTake(in.prev_active);
            out.state = clip.removeTake(in.take_index);
            dropTakeFromComp(clip, in.take_index);
          } else {
            if (!in.state.buffer) return {};
            clip.insertTake(in.take_index, std::move(in.state));
            clip.selectTake(in.take_index);
            if (in.setsComp) clip.setCompCells(in.cells, in.cell_len);
          }
        } else if (strip) {
          out.state = clips[i]->stripTake();
        } else {
          if (!in.state.buffer) return {};
          auto displaced = clips[i]->restoreTake(std::move(in.state));
          retireOwned(displaced.first.release());
          retireOwned(displaced.second.release());
        }
        // The instrument rider (docs/vst3.md §11): the inverse takes
        // the state current now, the payload's state goes live. A slot
        // no longer on the chain drops the rider.
        if (in.instrument_slot.isNotEmpty()) {
          if (auto* instrument = dynamic_cast<celestrian::dsp::Vst3Slot*>(
                  clips[i]->fxChain()->findSlot(in.instrument_slot))) {
            out.instrument_slot = in.instrument_slot;
            out.instrument_state = instrument->stateBlob();
            if (in.instrument_state.getSize() > 0)
              instrument->restoreState(in.instrument_state);
          }
        }
        inv.takes.push_back(std::move(out));
      }
      if (e.setsIsland) setIslandQuantum(e.iq, e.iepoch, inv);
      // Undo of a FIRST take reverts Q to 0, which clears every
      // sequence into the inverse's riders; redo reinstalls them.
      reinstallSequenceRiders(e);
      // The group-window lift rides the take (see reconcileTakes):
      // undo puts the members' commit-time windows back and clears the
      // stack's; redo lifts again.
      applyWindowRiders(find, e, inv);
      // The sequence rider (auto-gate).
      if (e.b1 && e.uuid.isNotEmpty()) {
        if (auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid))) {
          inv.b1 = true;
          inv.uuid = e.uuid;
          if (const celestrian::Sequence* old = stack->sequencePtr()) {
            inv.seq = std::make_unique<celestrian::Sequence>(*old);
          }
          const celestrian::Sequence* fresh =
              e.seq ? new celestrian::Sequence(*e.seq) : nullptr;
          if (const celestrian::Sequence* old = stack->exchangeSequence(fresh)) {
            retireOwned(old);
          }
        }
      }
      return inv;
    }
    case K::SelectTake: {
      // Takes (docs/takes.md): an atomic content-pointer swap; the
      // inverse names the take that was active.
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip || clip->isArmedOrRecording()) return {};
      if (root_node->hasActiveTake()) return {};
      if (e.index < 0 || e.index >= clip->takeCount() ||
          e.index == clip->activeTake())
        return {};
      Edit inv(K::SelectTake);
      inv.uuid = e.uuid;
      inv.index = clip->activeTake();
      if (!clip->selectTake(e.index)) return {};
      return inv;
    }
    case K::DeleteTake: {
      // Forward (no payload): detach take `index` — never the last one;
      // the inverse OWNS the record (the owned-subtree argument) with
      // the activity and comp to restore. With a payload: reinsert.
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip || clip->isArmedOrRecording()) return {};
      if (root_node->hasActiveTake()) return {};
      Edit inv(K::DeleteTake);
      inv.uuid = e.uuid;
      if (e.takes.empty()) {
        const int k = e.index;
        if (clip->takeCount() < 2 || k < 0 || k >= clip->takeCount()) return {};
        Edit::TakePayload tp;
        tp.uuid = e.uuid;
        tp.take_index = k;
        tp.prev_active = clip->activeTake();
        tp.setsComp = true;
        tp.cells = clip->compCells();
        tp.cell_len = clip->compCellLength();
        tp.state = clip->removeTake(k);
        if (!tp.state.buffer) return {};
        dropTakeFromComp(*clip, k);
        inv.takes.push_back(std::move(tp));
        return inv;
      }
      Edit::TakePayload& tp = e.takes[0];
      if (!tp.state.buffer || tp.take_index < 0 ||
          tp.take_index > clip->takeCount())
        return {};
      clip->insertTake(tp.take_index, std::move(tp.state));
      if (tp.prev_active >= 0) clip->selectTake(tp.prev_active);
      if (tp.setsComp) clip->setCompCells(tp.cells, tp.cell_len);
      inv.index = tp.take_index;
      return inv;
    }
    case K::Comp: {
      // The comp (docs/takes.md): the full cell array replaces the
      // old one whole (seqlocked inline); the inverse carries the old.
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip || clip->isArmedOrRecording()) return {};
      if (root_node->hasActiveTake()) return {};
      Edit inv(K::Comp);
      inv.uuid = e.uuid;
      inv.cells = clip->compCells();
      inv.cell_len = clip->compCellLength();
      clip->setCompCells(e.cells, e.cell_len);
      return inv;
    }
    case K::SequenceBypass: {
      auto* stack = dynamic_cast<celestrian::StackNode*>(find(e.uuid));
      if (!stack) return {};
      Edit inv(K::SequenceBypass);
      inv.uuid = e.uuid;
      inv.b1 = stack->isSequenceBypassed();
      stack->setSequenceBypassed(e.b1);
      return inv;
    }
    case K::Input: {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip) return {};
      Edit inv(K::Input);
      inv.uuid = e.uuid;
      inv.d1 = (double)clip->getInputChannel();
      clip->setInputChannel((int)e.d1);
      return inv;
    }
    case K::InputR: {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(find(e.uuid));
      if (!clip) return {};
      Edit inv(K::InputR);
      inv.uuid = e.uuid;
      inv.d1 = (double)clip->getInputChannelRight();
      clip->setInputChannelRight((int)e.d1);
      return inv;
    }
    case K::MoveSlot: {
      auto* node = find(e.uuid);
      if (!node) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      const int from = chain->indexOfSlot(e.s1);
      const int slot_count = (int)chain->slots().size();
      const int to = juce::jlimit(0, slot_count - 1, e.index);
      if (from < 0 || from == to) return {};
      Edit inv(K::MoveSlot);
      inv.uuid = e.uuid;
      inv.s1 = e.s1;
      inv.index = from;
      // Successor chain sharing the slot objects (DSP state survives);
      // publish, then retire the predecessor (an in-flight render may
      // read it for ≤2 more callbacks).
      auto slots = chain->slots();
      auto moved = slots[(size_t)from];
      slots.erase(slots.begin() + from);
      slots.insert(slots.begin() + to, std::move(moved));
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::AddSlot: {
      auto* node = find(e.uuid);
      if (!node || e.slot == nullptr) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      auto slots = chain->slots();
      const int slot_count = (int)slots.size();
      const int to =
          e.index < 0 ? slot_count : juce::jlimit(0, slot_count, e.index);
      Edit inv(K::RemoveSlot);
      inv.uuid = e.uuid;
      inv.s1 = e.slot->slotUuid();
      slots.insert(slots.begin() + to, e.slot);
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::RemoveSlot: {
      auto* node = find(e.uuid);
      if (!node) return {};
      celestrian::dsp::FxChain* chain = node->fxChain();
      const int from = chain->indexOfSlot(e.s1);
      if (from < 0) return {};
      auto slots = chain->slots();
      Edit inv(K::AddSlot);
      inv.uuid = e.uuid;
      inv.index = from;
      inv.slot = slots[(size_t)from];  // the undo entry OWNS the slot
      slots.erase(slots.begin() + from);
      retireOwned(std::unique_ptr<celestrian::dsp::FxChain>(
          node->exchangeFxChain(
              celestrian::dsp::FxChain::makeFromSlots(std::move(slots))
                  .release())));
      return inv;
    }
    case K::Nop:
      return {};
  }
  return {};
}

void AudioEngine::retireEdit(celestrian::Edit&& e) {
  // Never free a detached subtree inline — an in-flight callback may read
  // it for ≤2 more callbacks. Hand it to the same graveyard the graph
  // mutations use.
  retireOwned(std::move(e.buffer));
  retireOwned(std::move(e.node));
  retireOwned(std::move(e.node2));
  // Take content (Kind::Take payloads, detached takes of a slot, the
  // pre-splice records of a slot's other takes) rides the same grace.
  auto retireTake = [this](celestrian::ClipNode::TakeState& s) {
    retireOwned(std::move(s.buffer));
    retireOwned(std::move(s.midi));
    // TakeStorage rides the same grace: dropping it inline would
    // munmap/VirtualFree pages an in-flight callback may still be
    // reading through storage_rt_.
    if (s.storage != nullptr) {
      // shared_ptr wrapper: retire() takes a copyable std::function.
      retire([st = std::shared_ptr<celestrian::TakeStorage>(
                  std::move(s.storage))] {});
    }
  };
  for (auto& tp : e.takes) retireTake(tp.state);
  for (auto& ot : e.other_takes) retireTake(ot.second);
  // A chain slot rides the same grace: the chain that referenced it was
  // itself just retired, so an in-flight callback may still process the
  // slot. The deleter holds the shared_ptr until the grace passes.
  if (e.slot != nullptr) {
    retire([slot = std::move(e.slot)] {});
  }
}

void AudioEngine::clearRedo() {
  for (auto& e : redo_) retireEdit(std::move(e));
  redo_.clear();
}

void AudioEngine::clearHistory() {
  for (auto& e : undo_) retireEdit(std::move(e));
  undo_.clear();
  clearRedo();
  pending_takes_.clear();
}

void AudioEngine::pushUndo(celestrian::Edit&& inverse) {
  undo_.push_back(std::move(inverse));
  while (undo_.size() > kUndoDepth) {
    retireEdit(std::move(undo_.front()));
    undo_.erase(undo_.begin());
  }
  clearRedo();
}

bool AudioEngine::refusedUnderLiveTake(const char* verb) const {
  if (root_node == nullptr || !root_node->hasActiveTake()) return false;
  juce::Logger::writeToLog(
      juce::String("AudioEngine: ") + verb +
      " refused - a take is armed or capturing (edits wait for the take)");
  return true;
}

namespace {
/** The kinds that stay live under a take: wiring and mixer facts that
 * change nothing about what sounds WHEN (rename, mute, the input
 * channels for the NEXT arm, fx slot structure) and inserting EMPTY
 * nodes (a new track) — every other kind moves time or content. */
bool liveUnderTake(celestrian::Edit::Kind k) {
  using K = celestrian::Edit::Kind;
  return k == K::Rename || k == K::Mute || k == K::Input || k == K::InputR ||
         k == K::MoveSlot || k == K::AddSlot || k == K::RemoveSlot ||
         k == K::Insert;
}
}  // namespace

void AudioEngine::record(celestrian::Edit forward) {
  reconcileTakes();  // a settled take logs BEFORE any later edit
  if (!liveUnderTake(forward.kind) && refusedUnderLiveTake("edit")) return;
  const bool live = forward.live;
  celestrian::Edit inv = applyEdit(std::move(forward));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;  // did not apply
  if (!undo_.empty() && editsCoalesce(undo_.back(), inv, live)) {
    clearRedo();  // a fresh user action still invalidates the redo branch
    return;       // keep the older inverse (restores further back)
  }
  pushUndo(std::move(inv));
}

namespace {
// Any edit that moves island facts — (Q, epoch), origins, or the
// windows that select against them — is refused under a live take:
// the performer is recording against that grid, and a mid-take undo
// of a trim (window + origin riders, or a lock-collapse) shifts the
// cycle under the take exactly like a take edit would.
bool movesIslandFacts(const celestrian::Edit& e) {
  // Take-list edits (docs/takes.md) join the set: their appliers
  // refuse under a live take, and a refusal must KEEP the entry.
  return e.kind == celestrian::Edit::Kind::Take ||
         e.kind == celestrian::Edit::Kind::Untake ||
         e.kind == celestrian::Edit::Kind::SelectTake ||
         e.kind == celestrian::Edit::Kind::DeleteTake ||
         e.kind == celestrian::Edit::Kind::Comp ||
         e.kind == celestrian::Edit::Kind::Collapse || e.setsIsland ||
         e.setsOrigin || !e.anchors.empty() || !e.windows.empty();
}

}  // namespace

void AudioEngine::undo() {
  reconcileTakes();
  if (undo_.empty()) return;
  // THE LIVE-TAKE GATE: no undo under a take (it could move the grid
  // the performer records against, or restructure around the take).
  // Refuse and KEEP the entry (a Nop would drop it from the log).
  if (refusedUnderLiveTake("undo")) return;
  juce::ignoreUnused(&movesIslandFacts);
  celestrian::Edit inv = std::move(undo_.back());
  undo_.pop_back();
  celestrian::Edit fwd = applyEdit(std::move(inv));
  if (fwd.kind != celestrian::Edit::Kind::Nop) redo_.push_back(std::move(fwd));
}

void AudioEngine::redo() {
  reconcileTakes();
  if (redo_.empty()) return;
  if (refusedUnderLiveTake("redo")) return;
  celestrian::Edit fwd = std::move(redo_.back());
  redo_.pop_back();
  celestrian::Edit inv = applyEdit(std::move(fwd));
  if (inv.kind != celestrian::Edit::Kind::Nop) undo_.push_back(std::move(inv));
}

void AudioEngine::deleteNode(const juce::String& uuid) {
  celestrian::Edit e(celestrian::Edit::Kind::Remove);
  e.uuid = uuid;
  record(std::move(e));
}
