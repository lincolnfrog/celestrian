#include "audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include "clip_node.h"
#include "rt_log.h"
#include "stack_node.h"
#include "timing.h"

namespace {
// Audio-thread-safe recursive scan of committed clips: detects whether any
// duration is not a multiple of the previous cycle (polyrhythmic
// expansion) and finds the newest origin (largest — origins are monotonic
// in recording order under the monotonic transport). No allocation.
void scanCommitted(celestrian::AudioNode *node, int64_t lcm_before,
                   bool &polyrhythmic, int64_t &newest_origin) {
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(node)) {
    for (auto *child : stack->getChildrenSnapshot()) {
      scanCommitted(child, lcm_before, polyrhythmic, newest_origin);
    }
    return;
  }
  const int64_t dur = node->getIntrinsicDuration();
  if (dur <= 0) return;
  if (dur % lcm_before != 0) polyrhythmic = true;
  newest_origin = std::max(newest_origin, node->origin_samples.load());
}
}  // namespace

AudioEngine::AudioEngine() {
  // Start with an empty root stack
  auto root = std::make_unique<celestrian::StackNode>("SessionRoot");
  root->setReclaimer(this);
  focused_node = root.get();
  root_node = std::move(root);

  // Pre-record ring: preallocated here so the audio thread never resizes it.
  prerecord_ring_.setSize(kPreRecordRingChannels, kPreRecordRingLen);
  prerecord_ring_.clear();
}

void AudioEngine::initialiseAudioDevice() { init(1, 2); }

void AudioEngine::createDefaultSession() {
  // Create a default stack with one clip ready for recording
  createNode("stack");
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(focused_node)) {
    if (stack->getNumChildren() > 0) {
      juce::String stack_uuid = stack->getChild(0)->getUuid();
      createNode("clip", stack_uuid);
    }
  }
}

AudioEngine::~AudioEngine() {
  device_manager.removeAudioCallback(this);
  // No callback can be in flight anymore.
  flushGraveyard();
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
    auto still_pending = [now](const RetiredItem &item) {
      return item.epoch + 2 > now;
    };
    auto it =
        std::partition(graveyard_.begin(), graveyard_.end(), still_pending);
    for (auto i = it; i != graveyard_.end(); ++i)
      ready.push_back(std::move(i->free));
    graveyard_.erase(it, graveyard_.end());
  }
  for (auto &free_fn : ready) free_fn();
}

int64_t AudioEngine::islandEpoch() const {
  if (auto *island = dynamic_cast<celestrian::StackNode *>(root_node.get())) {
    return island->getEpoch();
  }
  return 0;
}

void AudioEngine::flushGraveyard() {
  std::vector<RetiredItem> pending;
  {
    std::lock_guard<std::mutex> lock(graveyard_mutex_);
    pending.swap(graveyard_);
  }
  for (auto &item : pending) item.free();
}

void AudioEngine::init(int inputs, int outputs) {
  // Try for 8 inputs, but default to whatever the hardware provides
  device_manager.initialiseWithDefaultDevices(8, outputs);
  auto *device = device_manager.getCurrentAudioDevice();
  if (device) {
    juce::Logger::writeToLog(
        "AudioEngine: Initialized with " +
        juce::String(device->getActiveInputChannels().countNumberOfSetBits()) +
        " input channels.");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: FAILED to get current audio device.");
  }
  device_manager.addAudioCallback(this);
}

celestrian::AudioNode *AudioEngine::findNodeByUuid(celestrian::AudioNode *node,
                                                   const juce::String &uuid) {
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(node)) {
    return stack->findNodeByUuid(uuid);
  }
  if (node && node->getUuid() == uuid) return node;
  return nullptr;
}

void AudioEngine::startRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);

  // If the whole song is stopped when clicking record, automatically play
  if (!is_playing_global.load()) {
    is_playing_global.store(true);
    juce::Logger::writeToLog(
        "AudioEngine: Auto-starting transport for recording.");
  }

  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    juce::Logger::writeToLog("AudioEngine: Found clip, starting recording.");

    // The clock is NEVER reset (kernel.md §2) — not even for the first
    // clip. What the old "Initial Recording Reset" actually provided was
    // the island epoch; that is now captured as data (epoch := arm
    // moment) in ClipNode's first-clip arm path, leaving the clock
    // untouched.
    clip->startRecording();
  } else {
    juce::Logger::writeToLog("AudioEngine: CLIP NOT FOUND for " + uuid);
  }
}

