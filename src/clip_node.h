#pragma once

#include "audio_node.h"
#include <juce_audio_basics/juce_audio_basics.h>

namespace celestrian {

/**
 * A leaf node representing a single audio recording.
 * Handles storage, playback, and slicing logic.
 */
class ClipNode : public AudioNode {
public:
  ClipNode(juce::String name, double source_sample_rate = 44100.0);
  ~ClipNode() override = default;

  // AudioNode implementation
  /**
   * Processes the audio buffer for recording or playback.
   */
  void process(const float *const *input_channels,
               float *const *output_channels, int num_input_channels,
               int num_output_channels, const ProcessContext &context) override;

  /**
   * Overrides GetWaveform to return peak data from the internal buffer.
   */
  juce::var getWaveform(int num_peaks) const override;

  /**
   * Returns NodeType::Clip.
   */
  NodeType getNodeType() const override { return NodeType::Clip; }

  /**
   * Returns clip-specific metadata (sample rate, etc.).
   */
  juce::var getMetadata() const override;

  /**
   * Assigns the preferred hardware input channel for this clip.
   */
  void setInputChannel(int index) { preferred_input_channel = index; }
  // Clip-specific methods
  /**
   * Starts capturing hardware input into the internal buffer.
   */
  void startRecording();

  /**
   * Signals the recording thread to stop and flush the buffer.
   */
  void stopRecording();

  /**
   * Starts audio playback from the current read position.
   */
  void startPlayback();

  /**
   * Stops audio playback.
   */
  void stopPlayback();

  bool isRecording() const { return is_recording; }
  bool isPlaying() const { return is_playing; }

  /**
   * Returns the total recorded sample count in the buffer.
   */
  int getNumSamples() const { return buffer.getNumSamples(); }

  /**
   * Returns the atomic write position for the recording process.
   */
  int getWritePos() const { return write_pos.load(); }

  /**
   * Returns the latest peak sample level captured by the process loop.
   */
  float getCurrentPeak() const override { return last_block_peak.load(); }

  int64_t primary_quantum_samples = 0;

private:
  juce::AudioBuffer<float> buffer;

  std::atomic<int> write_pos{0};
  std::atomic<int> read_pos{0};

  std::atomic<bool> is_recording{false};
  std::atomic<bool> is_awaiting_stop{false};
  std::atomic<bool> is_playing{false};

  double sample_rate;
  std::atomic<float> current_max_peak{0.0f};
  std::atomic<float> last_block_peak{0.0f};

  int preferred_input_channel = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

} // namespace celestrian
