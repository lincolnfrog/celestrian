#pragma once

#include "audio_node.h"
#include "clip_node.h"
#include <juce_audio_devices/juce_audio_devices.h>
#include <memory>
#include <vector>

class AudioEngine : public juce::AudioIODeviceCallback {
public:
  AudioEngine();
  ~AudioEngine() override;

  // Global Transport
  void toggle_playback();
  bool is_playing() const { return is_playing_global; }

  // Node Recording
  void start_recording_in_node(const juce::String &uuid);
  void stop_recording_in_node(const juce::String &uuid);

  // State API
  juce::var get_graph_state() const;
  juce::var get_waveform(const juce::String &uuid, int num_peaks) const;

  // Navigation API
  void enter_box(const juce::String &uuid);
  void exit_box();
  void create_node(const juce::String &type);
  void rename_node(const juce::String &uuid, const juce::String &new_name);

  juce::var get_input_list() const;
  void set_node_input(const juce::String &uuid, int channel_index);

  // AudioIODeviceCallback methods
  void audioDeviceIOCallbackWithContext(
      const float *const *input_channel_data, int num_input_channels,
      float *const *output_channel_data, int num_output_channels,
      int num_samples,
      const juce::AudioIODeviceCallbackContext &context) override;

  void audioDeviceAboutToStart(juce::AudioIODevice *device) override;
  void audioDeviceStopped() override;

private:
  void init(int inputs, int outputs);
  celestrian::ClipNode *get_clip_by_uuid(celestrian::AudioNode *node,
                                         const juce::String &uuid);

  juce::AudioDeviceManager device_manager;

  // The root of the hierarchical audio graph
  std::unique_ptr<celestrian::AudioNode> root_node;

  // Navigation focus items
  celestrian::AudioNode *focused_node = nullptr;
  std::vector<celestrian::AudioNode *> navigation_stack;

  // Global Transport
  bool is_playing_global = false;
  int64_t global_transport_pos = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
