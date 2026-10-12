#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <utility>
#include <vector>

#include "audio_node.h"
#include "midi_sequence.h"
#include "take_storage.h"

namespace celestrian {

/**
 * A leaf node: a recorded slot — one origin, one period — holding one or
 * more takes, and its playback. Four jobs, one file each:
 *
 *   clip_node_capture.cc  the recording state machine (RecState): the
 *                         arm, capture, the stop boundary, the commit;
 *   clip_node_takes.cc    the content model: the take list and the comp,
 *                         a new take's settle, strip / restore, the
 *                         lock-collapse and the splice, load and import;
 *   clip_node_render.cc   playback: the render equation (timing.h) over
 *                         samples or notes, the live tail, the output
 *                         stage;
 *   clip_node.cc          construction, the content swaps, and what the
 *                         UI reads (metadata, peaks).
 *
 * THE CONTENT POINTERS. The audio buffer and the note sequence are each
 * reached through ONE atomic pointer (the one-pointer discipline,
 * AudioNode::fxChain). The message thread installs a successor through
 * swapContent / swapMidi and nowhere else; each hands back the displaced
 * owner, which the caller RETIRES — through the engine reclaimer, or
 * inside a log entry — and never frees inline: a render in flight may
 * still be reading it. One caller drops what it displaces in place: a
 * session load (the node is not yet in the graph). The audio thread
 * loads each pointer once per pass and writes through it only while
 * capturing, when the message thread swaps nothing.
 */
class ClipNode : public AudioNode {
 public:
  /**
   * The recording lifecycle (kernel.md §3): ONE explicit state.
   *
   *   Idle ──startRecording()──▶ Armed ──target reached──▶ Capturing
   *    ▲          (msg thread)     │        (audio thread)     │
   *    │◀── stopRecording() = cancel          stopRecording() ─┤
   *    │                                 = a request, taken up │
   *    │                                 at the next block top │
   *    │◀── commit ─── PendingStop ◀── Q > 0: a boundary ──────┤
   *    └◀── commit ◀── Q == 0 (the island's first take): there ┘
   *
   * "Committed" is Idle-with-content. The message thread arms, cancels
   * an arm, and ASKS for a stop; the audio thread starts capture, takes
   * the request up at a block top, picks the stop boundary and commits —
   * every commit is its own. An island's first take has no boundary to
   * finish at: it commits at the top that takes its stop up, at its
   * write head, and that block plays it. While Armed the target is
   * re-evaluated every block, so the latency-compensated clock can land
   * back on a boundary the raw clock has passed. A state's parameters
   * (awaiting_start_at, awaiting_stop_at) are written before the state
   * flips.
   *
   * THE END-OF-TAKE ORDER: the audio thread publishes a take's end (a
   * commit, a new take's cancel) as its facts — the duration, a new
   * take's outcome — then Idle, then the island's count (takeCommitted /
   * takeCancelled). A clip seen Idle holds every fact of its take, and
   * an island that counts no live take has every clip of the
   * performance settled: what AudioEngine::reconcileTakes reads.
   */
  enum class RecState : int { Idle = 0, Armed, Capturing, PendingStop };

  /** What a take's content is: AUDIO, samples captured from the assigned
   * device input(s); MIDI, notes captured from the MIDI input and
   * rendered through the chain's instrument slot (vst3.md §8). Decided
   * at arm from the clip's own chain, fixed for the take, and one kind
   * per slot (prepareRetake). The lifecycle and the render equation are
   * the same for both. */
  enum class ContentKind : int { Audio = 0, Midi };

  /** The engine passes the device's rate; the default serves node-level
   * tests. */
  ClipNode(juce::String name, double source_sample_rate = 44100.0);
  ~ClipNode() override = default;

  void control(const float* const* input_channels, int num_input_channels,
               const ProcessContext& context) override;
  void render(float* const* output_channels, int num_output_channels,
              const ProcessContext& context) const override;
  /** Peaks of the committed content; empty while a take is live (the
   * message thread reads content only in Idle). */
  juce::var getWaveform(int num_peaks) const override;
  NodeType getNodeType() const override { return NodeType::Clip; }
  int64_t getIntrinsicDuration() const override {
    return duration_samples.load();
  }
  juce::var getMetadata() const override;

  // --- Inputs ---
  /** The device input this clip records and monitors — the LEFT of a
   * stereo pair when a right input is set. inputFor resolves it against
   * the device. */
  void setInputChannel(int index) { preferred_input_channel.store(index); }
  int getInputChannel() const { return preferred_input_channel.load(); }
  /** The RIGHT input of a stereo pair; −1 keeps the clip mono. A take's
   * channel count is fixed at its arm. */
  void setInputChannelRight(int index) {
    preferred_input_channel_right.store(index);
  }
  int getInputChannelRight() const {
    return preferred_input_channel_right.load();
  }
  bool isStereoInput() const {
    return preferred_input_channel_right.load() >= 0;
  }
  /** SOFTWARE INPUT MONITORING (Q20, design_language.md §5): while on,
   * render adds this block's arrivals on the clip's input(s) to the dry
   * signal AHEAD of the gate and the rack, so the input is heard through
   * the clip's gate, chain, gain and pan like content — whatever the
   * take and the transport are doing, and through a rest handed down
   * from a group (ProcessContext::content_silent silences content, not
   * live input). Read from the pre-record ring: no latency beyond the
   * device round trip, and never in a bounce, which carries no ring.
   * Off by default; not undoable; saved, and captured by templates. */
  bool isMonitoring() const { return monitor_.load(); }
  void setMonitoring(bool on) { monitor_.store(on); }

