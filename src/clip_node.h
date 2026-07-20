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
  /**
   * The recording lifecycle (kernel.md §3 — the last piece of P0-4):
   * ONE explicit state replaces the old five-boolean encoding, so
   * illegal flag combinations are unrepresentable.
   *
   *   Idle ──startRecording()──▶ Armed ──target reached──▶ Capturing
   *    ▲          (msg thread)     │        (audio thread)     │
   *    │◀── stopRecording() = cancel                           │
   *    │                                stopRecording(), Q>0 ──┤
   *    │◀── commit ─── PendingStop ◀── (boundary computed on   │
   *    │               (audio thread)   the audio thread — D2) │
   *    └◀────────── commit (immediate: Q==0 first clip) ◀──────┘
   *
   * "Committed" is Idle-with-content. While Armed, the arm decision
   * re-evaluates every block — deliberate: the latency-compensated
   * clock must be able to land back on a boundary the raw clock has
   * already passed. Transitions: message thread arms/cancels/requests
   * stop; the audio thread starts capture, picks stop boundaries, and
   * commits. Every field is atomic; each state's parameters
   * (awaiting_start_at / awaiting_stop_at) are written before the state
   * flips.
   */
  enum class RecState : int { Idle = 0, Armed, Capturing, PendingStop };

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
  int getInputChannel() const { return preferred_input_channel; }
  double getSampleRate() const { return sample_rate; }
  /** The take's heard frame (contextCycle) — a recorded fact that must
   * persist (session_io); 0 for the first take. */
  int64_t contextCycle() const { return take_context_cycle_.load(); }
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

  RecState recState() const { return (RecState)rec_state_.load(); }
  bool isRecording() const override {
    const RecState s = recState();
    return s == RecState::Capturing || s == RecState::PendingStop;
  }
  bool isArmedOrRecording() const override {
    return recState() != RecState::Idle;
  }
  bool isPlaying() const { return is_playing.load(); }
  bool isPendingStart() const { return recState() == RecState::Armed; }
  bool isAwaitingStop() const {
    // True from the moment the user asked to stop (stop_requested_ is
    // the one-block bridge until the audio thread picks the boundary).
    return recState() == RecState::PendingStop ||
           (recState() == RecState::Capturing && stop_requested_.load());
  }
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

  /** Commit the take. `ctx` is present on the audio-thread path (from
   * process) and carries the island facts + snapshot; null on the
   * message-thread first-clip immediate stop (parent walks are fine
   * there). */
  void commitRecording(int64_t final_duration = -1,
                       const ProcessContext *ctx = nullptr);
  const juce::AudioBuffer<float> &getAudioBuffer() const { return buffer; }

  // --- Q13 lock-collapse (owner ruling 2026-07-19) ---
  /** Where this clip's committed content begins inside the storage
   * buffer. 0 for every normally-recorded take; a lock-collapse shifts
   * it to the trimmed window's start. Content coordinates (loop points,
   * playback phase, waveform, save) stay 0-based — the base is a pure
   * storage detail, so nothing downstream ever sees the dead air. */
  int64_t getContentBase() const { return content_base_.load(); }
  /** Collapse the committed content to its window [shift, shift+len):
   * the trimmed region BECOMES the take — content base and origin move
   * by `shift`, duration := len, window consumed (full-span). The take
   * now reads as performed exactly; the cut material stays in the
   * buffer, unreachable except by uncollapse (undo). Message thread;
   * all-atomic (same exposure discipline as setLoopPoints). */
  void collapseToWindow(int64_t shift, int64_t len) {
    content_base_.store(content_base_.load() + shift);
    origin_samples.store(origin_samples.load() + shift);
    duration_samples.store(len);
    setLoopPoints(0, len);
  }
  /** Inverse of collapseToWindow: restore the pre-collapse buffer view
   * and the trim (window [shift, shift + current duration)). */
  void uncollapseFromWindow(int64_t shift, int64_t old_duration) {
    const int64_t len = duration_samples.load();
    content_base_.store(content_base_.load() - shift);
    origin_samples.store(origin_samples.load() - shift);
    duration_samples.store(old_duration);
    setLoopPoints(shift, shift + len);
  }

  /**
   * Restore a committed take on session load (session_io): copies `audio`
   * into the buffer, marks it playable, and sets the recorded facts that
   * are not public atomics (write position, contextCycle). The caller
   * sets origin/duration/loop points/mute separately (public). Message
   * thread only — the node is not yet in the live graph.
   */
  void loadCommitted(const juce::AudioBuffer<float> &audio,
                     int64_t context_cycle) {
    const int n = std::min(audio.getNumSamples(), buffer.getNumSamples());
    buffer.clear();
    if (n > 0 && audio.getNumChannels() > 0)
      buffer.copyFrom(0, 0, audio, 0, 0, n);
    write_position.store(n);
    take_context_cycle_.store(context_cycle);
    rec_state_.store((int)RecState::Idle);
    is_playing.store(true);  // committed clips sound
  }

 private:
  juce::AudioBuffer<float> buffer;

  // Mono scratch for the effect rack: playback renders here, the rack
  // processes in place, then the result sums into the parent. Sized in
  // the constructor; grows only if the device block exceeds it (rare —
  // the StackNode::mix_buffer precedent). Audio-thread only.
  std::vector<float> fx_scratch_;

  std::atomic<int> write_position{0};
  std::atomic<int> read_position{0};

  // Q13 lock-collapse: storage offset of the committed content (see
  // getContentBase). Playback/waveform/save add it; capture never does
  // (recording clips always have base 0).
  std::atomic<int64_t> content_base_{0};

  // Pre-record capture window (docs/performance.md §3). When the engine
  // provides a pre-record ring, capture no longer copies "whatever input
  // arrived after recording started" — it copies the input that *arrived*
  // at the times the clip semantically covers: clip position p holds the
  // input sample that arrived at input-clock (window start + p), where the
  // window start maps the trigger through the latency compensation.
  // Audio-thread only.
  int64_t capture_next_clock_ = 0;
  bool capture_uses_ring_ = false;

  /** Armed-state evaluation (audio thread, once per block). */
  void armEvaluate(const ProcessContext &context);
  /** Armed → Capturing: fixes the capture window for `target`. */
  void beginCapture(const ProcessContext &context, int64_t target,
                    int64_t compensated_pos);

  std::atomic<int> rec_state_{(int)RecState::Idle};
  // Message-thread stop request; consumed by the audio thread, which
  // computes the boundary from its own write position (D2 fix).
  std::atomic<bool> stop_requested_{false};
  std::atomic<bool> is_playing{false};

  std::atomic<int64_t> awaiting_start_at{
      0};  // Armed: the chosen arm target (0 = none yet)
  std::atomic<int64_t> awaiting_stop_at{0};  // PendingStop: commit boundary
  // The committed island cycle this take was performed against (its
  // heard frame; 0 for the first take). Set at capture start, kept
  // after commit — published as `contextCycle` for display take-marking.
  std::atomic<int64_t> take_context_cycle_{0};
  std::atomic<int64_t> commit_master_pos{
      0};  // Master pos when recording commits

  double sample_rate;
  std::atomic<float> current_max_peak{0.0f};

  int preferred_input_channel = 0;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

}  // namespace celestrian
