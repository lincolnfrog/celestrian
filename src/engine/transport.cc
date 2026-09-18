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


void AudioEngine::togglePlayback() {
  // Pause/resume: stopping freezes the clock where it is; playing
  // resumes from the same phase. The clock is never reset (kernel.md).
  // (Restart-from-top is not an engine concept; if it ever were, it
  // would be a root time-map — kernel.md §3.) The user-facing play
  // start is UI policy composed from this toggle and seekTransport —
  // session_view.md display law 15, ui/js/play_start.js. No pause under a live take
  // (owner ruling 2026-09-09): the take performs against the running
  // clock — finish or cancel it first.
  if (is_playing_global.load() && refusedUnderLiveTake("pause")) return;
  is_playing_global = !is_playing_global.load();
}

bool AudioEngine::seekTransport(double delta_samples,
                                std::optional<int64_t> at_clock,
                                SeekResult* applied) {
  // Refused while any take is live or armed: takes place audio by
  // this clock (arm targets, origins, commit boundaries all read it),
  // so a mid-take phase jump would corrupt the take's placement. The
  // UI mirrors the refusal (ruler shows a locked cursor), but the
  // engine owns the rule.
  if (root_node == nullptr) return false;
  // Settle any take the audio thread committed since the last poll
  // FIRST: shiftHistoryAbsolutes below re-frames the log, and a take
  // that has not entered it yet would carry a pre-seek zero into its
  // later Untake entry (record/undo/redo reconcile the same way).
  reconcileTakes();
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    return false;
  }

  // THE SEEK IS A PHASE ADVANCE (docs/frame.md): the engine reads no
  // frame — only the view knows where the frame's zero is seated — so
  // the view sends how far the playing phase should move, computed
  // against the transport reading it last polled (`at_clock`). The
  // clock has moved since that poll; correcting for it lands the phase
  // the view meant, exactly, stopped or playing. Advancing the phase
  // by `advance` is moving the island's zero — and every origin with
  // it — BACK by `advance`. The monotonic clock is untouched
  // (kernel.md); islandPos teleports with the zero, and the UI's
  // dead-reckoner classifies the jump as a TELEPORT, never velocity
  // (playhead_clock.js). A zero advance is an accepted no-op.
  const int64_t t = global_transport_pos.load();
  int64_t advance = (int64_t)std::llround(delta_samples);
  if (at_clock.has_value()) advance -= t - *at_clock;
  if (applied != nullptr) {
    applied->advance = advance;
    applied->clock = t;
  }
  const int64_t delta = -advance;
  if (delta == 0) return true;
  const int64_t zero_old = root_node->getZero();
  const int64_t zero_new = zero_old + delta;
  const uint32_t gen = root_node->nextIslandGeneration();
  // THE CONTENT-FRAME LAW (time_maps.md; pinned by
  // tests/content_frame_tests.cc): clips read their buffers
  // ORIGIN-relative on the monotonic clock, so moving the zero alone
  // would move the cursor and NOT the audio. A seek is a phase jump of
  // the whole island: every origin rides the zero's delta, so each
  // clip's placement on the grid (origin − zero) is unchanged and
  // playback lands at the requested phase. Not undoable, like the seek
  // itself.
  // Every origin — clips AND stacks (Q18), the root's too — rides the
  // delta: the recursive shift is the one primitive (composition.md §5).
  shiftOriginsGated(*root_node, delta, gen);
  // Origins first (gated), then the zero with the generation: one
  // block top adopts both or neither.
  root_node->seekZeroTo(zero_new, gen);
  // THE HISTORY RIDES TOO: the undo/redo logs store ABSOLUTE origins
  // and zeros, and a seek re-frames every absolute in the session. An
  // inverse restoring pre-seek absolutes for a SUBSET of clips (a
  // continuity rider, a take payload) would shift that subset against
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
    // setsIsland's izero is a real zero on every kind that sets it.
    // A Collapse inverse's facts (shift, old_duration, the window) are
    // RELATIVE; its splice form's pre-splice origin rides `iorg` under
    // setsOrigin and shifts below like every absolute.
    if (e.setsIsland) e.izero += delta;
    if (e.setsOrigin) e.iorg += delta;
    for (auto& r : e.anchors) r.origin += delta;
    for (auto& r : e.seq_riders) r.origin += delta;  // the root's anchor
    for (auto& tp : e.takes) tp.state.origin += delta;
    for (auto& ot : e.other_takes) ot.second.origin += delta;
    shiftSubtree(e.node.get());
    shiftSubtree(e.node2.get());
  };
  for (auto& e : undo_) shiftEdit(e);
  for (auto& e : redo_) shiftEdit(e);
}

void AudioEngine::tick() {
  // Forward any log lines queued by the audio thread.
  celestrian::RtLog::instance().drain();
  // Settled takes enter the undo log (see PendingTake), and every live
  // take keeps its storage headroom.
  reconcileTakes();
  growLiveTakes();
}

juce::var AudioEngine::getGraphState() {
  tick();

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
    // is audible, and the playhead loops with what is heard — from the
    // root's frame top (its song's origin while it carries one, else
    // the island zero), the place the root's own geometry folds from.
    const int64_t cycle = calculateEffectiveCycleLength();
    const int64_t rel = t - rootFrameTop();
    master_view = (double)celestrian::timing::posMod(rel, cycle);
  }
  // The RAW island clock (zero-relative, unwrapped): masterPos above is
  // folded on the CURRENT audible cycle, so its fold point jumps when a
  // live map edit changes that cycle mid-gesture. The UI folds this
  // invariant clock on its own (pinned) frame for a continuous cursor.
  const double island_view = (double)(t - islandZero());

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
  // The island zero is the UI's frame origin for every cycle-relative
  // projection (kernel.md one-frame rule). It is NOT the root node's
  // `origin` metadata — commit re-bases the zero (StackNode::takeCommitted),
  // and the UI marking take-vs-ghost tiles needs the re-based value.
  state.setProperty("islandZero", (double)islandZero());
  // THE DEFINER, published: the sole committed
  // clip, or the definer stack, whose window re-establishes Q — the UI
  // reads this instead of re-deriving it with its own (drifting)
  // definition. Empty when the island has no definer.
  {
    // engine_internal::definer carries EVERY gate (sole geometry, no
    // live take, no audition) — the UI reads the answer, never re-adds
    // a gate.
    auto* d = celestrian::engine_internal::definer(*root_node);
    state.setProperty("definerId", d != nullptr ? d->getUuid() : juce::String());
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

juce::var AudioEngine::getTakeWaveform(const juce::String& uuid, int index,
                                       int num_peaks) const {
  auto* self = const_cast<AudioEngine*>(this);
  if (auto* clip = dynamic_cast<celestrian::ClipNode*>(
          self->findNodeByUuid(root_node.get(), uuid))) {
    return clip->getTakeWaveform(index, num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- LCM Timeline Helpers ---

int64_t AudioEngine::calculateEffectiveCycleLength() const {
  // THE PERIOD LAW over the current snapshot (period_law.h /
  // graph_snapshot.h) — the very computation the audio callback seeds
  // its context with, so the message thread and the callback cannot
  // disagree on the cycle. The snapshot is immutable once published and
  // the message thread publishes it; node facts (durations, windows,
  // sequences) are atomics read live.
  const int64_t one_second = (int64_t)cached_sample_rate_.load();
  if (!root_node) return one_second;
  const auto* snap = graph_snapshot_.load(std::memory_order_acquire);
  if (snap == nullptr) return one_second;
  return celestrian::snapEffectiveCycle(*snap, root_node->getEffectiveQuantum(),
                                        one_second);
}