  // --- Content ---
  int contentChannels() const { return content_.load()->getNumChannels(); }
  /** The kind of the current / last take (Audio until a MIDI take is
   * armed). Either thread. */
  ContentKind contentKind() const { return (ContentKind)content_kind_.load(); }
  /** This clip records and renders NOTES: it holds MIDI content, or it
   * is empty and its chain carries an instrument slot (the next take
   * will be MIDI). Message thread. */
  bool isMidiClip() const;
  /** The note sequence (the message thread reads it only in Idle). */
  const MidiSequence& midiSequence() const { return *midi_.load(); }
  const juce::AudioBuffer<float>& getAudioBuffer() const {
    return *content_.load();
  }
  /** Ask the next block to send the instrument the sound-off pair
   * (vst3.md §8.3) — the device-stop edge, where no block is running to
   * carry it. Any thread; consumed once. */
  void requestMidiSoundOff() { midi_sound_off_pending_.store(true); }
  double getSampleRate() const { return sample_rate; }
  /** The island cycle the slot's first take was performed against — the
   * modulus its display mark folds on (Q14); 0 for an island's first
   * take. Persisted. */
  int64_t contextCycle() const { return take_context_cycle_.load(); }

  // --- The recording verbs (message thread) ---
  struct TakeState;
  // THE ARM: a JUDGE, then two halves that cannot fail — so a GROUP arms
  // as one: every member is prepared first (slow where the OS does not
  // overcommit lazily), then the Armed states are published back to
  // back, one block top sees them all, and N mics share one origin.
  /** A first take may arm here: the clip is Idle. (Which clips an arm
   * targets — the empty ones — is the engine's to say.) */
  bool mayRecord() const { return recState() == RecState::Idle; }
  /** The first half, on a clip that may record: the take's storage is
   * reserved and the capture facts start over. `through_map_commit_cycle`
   * > 0 arms the take THROUGH an enclosing active map (time_maps.md §3):
   * it is C, the mapping node's full inner cycle, the dense span the
   * take commits at. Returns what the arm DISPLACED — the content its
   * storage replaced — for the caller to retire (the class comment). */
  TakeState prepareRecording(int64_t through_map_commit_cycle = 0);
  /** The second half: Idle → Armed. */
  void publishArm();
  /** Both halves, for one clip; nothing when it may not record. */
  TakeState startRecording(int64_t through_map_commit_cycle = 0);
  /** ASK a live take to stop. Armed: a cancel, here. Capturing: a
   * request the audio thread takes up at a block top (RecState) — the
   * take is still live when this returns. `group_generation` != 0 parks
   * the request until the island root publishes that generation, so
   * every member of a group takes it up at one block top. */
  void stopRecording(uint32_t group_generation = 0);
  /** Commit the take: `final_duration` > 0 names the boundary it
   * finishes at, else its length is what it holds (a first take, a
   * through-map cycle, a new take's period). AUDIO THREAD: `context` is
   * the block's. */
  void commitRecording(const ProcessContext& context,
                       int64_t final_duration = -1);
  /** Opens the content-sounds gate (is_playing), as a commit does. Not a
   * user verb (there is no per-node Play): tests use it. */
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
  /** From the moment a stop was asked for (the request is pending until
   * the audio thread picks the boundary). */
  bool isAwaitingStop() const {
    return recState() == RecState::PendingStop ||
           (recState() == RecState::Capturing &&
            (stop_requested_.load() || stop_pending_gen_.load() != 0));
  }
  int64_t getAwaitingStartAt() const { return awaiting_start_at.load(); }
  /** The last capture met its wall (wallGuard) and was finished there.
   * A diagnostic of the live take, cleared at the next arm. */
  bool capHit() const { return cap_hit_.load(); }

