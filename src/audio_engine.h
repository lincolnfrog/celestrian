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
  /**
   * Toggles global audio playback.
   */
  void togglePlayback();

  /**
   * Returns true if the transport is currently running.
   */
  bool isPlaying() const { return is_playing_global; }

  // Node Recording
  /**
   * Enables recording mode for a specific clip node.
   */
  void startRecordingInNode(const juce::String &uuid);

  /**
   * Disables recording mode for a specific clip node.
   */
  void stopRecordingInNode(const juce::String &uuid);

  // State API
  /**
   * Returns a JSON-compatible representation of the entire audio graph.
   */
  juce::var getGraphState() const;

  /**
   * Returns peak data for the specified node.
   */
  juce::var getWaveform(const juce::String &uuid, int num_peaks) const;

  // Navigation API
  /**
   * Moves the user focus into a sub-box.
   */
  void enterBox(const juce::String &uuid);

  /**
   * Returns the focus to the parent box.
   */
  void exitBox();

  /**
   * Creates a new node of the specified type in the current box.
   */
  void createNode(const juce::String &type, double x = -1.0, double y = -1.0);

  /**
   * Renames a specific node.
   */
  void renameNode(const juce::String &uuid, const juce::String &new_name);

  /**
   * Returns a list of available hardware audio inputs.
   */
  juce::var getInputList() const;

  /**
   * Sets the input channel index for a specific node.
   */
  void setNodeInput(const juce::String &uuid, int channel_index);

  /**
   * Sets the non-destructive loop points for a specific node.
   */
  void setLoopPoints(const juce::String &uuid, int64_t start, int64_t end);

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
  celestrian::AudioNode *findNodeByUuid(celestrian::AudioNode *node,
                                        const juce::String &uuid);

  juce::AudioDeviceManager device_manager;

  // The root of the hierarchical audio graph
  std::unique_ptr<celestrian::AudioNode> root_node;

  // Navigation focus items
  celestrian::AudioNode *focused_node = nullptr;
  std::vector<celestrian::AudioNode *> navigation_stack;

  // Global Transport
  std::atomic<bool> is_playing_global{false};
  std::atomic<int64_t> global_transport_pos{0};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
