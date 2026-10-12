// AudioEngine — the MAP, RE-TIME and SEQUENCE verbs: setLoopPoints and
// setSegments (two entry points of one map commit, commitMap),
// toggleLoopWindow, setTiming, setSequence, toggleSequence and the step
// audition. Each judges its request, builds an Edit and records it; the
// appliers are engine/edit_geometry.cc and edit_facts.cc. Message thread
// only.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../heard_index.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

namespace {
using celestrian::AudioNode;
using celestrian::ClipNode;
using celestrian::Edit;
using celestrian::StackNode;
using celestrian::timing::TimeMap;
namespace heard = celestrian::heard;

bool sameMap(const TimeMap& a, const TimeMap& b) {
  if (a.n != b.n) return false;
  for (int i = 0; i < a.n; ++i) {
    if (a.segs[i].start != b.segs[i].start || a.segs[i].end != b.segs[i].end) {
      return false;
    }
  }
  return true;
}

/** THE ROOT'S MAP IS THE ISLAND'S LOOP REGION (composition.md §4): it
 * selects from the island's own timeline and folds from the island zero.
 * An island with no Q has neither — no content, no zero — so its root
 * has no region to set and none to bypass. (An empty GROUP differs: it is
 * a part authored ahead of its first take, and its geometry meets the
 * scrub when Q is established.) */
bool isRootOfEmptyIsland(const StackNode& root, const AudioNode& node) {
  return &node == &root && root.getQuantum() <= 0;
}

/** THE SOLE DEFINER'S RE-ANCHOR (Q13): the origin at which the node goes
 * on sounding through a re-trim to `map`. The node's received clock is
 * the frame its origin lives in (heard_index.h).
 *
 * A map that still plays the position sounding now KEEPS IT SOUNDING,
 * whatever its shape and whether or not a map was in force
 * (time_maps.md §5). When the re-trim removed that position the two
 * shapes answer differently, and each keeps its own rule:
 *   - a WINDOW folds the position into itself by where it lies in the
 *     content (heard::foldIntoWindow);
 *   - a CELL MAP folds the old HEARD phase into its period
 *     (heard::originForHeard) — and with no map in force, its pass
 *     starts at this moment. */
int64_t soleDefinerOrigin(const AudioEngine& engine, const AudioNode& node,
                          const TimeMap& map) {
  const heard::Received received =
      heard::receivedAt(node, engine.transportClock(), engine.rootScope());
  const int64_t sounding =
      heard::ownInnerAt(node, received.clock, received.scope).inner;
  if (map.n == 1) {
    return received.clock -
           heard::foldIntoWindow(sounding, map.segs[0].start, map.period());
  }
  const TimeMap old_map = node.activeTimeMap();
  const int64_t old_heard_phase =
      old_map.active() && old_map.period() > 0
          ? old_map.heardOffsetOf(sounding)
          : 0;
  return heard::originForHeard(map, received.clock, sounding, old_heard_phase);
}

/** MEMBERS WHOLE: the definer stack's window is the group's one region,
 * so a member still holding a window or a cell map of its own — it would
 * loop its slice under the stack's — goes whole with the same edit. A
 * window spanning the member's whole take restricts nothing and stays. */
void attachMembersWholeRiders(const StackNode& stack, Edit& e) {
  for (const auto& child : stack.ownedChildren()) {
    auto* member = dynamic_cast<ClipNode*>(child.get());
    if (member == nullptr || member->getIntrinsicDuration() <= 0) continue;
    const bool whole =
        !member->hasSegmentMap() &&
        (member->getLoopEnd() <= member->getLoopStart() ||
         (member->getLoopStart() == 0 &&
          member->getLoopEnd() >= member->getIntrinsicDuration()));
    if (whole) continue;
    Edit::WindowRider rider;  // start = end = 0: no window
    rider.uuid = member->getUuid();
    e.windows.push_back(std::move(rider));
  }
}

/** The bridge's sequence payload (lengths in samples) as a Sequence:
 * null for a void payload or one with no steps (a clear). AN EDIT IS
 * STRICT: a payload the one reader (Sequence::fromVar) could not take
 * whole is refused — `refusal` says what it would have dropped. */
std::unique_ptr<celestrian::Sequence> sequenceFromPayload(
    const juce::var& payload, juce::String& refusal) {
  using celestrian::Sequence;
  Sequence::Dropped dropped;
  auto seq = Sequence::fromVar(
      payload, Sequence::kSampleKeys,
      [](const juce::var& v) { return (int64_t)(double)v; }, dropped);
  if (dropped.any()) {
    refusal = dropped.what();
    return nullptr;
  }
  return seq;
}
}  // namespace

