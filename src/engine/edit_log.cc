// AudioEngine — the EDIT LOG: applyEdit / applyEditImpl (one mutation
// per Edit kind, returning its inverse), the window-domain and window
// riders, the group lock-collapse pair, retirement of detached
// payloads, and the undo / redo stacks (record, pushUndo, undo, redo,
// deleteNode). Message thread only.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

using celestrian::engine_internal::definerStack;
using celestrian::engine_internal::firstCommittedClip;

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
// Continuous drags collapse into ONE undo step: when the new inverse
// targets the same node/kind as the top of the stack, the older inverse
// already restores further back, so the new one is dropped.
bool editsCoalesce(const Edit& top, const Edit& fresh) {
  if (top.kind != fresh.kind || top.uuid != fresh.uuid) return false;
  // LIVE map-edit drags (seam slides stream throttled setSegments
  // commits so the splice is AUDIBLE while dragging — time_maps.md)
  // flood; keep the oldest inverse so one gesture is one undo step.
  return top.kind == Edit::Kind::Segments;
}
}  // namespace

namespace {
/** Ungated ancestor lift for the collapse paths (Q18): a definer's
 * collapse moves its origin by the window start; its ancestors, anchored
 * because of it, follow. */
void liftAncestorsOf(celestrian::AudioNode& node, int64_t delta) {
  for (auto* p = node.getParent(); p != nullptr; p = p->getParent()) {
    if (p->isAnchored()) p->origin_samples.store(p->origin_samples.load() + delta);
  }
}
}  // namespace

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

/** The definer STACK's committed direct members (one take). */
std::vector<celestrian::ClipNode*> stackMembers(celestrian::StackNode& stack) {
  std::vector<celestrian::ClipNode*> out;
  for (const auto& child : stack.ownedChildren()) {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(child.get());
    if (clip != nullptr && clip->getIntrinsicDuration() > 0) out.push_back(clip);
  }
  return out;
}

/** GROUP LOCK-COLLAPSE (the fractal twin of collapseToWindow): the
 * stack's single window [s, s+len) becomes the
 * take — every member collapses to it (content base + origin shift by
 * s, duration := len, whole) and the stack window is consumed.
 * Audio-neutral under the content-frame law (epoch == members' origin):
 * heard = s + ((t − origin) mod len) before, (t − (origin + s)) mod len
 * after. Returns false when there is nothing to collapse. */
