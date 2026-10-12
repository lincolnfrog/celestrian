// AudioEngine — TAKE LIFECYCLE (message thread only): the arm
// (startRecordingInNode, newTake), the stop (stopRecordingInNode), the
// settle that logs a performance (reconcileTakes, settleCommittedTake,
// applyAutoGate), the take-list verbs (selectTake, deleteTake, setComp —
// docs/takes.md) and take storage upkeep (compactClipToHeap,
// compactIdleTakes, growLiveTakes).
//
// ONE PERFORMANCE, ONE MOMENT: a group arms, stops and commits as one
// take. Every member is addressed in ONE message-thread call and
// published together, so a single block top sees them all — a per-member
// loop could straddle an audio block and split the group across two
// boundaries.

#include "../audio_engine.h"

#include <algorithm>
#include <atomic>

#include "../clip_node.h"
#include "../dsp/vst3_slot.h"
#include "../heard_index.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

namespace celestrian::engine_internal {
namespace {

// --- Storage upkeep ----------------------------------------------------

/** What a settled take keeps: every recorded sample (a lock-collapsed
 * take keeps what an uncollapse would bring back), never less than its
 * committed duration (a through-map take commits a dense cycle past its
 * write head) or one second. */
int64_t settledLength(const ClipNode& clip) {
  return std::max<int64_t>({clip.recordedLength(), clip.duration_samples.load(),
                            (int64_t)clip.getSampleRate()});
}

/** The slack per channel above which compacting an idle take pays
 * (~4 MB of samples). */
constexpr int64_t kCompactionSlackSamples = int64_t{1} << 20;

// --- The arm sets (Q7: record is fractal — a clip records itself, a
// stack its members) -----------------------------------------------------

/** ARM TARGETS EMPTINESS: the idle EMPTY clips under `node`. A clip that
 * holds content is never re-recorded by an arm — it plays; a further
 * take of it is the new-take verb. */
std::vector<ClipNode*> armTargets(AudioNode& node) {
  std::vector<ClipNode*> out;
  forEachClip(node, [&](ClipNode& clip) {
    if (clip.mayRecord() && clip.getIntrinsicDuration() == 0) {
      out.push_back(&clip);
    }
  });
  return out;
}

/** NEW-TAKE targets (docs/takes.md): a committed idle clip records
 * itself; a stack its committed idle DIRECT clip children, as one
 * performance. */
std::vector<ClipNode*> retakeTargets(AudioNode& node) {
  std::vector<ClipNode*> out;
  const auto consider = [&](AudioNode& n) {
    if (n.getNodeType() != NodeType::Clip) return;
    auto& clip = static_cast<ClipNode&>(n);
    if (clip.recState() == ClipNode::RecState::Idle &&
        clip.getIntrinsicDuration() > 0) {
      out.push_back(&clip);
    }
  };
  if (node.getNodeType() == NodeType::Stack) {
    for (const auto& child : static_cast<StackNode&>(node).ownedChildren()) {
      consider(*child);
    }
  } else {
    consider(node);
  }
  return out;
}

/** Every clip under `node` with a live take (armed, capturing or
 * pending stop): the stop set. */
std::vector<ClipNode*> liveClips(AudioNode& node) {
  std::vector<ClipNode*> out;
  forEachClip(node, [&](ClipNode& clip) {
    if (clip.recState() != ClipNode::RecState::Idle) out.push_back(&clip);
  });
  return out;
}

// --- The arm -------------------------------------------------------------

/** A cued step an arm is aimed at: the stack, the step, and the map the
 * stack plays once the step's audition is engaged (StackNode::
 * auditionMap for that step; none for a step the song never visits). */
struct StepAim {
  StackNode* stack = nullptr;
  int step = -1;
  timing::TimeMap span;

