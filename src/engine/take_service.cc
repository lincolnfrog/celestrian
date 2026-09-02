// AudioEngine — TAKE LIFECYCLE: arm (startRecordingInNode: the Q13
// lock-collapse, Q7 group arm, S21 auto-target, through-map arm), stop
// (stopRecordingInNode), the settle that logs a performance into the
// undo log (reconcileTakes, liftGroupWindow, applyAutoGate), and take
// storage upkeep (compactClipToHeap, compactIdleTakes, growLiveTakes).
// Message thread only.

#include "../audio_engine.h"

#include <algorithm>

#include "../clip_node.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

using celestrian::engine_internal::definerStack;
using celestrian::engine_internal::firstCommittedClip;
using celestrian::engine_internal::hasActiveGeometryOutside;

void AudioEngine::compactClipToHeap(celestrian::ClipNode& clip) {
  if (clip.isArmedOrRecording()) return;
  const int64_t keep = std::max<int64_t>(
      {clip.recordedLength(), clip.duration_samples.load(),
       (int64_t)clip.getSampleRate()});
  const int chans = std::max(1, clip.getAudioBuffer().getNumChannels());
  auto fresh = std::make_unique<juce::AudioBuffer<float>>(chans, (int)keep);
  // keep can exceed the source (duration/sample-rate floors above) and
  // AudioBuffer does not zero on construction — clear the tail past the
  // copied region or it plays garbage.
  const int64_t have =
      std::min<int64_t>(keep, clip.getAudioBuffer().getNumSamples());
  for (int c = 0; c < chans; ++c) {
    fresh->copyFrom(c, 0, clip.getAudioBuffer(), c, 0, (int)have);
    if (have < keep) fresh->clear(c, (int)have, (int)(keep - have));
  }
  retireOwned(clip.swapContent(std::move(fresh)));
  if (auto st = clip.releaseStorage()) retireOwned(std::move(st));
}

void AudioEngine::compactIdleTakes() {
  // Take compaction (message thread): a committed take shrinks to exactly
  // its recorded material and the arm-time virtual reservation returns
  // to the OS. Safe under an actively RENDERING clip: content is
  // reached through one atomic pointer, and the displaced buffer retires
  // through the reclaimer (an in-flight callback may read it for ≤2
  // more callbacks). Armed/recording clips are never touched; keep =
  // recordedLength (not duration!) so a lock-collapsed definer keeps
  // its dead air for uncollapse.
  const std::function<void(celestrian::StackNode&)> visit =
      [&](celestrian::StackNode& stack) {
        for (const auto& child : stack.ownedChildren()) {
          if (child->getNodeType() == celestrian::NodeType::Stack) {
            visit(static_cast<celestrian::StackNode&>(*child));
            continue;
          }
          auto& clip = static_cast<celestrian::ClipNode&>(*child);
          if (clip.isArmedOrRecording()) continue;
          // Through-map takes store a dense [0, C) buffer with the
          // content folded past the heard length — keep the full
          // committed duration, not just recordedLength.
          const int64_t keep = std::max<int64_t>(
              {clip.recordedLength(), clip.duration_samples.load(),
               (int64_t)clip.getSampleRate()});
          // Compact only when the win is real (≥ ~4 MB of samples).
          if (clip.contentCapacity() - keep < (int64_t{1} << 20)) continue;
          const int chans = std::max(1, clip.getAudioBuffer().getNumChannels());
          auto fresh =
              std::make_unique<juce::AudioBuffer<float>>(chans, (int)keep);
          for (int c = 0; c < chans; ++c) {
            fresh->copyFrom(c, 0, clip.getAudioBuffer(), c, 0,
                            (int)std::min<int64_t>(
                                keep, clip.getAudioBuffer().getNumSamples()));
          }
          retireOwned(clip.swapContent(std::move(fresh)));
          // The reserved storage the referring buffer pointed into goes
          // with it (the reclaimer frees it after the buffer object).
          if (auto st = clip.releaseStorage()) retireOwned(std::move(st));
        }
      };
  visit(*root_node);
}

