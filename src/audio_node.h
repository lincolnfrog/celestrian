#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>

#include "dsp/effects.h"
#include "timing.h"

namespace celestrian {

class AudioNode;

/**
 * Context for audio processing, passed down the recursive graph.
 * POD-only: this struct is copied per stack per block on the audio thread,
 * so it must never carry heap-owning members (e.g. juce::String).
 */
struct ProcessContext {
  // Default is a test-only fallback; the engine always overwrites this
  // with the actual device rate (cached in audioDeviceAboutToStart).
  double sample_rate = 44100.0;
  int num_samples = 0;
  bool is_playing = false;
  bool is_recording = false;

  // Global transport master position (in samples)
  int64_t master_pos = 0;

  // Latency compensation (in samples)
  int input_latency = 0;
  int output_latency = 0;

  // Solo state: resolved once by the engine on the message thread.
  // Null when nothing is soloed. Nodes compare pointers (never strings)
  // and walk their ancestor chain to honor soloed containers.
  const AudioNode *solo_node = nullptr;

  // The received frame's cycle top (time_maps.md): the engine sets this
  // to the island epoch; a stack with an ACTIVE loop window re-bases it
  // for its children to the window start. Window phase is always
  // (master_pos − cycle_epoch) mod window_len — a pure function of the
  // received clock, never of view state or a private counter.
  int64_t cycle_epoch = 0;

  // The recording context (P1-6, context passed DOWN): the longest
  // committed sibling duration in this scope — each stack overwrites it
  // for its children (recording children contribute 0 because their
  // duration resets at arm). A clip's arm math uses
  // max(Q, context_loop); leaves never inspect siblings.
  int64_t context_loop = 0;

  // --- Pre-record ring (docs/performance.md §3) ---
  // The engine continuously copies device input into a ring indexed by a
  // monotonic input clock (total input samples since engine start — unlike
  // master_pos it never wraps or resets). Recording clips read their
  // capture window from this ring instead of the live block, so a clip
  // position can map to any recent arrival time — including times earlier
  // in the current block or slightly in the past.
  // Null when no backend ring exists (unit tests driving nodes directly);
  // clips then fall back to live block capture.
  const float *const *prerecord_ring = nullptr;
  int prerecord_ring_len = 0;       // samples per channel
  int prerecord_ring_channels = 0;  // valid channels in the ring
  int64_t input_clock = 0;          // arrival index of this block's sample 0
};

/**
 * Enumeration of available node types in the Celestrian ecosystem.
 */
enum class NodeType { Clip, Stack, Unknown };

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
    obj->setProperty("x", (double)x_pos.load());
    obj->setProperty("y", (double)y_pos.load());
    obj->setProperty("w", (double)width.load());
    obj->setProperty("h", (double)height.load());
    obj->setProperty("currentPeak", (float)last_block_peak.load());
    if (isRecording())
      obj->setProperty("duration", (double)live_duration_samples.load());
    else
      obj->setProperty("duration", (double)duration_samples.load());
    obj->setProperty("loopStart", (double)loop_start_samples.load());
    obj->setProperty("loopEnd", (double)loop_end_samples.load());
    // Loop window state — fractal (I5): published for clips and stacks
    // alike; `playhead` carries the window phase while active.
    obj->setProperty("loopBypassed", (bool)loop_window_bypassed_.load());
    obj->setProperty("windowActive", isLoopWindowActive());
    // Built-in effect rack state (fractal like windows)
    obj->setProperty("effects", fx_.getMetadata());
    obj->setProperty("effectiveQuantum", (double)getEffectiveQuantum());
    obj->setProperty("playhead", (double)playhead_pos.load());
    obj->setProperty("isRecording", (bool)isRecording());
    obj->setProperty("isMuted", (bool)is_muted.load());
    // launchPoint is a PROJECTION of origin (kernel.md §2 table):
    // derived at read time, never stored. anchorPhase was deleted
    // outright (no consumer; the UI derives lane position from origin).
    obj->setProperty("launchPoint",
                     (double)timing::launchPointFor(origin_samples.load(),
                                                    duration_samples.load()));
    obj->setProperty("origin", (double)origin_samples.load());