void AudioEngine::stopRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    clip->stopRecording();
  }
}

void AudioEngine::togglePlayback() {
  // Pause/resume: stopping freezes the clock where it is; playing
  // resumes from the same phase. The clock is never reset (kernel.md).
  // (The old stop-reset only "restarted from the top" when the island
  // epoch happened to be 0; restart-from-top as a real feature is a
  // root time-map — tasks.md open question 8.)
  is_playing_global = !is_playing_global.load();
}

juce::var AudioEngine::getGraphState() const {
  // Forward any log lines queued by the audio thread (UI polls this
  // every ~50 ms, so this doubles as the RtLog drain point).
  celestrian::RtLog::instance().drain();

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
    master_view = (double)(cycle > 0 ? ((rel % cycle) + cycle) % cycle : rel);
  }

  if (focused_node) {
    auto metadata = focused_node->getMetadata();
    auto *obj = metadata.getDynamicObject();
    obj->setProperty("isPlaying", (bool)is_playing_global.load());
    obj->setProperty("masterPos", master_view);
    // The island epoch is the UI's frame origin for every cycle-relative
    // projection (kernel.md one-frame rule). It is NOT the root node's
    // `origin` metadata — commit re-bases the epoch (see processBlock),
    // and the UI marking take-vs-ghost tiles needs the re-based value.
    obj->setProperty("islandEpoch", (double)islandEpoch());
    obj->setProperty("soloedId", soloed_node_uuid);
    obj->setProperty("focusedId", focused_node->getUuid());
    obj->setProperty("perf", makePerfState());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  state->setProperty("isPlaying", (bool)is_playing_global.load());
  state->setProperty("masterPos", master_view);
  state->setProperty("islandEpoch", (double)islandEpoch());
  state->setProperty("soloedId", soloed_node_uuid);
  state->setProperty("nodes", juce::Array<juce::var>());
  state->setProperty("perf", makePerfState());
  return juce::var(state.get());
}

juce::var AudioEngine::getWaveform(const juce::String &uuid,
                                   int num_peaks) const {
  auto *self = const_cast<AudioEngine *>(this);
  if (auto *node = self->findNodeByUuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- Stack Expand/Collapse ---

void AudioEngine::toggleStackExpand(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    bool currentState = node->is_expanded.load();
    bool newState = !currentState;
    node->is_expanded.store(newState);

    // Purely visual (I6b): expansion changes nothing audible. Loop
    // window activation lives in its own state (toggleLoopWindow).
    juce::Logger::writeToLog(
        "AudioEngine: Toggled expand for " + uuid + " (New State: " +
        juce::String(newState ? "expanded" : "collapsed") + ")");
  }
}

void AudioEngine::createNode(const juce::String &type,
                             const juce::String &parent_uuid) {
  // Find target parent stack
  celestrian::StackNode *target_stack = nullptr;

  if (!parent_uuid.isEmpty()) {
    // Use specified parent
    auto *parent_node = findNodeByUuid(root_node.get(), parent_uuid);
    target_stack = dynamic_cast<celestrian::StackNode *>(parent_node);
  } else {
    // Default to focused_node
    target_stack = dynamic_cast<celestrian::StackNode *>(focused_node);
  }

  if (!target_stack) {
    juce::Logger::writeToLog("createNode: No valid stack target found");
    return;
  }

  std::unique_ptr<celestrian::AudioNode> new_node;
  if (type == "clip") {
    // Clip buffers and metadata carry the actual device rate (P0-5).
    new_node = std::make_unique<celestrian::ClipNode>(
        "New Clip", cached_sample_rate_.load());
  } else if (type == "stack") {
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  } else {
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  }

  new_node->setParent(target_stack);
  // Visual positioning is handled by the frontend.
  // Backend only manages ordered list membership.
  target_stack->addChild(std::move(new_node));
}

void AudioEngine::renameNode(const juce::String &uuid,
                             const juce::String &new_name) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->setName(new_name);
  }
}

