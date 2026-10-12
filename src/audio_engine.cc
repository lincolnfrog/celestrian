// AudioEngine — the message-thread owner of the session graph and the
// audio callback. This file holds construction, the whole-graph publish,
// the reclaimer (retire / flushGraveyard) and session save / load. The
// rest of the class lives under src/engine/, one file per responsibility:
//   island_geometry.cc  the Q hand-off, the continuity rider, Q18 origins
//                       and anchoring, island (Q, zero) writes, the scrub
//   definer.cc          the Q-definer: which node re-establishes (Q, zero)
//   edit_log.cc         the edit log: record, the gesture, undo / redo
//   edit_structure.cc, edit_geometry.cc, edit_takes.cc, edit_facts.cc
//                       the appliers, one per Edit kind
//   take_service.cc     take lifecycle: arm, stop, settle, storage upkeep
//   transport.cc        play / pause, seek, getGraphState — the ONE UI
//                       state publication
//   verbs.cc            bridge verbs: node CRUD, templates, inputs,
//                       pan / gain, the fx rack, MIDI arm, solo / mute
//   map_edits.cc        the map commit, the re-time, sequences and the
//                       step audition
//   audio_callback.cc   the audio callback and its perf meters
//   device_service.cc   device open / selection, latency calibration
//                       and their persistence, device lifecycle
//   bounce.cc, import.cc  the offline render and the file import
//   engine_internal.h, edit_internal.h  what the files above share
// Everything but the callback is message thread only; the callback
// communicates through atomics, the graph snapshot and the reclaimer
// (docs/performance.md §1).

#include "audio_engine.h"

#include <algorithm>

#include "engine/engine_internal.h"
#include "rt_log.h"
#include "stack_node.h"

AudioEngine::AudioEngine() {
  // The RtLog is a function-local static: its first touch constructs it
  // under a guard. Here, on the message thread, so the audio thread's
  // first post() never runs the constructor or its lock.
  celestrian::RtLog::instance();

  root_node = std::make_unique<celestrian::StackNode>("SessionRoot");
  publishGraph();

  // Preallocated: the audio thread never resizes the ring, and one drain
  // of the MIDI queue never grows the buffer.
  prerecord_ring_.setSize(kPreRecordRingChannels, kPreRecordRingLen);
  prerecord_ring_.clear();
  live_midi_buffer_.ensureSize(
      celestrian::engine_internal::kLiveMidiDrainBytes);
  slice_midi_buffer_.ensureSize(
      celestrian::engine_internal::kLiveMidiDrainBytes);
}

void AudioEngine::publishGraph() {
  const auto* fresh = celestrian::buildGraphSnapshot(*root_node);
  const auto* old = graph_snapshot_.exchange(fresh, std::memory_order_acq_rel);
  // PUBLISH, THEN RETIRE: a callback in flight may still traverse the old
  // snapshot, and the reclaimer's two-callback grace covers it only if
  // every stamp is taken AFTER the exchange. A node detached earlier in
  // this edit (parked by retireNode) was reachable through the old
  // snapshot until this line, so its grace starts here; whatever is
  // already in the graveyard is re-stamped to now as well, so nothing
  // retired between a detach and its publish is reaped inside that
  // window.
  const uint64_t now = callback_count_.load();
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    for (auto& item : graveyard_) item.epoch = std::max(item.epoch, now);
  }
  std::vector<std::unique_ptr<celestrian::AudioNode>> parked;
  parked.swap(parked_nodes_);
  for (auto& node : parked) retireOwned(std::move(node));
  retireOwned(old);
}

void AudioEngine::retireNode(std::unique_ptr<celestrian::AudioNode> node) {
  // PARK, never stamp: the published snapshot lists nodes, not owners,
  // so a detached node stays reachable until publishGraph replaces it.
  // Stamped now, a reaping retire() between the detach and the publish
  // could free it under a callback.
  if (node) parked_nodes_.push_back(std::move(node));
}