  /** The map `node` will play under the take. */
  timing::TimeMap mapOf(const AudioNode& node) const {
    return &node == stack && span.active() ? span : node.activeTimeMap();
  }
  bool auditions(const StackNode& node) const {
    return (&node == stack && span.active()) || node.auditionActive();
  }
};

/**
 * S21 AUTO-TARGET (docs/sequencer.md §3): an arm while the playhead is
 * inside a CUED step records INTO that step. A plain take lands at
 * absolute positions, but cue playback re-bases the step to the song
 * top, so the take would never replay where it was played; the step's
 * audition routes the arm through the through-map path, which places it
 * where cue playback reads it. The nearest sequenced ancestor of
 * `target` answers; one already auditioning means the performer aimed,
 * and wins. DECIDED here, engaged by the arm once it is certain.
 */
StepAim autoTargetCuedStep(const ClipNode& target, int64_t clock,
                           const heard::Scope& root_scope) {
  const auto sequenced = [](const AudioNode& a) {
    return a.getNodeType() == NodeType::Stack &&
           static_cast<const StackNode&>(a).activeSequence() != nullptr;
  };
  auto* stack = static_cast<StackNode*>(nearestAncestor(target, sequenced));
  if (stack == nullptr || stack->auditionActive()) return {};
  const Sequence* seq = stack->activeSequence();
  if (!seq->any_cue) return {};
  // The song position the stack itself reads (heard::songPositionAt).
  const int step = seq->stepAt(heard::songPositionAt(
      *stack, heard::receivedAt(*stack, clock, root_scope)));
  if (!seq->cueAt(step)) return {};
  StepAim aim;
  aim.stack = stack;
  aim.step = step;
  if (const int visit = seq->first_visit[step]; visit >= 0) {
    aim.span =
        timing::TimeMap::single(seq->bounds[visit], seq->bounds[visit + 1]);
  }
  return aim;
}

/** How one arm target records through the maps above it. */
struct ThroughMap {
  int64_t cycle = 0;              // C; 0 = a plain take
  const char* refusal = nullptr;  // why the arm cannot be placed
};

/**
 * THROUGH-MAP ARM (time_maps.md phase 2): an ACTIVE map on an ancestor
 * shapes the take — it records THROUGH the nearest one and commits a
 * dense [0, C) buffer. C is the mapping node's full inner cycle; under
 * an active sequence on that node it is the map period alone, a
 * STEP-SIZED part with no silence inserted (S18, docs/sequencer.md
 * §11.4). Refused where the placement would be a multi-segment product,
 * outside the single-map scope — composed active maps, or an AUTHORED
 * window over cued steps (the step audition composes fine) — and where
 * C does not fit a dense take buffer. Before Q exists a single map
 * shapes nothing.
 */
ThroughMap throughMapOf(const ClipNode& target, const StepAim& aim,
                        int64_t quantum) {
  const auto mapped = [&](const AudioNode& a) { return aim.mapOf(a).active(); };
  AudioNode* mapping = nearestAncestor(target, mapped);
  if (mapping == nullptr) return {};
  if (nearestAncestor(*mapping, mapped) != nullptr) {
    return {0, "nested active loop windows (bypass one to record through "
               "the other)"};
  }
  if (quantum <= 0) return {};
  if (auto* stack = dynamic_cast<StackNode*>(mapping)) {
    const Sequence* seq = stack->activeSequence();
    if (seq != nullptr && seq->any_cue && !aim.auditions(*stack)) {
      return {0, "an authored window over a sequence with cued steps "
                 "(audition the step to record into it)"};
    }
  }
  const int64_t period = aim.mapOf(*mapping).period();
  const int64_t cycle =
      mapping->activeSequenceLen() > 0
          ? period
          : std::max(mapping->getIntrinsicDuration(), period);
  if (cycle > ClipNode::kMaxTakeSamples / 2) {
    return {0, "the mapped cycle is too large for a dense take buffer"};
  }
  return {cycle, nullptr};
}

/** The island facts a performance found at its arm. */
struct IslandBefore {
  int64_t quantum = 0;
  int64_t zero = 0;
};

/**
 * THE ARM, once nothing can refuse it: every target is armed. A stopped
 * transport starts. Every member's take is PREPARED first —
 * `prepare(clip, index)`, the clip's own first half, slow where the
 * reservation commits eagerly; what it displaced retires through the
 * reclaimer — and
 * only then are the Armed states published back to back: a callback
 * landing between one member's reserve and its publish would give the
 * members different origins (ClipNode::publishArm). The island facts are
 * read BEFORE that publish: from the next block top they are the audio
 * thread's to move (a first take's arm block stores the zero), and the
 * take's undo restores what the performance FOUND. Last, the first MIDI
 * member takes the live play-through (single-armed), so the performer
 * hears the instrument being recorded; capture reads the input
 * regardless.
 */
template <typename Prepare>
IslandBefore armPerformance(AudioEngine& engine, const StackNode& root,
                            std::atomic<bool>& transport_playing,
                            const std::vector<ClipNode*>& targets,
                            Prepare&& prepare) {
  if (!transport_playing.load()) {
    transport_playing.store(true);
    juce::Logger::writeToLog(
        "AudioEngine: Auto-starting transport for recording.");
  }
  const IslandBefore before{root.getQuantum(), root.getZero()};
  for (size_t i = 0; i < targets.size(); ++i) {
    retireTake(engine, prepare(*targets[i], i));
  }
  for (ClipNode* clip : targets) clip->publishArm();
  for (ClipNode* clip : targets) {
    if (clip->contentKind() != ClipNode::ContentKind::Midi) continue;
    if (!clip->midi_armed.load()) engine.setMidiArmed(clip->getUuid(), true);
    break;
  }
  return before;
}

// --- The settle ----------------------------------------------------------

/** SETTLED: the audio thread has published the whole end of the
 * performance (the end-of-take order, ClipNode::RecState) — every member
 * is Idle, and a new take has published its outcome. A clip read
 * part-way through its commit is neither, so it is never taken for a
 * cancelled take. A member no longer in the graph has nothing to
 * settle. */
bool performanceSettled(StackNode& root, const std::vector<juce::String>& uuids,
                        bool new_take) {
  for (const auto& uuid : uuids) {
    const auto* clip = dynamic_cast<ClipNode*>(root.findByUuid(uuid));
    if (clip == nullptr) continue;
    if (clip->isArmedOrRecording() || (new_take && !clip->retakeSettled())) {
      return false;
    }
  }
  return true;
}

/** The members of a settled FIRST take that committed (a cancelled one
 * holds nothing). */
std::vector<ClipNode*> committedMembers(StackNode& root,
                                        const std::vector<juce::String>& uuids) {
  std::vector<ClipNode*> out;
  for (const auto& uuid : uuids) {
    auto* clip = dynamic_cast<ClipNode*>(root.findByUuid(uuid));
    if (clip != nullptr && clip->duration_samples.load() > 0) out.push_back(clip);
  }
  return out;
}

/**
 * A NEW TAKE settles through its clip (docs/takes.md): a committed one
 * joins the list, now active; a cancelled one hands the slot back to its
 * previous take, its abandoned reservation retiring through the
 * reclaimer. Returns the members that committed. A new take PLAYS AS
 * PERFORMED — armed at the slot's own, possibly re-timed top, it sounds
 * where it was played — so the slot's re-time now describes it: 0. The
 * older takes keep their shift as a baked fact (they share the origin);
 * the re-time from before rides the entry.
 */
CommittedTake settleRetakes(GraphReclaimer& reclaimer, StackNode& root,
                            const std::vector<juce::String>& uuids,
                            const std::vector<int>& prev_active) {
  CommittedTake take;
  take.new_take = true;
  for (size_t k = 0; k < uuids.size(); ++k) {
    auto* clip = dynamic_cast<ClipNode*>(root.findByUuid(uuids[k]));
    if (clip == nullptr) continue;
    ClipNode::TakeState displaced;
    if (!clip->settleRetake(displaced)) {
      retireTake(reclaimer, std::move(displaced));
      juce::Logger::writeToLog("AudioEngine: new take cancelled on " +
                               clip->getUuid() + " - the previous take stands");
      continue;
    }
    take.clips.push_back(clip);
    take.prev_active.push_back(prev_active[k]);
    take.prev_retime.push_back(clip->retime());
    clip->setRetime(0);
  }
  return take;
}

/**
 * GROUP-WINDOW LIFT (Q13 for groups). A take committed off the grid of a
 * Q that outlived its content commits whole, with a sub-region loop on
 * each clip (commitRecording's hysteresis snap). On a sole clip that
 * region IS the definer selection; on a group take it belongs to the
 * definer STACK ("children whole"): left on the members, a trim would
 * put a stack window over theirs. So the members' common commit-time
 * region becomes the stack's window and the members go whole.
 */
void liftGroupWindow(StackNode& root, const std::vector<ClipNode*>& committed,
                     Edit& inv) {
  if (committed.size() < 2) return;
  StackNode* stack = definerStack(root);
  if (stack == nullptr || stack->isLoopWindowActive()) return;
  int64_t ls = 0, le = 0;
  for (size_t i = 0; i < committed.size(); ++i) {
    ClipNode* clip = committed[i];
    if (clip->getParent() != stack || clip->hasSegmentMap()) return;
    const int64_t s = clip->getLoopStart();
    const int64_t e = std::min(clip->getLoopEnd(), clip->getIntrinsicDuration());
    if (i == 0) {
      ls = s;
      le = e;
    } else if (s != ls || e != le) {
      return;  // no common region: not a snap artefact
    }
  }
  if (le <= ls || !storesGeometry(*committed[0])) return;  // whole already
  // The rider takes the stack back to no window. The members' regions
  // come back through the Untake payload (stripTake zeroes them,
  // restoreTake reinstalls what they hold now: whole).
  Edit::WindowRider back;
  back.uuid = stack->getUuid();
  back.start = stack->getLoopStart();
  back.end = stack->getLoopEnd();
  inv.windows.push_back(std::move(back));
  for (ClipNode* clip : committed) clip->setLoopPoints(0, 0);
  stack->setLoopPoints(ls, le);
  juce::Logger::writeToLog("AudioEngine: group take window lifted onto " +
                           stack->getUuid() + " [" + juce::String(ls) + ", " +
                           juce::String(le) + ") - members whole");
}

}  // namespace

Edit settleCommittedTake(AudioEngine& engine, StackNode& root,
                         const CommittedTake& take) {
  Edit inv(Edit::Kind::Untake);
  for (size_t k = 0; k < take.clips.size(); ++k) {
    ClipNode& clip = *take.clips[k];
    Edit::TakePayload payload;
    payload.uuid = clip.getUuid();
    if (take.new_take) {
      payload.take_index = clip.activeTake();
      payload.prev_active = take.prev_active[k];
      if (k < take.prev_retime.size()) {
        payload.setsRetime = true;
        payload.retime = take.prev_retime[k];
      }
    }
    if (clip.contentKind() == ClipNode::ContentKind::Midi) {
      if (auto* instrument = dynamic_cast<dsp::Vst3Slot*>(
              clip.fxChain()->firstInstrumentSlot())) {
        payload.instrument_slot = instrument->slotUuid();
        payload.instrument_state = instrument->stateBlob();
      }
    }
    inv.takes.push_back(std::move(payload));
  }
  inv.setsIsland = true;
  inv.iq = take.q_before;
  inv.izero = take.zero_before;
  if (!take.new_take) {
    if (take.q_before <= 0 && root.getQuantum() > 0) {
      engine.scrubIncoherentGeometry(root.getQuantum(), inv);
    }
    settleAnchors(root, inv);
    liftGroupWindow(root, take.clips, inv);
  }
  for (ClipNode* clip : take.clips) {
    if (clip->reservedStorage() != nullptr) engine.compactClipToHeap(*clip);
  }
  return inv;
}

}  // namespace celestrian::engine_internal