void AudioEngine::reorderNode(const juce::String &node_uuid,
                              const juce::String &new_parent_uuid,
                              int new_index) {
  // Find the node to move
  auto *node = findNodeByUuid(root_node.get(), node_uuid);
  if (!node) {
    juce::Logger::writeToLog("reorderNode: Node not found: " + node_uuid);
    return;
  }

  // Find the new parent stack
  auto *new_parent = findNodeByUuid(root_node.get(), new_parent_uuid);
  auto *new_parent_stack = dynamic_cast<celestrian::StackNode *>(new_parent);
  if (!new_parent_stack) {
    juce::Logger::writeToLog("reorderNode: Invalid parent: " + new_parent_uuid);
    return;
  }

  // Get current parent
  auto *old_parent = node->getParent();
  auto *old_parent_stack = dynamic_cast<celestrian::StackNode *>(old_parent);

  // Remove from old parent and insert at new index
  if (old_parent_stack) {
    for (int i = 0; i < old_parent_stack->getNumChildren(); ++i) {
      if (old_parent_stack->getChild(i) == node) {
        auto owned_node = old_parent_stack->removeChild(i);
        owned_node->setParent(new_parent_stack);

        // Insert at the index specified by the frontend
        juce::Logger::writeToLog("reorderNode: " + node_uuid + " to " +
                                 new_parent_uuid + " at index " +
                                 juce::String(new_index));
        new_parent_stack->insertChildAt(std::move(owned_node), new_index);
        return;
      }
    }
  }
}

juce::String AudioEngine::combineNodes(const juce::String &dragged_uuid,
                                       const juce::String &target_uuid) {
  using celestrian::StackNode;

  auto *dragged = findNodeByUuid(root_node.get(), dragged_uuid);
  auto *target = findNodeByUuid(root_node.get(), target_uuid);
  if (!dragged || !target || dragged == target) {
    juce::Logger::writeToLog("combineNodes: Node not found or identical (" +
                             dragged_uuid + ", " + target_uuid + ")");
    return {};
  }

  auto *dragged_parent = dynamic_cast<StackNode *>(dragged->getParent());
  auto *target_parent = dynamic_cast<StackNode *>(target->getParent());
  if (!dragged_parent || !target_parent) {
    juce::Logger::writeToLog("combineNodes: Node has no parent stack");
    return {};
  }

  // Detach the dragged node from its parent.
  std::unique_ptr<celestrian::AudioNode> dragged_owned;
  for (int i = 0; i < dragged_parent->getNumChildren(); ++i) {
    if (dragged_parent->getChild(i) == dragged) {
      dragged_owned = dragged_parent->removeChild(i);
      break;
    }
  }
  if (!dragged_owned) return {};

  // Find the target's index AFTER the dragged removal (it may have shifted
  // if both nodes share a parent), then detach the target too.
  int target_index = -1;
  for (int i = 0; i < target_parent->getNumChildren(); ++i) {
    if (target_parent->getChild(i) == target) {
      target_index = i;
      break;
    }
  }
  if (target_index < 0) {
    // Should not happen; restore the dragged node rather than losing it.
    dragged_parent->addChild(std::move(dragged_owned));
    return {};
  }
  auto target_owned = target_parent->removeChild(target_index);

  // Build the combined stack at the target's position, target first
  // (mirrors the mock backend semantics used by drag & drop).
  auto new_stack = std::make_unique<StackNode>("Combined Stack");
  new_stack->x_pos.store(target_owned->x_pos.load());
  new_stack->y_pos.store(target_owned->y_pos.load());
  new_stack->addChild(std::move(target_owned));
  new_stack->addChild(std::move(dragged_owned));

  juce::String new_uuid = new_stack->getUuid();
  target_parent->insertChildAt(std::move(new_stack), target_index);

  juce::Logger::writeToLog("combineNodes: Combined " + dragged_uuid + " + " +
                           target_uuid + " into stack " + new_uuid);
  return new_uuid;
}

void AudioEngine::setNodePosition(const juce::String &node_uuid, double x,
                                  double y) {
  auto *node = findNodeByUuid(root_node.get(), node_uuid);
  if (node) {
    node->x_pos = x;
    node->y_pos = y;
  }
}

juce::var AudioEngine::getInputList() const {
  juce::Array<juce::var> names;
  if (auto *device = device_manager.getCurrentAudioDevice()) {
    auto inputNames = device->getInputChannelNames();
    juce::Logger::writeToLog("AudioEngine: Found " +
                             juce::String(inputNames.size()) +
                             " input channel names.");
    for (const auto &name : inputNames) {
      names.add(name);
    }
  }
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();
  obj->setProperty("inputs", names);
  return juce::var(obj.get());
}

