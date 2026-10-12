// AudioEngine — the EDIT LOG. Every undoable change is an Edit
// (src/edit.h): applyEdit performs one and answers its INVERSE; the undo
// stack is a list of inverses, the redo stack a list of forwards, and
// applying either yields the other. This file is the log itself — the
// per-kind table and dispatch, record with its gesture tracking, undo,
// redo, cancel, the arm's deferred entries and retirement. The appliers
// live beside it, one file per family (engine/edit_*.cc). Message thread
// only: the audio thread sees the atomics and snapshots an edit leaves
// behind, never the edit.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "edit_internal.h"
#include "engine_internal.h"

namespace {
using celestrian::Edit;

/** "edit LoopPoints on Drums [7e1090]" — the origin-drift log's cause. */
juce::String driftCause(celestrian::AudioNode* root, const char* verb,
                        const char* kind_name, const juce::String& uuid) {
  juce::String cause = juce::String(verb) + " " + kind_name;
  if (uuid.isEmpty()) return cause;
  const celestrian::AudioNode* node = root ? root->findByUuid(uuid) : nullptr;
  const juce::String tag = "[" + uuid.substring(0, 6) + "]";
  return cause + " on " + (node ? node->getName() + " " + tag : tag);
}

/** A gesture's entry restores the gesture's START. It is the first
 * commit's inverse, so a rider that commit did not carry — an origin a
 * later commit re-anchors, the grid, a member's window — is one it
 * lacks; the `later` inverse captured that fact while it still held the
 * start's value, and the entry takes it. What the entry already holds is
 * older, and stays. */
void completeGestureEntry(Edit& entry, Edit& later) {
  if (later.setsOrigin && !entry.setsOrigin) {
    entry.setsOrigin = true;
    entry.iorg = later.iorg;
    entry.liftsAncestors = later.liftsAncestors;
  }
  if (later.setsIsland && !entry.setsIsland) {
    entry.setsIsland = true;
    entry.iq = later.iq;
    entry.izero = later.izero;
    entry.seq_riders = std::move(later.seq_riders);  // the songs at that grid
  }
  for (auto& rider : later.windows) {
    const bool held = std::any_of(
        entry.windows.begin(), entry.windows.end(),
        [&](const Edit::WindowRider& r) { return r.uuid == rider.uuid; });
    if (!held) entry.windows.push_back(std::move(rider));
  }
}
}  // namespace

// --- The kinds --------------------------------------------------------

AudioEngine::KindTraits AudioEngine::traitsOf(Edit::Kind kind) {
  using K = Edit::Kind;
  using E = AudioEngine;
  using T = KindTraits::Touches;
  using U = KindTraits::UnderTake;
  using G = KindTraits::Gesture;
  // ONE ROW PER KIND: its name, its applier, what applyEdit owes the
  // graph once it applied, whether it stays live under a take, and the
  // gesture family its live commits coalesce in.
  switch (kind) {
    case K::Nop:
      return {"Nop", nullptr, T::FACTS, U::WAITS, G::NONE};
    case K::Insert:
      return {"Insert", &E::applyInsert, T::STRUCTURE, U::LIVE, G::NONE};
    case K::Remove:
      return {"Remove", &E::applyRemove, T::STRUCTURE, U::WAITS, G::NONE};
    case K::Move:
      return {"Move", &E::applyMove, T::STRUCTURE, U::WAITS, G::NONE};
    case K::Combine:
      return {"Combine", &E::applyCombine, T::STRUCTURE, U::WAITS, G::NONE};
    case K::Explode:
      return {"Explode", &E::applyExplode, T::STRUCTURE, U::WAITS, G::NONE};
    case K::Rename:
      return {"Rename", &E::applyRename, T::FACTS, U::LIVE, G::NONE};
    case K::Mute:
      return {"Mute", &E::applyMute, T::FACTS, U::LIVE, G::NONE};
    case K::LoopPoints:
      return {"LoopPoints", &E::applyLoopPoints, T::FACTS, U::WAITS, G::MAP};
    case K::LoopBypass:
      return {"LoopBypass", &E::applyLoopBypass, T::FACTS, U::WAITS, G::NONE};
    case K::Segments:
      return {"Segments", &E::applySegments, T::FACTS, U::WAITS, G::MAP};
    case K::PeriodSource:
      return {"PeriodSource", &E::applyPeriodSource, T::FACTS, U::WAITS,
              G::NONE};
    case K::Input:
      return {"Input", &E::applyInput, T::FACTS, U::LIVE, G::NONE};
    case K::InputR:
      return {"InputR", &E::applyInputR, T::FACTS, U::LIVE, G::NONE};
    case K::Collapse:
      return {"Collapse", &E::applyCollapse, T::FACTS, U::WAITS, G::NONE};
    case K::MoveSlot:
      return {"MoveSlot", &E::applyMoveSlot, T::FACTS, U::LIVE, G::NONE};
    case K::AddSlot:
      return {"AddSlot", &E::applyAddSlot, T::FACTS, U::LIVE, G::NONE};
    case K::RemoveSlot:
      return {"RemoveSlot", &E::applyRemoveSlot, T::FACTS, U::LIVE, G::NONE};
    case K::Sequence:
      return {"Sequence", &E::applySequence, T::ROOT_ANCHOR, U::WAITS,
              G::NONE};
    case K::SequenceBypass:
      return {"SequenceBypass", &E::applySequenceBypass, T::FACTS, U::WAITS,
              G::NONE};
    case K::Take:
      return {"Take", &E::applyTake, T::CONTENT, U::WAITS, G::NONE};
    case K::Untake:
      return {"Untake", &E::applyTake, T::CONTENT, U::WAITS, G::NONE};
    case K::SelectTake:
      return {"SelectTake", &E::applySelectTake, T::FACTS, U::WAITS, G::NONE};
    case K::DeleteTake:
      return {"DeleteTake", &E::applyDeleteTake, T::FACTS, U::WAITS, G::NONE};
    case K::Comp:
      return {"Comp", &E::applyComp, T::FACTS, U::WAITS, G::NONE};
    case K::Timing:
      return {"Timing", &E::applyTiming, T::FACTS, U::WAITS, G::TIMING};
    case K::Definer:
      return {"Definer", &E::applyDefiner, T::FACTS, U::WAITS, G::NONE};
  }
  return {"?", nullptr, T::FACTS, U::WAITS, G::NONE};
}

