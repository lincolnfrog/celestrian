// AudioEngine — MAP + SEQUENCE EDITS: the loop-window and segment-map
// verbs (setLoopPoints, setSegments, toggleLoopWindow) with their
// mid-take gates, the coherence guard and the Q13 definer re-trim
// riders; the sequencer verbs (setSequence, auditionStep,
// toggleSequence). Each records an Edit; the edit log applies it.
// Message thread only.

#include "../audio_engine.h"

#include "../heard_index.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

using celestrian::engine_internal::definerStack;
using celestrian::engine_internal::hasActiveGeometryOutside;

void AudioEngine::setLoopPoints(const juce::String& uuid, int64_t start,
                                int64_t end) {
  juce::Logger::writeToLog("AudioEngine::setLoopPoints: uuid=" + uuid +
                           " start=" + juce::String(start) +
                           " end=" + juce::String(end));
  // MID-TAKE MAP-EDIT GATE (time_maps.md phase 2): a take recording
  // THROUGH this node's map froze the map's geometry at arm (anchor,
  // seams, commit cycle) — editing the window under it would change
  // time under the recorder. Refuse until the take commits. The gate
  // covers the recording TARGET itself too (a window authored on the
  // clip being recorded would survive to its commit as incoherent
  // geometry). Sibling windows stay editable (they don't shape this
  // recorder's clock; their heard-cycle effect was snapshotted at arm).
  if (auto* target = findNodeByUuid(root_node.get(), uuid);
      target && target->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setLoopPoints refused - a take is recording "
        "here (finish or cancel it first)");
    return;
  }
  // COHERENCE GUARD (time_maps.md §6): a window length off the Q grid
  // is refused — categorical, both sides (the UI snaps; the engine
  // enforces). One incoherent map period LCM-explodes the effective
  // cycle and blanks the timeline.
  // The sole exception is the Q13 sole-definer re-trim below, where
  // the window length *re-establishes* Q rather than fighting it.
  // Lengths are checked post-clamp (the same clamp the clip branch
  // applies), so the judged window is the one that would be stored.
  if (auto* target = findNodeByUuid(root_node.get(), uuid)) {
    const int64_t c_start = std::max((int64_t)0, start);
    int64_t c_end = end;
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    if (clip != nullptr) c_end = std::min(end, clip->getIntrinsicDuration());
    // IDENTITY EDITS RECORD NOTHING: a zero-movement bracket click
    // would re-commit the stored window — a no-op undo step that also
    // destroys the redo branch (and, on a definer, churns the origin by
    // a whole window length). An installed override still applies:
    // this edit replaces it.
    {
      const bool same_cleared = c_end <= c_start &&
                                target->getLoopEnd() <= target->getLoopStart();
      if (!target->hasSegmentMap() &&
          (same_cleared || (c_start == target->getLoopStart() &&
                            c_end == target->getLoopEnd()))) {
        return;
      }
    }
    // A stack window selects over its INNER cycle: a window past it is
    // malformed — refused, as setSegments refuses. The definer branch
    // below clamps instead (its UI clamps to the raw extent; the two
    // agree).
    const bool stack_definer_early =
        clip == nullptr && definerStack(root_node.get()) == target &&
        !root_node->hasActiveTake() &&
        !static_cast<celestrian::StackNode*>(target)->auditionActive();
    if (clip == nullptr && !stack_definer_early &&
        target->getIntrinsicDuration() > 0 && end > target->getIntrinsicDuration()) {
      juce::Logger::writeToLog(
          "AudioEngine::setLoopPoints refused - window end " +
          juce::String(end) + " is past the stack's inner cycle " +
          juce::String(target->getIntrinsicDuration()));
      return;
    }
    const bool clip_definer = clip != nullptr &&
                              clip->getIntrinsicDuration() > 0 &&
                              islandCommittedClipCount() == 1 &&
                              !hasActiveGeometryOutside(root_node.get(), clip);
    // Q13 for groups: the definer STACK's window re-establishes Q too.
    const bool stack_definer =
        clip == nullptr && definerStack(root_node.get()) == target &&
        !static_cast<celestrian::StackNode*>(target)->auditionActive();
    const bool q13_retrim = c_end > c_start &&
                            (clip_definer || stack_definer) &&
                            !root_node->hasActiveTake();
    const int64_t q = target->getEffectiveQuantum();
    const int64_t len = c_end - c_start;
    if (!q13_retrim && q > 0 && len > 0 &&
        !isPeriodCoherentWithQuantum(len, q)) {
      juce::Logger::writeToLog(
          "AudioEngine::setLoopPoints refused - window length " +
          juce::String(len) + " is neither a whole multiple nor an " +
          "exact divisor of Q " + juce::String(q) +
          " (coherence is categorical)");
      return;
    }
  }
  // Window phase is derived from the island clock (time_maps.md); nothing
  // to reset when the region changes. Undoable (LoopPoints).
  celestrian::Edit e(celestrian::Edit::Kind::LoopPoints);
  e.uuid = uuid;
  e.d1 = (double)start;
  e.d2 = (double)end;
  // Q13 — re-trim before lock, ONE PATH for clips and stacks (Q18,
  // composition.md §5): while the definer's geometry is the island's
  // only content, adjusting its loop region re-establishes the island
  // (Q, epoch): Q := window length, epoch := origin' + window start
  // (the performance moment of the trimmed loop's top), PHASE-
  // PRESERVING — the inner position sounding RIGHT NOW keeps sounding:
  // origin' = t0 − pT, and for a STACK
  // that origin shift moves its whole subtree (applySetsOrigin), so
  // the members follow their group with no per-member riders. The
  // re-establishment rides the LoopPoints edit so it undoes atomically
  // with the window. hasActiveTake: an armed/capturing take is already
  // performing against the current grid — while a take is in flight
  // this is an ordinary window edit.
  if (auto* target = findNodeByUuid(root_node.get(), uuid)) {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    auto* stack = dynamic_cast<celestrian::StackNode*>(target);
    const int64_t D = target->getIntrinsicDuration();
    const bool stack_definer = stack != nullptr &&
                               definerStack(root_node.get()) == stack &&
                               !root_node->hasActiveTake() &&
                               !stack->auditionActive();
    const bool clip_definer = clip != nullptr && D > 0 &&
                              islandCommittedClipCount() == 1 &&
                              !root_node->hasActiveTake() &&
                              !hasActiveGeometryOutside(root_node.get(), clip);
    // A window selects material — clamp to it (a fractional-Q drag
    // rounded past the take's end would otherwise produce a window, and
    // a Q, longer than the content it loops). Non-definer stacks are
    // refused above when past their inner cycle; the definer clamps
    // (its UI clamps to the raw extent; the two agree).
    start = std::max((int64_t)0, start);
    if (clip != nullptr || (stack_definer && D > 0)) end = std::min(end, D);
    e.d1 = (double)start;
    e.d2 = (double)end;
    const bool definer = clip_definer || stack_definer;
    const bool anchored = clip != nullptr || target->isAnchored();
    if (definer && end > start && D > 0) {
      const int64_t t0 = global_transport_pos.load();
      const int64_t len = end - start;
      // The inner position sounding NOW by the actual playback equation
      // (heard_index.h — one statement of the render, clip or stack,
      // active map / override included), folded into the new window.
      const int64_t p0 =
          celestrian::heard::nodeInner(*target, t0, cycleTopOf(*target));
      const int64_t pT = celestrian::heard::foldIntoWindow(p0, start, len);
      const int64_t origin1 = t0 - pT;
      if (anchored) {
        e.setsOrigin = true;
        e.iorg = origin1;
        e.liftsAncestors = true;  // the definer's ancestors follow (Q18)
      }
      e.setsIsland = true;
      e.iq = len;
      e.iepoch = origin1 + start;
    } else if (definer && D > 0) {
      // WINDOW CLEAR RE-ESTABLISHES THE BASE FACTS: the definer's
      // window was Q — clearing it restores the
      // whole take (or the group's whole inner cycle) as the part, so
      // Q := D and epoch := origin (the content-frame identity, exactly
      // as first commit established them).
      e.setsIsland = true;
      e.iq = D;
      e.iepoch = anchored ? target->origin_samples.load() : root_node->getEpoch();
    } else if (D > 0 && !root_node->hasActiveTake()) {
      // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (see attachMapEditRiders)
      // — clips and stacks alike since Q18.
      attachMapEditRiders(e, *target,
                          end > start
                              ? celestrian::timing::TimeMap::single(start, end)
                              : celestrian::timing::TimeMap::none(),
                          root_node->getEffectiveQuantum());
    }
    // MEMBERS WHOLE (the window law for the definer stack): a member
    // still carrying its own single window — a group take committed
    // before the group-window lift (reconcileTakes) — would loop its
    // slice UNDER the stack's window, and the trim view (which draws
    // members whole) would lie. Ride them whole with this edit.
    if (stack_definer) {
      for (const auto& child : stack->ownedChildren()) {
        auto* c = dynamic_cast<celestrian::ClipNode*>(child.get());
        if (c == nullptr || c->getIntrinsicDuration() <= 0) continue;
        const int64_t d = c->getIntrinsicDuration();
        if (!c->hasSegmentMap() && c->getLoopStart() == 0 &&
            c->getLoopEnd() >= d)
          continue;
        celestrian::Edit::WindowRider r;
        r.uuid = c->getUuid();
        r.start = 0;
        r.end = d;
        e.windows.push_back(std::move(r));
      }
    }
  }
  record(std::move(e));
}

