// AudioEngine — the message-thread owner of the session graph and the
// audio callback. This file holds construction, the whole-graph
// publish, the reclaimer (retire / flushGraveyard), the uuid lookup
// and session save / load. The rest of the class lives under
// src/engine/, one file per responsibility:
//   island_geometry.cc  the island geometry law: definers, Q13 riders,
//                       two-anchor continuity, Q18 origins / anchoring,
//                       island (Q, epoch) writes and the scrubs
//   edit_log.cc         applyEdit and its inverses, the undo / redo log
//   take_service.cc     take lifecycle: arm, stop, settle, storage upkeep
//   transport.cc        play / pause, seek, getGraphState — the ONE UI
//                       state publication
//   verbs.cc            bridge verbs: node CRUD, templates, inputs,
//                       pan / gain, the fx rack, MIDI arm, solo / mute
//   map_edits.cc        loop points, segments, window toggle, sequences
//                       and step audition
//   audio_callback.cc   the audio callback and its perf meters
//   device_service.cc   device open / selection, latency calibration
//                       and their persistence, device lifecycle
//   engine_internal.h   tree queries shared by the files above
// Everything but the callback is message thread only; the callback
// communicates through atomics, the graph snapshot and the reclaimer
// (docs/performance.md §1).

#include "audio_engine.h"

#include <algorithm>

#include "rt_log.h"
#include "stack_node.h"

// The epoch re-base is driven by the commit EVENT (StackNode::takeCommitted),
// never by callback edge detection (unification_audit.md §1.5).

AudioEngine::AudioEngine() {
  // Start with an empty root stack
  auto root = std::make_unique<celestrian::StackNode>("SessionRoot");
  root_node = std::move(root);
  publishGraph();

  // Pre-record ring: preallocated here so the audio thread never resizes it.
  prerecord_ring_.setSize(kPreRecordRingChannels, kPreRecordRingLen);
  prerecord_ring_.clear();

  // Live MIDI buffer (phase 4): preallocated so the per-callback drain
  // never grows it on the audio thread.
  live_midi_buffer_.ensureSize(8192);
}

void AudioEngine::publishGraph() {
  const auto* fresh = celestrian::buildGraphSnapshot(*root_node);
  const auto* old = graph_snapshot_.exchange(fresh, std::memory_order_acq_rel);
  // Publish-then-retire: an in-flight callback may still traverse the
  // old snapshot; the reclaimer's 2-callback grace covers it. (Nodes a
  // structural edit removed are retired by their own paths AFTER this
  // publish, so the old snapshot never outlives its referents.)
  retireOwned(old);
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

    // Reap: an item retired at epoch E is unreachable once the callback
    // counter has advanced by 2 — every callback that could have loaded the
    // old snapshot has completed by then.
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

int64_t AudioEngine::islandEpoch() const { return root_node->getEpoch(); }

void AudioEngine::flushGraveyard() {
  std::vector<RetiredItem> pending;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    pending.swap(graveyard_);
  }
  for (auto& item : pending) item.free();
}

celestrian::AudioNode* AudioEngine::findNodeByUuid(celestrian::AudioNode* node,
                                                   const juce::String& uuid) {
  return node ? node->findByUuid(uuid) : nullptr;
}

bool AudioEngine::saveSession(const juce::String& path) {
  return celestrian::session_io::save(*root_node, cached_sample_rate_.load(),
                                      juce::File(path));
}

bool AudioEngine::loadSession(const juce::String& path) {
  // Refuse mid-take: an in-flight capture is TRANSIENT, not saved, and
  // tearing the graph out from under it would corrupt the buffer.
  if (root_node->hasActiveTake()) return false;

  auto loaded = celestrian::session_io::load(juce::File(path),
                                             cached_sample_rate_.load());
  if (!loaded.ok) return false;

  // Swap the root's CONTENTS in place: root_node's identity never
  // changes, so the audio thread (which dereferences root_node) sees no
  // pointer race — only the child snapshot swaps, through the proven
  // reclaimer path. There is a ≤2-callback window of an empty root
  // (brief silence) during the load, which is acceptable for a load.
  // clearChildren DETACHES; retirement is ours — the audio thread may
  // still traverse the old graph snapshot for ≤2 callbacks after the
  // publish below.
  {
    for (auto& node : root_node->clearChildren()) {
      retireOwned(std::move(node));
    }
  }
  for (auto& child : loaded.children) root_node->addChild(std::move(child));

  // Force the island facts. addChild may have transiently re-established
  // (Q, epoch) from the first committed clip using the CLIP's origin as
  // the epoch (wrong); this overrides it with the persisted values.
  root_node->setQuantum(loaded.q_samples, loaded.epoch);
  root_node->is_muted.store(loaded.root_muted);
  celestrian::session_io::applyEffects(
      *root_node, loaded.root_effects, loaded.sample_rate,
      [this](celestrian::dsp::FxChain* old) { retireOwned(old); });
  // Q18: pre-Q18 sessions carry no stack origins — anchor from content
  // (the same rule the first content applied live).
  {
    celestrian::Edit scratch;
    settleAnchors(scratch);
  }
  publishGraph();  // the audio thread sees the loaded topology

  clearHistory();  // a loaded session starts with no undo history

  juce::Logger::writeToLog("AudioEngine: session loaded from " + path);
  // The ONE post-load hook (all load paths funnel through here —
  // bridge, chooser, project manager): MainComponent uses it for the
  // plugin revival sweep (docs/vst3.md §6).
  if (on_session_loaded_) on_session_loaded_();
  return true;
}