Edit AudioEngine::applyEdit(Edit e) {
  // A COMPOSED step (Edit::then): this edit, then the next, each applied
  // whole; the inverse leads with the later edit's. An edit that does
  // not apply ends the step there — what did apply is what the inverse
  // undoes.
  if (std::unique_ptr<Edit> next = std::move(e.then)) {
    Edit inv = applyEdit(std::move(e));
    if (inv.kind == Edit::Kind::Nop) {
      retireEdit(std::move(*next));
      return inv;
    }
    Edit next_inv = applyEdit(std::move(*next));
    if (next_inv.kind == Edit::Kind::Nop) return inv;
    Edit* last = &next_inv;
    while (last->then != nullptr) last = last->then.get();
    last->then = std::make_unique<Edit>(std::move(inv));
    return next_inv;
  }
  const KindTraits traits = traitsOf(e.kind);
  if (traits.apply == nullptr) return {};
  // Every path here has passed the live-take gate, and the appliers rely
  // on it: none looks for a take of its own.
  jassert(traits.under_take == KindTraits::UnderTake::LIVE ||
          !root_node->hasActiveTake());
  // The anchoring an undo or redo carries is the one the settle below
  // produced the first time (Q18): it is applied, never derived again.
  Edit anchor_riders;
  anchor_riders.anchors = std::move(e.anchors);
  Edit inv = (this->*traits.apply)(std::move(e));
  if (inv.kind == Edit::Kind::Nop) return inv;
  using Touches = KindTraits::Touches;
  if (traits.touches != Touches::FACTS) {
    if (!anchor_riders.anchors.empty()) applyAnchorRiders(anchor_riders, inv);
    if (traits.touches != Touches::ROOT_ANCHOR) settleAnchors(inv);
  }
  // The one place a change of topology reaches the audio thread.
  if (traits.touches == Touches::STRUCTURE) publishGraph();
  return inv;
}

// --- Retirement -------------------------------------------------------

void AudioEngine::retireEdit(Edit&& e) {
  // NEVER FREED INLINE: what an edit owns — a detached subtree, a take's
  // buffer, notes and reserved storage, a chain slot — was reachable from
  // a graph the audio thread may still be walking, so a dropped edit
  // hands all of it to the reclaimer (retire).
  using celestrian::engine_internal::retireTake;
  if (e.then != nullptr) retireEdit(std::move(*e.then));
  retireOwned(std::move(e.buffer));
  retireOwned(std::move(e.node));
  for (auto& payload : e.takes) retireTake(*this, std::move(payload.state));
  for (auto& other : e.other_takes) retireTake(*this, std::move(other.second));
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
  endGesture();
}