  // --- Take storage (take_storage.h states the law) ---
  /** The reservation bound, samples per channel (~6.7 h at 44.1 kHz:
   * juce sample counts are int). Integrity, not policy. */
  static constexpr int64_t kMaxTakeSamples = (int64_t{1} << 30);
  /** How much capture the grower keeps committed ahead of a take beyond
   * what the take needs to stop (~60 s at 48 kHz per channel) — how long
   * the message thread may stall before a take meets its wall. */
  static constexpr int64_t kArmCommitSamples = int64_t{48000} * 60;
  /** The blocks either side of a stop boundary: the request lands a
   * block before the boundary is chosen, and the block that crosses the
   * boundary is written whole. */
  static constexpr int64_t kStopSlackSamples = 8192;
  /** What a take still writes once a stop is asked for: on to its next
   * Q boundary (at most Q away), and the slack around it. */
  static int64_t stopRun(int64_t quantum) {
    return std::max<int64_t>(0, quantum) + kStopSlackSamples;
  }
  /**
   * THE TAKE'S REACH: the furthest sample (per channel, exclusive) the
   * live take may touch before the grower next runs — the one figure
   * the arm, the new take and the grower commit the storage to, and the
   * wall guard measures the write head against:
   *   - the dense spans a take owns whole from its arm — a through-map
   *     take's commit cycle [0, C); a new take's slot, i.e. its period
   *     behind the shared content base and the old extent of a collapsed
   *     slot (what an uncollapse would expose) — both cleared at arm;
   *   - ahead of the linear write head: the stop run, so a stop asked
   *     for now still reaches its boundary, plus kArmCommitSamples.
   * `quantum` is the island Q. Message thread.
   */
  int64_t takeReach(int64_t quantum) const;
  /** Commit the reserved storage out to the take's reach (nothing to do
   * for heap content). Message thread: the arm, and the engine's grower
   * on every poll while the take is live. */
  void commitTakeReach(int64_t quantum);
  int64_t contentCapacity() const { return content_.load()->getNumSamples(); }
  /** The samples per channel capture may write: the buffer's extent,
   * cut at the storage's committed edge. */
  int64_t writableCapacity() const;
  /** The recorded extent of the active take: storage samples from the
   * buffer's start, so ≥ base + duration after a lock-collapse (the
   * whole recording — what compaction must keep for an uncollapse). */
  int64_t recordedLength() const { return write_position.load(); }
  /** Install `fresh` as the audio content; returns the DISPLACED buffer
   * (the class comment: retire it). Message thread. */
  std::unique_ptr<juce::AudioBuffer<float>> swapContent(
      std::unique_ptr<juce::AudioBuffer<float>> fresh);
  /** The reserved storage behind the current content (null = heap). */
  TakeStorage* reservedStorage() const { return take_storage_.get(); }
  /** Detach the reserved storage once the buffer referring to it has
   * been swapped out; the caller retires it. Message thread. */
  std::unique_ptr<TakeStorage> releaseStorage();
  /** TEST-ONLY: mutable content access (wall-guard simulations). */
  juce::AudioBuffer<float>& contentForTest() { return *content_.load(); }
  /** TEST-ONLY: the samples the render scratch pair holds, both
   * channels together (a growth of either shows). */
  int renderScratchSamplesForTest() const {
    return (int)(fx_scratch_.size() + fx_scratch2_.size());
  }

  // --- The seam fade (kernel.md §2) ---
  /** Its length, 4 ms: long enough that no seam clicks, short enough to
   * hear as a cut, not a fade. */
  static int64_t seamFadeSamples(double sample_rate) {
    return (int64_t)(sample_rate * 0.004);
  }
  /** The declick ramp shared by the seam fade and the engine's
   * play-start fade: raised cosine, 0 → 1 at sample j of a `len`-sample
   * fade (sampled at centres, so the two ends mirror and a crossfading
   * pair sums to 1). */
  static float fadeRamp(int64_t j, int64_t len) {
    return 0.5f - 0.5f * std::cos(juce::MathConstants<float>::pi *
                                  ((float)j + 0.5f) / (float)len);
  }
  /** On in the app. The test runner turns it off so the kernel-law
   * oracles stay sample-exact; tests/seam_fade_tests.cc turns it back on
   * for its own checks. Process-wide; read once per render. */
  static inline std::atomic<bool> seam_fades_enabled{true};

  // --- The lock-collapse (composition.md §5) ---
  /** Where the committed content begins inside the storage buffer: 0
   * for a take as recorded; a collapse moves it to the trimmed window's
   * start. Content coordinates — the map, the playback phase, peaks, the
   * saved file — stay 0-based; every take of the slot shares the base. */
  int64_t getContentBase() const { return content_base_.load(); }
  /** The LEAF half of a lock-collapse: the window [shift, shift + len)
   * BECOMES the take — the content view moves by `shift`, the duration
   * is `len`, the window is consumed, and the top and the comp ride the
   * view. The cut material stays in the buffer, reachable only by the
   * uncollapse. The origin is the applier's (AudioEngine::collapseNode
   * moves the node's whole subtree once). */
  void collapseContent(int64_t shift, int64_t len);
  /** The inverse: the pre-collapse view, with the trim back as the
   * window [shift, shift + the current duration). */
  void uncollapseContent(int64_t shift, int64_t old_duration);
  /** The content is a collapsed window of a longer recording. */
  bool isCollapsed() const { return collapsed_from_.load() > 0; }
  /** The pre-collapse duration (0 when not collapsed). */
  int64_t collapsedFrom() const { return collapsed_from_.load(); }

  // --- Takes (takes.md §1) ---
  // A committed clip holds N takes of its ONE slot: alternate content
  // for the same origin, period and content base. The ACTIVE take is the
  // live content; the others sit in `takes_` as detached records, the
  // slot at the active index holding none (a single-take clip may keep
  // the list empty). A take is immutable once committed.
  /** A take, detached as one value; its holder OWNS the content. The
   * first group is what a take IS (exchangeLive is its one statement);
   * the slot facts ride only a WHOLE-clip strip and are at rest in a
   * list record. */
  struct TakeState {
    std::unique_ptr<juce::AudioBuffer<float>> buffer;
    std::unique_ptr<TakeStorage> storage;  // when `buffer` refers to it
    std::unique_ptr<MidiSequence> midi;
    int64_t recorded = 0;  // storage samples from the buffer's start
    int content_kind = 0;  // a ContentKind