void AudioEngine::setSegments(const juce::String& uuid,
                              const celestrian::timing::TimeMap& map) {
  using TimeMap = celestrian::timing::TimeMap;
  auto* target = findNodeByUuid(root_node.get(), uuid);
  if (target == nullptr) return;

  // MID-TAKE MAP-EDIT GATE (time_maps.md phase 2): a take recording
  // through this map froze its geometry at arm. Any armed/recording
  // target refuses (a stack answers for its subtree).
  if (target->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setSegments refused - a take is armed/recording "
        "here (finish or cancel it first)");
    return;
  }

  // Structural sanity only (time_maps.md §4: the EDITOR owns coherence
  // — seam theorem; the engine owns well-formedness): ordered,
  // disjoint, each non-empty, within the node's inner cycle.
  const int64_t intrinsic = target->getIntrinsicDuration();
  // An EMPTY clip has no material for a map to select: with intrinsic
  // 0 the per-segment bound check below never fires, so a segment list
  // would be accepted and its period would fight Q for a clip that
  // never joined the island. (The n ≤ 1 forms reach setLoopPoints,
  // whose clamp-to-duration clears them.)
  if (map.n >= 2 && intrinsic <= 0 &&
      dynamic_cast<celestrian::ClipNode*>(target) != nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::setSegments refused - nothing committed here to "
        "map (record a take first)");
    return;
  }
  int64_t prev_end = 0;
  for (int i = 0; i < map.n; ++i) {
    const auto& s = map.segs[i];
    if (s.end <= s.start || s.start < prev_end ||
        (intrinsic > 0 && s.end > intrinsic)) {
      juce::Logger::writeToLog(
          "AudioEngine::setSegments refused - malformed segment list");
      return;
    }
    prev_end = s.end;
  }

  // n ≤ 1 is the single-window form: ONE code path — setLoopPoints
  // owns the Q13 machinery and clears any override.
  if (map.n == 0) {
    setLoopPoints(uuid, 0, 0);
    return;
  }
  if (map.n == 1) {
    setLoopPoints(uuid, map.segs[0].start, map.segs[0].end);
    return;
  }

  // COHERENCE GUARD (time_maps.md §6): the map's PERIOD must be a whole
  // multiple of Q — categorical, both sides (the UI snaps; the engine
  // enforces). One incoherent period LCM-explodes the effective cycle
  // and blanks the timeline.
  // The sole exception is the Q13 sole-definer re-trim below, where
  // the period *re-establishes* Q rather than fighting it. (The n ≤ 1
  // delegations above are guarded inside setLoopPoints.)
  {
    const bool q13_retrim =
        (dynamic_cast<celestrian::ClipNode*>(target) != nullptr &&
         intrinsic > 0 && islandCommittedClipCount() == 1 &&
         !root_node->hasActiveTake() && !hasActiveGeometryOutside(root_node.get(), target)) ||
        // Q13 FOR GROUPS, the multi-segment twin: the definer STACK's
        // map re-establishes Q too.
        (definerStack(root_node.get()) == target &&
         !root_node->hasActiveTake() &&
         !static_cast<celestrian::StackNode*>(target)->auditionActive());
    const int64_t q = target->getEffectiveQuantum();
    const int64_t p = map.period();
    if (!q13_retrim && q > 0 && !isPeriodCoherentWithQuantum(p, q)) {
      juce::Logger::writeToLog(
          "AudioEngine::setSegments refused - period " + juce::String(p) +
          " is neither a whole multiple nor an " + "exact divisor of Q " +
          juce::String(q) + " (coherence is categorical)");
      return;
    }
  }

  celestrian::Edit e(celestrian::Edit::Kind::Segments);
  e.uuid = uuid;
  e.setsMap = true;
  e.tmap = map;

  // Q13 — multi-segment re-trim before lock (the punch/cell twin of
  // the provisional window trim): while the island's ONLY committed
  // content is this clip, the map re-establishes (Q := period,
  // epoch := origin' + mapOffset(0)), with the phase-preserving origin
  // re-anchor generalized through the map: the buffer position
  // sounding RIGHT NOW keeps sounding (inverse-mapped when still
  // covered; the old heard phase folds into the new period when the
  // cut removed it).
  // Q18: ONE path for the clip definer and the definer STACK — the
  // node's inner position sounding now re-anchors under the new map;
  // for a stack the origin shift moves its subtree (applySetsOrigin).
  {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    auto* stack = dynamic_cast<celestrian::StackNode*>(target);
    const bool clip_definer =
        clip != nullptr && intrinsic > 0 && islandCommittedClipCount() == 1 &&
        !root_node->hasActiveTake() &&
        !hasActiveGeometryOutside(root_node.get(), clip);
    const bool stack_definer = stack != nullptr &&
                               definerStack(root_node.get()) == stack &&
                               !root_node->hasActiveTake() &&
                               !stack->auditionActive() && intrinsic > 0;
    if (clip_definer || stack_definer) {
      const int64_t t0 = global_transport_pos.load();
      const TimeMap old_map = target->activeTimeMap();
      const int64_t period = map.period();
      const int64_t a0 = map.mapOffset(0);
      const int64_t fallback = cycleTopOf(*target);
      int64_t origin_new = t0 - a0;  // no old map: heard phase 0 at t0
      if (old_map.active() && old_map.period() > 0) {
        // heard_index.h: the position sounding now, re-anchored under
        // the new map (old heard phase folds in when the cut removed it).
        const int64_t p0 = celestrian::heard::nodeInner(*target, t0, fallback);
        origin_new = celestrian::heard::originForHeard(
            map, t0, p0, old_map.heardOffsetOf(p0));
      }
      if (clip != nullptr || target->isAnchored()) {
        e.setsOrigin = true;
        e.iorg = origin_new;
        e.liftsAncestors = true;  // the definer's ancestors follow (Q18)
      }
      e.setsIsland = true;
      e.iq = period;
      e.iepoch = origin_new + a0;
      if (stack != nullptr) {
        // MEMBERS WHOLE (the definer invariant): any member window or
        // override goes whole with the same edit.
        for (const auto& child : stack->ownedChildren()) {
          auto* c = dynamic_cast<celestrian::ClipNode*>(child.get());
          if (c == nullptr || c->getIntrinsicDuration() <= 0) continue;
          const int64_t d = c->getIntrinsicDuration();
          if (c->hasSegmentMap() || c->getLoopStart() != 0 ||
              c->getLoopEnd() < d) {
            celestrian::Edit::WindowRider w;
            w.uuid = c->getUuid();
            w.start = 0;
            w.end = d;
            e.windows.push_back(std::move(w));
          }
        }
      }
    } else if (intrinsic > 0 && !root_node->hasActiveTake()) {
      // CYCLE-TOP RULE + TWO-ANCHOR CONTINUITY (see attachMapEditRiders).
      attachMapEditRiders(e, *target, map, target->getEffectiveQuantum());
    }
  }

  record(std::move(e));
}