// --- The map ----------------------------------------------------------

bool AudioEngine::setLoopPoints(const juce::String& uuid, int64_t start,
                                int64_t end, bool live) {
  if (!live) openGesture(uuid, Edit::Kind::LoopPoints);
  auto* target = findNodeByUuid(uuid);
  if (target == nullptr) return false;
  const bool is_clip = target->getNodeType() == celestrian::NodeType::Clip;
  const int64_t duration = target->getIntrinsicDuration();
  const bool definer_stack =
      !is_clip && celestrian::engine_internal::definer(*root_node) == target;
  // A window selects material, so it is CLAMPED to it: a clip's to its
  // take, the definer stack's to its inner cycle. Any other stack's
  // window past its inner cycle is malformed and refused, as setSegments
  // refuses it.
  start = std::max<int64_t>(0, start);
  if (!is_clip && !definer_stack && duration > 0 && end > duration) {
    juce::Logger::writeToLog(
        "AudioEngine::setLoopPoints refused - window end " +
        juce::String(end) + " is past the stack's inner cycle " +
        juce::String(duration));
    return false;
  }
  // The window is judged (identity, coherence) as it would be stored: a
  // drag past the material is the window that ends at it.
  const bool clamps = is_clip || definer_stack;
  return commitMap(
      *target, TimeMap::single(start, clamps ? std::min(end, duration) : end),
      live);
}

bool AudioEngine::setSegments(const juce::String& uuid, const TimeMap& map,
                              bool live) {
  if (!live) openGesture(uuid, Edit::Kind::Segments);
  auto* target = findNodeByUuid(uuid);
  if (target == nullptr) return false;
  const int64_t duration = target->getIntrinsicDuration();
  // An EMPTY clip has no material for cells to select, and no extent for
  // the bound below to judge them by.
  if (map.n >= 2 && duration <= 0 &&
      target->getNodeType() == celestrian::NodeType::Clip) {
    juce::Logger::writeToLog(
        "AudioEngine::setSegments refused - nothing committed here to map "
        "(record a take first)");
    return false;
  }
  // WELL-FORMED (time_maps.md §4): ordered, disjoint, each non-empty,
  // within the node's inner cycle. Never clamped.
  int64_t previous_end = 0;
  for (int i = 0; i < map.n; ++i) {
    const auto& segment = map.segs[i];
    if (segment.end <= segment.start || segment.start < previous_end ||
        (duration > 0 && segment.end > duration)) {
      juce::Logger::writeToLog(
          "AudioEngine::setSegments refused - malformed segment list");
      return false;
    }
    previous_end = segment.end;
  }
  // No segment and one segment are the single-window form.
  if (map.n == 0) return setLoopPoints(uuid, 0, 0, live);
  if (map.n == 1) {
    return setLoopPoints(uuid, map.segs[0].start, map.segs[0].end, live);
  }
  return commitMap(*target, map, live);
}

