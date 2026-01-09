#include "audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include "clip_node.h"
#include "stack_node.h"

AudioEngine::AudioEngine() {
  init(1, 2);

  // Start with an empty root stack
  root_node = std::make_unique<celestrian::StackNode>("SessionRoot");
  focused_node = root_node.get();
}

AudioEngine::~AudioEngine() { device_manager.removeAudioCallback(this); }

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

    // INITIAL RECORDING RESET:
    // If we are starting a recording and there is NO existing quantum
    // (i.e., this is the First Clip), we reset the global transport to 0.
    // This ensures the first clip defines "Time Zero" and has no offset.
    if (root_node->getEffectiveQuantum() == 0) {
      global_transport_pos.store(0);
      juce::Logger::writeToLog(
          "AudioEngine: First Clip detected -> Reset Global Transport to 0.");
    }

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
  is_playing_global = !is_playing_global.load();
  if (!is_playing_global.load()) {
    global_transport_pos = 0;
  }
}

juce::var AudioEngine::getGraphState() const {
  if (focused_node) {
    auto metadata = focused_node->getMetadata();
    auto *obj = metadata.getDynamicObject();
    obj->setProperty("isPlaying", (bool)is_playing_global.load());
    obj->setProperty("masterPos", (double)global_transport_pos.load());
    obj->setProperty("soloedId", soloed_node_uuid);
    obj->setProperty("focusedId", focused_node->getUuid());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  state->setProperty("isPlaying", (bool)is_playing_global.load());
  state->setProperty("masterPos", (double)global_transport_pos.load());
  state->setProperty("soloedId", soloed_node_uuid);
  state->setProperty("nodes", juce::Array<juce::var>());
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
    node->is_expanded.store(!currentState);
    juce::Logger::writeToLog(
        "AudioEngine: Toggled expand for " + uuid + " (New State: " +
        juce::String(!currentState ? "expanded" : "collapsed") + ")");
  }
}

void AudioEngine::createNode(const juce::String &type, double x, double y,
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
    new_node = std::make_unique<celestrian::ClipNode>("New Clip", 44100.0);
  } else if (type == "stack") {
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  } else {
    // Fallback for any legacy "box" calls
    new_node = std::make_unique<celestrian::StackNode>("New Stack");
  }

  new_node->setParent(target_stack);
  if (x >= 0 && y >= 0) {
    new_node->x_pos = x;
    new_node->y_pos = y;
  } else {
    new_node->x_pos = 0.0;  // Default to Time 0
    new_node->y_pos =
        target_stack->getNumChildren() * 120.0;  // 120px per clip row
  }
  target_stack->addChild(std::move(new_node));
}

void AudioEngine::renameNode(const juce::String &uuid,
                             const juce::String &new_name) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->setName(new_name);
  }
}