void AudioEngine::setNodeInput(const juce::String &uuid, int channel_index) {
  if (auto *clip = dynamic_cast<celestrian::ClipNode *>(
          findNodeByUuid(root_node.get(), uuid))) {
    clip->setInputChannel(channel_index);
  }
}

void AudioEngine::setEffectEnabled(const juce::String &uuid,
                                   const juce::String &fx, bool enabled) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    // Prepare BEFORE the flag flips: the audio thread must never see an
    // enabled effect whose buffers aren't allocated. Idempotent per rate.
    double sr = cached_sample_rate_.load();
    if (sr <= 0) sr = 44100.0;
    node->effects().prepare(sr);
    if (node->effects().setEnabled(fx, enabled)) {
      juce::Logger::writeToLog("AudioEngine: effect " + fx + " on " + uuid +
                               (enabled ? " ENABLED" : " DISABLED"));
    }
  }
}

void AudioEngine::setEffectParam(const juce::String &uuid,
                                 const juce::String &fx,
                                 const juce::String &key, double value) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->effects().setParam(fx, key, value);
  }
}

void AudioEngine::setEffectScope(const juce::String &uuid, bool active) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    if (active) {
      // The scope can open before any slot is enabled — prepare so the
      // ring exists when the audio thread starts capturing
      double sr = cached_sample_rate_.load();
      if (sr <= 0) sr = 44100.0;
      node->effects().prepare(sr);
    }
    node->effects().setScopeActive(active);
  }
}

void AudioEngine::setLoopPoints(const juce::String &uuid, int64_t start,
                                int64_t end) {
  juce::Logger::writeToLog("AudioEngine::setLoopPoints: uuid=" + uuid +
                           " start=" + juce::String(start) +
                           " end=" + juce::String(end));
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->setLoopPoints(start, end);

    // Window phase is derived from the island clock (time_maps.md);
    // nothing to reset when the region changes.
    juce::Logger::writeToLog("  -> Found node, loop points set successfully");
  } else {
    juce::Logger::writeToLog("  -> ERROR: Node not found!");
  }
}