    int64_t origin = 0, duration = 0, base = 0;
    int64_t context_cycle = 0, loop_start = 0, loop_end = 0;
    int64_t collapsed_from = 0;
    int64_t top = timing::kNoTop;
    int64_t retime = 0;
  };
  static constexpr int kMaxTakes = 32;
  static constexpr int kMaxCompCells = 256;
  /** 0 for an empty clip, else max(1, the list's size). */
  int takeCount() const;
  int activeTake() const { return active_take_.load(); }
  /** Take k's audio buffer / notes (the live content for the active
   * one); null when k is out of range. Idle. */
  const juce::AudioBuffer<float>* takeBuffer(int k) const;
  const MidiSequence* takeMidi(int k) const;
  /** Make take k the active one. False when k is out of range, already
   * active, or the clip is not Idle. */
  bool selectTake(int k);
  /** Detach take k (of two or more); an active k hands activity to its
   * lower neighbour (k − 1, else the new 0). */
  TakeState removeTake(int k);
  /** Reinsert a detached record at index k; activity stays where it is. */
  void insertTake(int k, TakeState&& s);
  /** Session load: append a further take behind the active take 0. */
  void appendLoadedTake(const juce::AudioBuffer<float>& audio);
  void appendLoadedMidiTake(std::vector<MidiEvent> events);
  /** THE MIRROR'S FLAG (session_io): every message-thread change to
   * committed content or its frame sets it, and the mirror rewrites the
   * clip's files when it is set. The audio-thread commit cannot:
   * AudioEngine::reconcileTakes marks the take when it settles. */
  bool takeFilesDirty() const { return take_files_dirty_; }
  void markTakeFilesDirty() { take_files_dirty_ = true; }
  void markTakeFilesWritten() const { take_files_dirty_ = false; }

  /** STRIP the committed take of a single-take clip: the clip returns
   * to EMPTY and the take — content and slot facts — comes back for the
   * log to own. */
  TakeState stripTake();
  /** Reinstall a stripped take on an empty clip. Returns the displaced
   * placeholders (the class comment: retire them). */
  std::pair<std::unique_ptr<juce::AudioBuffer<float>>,
            std::unique_ptr<MidiSequence>>
  restoreTake(TakeState&& s);

  /** A NEW TAKE (takes.md §2) may arm here: the clip is Idle with
   * content, its list has room, and its chain's kind is the slot's (one
   * kind per slot, or the list could not be saved as one clip). */
  bool mayRetake() const;
  /** The arm's first half for a further take of a clip that may take
   * one: the active content parks in its list slot and the clip is
   * silent until the take settles; origin, period, map and base stand.
   * Returns what the arm displaced, as prepareRecording does; publish
   * with publishArm(). */
  TakeState prepareRetake();
  /** A new take has committed or cancelled and awaits settleRetake. */
  bool retakeSettled() const {
    return retake_committed_.load() || retake_cancelled_.load();
  }
  /** Settle a finished new take: a COMMITTED one joins the list as the
   * active take (true); a CANCELLED one gives the slot back to the take
   * that was active, the abandoned reservation coming back in
   * `displaced` for the caller to retire (false). */
  bool settleRetake(TakeState& displaced);

  /** THE COMP: one take index per cell (−1 = the active take). Cell k
   * covers the inner positions [offset + k·cell_len, offset + (k + 1)·
   * cell_len): authored at offset 0 with cell_len = Q, and RIDING the
   * content view from then on — a lock-collapse slides the offset with
   * the material, so a cell keeps naming the stretch of the recording
   * it was drawn on, and cells the collapsed take no longer reaches stay
   * stored for the uncollapse. Empty = no comp. */
  std::vector<int> compCells() const;
  int64_t compCellLength() const { return take_[0].comp_q.load(); }
  int64_t compCellOffset() const { return take_[0].comp_off.load(); }
  void setCompCells(const std::vector<int>& cells, int64_t cell_len,
                    int64_t cell_offset = 0);
  /** Peaks of take k over the committed span (the take-list view). */
  juce::var getTakeWaveform(int k, int num_peaks) const;

  /** THE PEAK BUCKET: peak `i` of `n` over `total` samples covers the
   * base-relative span [⌊i·total/n⌋, ⌊(i+1)·total/n⌋) — proportional
   * bounds, so the last bucket reaches the take's end and no peak drifts
   * early at any density. Never empty: with n > total a bucket holds one
   * sample. JS twin: ui/js/mock/waveform.js peakBucket. */
  struct PeakBucket {
    int64_t start = 0;
    int64_t end = 0;
  };
  static PeakBucket peakBucket(int i, int64_t total, int n) {
    if (n <= 0 || total <= 0) return {};
    const int64_t start = (int64_t)i * total / n;
    return {start, std::max(start + 1, (int64_t)(i + 1) * total / n)};
  }

