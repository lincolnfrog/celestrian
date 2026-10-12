// AudioEngine — TRANSPORT + STATE (message thread only): play / pause,
// the seek, the poll's housekeeping (tick), getGraphState — the ONE UI
// state publication — and the state reads beside it (waveforms, a MIDI
// clip's notes, the perf block, the audible cycle).
//
// THE CLOCK IS NEVER RESET (kernel.md §2): pause freezes it, play
// resumes it, and a seek moves the island's zero — and every origin
// with it — instead.

#include "../audio_engine.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <vector>

#include "../clip_node.h"
#include "../rt_log.h"
#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

bool AudioEngine::togglePlayback() {
  // No pause under a live take: it performs against the running clock.
  // (The user-facing play start is UI policy composed from this toggle
  // and seekTransport — ui/js/play_start.js.)
  if (is_playing_global.load() && refusedUnderLiveTake("pause")) return false;
  is_playing_global = !is_playing_global.load();
  return true;
}

bool AudioEngine::seekTransport(double delta_samples,
                                std::optional<int64_t> at_clock,
                                SeekResult* applied) {
  // A take the audio thread committed since the last poll settles
  // FIRST: shiftHistoryAbsolutes below re-frames the log, and a take
  // entering it later would carry a pre-seek zero.
  reconcileTakes();
  // Refused under a live or armed take: takes place audio by this clock
  // (arm targets, origins, commit boundaries).
  if (root_node->hasActiveTake() || root_node->isArmedOrRecording()) {
    return false;
  }

  // THE SEEK IS A PHASE ADVANCE (the contract: audio_engine.h): the
  // view's advance, corrected for the clock having moved since the
  // reading it was computed against, is applied by moving the island's
  // zero BACK by it.
  const int64_t t = global_transport_pos.load();
  int64_t advance = (int64_t)std::llround(delta_samples);
  if (at_clock.has_value()) advance -= t - *at_clock;
  if (applied != nullptr) {
    applied->advance = advance;
    applied->clock = t;
  }
  const int64_t delta = -advance;
  if (delta == 0) return true;
  // THE CONTENT-FRAME LAW (time_maps.md; tests/content_frame_tests.cc):
  // clips read their buffers ORIGIN-relative, so moving the zero alone
  // would move the cursor and not the audio. Every origin — clips and
  // stacks, the root's too — rides the delta, and each node's placement
  // on the grid is unchanged. Origins first (gated), then the zero with
  // the generation: one block top adopts both or neither.
  const uint32_t gen = root_node->nextIslandGeneration();
  shiftOriginsGated(*root_node, delta, gen);
  root_node->seekZeroTo(root_node->getZero() + delta, gen);
  shiftHistoryAbsolutes(delta);
  return true;
}

void AudioEngine::shiftHistoryAbsolutes(int64_t delta) {
  // THE HISTORY RIDES A SEEK: the logs store ABSOLUTE origins and zeros.
  // An inverse restoring pre-seek absolutes for a SUBSET of clips would
  // move that subset against everything else, so every absolute in the
  // logs shifts by the same delta and undo restores the same PLACEMENT.
  auto shiftEdit = [&](celestrian::Edit& entry) {
    // Every edit of a composed entry (Edit::then).
    for (celestrian::Edit* e = &entry; e != nullptr; e = e->then.get()) {
      // A Collapse inverse's own facts (shift, old_duration, the window)
      // are RELATIVE; its splice form's pre-splice origin rides `iorg`
      // and shifts like every absolute.
      if (e->setsIsland) e->izero += delta;
      if (e->setsOrigin) e->iorg += delta;
      for (auto& r : e->anchors) r.origin += delta;
      for (auto& r : e->seq_riders) r.origin += delta;  // the root's anchor
      for (auto& tp : e->takes) tp.state.origin += delta;
      for (auto& ot : e->other_takes) ot.second.origin += delta;
      // A detached subtree the entry owns: every node's origin, ungated
      // (nothing renders it).
      if (e->node != nullptr) {
        celestrian::engine_internal::forEachNode(
            *e->node, [delta](celestrian::AudioNode& node) {
              node.origin_samples.store(node.origin_samples.load() + delta);
            });
      }
    }
  };
  for (auto& e : undo_) shiftEdit(e);
  for (auto& e : redo_) shiftEdit(e);
  // …and the redo branch an open gesture keeps (cancelGesture may put
  // it back).
  for (auto& e : gesture_redo_) shiftEdit(e);
}