void AudioEngine::toggleLoopWindow(const juce::String &uuid) {
  // Fractal (I5): window state lives on AudioNode — clips toggle their
  // single-segment window exactly like stacks toggle their time-map.
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    const bool bypassed = !node->isLoopWindowBypassed();
    node->setLoopWindowBypassed(bypassed);
    juce::Logger::writeToLog(
        "AudioEngine: Loop window for " + uuid +
        (bypassed ? " BYPASSED" : " ACTIVE"));
  }
}
void AudioEngine::audioDeviceIOCallbackWithContext(
    const float *const *input_channel_data, int num_input_channels,
    float *const *output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext &context) {
  juce::ScopedNoDenormals no_denormals;

  // Epoch for deferred reclamation (see retire()).
  callback_count_.fetch_add(1);

  // --- Instrumentation: entry gap (xrun detection) ---
  const int64_t entry_ticks = juce::Time::getHighResolutionTicks();
  if (last_entry_ticks_ != 0) {
    const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
    const double gap_s = (double)(entry_ticks - last_entry_ticks_) / tps;
    const double period_s =
        (double)num_samples / cached_sample_rate_.load();
    // Gaps well beyond one block period mean the device starved (ignore
    // long idle gaps — those are stop/start, not overruns).
    if (gap_s > 2.0 * period_s && gap_s < 0.5) xrun_count_.fetch_add(1);
  }
  last_entry_ticks_ = entry_ticks;

  for (int i = 0; i < num_output_channels; ++i) {
    if (output_channel_data[i] != nullptr)
      juce::FloatVectorOperations::clear(output_channel_data[i], num_samples);
  }

  // --- Latency calibration pass (docs/performance.md §7) ---
  // While capturing: mirror the input into the calibration buffer and emit
  // the click into the outputs. Same block index for both sides, so the
  // capture timeline and the emission timeline are identical by
  // construction. Everything here is preallocated and bounded.
  if (calibration_phase_.load() == (int)CalibrationPhase::Capturing) {
    const int cap_len = calibration_capture_.getNumSamples();
    int wp = calibration_write_pos_.load();
    const int n = std::min(num_samples, cap_len - wp);

    if (n > 0) {
      if (num_input_channels > 0 && input_channel_data[0] != nullptr) {
        calibration_capture_.copyFrom(0, wp, input_channel_data[0], n);
      }

      // Click: 128 samples, decaying from full scale, starting at
      // calibration_click_pos_ on the shared timeline.
      constexpr int kClickLen = 128;
      for (int i = 0; i < n; ++i) {
        const int t = wp + i;
        const int k = t - calibration_click_pos_;
        if (k >= 0 && k < kClickLen) {
          const float v = 0.9f * (1.0f - (float)k / (float)kClickLen);
          for (int ch = 0; ch < num_output_channels; ++ch) {
            if (output_channel_data[ch] != nullptr)
              output_channel_data[ch][i] += v;
          }
        }
      }

      wp += n;
      calibration_write_pos_.store(wp);
    }

    if (wp >= cap_len) {
      calibration_phase_.store((int)CalibrationPhase::Done);
    }
  }

  // --- Pre-record ring write (docs/performance.md §3) ---
  // Every input block lands in the ring unconditionally, keyed by the
  // monotonic input clock, so a recording that starts later can still
  // reach audio that has already arrived. Two bounded memcpys per channel.
  const int ring_channels =
      std::min(num_input_channels, (int)kPreRecordRingChannels);
  for (int ch = 0; ch < ring_channels; ++ch) {
    if (input_channel_data[ch] == nullptr) continue;
    const int idx = (int)(input_clock_ % kPreRecordRingLen);
    const int first = std::min(num_samples, kPreRecordRingLen - idx);
    prerecord_ring_.copyFrom(ch, idx, input_channel_data[ch], first);
    if (num_samples > first) {
      prerecord_ring_.copyFrom(ch, 0, input_channel_data[ch] + first,
                               num_samples - first);
    }
  }

  if (root_node) {
    celestrian::ProcessContext pc;
    pc.sample_rate = cached_sample_rate_.load();
    pc.num_samples = num_samples;
    pc.is_playing = is_playing_global;
    pc.is_recording = true;  // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;
    if (ring_channels > 0) {
      pc.prerecord_ring = prerecord_ring_.getArrayOfReadPointers();
      pc.prerecord_ring_len = kPreRecordRingLen;
      pc.prerecord_ring_channels = ring_channels;
    }
    pc.input_clock = input_clock_;
    // Recording alignment: a measured round-trip (empirical calibration)
    // supersedes the driver-reported latencies, which are often wrong or
    // zero on consumer hardware.
    const int64_t measured = measured_latency_samples_.load();
    if (measured >= 0) {
      pc.input_latency = (int)measured;
      pc.output_latency = 0;
    } else {
      pc.input_latency = cached_input_latency_.load();
      pc.output_latency = cached_output_latency_.load();
    }
    pc.solo_node = soloed_node_ptr_.load();
    // Cycle-top of the island frame — loop-window time-maps phase off
    // this (time_maps.md); windowed stacks re-base it for their children.
    pc.cycle_epoch = islandEpoch();

    // Update Global Quantum Propagation:
    // If focused box has no quantum, check if its children have a finished
    // recording.
    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    input_clock_ += num_samples;

    if (is_playing_global.load()) {
      // Monotonic transport (kernel.md step 3): the clock only moves
      // forward. Clips align by their stored origins, so commits have
      // nothing to wrap, snap, or reset — the old LCM-wrap /
      // LCM-growth-snap / polyrhythm / first-clip-snap branch pile is
      // gone. The cycle position shown to the UI is a DERIVED view
      // (see getGraphState), which during recording grows linearly from
      // a base frozen at record start so the cursor can extend past the
      // committed LCM (recording.md cursor table).
      const int64_t old_pos = global_transport_pos.load();

      const bool is_recording = isAnyNodeRecording();
      if (is_recording && !was_any_node_recording_) {
        // The frozen base continues the view the user was WATCHING —
        // the effective (window-aware) wrap. The re-base comparison
        // (view_lcm_before_) stays intrinsic: simple-extension
        // detection is about committed material, not window state.
        const int64_t view_cycle = calculateEffectiveCycleLength();
        const int64_t rel = old_pos - islandEpoch();
        view_base_.store(view_cycle > 0 ? rel % view_cycle : rel);
        view_anchor_t_.store(old_pos);
        view_lcm_before_ = calculateTimelineLength();
      } else if (!is_recording && was_any_node_recording_) {
        // Commit: when the cycle grew as a simple extension (every
        // duration divides into multiples of the old cycle), re-base
        // the ISLAND epoch to the newest committed origin, so the
        // cycle top becomes the new phrase's top (recording.md "LCM
        // Expansion Snap", reborn as a pure epoch re-base — the clock
        // and the audio are untouched). The same epoch drives clip
        // arm/commit math, so visuals and audio share ONE frame.
        // Polyrhythmic expansions keep the old epoch: the cursor sails
        // on (recording.md example).
        const int64_t new_cycle = calculateTimelineLength();
        if (view_lcm_before_ > 0 && new_cycle > view_lcm_before_) {
          bool polyrhythmic = false;
          int64_t newest_origin = islandEpoch();
          scanCommitted(focused_node, view_lcm_before_, polyrhythmic,
                        newest_origin);
          if (!polyrhythmic) {
            if (auto *island =
                    dynamic_cast<celestrian::StackNode *>(root_node.get())) {
              island->setEpoch(newest_origin);
            }
          }
        }
      }
      was_any_node_recording_ = is_recording;
      view_recording_.store(is_recording);

      global_transport_pos.store(old_pos + num_samples);
    }
  }

  updatePerfMeters(entry_ticks, num_samples);
}

