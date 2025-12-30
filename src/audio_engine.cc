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

celestrian::ClipNode *AudioEngine::getClipByUuid(celestrian::AudioNode *node,
                                                 const juce::String &uuid) {
  if (node->getUuid() == uuid)
    return dynamic_cast<celestrian::ClipNode *>(node);

  if (auto *box = dynamic_cast<celestrian::BoxNode *>(node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      if (auto *found = getClipByUuid(box->getChild(i), uuid))
        return found;
    }
  }
  return nullptr;
}

void AudioEngine::startRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: start_recording requested for " +
                           uuid);
  if (auto *clip = getClipByUuid(root_node.get(), uuid)) {
    juce::Logger::writeToLog("AudioEngine: Found clip, starting recording.");
    // If this is the FIRST clip in the current focused box, it will set the
    // quantum We'll handle that when recording STOPS.
    clip->startRecording();
  } else {
    juce::Logger::writeToLog("AudioEngine: CLIP NOT FOUND for " + uuid);
  }
}

void AudioEngine::stopRecordingInNode(const juce::String &uuid) {
  juce::Logger::writeToLog("AudioEngine: stop_recording requested for " + uuid);
  if (auto *clip = getClipByUuid(root_node.get(), uuid)) {
    // Quantum aligned stopping is handled inside ClipNode::stopRecording()
    // based on the derived/effective quantum.
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
    obj->setProperty("focusedId", focused_node->getUuid());
    return metadata;
  }

  juce::DynamicObject::Ptr state = new juce::DynamicObject();
  state->setProperty("isPlaying", (bool)is_playing_global.load());
  state->setProperty("nodes", juce::Array<juce::var>());
  return juce::var(state.get());
}

static celestrian::AudioNode *findNodeByUuid(celestrian::AudioNode *node,
                                             const juce::String &uuid) {
  if (node->getUuid() == uuid)
    return node;
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(node)) {
    for (int i = 0; i < box->getNumChildren(); ++i) {
      if (auto *found = findNodeByUuid(box->getChild(i), uuid))
        return found;
    }
  }
  return nullptr;
}

juce::var AudioEngine::getWaveform(const juce::String &uuid,
                                   int num_peaks) const {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    return node->getWaveform(num_peaks);
  }
  return juce::Array<juce::var>();
}

// --- Navigation ---

void AudioEngine::enterBox(const juce::String &uuid) {
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

void AudioEngine::exitBox() {
  if (!navigation_stack.empty()) {
    focused_node = navigation_stack.back();
    navigation_stack.pop_back();
  }
}

void AudioEngine::createNode(const juce::String &type) {
  if (auto *box = dynamic_cast<celestrian::BoxNode *>(focused_node)) {
    std::unique_ptr<celestrian::AudioNode> new_node;
    if (type == "clip") {
      new_node = std::make_unique<celestrian::ClipNode>("New Clip", 44100.0);
    } else {
      new_node = std::make_unique<celestrian::BoxNode>("New Box");
    }

    new_node->setParent(box);
    new_node->x_pos = 120.0;
    new_node->y_pos = box->getNumChildren() * 70.0;
    box->addChild(std::move(new_node));
  }
}

void AudioEngine::renameNode(const juce::String &uuid,
                             const juce::String &new_name) {
  if (auto *node = findNodeByUuid(root_node.get(), uuid)) {
    node->setName(new_name);
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
  if (auto *clip = getClipByUuid(root_node.get(), uuid)) {
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
    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    if (is_playing_global.load()) {
      global_transport_pos += num_samples;
    }
  }
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {}
void AudioEngine::audioDeviceStopped() {}