  // --- The splice (time_maps.md §5): a CUT map's lock-collapse ---
  // The kept cells BECOME the take: each take of the slot is copied,
  // cell after cell, into an exact-size buffer. ORDER: the other takes
  // and the notes first, then spliceToMap — it rewrites the content base
  // all three read. Each call returns what it displaced, for the edit's
  // inverse to own; the un-splice calls take those back and return the
  // spliced content to retire.
  /** The active take: duration := the map's period, origin +=
   * mapOffset(0) (playback is sample-identical to the mapped playback it
   * replaces), no window, base 0, the top at its heard offset. THE COMP
   * is consumed with the cut — the kept cells no longer sit on one grid
   * — so the take holds what the comp SOUNDED, read from `pre_splice`
   * (what spliceOtherTakesToMap returned), and the comp clears. */
  std::unique_ptr<juce::AudioBuffer<float>> spliceToMap(
      const timing::TimeMap& m,
      const std::vector<std::pair<int, TakeState>>* pre_splice = nullptr);
  /** The inverse: the pre-splice buffer and facts. The caller then puts
   * the cut map and the comp back. */
  std::unique_ptr<juce::AudioBuffer<float>> unspliceFromMap(
      std::unique_ptr<juce::AudioBuffer<float>> old_buffer, int64_t old_origin,
      int64_t old_duration, int64_t old_base, int64_t old_recorded,
      int64_t old_collapsed_from, int64_t old_top);
  /** A MIDI clip's notes: those inside the kept cells move to their
   * spliced positions, the rest are cut. */
  std::unique_ptr<MidiSequence> spliceMidiToMap(const timing::TimeMap& m);
  std::unique_ptr<MidiSequence> unspliceMidi(
      std::unique_ptr<MidiSequence> old_sequence);
  /** Every inactive take, as (index, pre-splice record) pairs. */
  std::vector<std::pair<int, TakeState>> spliceOtherTakesToMap(
      const timing::TimeMap& m);
  std::vector<TakeState> unspliceOtherTakes(
      std::vector<std::pair<int, TakeState>>&& old);

  // --- Session load and import ---
  /** Session load: `audio` becomes the committed content of a clip not
   * yet in the graph. The caller sets origin, duration, map and mute. */
  void loadCommitted(const juce::AudioBuffer<float>& audio,
                     int64_t context_cycle);
  /** The MIDI form: the events become the content and the clip a MIDI
   * clip. The duration is set first: it is the recorded extent. */
  void loadCommittedMidi(std::vector<MidiEvent> events, int64_t context_cycle);
  /** IMPORT (import.md): install a decoded buffer as the committed take
   * of an EMPTY idle clip that lives in the graph. Returns the displaced
   * placeholder to retire. The caller establishes the island and logs
   * the take. */
  std::unique_ptr<juce::AudioBuffer<float>> installImportedTake(
      std::unique_ptr<juce::AudioBuffer<float>> audio, int64_t origin,
      int64_t duration, int64_t loop_end, int64_t context_cycle);

 private:
  // --- Content (the class comment states the pointer law) ---
  std::unique_ptr<juce::AudioBuffer<float>> content_owned_;
  std::atomic<juce::AudioBuffer<float>*> content_{nullptr};
  std::unique_ptr<MidiSequence> midi_owned_;
  std::atomic<MidiSequence*> midi_{nullptr};
  // The reservation `content_owned_` refers to, when it does (null:
  // heap content). The audio thread reads the raw pointer for its wall.
  std::unique_ptr<TakeStorage> take_storage_;
  std::atomic<TakeStorage*> storage_rt_{nullptr};
  std::atomic<int> content_kind_{(int)ContentKind::Audio};
  // Samples, three meanings by phase. CAPTURING: heard samples written,
  // from the capture base (the write head). COMMITTED: the recorded
  // extent from the buffer's start, base included — max(base + written,
  // the old extent of a collapsed slot) for a new take (recordedLength).
  // A loaded MIDI take: its duration.
  std::atomic<int64_t> write_position{0};
  // Where the committed content begins in the buffer (getContentBase),
  // and the pre-collapse duration (0 = not collapsed).
  std::atomic<int64_t> content_base_{0};
  std::atomic<int64_t> collapsed_from_{0};
  // The content-sounds gate: the clip holds committed content and plays
  // it. NOT the transport (ProcessContext::is_playing); render needs
  // both. Down while a take is armed or live and on an empty clip.
  std::atomic<bool> is_playing{false};
  // Hz, fixed at construction: published as `sampleRate`, and the length
  // of the empty placeholder.
  double sample_rate;

  /** An empty clip's audio content: one zeroed second. Never zero-sized:
   * render folds positions on its length. */
  std::unique_ptr<juce::AudioBuffer<float>> makeEmptyContent() const;
  /** swapContent's twin for the note sequence. */
  std::unique_ptr<MidiSequence> swapMidi(std::unique_ptr<MidiSequence> fresh);