void AudioEngine::toggleLoopWindow(const juce::String& uuid) {
  // Fractal (I5): window state lives on AudioNode — clips toggle their
  // single-segment window exactly like stacks toggle their time-map.
  if (auto* node = findNodeByUuid(root_node.get(), uuid)) {
    // MID-TAKE MAP-EDIT GATE (see setLoopPoints): flipping a stack's
    // map under a live take would change time under the recorder.
    if (node->getNodeType() == celestrian::NodeType::Stack &&
        node->isArmedOrRecording()) {
      juce::Logger::writeToLog(
          "AudioEngine::toggleLoopWindow refused - a take is recording "
          "in this subtree (finish or cancel it first)");
      return;
    }
    celestrian::Edit e(celestrian::Edit::Kind::LoopBypass);
    e.uuid = uuid;
    e.b1 = !node->isLoopWindowBypassed();  // toggle to the opposite state
    record(std::move(e));
  }
}

void AudioEngine::setSequence(const juce::String& uuid,
                              const juce::var& payload) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::setSequence refused - target is not a stack");
    return;
  }
  // MID-TAKE GATE (docs/sequencer.md §9 S5 / the setSegments precedent):
  // a take recording in this subtree hears the sequence as its frame —
  // editing it mid-take would change the heard world under the recorder.
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setSequence refused - a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }

  celestrian::Edit e(celestrian::Edit::Kind::Sequence);
  e.uuid = uuid;

  // A void/empty payload clears the sequence (e.seq stays null).
  if (auto* o = payload.getDynamicObject()) {
    auto seq = std::make_unique<celestrian::Sequence>();
    if (auto* steps = o->getProperty("steps").getArray()) {
      for (const auto& sv : *steps) {
        if ((int)seq->steps.size() >= celestrian::Sequence::kMaxSteps) {
          juce::Logger::writeToLog(
              "AudioEngine::setSequence refused - more than 64 steps");
          return;
        }
        celestrian::Sequence::Step st;
        st.len = (int64_t)(double)sv.getProperty("len", {});
        st.name = sv.getProperty("name", {}).toString();
        st.cue = (bool)sv.getProperty("cue", false);
        if (st.len <= 0) {
          juce::Logger::writeToLog(
              "AudioEngine::setSequence refused - non-positive step length");
          return;
        }
        seq->steps.push_back(std::move(st));
      }
    }
    if (auto* g = o->getProperty("gates").getDynamicObject()) {
      for (const auto& p : g->getProperties()) {
        celestrian::Sequence::GateRow row;
        row.uuid = p.name.toString();
        row.mask = 0;
        if (auto* bits = p.value.getArray()) {
          for (int i = 0;
               i < bits->size() && i < celestrian::Sequence::kMaxSteps; ++i) {
            if ((bool)(*bits)[i]) row.mask |= (1ull << i);
          }
        }
        seq->gates.push_back(std::move(row));
      }
    }
    if (!seq->steps.empty()) {
      seq->finalize();
      e.seq = std::move(seq);
    }
    // NOTE (S10): step lengths are NOT gated on Q coherence —
    // steps CONCATENATE (never LCM), free lengths are deliberate and
    // badged in the UI; the frame-health warning is display machinery.
  }
  record(std::move(e));
}

