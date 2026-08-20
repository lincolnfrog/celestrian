#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include "audio_node.h"
#include "midi_sequence.h"

namespace celestrian {

/**
 * A leaf node: one recorded take and its playback.
 *
 * Three cooperating pieces, each documented at its members:
 *   - the recording STATE MACHINE (RecState below) — arm targets, the
 *     capture window, stop boundaries, commit;
 *   - the CONTENT model — one buffer reached through one atomic pointer
 *     (D4): a huge virtual reservation at arm, compacted after commit,
 *     write-once thereafter (no overdub), with content_base_ letting a
 *     lock-collapse re-window storage without copying;
 *   - the kernel PLAYBACK equation in render() — a pure function of
 *     (buffer, origin, active map, t); every cyclic behavior (loops,
 *     windows, one-shots, spliced maps) is a parameter of that one
 *     equation, never a separate code path.
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

  /**
   * What a take's CONTENT is (docs/vst3.md §8, phase 5): AUDIO — a
   * sample buffer captured from the assigned device input(s); MIDI — a
   * note sequence captured from the MIDI input, rendered through the
   * chain's instrument slot. Decided at ARM from the clip's own chain
   * (an instrument slot makes it a MIDI track — Q-V3's MidiClipNode
   * folded into ClipNode, because the take lifecycle is content-
   * agnostic and lives here) and fixed for the take's lifetime; the
   * kernel playback equation, arm/stop/commit math, through-map fold,
   * epoch re-base and undo entries are shared verbatim.
   */
  enum class ContentKind : int { Audio = 0, Midi };

  // The default rate is a convenience for unit tests; the engine passes
  // the actual device rate when creating clips (P0-5).
  ClipNode(juce::String name, double source_sample_rate = 44100.0);
  ~ClipNode() override = default;

  // AudioNode implementation (§2.3 control/render split)
  /** Decisions + capture: arm targets, stop boundaries, input ingest,
   * commit (with island consequences). */
  void control(const float* const* input_channels, int num_input_channels,
               const ProcessContext& context) override;
  /** The kernel playback equation — pure; see AudioNode::render. */
  void render(float* const* output_channels, int num_output_channels,
              const ProcessContext& context) const override;

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
   * Assigns the preferred hardware input channel for this clip (the
   * LEFT channel of a stereo pair when a right input is also set).
   */
  void setInputChannel(int index) { preferred_input_channel = index; }
  int getInputChannel() const { return preferred_input_channel; }
  /**
   * Assigns the RIGHT hardware input of a stereo pair; −1 (default)
   * keeps the clip mono. The channel COUNT of a take is fixed at arm
   * (startRecording sizes the content buffer from this), so flipping it
   * mid-take does nothing until the next arm.
   */
  void setInputChannelRight(int index) {
    preferred_input_channel_right = index;
  }
  int getInputChannelRight() const { return preferred_input_channel_right; }
  /** Two device inputs assigned → the next take captures stereo. */
  bool isStereoInput() const { return preferred_input_channel_right >= 0; }
  /** Channel count of the clip's CONTENT (committed or capturing). */
  int contentChannels() const { return content_.load()->getNumChannels(); }
  /** The content kind of the current/last take (Audio until a MIDI
   * take is armed). Audio-thread safe. */
  ContentKind contentKind() const { return (ContentKind)content_kind_.load(); }
  /** True when this clip records/renders NOTES: it holds MIDI content,
   * or it is empty and its chain carries an instrument slot (the next
   * take will be MIDI). Message thread (metadata / arm decisions). */
  bool isMidiClip() const {
    if (contentKind() == ContentKind::Midi) return true;
    return duration_samples.load() <= 0 && !isArmedOrRecording() &&
           fxChain()->hasInstrumentSlot();
  }
  /** The note sequence (D3: message thread reads only while Idle). */
  const MidiSequence& midiSequence() const { return *midi_.load(); }
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

  /**
   * Signals the recording thread to stop and flush the buffer.
   */
  void stopRecording();
  /** Group-stop variant (Q7): the caller snapshots whether the island
   * had a quantum BEFORE stopping ANY clip of the set. Without the
   * snapshot, a simultaneous first-take group stop diverges: the first
   * clip's immediate commit establishes Q, flipping its siblings onto
   * the record-to-next-boundary path — they'd run a full extra Q. One
   * performance must mean one committed duration, so all first takes
   * of a group stop take the immediate-commit path together. */
  void stopRecording(bool island_has_quantum);