void AudioEngine::tick() {
  celestrian::RtLog::instance().drain();  // lines the audio thread queued
  reconcileTakes();
  growLiveTakes();
  // The drift log's catch-all: a relative move no named step reported
  // (an arm, the audio thread's commit, a path outside the edit log)
  // surfaces at the next poll.
  noteOriginDrift("an unlogged step (seen at a poll)");
}

juce::var AudioEngine::getGraphState() {
  tick();

  // THE CYCLE VIEW of the monotonic clock: the published masterPos is
  // derived here. It folds on the EFFECTIVE cycle — active windows
  // shorten what is audible, and the playhead loops with what is heard —
  // from the root's frame top, where the root's own geometry folds from.
  // Under a take it is the callback's base plus linear growth: the
  // cursor runs on past the committed cycle, and before Q exists it is
  // the first take's own position (the clock from the island zero).
  const int64_t t = global_transport_pos.load();
  const double master_view =
      view_recording_.load()
          ? (double)(view_base_.load() + (t - view_anchor_t_.load()))
          : (double)celestrian::timing::posMod(t - rootFrameTop(),
                                               calculateEffectiveCycleLength());
  // The RAW island clock (zero-relative, unwrapped): masterPos's fold
  // point jumps when a live map edit changes the audible cycle
  // mid-gesture; the UI folds this invariant clock on its own frame for
  // a continuous cursor.
  const double island_view = (double)(t - islandZero());

  // The root's metadata IS the state: every node, and `quantum` — the
  // island Q — at the top level.
  auto metadata = root_node->getMetadata();
  auto* obj = metadata.getDynamicObject();
  attachTransportState(*obj, master_view, island_view);
  obj->setProperty("focusedId", root_node->getUuid());
  return metadata;
}

void AudioEngine::attachTransportState(juce::DynamicObject& state,
                                       double master_view,
                                       double island_view) const {
  state.setProperty("isPlaying", (bool)is_playing_global.load());
  state.setProperty("masterPos", master_view);
  state.setProperty("islandPos", island_view);
  // The island zero — Q's grid phase — is not the root node's `origin`
  // metadata: the root's own origin is its song's anchor (docs/frame.md
  // §4).
  state.setProperty("islandZero", (double)islandZero());
  // THE DEFINER, published: the UI reads the answer (engine_internal::
  // definer carries every gate) and never re-derives it. Empty when the
  // island has none.
  auto* d = celestrian::engine_internal::definer(*root_node);
  state.setProperty("definerId", d != nullptr ? d->getUuid() : juce::String());
  // Master monitor: the output's peak envelope per channel (linear
  // 0..1), written by the callback.
  state.setProperty("masterVuL", (double)master_vu_l_.load());
  state.setProperty("masterVuR", (double)master_vu_r_.load());
  state.setProperty("canUndo", canUndo());
  state.setProperty("canRedo", canRedo());
  state.setProperty("perf", makePerfState());
}

juce::var AudioEngine::makePerfState() const {
  juce::DynamicObject::Ptr perf = new juce::DynamicObject();
  perf->setProperty("maxBlockUs", (double)max_block_us_.load());
  perf->setProperty("avgLoadPct", avg_dsp_load_.load() * 100.0);
  perf->setProperty("xruns", (double)xrun_count_.load());

  const int64_t measured = measured_latency_samples_.load();
  perf->setProperty("latencyCompensationSamples",
                    (double)celestrian::engine_internal::recordingLatency(
                        measured, cached_input_latency_.load(),
                        cached_output_latency_.load()));
  perf->setProperty("calibrated", measured >= 0);
  // The device's actual rate: what any samples→ms display must use.
  perf->setProperty("sampleRate", cached_sample_rate_.load());
  return juce::var(perf.get());
}

