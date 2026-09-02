// AudioEngine — TRANSPORT + STATE: play/pause, the seek (a whole-island
// phase jump whose delta the undo/redo logs ride), getGraphState — the
// ONE UI state publication — with its transport block, waveform reads
// and the effective-cycle helper. Message thread only.

#include "../audio_engine.h"

#include <cmath>

#include "../clip_node.h"
#include "../rt_log.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

using celestrian::engine_internal::definerStack;
using celestrian::engine_internal::firstCommittedClip;
using celestrian::engine_internal::hasActiveGeometryOutside;

void AudioEngine::togglePlayback() {
  // Pause/resume: stopping freezes the clock where it is; playing
  // resumes from the same phase. The clock is never reset (kernel.md).
  // (Restart-from-top as a real feature is a root time-map — tasks.md
  // open question 8.)
  is_playing_global = !is_playing_global.load();
}

bool AudioEngine::seekTransport(double pos_samples) {
  // Refused while any take is live or armed: takes place audio by
  // this clock (arm targets, origins, commit boundaries all read it),
  // so a mid-take phase jump would corrupt the take's placement. The
  // UI mirrors the refusal (ruler shows a locked cursor), but the
  // engine owns the rule.
  if (root_node == nullptr) return false;
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    return false;
  }

  // The target arrives in the published-masterPos domain: epoch-
  // relative, folded on the audible cycle (E-C — under a root
  // audition that cycle IS the step, since the derived window is an
  // active map and getEffectivePeriod lets maps win). Fold
  // defensively so an out-of-range target lands where the playhead
  // would show it rather than teleporting the phase off-cycle.
  const int64_t cycle = calculateEffectiveCycleLength();
  int64_t pos = (int64_t)std::llround(pos_samples);
  if (cycle > 0) {
    pos = celestrian::timing::posMod(pos, cycle);
  } else if (pos < 0) {
    pos = 0;
  }

  // The seek itself: epoch := t - pos, so rel = t - epoch reads as
  // exactly the requested phase from the next block/poll on. The
  // monotonic clock is untouched (kernel.md); islandPos teleports
  // with the epoch, and the UI's dead-reckoner classifies the jump
  // as a TELEPORT, never velocity (playhead_clock.js).
  const int64_t t = global_transport_pos.load();
  const int64_t epoch_old = root_node->getEpoch();
  const int64_t epoch_new = t - pos;
  const uint32_t gen = root_node->nextIslandGeneration();
  // THE CONTENT-FRAME LAW (time_maps.md; pinned by
  // tests/content_frame_tests.cc): clips read their buffers
  // ORIGIN-relative on the monotonic clock, so moving the epoch alone
  // would move the cursor and NOT the audio. A seek is a phase jump of
  // the whole island: every origin rides the epoch delta, so each
  // clip's placement on the grid (origin − epoch) is unchanged and
  // playback lands at the requested phase. Not undoable, like the seek
  // itself.
  const int64_t delta = epoch_new - epoch_old;
  // Every origin — clips AND stacks (Q18) — rides the delta: the
  // recursive shift is the one primitive (composition.md §5).
  if (delta != 0) shiftOriginsGated(*root_node, delta, gen);
  // Origins first (gated), then the epoch with the generation: one
  // block top adopts both or neither.
  root_node->seekEpochTo(epoch_new, gen);
  // THE HISTORY RIDES TOO: the undo/redo logs store ABSOLUTE origins
  // and epochs, and a seek re-frames every absolute in the session. An
  // inverse restoring pre-seek absolutes for a SUBSET of clips (a
  // two-anchor rider, a take payload) would shift that subset against
  // everything else — undo would audibly move a clip the edit never
  // touched. Shift every absolute in both logs by the same delta, so
  // undo after a seek restores the same PLACEMENT.
  if (delta != 0) shiftHistoryAbsolutes(delta);
  return true;
}

void AudioEngine::shiftHistoryAbsolutes(int64_t delta) {
  const std::function<void(celestrian::AudioNode*)> shiftSubtree =
      [&](celestrian::AudioNode* node) {
        if (node == nullptr) return;
        // Detached subtrees held by the log: every node's origin (Q18 —
        // stacks too), ungated (nothing renders them).
        node->origin_samples.store(node->origin_samples.load() + delta);
        if (node->getNodeType() == celestrian::NodeType::Clip) return;
        auto* stack = static_cast<celestrian::StackNode*>(node);
        for (const auto& child : stack->ownedChildren())
          shiftSubtree(child.get());
      };
  auto shiftEdit = [&](celestrian::Edit& e) {
    // setsIsland's iepoch is a real epoch on every kind that sets it
    // (CollapseTake/CollapseGroup reuse iq/iepoch as shift/duration but
    // never with setsIsland).
    if (e.setsIsland) e.iepoch += delta;
    if (e.setsOrigin) e.iorg += delta;
    for (auto& r : e.anchors) r.origin += delta;
    for (auto& tp : e.takes) tp.state.origin += delta;
    shiftSubtree(e.node.get());
    shiftSubtree(e.node2.get());
  };
  for (auto& e : undo_) shiftEdit(e);
  for (auto& e : redo_) shiftEdit(e);
}