void AudioEngine::growLiveTakes() {
  // THE GROWER (take_storage.h): keep a headroom of committed pages
  // ahead of every live take's write head. Message thread, every poll;
  // a stalled message thread is the only way a take reaches its wall.
  const std::function<void(celestrian::StackNode&)> visit =
      [&](celestrian::StackNode& stack) {
        for (const auto& child : stack.ownedChildren()) {
          if (child->getNodeType() == celestrian::NodeType::Stack) {
            visit(static_cast<celestrian::StackNode&>(*child));
            continue;
          }
          auto& clip = static_cast<celestrian::ClipNode&>(*child);
          if (!clip.isArmedOrRecording()) continue;
          if (celestrian::TakeStorage* st = clip.reservedStorage()) {
            st->commitTo(clip.recordedLength() + celestrian::ClipNode::kArmCommitSamples);
          }
        }
      };
  visit(*root_node);
}

namespace {

/** Q7 GROUP ARM: record is fractal — on a
 * clip it records that clip; on a stack it records the stack's members.
 * These helpers walk the OWNERSHIP tree (message thread only — this is
 * type discrimination on a user-supplied target, not audio-thread
 * traversal).
 *
 * "Arm targets emptiness" (Q7 refinement): a clip that already has
 * content cannot be re-recorded — group record arms only the EMPTY
 * clips; the full ones just play. Re-recording content is the *takes*
 * feature, not arm. */
void collectArmTargets(celestrian::AudioNode* node,
                       std::vector<celestrian::ClipNode*>& out) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    auto* clip = static_cast<celestrian::ClipNode*>(node);
    if (clip->recState() == celestrian::ClipNode::RecState::Idle &&
        clip->getIntrinsicDuration() == 0) {
      out.push_back(clip);
    }
    return;
  }
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
    for (const auto& child : stack->ownedChildren()) {
      collectArmTargets(child.get(), out);
    }
  }
}

/** Every clip in `node`'s subtree with a live take (armed / capturing /
 * pending stop) — the group-stop set. */
void collectHotClips(celestrian::AudioNode* node,
                     std::vector<celestrian::ClipNode*>& out) {
  if (node->getNodeType() == celestrian::NodeType::Clip) {
    auto* clip = static_cast<celestrian::ClipNode*>(node);
    if (clip->recState() != celestrian::ClipNode::RecState::Idle) {
      out.push_back(clip);
    }
    return;
  }
  if (auto* stack = dynamic_cast<celestrian::StackNode*>(node)) {
    for (const auto& child : stack->ownedChildren()) {
      collectHotClips(child.get(), out);
    }
  }
}

}  // namespace

