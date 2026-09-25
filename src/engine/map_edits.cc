// AudioEngine — MAP + SEQUENCE EDITS: the loop-window and segment-map
// verbs (setLoopPoints, setSegments, toggleLoopWindow) with their
// mid-take gates, the coherence guard and the Q13 definer re-trim
// riders; the re-time verb (setTiming — the ↺ drag, loop_selection.md
// §9); the sequencer verbs (setSequence, auditionStep, toggleSequence).
// Each records an Edit; the edit log applies it. Message thread only.

#include "../audio_engine.h"

#include "../heard_index.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"


void AudioEngine::setLoopPoints(const juce::String& uuid, int64_t start,
                                int64_t end, bool live) {
  juce::Logger::writeToLog("AudioEngine::setLoopPoints: uuid=" + uuid +
                           " start=" + juce::String(start) +
                           " end=" + juce::String(end));
  // A GESTURE'S FIRST COMMIT opens it before any gate (edit_log.cc): an
  // identity or a refusal records nothing, yet the drag's live commits
  // must not join the previous gesture's entry.
  if (!live) openGesture(uuid, celestrian::Edit::Kind::LoopPoints);
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
  // COHERENCE GUARD (time_maps.md §4): a window length off the Q grid
  // is refused — categorical, both sides (the UI snaps; the engine
  // enforces). One incoherent map period LCM-explodes the effective
  // cycle and blanks the timeline.
  // The sole exception is the DEFINER's re-trim below (the Q13 definer,
  // or a designated one — Q22), where the window length *re-establishes*
  // Q rather than fighting it.
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
        clip == nullptr && celestrian::engine_internal::definer(*root_node) == target;
    if (clip == nullptr && !stack_definer_early &&
        target->getIntrinsicDuration() > 0 && end > target->getIntrinsicDuration()) {
      juce::Logger::writeToLog(
          "AudioEngine::setLoopPoints refused - window end " +
          juce::String(end) + " is past the stack's inner cycle " +
          juce::String(target->getIntrinsicDuration()));
      return;
    }
    // THE DEFINER (engine_internal::definer, every gate inside): the
    // sole clip, or the definer STACK — its window re-establishes Q.
    auto* definer_node = celestrian::engine_internal::definer(*root_node);
    const bool clip_definer = clip != nullptr && definer_node == clip &&
                              clip->getIntrinsicDuration() > 0;
    const bool stack_definer = clip == nullptr && definer_node == target;
    const bool q13_retrim = c_end > c_start && (clip_definer || stack_definer);
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
  // (Q, zero): Q := window length, zero := origin' + window start
  // (the performance moment of the trimmed loop's top), PHASE-
  // PRESERVING — the inner position sounding RIGHT NOW keeps sounding:
  // origin' = t0 − pT, and for a STACK
  // that origin shift moves its whole subtree (applySetsOrigin), so
  // the members follow their group with no per-member riders. A
  // DESIGNATED definer with company (Q22) re-establishes the same
  // (Q, zero) but keeps its origin (zero := origin + window start). The
  // re-establishment rides the LoopPoints edit so it undoes atomically
  // with the window. hasActiveTake: an armed/capturing take is already
  // performing against the current grid — while a take is in flight
  // this is an ordinary window edit.
  if (auto* target = findNodeByUuid(root_node.get(), uuid)) {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    auto* stack = dynamic_cast<celestrian::StackNode*>(target);
    const int64_t D = target->getIntrinsicDuration();
    auto* definer_node = celestrian::engine_internal::definer(*root_node);
    const bool stack_definer = stack != nullptr && definer_node == stack;
    const bool clip_definer = clip != nullptr && D > 0 && definer_node == clip;
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
    if (definer && end > start && D > 0 &&
        !celestrian::engine_internal::holdsAllCommittedContent(*root_node,
                                                               *target)) {
      // A DESIGNATED DEFINER WITH COMPANY (Q22) KEEPS ITS ORIGIN: other
      // tracks play against it, and nothing re-times unless the user does
      // it explicitly (loop_selection.md §9, P1). The window re-grids the
      // island — Q := its length, zero := origin + start (the window's
      // top, where the loop anchors) — and the company that no longer
      // fits the grid drifts (the period law's drift clause).
      e.setsIsland = true;
      e.iq = end - start;
      e.izero = (anchored ? target->origin_samples.load() : root_node->getZero()) +
                start;
    } else if (definer && end > start && D > 0) {
      // SOLE (Q13): the definer is the island's only content.
      const int64_t len = end - start;
      // The inner position sounding NOW by the actual playback equation
      // (heard_index.h — one statement of the render, clip or stack,
      // active map / override included, composed through the
      // ancestors), folded into the new window. The origin lives in the
      // node's RECEIVED clock frame.
      const celestrian::heard::Received rec = celestrian::heard::receivedAt(
          *target, global_transport_pos.load(), rootScope());
      const int64_t p0 =
          celestrian::heard::ownInnerAt(*target, rec.clock, rec.scope).inner;
      const int64_t pT = celestrian::heard::foldIntoWindow(p0, start, len);
      const int64_t origin1 = rec.clock - pT;
      if (anchored) {
        e.setsOrigin = true;
        e.iorg = origin1;
        e.liftsAncestors = true;  // the definer's ancestors follow (Q18)
      }
      e.setsIsland = true;
      e.iq = len;
      e.izero = origin1 + start;
    } else if (definer && D > 0) {
      // WINDOW CLEAR RE-ESTABLISHES THE BASE FACTS: the definer's
      // window was Q — clearing it restores the
      // whole take (or the group's whole inner cycle) as the part, so
      // Q := D and zero := origin (the content-frame identity, exactly
      // as first commit established them).
      e.setsIsland = true;
      e.iq = D;
      e.izero = anchored ? target->origin_samples.load() : root_node->getZero();
    } else if (D > 0 && !root_node->hasActiveTake()) {
      // THE CONTINUITY rider (see attachMapEditRiders) — clips and
      // stacks alike since Q18.
      attachMapEditRiders(e, *target,
                          end > start
                              ? celestrian::timing::TimeMap::single(start, end)
                              : celestrian::timing::TimeMap::none());
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
        // Already whole: no window, or a full-span one (restricts
        // nothing). Whole = NO window (D4-7).
        if (!c->hasSegmentMap() &&
            (c->getLoopEnd() <= c->getLoopStart() ||
             (c->getLoopStart() == 0 && c->getLoopEnd() >= d)))
          continue;
        celestrian::Edit::WindowRider r;
        r.uuid = c->getUuid();
        r.start = 0;
        r.end = 0;
        e.windows.push_back(std::move(r));
      }
    }
  }
  e.live = live;  // a mid-gesture update coalesces (edit_log.cc)
  record(std::move(e));
}