using celestrian::engine_internal::CommittedTake;
using celestrian::engine_internal::forEachClip;
using celestrian::engine_internal::IslandBefore;
using celestrian::engine_internal::nearestAncestor;
using celestrian::engine_internal::StepAim;
using celestrian::engine_internal::ThroughMap;

void AudioEngine::compactClipToHeap(celestrian::ClipNode& clip) {
  if (clip.isArmedOrRecording()) return;
  const int64_t keep = celestrian::engine_internal::settledLength(clip);
  const int chans = std::max(1, clip.getAudioBuffer().getNumChannels());
  auto fresh = std::make_unique<juce::AudioBuffer<float>>(chans, (int)keep);
  // `keep` can pass the source's end, and AudioBuffer does not zero on
  // construction: clear the tail past the copy.
  const int64_t have =
      std::min<int64_t>(keep, clip.getAudioBuffer().getNumSamples());
  for (int c = 0; c < chans; ++c) {
    fresh->copyFrom(c, 0, clip.getAudioBuffer(), c, 0, (int)have);
    if (have < keep) fresh->clear(c, (int)have, (int)(keep - have));
  }
  // Safe under a RENDERING clip: content is reached through one atomic
  // pointer, and what the swap displaces — the buffer, then the
  // reservation it referred into — retires through the reclaimer.
  retireOwned(clip.swapContent(std::move(fresh)));
  if (auto st = clip.releaseStorage()) retireOwned(std::move(st));
}