void AudioEngine::updatePerfMeters(int64_t entry_ticks, int num_samples) {
  const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
  const double duration_s =
      (double)(juce::Time::getHighResolutionTicks() - entry_ticks) / tps;
  const double period_s = (double)num_samples / cached_sample_rate_.load();

  const int64_t us = (int64_t)(duration_s * 1.0e6);
  if (us > max_block_us_.load()) max_block_us_.store(us);

  if (period_s > 0.0) {
    const double load = duration_s / period_s;
    // Single writer (audio thread): plain read-modify-write is fine.
    avg_dsp_load_.store(0.9 * avg_dsp_load_.load() + 0.1 * load);
  }
}

juce::var AudioEngine::makePerfState() const {
  juce::DynamicObject::Ptr perf = new juce::DynamicObject();
  perf->setProperty("maxBlockUs", (double)max_block_us_.load());
  perf->setProperty("avgLoadPct", avg_dsp_load_.load() * 100.0);
  perf->setProperty("xruns", (double)xrun_count_.load());

  const int64_t measured = measured_latency_samples_.load();
  const int64_t effective =
      measured >= 0
          ? measured
          : cached_input_latency_.load() + cached_output_latency_.load();
  perf->setProperty("latencyCompensationSamples", (double)effective);
  perf->setProperty("calibrated", measured >= 0);
  // The device's actual rate — the UI must use this (not 44100) for any
  // samples→ms display. The field found a 48 kHz device this way.
  perf->setProperty("sampleRate", cached_sample_rate_.load());
  return juce::var(perf.get());
}

// --- Latency Calibration (docs/performance.md §7) ---

void AudioEngine::startLatencyCalibration() {
  // Preallocate the capture buffer on the message thread BEFORE flipping
  // the phase — the audio thread only ever writes into existing storage.
  const double sr = cached_sample_rate_.load();
  const int capture_len = (int)(sr * 2.0);  // 2 s window
  calibration_capture_.setSize(1, capture_len, false, true, false);
  calibration_capture_.clear();
  calibration_click_pos_ = (int)(sr * 0.25);  // 250 ms of noise-floor lead-in
  calibration_write_pos_.store(0);
  measured_latency_samples_.store(-1);  // fall back to reported until done

  juce::Logger::writeToLog(
      "AudioEngine: Latency calibration started (capture " +
      juce::String(capture_len) + " samples, click at " +
      juce::String(calibration_click_pos_) + ")");

  calibration_phase_.store((int)CalibrationPhase::Capturing);
}

