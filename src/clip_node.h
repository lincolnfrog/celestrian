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

  // AudioNode implementation (§2.3 control/render split)
  /** Decisions + capture: arm targets, stop boundaries, input ingest,
   * commit (with island consequences). */
  void control(const float *const *input_channels, int num_input_channels,
               const ProcessContext &context) override;
  /** The kernel playback equation — pure; see AudioNode::render. */
  void render(float *const *output_channels, int num_output_channels,
              const ProcessContext &context) const override;

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
   *
   * `through_map_commit_cycle` > 0 arms the take THROUGH an enclosing
   * ACTIVE time-map (time_maps.md phase 2): the value is C, the mapping
   * node's full inner cycle — the dense buffer span the take commits at
   * (ruling 2). The engine computes it on the message thread (nearest
   * active-map ancestor's intrinsic duration); 0 = plain recording.
   */
  void startRecording(int64_t through_map_commit_cycle = 0);

  /** The C a through-map arm will commit at; 0 = plain take. */
  int64_t throughMapCommitCycle() const { return map_commit_cycle_.load(); }

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
  int getSampleCount() const { return content_.load()->getNumSamples(); }

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
  const juce::AudioBuffer<float> &getAudioBuffer() const {
    return *content_.load();
  }

  // --- Take content storage (D4: NO recording wall) ---
  // The content buffer is reached through ONE atomic pointer. At ARM it
  // becomes a huge VIRTUAL reservation (address space only — the OS
  // commits physical pages as capture writes them), so a take's memory
  // cost is exactly what it records and the only real limit is the
  // machine. The reservation bound (~6.7 h at 44.1 kHz; juce sample
  // counts are int) exists for integrity, not policy: reaching it
  // auto-finishes CLEANLY at the last boundary that fits (never a
  // silent zombie). After commit the engine COMPACTS: an exact-size
  // copy swaps in atomically (safe under an actively rendering clip)
  // and the old buffer retires through the reclaimer (Step 3 lifetime
  // discipline).
  static constexpr int64_t kMaxTakeSamples = (int64_t{1} << 30);
  int64_t contentCapacity() const { return content_.load()->getNumSamples(); }
  /** Total recorded samples (the full take, ≥ duration after a
   * lock-collapse — compaction must keep it all for uncollapse). */
  int64_t recordedLength() const { return write_position.load(); }
  /** Message thread: swap in a replacement content buffer (compaction).
   * The caller retires the returned old buffer — an in-flight render
   * may still be reading it this block. */
  juce::AudioBuffer<float> *swapContent(
      std::unique_ptr<juce::AudioBuffer<float>> fresh) {
    juce::AudioBuffer<float> *old = content_owned_.release();
    content_owned_ = std::move(fresh);
    content_.store(content_owned_.get());
    return old;
  }
  /** TEST-ONLY: mutable content access (wall-guard simulations). */
  juce::AudioBuffer<float> &contentForTest() { return *content_.load(); }
  bool capHit() const { return cap_hit_.load(); }

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

  // --- Multi-segment lock-collapse (time_maps.md phase 3) ---
  /** The multi-segment twin of collapseToWindow: the map's kept
   * material BECOMES the take — a SPLICE COPY concatenates the
   * segments into an exact-size buffer (a content_base_ shift cannot
   * express a discontiguous keep). New facts: duration := period,
   * origin += mapOffset(0) (the anchoring law — playback is
   * sample-identical to the mapped playback it replaces), window
   * full-span, content_base 0. Returns the OLD buffer — the caller
   * (the edit inverse) OWNS it for undo; it must not be freed inline
   * (in-flight renders may read it for ≤2 callbacks). Message thread,
   * committed clip only. The caller clears/retires the map override.
   */
  std::unique_ptr<juce::AudioBuffer<float>> spliceToMap(
      const timing::TimeMap &m) {
    const int64_t period = m.period();
    auto spliced =
        std::make_unique<juce::AudioBuffer<float>>(1, (int)period);
    spliced->clear();
    const auto &src = *content_.load();
    const int64_t base = content_base_.load();
    int64_t w = 0;
    for (int i = 0; i < m.n; ++i) {
      const int64_t s = m.segs[i].start;
      const int64_t len = m.segs[i].end - s;
      const int64_t from = base + s;
      const int64_t avail = std::max<int64_t>(
          0, std::min<int64_t>(len, src.getNumSamples() - from));
      if (avail > 0) spliced->copyFrom(0, (int)w, src, 0, (int)from, (int)avail);
      w += len;
    }
    origin_samples.store(origin_samples.load() + m.mapOffset(0));
    duration_samples.store(period);
    setLoopPoints(0, period);
    content_base_.store(0);
    write_position.store((int)period);
    std::unique_ptr<juce::AudioBuffer<float>> old = std::move(content_owned_);
    content_owned_ = std::move(spliced);
    content_.store(content_owned_.get());
    return old;
  }
  /** Inverse of spliceToMap: reinstall the pre-splice buffer + facts.
   * Returns the DISPLACED spliced buffer — the caller retires it (an
   * in-flight render may still read it). Loop points restore to
   * full-span: the reinstalled map override shadows them (the same
   * documented looseness as LoopPoints-under-override). */
  std::unique_ptr<juce::AudioBuffer<float>> unspliceFromMap(
      std::unique_ptr<juce::AudioBuffer<float>> old_buffer,
      int64_t old_origin, int64_t old_duration, int64_t old_base,
      int64_t old_recorded) {
    std::unique_ptr<juce::AudioBuffer<float>> displaced =
        std::move(content_owned_);
    content_owned_ = std::move(old_buffer);
    content_.store(content_owned_.get());
    origin_samples.store(old_origin);
    duration_samples.store(old_duration);
    setLoopPoints(0, old_duration);
    content_base_.store(old_base);
    write_position.store((int)old_recorded);
    return displaced;
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
    // Exact-size: a saved take is never truncated to some prior
    // capacity (the old fixed 60 s buffer clipped long takes on load).
    auto &buffer = *content_.load();
    const int n = audio.getNumSamples();
    if (n > 0) buffer.setSize(1, n, false, false, false);
    buffer.clear();
    if (n > 0 && audio.getNumChannels() > 0)
      buffer.copyFrom(0, 0, audio, 0, 0, n);
    write_position.store(n);
    take_context_cycle_.store(context_cycle);
    rec_state_.store((int)RecState::Idle);
    is_playing.store(true);  // committed clips sound
  }

 private:
  // Content storage (see the D4 block above): owned on the message
  // thread, read through the atomic by both threads.
  std::unique_ptr<juce::AudioBuffer<float>> content_owned_;
  std::atomic<juce::AudioBuffer<float> *> content_{nullptr};
  // Set when the take auto-finished at the reservation bound.
  std::atomic<bool> cap_hit_{false};

  // Mono scratch for the effect rack: playback renders here, the rack
  // processes in place, then the result sums into the parent. Sized in
  // the constructor; grows only if the device block exceeds it (rare —
  // the StackNode::mix_buffer precedent). Audio-thread only. `mutable`:
  // DSP scratch written by the CONST render phase (§2.3).
  mutable std::vector<float> fx_scratch_;

  // §2.3 phase split: set when commitRecording fires, cleared at the
  // top of the next control pass. render() gates on it so the commit
  // block stays SILENT — the historical semantics (process used to
  // return right after commit, skipping playback for that block).
  mutable std::atomic<bool> committed_this_block_{false};

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
  /** Write `n` captured samples whose heard-elapsed index starts at
   * `heard_pos` — plain takes write linearly; through-map takes fold
   * destinations through the frozen map (bounded seam runs). */
  void captureWrite(juce::AudioBuffer<float> &buffer, int64_t heard_pos,
                    const float *src, int n);

  // --- Through-map take state (time_maps.md phase 2) ---
  // The commit cycle C, set at arm on the message thread (atomic: the
  // audio thread's arm branch keys on it); cleared at commit/cancel.
  std::atomic<int64_t> map_commit_cycle_{0};
  // Frozen by the through-map arm branch when capture begins — the map
  // shaping this take and the anchor's heard offset within its period.
  // Audio-thread-only plain fields (capture_next_clock_ discipline).
  bool through_map_capture_ = false;
  timing::TimeMap take_map_{};
  int64_t map_anchor_off_ = 0;

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