bool AudioEngine::commitMap(AudioNode& target, const TimeMap& map, bool live) {
  // A map on the root of an empty island selects nothing. Clearing one a
  // delete left stored there is not refused.
  if (map.n > 0 && isRootOfEmptyIsland(*root_node, target)) {
    juce::Logger::writeToLog(
        "AudioEngine: map edit refused - the island is empty: its root has "
        "no loop region to set");
    return false;
  }
  // IDENTITY RECORDS NOTHING: re-committing the stored map — a bracket
  // clicked without moving, a drag's first commit before it crosses a
  // whole Q — would log an empty undo step, drop the redo branch and, on
  // a definer, solve its origin anew.
  if (sameMap(target.storedMap(), map)) return false;
  const int64_t duration = target.getIntrinsicDuration();
  // THE DEFINER's map RE-ESTABLISHES Q (Q13; a designated definer, Q22):
  // every gate is engine_internal::definer's.
  const bool definer =
      duration > 0 &&
      celestrian::engine_internal::definer(*root_node) == &target;
  // COHERENCE (time_maps.md §4) is categorical: any other node's period
  // must be a whole multiple or an exact divisor of Q, or the effective
  // cycle LCM-explodes. The view snaps; the engine enforces.
  if (const int64_t q = target.getEffectiveQuantum();
      map.n > 0 && !definer && q > 0 &&
      !isPeriodCoherentWithQuantum(map.period(), q)) {
    juce::Logger::writeToLog(
        "AudioEngine: map edit refused - period " + juce::String(map.period()) +
        " is neither a whole multiple nor an exact divisor of Q " +
        juce::String(q));
    return false;
  }

  Edit e(map.n >= 2 ? Edit::Kind::Segments : Edit::Kind::LoopPoints);
  e.uuid = target.getUuid();
  if (map.n >= 2) {
    e.setsMap = true;
    e.tmap = map;
  } else if (map.n == 1) {
    e.i1 = map.segs[0].start;
    e.i2 = map.segs[0].end;
  }
  if (definer) {
    // The island's facts ride the edit, so they undo with the map. A
    // stack not yet anchored measures from the island zero.
    auto* stack = dynamic_cast<StackNode*>(&target);
    const bool anchored = stack == nullptr || target.isAnchored();
    const int64_t origin =
        anchored ? target.origin_samples.load() : root_node->getZero();
    e.setsIsland = true;
    if (map.n == 0) {
      // CLEARED: the whole take (or the group's whole inner cycle) is
      // the part again — Q := its length, zero := its origin, as the
      // first commit established them.
      e.iq = duration;
      e.izero = origin;
    } else if (!celestrian::engine_internal::holdsAllCommittedContent(
                   *root_node, target)) {
      // WITH COMPANY (a designated definer): other tracks play against
      // it, so its origin stays — Q := the period, zero := the map's top
      // — and company that no longer fits the grid drifts
      // (period_law.h).
      e.iq = map.period();
      e.izero = origin + map.mapOffset(0);
    } else {
      // SOLE: the origin re-anchors so the audio flows through the trim,
      // and the grid derives from it. A stack's origin moves its whole
      // subtree; the ancestors anchored on the definer follow (Q18).
      const int64_t re_anchored = soleDefinerOrigin(*this, target, map);
      if (anchored) {
        e.setsOrigin = true;
        e.iorg = re_anchored;
        e.liftsAncestors = true;
      }
      e.iq = map.period();
      e.izero = re_anchored + map.mapOffset(0);
    }
    if (stack != nullptr) attachMembersWholeRiders(*stack, e);
  } else if (duration > 0) {
    attachMapEditRiders(e, target, map);  // the continuity re-anchor
  }
  e.live = live;
  return record(std::move(e));
}

bool AudioEngine::toggleLoopWindow(const juce::String& uuid) {
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return false;
  if (isRootOfEmptyIsland(*root_node, *node)) {
    juce::Logger::writeToLog(
        "AudioEngine::toggleLoopWindow refused - the island is empty: its "
        "root has no loop region to bypass");
    return false;
  }
  Edit e(Edit::Kind::LoopBypass);
  e.uuid = uuid;
  e.b1 = !node->isLoopWindowBypassed();
  return record(std::move(e));
}

// --- The re-time ------------------------------------------------------

bool AudioEngine::setTiming(const juce::String& uuid, int64_t shift,
                            std::optional<int64_t> top, bool live) {
  // A ↺ drag may open on a zero shift: the gesture opens before any gate.
  if (!live) openGesture(uuid, Edit::Kind::Timing);
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::setTiming refused - " + why);
    return false;
  };
  AudioNode* node = findNodeByUuid(uuid);
  if (node == nullptr || node == root_node.get()) {
    return refuse(uuid + " is not a track or group");
  }
  // Committed: a clip with a take, a group anchored by its content.
  const bool committed = node->getNodeType() == celestrian::NodeType::Stack
                             ? node->isAnchored()
                             : node->getIntrinsicDuration() > 0;
  if (!committed) return refuse("nothing committed here to re-time");
  // The Q-definer's frame top IS the island zero: moving it re-times
  // nothing against anything, and its trims re-establish the grid
  // instead. The predicate the state publishes as `definerId`.
  if (celestrian::engine_internal::definer(*root_node) == node) {
    return refuse("the Q-definer's origin is the island zero");
  }
  // Refused whole: no half-applied shift.
  if (top.has_value() && !node->keepsTop(*top)) {
    return refuse("top " + juce::String(*top) + " is outside the kept set");
  }
  // Identity records nothing (commitMap).
  if (shift == 0 && (!top.has_value() || *top == node->storedTop())) {
    return false;
  }
  // Absolute values (the applier's inverse is the same shape): the origin
  // moves by exactly `shift`, and the re-time counts it.
  Edit e(Edit::Kind::Timing);
  e.uuid = uuid;
  e.setsOrigin = true;
  e.iorg = node->origin_samples.load() + shift;
  e.setsRetime = true;
  e.iretime = node->retime() + shift;
  if (top.has_value()) {
    e.setsTop = true;
    e.itop = *top;
  }
  e.live = live;
  return record(std::move(e));
}