  // --- The take list (message thread) ---
  std::vector<TakeState> takes_;
  std::atomic<int> active_take_{0};
  mutable bool take_files_dirty_ = false;
  // THE TAKE TABLE: the audio thread's view of the inactive buffers and
  // the comp, all-atomic behind one seqlock (seq_locked.h: take_[0] the
  // primary, take_[1] the shadow; single-field readers read the
  // primary). buffers[active] is null — the active buffer is content_ —
  // and a cell naming the active take, an index out of range or a null
  // entry reads the active buffer.
  SeqLock take_lock_;
  struct TakeTableCopy {
    std::atomic<int> count{0};
    std::atomic<const juce::AudioBuffer<float>*> buffers[kMaxTakes]{};
    // Each inactive buffer's recorded extent: the seam fade reads past a
    // run's end only inside it.
    std::atomic<int64_t> recorded[kMaxTakes]{};
    std::atomic<int> comp_n{0};
    std::atomic<int64_t> comp_q{0};
    std::atomic<int64_t> comp_off{0};  // inner position of cell 0's start
    std::atomic<int8_t> comp_cells[kMaxCompCells]{};
  };
  TakeTableCopy take_[2];
  /** Republish the table from the list: after any list change, and
   * before a detached buffer may be retired. */
  void publishTakeTable();
  /** Slide the comp's cells by `delta` inner samples. */
  void shiftComp(int64_t delta);
  /** Grow `takes_` to hold the active slot when it is still empty. */
  void ensureTakeList();
  /** The content of no take, of `kind`: the empty placeholders. */
  TakeState emptyTake(ContentKind kind) const;
  /** Install `in` as the live take's content and return what was live —
   * the buffer with the storage it refers to, the notes, the recorded
   * extent, the kind. */
  TakeState exchangeLive(TakeState&& in);
  // A new take: its period (the capture's cap), set at arm; 0 = not a
  // new take. Cleared at commit / cancel, whose outcome waits in the two
  // flags for settleRetake.
  std::atomic<int64_t> retake_period_{0};
  std::atomic<bool> retake_committed_{false};
  std::atomic<bool> retake_cancelled_{false};

  static juce::var audioPeaks(const juce::AudioBuffer<float>& buffer,
                              int64_t base, int total_samples, int num_peaks);
  static juce::var midiPeaks(const MidiSequence& seq, int64_t base,
                             int total_samples, int num_peaks);

  // --- The recording state (clip_node_capture.cc) ---
  std::atomic<int> rec_state_{(int)RecState::Idle};
  // The message thread's stop request, consumed by the audio thread; and
  // a parked group stop's generation (0 = none), which becomes a request
  // at the block top whose context carries a generation >= it.
  std::atomic<bool> stop_requested_{false};
  std::atomic<uint32_t> stop_pending_gen_{0};
  // Two different clocks. Armed: the arm target, a moment on the HEARD
  // clock (0 = none yet). PendingStop: the commit boundary, a position
  // of the WRITE HEAD (heard samples into the take).
  std::atomic<int64_t> awaiting_start_at{0};
  std::atomic<int64_t> awaiting_stop_at{0};
  std::atomic<int64_t> take_context_cycle_{0};  // contextCycle()
  std::atomic<bool> cap_hit_{false};            // capHit()
  // Set by a commit, cleared at the next control pass: the commit block
  // renders SILENT, and playback begins on the block after. The one
  // commit that leaves it clear is a first take's at the block top that
  // takes its stop up (consumeStopRequest): that block plays.
  std::atomic<bool> committed_this_block_{false};
  // A through-map take's commit cycle C, set at arm (0 = a plain take);
  // cleared at commit / cancel.
  std::atomic<int64_t> map_commit_cycle_{0};

  // AUDIO-THREAD-ONLY capture facts (plain fields), fixed at beginCapture
  // and ended by the commit. The take's channel count is fixed earlier,
  // at arm: the Armed store publishes it.
  int capture_channels_ = 1;
  // The capture window (performance.md §3): content position p holds the
  // input that arrived at capture_next_clock_ + p on the input clock.
  int64_t capture_next_clock_ = 0;
  bool capture_uses_ring_ = false;
  bool underrun_logged_ = false;  // one log line per capture
  // The heard-length cap — one map pass, or a new take's period; 0 =
  // none — and where content position 0 sits in the buffer.
  int64_t capture_cap_ = 0;
  int64_t capture_base_ = 0;
  // A through-map take: the map shaping it, frozen when capture begins,
  // and the anchor's heard offset within the map's period.
  bool through_map_capture_ = false;
  timing::TimeMap take_map_{};
  int64_t map_anchor_off_ = 0;
  // A MIDI take: the arrival index of the write head, the next history
  // sequence number to read, the notes held now (the meter and the end
  // seam) and before the window opened (the prelude), and the log
  // latches.
  int64_t midi_capture_next_clock_ = 0;
  int64_t midi_history_cursor_ = 0;
  HeldNotes capture_held_;
  HeldNotes capture_prelude_;
  bool midi_prelude_folded_ = false;
  bool midi_lost_logged_ = false;
  bool midi_full_logged_ = false;