void AudioEngine::compactIdleTakes() {
  forEachClip(*root_node, [this](celestrian::ClipNode& clip) {
    const int64_t slack = clip.contentCapacity() -
                          celestrian::engine_internal::settledLength(clip);
    if (slack >= celestrian::engine_internal::kCompactionSlackSamples) {
      compactClipToHeap(clip);  // which leaves a live take alone
    }
  });
}

void AudioEngine::growLiveTakes() {
  // THE GROWER (take_storage.h): every live take's reach stays committed
  // (ClipNode::takeReach). A stalled message thread is the only way a
  // take meets its wall.
  const int64_t quantum = root_node->getQuantum();
  forEachClip(*root_node, [quantum](celestrian::ClipNode& clip) {
    if (clip.isArmedOrRecording()) clip.commitTakeReach(quantum);
  });
}

bool AudioEngine::startRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine: record refused - " + why);
    return false;
  };
  // VALIDATE, THEN ARM: every refusal leaves the transport, the graph
  // and the undo log as it found them.
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return refuse("no node " + uuid);
  // ONE TAKE AT A TIME: the island's cycle snapshots belong to the one
  // live performance.
  if (refusedUnderLiveTake("record (a second arm)")) return false;
  // The island counts no take, so every earlier performance has
  // settled: it enters the log ahead of this arm's edits.
  reconcileTakes();
  const std::vector<celestrian::ClipNode*> targets =
      celestrian::engine_internal::armTargets(*node);
  if (targets.empty()) {
    return refuse("no empty clip to arm under " + uuid +
                  " (arm targets emptiness, Q7; re-recording is the takes "
                  "feature)");
  }

  // THE ARM'S OWN EDITS (applyArmEdits) go in first, unlogged: the
  // checks below judge the graph the take will record against — a
  // collapsed definer stack is no longer a window above its members, and
  // the song position the auto-target reads follows the collapse's
  // origins. A refusal puts them back. ANY member's refusal refuses the
  // WHOLE group: half a performance armed would be worse than none.
  ArmEdits arm_edits = applyArmEdits(node, nullptr);
  const StepAim aim = celestrian::engine_internal::autoTargetCuedStep(
      *targets[0], global_transport_pos.load(), rootScope());
  std::vector<int64_t> through_map_cycles;
  for (const celestrian::ClipNode* target : targets) {
    const ThroughMap through = celestrian::engine_internal::throughMapOf(
        *target, aim, root_node->getQuantum());
    if (through.refusal != nullptr) {
      revertArmEdits(std::move(arm_edits));
      return refuse(through.refusal);
    }
    through_map_cycles.push_back(through.cycle);
  }

  // THE ARM PROCEEDS: nothing below refuses.
  logArmEdits(std::move(arm_edits));
  if (aim.stack != nullptr) {
    aim.stack->setAuditionStep(aim.step);
    juce::Logger::writeToLog(
        "AudioEngine: arm inside cued step " + juce::String(aim.step) +
        " - auto-targeting it (S21: record-into-step)");
  }
  const IslandBefore before = celestrian::engine_internal::armPerformance(
      *this, *root_node, is_playing_global, targets,
      [&](celestrian::ClipNode& clip, size_t i) {
        // STALE GEOMETRY DIES AT ARM: a cell map found on an empty clip
        // would warp the new take's playback with segments cut for
        // content that is gone.
        if (clip.hasSegmentMap()) clip.setLoopPoints(0, 0);
        return clip.prepareRecording(through_map_cycles[i]);
      });

  // TAKES ARE UNDOABLE: register the performance; reconcileTakes logs it
  // once every member has settled (PendingTake).
  PendingTake pending;
  pending.q_before = before.quantum;
  pending.zero_before = before.zero;
  for (const celestrian::ClipNode* clip : targets) {
    pending.uuids.push_back(clip->getUuid());
  }
  // Aimed at a looping step? The auditioning DIRECT parent of a member
  // names the auto-gate (docs/sequencer.md §11.5).
  for (const celestrian::ClipNode* clip : targets) {
    auto* parent = dynamic_cast<celestrian::StackNode*>(clip->getParent());
    if (parent != nullptr && parent->auditionActive()) {
      pending.gate_stack = parent->getUuid();
      pending.gate_step = parent->auditionStep();
      break;
    }
  }
  pending_takes_.push_back(std::move(pending));
  return true;
}