void AudioEngine::startRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);

  // If the whole song is stopped when clicking record, automatically play
  if (!is_playing_global.load()) {
    is_playing_global.store(true);
    juce::Logger::writeToLog(
        "AudioEngine: Auto-starting transport for recording.");
  }

  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) {
    juce::Logger::writeToLog("AudioEngine: NODE NOT FOUND for " + uuid);
    return;
  }

  // Q13 LOCK-COLLAPSE: arming a take against a provisionally-trimmed
  // island FINALIZES the trim — the sole committed clip collapses to
  // its window BEFORE the arm, so every boundary computation (context
  // loop, heard/intrinsic cycle snapshots, LCMs) sees an ordinary
  // whole-Q looper. An incommensurate buffer left alive would poison
  // them all (the next take anchors at origin − epoch ∉ Q·Z).
  // Undoable — ⌘Z restores the full buffer and the trim. (A stack
  // target can never BE the definer clip, so the != uuid guard stays
  // correct for group arms.)
  if (islandCommittedClipCount() == 1) {
    if (auto* definer = firstCommittedClip(root_node.get());
        definer && definer->getUuid() != uuid &&
        definer->isLoopWindowActive() && !hasActiveGeometryOutside(root_node.get(), definer)) {
      celestrian::Edit e(celestrian::Edit::Kind::CollapseTake);
      e.uuid = definer->getUuid();
      record(std::move(e));  // no-op (not recorded) if already full-span
    }
  }
  // The GROUP twin: a trimmed definer STACK collapses to its window
  // before any arm — its raw inner cycle would
  // otherwise survive the lock incommensurate (inflating every LCM the
  // arm math snapshots, the very poison the clip collapse removes).
  if (auto* ds = definerStack(root_node.get());
      ds != nullptr && !root_node->hasActiveTake() && !ds->auditionActive() &&
      !ds->isLoopWindowBypassed() && !ds->hasSegmentMap() &&
      ds->getLoopEnd() > ds->getLoopStart()) {
    celestrian::Edit e(celestrian::Edit::Kind::CollapseGroup);
    e.uuid = ds->getUuid();
    record(std::move(e));  // no-op (not recorded) if nothing to collapse
  }

  // Q7 GROUP ARM: resolve the whole arm set — a clip records itself, a
  // stack records its EMPTY clip descendants — and arm it in THIS one
  // message-thread call. One call means the group shares one arm target
  // and one committed duration (one performance, N microphones): a
  // per-clip loop could straddle an audio block and split the group
  // across two boundaries.
  std::vector<celestrian::ClipNode*> targets;
  collectArmTargets(node, targets);
  if (targets.empty()) {
    juce::Logger::writeToLog(
        "AudioEngine: record refused - no empty clip to arm under " + uuid +
        " (arm targets emptiness, Q7; re-recording is the takes feature)");
    return;
  }

  // S21 AUTO-TARGET (docs/sequencer.md §3):
  // arming while the playhead is inside a CUED step becomes Mode-2
  // record-into-that-step. A Mode-1 take lands at absolute positions,
  // but cue playback RE-BASES the step to the song top — the take
  // would never replay where the performer heard themselves play it.
  // Engaging the step audition here routes the arm through the
  // existing through-map path (S18 step-sized part, S19 auto-gate),
  // which places the take exactly where cue playback reads it. The
  // nearest sequenced ancestor of the first target answers; an
  // audition already active anywhere in the chain means the performer
  // already aimed (explicit Mode-2) and wins. The audition is the
  // same monitoring gesture as an explicit one — Esc releases it.
  if (!targets.empty()) {
    for (auto* a = targets[0]->getParent(); a != nullptr;
         a = a->getParent()) {
      auto* s = dynamic_cast<celestrian::StackNode*>(a);
      if (s == nullptr) continue;
      if (s->auditionActive()) break;  // explicitly aimed already
      const celestrian::Sequence* sq = s->activeSequence();
      if (sq == nullptr) continue;  // not sequenced: keep walking up
      if (sq->any_cue && sq->total > 0) {
        const int64_t rel =
            sq->fold(global_transport_pos.load() - root_node->getEpoch());
        const int step = sq->stepAt(rel);
        if (sq->cueAt(step)) {
          s->setAuditionStep(step);
          juce::Logger::writeToLog(
              "AudioEngine: arm inside cued step " + juce::String(step) +
              " - auto-targeting it (S21: record-into-step)");
        }
      }
      break;  // nearest sequenced ancestor answers either way
    }
  }

  // THROUGH-MAP ARM (time_maps.md phase 2): an ACTIVE map on an
  // ancestor shapes each take — the take records THROUGH it (heard
  // arm math, one-period cap, dense [0, C) commit). The walk runs on
  // the message thread (parent chains are legal here); C = the
  // mapping node's full inner cycle, snapshotted at arm (map edits
  // are gated while the take is live). Computed per target (an
  // intermediate stack's map shapes only the clips beneath it); ANY
  // refusal refuses the WHOLE group — a group take is one performance,
  // and arming half of it would be worse than arming none.
  std::vector<int64_t> through_map_cycles(targets.size(), 0);
  for (size_t i = 0; i < targets.size(); ++i) {
    int active_maps = 0;
    celestrian::AudioNode* mapping = nullptr;
    for (auto* a = targets[i]->getParent(); a != nullptr;
         a = a->getParent()) {
      if (a->activeTimeMap().active()) {
        ++active_maps;
        if (mapping == nullptr) mapping = a;  // nearest wins
      }
    }
    if (active_maps > 1) {
      // Composed active maps are a multi-segment PRODUCT — outside
      // the ratified phase-2 scope (single map). Refuse the arm.
      juce::Logger::writeToLog(
          "AudioEngine: record refused - nested active loop windows "
          "(bypass one to record through the other)");
      return;
    }
    if (mapping != nullptr && root_node->getQuantum() > 0) {
      // An AUTHORED window over a sequence with CUED steps: the map
      // may span several steps, so the composed take placement is a
      // multi-segment product — outside the ratified cue scope (the
      // nested-active-maps refusal precedent). The step AUDITION
      // composes fine (childContext hands down the composed map);
      // only the authored-window case refuses.
      if (auto* ms = dynamic_cast<celestrian::StackNode*>(mapping)) {
        const celestrian::Sequence* msq = ms->activeSequence();
        if (msq != nullptr && msq->any_cue && !ms->auditionActive()) {
          juce::Logger::writeToLog(
              "AudioEngine: record refused - an authored window over a "
              "sequence with cued steps (audition the step to record "
              "into it)");
          return;
        }
      }
      const int64_t period = mapping->activeTimeMap().period();
      // S18 (docs/sequencer.md §11.4): under an
      // ACTIVE SEQUENCE on the mapping node the take is a STEP-SIZED
      // PART — C = the map period, no silence inserted ("we should not
      // be in the business of inserting silence"); the gate decides
      // where it plays. Without a sequence the phase-2 rule stands:
      // the mapping node's full inner cycle, dense.
      const int64_t C = mapping->activeSequenceLen() > 0
                            ? period
                            : std::max(mapping->getIntrinsicDuration(), period);
      if (C > celestrian::ClipNode::kMaxTakeSamples / 2) {
        juce::Logger::writeToLog(
            "AudioEngine: record refused - the mapped cycle is too "
            "large for a dense take buffer");
        return;
      }
      through_map_cycles[i] = C;
    }
  }

  // The clock is NEVER reset (kernel.md §2) — not even for the first
  // clip: the island epoch (epoch := arm moment) is captured as data in
  // ClipNode's first-clip arm path and the clock is untouched.
  // ONE PERFORMANCE, ONE ARM MOMENT: reserve every member's take buffer
  // first (slow on eager-commit platforms), THEN publish the Armed
  // states back-to-back so one block top arms all N mics together —
  // per-mic reserve+publish would let a callback land between mics and
  // give them different first-take origins (see ClipNode::publishArm).
  std::vector<bool> prepared(targets.size(), false);
  for (size_t i = 0; i < targets.size(); ++i) {
    // STALE GEOMETRY DIES AT ARM: arm targets
    // emptiness, but a map override can survive a take strip (undo of
    // a take) on the now-empty clip — and would warp the NEW take's
    // playback with the OLD take's segments. Retire it through the
    // reclaimer (an in-flight callback may still read it).
    if (targets[i]->hasSegmentMap()) targets[i]->setLoopPoints(0, 0);
    prepared[i] = targets[i]->prepareRecording(through_map_cycles[i]);
  }
  for (size_t i = 0; i < targets.size(); ++i) {
    if (prepared[i]) targets[i]->publishArm();
  }

  // MIDI takes (phase 5): recording a MIDI track means "my keyboard
  // goes here" — MIDI-arm it so the performer hears the instrument
  // they are recording into (single-armed: the first MIDI target of a
  // group takes it; capture itself reads the input regardless).
  for (auto* target : targets) {
    if (target->contentKind() == celestrian::ClipNode::ContentKind::Midi) {
      if (!target->midi_armed.load()) setMidiArmed(target->getUuid(), true);
      break;
    }
  }

  // TAKES ARE UNDOABLE: register the performance; reconcileTakes logs
  // it once every member has settled (see PendingTake).
  {
    PendingTake p;
    for (auto* target : targets) p.uuids.push_back(target->getUuid());
    p.q_before = root_node->getQuantum();
    p.epoch_before = root_node->getEpoch();
    // Aimed at a looping step? The nearest auditioning ancestor that is
    // the DIRECT parent of a target (§11.5) names the auto-gate.
    for (auto* target : targets) {
      auto* parent = dynamic_cast<celestrian::StackNode*>(target->getParent());
      if (parent != nullptr && parent->auditionActive()) {
        p.gate_stack = parent->getUuid();
        p.gate_step = parent->auditionStep();
        break;
      }
    }
    pending_takes_.push_back(std::move(p));
  }
}