  /** A stop request, taken up at the block top: PendingStop at the
   * boundary chosen here; a new take's cancel; an island's first take's
   * commit. True when the take ended at this top. */
  bool consumeStopRequest(const ProcessContext& context);
  /** THE WALL GUARD — integrity, not policy: a take whose write head
   * nears its writable edge finishes at the last boundary that fits (a
   * first take, with no boundary, commits where it is — true). */
  bool wallGuard(const ProcessContext& context);
  /** One block of an audio take, from the pre-record ring, else the live
   * block, else silence. May commit (finishCaptureBlock). */
  void captureAudioBlock(const ProcessContext& context,
                         const float* const* input_channels,
                         int num_input_channels);
  /** One block of a MIDI take, from the arrival history, else the live
   * block. May commit. */
  void captureMidiBlock(const ProcessContext& context);
  /** Write `n` samples whose heard index starts at `heard_pos` into
   * channel `dest_ch`: linearly behind the capture base, or folded
   * through the take's map. */
  void captureWrite(juce::AudioBuffer<float>& buffer, int dest_ch,
                    int64_t heard_pos, const float* src, int n);
  /** Append one event at heard position `pos`, placed as captureWrite
   * places samples. */
  void captureMidiEvent(int64_t pos, const juce::uint8* bytes, int size,
                        float& block_peak);
  /** What every capture block ends with: the meter, the write head, and
   * the two commits a block can cross — the PendingStop boundary and
   * the cap. Nothing may touch capture state after it returns. */
  void finishCaptureBlock(int written, float block_peak,
                          const ProcessContext& context);
  /** How many more heard samples the take may write from write head
   * `wp`: to its writable edge, and to its cap. */
  int64_t captureSpace(int64_t wp) const;
  /** How many of `n` samples from storage position `start` lie inside
   * the writable extent. Every write into the live take is cut to this;
   * a cut means the reach was not committed ahead of the writer, and is
   * counted (TakeStorage::cut_writes). */
  int writableRun(int64_t start, int64_t n) const;
  /** Zero [0, end) of every channel of the live take's buffer. Message
   * thread, clip idle. */
  void clearTakeSpan(int64_t end);
  /** Where a live take's content position 0 sits in its buffer: a new
   * take lands at the slot's shared base, any other at 0. */
  int64_t captureBase() const {
    return retake_period_.load() > 0 ? content_base_.load() : 0;
  }
  /** Armed, once per block: choose the target; begin capture once it is
   * reached. */
  void armEvaluate(const ProcessContext& context);
  /** Armed → Capturing: fixes the capture window for `target`. */
  void beginCapture(const ProcessContext& context, int64_t target,
                    int64_t compensated_pos);
  /** An arm target is REACHED by the run — `n` samples — that takes the
   * heard clock, or `raw`, the uncompensated one, up to it or past it.
   * Judged per run, so a block a stack has split starts the take in the
   * run that holds the target, not in an earlier one. */
  static bool armReached(int64_t heard, int64_t raw, int n, int64_t target) {
    return heard + n >= target || (raw < target && raw + n >= target);
  }
  /** The arm's storage and capture-fact reset, shared by a plain arm and
   * a new take; returns the content the storage displaced. Message
   * thread, Idle clip. */
  TakeState reserveTakeStorage(int64_t through_map_commit_cycle);

  // --- Inputs ---
  // Written on the message thread, read by capture and monitoring.
  std::atomic<int> preferred_input_channel{0};
  std::atomic<int> preferred_input_channel_right{-1};  // −1 = mono
  std::atomic<bool> monitor_{false};
  /** WHICH INPUT IS THIS CLIP'S — one rule for capture and monitoring,
   * so what is monitored is what records. `side` 0 is the left (or mono)
   * input, 1 the right of a stereo pair; a mono clip's right follows its
   * left. An assignment the device cannot serve — none (−1), or past its
   * `channels` — is the nearest channel it has, so a take is never
   * silently empty. −1 only when there is no channel at all. */
  int inputFor(int side, int channels) const;
  /** `n` samples of a ring from position `clock`, as the straight span
   * [idx, idx + first) and — when the run wraps — the rest from 0. */
  struct RingSpan {
    int idx = 0;
    int first = 0;
  };
  static RingSpan ringSpan(int64_t clock, int n, int ring_len) {
    const int idx = (int)(clock % ring_len);
    return {idx, std::min(n, ring_len - idx)};
  }

  // --- Playback (clip_node_render.cc) ---
  // DSP scratch and view telemetry the const render writes
  // (AudioNode::render states the exception). The scratch pair carries
  // channel 0 and, for stereo, channel 1: content renders into it, the
  // gate and the rack work in place, the output stage sums it into the
  // parent. Sized at construction for the block ceiling
  // (kMaxBlockSamples): no block within it grows them.
  mutable std::vector<float> fx_scratch_;
  mutable std::vector<float> fx_scratch2_;
  // The most content and live events renderMidi takes in one block (a
  // denser block drops the rest), and the most it then hands
  // render_midi_: those, a note-off for every note the content had
  // sounding — carried into the block or struck in it — and one
  // sound-off pair per channel. render_midi_ is reserved for that at
  // construction, so no block grows it.
  static constexpr int kMaxBlockEvents = 4096;
  static constexpr int kMaxRenderMidiEvents =
      2 * kMaxBlockEvents + HeldNotes::kMaxHeld + 2 * kMidiChannels;
  // MIDI render state: the block's events, the notes the content has
  // sounding, whether content ran last block, and the storage position
  // the next run should continue from (−1 = none; a jump is a
  // discontinuity).
  mutable juce::MidiBuffer render_midi_;
  mutable HeldNotes render_held_;
  mutable bool midi_content_was_active_ = false;
  mutable int64_t midi_render_next_pos_ = -1;
  // The sound-off edges (vst3.md §8.3): the channels the instrument has
  // heard since the last pair, whether the gate was shut last block, and
  // the device-stop edge control latched for render to send (it clears
  // the latch when it does).
  mutable juce::uint16 midi_channels_in_use_ = 0;
  mutable bool midi_gate_was_closed_ = false;
  mutable bool midi_sound_off_due_ = false;
  // requestMidiSoundOff's flag: any thread sets it, control consumes it.
  std::atomic<bool> midi_sound_off_pending_{false};
  // Samples the chain still runs after the last event.
  mutable int64_t midi_tail_samples_left_ = 0;