juce::var AudioEngine::getLatencyCalibration() {
  const double sr = cached_sample_rate_.load();

  // Run onset detection once, on the message thread, when capture is done.
  if (calibration_phase_.load() == (int)CalibrationPhase::Done &&
      measured_latency_samples_.load() < 0) {
    const float *data = calibration_capture_.getReadPointer(0);
    const int len = calibration_capture_.getNumSamples();
    const int click = calibration_click_pos_;

    // Noise floor from the lead-in, peak from the post-click region.
    float floor_level = 0.0f;
    for (int i = 0; i < click; ++i)
      floor_level = std::max(floor_level, std::abs(data[i]));
    float peak = 0.0f;
    for (int i = click; i < len; ++i)
      peak = std::max(peak, std::abs(data[i]));

    // Need a clear response well above the room/line noise.
    if (peak < std::max(0.02f, floor_level * 4.0f)) {
      calibration_phase_.store((int)CalibrationPhase::Failed);
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration FAILED — no loopback signal "
          "detected (peak=" +
          juce::String(peak) + ", floor=" + juce::String(floor_level) + ")");
    } else {
      const float threshold = std::max(floor_level * 4.0f, peak * 0.3f);
      for (int i = click; i < len; ++i) {
        if (std::abs(data[i]) >= threshold) {
          measured_latency_samples_.store(i - click);
          break;
        }
      }
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration DONE — round trip = " +
          juce::String(measured_latency_samples_.load()) + " samples (" +
          juce::String(measured_latency_samples_.load() / sr * 1000.0, 2) +
          " ms)");
      persistCalibration(measured_latency_samples_.load());
    }
  }

  juce::DynamicObject::Ptr result = new juce::DynamicObject();
  const int phase = calibration_phase_.load();
  const char *phase_name =
      phase == (int)CalibrationPhase::Capturing  ? "capturing"
      : phase == (int)CalibrationPhase::Done     ? "done"
      : phase == (int)CalibrationPhase::Failed   ? "failed"
                                                 : "idle";
  const int64_t measured = measured_latency_samples_.load();
  result->setProperty("phase", phase_name);
  result->setProperty("roundTripSamples", (double)measured);
  result->setProperty("roundTripMs",
                      measured >= 0 ? measured / sr * 1000.0 : -1.0);
  result->setProperty("calibrated", measured >= 0);
  return juce::var(result.get());
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {
  if (device) {
    cached_input_latency_.store(device->getInputLatencyInSamples());
    cached_output_latency_.store(device->getOutputLatencyInSamples());
    cached_sample_rate_.store(device->getCurrentSampleRate());
    cached_block_size_.store(device->getCurrentBufferSizeSamples());

    // Latency self-report (docs/performance.md §6.3): if the reported
    // latencies are zero, recording compensation is a no-op and empirical
    // calibration is the only trustworthy source.
    juce::Logger::writeToLog(
        "AudioEngine: Device started: '" + device->getName() +
        "' sr=" + juce::String(device->getCurrentSampleRate()) +
        " block=" + juce::String(device->getCurrentBufferSizeSamples()) +
        " inLatency=" + juce::String(device->getInputLatencyInSamples()) +
        " outLatency=" + juce::String(device->getOutputLatencyInSamples()));

    // A calibration is only valid for the exact device configuration it
    // was measured on.
    current_device_key_ = device->getName() + "|" +
                          juce::String(device->getCurrentSampleRate()) + "|" +
                          juce::String(device->getCurrentBufferSizeSamples());
    restoreCalibrationForCurrentDevice();
  }
}

// --- Calibration persistence (docs/performance.md §7) ---

juce::File AudioEngine::calibrationFile() const {
  if (calibration_file_override_ != juce::File()) {
    return calibration_file_override_;
  }
  return juce::File::getSpecialLocation(
             juce::File::userApplicationDataDirectory)
      .getChildFile("Celestrian")
      .getChildFile("calibration.json");
}

void AudioEngine::setCalibrationFile(const juce::File &file) {
  calibration_file_override_ = file;
}

void AudioEngine::persistCalibration(int64_t samples) {
  // No device key means no device ever started (unit tests) — a value
  // measured there is not attributable to hardware, so don't store it.
  if (current_device_key_.isEmpty() || samples < 0) return;

  auto file = calibrationFile();
  juce::var root;
  if (file.existsAsFile()) {
    root = juce::JSON::parse(file.loadFileAsString());
  }
  if (root.getDynamicObject() == nullptr) {
    root = juce::var(new juce::DynamicObject());
  }
  root.getDynamicObject()->setProperty(current_device_key_, (double)samples);

  file.getParentDirectory().createDirectory();
  file.replaceWithText(juce::JSON::toString(root, true));

  juce::Logger::writeToLog("AudioEngine: Calibration persisted for '" +
                           current_device_key_ + "' (" +
                           juce::String(samples) + " samples) -> " +
                           file.getFullPathName());
}