AudioEngine::~AudioEngine() {
  device_manager.removeAudioCallback(this);
  // No callback can be in flight anymore.
  flushGraveyard();
  delete graph_snapshot_.exchange(nullptr);  // the final published snapshot
  celestrian::RtLog::instance().drain();
}

void AudioEngine::retire(std::function<void()> deleter) {
  const uint64_t now = callback_count_.load();
  std::vector<std::function<void()>> ready;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    graveyard_.push_back({now, std::move(deleter)});

    // Reap: once the callback counter has advanced by 2, every callback
    // that could have loaded the retired object has completed.
    auto still_pending = [now](const RetiredItem& item) {
      return item.epoch + 2 > now;
    };
    auto it =
        std::partition(graveyard_.begin(), graveyard_.end(), still_pending);
    for (auto i = it; i != graveyard_.end(); ++i)
      ready.push_back(std::move(i->free));
    graveyard_.erase(it, graveyard_.end());
  }
  for (auto& free_fn : ready) free_fn();
}

int64_t AudioEngine::islandZero() const { return root_node->getZero(); }

int64_t AudioEngine::rootFrameTop() const {
  return root_node->isAnchored() ? root_node->origin_samples.load()
                                 : root_node->getZero();
}

void AudioEngine::flushGraveyard() {
  std::vector<RetiredItem> pending;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    pending.swap(graveyard_);
  }
  for (auto& item : pending) item.free();
}

bool AudioEngine::saveSession(const juce::String& path) {
  return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                      juce::File(path));
}

bool AudioEngine::loadSession(const juce::String& path) {
  // A capture in flight is transient, not saved, and tearing the graph
  // out from under it would corrupt its buffer.
  if (root_node->hasActiveTake()) return false;

  // The live clock seats a zero saved by a longer-running earlier run
  // (session_io::load): the island loads at its top, never in the future.
  auto loaded = celestrian::session_io::load(juce::File(path),
                                             cached_sample_rate_.load(),
                                             global_transport_pos.load());
  if (!loaded.ok) return false;

  // The root's CONTENTS swap in place: its identity never changes, so
  // the audio thread sees no pointer race, only a brief empty root.
  // clearChildren DETACHES; the old nodes stay reachable through the
  // published snapshot until the publish below (retireNode).
  for (auto& node : root_node->clearChildren()) retireNode(std::move(node));
  for (auto& child : loaded.children) root_node->addChild(std::move(child));

  // The island facts are the persisted ones: attaching content never
  // establishes any.
  root_node->setQuantum(loaded.q_samples, loaded.zero);
  // The Q hand-off's designation (Q22), after the graph it names; one
  // naming a missing node falls through (engine_internal::definer).
  root_node->setDefinerDesignation(loaded.definer);
  // The root's anchor rides its song (docs/frame.md §4): the loader
  // resolved it from the root's record; content never settles it.
  root_node->setAnchor(loaded.root_anchored,
                       loaded.root_anchored ? loaded.root_origin : 0, 0);
  // The root's own record on the LIVE root — the facts a nested stack
  // loads, at root scope (a radio may live here, S12). After Q, which
  // the song's step lengths are measured in; the rack prepared at the
  // DEVICE's rate, not the bundle's. What they displace may still be
  // read by the audio thread.
  celestrian::session_io::applyNodeFacts(
      *root_node, loaded.root, loaded.q_samples, currentSampleRateOrFallback(),
      celestrian::session_io::SequenceScope::ROOT,
      [this](celestrian::dsp::FxChain* old) { retireOwned(old); },
      [this](const celestrian::Sequence* old) { retireOwned(old); });
  // A session without stack origins anchors from content, as live
  // content does (Q18).
  {
    celestrian::Edit scratch;
    settleAnchors(scratch);
  }
  publishGraph();

  clearHistory();
  // A loaded island is not a move: the drift log starts over.
  origin_marks_.clear();
  noteOriginDrift("load");

  juce::Logger::writeToLog("AudioEngine: session loaded from " + path);
  if (on_session_loaded_) on_session_loaded_();
  return true;
}