/**
 * GROUP-WINDOW LIFT (Q13 FOR GROUPS). A take committed against a
 * SURVIVED Q (the island's earlier content deleted, Q kept) whose
 * length is off the grid commits whole but with a sub-region loop
 * [0, floor(L/Q)·Q) — or [0, Q/2) — on each clip (commitRecording's
 * hysteresis snap). For a sole clip that region IS the definer
 * selection (the trim view shows it). For a GROUP take the window
 * belongs to the definer STACK under the window law ("children
 * whole"): left on the members, the trim view would draw the whole
 * take selected while the members looped half of it, and a trim would
 * stack a stack window over the members'. So the members' common
 * commit-time region becomes the stack's window and the members go
 * whole. Rides the take's undo entry.
 */
void AudioEngine::liftGroupWindow(
    const std::vector<celestrian::ClipNode*>& committed,
    celestrian::Edit& inv) {
  if (committed.size() < 2) return;
  auto* stack = definerStack(root_node.get());
  if (stack == nullptr || stack->isLoopWindowActive()) return;
  int64_t ls = 0, le = 0;
  for (size_t i = 0; i < committed.size(); ++i) {
    auto* clip = committed[i];
    if (clip->getParent() != stack || clip->hasSegmentMap()) return;
    const int64_t s = clip->getLoopStart();
    const int64_t e = std::min(clip->getLoopEnd(), clip->getIntrinsicDuration());
    if (i == 0) {
      ls = s;
      le = e;
    } else if (s != ls || e != le) {
      return;  // no common region — not a snap artefact
    }
  }
  if (!(le > ls) || (ls == 0 && le >= committed[0]->getIntrinsicDuration()))
    return;  // whole already
  // The undo rider: the stack goes back to no window (the members'
  // regions come back through the Untake payload — stripTake zeroes
  // them, restoreTake reinstalls whatever they hold now: whole).
  celestrian::Edit::WindowRider back;
  back.uuid = stack->getUuid();
  back.start = stack->getLoopStart();
  back.end = stack->getLoopEnd();
  inv.windows.push_back(std::move(back));
  for (auto* clip : committed)
    clip->setLoopPoints(0, clip->getIntrinsicDuration());
  stack->setLoopPoints(ls, le);
  juce::Logger::writeToLog("AudioEngine: group take window lifted onto " +
                           stack->getUuid() + " [" + juce::String(ls) + ", " +
                           juce::String(le) + ") - members whole");
}