bool AudioEngine::newTake(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: new_take requested for " + uuid);
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine: new take refused - " + why);
    return false;
  };
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return refuse("no node " + uuid);
  if (refusedUnderLiveTake("new take (a second arm)")) return false;
  reconcileTakes();  // earlier performances log first (startRecordingInNode)
  const std::vector<celestrian::ClipNode*> targets =
      celestrian::engine_internal::retakeTargets(*node);
  if (targets.empty()) {
    return refuse("no committed idle clip under " + uuid +
                  " (record arms an empty clip; a new take re-records a slot)");
  }
  for (const celestrian::ClipNode* t : targets) {
    // A one-shot's period is the context cycle, not its length: the
    // slot-top arm rule has no top to aim at.
    if (t->periodFromContext()) {
      return refuse(t->getUuid() +
                    " is a one-shot (its period is the context cycle)");
    }
    // The slot's top must be a heard moment: under an ACTIVE ancestor
    // map the heard clock is folded and may never visit it.
    const auto mapped = [](const celestrian::AudioNode& a) {
      return a.isLoopWindowActive();
    };
    if (nearestAncestor(*t, mapped) != nullptr) {
      return refuse("an active loop window or step audition encloses " +
                    t->getUuid() + " (bypass it to re-record the slot)");
    }
    if (t->takeCount() >= celestrian::ClipNode::kMaxTakes) {
      return refuse(t->getUuid() + " holds the maximum number of takes");
    }
    // What is left of the clip's own judge: the chain's kind.
    if (!t->mayRetake()) {
      return refuse(t->getUuid() +
                    " would record a different content kind than its takes "
                    "hold");
    }
  }

  // Every refusal is behind us. THE ARM'S OWN EDITS, as at any arm: a
  // provisionally trimmed definer collapses to its window first, so the
  // new take's period IS the trimmed loop (Q13); a new take of the
  // designated definer itself (or its members) keeps the hand-off, one
  // of any other slot ends it (Q22).
  logArmEdits(applyArmEdits(nullptr, &targets));

  PendingTake pending;
  pending.retake = true;
  for (const celestrian::ClipNode* clip : targets) {
    pending.uuids.push_back(clip->getUuid());
    pending.prev_active.push_back(clip->activeTake());
  }
  // The arm's own edits change nothing mayRetake judges (a collapse
  // leaves a slot its content, its list and its chain).
  const IslandBefore before = celestrian::engine_internal::armPerformance(
      *this, *root_node, is_playing_global, targets,
      [](celestrian::ClipNode& clip, size_t) { return clip.prepareRetake(); });
  pending.q_before = before.quantum;
  pending.zero_before = before.zero;
  pending_takes_.push_back(std::move(pending));
  juce::Logger::writeToLog("AudioEngine: new take armed on " +
                           juce::String((int)targets.size()) +
                           " clip(s) - each at its own slot top");
  return true;
}