void AudioEngine::setSegments(const juce::String& uuid,
                              const celestrian::timing::TimeMap& map,
                              bool live) {
  using TimeMap = celestrian::timing::TimeMap;
  // A gesture's first commit opens it before any gate (setLoopPoints).
  if (!live) openGesture(uuid, celestrian::Edit::Kind::Segments);
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
    setLoopPoints(uuid, 0, 0, live);
    return;
  }
  if (map.n == 1) {
    setLoopPoints(uuid, map.segs[0].start, map.segs[0].end, live);
    return;
  }

  // IDENTITY EDITS RECORD NOTHING (the setLoopPoints rule): re-committing
  // the stored cell map — a splice drag's first commit before it crosses
  // a whole Q, a live commit that dwells — would log a no-op undo step
  // that also destroys the redo branch (and, on a definer, re-solve the
  // origin). The gesture is open already (above), so the drag's live
  // commits still form one step.
  {
    const TimeMap stored = target->storedMap();
    bool same = stored.n == map.n;
    for (int i = 0; same && i < map.n; ++i) {
      same = stored.segs[i].start == map.segs[i].start &&
             stored.segs[i].end == map.segs[i].end;
    }
    if (same) return;
  }

  // COHERENCE GUARD (time_maps.md §4): the map's PERIOD must be a whole
  // multiple of Q — categorical, both sides (the UI snaps; the engine
  // enforces). One incoherent period LCM-explodes the effective cycle
  // and blanks the timeline.
  // The sole exception is the DEFINER's re-trim below (Q13, or a
  // designated definer — Q22), where the period *re-establishes* Q
  // rather than fighting it. (The n ≤ 1 delegations above are guarded
  // inside setLoopPoints.)
  {
    // Clip or definer STACK alike (engine_internal::definer, every
    // gate inside): the definer's map re-establishes Q.
    const bool q13_retrim =
        intrinsic > 0 && celestrian::engine_internal::definer(*root_node) == target;
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
  // zero := origin' + mapOffset(0)), with the phase-preserving origin
  // re-anchor generalized through the map: the buffer position
  // sounding RIGHT NOW keeps sounding (inverse-mapped when still
  // covered; the old heard phase folds into the new period when the
  // cut removed it). A designated definer with company (Q22) keeps its
  // origin instead (zero := origin + mapOffset(0)).
  // Q18: ONE path for the clip definer and the definer STACK — the
  // node's inner position sounding now re-anchors under the new map;
  // for a stack the origin shift moves its subtree (applySetsOrigin).
  {
    auto* clip = dynamic_cast<celestrian::ClipNode*>(target);
    auto* stack = dynamic_cast<celestrian::StackNode*>(target);
    auto* definer_node = celestrian::engine_internal::definer(*root_node);
    const bool clip_definer =
        clip != nullptr && intrinsic > 0 && definer_node == clip;
    const bool stack_definer =
        stack != nullptr && intrinsic > 0 && definer_node == stack;
    if (clip_definer || stack_definer) {
      const int64_t period = map.period();
      const int64_t a0 = map.mapOffset(0);
      const bool anchored = clip != nullptr || target->isAnchored();
      if (!celestrian::engine_internal::holdsAllCommittedContent(*root_node,
                                                                 *target)) {
        // A DESIGNATED DEFINER WITH COMPANY (Q22) KEEPS ITS ORIGIN (the
        // setLoopPoints rule): Q := the map's period, zero := origin + a0
        // (the map's heard top); the company that no longer fits drifts.
        e.setsIsland = true;
        e.iq = period;
        e.izero =
            (anchored ? target->origin_samples.load() : root_node->getZero()) + a0;
      } else {
        // SOLE (Q13): the node's RECEIVED clock (heard_index.h: the
        // ancestors' maps composed) — the frame its origin lives in.
        const celestrian::heard::Received rec = celestrian::heard::receivedAt(
            *target, global_transport_pos.load(), rootScope());
        const int64_t t0 = rec.clock;
        const TimeMap old_map = target->activeTimeMap();
        int64_t origin_new = t0 - a0;  // no old map: heard phase 0 at t0
        if (old_map.active() && old_map.period() > 0) {
          // heard_index.h: the position sounding now, re-anchored under
          // the new map (old heard phase folds in when the cut removed it).
          const int64_t p0 =
              celestrian::heard::ownInnerAt(*target, rec.clock, rec.scope).inner;
          origin_new = celestrian::heard::originForHeard(
              map, t0, p0, old_map.heardOffsetOf(p0));
        }
        if (anchored) {
          e.setsOrigin = true;
          e.iorg = origin_new;
          e.liftsAncestors = true;  // the definer's ancestors follow (Q18)
        }
        e.setsIsland = true;
        e.iq = period;
        e.izero = origin_new + a0;
      }
      if (stack != nullptr) {
        // MEMBERS WHOLE (the definer invariant): any member window or
        // override goes whole with the same edit.
        for (const auto& child : stack->ownedChildren()) {
          auto* c = dynamic_cast<celestrian::ClipNode*>(child.get());
          if (c == nullptr || c->getIntrinsicDuration() <= 0) continue;
          const int64_t d = c->getIntrinsicDuration();
          const bool whole =
              !c->hasSegmentMap() &&
              (c->getLoopEnd() <= c->getLoopStart() ||
               (c->getLoopStart() == 0 && c->getLoopEnd() >= d));
          if (!whole) {  // whole = NO window (D4-7)
            celestrian::Edit::WindowRider w;
            w.uuid = c->getUuid();
            w.start = 0;
            w.end = 0;
            e.windows.push_back(std::move(w));
          }
        }
      }
    } else if (intrinsic > 0 && !root_node->hasActiveTake()) {
      // THE CONTINUITY rider (see attachMapEditRiders).
      attachMapEditRiders(e, *target, map);
    }
  }

  e.live = live;  // a mid-gesture update coalesces (edit_log.cc)
  record(std::move(e));
}

