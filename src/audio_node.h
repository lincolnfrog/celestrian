#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

namespace celestrian {

/**
 * Context for audio processing, passed down the recursive graph.
 */
struct ProcessContext {
  double sample_rate = 44100.0;
  int num_samples = 0;
  bool is_playing = false;
  bool is_recording = false;

  // Global transport master position (in samples)
  int64_t master_pos = 0;
};

/**
 * Enumeration of available node types in the Celestrian ecosystem.
 */
enum class NodeType { Clip, Box, Unknown };

/**
 * Interface for all audio-producing or processing nodes in the Celestrian
 * graph.
 */
class AudioNode {
public:
  AudioNode(juce::String node_name)
      : node_name(std::move(node_name)), node_uuid(juce::Uuid().toString()) {}
  virtual ~AudioNode() = default;

  /**
   * Processes audio into the provided output channels or captures from input.
   * @param input_channels Pointer to input samples.
   * @param output_channels Pointer to output samples to be filled.
   * @param num_input_channels Number of available hardware input channels.
   * @param num_output_channels Number of hardware output channels.
   * @param context Current processing context (sample rate, transport, etc.).
   */
  virtual void process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels,
                       const ProcessContext &context) = 0;

  /**
   * Generates waveform peaks for visualization.
   * @param num_peaks The number of peak samples to return.
   */
  virtual juce::var getWaveform(int num_peaks) const = 0;

  /**
   * Returns a JSON object containing node metadata for UI rendering.
   */
  virtual juce::var getMetadata() const {
    auto *obj = new juce::DynamicObject();
    obj->setProperty("id", node_uuid);
    obj->setProperty("name", node_name);
    obj->setProperty("type", getNodeTypeString());
    obj->setProperty("x", x_pos);
    obj->setProperty("y", y_pos);
    obj->setProperty("w", width);
    obj->setProperty("h", height);
    obj->setProperty("playhead", playhead_pos);
    obj->setProperty("duration", duration_samples);
    obj->setProperty("isRecording", is_node_recording);
    obj->setProperty("currentPeak", getCurrentPeak());
    return juce::var(obj);
  }

  virtual juce::String getName() const { return node_name; }
  virtual void setName(const juce::String &new_name) { node_name = new_name; }

  virtual juce::String getUuid() const { return node_uuid; }
  virtual NodeType getNodeType() const = 0;

  virtual juce::String getNodeTypeString() const {
    switch (getNodeType()) {
    case NodeType::Clip:
      return "clip";
    case NodeType::Box:
      return "box";
    default:
      return "unknown";
    }
  }

  /**
   * Returns the latest peak sample level for real-time visualization.
   */
  virtual float getCurrentPeak() const { return 0.0f; }

  // Spatial arrangement in the parent stack/plane
  double x_pos = 0.0, y_pos = 0.0;
  double width = 200.0, height = 100.0;

  // Transport state
  double playhead_pos = 0.0;    // 0.0 to 1.0 (normalized)
  int64_t duration_samples = 0; // Length of the loop
  bool is_node_recording = false;

protected:
  juce::String node_name;
  juce::String node_uuid;
};

} // namespace celestrian