struct GroupCollapseFacts {
  int64_t shift = 0, old_duration = 0, win_start = 0, win_end = 0;
};
bool collapseGroupNow(celestrian::StackNode& stack, GroupCollapseFacts& f) {
  // RAW atomics only: activeTimeMap() is overridden by a STEP
  // AUDITION's derived map — collapsing to that would make a monitoring
  // gesture the take and destroy the authored window. The sole-clip
  // path reads the raw atomics for the same reason. A multi-segment
  // override is not a single window: nothing to collapse here.
  if (stack.isLoopWindowBypassed() || stack.hasSegmentMap()) return false;
  const auto members = stackMembers(stack);
  if (members.empty()) return false;
  const int64_t D = members[0]->getIntrinsicDuration();
  const int64_t s = std::max((int64_t)0, stack.getLoopStart());
  const int64_t e = std::min(stack.getLoopEnd(), D);
  const int64_t len = e - s;
  if (len <= 0 || (s == 0 && e >= D)) return false;
  for (auto* m : members) {
    if (m->getIntrinsicDuration() != D) return false;  // not one take
  }
  // Q18: the stack's window anchors at the stack's own origin, so the
  // collapse moves the ORIGIN of the whole subtree by `s` (exactly the
  // sole-clip law: window top → origin) alongside the content bases.
  // Audio-neutral: inner s + ((t − O − s) mod len) before ==
  // base s + ((t − (O + s)) mod len) after.
  for (auto* m : members) m->collapseToWindow(s, len);
  stack.origin_samples.store(stack.origin_samples.load() + s);
  liftAncestorsOf(stack, s);
  stack.setLoopPoints(0, 0);
  f.shift = s;
  f.old_duration = D;
  f.win_start = s;
  f.win_end = e;
  return true;
}
void uncollapseGroupNow(celestrian::StackNode& stack, const GroupCollapseFacts& f) {
  for (auto* m : stackMembers(stack)) {
    if (!m->isCollapsed()) continue;
    // Unwind this level: buffer view AND origin (Q18 — the group
    // collapse shifted both, like the sole-clip collapse).
    m->uncollapseFromWindow(f.shift, f.old_duration, /*origin_shift=*/f.shift);
    m->setLoopPoints(0, f.old_duration);  // members whole; the window is the stack's
  }
  stack.origin_samples.store(stack.origin_samples.load() - f.shift);
  liftAncestorsOf(stack, -f.shift);
  stack.setLoopPoints(f.win_start, f.win_end);
}
}  // namespace

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
      // it was. Same derivation as the forward CollapseTake; redo's
      // Remove re-derives the uncollapse, so no payload rides back.
      if (e.uuid2.isNotEmpty()) {
        if (auto* clip = dynamic_cast<celestrian::ClipNode*>(
                findNodeByUuid(root_node.get(), e.uuid2))) {
          const int64_t dur = clip->getIntrinsicDuration();
          const int64_t ls = clip->getLoopStart();
          const int64_t le = std::min(clip->getLoopEnd(), dur);
          if (le - ls > 0 && !(ls == 0 && le >= dur)) {
            clip->collapseToWindow(ls, le - ls);
            liftAncestorsOf(*clip, ls);  // Q18: ancestors follow the definer
          }
        } else if (auto* stack = asStack(e.uuid2)) {
          GroupCollapseFacts f;
          collapseGroupNow(*stack, f);  // the group twin re-derives
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
      if (reopened && islandCommittedClipCount() == 1) {
        if (auto* survivor = firstCommittedClip(root_node.get());
            survivor && survivor->isCollapsed()) {
          const int64_t unwound = survivor->getContentBase();
          survivor->uncollapseFromWindow(unwound, survivor->collapsedFrom());
          liftAncestorsOf(*survivor, -unwound);  // Q18
          inv.uuid2 = survivor->getUuid();
        }
      }
      // The GROUP twin: back down to a definer stack whose members were
      // group-collapsed — restore the full takes with the old window on
      // the stack (audio-neutral, trimming longer possible again).
      if (auto* ds = reopened ? definerStack(root_node.get()) : nullptr;
          ds != nullptr) {
        const auto members = stackMembers(*ds);
        if (!members.empty() && members[0]->isCollapsed()) {
          GroupCollapseFacts f;
          f.shift = members[0]->getContentBase();
          f.old_duration = members[0]->collapsedFrom();
          f.win_start = f.shift;
          f.win_end = f.shift + members[0]->getIntrinsicDuration();
          uncollapseGroupNow(*ds, f);
          inv.uuid2 = ds->getUuid();
        }
      }
      return inv;
    }
    case K::Move: {
      auto* node = find(e.uuid);
      auto* newParent = asStack(e.parentUuid);
      if (!node || !newParent) return {};
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
      int draggedIdx = -1, targetIdx = -1;
      auto* draggedParent = parentOf(dragged, &draggedIdx);
      auto* targetParent = parentOf(target, &targetIdx);
      if (!draggedParent || !targetParent) return {};
      auto draggedOwned = draggedParent->removeChild(draggedIdx);
      // Target index may have shifted if it shared a parent with dragged.
      int tIdx = -1;
      auto* tParent = parentOf(target, &tIdx);
      auto targetOwned = tParent->removeChild(tIdx);
      auto newStack = std::make_unique<StackNode>("Combined Stack");
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
      // Remove the now-empty combined stack; retire it — an in-flight
      // callback may still traverse it via the outgoing graph snapshot.
      int stackIdx = -1;
      if (auto* stackParent = parentOf(stack, &stackIdx);
          stackParent && stackIdx >= 0) {
        retireOwned(stackParent->removeChild(stackIdx));
      }
      Edit inv(K::Combine);
      inv.uuid = draggedUuid;
      inv.uuid2 = targetUuid;
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
      if (e.setsMap && e.tmap.n >= 2) {
        node->setMap(e.tmap);  // undo path: the cell map comes back
      } else {
        node->setLoopPoints((int64_t)e.d1, (int64_t)e.d2);
      }
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
    case K::CollapseTake: {
      // Q13 lock-collapse (design_language.md Q13): the trim is a
      // PRE-LOCK affordance — when a take arms against a provisionally
      // trimmed island, the trimmed region BECOMES the take, as if it
      // had been performed exactly (duration = window len, origin =
      // its own window top = the epoch, window consumed). (Q, epoch)
      // do not move: the collapse lands the clip exactly on the grid
      // the trim already established.
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          findNodeByUuid(root_node.get(), e.uuid));
      if (!clip) return {};
      Edit inv(K::CollapseTake);
      inv.uuid = e.uuid;
      if (!e.b1) {
        // MULTI-SEGMENT definer (phase 3): the collapse is a SPLICE —
        // the kept cells become the take; the inverse owns the
        // pre-splice buffer + map + facts (write-once safety, the
        // owned-subtree argument).
        if (const celestrian::timing::TimeMap mm = clip->storedMap(); mm.n >= 2) {
          const celestrian::timing::TimeMap* m = &mm;
          // A referring (reserved-storage) buffer must not be the one
          // the inverse comes to own: compact to the heap first.
          compactClipToHeap(*clip);
          inv.b1 = true;
          inv.setsMap = true;
          inv.tmap = *m;
          inv.iq = clip->origin_samples.load();
          inv.iepoch = clip->getIntrinsicDuration();
          inv.d1 = (double)clip->getContentBase();
          inv.d2 = (double)clip->recordedLength();
          // MIDI content splices its note sequence too (phase 5) —
          // BEFORE spliceToMap rewrites the shared facts (base).
          if (clip->contentKind() == celestrian::ClipNode::ContentKind::Midi)
            inv.midi = clip->spliceMidiToMap(*m);
          inv.buffer = clip->spliceToMap(*m);
          liftAncestorsOf(*clip, m->mapOffset(0));  // Q18: origin += a0
          // spliceToMap left the geometry at the full span of the new take.
          return inv;
        }
        const int64_t dur = clip->getIntrinsicDuration();
        const int64_t ls = clip->getLoopStart();
        const int64_t le = std::min(clip->getLoopEnd(), dur);
        const int64_t len = le - ls;
        // Full-span (or invalid) window: nothing to collapse.
        if (len <= 0 || (ls == 0 && le >= dur)) return {};
        clip->collapseToWindow(ls, len);
        liftAncestorsOf(*clip, ls);  // Q18: ancestors follow the definer
        inv.b1 = true;  // inverse = uncollapse, carrying what it needs
        inv.iq = ls;
        inv.iepoch = dur;
      } else if (e.setsMap) {
        // Un-splice: reinstall the pre-splice buffer + facts, retire
        // the displaced spliced buffer, and put the map back.
        const int64_t before_origin = clip->origin_samples.load();
        retireOwned(clip->unspliceFromMap(std::move(e.buffer), e.iq, e.iepoch,
                                          (int64_t)e.d1, (int64_t)e.d2));
        liftAncestorsOf(*clip, clip->origin_samples.load() - before_origin);
        if (e.midi) retireOwned(clip->unspliceMidi(std::move(e.midi)));
        clip->setMap(e.tmap);
        // Inverse of the inverse: the parameterless forward re-derives
        // (the override is present again).
      } else {
        // Level undo: this collapse shifted the origin by exactly its
        // own window start (e.iq) — unwind that level only.
        clip->uncollapseFromWindow(e.iq, e.iepoch, e.iq);
        liftAncestorsOf(*clip, -e.iq);  // Q18
        // inverse of the inverse: the parameterless forward re-derives.
      }
      return inv;
    }
    case K::CollapseGroup: {
      auto* stack = asStack(e.uuid);
      if (!stack) return {};
      Edit inv(K::CollapseGroup);
      inv.uuid = e.uuid;
      if (!e.b1) {
        GroupCollapseFacts f;
        if (!collapseGroupNow(*stack, f)) return {};
        inv.b1 = true;
        inv.iq = f.shift;
        inv.iepoch = f.old_duration;
        inv.d1 = (double)f.win_start;
        inv.d2 = (double)f.win_end;
      } else {
        GroupCollapseFacts f;
        f.shift = e.iq;
        f.old_duration = e.iepoch;
        f.win_start = (int64_t)e.d1;
        f.win_end = (int64_t)e.d2;
        uncollapseGroupNow(*stack, f);
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
      std::vector<celestrian::ClipNode*> clips;
      for (const auto& tp : e.takes) {
        auto* clip = dynamic_cast<celestrian::ClipNode*>(find(tp.uuid));
        if (!clip || clip->isArmedOrRecording()) return {};
        if (strip && clip->duration_samples.load() <= 0) return {};
        if (!strip && clip->duration_samples.load() > 0) return {};
        clips.push_back(clip);
      }
      // Island facts: capture current, then set the payload's.
      inv.setsIsland = true;
      inv.iq = root_node->getQuantum();
      inv.iepoch = root_node->getEpoch();
      for (size_t i = 0; i < clips.size(); ++i) {
        Edit::TakePayload out;
        out.uuid = e.takes[i].uuid;
        if (strip) {
          out.state = clips[i]->stripTake();
        } else {
          if (!e.takes[i].state.buffer) return {};
          auto displaced = clips[i]->restoreTake(std::move(e.takes[i].state));
          retireOwned(displaced.first.release());
          retireOwned(displaced.second.release());
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
  // Take content (Kind::Take payloads) rides the same grace.
  for (auto& tp : e.takes) {
    retireOwned(std::move(tp.state.buffer));
    retireOwned(std::move(tp.state.midi));
    // TakeStorage rides the same grace: dropping it inline would
    // munmap/VirtualFree pages an in-flight callback may still be
    // reading through storage_rt_.
    if (tp.state.storage != nullptr) {
      // shared_ptr wrapper: retire() takes a copyable std::function.
      retire([st = std::shared_ptr<celestrian::TakeStorage>(
                  std::move(tp.state.storage))] {});
    }
  }
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

void AudioEngine::record(celestrian::Edit forward) {
  reconcileTakes();  // a settled take logs BEFORE any later edit
  celestrian::Edit inv = applyEdit(std::move(forward));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;  // did not apply
  if (!undo_.empty() && editsCoalesce(undo_.back(), inv)) {
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
  return e.kind == celestrian::Edit::Kind::Take ||
         e.kind == celestrian::Edit::Kind::Untake ||
         e.kind == celestrian::Edit::Kind::CollapseTake ||
         e.kind == celestrian::Edit::Kind::CollapseGroup || e.setsIsland ||
         e.setsOrigin || !e.anchors.empty() || !e.windows.empty();
}
}  // namespace

void AudioEngine::undo() {
  reconcileTakes();
  if (undo_.empty()) return;
  // A take edit moves island facts (Q, epoch, the committed cycle):
  // never under a live take. Refuse and KEEP the entry (a Nop would
  // drop it from the log).
  if (movesIslandFacts(undo_.back()) && root_node->hasActiveTake()) {
    juce::Logger::writeToLog(
        "AudioEngine::undo refused - it would move the cycle a take is "
        "recording against (finish or cancel the take first)");
    return;
  }
  celestrian::Edit inv = std::move(undo_.back());
  undo_.pop_back();
  celestrian::Edit fwd = applyEdit(std::move(inv));
  if (fwd.kind != celestrian::Edit::Kind::Nop) redo_.push_back(std::move(fwd));
}

void AudioEngine::redo() {
  reconcileTakes();
  if (redo_.empty()) return;
  if (movesIslandFacts(redo_.back()) && root_node->hasActiveTake()) {
    juce::Logger::writeToLog(
        "AudioEngine::redo refused - it would move the cycle a take is "
        "recording against (finish or cancel the take first)");
    return;
  }
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