void AudioEngine::auditionStep(const juce::String& uuid, int step) {
  // THE STEP AUDITION (docs/sequencer.md §11.2): "loop this step". A
  // monitoring gesture, not an edit — nothing is recorded, nothing
  // persists. The derived window appears through activeTimeMap() on
  // the stack; −1 clears it. Refused while a take is live in the
  // subtree: the window IS the take's heard frame (the mid-take
  // map-edit refusal, inherited).
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) {
    juce::Logger::writeToLog(
        "AudioEngine::auditionStep refused - target is not a stack");
    return;
  }
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::auditionStep refused - a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }
  if (step >= 0) {
    const celestrian::Sequence* s = stack->activeSequence();
    if (s == nullptr || step >= s->numSteps()) {
      juce::Logger::writeToLog(
          "AudioEngine::auditionStep refused - no such step in an active "
          "sequence");
      return;
    }
  }
  stack->setAuditionStep(step < 0 ? -1 : step);
  juce::Logger::writeToLog("AudioEngine: audition step " + juce::String(step) +
                           " on " + uuid);
}

void AudioEngine::toggleSequence(const juce::String& uuid) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (stack == nullptr) return;
  if (stack->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::toggleSequence refused - a take is armed/recording "
        "in this subtree (finish or cancel it first)");
    return;
  }
  celestrian::Edit e(celestrian::Edit::Kind::SequenceBypass);
  e.uuid = uuid;
  e.b1 = !stack->isSequenceBypassed();
  record(std::move(e));
}