void AudioEngine::pushUndo(Edit&& inverse) {
  undo_.push_back(std::move(inverse));
  while (undo_.size() > kUndoDepth) {
    retireEdit(std::move(undo_.front()));
    undo_.erase(undo_.begin());
  }
  clearRedo();
  endGesture();
}

// --- The live-take gate -----------------------------------------------

bool AudioEngine::refusedUnderLiveTake(const char* verb) const {
  if (!root_node->hasActiveTake()) return false;
  juce::Logger::writeToLog(
      juce::String("AudioEngine: ") + verb +
      " refused - a take is armed or capturing (edits wait for the take)");
  return true;
}

bool AudioEngine::refusedUnderLiveTake(Edit::Kind kind,
                                       const char* verb) const {
  return traitsOf(kind).under_take == KindTraits::UnderTake::WAITS &&
         refusedUnderLiveTake(verb);
}

// --- The gesture ------------------------------------------------------
//
// A drag streams throttled commits, so the edit is audible while it
// moves, and the whole drag is ONE undo step (loop_selection.md §14).
// Its first commit arrives non-live and opens the gesture (openGesture)
// whatever it goes on to record; every later commit carries Edit::live.
// The first of them all to APPLY logs the gesture's entry, and the live
// commits after it coalesce into that entry: it already restores the
// gesture's start, so a later inverse only completes it
// (completeGestureEntry) and is dropped. A commit that records nothing —
// an identity, a refusal — keeps the gesture open: a drag that dwells, or
// returns to its start, is still one step.
//
// The gesture is TRACKED (gesture_), never read off the stack's top: a
// first commit that recorded nothing leaves the PREVIOUS gesture's entry
// there. While the gesture is `logged` its entry is the top; any other
// entry logged, an undo and a redo end it, so a stray live commit logs a
// step of its own. Commits pair within one family
// (KindTraits::Gesture) — a window may become a cell map mid-drag, a
// re-time never joins a map edit — and only live commits coalesce: two
// gestures on one lane, however close in time, are two steps.

void AudioEngine::openGesture(const juce::String& uuid, Edit::Kind kind) {
  endGesture();  // the previous gesture can no longer be cancelled
  gesture_ = {uuid, kind, false};
}

void AudioEngine::endGesture() {
  // The redo branch the gesture's entry invalidated can no longer come
  // back (only cancelGesture restores it).
  for (auto& e : gesture_redo_) retireEdit(std::move(e));
  gesture_redo_.clear();
  gesture_ = {};
}

bool AudioEngine::record(Edit forward) {
  reconcileTakes();  // a settled take is logged before any later edit
  if (refusedUnderLiveTake(forward.kind, "edit")) return false;
  const KindTraits traits = traitsOf(forward.kind);
  const bool live = forward.live;
  const juce::String uuid = forward.uuid;
  const Edit::Kind kind = forward.kind;
  using Gesture = KindTraits::Gesture;
  const bool coalesces = live && gesture_.logged && gesture_.uuid == uuid &&
                         traits.gesture != Gesture::NONE &&
                         traitsOf(gesture_.kind).gesture == traits.gesture &&
                         !undo_.empty();
  // A coalescing map commit reconciles the top from the base its
  // gesture STARTED with — the one the gesture's entry recorded
  // (reconcileTopRider) — never from the previous live commit's.
  if (coalesces && traits.gesture == Gesture::MAP && !forward.setsTop &&
      undo_.back().hasTopBase) {
    forward.hasTopBase = true;
    forward.topBase = undo_.back().topBase;
  }
  Edit inv = applyEdit(std::move(forward));
  if (inv.kind == Edit::Kind::Nop) return false;
  noteOriginDrift(driftCause(root_node.get(), live ? "live edit" : "edit",
                             traits.name, uuid));
  if (coalesces) {
    completeGestureEntry(undo_.back(), inv);
    return true;
  }
  // A map or re-time entry is its gesture's first. The redo branch it
  // invalidates is KEPT for as long as the gesture can be cancelled: a
  // cancelled drag leaves the log as it found it, redo and all.
  const bool gesture_entry = traits.gesture != Gesture::NONE;
  std::vector<Edit> kept_redo;
  if (gesture_entry) kept_redo.swap(redo_);
  pushUndo(std::move(inv));
  if (gesture_entry) {
    gesture_ = {uuid, kind, true};
    gesture_redo_ = std::move(kept_redo);
  }
  return true;
}