juce::var AudioEngine::getWaveform(const juce::String& uuid,
                                   int num_peaks) const {
  if (auto* node = findNodeByUuid(uuid)) return node->getWaveform(num_peaks);
  return juce::Array<juce::var>();
}

juce::var AudioEngine::getTakeWaveform(const juce::String& uuid, int index,
                                       int num_peaks) const {
  if (auto* clip =
          dynamic_cast<celestrian::ClipNode*>(findNodeByUuid(uuid))) {
    return clip->getTakeWaveform(index, num_peaks);
  }
  return juce::Array<juce::var>();
}

juce::var AudioEngine::getMidiNotes(const juce::String& uuid) const {
  juce::Array<juce::var> rows;
  auto* clip = dynamic_cast<celestrian::ClipNode*>(findNodeByUuid(uuid));
  if (clip == nullptr || clip->recState() != celestrian::ClipNode::RecState::Idle ||
      clip->contentKind() != celestrian::ClipNode::ContentKind::Midi) {
    return rows;
  }
  const int64_t duration = clip->getIntrinsicDuration();
  const int64_t q = root_node->getQuantum();
  if (duration <= 0 || q <= 0) return rows;
  const int64_t base = clip->getContentBase();
  const celestrian::MidiSequence& seq = clip->midiSequence();

  struct Note {
    int64_t pos = 0, len = 0;
    int note = 0, velocity = 0;
  };
  struct Open {
    int64_t pos = 0;
    int velocity = 0;
  };
  std::vector<Note> notes;
  std::map<int, std::vector<Open>> open;  // (channel, pitch) -> note-ons
  for (int i = 0; i < seq.count(); ++i) {
    const celestrian::MidiEvent& e = seq[i];
    const int64_t pos = e.pos - base;
    if (pos < 0 || pos >= duration) continue;
    const int key = e.channel0() * 128 + e.note();
    if (e.isNoteOn()) {
      open[key].push_back({pos, e.velocity()});
    } else if (e.isNoteOff()) {
      auto it = open.find(key);
      if (it == open.end() || it->second.empty()) continue;
      const Open on = it->second.back();
      it->second.pop_back();
      notes.push_back({on.pos, pos - on.pos, e.note(), on.velocity});
    }
  }
  // Unpaired note-ons run to the take end.
  for (const auto& [key, stack] : open) {
    for (const Open& on : stack) {
      notes.push_back({on.pos, duration - on.pos, key % 128, on.velocity});
    }
  }
  std::stable_sort(notes.begin(), notes.end(),
                   [](const Note& a, const Note& b) { return a.pos < b.pos; });
  for (const Note& n : notes) {
    const celestrian::timing::QTime pos = celestrian::timing::fromSamples(n.pos, q);
    const celestrian::timing::QTime len = celestrian::timing::fromSamples(n.len, q);
    juce::Array<juce::var> row;
    row.add((double)pos.num);
    row.add((double)pos.den);
    row.add(n.note);
    row.add(n.velocity);
    row.add((double)len.num);
    row.add((double)len.den);
    rows.add(juce::var(row));
  }
  return rows;
}

int64_t AudioEngine::calculateEffectiveCycleLength() const {
  // THE ISLAND'S AUDIBLE CYCLE on the message thread: the period law
  // over the current snapshot — the computation the callback seeds its
  // context with (engine_internal::renderContext), so the two threads
  // cannot disagree. The snapshot is immutable once published; node
  // facts (durations, windows, sequences) are atomics read live.
  const auto* snap = graph_snapshot_.load(std::memory_order_acquire);
  return celestrian::snapEffectiveCycle(*snap, root_node->getQuantum(),
                                        (int64_t)cached_sample_rate_.load());
}
