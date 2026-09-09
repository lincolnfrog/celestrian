#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <vector>

#include "audio_node.h"
#include "take_storage.h"
#include "midi_sequence.h"

namespace celestrian {

/**
 * A leaf node: a recorded slot (one origin, one period) holding one or
 * more takes, and its playback.
 *
 * Three cooperating pieces, each documented at its members:
 *   - the recording STATE MACHINE (RecState below) — arm targets, the
 *     capture window, stop boundaries, commit;
 *   - the CONTENT model — one buffer reached through one atomic
 *     pointer: a huge virtual reservation at arm, compacted after commit,
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
   * The recording lifecycle (kernel.md §3): ONE explicit state, so
   * illegal flag combinations are unrepresentable.
   *
   *   Idle ──startRecording()──▶ Armed ──target reached──▶ Capturing
   *    ▲          (msg thread)     │        (audio thread)     │
   *    │◀── stopRecording() = cancel                           │
   *    │                                stopRecording(), Q>0 ──┤
   *    │◀── commit ─── PendingStop ◀── (boundary computed on   │
   *    │               (audio thread)   the audio thread)      │
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
   * (an instrument slot makes it a MIDI track — one class, because the
   * take lifecycle is content-agnostic) and fixed for the take's
   * lifetime; the
   * kernel playback equation, arm/stop/commit math, through-map fold,
   * epoch re-base and undo entries are shared verbatim.
   */
  enum class ContentKind : int { Audio = 0, Midi };

  // The default rate is a convenience for unit tests; the engine passes
  // the actual device rate when creating clips.
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
  void setInputChannel(int index) { preferred_input_channel.store(index); }
  int getInputChannel() const { return preferred_input_channel.load(); }
  /**
   * Assigns the RIGHT hardware input of a stereo pair; −1 (default)
   * keeps the clip mono. The channel COUNT of a take is fixed at arm
   * (startRecording sizes the content buffer from this), so flipping it
   * mid-take does nothing until the next arm.
   */
  void setInputChannelRight(int index) {
    preferred_input_channel_right.store(index);
  }
  int getInputChannelRight() const {
    return preferred_input_channel_right.load();
  }
  /** Two device inputs assigned → the next take captures stereo. */
  bool isStereoInput() const {
    return preferred_input_channel_right.load() >= 0;
  }
  /**
   * Software input monitoring (Q20, design_language.md §5): while on,
   * render adds this block's arrivals for the clip's input channel(s)
   * — read from the pre-record ring — into the dry signal ahead of the
   * gate and the rack, so the input is heard through the clip's chain,
   * gain and pan like content. Independent of the recording state (a
   * capturing clip renders no content, so nothing doubles). OFF by
   * default; not undoable (a monitoring gesture, like solo/midiArmed);
   * persisted and captured by track templates as input setup.
   */
  bool isMonitoring() const { return monitor_.load(); }
  void setMonitoring(bool on) { monitor_.store(on); }
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
  /** The note sequence (message thread reads only while Idle). */
  const MidiSequence& midiSequence() const { return *midi_.load(); }
  /** Asks the next MIDI render block to send the sound-off pair
   * (docs/vst3.md §11) to the instrument — the device-stop edge, where
   * no block is running to carry it. Any thread; consumed once. */
  void requestMidiSoundOff() { midi_sound_off_pending_.store(true); }
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
  /** startRecording in two halves, for atomic GROUP arms: reserve the
   * take buffer + reset the capture facts (may be slow: 4 GB virtual
   * reservation), then publish the Armed state. Returns false when the
   * clip is not idle (nothing to publish). Message thread. */
  bool prepareRecording(int64_t through_map_commit_cycle = 0);
  void publishArm();

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
  /** `group_generation` != 0 parks the stop until the island root
   * publishes that generation (one block top for every member). */
  void stopRecording(bool island_has_quantum, uint32_t group_generation = 0);