void AudioEngine::reconcileTakes() {
  // See PendingTake (audio_engine.h). Message thread only.
  for (size_t i = 0; i < pending_takes_.size();) {
    PendingTake& p = pending_takes_[i];
    bool settled = true;
    std::vector<celestrian::ClipNode*> committed;
    for (const auto& u : p.uuids) {
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          findNodeByUuid(root_node.get(), u));
      if (clip == nullptr) continue;  // deleted/cancelled: nothing to log
      if (clip->isArmedOrRecording()) {
        settled = false;
        break;
      }
      if (clip->duration_samples.load() > 0) committed.push_back(clip);
    }
    if (!settled) {
      ++i;
      continue;
    }
    PendingTake done = std::move(p);
    pending_takes_.erase(pending_takes_.begin() + (long)i);
    if (committed.empty()) continue;  // the whole performance cancelled

    // The log entry is the INVERSE (Untake): it names the clips and
    // carries the island facts as they were BEFORE the performance, so
    // undo restores the grid with the content. applyEdit on Untake
    // builds the forward Take (owning the stripped content) for redo.
    celestrian::Edit inv(celestrian::Edit::Kind::Untake);
    for (auto* clip : committed) {
      celestrian::Edit::TakePayload tp;
      tp.uuid = clip->getUuid();
      inv.takes.push_back(std::move(tp));
    }
    inv.setsIsland = true;
    inv.iq = done.q_before;
    inv.iepoch = done.epoch_before;
    // Q18: the first content under a stack anchors it (the group take
    // anchors its group at the take's origin); rides the take's entry.
    settleAnchors(inv);
    liftGroupWindow(committed, inv);
    // Return the reservation now, not at the next save: a settled take
    // shrinks to its material (take_storage.h).
    for (auto* clip : committed) {
      if (clip->reservedStorage() != nullptr) compactClipToHeap(*clip);
    }
    pushUndo(std::move(inv));
    clearRedo();  // a new performance invalidates the redo branch
    juce::Logger::writeToLog(
        "AudioEngine: take logged (undoable) - " +
        juce::String((int)committed.size()) + " clip(s)");
    // Q ESTABLISHMENT SCRUB: geometry is
    // legal to author PRE-Q (the nested-maps arm refusal is pinned on
    // it), but a window/map whose length was free while Q was
    // unestablished can be INCOHERENT with the Q this very take just
    // established — permanently, since the coherence guard only judges
    // future edits. Clear what cannot live on the new grid, with a log.
    if (done.q_before <= 0 && root_node->getQuantum() > 0) {
      scrubIncoherentGeometry(root_node->getQuantum());
    }

    // STEP-RECORD AUTO-GATE (docs/sequencer.md §11.5, S19): the take
    // was aimed at a looping step — gate each committed DIRECT child of
    // the auditioning stack ON in that step, OFF elsewhere, as ONE
    // Edit::Sequence that COALESCES with the take's entry, so one ⌘Z
    // removes take + gates together.
    if (done.gate_stack.isNotEmpty() && done.gate_step >= 0) {
      applyAutoGate(done.gate_stack, done.gate_step, committed);
    }
  }
}