void AudioEngine::setTiming(const juce::String& uuid, int64_t shift,
                            std::optional<int64_t> top, bool live) {
  // THE SHIFT (loop_selection.md §9.2, owner 2026-09-24): a swap changes
  // WHAT plays and keeps the origin; a shift changes WHEN — it moves the
  // take's origin, re-timing it against every other track. This verb is
  // the only way that happens: the lane ↺ drag (a shift), the panel's
  // start-marker drag (a new top plus the compensating shift, so the ↺
  // keeps its moment), "timing as played" (shift = −retime). The origin
  // moves by exactly `shift` — NOT a continuity re-anchor, never
  // re-folded (a free, sub-Q shift is the point: I4 as amended) — and
  // the re-time counts it.
  // A gesture's first commit opens it before any gate (setLoopPoints) —
  // a ↺ drag may open on a zero shift.
  if (!live) openGesture(uuid, celestrian::Edit::Kind::Timing);
  auto* clip = dynamic_cast<celestrian::ClipNode*>(
      findNodeByUuid(root_node.get(), uuid));
  if (clip == nullptr) {
    // Stacks keep no timing in Phase 2 (their origin is their earliest
    // content's, Q18); an unknown uuid lands here too.
    juce::Logger::writeToLog("AudioEngine::setTiming refused - " + uuid +
                             " is not a clip");
    return;
  }
  // THE RECORDING GATE (Phase 1): nothing re-times while any take is
  // armed or capturing — the performer is playing against this grid.
  if (refusedUnderLiveTake("setTiming")) return;
  if (clip->isArmedOrRecording()) {
    juce::Logger::writeToLog(
        "AudioEngine::setTiming refused - a take is recording or pending here");
    return;
  }
  if (clip->getIntrinsicDuration() <= 0) {
    juce::Logger::writeToLog(
        "AudioEngine::setTiming refused - nothing committed here to re-time");
    return;
  }
  // THE Q-DEFINER: its frame top IS the island zero — (Q, zero) derive
  // from it (Q13), so moving it re-times nothing against anything; its
  // own trims re-establish the grid instead. The same predicate the
  // state publishes as `definerId`, so the view's canRetime agrees.
  if (celestrian::engine_internal::definer(*root_node) == clip) {
    juce::Logger::writeToLog(
        "AudioEngine::setTiming refused - the Q-definer's origin is the "
        "island zero");
    return;
  }
  // A top must be one the region plays (the kept set) — refused whole
  // otherwise: no half-applied shift.
  if (top.has_value() && !clip->keepsTop(*top)) {
    juce::Logger::writeToLog("AudioEngine::setTiming refused - top " +
                             juce::String(*top) +
                             " is outside the clip's kept set");
    return;
  }
  // IDENTITY EDITS RECORD NOTHING (the setLoopPoints rule): a zero shift
  // with no new top would log a no-op undo step and eat the redo branch.
  if (shift == 0 && (!top.has_value() || *top == clip->storedTop())) return;
  celestrian::Edit e(celestrian::Edit::Kind::Timing);
  e.uuid = uuid;
  e.setsOrigin = true;
  e.iorg = clip->origin_samples.load() + shift;
  e.setsRetime = true;
  e.iretime = clip->retime() + shift;
  if (top.has_value()) {
    e.setsTop = true;
    e.itop = *top;
  }
  e.live = live;  // a mid-gesture update coalesces (edit_log.cc)
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
                              const juce::var& payload,
                              std::optional<int64_t> zero) {
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
        // Per-step fades (S13, sequencer.md §15): samples, never
        // negative; a fade longer than the run shrinks at render.
        st.fade_in = std::max<int64_t>(
            0, (int64_t)(double)sv.getProperty("fadeIn", 0.0));
        st.fade_out = std::max<int64_t>(
            0, (int64_t)(double)sv.getProperty("fadeOut", 0.0));
        // The successor graph (sequencer.md §14): [{to, w}] — a target
        // outside the step list is malformed, refused like a bad
        // length (the UI never sends one).
        if (auto* next = sv.getProperty("next", {}).getArray()) {
          for (const auto& nv : *next) {
            celestrian::Sequence::Successor s;
            s.to = (int)nv.getProperty("to", -1);
            s.weight = (int)nv.getProperty("w", 1);
            if (s.to < 0 || s.to >= steps->size() || s.weight <= 0) {
              juce::Logger::writeToLog(
                  "AudioEngine::setSequence refused - successor out of range");
              return;
            }
            st.next.push_back(s);
          }
        }
        seq->steps.push_back(std::move(st));
      }
    }
    seq->seed = (uint32_t)(int64_t)(double)o->getProperty("seed");
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
      // ROOT-ONLY RADIO (S12, composition.md §3): a period-less
      // program cannot contribute a period to a parent, so it is
      // legal only where no ancestor needs one — the root.
      if (seq->radio && stack != root_node.get()) {
        juce::Logger::writeToLog(
            "AudioEngine::setSequence refused - a radio (stochastic or "
            "non-returning successors) has no period; root only (S12)");
        return;
      }
      e.seq = std::move(seq);
    }
    // NOTE (S10): step lengths are NOT gated on Q coherence —
    // steps CONCATENATE (never LCM), free lengths are deliberate and
    // badged in the UI; the frame-health warning is display machinery.
  }
  // THE ROOT'S ANCHOR (docs/frame.md §4, Q18 at depth 0): a song on
  // the root anchors it at the zero the view had seated — the song's
  // top is where the picture already started, so authoring moves
  // nothing. The zero lands on the Q grid (the view seats it there; an
  // off-grid caller is snapped) and defaults to the island zero, the
  // frame the root folded from before. A root that already carries a
  // song keeps its origin: the song owns the frame. Clearing the song
  // un-anchors. Either way the change is an anchor rider the inverse
  // reverses exactly (applyAnchorRiders), never a re-derivation.
  if (stack == root_node.get()) {
    const int64_t q = root_node->getQuantum();
    const bool anchored = root_node->isAnchored();
    if (e.seq && !anchored && q > 0) {
      const int64_t island_zero = root_node->getZero();
      const int64_t z = zero.value_or(island_zero);
      celestrian::Edit::AnchorRider r;
      r.uuid = uuid;
      r.anchored = true;
      r.origin = z - celestrian::timing::posMod(z - island_zero, q);
      e.anchors.push_back(std::move(r));
    } else if (!e.seq && anchored) {
      celestrian::Edit::AnchorRider r;
      r.uuid = uuid;
      r.anchored = false;
      r.origin = 0;
      e.anchors.push_back(std::move(r));
    }
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
  // Island-wide since the live-take gate (owner ruling 2026-09-09): an
  // audition changes what the performer hears mid-take.
  if (refusedUnderLiveTake("auditionStep")) return;
  if (step >= 0) {
    const celestrian::Sequence* s = stack->activeSequence();
    if (s == nullptr || !s->reachableStep(step)) {
      juce::Logger::writeToLog(
          "AudioEngine::auditionStep refused - no such step in the active "
          "program (unreachable steps have no span)");
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