  /**
   * Opens the content-sounds gate (`is_playing`) — the internal flag
   * commit also sets. NOT a user verb (Q16: there is no per-node
   * Play/Stop); tests use it to make a clip render without a full
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
           (recState() == RecState::Capturing &&
            (stop_requested_.load() || stop_pending_gen_.load() != 0));
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

  // --- Take content storage (NO recording wall) ---
  // The content buffer is reached through ONE atomic pointer. At ARM it
  // becomes a REFERRING buffer over reserved storage (take_storage.h):
  // address space for the whole bound, pages committed ahead of the
  // write head by the engine's grower — so a take's memory cost is
  // what it records plus a headroom, on every platform (a plain malloc
  // is lazy on macOS but charges the full reservation per mic on
  // Windows). The reservation bound (~6.7 h at 44.1 kHz; juce sample
  // counts are int) exists for integrity, not policy: reaching it — or
  // the committed edge, if the grower ever starves — auto-finishes
  // CLEANLY at the last boundary that fits (never a silent zombie). At
  // SETTLE the engine COMPACTS: an exact-size heap copy swaps in
  // atomically (safe under an actively rendering clip) and the old
  // buffer + its storage retire through the reclaimer.
  static constexpr int64_t kMaxTakeSamples = (int64_t{1} << 30);
  /** Committed at arm and kept ahead of the write head by the engine's
   * grower (~60 s at 48 kHz per channel): the take's real memory cost
   * is what it recorded plus this headroom. */
  static constexpr int64_t kArmCommitSamples = int64_t{48000} * 60;
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
  /** The reserved storage behind the current content (null = heap). */
  TakeStorage* reservedStorage() const { return take_storage_.get(); }
  /** Message thread: detach the reserved storage (after the referring
   * buffer has been swapped out); the caller retires it. */
  std::unique_ptr<TakeStorage> releaseStorage() {
    storage_rt_.store(nullptr);
    return std::move(take_storage_);
  }
  /** The samples per channel capture may write: the buffer's extent,
   * capped by the storage's committed edge (audio thread). */
  int64_t writableCapacity() const {
    const int64_t cap = content_.load()->getNumSamples();
    if (const TakeStorage* st = storage_rt_.load()) return std::min(cap, st->committed());
    return cap;
  }
  /** TEST-ONLY: mutable content access (wall-guard simulations). */
  juce::AudioBuffer<float>& contentForTest() { return *content_.load(); }
  bool capHit() const { return cap_hit_.load(); }