void AudioEngine::applyAutoGate(
    const juce::String& stack_uuid, int step,
    const std::vector<celestrian::ClipNode*>& committed) {
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(root_node.get(), stack_uuid));
  if (stack == nullptr) return;
  const celestrian::Sequence* cur = stack->sequencePtr();
  if (cur == nullptr || step >= cur->numSteps()) return;
  auto fresh = std::make_unique<celestrian::Sequence>(*cur);
  bool changed = false;
  for (auto* clip : committed) {
    // Direct children only (§11.5): a deeper take must not gate its
    // whole group off in every other section.
    if (clip->getParent() != stack) continue;
    const uint64_t mask = 1ull << step;
    bool found = false;
    for (auto& row : fresh->gates) {
      if (row.uuid == clip->getUuid()) {
        row.mask = mask;
        found = true;
      }
    }
    if (!found) {
      celestrian::Sequence::GateRow row;
      row.uuid = clip->getUuid();
      row.mask = mask;
      fresh->gates.push_back(std::move(row));
    }
    changed = true;
  }
  if (!changed) {
    juce::Logger::writeToLog(
        "AudioEngine: step-take landed ungated (not a direct child of the "
        "looping stack) - gate it by hand");
    return;
  }
  fresh->finalize();
  celestrian::Edit e(celestrian::Edit::Kind::Sequence);
  e.uuid = stack_uuid;
  e.seq = std::move(fresh);
  e.b1 = true;  // auto-gate marker: coalesces onto the take's log entry
  celestrian::Edit inv = applyEdit(std::move(e));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;
  // Compose: the Untake entry on top of the log absorbs the gate
  // inverse — undo applies the sequence restore, then the strip.
  if (!undo_.empty() && undo_.back().kind == celestrian::Edit::Kind::Untake) {
    undo_.back().seq = std::move(inv.seq);
    undo_.back().uuid = stack_uuid;
    undo_.back().b1 = true;
  } else {
    pushUndo(std::move(inv));
  }
}

void AudioEngine::stopRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  auto* node = findNodeByUuid(root_node.get(), uuid);
  if (node == nullptr) return;
  // Q7: stop is fractal like arm — a stack target stops every live take
  // beneath it in ONE message-thread pass, so the audio thread sees all
  // the stop requests at the same block top and the group commits at
  // one shared boundary (one committed duration).
  std::vector<celestrian::ClipNode*> hot;
  collectHotClips(node, hot);
  // Snapshot the island-Q fact BEFORE any stop runs: a first-take group
  // stop commits its first clip immediately, which ESTABLISHES Q — read
  // after that, the siblings would flip onto the record-to-next-boundary
  // path and run a full extra Q (one performance, one duration).
  const bool had_quantum = root_node->getQuantum() > 0;
  // ONE PERFORMANCE, ONE STOP MOMENT: a group
  // stop parks a generation on every member and publishes it in one
  // store, so all members flip at the same block top and compute the
  // same boundary. A single clip (or a pre-Q immediate commit) takes
  // the direct path.
  const uint32_t gen =
      (hot.size() > 1 && had_quantum) ? root_node->nextStopGeneration() : 0;
  for (auto* clip : hot) {
    clip->stopRecording(had_quantum, gen);
  }
  if (gen != 0) root_node->publishStopGeneration(gen);
}
