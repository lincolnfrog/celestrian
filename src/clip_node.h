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
  ClipNode(juce::String name, double sourceSampleRate = 44100.0);
  ~ClipNode() override = default;

  // AudioNode implementation
  void process(const float *const *inputChannels, float *const *outputChannels,
               int numInputChannels, int numOutputChannels,
               const ProcessContext &context) override;

  juce::var getWaveform(int numPeaks) const override;
  juce::String getNodeType() const override { return "clip"; }
  juce::var getMetadata() const override;

  void setInputChannel(int index) { preferred_input_channel = index; }
  // Clip-specific methods
  void startRecording();
  void stopRecording();

  void startPlayback();
  void stopPlayback();

  bool isRecording() const { return is_recording; }
  bool isPlaying() const { return is_playing; }

  int getNumSamples() const { return buffer.getNumSamples(); }
  int getWritePos() const { return write_pos.load(); }

  float get_current_peak() const override { return last_block_peak.load(); }

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