  // --- Q13 lock-collapse ---
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
  void collapseContent(int64_t shift, int64_t len) {
    // THE LEAF HALF of a lock-collapse (composition.md §5): the content
    // view moves by `shift`, the duration becomes `len`, the clip's
    // own window is consumed. The ORIGIN is NOT touched here — the
    // applier (AudioEngine::collapseNode) moves the collapsed node's
    // whole subtree once, clip or stack alike (Q18: a window anchors at
    // its node's origin, so window top → origin keeps the collapse
    // audio-neutral).
    //
    // THE COLLAPSE MARKER (nesting: collapse → cancel take → re-trim →
    // arm again is a legal second collapse): `collapsed_from_` keeps the
    // ORIGINAL duration (set only on the first level). What the
    // collapses shifted by IS `content_base_` — the base starts at 0 on
    // every commit and only collapses move it — so the re-opening
    // restore (which unwinds ALL levels) reads the base; no second
    // counter to keep in step.
    if (collapsed_from_.load() == 0) collapsed_from_.store(duration_samples.load());
    content_base_.store(content_base_.load() + shift);
    duration_samples.store(len);
    setLoopPoints(0, 0);  // the window is consumed: the take IS the window
    take_files_dirty_ = true;  // the mirrored WAV is the committed window
  }
  /** Inverse of collapseContent: restore the pre-collapse buffer view
   * and the trim (window [shift, shift + current duration)). Like the
   * forward, the origin is the applier's (AudioEngine::uncollapseNode
   * moves the subtree back by `shift`). */
  void uncollapseContent(int64_t shift, int64_t old_duration) {
    const int64_t len = duration_samples.load();
    content_base_.store(content_base_.load() - shift);
    duration_samples.store(old_duration);
    setLoopPoints(shift, shift + len);
    // Fully unwound (the content view is back at 0) → not collapsed.
    if (content_base_.load() == 0) collapsed_from_.store(0);
    take_files_dirty_ = true;
  }
  /** True when the committed content is a lock-collapsed window of a
   * longer recording (trimmed-away material still in the buffer). */
  bool isCollapsed() const { return collapsed_from_.load() > 0; }
  /** The pre-collapse duration (0 when not collapsed). */
  int64_t collapsedFrom() const { return collapsed_from_.load(); }

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
    // The spliced buffer IS the take now: no trimmed-away material, so
    // no collapse marker (the inverse restores it with the old buffer).
    collapsed_from_.store(0);
    write_position.store((int)period);
    take_files_dirty_ = true;
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
      int64_t old_duration, int64_t old_base, int64_t old_recorded,
      int64_t old_collapsed_from) {
    std::unique_ptr<juce::AudioBuffer<float>> displaced =
        std::move(content_owned_);
    content_owned_ = std::move(old_buffer);
    content_.store(content_owned_.get());
    origin_samples.store(old_origin);
    duration_samples.store(old_duration);
    setLoopPoints(0, old_duration);
    content_base_.store(old_base);
    collapsed_from_.store(old_collapsed_from);
    write_position.store((int)old_recorded);
    take_files_dirty_ = true;
    return displaced;
  }

  // --- TAKES ARE UNDOABLE (docs/sequencer.md §11.5; edit.h Kind::Take
  // / Untake) ---
  /** Everything a committed take IS, detachable as one value: the
   * content (audio buffer and/or note sequence — moved, not copied)
   * plus the recorded facts. The caller (an edit) OWNS the content. */
  struct TakeState {
    std::unique_ptr<juce::AudioBuffer<float>> buffer;
    std::unique_ptr<TakeStorage> storage;  // when `buffer` refers to it
    std::unique_ptr<MidiSequence> midi;
    int64_t origin = 0, duration = 0, base = 0, recorded = 0;
    int64_t context_cycle = 0, loop_start = 0, loop_end = 0;
    int64_t collapsed_from = 0;
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
    s.loop_start = getLoopStart();
    s.loop_end = getLoopEnd();
    s.content_kind = content_kind_.load();
    s.cap_hit = cap_hit_.load();
    s.collapsed_from = collapsed_from_.load();
    // Silence first (render reads duration/is_playing before content).
    is_playing.store(false);
    duration_samples.store(0);
    auto empty = std::make_unique<juce::AudioBuffer<float>>(
        1, std::max(1, (int)sample_rate));
    empty->clear();
    s.buffer = std::move(content_owned_);
    s.storage = releaseStorage();  // travels with the referring buffer
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
    collapsed_from_.store(0);
    setLoopPoints(0, 0);
    rec_state_.store((int)RecState::Idle);
    // A strip is legal only on a single-take clip (the applier gates);
    // the list and comp go with the content.
    takes_.clear();
    active_take_.store(0);
    setCompCells({}, 0);
    publishTakeTable();
    take_files_dirty_ = true;
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
    take_storage_ = std::move(s.storage);
    storage_rt_.store(take_storage_.get());
    content_.store(content_owned_.get());
    displaced.second = std::move(midi_owned_);
    midi_owned_ = std::move(s.midi);
    midi_.store(midi_owned_.get());
    content_kind_.store(s.content_kind);
    content_base_.store(s.base);
    write_position.store((int)s.recorded);
    take_context_cycle_.store(s.context_cycle);
    cap_hit_.store(s.cap_hit);
    collapsed_from_.store(s.collapsed_from);
    origin_samples.store(s.origin);
    setLoopPoints(s.loop_start, s.loop_end);
    rec_state_.store((int)RecState::Idle);
    // Content last, then sound (the commit publication order).
    duration_samples.store(s.duration);
    is_playing.store(true);
    take_files_dirty_ = true;
    return displaced;
  }

  // --- TAKES AND COMPING (docs/takes.md; edit.h SelectTake / DeleteTake
  // / Comp, Take / Untake with a take index) ---
  // A committed clip holds N takes sharing its ONE origin and period:
  // alternate content buffers for the same musical slot. The ACTIVE
  // take lives in the live content fields (content_owned_, midi_owned_,
  // write_position, cap_hit_); the others sit in `takes_` as detached
  // TakeState records, the slot at active_take_ holding no content. A
  // single-take clip may keep `takes_` empty. Every take of a clip
  // shares content_base_ (a lock-collapse shifts the whole slot, so one
  // base serves all; the record's `base` is the persisted fact). Take
  // buffers are immutable once committed: a removed record travels into
  // the edit log and retires through the reclaimer, never freed inline.
  // The audio thread sees the list through the seqlocked take table
  // (take_buffers_ + the comp cells), read once per render.
  static constexpr int kMaxTakes = 32;
  static constexpr int kMaxCompCells = 256;
  /** Takes held: 0 for an empty clip, else max(1, list size). Message
   * thread. */
  int takeCount() const {
    if (duration_samples.load() <= 0) return 0;
    return std::max<int>(1, (int)takes_.size());
  }
  int activeTake() const { return active_take_.load(); }
  /** Take k's audio buffer / note sequence (the active one's live
   * content), or null when k is out of range. Message thread, Idle. */
  const juce::AudioBuffer<float>* takeBuffer(int k) const;
  const MidiSequence* takeMidi(int k) const;
  /** Recorded length of take k (the active's write position). */
  int64_t takeRecorded(int k) const;
  /** Content base of take k — shared by every take (see above). */
  int64_t takeBase(int) const { return content_base_.load(); }
  /** Make take k the active one: an atomic content-pointer swap (the
   * displaced pointers live on in the list). False when k is out of
   * range, already active, or the clip is not Idle. Message thread. */
  bool selectTake(int k);
  /** Detach take k (count >= 2). An active k hands activity to its
   * lower neighbour (k − 1, else the new 0). The caller OWNS the record.
   * Message thread, Idle clip. */
  TakeState removeTake(int k);
  /** Reinsert a detached record at index k (the inverse of removeTake);
   * activity stays where it is. Message thread, Idle clip. */
  void insertTake(int k, TakeState&& s);
  /** Session load: append take k's content behind the active take 0. */
  void appendLoadedTake(const juce::AudioBuffer<float>& audio);
  void appendLoadedMidiTake(std::vector<MidiEvent> events);
  /** True once a removeTake/insertTake renumbered the list since the
   * last session write: the per-take files must be rewritten whole. */
  bool takeFilesDirty() const { return take_files_dirty_; }
  void markTakeFilesWritten() const { take_files_dirty_ = false; }
  /** The ONE truth for the mirror (session_io): every message-thread
   * mutation of committed content or its frame sets this; the mirror
   * rewrites the clip's WAVs iff it is set (or a file is missing). The
   * audio-thread commit cannot set it — reconcileTakes does, when the
   * take settles into the log. */
  void markTakeFilesDirty() { take_files_dirty_ = true; }

  /** NEW TAKE (docs/takes.md): arm a further take of a COMMITTED clip
   * without emptying it — the active content moves into its list slot,
   * fresh storage is reserved, and the clip renders silence until the
   * take settles. Origin, period, loop points and base stay. The arm
   * target is the next t ≡ origin (mod period); capture runs exactly
   * one period and auto-finishes. False when the clip is not Idle with
   * content, the list is full, or the next take's kind would differ
   * from the active's. Publish with publishArm(). Message thread. */
  bool prepareRetake();
  /** A new take has committed or cancelled and awaits settleRetake. */
  bool retakeSettled() const {
    return retake_committed_.load() || retake_cancelled_.load();
  }
  /** Settle a finished new take (message thread): a COMMITTED one is
   * appended to the list and becomes active (returns true); a
   * CANCELLED one restores the previous active take, the abandoned
   * reservation coming back in `displaced` for the caller to retire
   * (returns false). */
  bool settleRetake(TakeState& displaced);

  /** The comp: one take index per Q cell of the period (−1 = the
   * active take), cells = ceil(period / cell_len). Empty = no comp.
   * Written whole behind the take seqlock. Message thread. */
  std::vector<int> compCells() const;
  int64_t compCellLength() const { return comp_q_.load(); }
  void setCompCells(const std::vector<int>& cells, int64_t cell_len);
  /** Peaks of take k over the committed span (the take-list view). */
  juce::var getTakeWaveform(int k, int num_peaks) const;

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
    // capacity (a fixed-capacity buffer would clip long takes on load).
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
   * IMPORT (docs/import.md): install a decoded audio buffer as the
   * committed take of an EMPTY idle clip that already lives in the
   * graph. The exact-size buffer goes in through the atomic content
   * pointer (the displaced placeholder comes back for the caller to
   * retire — an in-flight render may read it this block), then the
   * recorded facts publish in the commit order: origin, base and loop
   * points first, duration last, then sound. Message thread; the
   * caller establishes the island and logs the take.
   */
  std::unique_ptr<juce::AudioBuffer<float>> installImportedTake(
      std::unique_ptr<juce::AudioBuffer<float>> audio, int64_t origin,
      int64_t duration, int64_t loop_end, int64_t context_cycle) {
    const int n = audio->getNumSamples();
    std::unique_ptr<juce::AudioBuffer<float>> displaced(
        swapContent(std::move(audio)));
    origin_samples.store(origin);
    content_base_.store(0);
    write_position.store(n);
    take_context_cycle_.store(context_cycle);
    setLoopPoints(0, loop_end);
    rec_state_.store((int)RecState::Idle);
    duration_samples.store(duration);
    is_playing.store(true);
    take_files_dirty_ = true;
    return displaced;
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
  /** The INACTIVE takes' twin of spliceToMap / spliceMidiToMap (call
   * it BEFORE spliceToMap rewrites the shared base): every other take
   * of the slot is spliced the same way, so the takes keep one period
   * and one base. Returns (index, OLD record) pairs — the edit inverse
   * OWNS the records. */
  std::vector<std::pair<int, TakeState>> spliceOtherTakesToMap(
      const timing::TimeMap& m);
  /** Inverse: reinstall the pre-splice records at their indices; the
   * displaced spliced ones come back for the caller to retire. */
  std::vector<TakeState> unspliceOtherTakes(
      std::vector<std::pair<int, TakeState>>&& old);

 private:
  // Content storage (see the take-storage block above): owned on the message
  // thread, read through the atomic by both threads.
  std::unique_ptr<juce::AudioBuffer<float>> content_owned_;
  // The live take's reserved storage (take_storage.h) when content_owned_
  // is a REFERRING buffer over it; null for plain heap content. Swapped
  // only for idle clips (message thread); the audio thread reads the
  // raw pointer for its write wall.
  std::unique_ptr<TakeStorage> take_storage_;
  std::atomic<TakeStorage*> storage_rt_{nullptr};
  std::atomic<juce::AudioBuffer<float>*> content_{nullptr};
  // MIDI content (phase 5): the note twin of content_, same
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
  // The take's PRELUDE: notes struck before the capture window that are
  // still down when it opens land as note-ons at content 0 (the note IS
  // sounding at the take's top — I1); folded once, at the window's
  // first block.
  HeldNotes capture_prelude_;
  bool midi_prelude_folded_ = false;
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
  // The sound-off edges (docs/vst3.md §11): the channels the
  // instrument has heard since the last sound-off pair (content and
  // live events alike — the pair goes to exactly those), whether the
  // S7 gate was fully closed last block (its closing is an edge), and
  // the device-stop request (requestMidiSoundOff).
  mutable juce::uint16 midi_channels_in_use_ = 0;
  mutable bool midi_gate_was_closed_ = false;
  mutable std::atomic<bool> midi_sound_off_pending_{false};
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
  // block stays SILENT.
  mutable std::atomic<bool> committed_this_block_{false};

  std::atomic<int> write_position{0};

  // Q13 lock-collapse: storage offset of the committed content (see
  // getContentBase). Playback/waveform/save add it; capture never does
  // (recording clips always have base 0).
  std::atomic<int64_t> content_base_{0};
  std::atomic<int64_t> collapsed_from_{0};  // pre-collapse duration; 0 = not collapsed

  // Pre-record capture window (docs/performance.md §3). When the engine
  // provides a pre-record ring, capture does not copy "whatever input
  // arrived after recording started" — it copies the input that *arrived*
  // at the times the clip semantically covers: clip position p holds the
  // input sample that arrived at input-clock (window start + p), where the
  // window start maps the trigger through the latency compensation.
  // Audio-thread only.
  int64_t capture_next_clock_ = 0;
  bool capture_uses_ring_ = false;
  // Underrun log latch (audio-thread only): one line per capture, reset
  // at beginCapture — a persistent underrun otherwise posts every block
  // and overwhelms the drain FIFO.
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
  /** Monitoring is on AND the context carries a pre-record ring (a
   * bounce carries none, so monitoring never reaches a bounce). */
  bool monitorLive(const ProcessContext& context) const {
    return monitor_.load() && context.prerecord_ring != nullptr &&
           context.prerecord_ring_channels > 0 &&
           context.prerecord_ring_len > 0;
  }
  /** Adds this block's ring arrivals into the fx scratch pair: the
   * left input into fx_scratch_ (and into fx_scratch2_ too when the
   * pair is already stereo — a mono input sits center), the right
   * input of a stereo pair into fx_scratch2_, promoting a mono scratch
   * (zeroed first). A channel outside the ring contributes nothing.
   * Ring index (input_clock + i) mod ring_len: at most one wrap, so two
   * bounded adds per channel. Returns whether the pair is now stereo.
   * Audio thread: pointer arithmetic only. */
  bool addMonitorInput(const ProcessContext& context, bool stereo) const;
  /** THE PRE-FX GATE (S7): a linear g0→g1 ramp over the scratch pair. */
  void applyGate(float g0, float g1, bool stereo, int n) const;
  /** THE OUTPUT STAGE (unification_audit.md §2.4): the scratch pair —
   * mono, or stereo — summed into the parent's channels at gain·pan
   * (balance law; a stereo pair folds to a mono device as equal
   * halves; channels ≥ 2 hear the fader-scaled unpanned mono). */
  void sumOutputStage(float* const* output_channels, int num_output_channels,
                      bool stereo, int n) const;

  // --- Take list (docs/takes.md; the public block above states the
  // ownership law) ---
  std::vector<TakeState> takes_;  // message thread; slot active_take_ empty
  std::atomic<int> active_take_{0};
  mutable bool take_files_dirty_ = false;  // session_io's rewrite flag
  // THE TAKE TABLE: the audio thread's view of the inactive buffers
  // and the comp, all-atomic behind one seqlock (the map's discipline)
  // — no heap, no reclaimer. take_buffers_[active] is null (the active
  // buffer is content_); a cell naming the active, an out-of-range or
  // a null entry reads the active buffer.
  SeqLock take_lock_;
  std::atomic<int> take_table_count_{0};
  std::atomic<const juce::AudioBuffer<float>*> take_buffers_[kMaxTakes]{};
  std::atomic<int> comp_n_{0};
  std::atomic<int64_t> comp_q_{0};
  std::atomic<int8_t> comp_cells_[kMaxCompCells]{};
  /** A consistent copy of the table for one render (audio thread). */
  struct CompView {
    int n = 0;
    int64_t q = 0;
    int count = 0;
    int active = 0;
    int8_t cells[kMaxCompCells] = {};
    const juce::AudioBuffer<float>* buffers[kMaxTakes] = {};
  };
  void readCompView(CompView& v) const;
  /** Republish take_buffers_ from the list (message thread, after any
   * list change and before a detached buffer retires). */
  void publishTakeTable();
  /** Grow `takes_` to hold the active slot when it is still empty. */
  void ensureTakeList();
  /** Move the live content into `slot` / adopt `slot` as the live
   * content (the two halves of selectTake). */
  void stashLive(TakeState& slot);
  void adoptSlot(TakeState& slot);
  /** The reservation + capture-fact reset shared by prepareRecording
   * and prepareRetake (message thread, Idle clip). */
  void reserveTakeStorage(int64_t through_map_commit_cycle);
  static juce::var audioPeaks(const juce::AudioBuffer<float>& buffer,
                              int64_t base, int total_samples, int num_peaks);
  static juce::var midiPeaks(const MidiSequence& seq, int64_t base,
                             int total_samples, int num_peaks);

  // --- New-take state (docs/takes.md) ---
  // The period the new take captures (its cap), set at arm on the
  // message thread; 0 = not a new take. Cleared at commit/cancel.
  std::atomic<int64_t> retake_period_{0};
  // Audio-thread commit/cancel outcome awaiting settleRetake.
  std::atomic<bool> retake_committed_{false};
  std::atomic<bool> retake_cancelled_{false};
  // Capture facts fixed at beginCapture (audio-thread plain fields):
  // the heard-length cap (a through-map pass or a new take's period; 0
  // = none) and the buffer offset capture writes at (a new take lands
  // at the shared content base; a fresh clip's is 0).
  int64_t capture_cap_ = 0;
  int64_t capture_base_ = 0;

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
  // computes the boundary from its own write position.
  std::atomic<bool> stop_requested_{false};
  // A parked group-stop generation (0 = none); becomes stop_requested_
  // at the block top whose context carries a generation >= this.
  std::atomic<uint32_t> stop_pending_gen_{0};
  // (origin_rt_ / origin_gate_gen_ / setOriginGated live on AudioNode
  // — stacks render with a gated origin too, Q18.)
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

  // Wiring facts written on the message thread and read by the audio
  // thread (capture, monitoring): atomic so the cross-thread read is a
  // defined one (a plain int here is a data race, however benign).
  std::atomic<int> preferred_input_channel{0};
  // Right input of a stereo pair; −1 = mono clip (the default).
  std::atomic<int> preferred_input_channel_right{-1};
  // Software input monitoring (Q20): off by default. Message-thread
  // toggle, audio-thread read per block.
  std::atomic<bool> monitor_{false};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

}  // namespace celestrian