// --- The sequence -----------------------------------------------------

bool AudioEngine::setSequence(const juce::String& uuid,
                              const juce::var& payload,
                              std::optional<int64_t> zero) {
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::setSequence refused - " + why);
    return false;
  };
  auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(uuid));
  if (stack == nullptr) return refuse("target is not a stack");
  Edit e(Edit::Kind::Sequence);
  e.uuid = uuid;
  juce::String malformed;
  e.seq = sequenceFromPayload(payload, malformed);
  if (malformed.isNotEmpty()) return refuse(malformed);
  // A RADIO has no period to give a parent, so it is legal only where no
  // ancestor needs one: the root (S12, composition.md §3).
  if (e.seq != nullptr && e.seq->radio && stack != root_node.get()) {
    return refuse("a radio (stochastic or non-returning successors) has no "
                  "period; root only (S12)");
  }
  // THE ROOT'S ANCHOR RIDES ITS SONG (docs/frame.md §4; Q18 at depth 0):
  // a song authored on the root anchors it at the zero the view had
  // seated — snapped to the Q grid, the island zero when absent — so
  // authoring moves nothing on screen. A root that already carries a song
  // keeps its origin; clearing the song un-anchors it. Either way the
  // change is an anchor rider, which the inverse reverses exactly.
  if (stack == root_node.get()) {
    const int64_t q = root_node->getQuantum();
    const bool anchored = root_node->isAnchored();
    Edit::AnchorRider rider;
    rider.uuid = uuid;
    if (e.seq != nullptr && !anchored && q > 0) {
      const int64_t island_zero = root_node->getZero();
      const int64_t seated = zero.value_or(island_zero);
      rider.anchored = true;
      rider.origin =
          seated - celestrian::timing::posMod(seated - island_zero, q);
      e.anchors.push_back(std::move(rider));
    } else if (e.seq == nullptr && anchored) {
      e.anchors.push_back(std::move(rider));  // anchored = false
    }
  }
  // Identity records nothing (commitMap): the song the stack already
  // holds — or a clear where there is none — with no anchor to move.
  if (e.anchors.empty() &&
      celestrian::Sequence::sameSong(e.seq.get(), stack->sequencePtr())) {
    return false;
  }
  return record(std::move(e));
}

bool AudioEngine::toggleSequence(const juce::String& uuid) {
  auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(uuid));
  if (stack == nullptr) return false;
  // THE BYPASS IS A FACT OF THE SONG: it is published and saved inside
  // it, so a stack with no song has none to flip — a flag set there
  // would surface only on the next song authored, born bypassed.
  if (stack->sequencePtr() == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::toggleSequence refused - no song to bypass");
    return false;
  }
  Edit e(Edit::Kind::SequenceBypass);
  e.uuid = uuid;
  e.b1 = !stack->isSequenceBypassed();
  return record(std::move(e));
}

bool AudioEngine::auditionStep(const juce::String& uuid, int step) {
  // A monitoring gesture, not an edit: nothing is recorded. The stack's
  // active map becomes the step's span (StackNode::activeTimeMap) until
  // −1 clears it. Refused under a take: the audition would change the
  // frame the performer hears.
  auto* stack = dynamic_cast<StackNode*>(findNodeByUuid(uuid));
  if (stack == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::auditionStep refused - target is not a stack");
    return false;
  }
  if (refusedUnderLiveTake("auditionStep")) return false;
  if (step >= 0) {
    const celestrian::Sequence* sequence = stack->activeSequence();
    if (sequence == nullptr || !sequence->reachableStep(step)) {
      juce::Logger::writeToLog(
          "AudioEngine::auditionStep refused - no such step in the active "
          "program (unreachable steps have no span)");
      return false;
    }
  }
  stack->setAuditionStep(step < 0 ? -1 : step);
  juce::Logger::writeToLog("AudioEngine: audition step " + juce::String(step) +
                           " on " + uuid);
  return true;
}
