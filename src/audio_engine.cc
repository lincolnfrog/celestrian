#include "audio_engine.h"
#include "box_node.h"
#include "clip_node.h"
#include <juce_audio_basics/juce_audio_basics.h>

AudioEngine::AudioEngine() {
  init(1, 2);

  // Start with an empty root box
  root_node = std::make_unique<celestrian::BoxNode>("SessionRoot");
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

celestrian::ClipNode *AudioEngine::get_clip_by_uuid(celestrian::AudioNode *node,
                                                    const juce::String &uuid) {
  if (node->getUuid() == uuid)
    return dynamic_cast<celestrian::ClipNode *>(node);

  if (auto *box = dynamic_cast<celestrian::BoxNode *>(node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      if (auto *found = get_clip_by_uuid(box->getChild(i), uuid))
        return found;
    }
  }
  return nullptr;
}

void AudioEngine::start_recording_in_node(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);
  if (auto *clip = get_clip_by_uuid(root_node.get(), uuid)) {
    juce::Logger::writeToLog("AudioEngine: Found clip, starting recording.");
    // If this is the FIRST clip in the current focused box, it will set the
    // quantum We'll handle that when recording STOPS.
    clip->startRecording();
  } else {
    juce::Logger::writeToLog("AudioEngine: CLIP NOT FOUND for " + uuid);
  }
}

void AudioEngine::stop_recording_in_node(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  if (auto *clip = get_clip_by_uuid(root_node.get(), uuid)) {
    clip->stopRecording();

    // Quantum Propagation logic:
    // If the box has no quantum yet, this clip sets it.
    if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
      if (box->get_primary_quantum() == 0) {
        // We'll wait for the clip to actually stop (it might be magnetic)
        // For now, let's assume it stops and sets the box quantum.
        // A more robust way would be a callback from ClipNode to BoxNode.
        // Simplified: Box checks its children for the first one with duration >
        // 0.
      }
    }
  }
}

void AudioEngine::toggle_playback() {
  is_playing_global = !is_playing_global;
  if (!is_playing_global) {
    global_transport_pos = 0;
  }
}

juce::var AudioEngine::get_graph_state() const {
  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  state->setProperty("is_playing", is_playing_global);
  state->setProperty("focused_id", focused_node ? focused_node->getUuid() : "");

  juce::Array<juce::var> children;
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      children.add(box->getChild(i)->getMetadata());
    }
  }
  state->setProperty("nodes", children);
  return juce::var(state.get());
}

static celestrian::AudioNode *find_node_by_uuid(celestrian::AudioNode *node,
                                                const juce::String &uuid) {
  if (node->getUuid() == uuid)
    return node;
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      if (auto *found = find_node_by_uuid(box->getChild(i), uuid))
        return found;
    }
  }
  return nullptr;
}

juce::var AudioEngine::get_waveform(const juce::String &uuid,
                                    int num_peaks) const {
  if (auto *node = find_node_by_uuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- Navigation ---

void AudioEngine::enter_box(const juce::String &uuid) {
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      auto *child = box->getChild(i);
      if (child->getUuid() == uuid &&
          dynamic_cast<celestrian::BoxNode *>(child)) {
        navigation_stack.push_back(focused_node);
        focused_node = child;
        return;
      }
    }
  }
}

void AudioEngine::exit_box() {
  if (!navigation_stack.empty()) {
    focused_node = navigation_stack.back();
    navigation_stack.pop_back();
  }
}

void AudioEngine::create_node(const juce::String &type) {
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
    std::unique_ptr<celestrian::AudioNode> new_node;
    if (type == "clip") {
      new_node = std::make_unique<celestrian::ClipNode>("New Clip", 44100.0);
    } else {
      new_node = std::make_unique<celestrian::BoxNode>("New Box");
    }

    new_node->x_pos = 120.0;
    new_node->y_pos = box->getNumChildren() * 70.0;
    box->addChild(std::move(new_node));
  }
}

void AudioEngine::rename_node(const juce::String &uuid,
                              const juce::String &new_name) {
  if (auto *node = find_node_by_uuid(root_node.get(), uuid)) {
    node->set_name(new_name);
  }
}

juce::var AudioEngine::get_input_list() const {
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

void AudioEngine::set_node_input(const juce::String &uuid, int channel_index) {
  if (auto *clip = get_clip_by_uuid(root_node.get(), uuid)) {
    clip->setInputChannel(channel_index);
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
    pc.is_recording = true; // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;

    static int log_count = 0;
    if (++log_count % 100 == 0) {
      juce::Logger::writeToLog(
          "AudioEngine: Processing " + juce::String(num_samples) +
          " samples, Inputs: " + juce::String(num_input_channels));
    }

    // Update Global Quantum Propagation:
    // If focused box has no quantum, check if its children have a finished
    // recording.
    if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
      if (box->get_primary_quantum() == 0) {
        for (int i = 0; i < box->getNumChildren(); ++i) {
          if (box->getChild(i)->duration_samples > 0) {
            box->set_primary_quantum(box->getChild(i)->duration_samples);
            // Tell other clips about this quantum
            for (int j = 0; j < box->getNumChildren(); ++j) {
              if (auto *clip =
                      dynamic_cast<celestrian::ClipNode *>(box->getChild(j)))
                clip->primary_quantum_samples = box->get_primary_quantum();
            }
            break;
          }
        }
      }
    }

    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    if (is_playing_global) {
      global_transport_pos += num_samples;
    }
  }
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {}
void AudioEngine::audioDeviceStopped() {}