    // Device-independent musical facts (Q12 / D-T3): the same values
    // projected onto the island's musical frame through the ONE law
    // (timing.h). These are the canonical facts the save format
    // serializes (sample fields above stay for the UI). `qSamples` is the
    // island exchange rate (physical) that reconstructs them on load.
    const int64_t q_samples = getEffectiveQuantum();
    const int64_t epoch = getIslandEpoch();
    obj->setProperty("qSamples", (double)q_samples);
    obj->setProperty(
        "originQ",
        qtimeVar(timing::originQ(origin_samples.load(), epoch, q_samples)));
    obj->setProperty(
        "periodQ",
        qtimeVar(timing::periodQ(duration_samples.load(), q_samples)));
    obj->setProperty("windowStartQ",
                     qtimeVar(timing::fromSamples(loop_start_samples.load(),
                                                  q_samples)));
    obj->setProperty(
        "windowEndQ",
        qtimeVar(timing::fromSamples(loop_end_samples.load(), q_samples)));
    return juce::var(obj);
  }

  /** A QTime as a {num, den} var for the metadata/persistence boundary. */
  static juce::var qtimeVar(timing::QTime q) {
    auto *o = new juce::DynamicObject();
    o->setProperty("num", (double)q.num);
    o->setProperty("den", (double)q.den);
    return juce::var(o);
  }

  void setName(const juce::String &new_name) { node_name = new_name; }
  juce::String getName() const { return node_name; }
  juce::String getUuid() const { return node_uuid; }
  /** Restore a persisted uuid on load (session_io) so save→load→save is
   * stable and references survive. Message thread, before the node joins
   * the graph. */
  void setUuid(const juce::String &u) { node_uuid = u; }

  virtual NodeType getNodeType() const = 0;

  virtual juce::String getNodeTypeString() const {
    switch (getNodeType()) {
      case NodeType::Clip:
        return "clip";
      case NodeType::Stack:
        return "stack";
      default:
        return "unknown";
    }
  }

  /** Actively capturing (or finishing to a stop boundary). */
  virtual bool isRecording() const { return false; }

  /**
   * The recording LIFECYCLE is active: armed, capturing, or pending
   * stop. Wider than isRecording() (an armed clip hasn't captured a
   * sample yet). Stacks answer for their subtree. This is what engine
   * bookkeeping (view freeze, epoch re-base, sibling context scans)
   * keys on. Audio-thread safe.
   */
  virtual bool isArmedOrRecording() const { return isRecording(); }

  /**
   * Returns the latest peak sample level for real-time visualization.
   */
  virtual float getCurrentPeak() const = 0;

  // Hierarchy
  void setParent(AudioNode *p) { parent.store(p); }
  AudioNode *getParent() const { return parent.load(); }

  /** Topmost node of this subtree — the island root under the current
   * one-island model. Audio-thread safe (atomic parent walk). */
  AudioNode *rootNode() {
    AudioNode *n = this;
    while (auto *p = n->getParent()) n = p;
    return n;
  }

  /**
   * Allocation-free child traversal (P1-8: replaces dynamic_cast
   * walks). Leaves are no-ops; StackNode iterates ONE published child
   * snapshot per call. Recursion is the visitor's choice: call
   * child->forEachChild(...) inside `fn`. Audio-thread safe.
   */
  virtual void forEachChild(void (*fn)(AudioNode *, void *),
                            void *user) const {
    (void)fn;
    (void)user;
  }

  /** Recursive UUID lookup (self included). */
  virtual AudioNode *findByUuid(const juce::String &uuid) {
    return getUuid() == uuid ? this : nullptr;
  }

  // --- Island / take-lifecycle events (no-ops except on the island
  // root, i.e. StackNode). Clips report their recording lifecycle to
  // `rootNode()` through these instead of the engine detecting edges by
  // scanning the graph every block (unification_audit.md §1.5).
  /** Establish (Q, epoch) if not yet locked; q == 0 sets a provisional
   * epoch only (first-clip arm — the epoch capture that replaced the
   * old transport reset). */
  virtual void establishIsland(int64_t quantum, int64_t epoch) {
    (void)quantum;
    (void)epoch;
  }
  /** A take was armed / cancelled / committed in this island. The
   * commit event carries the take's origin and drives the epoch
   * re-base (simple-extension rule) — see StackNode. */
  virtual void takeArmed() {}
  virtual void takeCancelled() {}
  virtual void takeCommitted(int64_t origin) { (void)origin; }
  /** Any take currently armed or capturing in this island. */
  virtual bool hasActiveTake() const { return false; }
  /** The HEARD island cycle the CURRENT take generation was armed
   * against — the EFFECTIVE cycle (E-C: active windows shorten it), 0
   * when no take is active / first take. Clips snapshot this at
   * capture start: it is the take's heard frame (`contextCycle`), the
   * modulus that folds "which cycle" out of its display anchor (Q14)
   * AND the audible-equivalence step for the origin fold (Q15). */
  virtual int64_t activeTakeHeardCycle() const { return 0; }
  /** The INTRINSIC committed cycle at arm (windows ignored) — the
   * frame modulus for the origin fold and the growth baseline for the
   * commit epoch re-base. Windows are reversible view-of-time state
   * and must not leak into either permanently. */
  virtual int64_t activeTakeIntrinsicCycle() const { return 0; }

  void setLoopPoints(int64_t start, int64_t end) {
    loop_start_samples.store(start);
    loop_end_samples.store(end);
  }

  int64_t getLoopStart() const { return loop_start_samples.load(); }
  int64_t getLoopEnd() const { return loop_end_samples.load(); }

  // --- Loop window state (time_maps.md phase 1, fractal per I5) ---
  /**
   * Whether the loop window is bypassed. A window is ACTIVE iff it is
   * valid (end > start) and not bypassed — independent of expansion
   * (I6b: collapse is purely visual). Lives on the BASE node: a clip's
   * loop region is the single-segment case of the stack's time-map
   * (time_maps.md "one implementation, fractal"), so window state and
   * its toggle apply uniformly to clips and stacks.
   */
  bool isLoopWindowBypassed() const { return loop_window_bypassed_.load(); }
  void setLoopWindowBypassed(bool bypassed) {
    loop_window_bypassed_.store(bypassed);
  }
  bool isLoopWindowActive() const {
    return !loop_window_bypassed_.load() &&
           loop_end_samples.load() > loop_start_samples.load();
  }

  // --- Built-in effects (docs/ui_overhaul.md effects bar) ---
  /**
   * The node's effect rack — FRACTAL like windows: a clip's rack
   * processes its rendered playback; a stack's rack processes the
   * summed group (so a stack reverb wets the whole kit). Mutations
   * (enable/params) happen on the message thread through AudioEngine;
   * the audio thread only reads atomics. prepare() before enable.
   */
  dsp::EffectRack &effects() { return fx_; }
  const dsp::EffectRack &effects() const { return fx_; }

  /**
   * The node's audible period in its parent's frame (E-C,
   * design_language.md): an ACTIVE loop window makes the node behave
   * as a window-length clip in the parent's LCM. This is exact, not an
   * approximation — window phase is island-clock derived, so island
   * times t and t+len map to identical child times: the subtree's
   * output is periodic in exactly the window length. Without a window,
   * the intrinsic duration. StackNode overrides the windowless case to
   * LCM its children's effective periods (nested windows shorten it).
   */
  virtual int64_t getEffectivePeriod() const {
    if (isLoopWindowActive()) {
      return loop_end_samples.load() - loop_start_samples.load();
    }
    return getIntrinsicDuration();
  }

  // Quantum Logic
  virtual int64_t getIntrinsicDuration() const = 0;
  virtual int64_t getEffectiveQuantum() const {
    if (auto *p = parent.load()) return p->getEffectiveQuantum();
    return 0;
  }

  /**
   * The island's cycle epoch: the master-clock moment of the visual cycle
   * top. ALL cycle-relative projections (anchors, slots, effective
   * positions) must be computed relative to this — mixing epoch-relative
   * views with absolute-frame math re-splits audio from visuals.
   */
  virtual int64_t getIslandEpoch() const {
    if (auto *p = parent.load()) return p->getIslandEpoch();
    return 0;
  }

  // Freeform canvas position for TOP-LEVEL stacks only — an opaque
  // blob the engine persists for the frontend (ui.md). Clips never
  // write these: lane x is a UI projection of `origin` (I6).
  std::atomic<double> x_pos{0.0}, y_pos{0.0};
  std::atomic<double> width{200.0}, height{100.0};

  // Transport state
  std::atomic<double> playhead_pos{0.0};          // 0.0 to 1.0 (normalized)
  std::atomic<int64_t> duration_samples{0};       // Length of the loop
  std::atomic<int64_t> live_duration_samples{0};  // Live count during recording
  std::atomic<int64_t> loop_start_samples{0};
  std::atomic<int64_t> loop_end_samples{0};
  // Loop window bypass flag (time_maps.md). Window phase is pure
  // arithmetic on the received clock — no private counter, fractal.
  std::atomic<bool> loop_window_bypassed_{false};

  // Built-in effect rack (dsp/effects.h): fixed slots, all-atomic
  // parameters — safe for the audio thread to read while the message
  // thread edits.
  dsp::EffectRack fx_;
  std::atomic<bool> is_muted{false};
  std::atomic<bool> is_expanded{
      true};  // UI state: expanded (true) or collapsed (false)
  std::atomic<float> last_block_peak{0.0f};

  // THE canonical timing fact (docs/kernel.md): the cycle moment this
  // node's content[0] belongs to, in performance-time samples. Set once
  // when recording starts. Launch point, anchor, and visual x are all
  // projections of this value.
  std::atomic<int64_t> origin_samples{0};

  // Atomic because the audio thread walks parent chains (quantum lookup,
  // solo ancestry) while the message thread reparents nodes during
  // reorder/combine operations.
  std::atomic<AudioNode *> parent{nullptr};

 protected:
  juce::String node_name;
  juce::String node_uuid;
};

}  // namespace celestrian