  /**
   * Opens the content-sounds gate (`is_playing`) — the internal flag
   * commit also sets. NOT a user verb since Q16 (per-node Play/Stop is
   * superseded); tests use it to make a clip render without a full
   * record→commit pass.
   */
  void startPlayback();

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
                       const ProcessContext* ctx = nullptr);
  const juce::AudioBuffer<float>& getAudioBuffer() const {
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
  juce::AudioBuffer<float>* swapContent(
      std::unique_ptr<juce::AudioBuffer<float>> fresh) {
    juce::AudioBuffer<float>* old = content_owned_.release();
    content_owned_ = std::move(fresh);
    content_.store(content_owned_.get());
    return old;
  }
  /** TEST-ONLY: mutable content access (wall-guard simulations). */
  juce::AudioBuffer<float>& contentForTest() { return *content_.load(); }
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
      const timing::TimeMap& m) {
    const int64_t period = m.period();
    const auto& src = *content_.load();
    const int chans = std::max(1, src.getNumChannels());
    // A MIDI clip's audio buffer is the idle baseline (its content is
    // the note sequence — spliceMidiToMap); keep the audio side minimal.
    const bool midi = contentKind() == ContentKind::Midi;
    auto spliced = std::make_unique<juce::AudioBuffer<float>>(
        chans, midi ? 1 : (int)period);
    spliced->clear();
    const int64_t base = content_base_.load();
    int64_t w = 0;
    for (int i = 0; i < (midi ? 0 : m.n); ++i) {
      const int64_t s = m.segs[i].start;
      const int64_t len = m.segs[i].end - s;
      const int64_t from = base + s;
      const int64_t avail = std::max<int64_t>(
          0, std::min<int64_t>(len, src.getNumSamples() - from));
      if (avail > 0) {
        for (int c = 0; c < chans; ++c) {
          spliced->copyFrom(c, (int)w, src, c, (int)from, (int)avail);
        }
      }
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
      std::unique_ptr<juce::AudioBuffer<float>> old_buffer, int64_t old_origin,
      int64_t old_duration, int64_t old_base, int64_t old_recorded) {
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

  // --- TAKES ARE UNDOABLE (owner ruling 2026-08-20, docs/sequencer.md
  // §11.5; edit.h Kind::Take / Untake) ---
  /** Everything a committed take IS, detachable as one value: the
   * content (audio buffer and/or note sequence — moved, not copied)
   * plus the recorded facts. The caller (an edit) OWNS the content. */
  struct TakeState {
    std::unique_ptr<juce::AudioBuffer<float>> buffer;
    std::unique_ptr<MidiSequence> midi;
    int64_t origin = 0, duration = 0, base = 0, recorded = 0;
    int64_t context_cycle = 0, loop_start = 0, loop_end = 0;
    int content_kind = 0;
    bool cap_hit = false;
  };
  /** Strip the committed take: the clip returns to EMPTY (idle, silent,
   * no duration, no origin) and the take's content + facts come back
   * as a value for the undo log to own. Message thread, Idle clip only
   * (the caller gates). Atomic-swap discipline: an in-flight render may
   * still read the old buffer this block — the returned content must
   * not be freed inline (the log keeps it for as long as it matters). */
  TakeState stripTake() {
    TakeState s;
    s.origin = origin_samples.load();
    s.duration = duration_samples.load();
    s.base = content_base_.load();
    s.recorded = write_position.load();
    s.context_cycle = take_context_cycle_.load();
    s.loop_start = loop_start_samples.load();
    s.loop_end = loop_end_samples.load();
    s.content_kind = content_kind_.load();
    s.cap_hit = cap_hit_.load();
    // Silence first (render reads duration/is_playing before content).
    is_playing.store(false);
    duration_samples.store(0);
    auto empty = std::make_unique<juce::AudioBuffer<float>>(
        1, std::max(1, (int)sample_rate));
    empty->clear();
    s.buffer = std::move(content_owned_);
    content_owned_ = std::move(empty);
    content_.store(content_owned_.get());
    auto empty_midi = std::make_unique<MidiSequence>(0);
    s.midi = std::move(midi_owned_);
    midi_owned_ = std::move(empty_midi);
    midi_.store(midi_owned_.get());
    content_kind_.store((int)ContentKind::Audio);
    origin_samples.store(0);
    content_base_.store(0);
    write_position.store(0);
    take_context_cycle_.store(0);
    cap_hit_.store(false);
    setLoopPoints(0, 0);
    rec_state_.store((int)RecState::Idle);
    return s;
  }
  /** Reinstall a stripped take (redo). Returns the DISPLACED empty
   * placeholders for the caller to retire (an in-flight render may read
   * them this block). Message thread, Idle empty clip only. */
  std::pair<std::unique_ptr<juce::AudioBuffer<float>>,
            std::unique_ptr<MidiSequence>>
  restoreTake(TakeState&& s) {
    std::pair<std::unique_ptr<juce::AudioBuffer<float>>,
              std::unique_ptr<MidiSequence>>
        displaced;
    displaced.first = std::move(content_owned_);
    content_owned_ = std::move(s.buffer);
    content_.store(content_owned_.get());
    displaced.second = std::move(midi_owned_);
    midi_owned_ = std::move(s.midi);
    midi_.store(midi_owned_.get());
    content_kind_.store(s.content_kind);
    content_base_.store(s.base);
    write_position.store((int)s.recorded);
    take_context_cycle_.store(s.context_cycle);
    cap_hit_.store(s.cap_hit);
    origin_samples.store(s.origin);
    setLoopPoints(s.loop_start, s.loop_end);
    rec_state_.store((int)RecState::Idle);
    // Content last, then sound (the commit publication order).
    duration_samples.store(s.duration);
    is_playing.store(true);
    return displaced;
  }

  /**
   * Restore a committed take on session load (session_io): copies `audio`
   * into the buffer, marks it playable, and sets the recorded facts that
   * are not public atomics (write position, contextCycle). The caller
   * sets origin/duration/loop points/mute separately (public). Message
   * thread only — the node is not yet in the live graph.
   */
  void loadCommitted(const juce::AudioBuffer<float>& audio,
                     int64_t context_cycle) {
    // Exact-size: a saved take is never truncated to some prior
    // capacity (the old fixed 60 s buffer clipped long takes on load).
    // Channel count follows the audio (stereo takes reload as stereo).
    auto& buffer = *content_.load();
    const int n = audio.getNumSamples();
    const int chans = std::max(1, audio.getNumChannels());
    if (n > 0)
      buffer.setSize(chans, n, /*keepExistingContent=*/false,
                     /*clearExtraSpace=*/false, /*avoidReallocating=*/false);
    buffer.clear();
    for (int c = 0; c < chans && n > 0; ++c)
      buffer.copyFrom(c, 0, audio, c, 0, n);
    write_position.store(n);
    take_context_cycle_.store(context_cycle);
    rec_state_.store((int)RecState::Idle);
    is_playing.store(true);  // committed clips sound
  }

  /**
   * Restore a committed MIDI take on session load (session_io): the
   * events become the content (exact-size), the clip becomes a MIDI
   * clip, playable. Origin/duration/loop points set by the caller.
   * Message thread only — the node is not yet in the live graph.
   */
  void loadCommittedMidi(std::vector<MidiEvent> events,
                         int64_t context_cycle) {
    auto fresh = std::make_unique<MidiSequence>();
    fresh->assign(std::move(events));
    midi_owned_ = std::move(fresh);
    midi_.store(midi_owned_.get());
    content_kind_.store((int)ContentKind::Midi);
    write_position.store((int)duration_samples.load());
    take_context_cycle_.store(context_cycle);
    rec_state_.store((int)RecState::Idle);
    is_playing.store(true);
  }

  /** The MIDI twin of spliceToMap (call it BEFORE spliceToMap, which
   * rewrites the shared facts): events inside the kept cells move to
   * their spliced positions; the rest are cut. Returns the OLD
   * sequence — the caller (the edit inverse) OWNS it for undo; never
   * freed inline. Message thread, committed MIDI clip only. */
  std::unique_ptr<MidiSequence> spliceMidiToMap(const timing::TimeMap& m) {
    const MidiSequence& src = *midi_.load();
    const int64_t base = content_base_.load();
    std::vector<MidiEvent> kept;
    kept.reserve((size_t)src.count());
    int64_t w = 0;
    for (int i = 0; i < m.n; ++i) {
      const int64_t s = m.segs[i].start;
      const int64_t len = m.segs[i].end - s;
      for (int k = 0; k < src.count(); ++k) {
        const int64_t rel = src[k].pos - base - s;
        if (rel >= 0 && rel < len) {
          MidiEvent e = src[k];
          e.pos = w + rel;
          kept.push_back(e);
        }
      }
      w += len;
    }
    auto spliced = std::make_unique<MidiSequence>();
    spliced->assign(std::move(kept));
    std::unique_ptr<MidiSequence> old = std::move(midi_owned_);
    midi_owned_ = std::move(spliced);
    midi_.store(midi_owned_.get());
    return old;
  }
  /** Inverse of spliceMidiToMap: reinstall the pre-splice sequence;
   * returns the DISPLACED one for the caller to retire. */
  std::unique_ptr<MidiSequence> unspliceMidi(
      std::unique_ptr<MidiSequence> old_sequence) {
    std::unique_ptr<MidiSequence> displaced = std::move(midi_owned_);
    midi_owned_ = std::move(old_sequence);
    midi_.store(midi_owned_.get());
    return displaced;
  }

 private:
  // Content storage (see the D4 block above): owned on the message
  // thread, read through the atomic by both threads.
  std::unique_ptr<juce::AudioBuffer<float>> content_owned_;
  std::atomic<juce::AudioBuffer<float>*> content_{nullptr};
  // MIDI content (phase 5): the note twin of content_, same D4
  // discipline (message thread owns/swaps on idle clips, audio thread
  // appends during capture and reads during render).
  std::unique_ptr<MidiSequence> midi_owned_;
  std::atomic<MidiSequence*> midi_{nullptr};
  std::atomic<int> content_kind_{(int)ContentKind::Audio};
  // MIDI capture state (audio-thread only, the capture_next_clock_
  // discipline): the arrival index content position write_position
  // corresponds to, the history cursor (next sequence number to
  // consider), the held-note meter, and the lost-events log latch.
  int64_t midi_capture_next_clock_ = 0;
  int64_t midi_history_cursor_ = 0;
  HeldNotes capture_held_;
  bool midi_lost_logged_ = false;
  // MIDI render scratch (mutable: DSP scratch written by the CONST
  // render phase, §2.3): the block's event buffer (preallocated in
  // the constructor), the notes the content has sounding (released at
  // seams / stop), whether content ran last block, and the content
  // position the next block is expected to continue from (−1 = none)
  // — a jump anywhere is a discontinuity that releases held notes.
  mutable juce::MidiBuffer render_midi_;
  mutable HeldNotes render_held_;
  mutable bool midi_content_was_active_ = false;
  mutable int64_t midi_render_next_pos_ = -1;
  // Release-tail budget: the chain keeps running this many samples
  // after the last content/live event so envelopes ring out.
  mutable int64_t midi_tail_samples_left_ = 0;
  // Set when the take auto-finished at the reservation bound.
  std::atomic<bool> cap_hit_{false};

  // Playback scratch for the effect rack: playback renders here, the
  // rack processes in place, then the result sums into the parent
  // (panned). fx_scratch_ carries channel 0; fx_scratch2_ carries
  // channel 1 of stereo content. Sized in the constructor; grow only if
  // the device block exceeds them (rare — the StackNode::mix_buffer
  // precedent). Audio-thread only. `mutable`: DSP scratch written by
  // the CONST render phase (§2.3).
  mutable std::vector<float> fx_scratch_;
  mutable std::vector<float> fx_scratch2_;

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
  // Underrun log latch (audio-thread only): one line per capture, reset
  // at beginCapture — a persistent underrun otherwise posts every block
  // and overwhelms the drain FIFO (the field-hang log storm).
  bool underrun_logged_ = false;
  // Channel count of the CURRENT take, fixed at arm (startRecording
  // sizes the buffer and stores this before the state flips to Armed —
  // the seq-cst state store publishes it to the audio thread).
  int capture_channels_ = 1;

  /** Armed-state evaluation (audio thread, once per block). */
  void armEvaluate(const ProcessContext& context);
  /** Armed → Capturing: fixes the capture window for `target`. */
  void beginCapture(const ProcessContext& context, int64_t target,
                    int64_t compensated_pos);
  /** Write `n` captured samples whose heard-elapsed index starts at
   * `heard_pos` into content channel `dest_ch` — plain takes write
   * linearly; through-map takes fold destinations through the frozen
   * map (bounded seam runs). */
  void captureWrite(juce::AudioBuffer<float>& buffer, int dest_ch,
                    int64_t heard_pos, const float* src, int n);
  /** The capture bookkeeping tail shared by the ring and live-block
   * paths: peak telemetry, write-position/live-duration advance, the
   * PendingStop boundary crossing, and the through-map one-period wall
   * (both of which may COMMIT the take). Callers must not touch capture
   * state after this returns — nothing may follow a commit. */
  void finishCaptureBlock(int written, float block_peak,
                          const ProcessContext& context);
  /** MIDI take capture for one block (phase 5): the history-ring path
   * (arrival-indexed, latency-compensated — the note twin of the
   * pre-record path) or the live-block fallback. Calls
   * finishCaptureBlock, which may commit. */
  void captureMidiBlock(const ProcessContext& context);
  /** Append one event to the take at content position `pos` (through-
   * map takes fold it like captureWrite does for samples). */
  void captureMidiEvent(int64_t pos, const juce::uint8* bytes, int size,
                        float& block_peak);
  /** The MIDI clip render path (phase 5): the kernel playback equation
   * over the note sequence — the block's covered content window(s)
   * sliced into sample-accurate events, seam releases, live play-
   * through, one chain run over silence from the instrument down. */
  void renderMidi(float* const* output_channels, int num_output_channels,
                  const ProcessContext& context) const;
  /** Solo/mute audibility for this block (Q16 canon; snapshot walk). */
  bool isSilencedThisBlock(const ProcessContext& context) const;

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
  // Right input of a stereo pair; −1 = mono clip (the default). Like
  // preferred_input_channel this is a message-thread wiring fact the
  // audio thread only reads.
  int preferred_input_channel_right = -1;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

}  // namespace celestrian