bool AudioEngine::selectTake(const juce::String& uuid, int index) {
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::selectTake refused - " + why);
    return false;
  };
  auto* clip = dynamic_cast<celestrian::ClipNode*>(
      findNodeByUuid(uuid));
  if (clip == nullptr) return refuse("no clip " + uuid);
  if (index < 0 || index >= clip->takeCount()) {
    return refuse("no take " + juce::String(index) + " on " + uuid);
  }
  if (index == clip->activeTake()) return false;  // nothing to change
  celestrian::Edit e(celestrian::Edit::Kind::SelectTake);
  e.uuid = uuid;
  e.index = index;
  return record(std::move(e));
}

bool AudioEngine::deleteTake(const juce::String& uuid, int index) {
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::deleteTake refused - " + why);
    return false;
  };
  auto* clip = dynamic_cast<celestrian::ClipNode*>(
      findNodeByUuid(uuid));
  if (clip == nullptr) return refuse("no clip " + uuid);
  if (clip->takeCount() < 2) {
    return refuse("the last take of a slot stays (delete the clip to remove "
                  "it)");
  }
  if (index < 0 || index >= clip->takeCount()) {
    return refuse("no take " + juce::String(index) + " on " + uuid);
  }
  celestrian::Edit e(celestrian::Edit::Kind::DeleteTake);
  e.uuid = uuid;
  e.index = index;
  return record(std::move(e));
}