void AudioEngine::restoreCalibrationForCurrentDevice() {
  int64_t restored = -1;

  auto file = calibrationFile();
  if (current_device_key_.isNotEmpty() && file.existsAsFile()) {
    auto root = juce::JSON::parse(file.loadFileAsString());
    if (auto *obj = root.getDynamicObject()) {
      if (obj->hasProperty(current_device_key_)) {
        restored = (int64_t)(double)obj->getProperty(current_device_key_);
      }
    }
  }

  // Found -> use the empirical value from a previous session. Not found ->
  // reset: a value measured on a different device config must not carry
  // over (that would be silently wrong compensation).
  measured_latency_samples_.store(restored);

  if (restored >= 0) {
    juce::Logger::writeToLog(
        "AudioEngine: Calibration restored for '" + current_device_key_ +
        "': " + juce::String(restored) + " samples (" +
        juce::String(restored / cached_sample_rate_.load() * 1000.0, 2) +
        " ms)");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: No stored calibration for '" + current_device_key_ +
        "' — using device-reported latencies until calibrated.");
  }
}

void AudioEngine::audioDeviceStopped() {
  // The callback is no longer running; everything pending is safe to free.
  flushGraveyard();
}

void AudioEngine::toggleSolo(const juce::String &uuid) {
  if (soloed_node_uuid == uuid) {
    soloed_node_uuid = "";  // Unsolo
    soloed_node_ptr_.store(nullptr);
  } else {
    auto *node = findNodeByUuid(root_node.get(), uuid);
    soloed_node_uuid = node ? uuid : juce::String();
    soloed_node_ptr_.store(node);
  }
  juce::Logger::writeToLog("AudioEngine: Solo toggled for " + uuid +
                           " (Active Solo: " + soloed_node_uuid + ")");
}

void AudioEngine::togglePlay(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    if (auto *clip = dynamic_cast<celestrian::ClipNode *>(node)) {
      if (clip->isPlaying()) {
        clip->stopPlayback();
      } else {
        clip->startPlayback();
      }
      juce::Logger::writeToLog(
          "AudioEngine: Play toggled for " + uuid + " (New State: " +
          juce::String(clip->isPlaying() ? "true" : "false") + ")");
    }
  }
}
void AudioEngine::toggleMute(const juce::String &uuid) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    bool newState = !node->is_muted.load();
    node->is_muted.store(newState);
    juce::Logger::writeToLog(
        "AudioEngine: Mute toggled for " + uuid +
        " (New State: " + juce::String(newState ? "true" : "false") + ")");
  }
}

// --- LCM Timeline Helpers ---

namespace {
// Recursive helper to compute LCM across all clips, even nested in stacks.
// Plain free function (not a std::function) because this runs per block on
// the audio thread and must not allocate. Iterates the published child
// snapshot — one atomic load per stack, no locks.
int64_t computeLcmRecursive(celestrian::AudioNode *node, int64_t current_lcm) {
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(node)) {
    for (auto *child : stack->getChildrenSnapshot()) {
      current_lcm = computeLcmRecursive(child, current_lcm);
    }
  } else {
    // It's a clip - use its duration for LCM
    int64_t dur = node->getIntrinsicDuration();
    if (dur > 0) {
      current_lcm = celestrian::timing::lcm(current_lcm, dur);
    }
  }
  return current_lcm;
}
}  // namespace

int64_t AudioEngine::calculateTimelineLength() const {
  // Fallback timeline: 1 second at the actual device rate (P0-5).
  const int64_t one_second = (int64_t)cached_sample_rate_.load();

  if (!focused_node) {
    return one_second;
  }

  int64_t quantum = focused_node->getEffectiveQuantum();
  if (quantum <= 0) quantum = one_second;

  return computeLcmRecursive(focused_node, quantum);
}

int64_t AudioEngine::calculateEffectiveCycleLength() const {
  const int64_t one_second = (int64_t)cached_sample_rate_.load();
  if (!focused_node) return one_second;

  int64_t quantum = focused_node->getEffectiveQuantum();
  if (quantum <= 0) quantum = one_second;

  // The root is never windowed itself; its effective period is the LCM
  // of the children's effective periods (E-C, recursive).
  const int64_t p = focused_node->getEffectivePeriod();
  return p > 0 ? celestrian::timing::lcm(quantum, p) : quantum;
}

bool AudioEngine::isAnyNodeRecording() const {
  if (!focused_node) return false;

  // Use StackNode's recursive method to check all descendants
  if (auto *stack = dynamic_cast<celestrian::StackNode *>(focused_node)) {
    return stack->isAnyChildRecording();
  }
  return false;
}
