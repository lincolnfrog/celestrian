#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "audio_node.h"

namespace celestrian {

/**
 * A leaf node representing a single audio recording.
 * Handles storage, playback, and slicing logic.
 */
class ClipNode : public AudioNode {
 public:
  // The default rate is a convenience for unit tests; the engine passes
  // the actual device rate when creating clips (P0-5).
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

  int64_t getIntrinsicDuration() const override {
    return duration_samples.load();
  }
  int64_t getEffectiveQuantum() const override;

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

  bool isRecording() const override { return is_recording.load(); }
  bool isPlaying() const { return is_playing.load(); }
  bool isPendingStart() const { return is_pending_start.load(); }
  bool isAwaitingStop() const { return is_awaiting_stop.load(); }
  int64_t getCommitMasterPos() const { return commit_master_pos.load(); }
  int64_t getAwaitingStartAt() const { return awaiting_start_at.load(); }

  /**
   * Returns the total recorded sample count in the buffer.
   */
  int getSampleCount() const { return buffer.getNumSamples(); }

  /**
   * Returns the atomic write position for the recording process.
   */
  int getWritePosition() const { return write_position.load(); }

  /**
   * Returns the latest peak sample level captured by the process loop.
   */
  float getCurrentPeak() const override { return last_block_peak.load(); }

  void commitRecording(int64_t final_duration = -1);
  const juce::AudioBuffer<float> &getAudioBuffer() const { return buffer; }

 private:
  juce::AudioBuffer<float> buffer;

  // Mono scratch for the effect rack: playback renders here, the rack
  // processes in place, then the result sums into the parent. Sized in
  // the constructor; grows only if the device block exceeds it (rare —
  // the StackNode::mix_buffer precedent). Audio-thread only.
  std::vector<float> fx_scratch_;

  std::atomic<int> write_position{0};
  std::atomic<int> read_position{0};

  // Pre-record capture window (docs/performance.md §3). When the engine
  // provides a pre-record ring, capture no longer copies "whatever input
  // arrived after recording started" — it copies the input that *arrived*
  // at the times the clip semantically covers: clip position p holds the
  // input sample that arrived at input-clock (window start + p), where the
  // window start maps the trigger through the latency compensation.
  // Audio-thread only.
  int64_t capture_next_clock_ = 0;
  bool capture_uses_ring_ = false;

  std::atomic<bool> is_recording{false};
  std::atomic<bool> is_pending_start{false};
  std::atomic<bool> is_awaiting_stop{false};
  std::atomic<bool> is_playing{false};

  std::atomic<int64_t> trigger_master_position{0};
  std::atomic<int64_t> awaiting_start_at{
      0};  // When to actually start recording
  std::atomic<int64_t> awaiting_stop_at{0};
  std::atomic<int64_t> commit_master_pos{
      0};  // Master pos when recording commits

  double sample_rate;
  std::atomic<float> current_max_peak{0.0f};

  int preferred_input_channel = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

}  // namespace celestrian