bool AudioEngine::setComp(const juce::String& uuid,
                          const std::vector<int>& cells) {
  const auto refuse = [](const juce::String& why) {
    juce::Logger::writeToLog("AudioEngine::setComp refused - " + why);
    return false;
  };
  auto* clip = dynamic_cast<celestrian::ClipNode*>(
      findNodeByUuid(uuid));
  if (clip == nullptr) return refuse("no clip " + uuid);
  if (clip->contentKind() == celestrian::ClipNode::ContentKind::Midi) {
    return refuse("comping a MIDI clip is not supported (select a whole "
                  "take)");
  }
  const int64_t q = root_node->getQuantum();
  const int64_t period = clip->getIntrinsicDuration();
  if (q <= 0 || period <= 0) return refuse("no committed period to comp");
  // The shape of a comp is judged for a comp that is being SET; clearing
  // one is always possible, whatever Q has become under it.
  const int64_t expected = (period + q - 1) / q;
  if (!cells.empty() && (int64_t)cells.size() != expected) {
    return refuse(juce::String((int)cells.size()) + " cells for a period of " +
                  juce::String(expected) + " Q cells");
  }
  if (!cells.empty() && expected > celestrian::ClipNode::kMaxCompCells) {
    return refuse("the period exceeds the comp's cell bound");
  }
  for (const int c : cells) {
    if (c < -1 || c >= clip->takeCount()) {
      return refuse("take " + juce::String(c) + " does not exist on " + uuid);
    }
  }
  // A comp is authored on the grid as it lies now: Q cells from the
  // content's zero (an identity records nothing).
  const int64_t cell_len = cells.empty() ? 0 : q;
  if (cells == clip->compCells() && cell_len == clip->compCellLength() &&
      clip->compCellOffset() == 0) {
    return false;
  }
  celestrian::Edit e(celestrian::Edit::Kind::Comp);
  e.uuid = uuid;
  e.cells = cells;
  e.cell_len = cell_len;
  return record(std::move(e));
}

void AudioEngine::reconcileTakes() {
  // Nothing settles while the island counts a live take: one performance
  // is live at a time, and its count drops last (the end-of-take order,
  // ClipNode::RecState).
  if (root_node->hasActiveTake()) return;
  for (size_t i = 0; i < pending_takes_.size();) {
    if (!celestrian::engine_internal::performanceSettled(
            *root_node, pending_takes_[i].uuids, pending_takes_[i].retake)) {
      ++i;
      continue;
    }
    const PendingTake done = std::move(pending_takes_[i]);
    pending_takes_.erase(pending_takes_.begin() + (long)i);

    CommittedTake take;
    if (done.retake) {
      take = celestrian::engine_internal::settleRetakes(
          *this, *root_node, done.uuids, done.prev_active);
    } else {
      take.clips = celestrian::engine_internal::committedMembers(*root_node,
                                                                 done.uuids);
    }
    if (take.clips.empty()) continue;  // the whole performance cancelled
    take.q_before = done.q_before;
    take.zero_before = done.zero_before;
    // The settled content is new to the mirror (a stripped-then-
    // re-recorded slot may still have a stale file under the same name).
    for (celestrian::ClipNode* clip : take.clips) clip->markTakeFilesDirty();
    pushUndo(celestrian::engine_internal::settleCommittedTake(*this, *root_node,
                                                             take));
    juce::Logger::writeToLog(
        juce::String("AudioEngine: ") + (done.retake ? "new take" : "take") +
        " logged (undoable) - " + juce::String((int)take.clips.size()) +
        " clip(s)");
    if (done.retake) continue;
    // The settle (anchors, a lifted group window) may move the tracks
    // that were already there; the new clips themselves are new.
    noteOriginDrift("take settle (" + juce::String((int)take.clips.size()) +
                    " clip(s): " + take.clips.front()->getName() + ")");
    if (done.gate_stack.isNotEmpty() && done.gate_step >= 0) {
      applyAutoGate(done.gate_stack, done.gate_step, take.clips);
    }
  }
}