void AudioEngine::moveNode(const juce::String &node_uuid,
                           const juce::String &new_parent_uuid, double new_y) {
  // Find the node to move
  auto *node = findNodeByUuid(root_node.get(), node_uuid);
  if (!node) {
    juce::Logger::writeToLog("moveNode: Node not found: " + node_uuid);
    return;
  }

  // Find the new parent stack
  auto *new_parent = findNodeByUuid(root_node.get(), new_parent_uuid);
  auto *new_parent_stack = dynamic_cast<celestrian::StackNode *>(new_parent);
  if (!new_parent_stack) {
    juce::Logger::writeToLog("moveNode: Invalid parent: " + new_parent_uuid);
    return;
  }

  // Get current parent
  auto *old_parent = node->getParent();
  auto *old_parent_stack = dynamic_cast<celestrian::StackNode *>(old_parent);

  // Remove from old parent
  if (old_parent_stack) {
    for (int i = 0; i < old_parent_stack->getNumChildren(); ++i) {
      if (old_parent_stack->getChild(i) == node) {
        auto owned_node = old_parent_stack->removeChild(i);

        // Update position and parent
        owned_node->y_pos = new_y;
        owned_node->setParent(new_parent_stack);

        // Add to new parent
        new_parent_stack->addChild(std::move(owned_node));
        return;
      }
    }
  }
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

void AudioEngine::setLoopPoints(const juce::String &uuid, int64_t start,
                                int64_t end) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->setLoopPoints(start, end);
  }
}
void AudioEngine::audioDeviceIOCallbackWithContext(
    const float *const *input_channel_data, int num_input_channels,
    float *const *output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext &context) {
  for (int i = 0; i < num_output_channels; ++i) {
    if (output_channel_data[i] != nullptr)
      juce::FloatVectorOperations::clear(output_channel_data[i], num_samples);
  }

  if (root_node) {
    celestrian::ProcessContext pc;
    pc.sample_rate = 44100.0;
    pc.num_samples = num_samples;
    pc.is_playing = is_playing_global;
    pc.is_recording = true;  // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;
    if (auto *device = device_manager.getCurrentAudioDevice()) {
      pc.input_latency = device->getInputLatencyInSamples();
      pc.output_latency = device->getOutputLatencyInSamples();
    }
    pc.solo_node_uuid = soloed_node_uuid;

    static int log_count = 0;
    if (++log_count % 100 == 0) {
      juce::Logger::writeToLog(
          "AudioEngine: Processing " + juce::String(num_samples) +
          " samples, Inputs: " + juce::String(num_input_channels));
    }

    // Update Global Quantum Propagation:
    // If focused box has no quantum, check if its children have a finished
    // recording.
    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    if (is_playing_global.load()) {
      int64_t old_pos = global_transport_pos.load();
      int64_t new_pos = old_pos + num_samples;

      bool is_recording = isAnyNodeRecording();

      // Before updating state, capture the current recording duration
      // (needed for transport continuity when recording ends)
      if (was_any_node_recording_ && !is_recording) {
        // Recording just finished - capture the duration of the just-finished
        // clip This is the newest clip's duration (it was just committed)
        if (auto *stack = dynamic_cast<celestrian::StackNode *>(focused_node)) {
          int64_t max_dur = 0;
          for (int i = 0; i < stack->getNumChildren(); ++i) {
            int64_t dur = stack->getChild(i)->getIntrinsicDuration();
            if (dur > max_dur) max_dur = dur;
          }
          // The just-finished recording's duration is the difference from old
          // LCM Actually, simpler: it's the position in the old LCM cycle
          last_recording_duration_ =
              old_pos %
              (lcm_before_recording_ > 0 ? lcm_before_recording_ : max_dur);
        }
      }

      bool just_started_recording = is_recording && !was_any_node_recording_;
      bool just_finished_recording = was_any_node_recording_ && !is_recording;
      was_any_node_recording_ = is_recording;

      // Store LCM when recording starts (before the new clip is added)
      if (just_started_recording) {
        lcm_before_recording_ = calculateTimelineLength();
      }

      // Only wrap at LCM boundary when NOT recording
      if (!is_recording) {
        int64_t timeline_length = calculateTimelineLength();
        if (timeline_length > 0) {
          // Check for polyrhythmic expansion (e.g. 3Q clip added to 4Q context
          // -> 12Q) If any clip's duration is NOT a multiple of the OLD LCM, we
          // have a polyrhythmic expansion where the cycle length increased
          // drastically. In this case, we MUST NOT snap, because the transport
          // is likely mid-cycle in the new, longer timeline.
          bool is_polyrhythmic_expansion = false;
          if (lcm_before_recording_ > 0) {
            if (auto *stack =
                    dynamic_cast<celestrian::StackNode *>(focused_node)) {
              for (int i = 0; i < stack->getNumChildren(); ++i) {
                int64_t dur = stack->getChild(i)->getIntrinsicDuration();
                if (dur > 0 && dur % lcm_before_recording_ != 0) {
                  is_polyrhythmic_expansion = true;
                  break;
                }
              }
            }
          }

          // When recording JUST ENDED and LCM GREW, snap to align transport
          // BUT only if:
          // 1. It's a simple extension (not polyrhythmic)
          // 2. Transport overshot the new LCM (for safety, though polyrhythm
          // check covers most cases)
          if (just_finished_recording &&
              timeline_length > lcm_before_recording_ &&
              !is_polyrhythmic_expansion && old_pos >= timeline_length) {
            int64_t lcm_index =
                (old_pos + timeline_length / 2) / timeline_length;
            int64_t snapped_pos =
                (lcm_index * timeline_length) % timeline_length;
            juce::Logger::writeToLog(
                "LCM SNAP: pos=" + juce::String(old_pos) + " → boundary " +
                juce::String(lcm_index * timeline_length) + " → " +
                juce::String(snapped_pos) +
                " (LCM grew: " + juce::String(lcm_before_recording_) + " → " +
                juce::String(timeline_length) + ")");
            old_pos = snapped_pos;
            new_pos = old_pos + num_samples;
          }
          // Polyrhythmic expansion: snap to the recording's final position
          // This ensures the cursor continues smoothly from where it was during
          // recording
          else if (just_finished_recording && is_polyrhythmic_expansion) {
            juce::Logger::writeToLog(
                "POLYRHYTHM SNAP: pos=" + juce::String(old_pos) +
                " → recording_dur " + juce::String(last_recording_duration_) +
                " (LCM grew: " + juce::String(lcm_before_recording_) + " → " +
                juce::String(timeline_length) + ")");
            new_pos = last_recording_duration_ + num_samples;
          }
          // FIRST CLIP FIX: When the first clip finishes recording, snap to 0
          // so playback starts from the beginning of the clip.
          // This happens when lcm_before_recording was just the default quantum
          // (no real clips existed yet).
          else if (just_finished_recording && lcm_before_recording_ > 0 &&
                   lcm_before_recording_ < timeline_length && old_pos > 0 &&
                   old_pos < timeline_length) {
            // Check if this is a "first clip" scenario: the old timeline was
            // just the default quantum, not from real clips
            bool is_first_clip = true;
            if (auto *stack =
                    dynamic_cast<celestrian::StackNode *>(focused_node)) {
              // Count clips with duration > 0 (finished recording)
              int clip_count = 0;
              for (int i = 0; i < stack->getNumChildren(); ++i) {
                if (stack->getChild(i)->getIntrinsicDuration() > 0) {
                  clip_count++;
                }
              }
              // More than 1 finished clip means we're NOT in first-clip
              // scenario
              is_first_clip = (clip_count <= 1);
            }

            if (is_first_clip) {
              juce::Logger::writeToLog(
                  "FIRST CLIP SNAP: pos=" + juce::String(old_pos) +
                  " → 0 (first clip finished, start from beginning)");
              new_pos = num_samples;  // Start from 0 + this block's samples
            }
          }

          // Normal wrap at LCM boundary
          new_pos = new_pos % timeline_length;
        }
      }
      global_transport_pos.store(new_pos);
    }
  }
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {}
void AudioEngine::audioDeviceStopped() {}

void AudioEngine::toggleSolo(const juce::String &uuid) {
  if (soloed_node_uuid == uuid) {
    soloed_node_uuid = "";  // Unsolo
  } else {
    soloed_node_uuid = uuid;  // New solo
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
int64_t gcd(int64_t a, int64_t b) {
  while (b != 0) {
    int64_t t = b;
    b = a % b;
    a = t;
  }
  return a;
}

int64_t lcm(int64_t a, int64_t b) {
  if (a == 0 || b == 0) return std::max(a, b);
  return (a / gcd(a, b)) * b;
}
}  // namespace

int64_t AudioEngine::calculateTimelineLength() const {
  if (!focused_node) {
    return 44100;  // Default 1 second at 44.1kHz
  }

  int64_t quantum = focused_node->getEffectiveQuantum();
  if (quantum <= 0) quantum = 44100;

  // Recursive helper to compute LCM across all clips, even nested in stacks
  std::function<int64_t(celestrian::AudioNode *, int64_t)> computeLCM =
      [&computeLCM](celestrian::AudioNode *node,
                    int64_t current_lcm) -> int64_t {
    if (auto *stack = dynamic_cast<celestrian::StackNode *>(node)) {
      // Recursively process children of this stack
      for (int i = 0; i < stack->getNumChildren(); ++i) {
        auto *child = stack->getChild(i);
        current_lcm = computeLCM(child, current_lcm);
      }
    } else {
      // It's a clip - use its duration for LCM
      int64_t dur = node->getIntrinsicDuration();
      if (dur > 0) {
        current_lcm = lcm(current_lcm, dur);
      }
    }
    return current_lcm;
  };

  int64_t result = computeLCM(focused_node, quantum);

  return result;
}

bool AudioEngine::isAnyNodeRecording() const {
  if (!focused_node) return false;

  if (auto *stack = dynamic_cast<celestrian::StackNode *>(focused_node)) {
    for (int i = 0; i < stack->getNumChildren(); ++i) {
      auto *child = stack->getChild(i);
      if (child->is_node_recording.load()) {
        return true;
      }
    }
  }
  return false;
}