  /** The arguments of the render equation (timing::innerAt) for this
   * block: the effective map — the active one, else the whole take —
   * the origin, and the fold: the map's period, or the context cycle for
   * a one-shot (AudioNode::period_from_context_). A period of 0: nothing
   * to play. */
  struct PlaybackFrame {
    timing::TimeMap map;
    int64_t origin = 0;
    int64_t fold = 0;
  };
  PlaybackFrame playbackFrame(const ProcessContext& context) const;
  /** Publish the view's cursor (AudioNode::playhead_pos) for clock `t`:
   * the heard phase as a fraction of the MAP period — what the view maps
   * through the map's segments — and 0 in a one-shot's rest. */
  void publishPlayhead(const PlaybackFrame& frame, int64_t t) const;
  /** The scratch pair holds `n` samples (`pair`: both channels). A
   * guard for a block past the ceiling — a test's, never a device's:
   * within kMaxBlockSamples it changes nothing. */
  void ensureScratch(int n, bool pair) const;
  /** Muted, or lost to a solo elsewhere (AudioNode::is_soloed). */
  bool isSilencedThisBlock(const ProcessContext& context) const;
  /** Monitoring is on and the context carries a pre-record ring. */
  bool monitorLive(const ProcessContext& context) const {
    return monitor_.load() && context.prerecord_ring != nullptr &&
           context.prerecord_ring_channels > 0 &&
           context.prerecord_ring_len > 0;
  }
  /** Add this block's arrivals on the clip's input(s) into the scratch
   * pair; a stereo input pair promotes a mono scratch. Returns whether
   * the pair is now stereo. */
  bool addMonitorInput(const ProcessContext& context, bool stereo) const;
  /** THE LIVE TAIL: what sounds when the content branch did not run the
   * rack this block (a stopped transport, an empty clip, a live take) —
   * the monitored input and / or MIDI play-through, once through the
   * gate, the rack and the output stage. */
  void renderLiveTail(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context, float gate_g0,
                      float gate_g1, bool user_shut) const;
  /** The pre-fx gate (AudioNode::gateEndpoints) over the scratch pair: a
   * linear g0 → g1 ramp. */
  void applyGate(float g0, float g1, bool stereo, int n) const;
  /** The scratch pair through the output stage (celestrian::
   * sumOutputStage) under this clip's pan and fader. */
  void sumOutputStage(float* const* output_channels, int num_output_channels,
                      bool stereo, int n) const;
  void renderMidi(float* const* output_channels, int num_output_channels,
                  const ProcessContext& context) const;
  void markChannelInUse(juce::uint8 status) const {
    if (status < 0xF0) {
      midi_channels_in_use_ |= (juce::uint16)(1u << (status & 0x0F));
    }
  }

  /** A consistent copy of the take table for one render. */
  struct CompView {
    int n = 0;
    int64_t q = 0;
    int64_t off = 0;
    int count = 0;
    int active = 0;
    int8_t cells[kMaxCompCells] = {};
    const juce::AudioBuffer<float>* buffers[kMaxTakes] = {};
    int64_t recorded[kMaxTakes] = {};
  };
  void readCompView(CompView& v) const;
  /** One run's read source: the channel of the buffer the comp names at
   * inner position `inner` (else the active buffer), its size, and the
   * raw extent [lo, hi) the seam fade may read beyond the run. The one
   * pick rule for content reads and the seam fade. */
  struct RunSource {
    const float* data = nullptr;
    int64_t cap = 0;
    int64_t lo = 0, hi = 0;
  };
  RunSource runSource(const juce::AudioBuffer<float>& active, int c,
                      int64_t inner, const CompView& comp) const;
  /** THE SEAM FADE (kernel.md §2): a pure pass over the rendered channel
   * `scratch` for the block [t, t + n) that smooths every seam within
   * `fade` samples of it — the loop wrap, a map splice, a comp cell
   * changing takes, a one-shot's edges — so a jump in the source never
   * reaches the speaker as a step. Stateless in t, like the render
   * equation: a bounce hears what playback does. */
  void applySeamFades(float* scratch, int c,
                      const juce::AudioBuffer<float>& active,
                      const CompView& comp, int64_t t, int n, int64_t origin,
                      const timing::TimeMap& map, int64_t fold,
                      int64_t fade) const;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ClipNode)
};

}  // namespace celestrian