juce::var AudioEngine::getGraphState() const {
  // Forward any log lines queued by the audio thread (UI polls this
  // every ~50 ms, so this doubles as the RtLog drain point).
  celestrian::RtLog::instance().drain();
  // The poll is also where settled takes enter the undo log (see
  // PendingTake): message-thread bookkeeping on a const read path —
  // the one sanctioned const_cast, for the same reason the RtLog drain
  // lives here.
  const_cast<AudioEngine*>(this)->reconcileTakes();
  const_cast<AudioEngine*>(this)->growLiveTakes();

  // Cycle view of the monotonic clock (kernel.md step 3): the engine
  // never wraps its transport; the UI-facing masterPos is derived here.
  // Idle/playback: t mod LCM. Recording: frozen base + linear growth so
  // the cursor extends past the committed LCM.
  const int64_t t = global_transport_pos.load();
  double master_view;
  if (view_recording_.load()) {
    master_view = (double)(view_base_.load() + (t - view_anchor_t_.load()));
  } else {
    // Wrap on the EFFECTIVE cycle (E-C): active windows shorten what
    // is audible, and the playhead loops with what is heard.
    const int64_t cycle = calculateEffectiveCycleLength();
    const int64_t rel = t - islandEpoch();
    master_view = (double)celestrian::timing::posMod(rel, cycle);
  }
  // The RAW island clock (epoch-relative, unwrapped): masterPos above is
  // folded on the CURRENT audible cycle, so its fold point jumps when a
  // live map edit changes that cycle mid-gesture. The UI folds this
  // invariant clock on its own (pinned) frame for a continuous cursor.
  const double island_view = (double)(t - islandEpoch());

  if (root_node) {
    auto metadata = root_node->getMetadata();
    auto* obj = metadata.getDynamicObject();
    attachTransportState(*obj, master_view, island_view);
    // NOTE: the root's metadata already carries `quantum` (its stored
    // island Q, stack_node.cc) — the VM reads it as the top-level Q
    // fact instead of re-deriving min-over-nodes.
    obj->setProperty("focusedId", root_node->getUuid());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  attachTransportState(*state, master_view, island_view);
  state->setProperty("quantum",
                     (double)(root_node ? root_node->getQuantum() : 0));
  state->setProperty("nodes", juce::Array<juce::var>());
  return juce::var(state.get());
}

void AudioEngine::attachTransportState(juce::DynamicObject& state,
                                       double master_view,
                                       double island_view) const {
  state.setProperty("isPlaying", (bool)is_playing_global.load());
  state.setProperty("masterPos", master_view);
  state.setProperty("islandPos", island_view);
  // The island epoch is the UI's frame origin for every cycle-relative
  // projection (kernel.md one-frame rule). It is NOT the root node's
  // `origin` metadata — commit re-bases the epoch (StackNode::takeCommitted),
  // and the UI marking take-vs-ghost tiles needs the re-based value.
  state.setProperty("islandEpoch", (double)islandEpoch());
  // THE DEFINER, published: the sole committed
  // clip, or the definer stack, whose window re-establishes Q — the UI
  // reads this instead of re-deriving it with its own (drifting)
  // definition. Empty when the island has no definer.
  {
    juce::String definer;
    if (islandCommittedClipCount() == 1) {
      if (auto* c = firstCommittedClip(root_node.get());
          c != nullptr && !hasActiveGeometryOutside(root_node.get(), c)) {
        definer = c->getUuid();
      }
    } else if (auto* ds = definerStack(root_node.get())) {
      definer = ds->getUuid();
    }
    state.setProperty("definerId", definer);
  }
  // Master monitor: smoothed output RMS per channel (linear 0..1) —
  // the transport VU section reads these off the state poll.
  state.setProperty("masterVuL", (double)master_vu_l_.load());
  state.setProperty("masterVuR", (double)master_vu_r_.load());
  state.setProperty("canUndo", canUndo());
  state.setProperty("canRedo", canRedo());
  state.setProperty("perf", makePerfState());
}

juce::var AudioEngine::getWaveform(const juce::String& uuid,
                                   int num_peaks) const {
  auto* self = const_cast<AudioEngine*>(this);
  if (auto* node = self->findNodeByUuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- LCM Timeline Helpers ---

int64_t AudioEngine::calculateEffectiveCycleLength() const {
  const int64_t one_second = (int64_t)cached_sample_rate_.load();
  if (!root_node) return one_second;

  int64_t quantum = root_node->getEffectiveQuantum();
  if (quantum <= 0) quantum = one_second;

  // The root is never windowed itself; its effective period is the LCM
  // of the children's effective periods (E-C, recursive).
  const int64_t p = root_node->getEffectivePeriod();
  return p > 0 ? celestrian::timing::lcm(quantum, p) : quantum;
}