void AudioEngine::applyAutoGate(
    const juce::String& stack_uuid, int step,
    const std::vector<celestrian::ClipNode*>& committed) {
  // STEP-RECORD AUTO-GATE (docs/sequencer.md §11.5, S19): a take aimed
  // at a looping step gates each committed DIRECT child of the
  // auditioning stack ON in that step and OFF elsewhere — one
  // Edit::Sequence composed onto the take's entry, so one undo removes
  // take and gates together. A deeper take is left ungated: gating it
  // would silence its whole group in every other section.
  auto* stack = dynamic_cast<celestrian::StackNode*>(
      findNodeByUuid(stack_uuid));
  if (stack == nullptr) return;
  const celestrian::Sequence* cur = stack->sequencePtr();
  if (cur == nullptr || step >= cur->numSteps()) return;
  auto fresh = std::make_unique<celestrian::Sequence>(*cur);
  bool changed = false;
  for (auto* clip : committed) {
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
  e.b1 = true;  // auto-gate marker: composes onto the take's log entry
  celestrian::Edit inv = applyEdit(std::move(e));
  if (inv.kind == celestrian::Edit::Kind::Nop) return;
  // The Untake entry on top of the log absorbs the gate inverse: undo
  // applies the sequence restore, then the strip.
  if (!undo_.empty() && undo_.back().kind == celestrian::Edit::Kind::Untake) {
    undo_.back().seq = std::move(inv.seq);
    undo_.back().uuid = stack_uuid;
    undo_.back().b1 = true;
  } else {
    pushUndo(std::move(inv));
  }
}

bool AudioEngine::stopRecordingInNode(const juce::String& uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  auto* node = findNodeByUuid(uuid);
  if (node == nullptr) return false;
  // Stop is fractal like arm (Q7): every live take under the target is
  // asked in THIS call. An armed take is cancelled here; a capturing one
  // is the audio thread's to end (ClipNode::stopRecording), at a block
  // top: on to its boundary, or — an island's first take, which has none
  // — right there, at its write head.
  const std::vector<celestrian::ClipNode*> live =
      celestrian::engine_internal::liveClips(*node);
  const bool first_take = root_node->getQuantum() <= 0;
  // A group stop parks a generation on every member and publishes it in
  // one store: all members take it up at the same block top — one
  // boundary, or one first-take length. A single clip is asked directly.
  const uint32_t gen = live.size() > 1 ? root_node->nextStopGeneration() : 0;
  for (celestrian::ClipNode* clip : live) clip->stopRecording(gen);
  if (gen != 0) root_node->publishStopGeneration(gen);
  // WHEN NO OTHER THREAD RUNS THE BLOCKS (blocksRunElsewhere) the block
  // top that would end a first take is this thread's to run, and nothing
  // can be capturing while it does — so it runs here, over a block of no
  // samples. A take with a boundary still to reach needs real blocks:
  // the host's.
  if (first_take && !blocksRunElsewhere()) {
    const celestrian::ProcessContext top =
        celestrian::engine_internal::renderContext(
            *root_node, *graph_snapshot_.load(std::memory_order_acquire),
            cached_sample_rate_.load(), /*num_samples=*/0,
            global_transport_pos.load(), is_playing_global.load());
    for (celestrian::ClipNode* clip : live) {
      if (clip->isRecording()) clip->control(nullptr, 0, top);
    }
  }
  // What has ended settles right here — an arm's cancel, a first take
  // this thread just ended: its slot sounds, and its undo step exists,
  // without waiting for the next poll. A take the audio thread has yet
  // to end settles at the poll after it does (tick).
  reconcileTakes();
  return !live.empty();
}