bool AudioEngine::cancelGesture(const juce::String& uuid) {
  reconcileTakes();
  // Not this node's gesture: whatever a drag logged here stands.
  if (gesture_.uuid != uuid || gesture_.kind == Edit::Kind::Nop) return false;
  if (!gesture_.logged || undo_.empty()) {
    endGesture();  // it logged nothing: the node is as the drag found it
    return true;
  }
  // Refused under a take like undo, and the entry is kept.
  if (refusedUnderLiveTake("cancelGesture")) return false;
  // The gesture's entry is the top of the stack: apply it — the graph is
  // the gesture's start again — and drop the forward it yields.
  Edit inv = std::move(undo_.back());
  undo_.pop_back();
  const juce::String cause = driftCause(root_node.get(), "cancel",
                                        traitsOf(inv.kind).name, inv.uuid);
  Edit forward = applyEdit(std::move(inv));
  noteOriginDrift(cause);
  if (forward.kind == Edit::Kind::Nop) {
    endGesture();  // it did not apply: the kept branch is no longer valid
    return false;
  }
  retireEdit(std::move(forward));
  // The redo branch the entry invalidated was recorded against exactly
  // this graph: it stands again.
  clearRedo();
  redo_ = std::move(gesture_redo_);
  gesture_redo_.clear();
  gesture_ = {};
  return true;
}

// --- Undo and redo ----------------------------------------------------

bool AudioEngine::replay(std::vector<Edit>& from, std::vector<Edit>& onto,
                         const char* verb) {
  reconcileTakes();
  // Under a take the entry is refused and KEPT: applied, it could move
  // the grid the performer records against.
  if (from.empty() || refusedUnderLiveTake(verb)) return false;
  endGesture();  // a later live commit logs a step of its own
  Edit edit = std::move(from.back());
  from.pop_back();
  const juce::String cause = driftCause(root_node.get(), verb,
                                        traitsOf(edit.kind).name, edit.uuid);
  Edit back = applyEdit(std::move(edit));
  noteOriginDrift(cause);
  if (back.kind == Edit::Kind::Nop) return false;  // it no longer applies
  onto.push_back(std::move(back));
  return true;
}

bool AudioEngine::undo() { return replay(undo_, redo_, "undo"); }

bool AudioEngine::redo() { return replay(redo_, undo_, "redo"); }

// --- The arm's own edits ----------------------------------------------

AudioEngine::ArmEdits AudioEngine::applyArmEdits(
    const celestrian::AudioNode* exclude,
    const std::vector<celestrian::ClipNode*>* retakes) {
  ArmEdits edits;
  // The definer's trim locks at the arm (collapseNode); the applier
  // answers Nop when there is nothing to collapse.
  if (auto* definer_node = celestrian::engine_internal::definer(*root_node);
      definer_node != nullptr && definer_node != exclude) {
    Edit collapse(Edit::Kind::Collapse);
    collapse.uuid = definer_node->getUuid();
    edits.collapse_inverse = applyEdit(std::move(collapse));
  }
  // Recording new content ends a hand-off (Q22) as it ends a first
  // take's trim: the designated definer collapsed just above — still the
  // definer then — and the designation clears.
  const auto endsHandOff = [&] {
    const juce::String& designation = root_node->definerDesignation();
    auto* designated = findNodeByUuid(designation);
    if (designation.isEmpty() || designated == nullptr) return false;
    if (retakes == nullptr || retakes->empty()) return true;
    // A new take of the designated node, or of its members, re-records
    // the definer: the hand-off stands.
    return !std::all_of(retakes->begin(), retakes->end(),
                        [designated](const celestrian::ClipNode* clip) {
                          return celestrian::edit_internal::isWithin(
                              clip, designated);
                        });
  };
  if (endsHandOff()) {
    edits.release_inverse = applyEdit(Edit(Edit::Kind::Definer));
  }
  return edits;
}

void AudioEngine::logArmEdits(ArmEdits&& edits) {
  for (Edit* inverse : {&edits.collapse_inverse, &edits.release_inverse}) {
    if (inverse->kind == Edit::Kind::Nop) continue;
    noteOriginDrift(driftCause(root_node.get(), "edit",
                               traitsOf(inverse->kind).name, inverse->uuid));
    pushUndo(std::move(*inverse));
  }
}

void AudioEngine::revertArmEdits(ArmEdits&& edits) {
  // Last applied, first put back. Nothing was logged, so the forwards
  // the inverses yield are dropped: a refused arm is not redo-able.
  for (Edit* inverse : {&edits.release_inverse, &edits.collapse_inverse}) {
    if (inverse->kind == Edit::Kind::Nop) continue;
    retireEdit(applyEdit(std::move(*inverse)));
  }
}
