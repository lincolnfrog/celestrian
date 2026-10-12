#pragma once

/**
 * AudioNode — the fractal node of the Celestrian graph: a ClipNode (a
 * leaf: one take, audio samples or MIDI notes) or a StackNode (a
 * container that sums its children). Stacks nest without limit; the
 * session root is a stack — the island root that owns Q and the zero.
 *
 * PHASES (performance.md §1): each block runs control() over the whole
 * graph — the mutating pass: recording decisions, capture, take
 * lifecycle — then render(), a CONST pass that only produces output for
 * the received clock.
 *
 * SIGNAL PATH, the same for every node: render (leaf) or sum (stack) →
 * time-map → pre-fx gate (gateEndpoints) → fx rack → gain·pan
 * (sumOutputStage) → parent.
 *
 * THREADING (performance.md §1): the audio thread never walks a parent
 * pointer and never reads a stack's ownership vector — the message
 * thread reparents and resizes them unsynchronized. Structure reaches
 * it as the whole-graph snapshot (ProcessContext::snap,
 * graph_snapshot.h) and island facts as fields of the ProcessContext a
 * parent hands DOWN to each child. Parent pointers, the ownership tree
 * and every function that walks them are MESSAGE THREAD ONLY.
 */

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>

#include "dsp/fx_chain.h"
#include "midi_input_queue.h"
#include "seq_locked.h"
#include "timing.h"

namespace celestrian {

class AudioNode;
struct GraphSnapshot;

/**
 * The per-block facts, passed DOWN the graph: the engine builds one per
 * callback and every stack copies and re-scopes it for its children
 * (StackNode::childContext). POD-only: it is copied per stack per run on
 * the audio thread, so it must never carry a heap-owning member.
 *
 * Field groups:
 *  - Clocks: master_pos is the RECEIVED clock (re-based and folded by
 *    each mapping stack on the way down — what render positions
 *    against); island_pos / island_zero are the INVARIANT island clock
 *    and its origin; frame_top is the received frame's cycle top.
 *  - Island facts: quantum, island (the lifecycle-event target), and the
 *    island / stop generations that let the audio thread adopt a
 *    multi-field edit as one fact.
 *  - Scope: context_cycle (the one scope cycle, composition.md §3), the
 *    innermost active map with its origin and heard top, gate_g0/g1,
 *    content_silent and resting, any_solo.
 *  - Capture: input_latency, the pre-record ring + input_clock,
 *    live_midi, midi_history + midi_latency.
 *  - Structure: snap + self.
 *
 * BLOCK-RELATIVE fields — gate_g0/g1 and live_midi — describe THIS
 * context's [0, num_samples). Whoever hands down a shorter run must
 * re-slice both, otherwise a gate ramp replays per run and a MIDI event
 * arrives twice or never (StackNode::forEachSeamRun is that hand-down).
 */
struct ProcessContext {
  // Hz. The engine sets the device rate; the default serves tests.
  double sample_rate = 44100.0;
  int num_samples = 0;
  bool is_playing = false;

  // Samples, RECEIVED frame: the transport position at the root,
  // re-based and folded by each mapping stack on the way down.
  int64_t master_pos = 0;

  // Samples: the round trip a performer plays against — device input +
  // output latency, or the calibrated value. Set by the engine.
  int input_latency = 0;

  // Any node in the island is soloed (AudioNode::is_soloed). Set by the
  // engine once per callback.
  bool any_solo = false;

  // Samples, received frame: the cycle top — an unanchored stack's
  // frame origin (AudioNode::frameOrigin). The engine sets the island
  // zero; a mapping stack and a cued step re-base it (childContext).
  int64_t frame_top = 0;

  // The pre-record ring (performance.md §3): recent device input,
  // indexed by input_clock, so a take can read any recent arrival time.
  // Null in node-level tests: clips then capture the live block.
  const float* const* prerecord_ring = nullptr;
  int prerecord_ring_len = 0;       // samples per channel
  int prerecord_ring_channels = 0;  // valid channels in the ring
  // Samples: the arrival index of this context's sample 0 — total input
  // since engine start, never wrapped or reset.
  int64_t input_clock = 0;

  // The whole-graph snapshot (one engine load per callback) and this
  // node's entry index in it, set by its parent. Never null in process.
  const GraphSnapshot* snap = nullptr;
  int self = 0;

  // Island facts, set by the engine and never re-scoped on the way
  // down: quantum (samples per Q, 0 = unestablished), island_zero
  // (samples, island frame) and the island root — the target of the
  // take-lifecycle events, never null in process.
  int64_t quantum = 0;
  int64_t island_zero = 0;
  AudioNode* island = nullptr;

  // Samples: the scope cycle — a one-shot's period and the grid a take
  // wraps on. Set by each stack for its children (period_law::scopeCycle).
  int64_t context_cycle = 0;

  // Samples, ISLAND frame: the engine's transport position, never
  // folded on the way down. Through-map arm triggers compare against
  // it: the folded master_pos wraps every map period and never crosses
  // a target at or past the map's end.
  int64_t island_pos = 0;
  // The island root's group-stop generation, read once per callback:
  // every member parked on it stops at the block top that first sees
  // it, so N mics commit one duration.
  uint32_t stop_generation = 0;
  // The island generation, read once per callback with (Q, zero): gates
  // origin adoption (AudioNode::adoptOriginGate).
  uint32_t island_generation = 0;
  // Block-relative: this context's incoming MIDI (vst3.md §8), drained
  // once per callback by the engine. Only the midi-armed node consumes
  // it. Null in node-level tests and with no MIDI device.
  const juce::MidiBuffer* live_midi = nullptr;
  // The arrival-indexed MIDI history a take captures from
  // (midi_input_queue.h). Null in node-level tests: live_midi stands in.
  const MidiHistory* midi_history = nullptr;
  // Samples: a MIDI arrival's compensation — OUTPUT latency only (a key
  // pressed on the heard beat reaches the callback that much later).
  // Content position of an arrival = heard time − this.
  int midi_latency = 0;

  // Block-relative: the parent sequence's dry-gain ramp for this node,
  // linear endpoints over [0, num_samples); 1,1 when ungated. Composed
  // into the pre-fx gate (AudioNode::gateEndpoints).
  float gate_g0 = 1.0f;
  float gate_g1 = 1.0f;

  // Every leaf renders silence in place of content while gates, racks
  // and output stages run on. Set past a bounced span (bounce.md) and by
  // a resting one-shot stack for its subtree (StackNode::childContext).
  bool content_silent = false;
  // WHY the content is silent, for content that tells a pause from an
  // end (a MIDI clip's notes, vst3.md §8.3). True: a one-shot stack
  // above is in its REST — the content sounds again at the next firing.
  // False under content_silent: the content has STOPPED. Set only by
  // StackNode::childContext, and never over a stop handed down to it.
  bool resting = false;

  // The innermost enclosing ACTIVE map (empty = none), set by the
  // mapping stack for its subtree, in samples. map_origin is that
  // stack's origin O — the map's inner positions are offsets from it
  // (Q18, composition.md §2). map_heard_top = O + mapOffset(0), the
  // heard grid anchor: pass tops fall at island times ≡ it mod
  // map.period().
  timing::TimeMap map{};
  int64_t map_heard_top = 0;
  int64_t map_origin = 0;
};

enum class NodeType { Clip, Stack, Unknown };

/** The period-source knob (Q5): a LOOP's period is its own length; a
 * ONE-SHOT's is the context cycle — it sounds once per scope cycle at
 * its origin, then rests. */
enum class PeriodSource { OWN_LENGTH, CONTEXT_CYCLE };

/** Pan gains, BALANCE law: center is unity on both channels and panning
 * attenuates the far channel only, so a full-scale take hard-panned
 * cannot clip the device. pan ∈ [−1 (L) .. +1 (R)]. */
inline void panGains(float pan, float& gain_l, float& gain_r) {
  const float p = pan < -1.0f ? -1.0f : (pan > 1.0f ? 1.0f : pan);
  gain_l = p > 0.0f ? 1.0f - p : 1.0f;
  gain_r = p < 0.0f ? 1.0f + p : 1.0f;
}

/** The output-stage gains, the last step of the signal path: `gl`/`gr`
 * are the balance-law pan gains scaled by the fader; `fader` alone
 * scales a mono or extra channel, where pan does not apply. Mute is
 * never a fader value (gateEndpoints). */
inline void outputStageGains(float pan, float gain, float& gl, float& gr,
                             float& fader) {
  panGains(pan, gl, gr);
  fader = gain;
  gl *= fader;
  gr *= fader;
}

/** THE OUTPUT STAGE, the one every node's signal leaves through: `l` —
 * and `r` when the signal is stereo (null: mono) — summed into the
 * parent's `n_out` channels under outputStageGains(pan, gain). Channel 0
 * is L and 1 is R: a mono signal pans between them, a stereo one
 * balances. A stereo pair folds to a mono device as equal halves; a
 * channel past the pair gets `l` at the fader. Null channels are
 * skipped. Audio thread: no heap, no locks. */
inline void sumOutputStage(float* const* out, int n_out, const float* l,
                           const float* r, int n, float pan, float gain) {
  if (out == nullptr) return;
  float gl = 1.0f, gr = 1.0f, fader = 1.0f;
  outputStageGains(pan, gain, gl, gr, fader);
  const bool pair_out = n_out >= 2;
  for (int ch = 0; ch < n_out; ++ch) {
    if (out[ch] == nullptr) continue;
    if (r != nullptr && !pair_out) {
      if (fader <= 0.0f) continue;
      juce::FloatVectorOperations::addWithMultiply(out[ch], l, 0.5f * fader, n);
      juce::FloatVectorOperations::addWithMultiply(out[ch], r, 0.5f * fader, n);
      continue;
    }
    const bool right = pair_out && ch == 1;
    const float* src = right && r != nullptr ? r : l;
    const float g = pair_out && ch < 2 ? (right ? gr : gl) : fader;
    if (g == 1.0f) {
      juce::FloatVectorOperations::add(out[ch], src, n);
    } else if (g > 0.0f) {
      juce::FloatVectorOperations::addWithMultiply(out[ch], src, g, n);
    }
  }
}

/** The node base (see the file header). */
class AudioNode {
 public:
  AudioNode(juce::String node_name)
      : node_name(std::move(node_name)), node_uuid(juce::Uuid().toString()) {}
  virtual ~AudioNode() {
    // Nodes only die via the reclaimer (2-callback grace), so no
    // in-flight audio can still be reading the chain here.
    delete chain_.load();
  }

  /** CONTROL phase: everything that decides or captures — arm targets,
   * stop boundaries, input capture, commit (and its one island write,
   * the first establishment). Mutates node state; renders nothing. */
  virtual void control(const float* const* input_channels,
                       int num_input_channels,
                       const ProcessContext& context) = 0;

  /** RENDER phase: the playback equation as a pure function of
   * (structure, settled state, received clock). CONST: render decides
   * nothing and mutates no musical state. The `mutable` members it
   * writes are the one sanctioned exception: DSP scratch (mix and fx
   * buffers, effect and gate-ramp state, the fx scope) and view
   * telemetry (playhead_pos). Nothing musical may join them. */
  virtual void render(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const = 0;

  /** control, then render. NON-virtual: called at the root, it settles
   * every decision in the graph before the first sample renders, so
   * render never observes state that changes mid-pass. Node-level tests
   * call it on one node with a context built the way the callback
   * builds one (tests/test_utils.h NodeContext). */
  void process(const float* const* input_channels,
               float* const* output_channels, int num_input_channels,
               int num_output_channels, const ProcessContext& context) {
    jassert(context.snap != nullptr && context.island != nullptr);
    control(input_channels, num_input_channels, context);
    render(output_channels, num_output_channels, context);
  }

  /** `num_peaks` waveform peaks for the UI. Message thread. */
  virtual juce::var getWaveform(int num_peaks) const = 0;

  /** The node's published state for the UI. Message thread. */
  virtual juce::var getMetadata() const {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", node_uuid);
    obj->setProperty("name", node_name);
    obj->setProperty("type", getNodeTypeString());
    obj->setProperty("currentPeak", (float)last_block_peak.load());
    if (isRecording())
      obj->setProperty("duration", (double)live_duration_samples.load());
    else
      obj->setProperty("duration", (double)duration_samples.load());
    const timing::TimeMap stored = storedMap();
    obj->setProperty("loopStart", (double)(stored.n == 1 ? stored.segs[0].start : 0));
    obj->setProperty("loopEnd", (double)(stored.n == 1 ? stored.segs[0].end : 0));
    obj->setProperty("loopBypassed", (bool)loop_window_bypassed_.load());
    obj->setProperty("windowActive", isLoopWindowActive());
    // "own" = a loop, "context" = a one-shot (Q5).
    obj->setProperty("periodSource",
                     period_from_context_.load() ? "context" : "own");
    // A multi-segment map: flat [s0, e0, s1, e1, ...] in samples.
    if (stored.n >= 2) {
      juce::Array<juce::var> segs;
      for (int i = 0; i < stored.n; ++i) {
        segs.add((double)stored.segs[i].start);
        segs.add((double)stored.segs[i].end);
      }
      obj->setProperty("segments", segs);
    }
    obj->setProperty("loopTop", (double)effectiveTop());
    obj->setProperty("retime", (double)retime_.load());
    // {chain: [...slots], scope?}: the chain array doubles as the save
    // format (vst3.md §6); the scope is present only while a panel
    // watches.
    {
      const dsp::FxChain* chain = chain_.load();
      juce::DynamicObject::Ptr fx = new juce::DynamicObject();
      fx->setProperty("chain", chain->getMetadata());
      const juce::var scope =
          fx_scope_.metadataVar(chain->compressorGainReductionDb());
      if (!scope.isVoid()) fx->setProperty("scope", scope);
      obj->setProperty("effects", juce::var(fx.get()));
    }
    obj->setProperty("effectiveQuantum", (double)getEffectiveQuantum());
    obj->setProperty("playhead", (double)playhead_pos.load());
    obj->setProperty("isRecording", (bool)isRecording());
    obj->setProperty("isMuted", (bool)is_muted.load());
    obj->setProperty("midiArmed", (bool)midi_armed.load());
    obj->setProperty("isSoloed", (bool)is_soloed.load());
    obj->setProperty("pan", (double)pan.load());
    obj->setProperty("gain", (double)gain.load());
    obj->setProperty("origin", (double)origin_samples.load());
    // A stack's origin is a stored fact only once anchored (Q18).
    obj->setProperty("anchored", (bool)anchored_.load());

    // The same facts as QTime (Q12, timing.h) — what the save format
    // serializes; `qSamples` is the exchange rate that restores them.
    const int64_t q_samples = getEffectiveQuantum();
    const int64_t zero = getIslandZero();
    obj->setProperty("qSamples", (double)q_samples);
    obj->setProperty("originQ", qtimeVar(timing::originQ(origin_samples.load(),
                                                         zero, q_samples)));
    obj->setProperty("periodQ", qtimeVar(timing::periodQ(
                                    duration_samples.load(), q_samples)));
    obj->setProperty(
        "windowStartQ",
        qtimeVar(timing::fromSamples(getLoopStart(), q_samples)));
    obj->setProperty("windowEndQ", qtimeVar(timing::fromSamples(
                                       getLoopEnd(), q_samples)));
    return juce::var(obj);
  }

  /** A QTime as a {num, den} var for the metadata/persistence boundary. */
  static juce::var qtimeVar(timing::QTime q) {
    auto* o = new juce::DynamicObject();
    o->setProperty("num", (double)q.num);
    o->setProperty("den", (double)q.den);
    return juce::var(o);
  }

  void setName(const juce::String& new_name) { node_name = new_name; }
  juce::String getName() const { return node_name; }
  juce::String getUuid() const { return node_uuid; }
  /** Restore a persisted uuid on load, so save→load→save is stable.
   * Message thread, before the node joins the graph. */
  void setUuid(const juce::String& u) { node_uuid = u; }

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

  /** The recording LIFECYCLE is active: armed, capturing or pending
   * stop — wider than isRecording() (an armed clip has captured
   * nothing yet). A clip answers from its state machine; a stack
   * answers for its subtree from the ownership tree (message thread). */
  virtual bool isArmedOrRecording() const { return isRecording(); }

  // Hierarchy: message thread only (the threading note above).
  void setParent(AudioNode* p) { parent.store(p); }
  AudioNode* getParent() const { return parent.load(); }

  /** The topmost node of this subtree — the island root. */
  AudioNode* rootNode() {
    AudioNode* n = this;
    while (auto* p = n->getParent()) n = p;
    return n;
  }

  /** Recursive UUID lookup (self included). */
  virtual AudioNode* findByUuid(const juce::String& uuid) {
    return getUuid() == uuid ? this : nullptr;
  }

  // --- Island / take-lifecycle events: no-ops except on the island
  // root (a StackNode). A clip reports its recording lifecycle to the
  // island root through these, so the engine detects no edges.
  /** Establish (Q, zero) if Q is not yet set; quantum == 0 sets a
   * provisional zero only (the first clip's arm moment — the clock
   * itself is never reset). */
  virtual void establishIsland(int64_t quantum, int64_t zero) {
    (void)quantum;
    (void)zero;
  }
  /** A take was armed / cancelled / committed: the island root counts
   * its live takes (hasActiveTake). A commit moves no island fact
   * (frame.md). takeArmed() walks the ownership tree, so it is MESSAGE
   * THREAD ONLY; cancel and commit are called from the audio thread. */
  virtual void takeArmed() {}
  virtual void takeCancelled() {}
  virtual void takeCommitted() {}
  /** Any take armed or capturing in this island. */
  virtual bool hasActiveTake() const { return false; }
  /** The HEARD island cycle the current take generation was armed
   * against (active windows shorten it); 0 with no take, and for the
   * first. A clip snapshots it at capture start as its take's context
   * frame — the modulus its display anchor folds on (Q14). */
  virtual int64_t activeTakeHeardCycle() const { return 0; }

  // --- THE MAP (time_maps.md §2, composition.md §1) ---
  // A node's geometry is ONE TimeMap value: n == 0 none, n == 1 a loop
  // window, n >= 2 a cell/punch map. It is stored inline behind a
  // seqlock (seq_locked.h): the message thread writes whole values and
  // the audio thread reads a consistent copy.
  /** The stored geometry, bypass ignored (either thread). */
  timing::TimeMap storedMap() const {
    timing::TimeMap m;
    map_lock_.read([&](int slot) {
      const MapCopy& c = map_[slot];
      m.n = c.n.load(std::memory_order_relaxed);
      for (int i = 0; i < timing::TimeMap::kMaxSegments; ++i) {
        m.segs[i].start = c.start[i].load(std::memory_order_relaxed);
        m.segs[i].end = c.end[i].load(std::memory_order_relaxed);
      }
    });
    if (m.n < 0 || m.n > timing::TimeMap::kMaxSegments) m.n = 0;
    return m;
  }
  /** Replace the geometry (message thread). n == 0 clears it. */
  void setMap(const timing::TimeMap& m) {
    map_lock_.write([&](int slot) {
      MapCopy& c = map_[slot];
      c.n.store(m.n, std::memory_order_relaxed);
      for (int i = 0; i < timing::TimeMap::kMaxSegments; ++i) {
        c.start[i].store(i < m.n ? m.segs[i].start : 0,
                         std::memory_order_relaxed);
        c.end[i].store(i < m.n ? m.segs[i].end : 0,
                       std::memory_order_relaxed);
      }
    });
  }
  /** The single-window form: [start, end) as one segment (none when
   * end <= start). */
  void setLoopPoints(int64_t start, int64_t end) {
    setMap(timing::TimeMap::single(start, end));
  }
  /** The single window's bounds; (0, 0) when there is none or the
   * geometry is a multi-segment map (see hasSegmentMap). */
  int64_t getLoopStart() const {
    const timing::TimeMap m = storedMap();
    return m.n == 1 ? m.segs[0].start : 0;
  }
  int64_t getLoopEnd() const {
    const timing::TimeMap m = storedMap();
    return m.n == 1 ? m.segs[0].end : 0;
  }
  /** True when the geometry is a cell/punch map (n >= 2). */
  bool hasSegmentMap() const { return storedMap().n >= 2; }
  /** timing::regionStart of this node: where an unset top reads. */
  int64_t regionStart() const {
    return timing::regionStart(storedMap(), isLoopWindowActive());
  }

  // --- THE TOP AND THE RE-TIME (loop_selection.md §9): message-thread
  // facts of every loop node, clip or group. THE TOP (↺) is a raw inner
  // position, or timing::kNoTop on a node never edited; every map edit
  // reconciles and stores it inside its applier, so undo restores it
  // with the map (time_map.h states the law). THE RE-TIME is the
  // cumulative USER shift of the origin in samples (0 = as played):
  // only setTiming moves it, by exactly what it moved the origin — the
  // continuity re-anchor, a Q13 re-trim, a collapse and a seek move the
  // origin without counting.
  int64_t storedTop() const { return loop_top_.load(); }
  void setStoredTop(int64_t t) { loop_top_.store(t); }
  int64_t retime() const { return retime_.load(); }
  void setRetime(int64_t r) { retime_.store(r); }
  /** Whether the stored map (or, with none, the node's inner span)
   * plays raw position `t` — the kept set a top must lie in. */
  bool keepsTop(int64_t t) const {
    return timing::keepsTop(storedMap(), getIntrinsicDuration(), t);
  }
  /** The published `loopTop`: the stored top when set and kept, else
   * the region start. */
  int64_t effectiveTop() const {
    return timing::effectiveTop(storedMap(), isLoopWindowActive(),
                                getIntrinsicDuration(), loop_top_.load());
  }

  // --- Loop window state: on the base, shared by clip and stack (I5) ---
  /** Whether the map is bypassed. A map is ACTIVE iff it has segments
   * and is not bypassed — independent of expansion (I6b). */
  bool isLoopWindowBypassed() const { return loop_window_bypassed_.load(); }
  void setLoopWindowBypassed(bool bypassed) {
    loop_window_bypassed_.store(bypassed);
  }
  /** Whether the node has an active map (activeTimeMap). */
  bool isLoopWindowActive() const { return activeTimeMap().active(); }

  /** The period-source knob (Q5): true = one-shot. */
  bool periodFromContext() const { return period_from_context_.load(); }

  /** The node's ACTIVE time-map (time_maps.md §2): the stored geometry,
   * or none when bypassed. Virtual for StackNode, whose step audition
   * and window domain decide it (sequencer.md §11.2, §11.8). */
  virtual timing::TimeMap activeTimeMap() const {
    if (loop_window_bypassed_.load()) return timing::TimeMap::none();
    return storedMap();
  }

  // --- The effect chain (vst3.md) ---
  /** The node's effect chain: a clip's processes its rendered playback,
   * a stack's the summed group. THE ONE-POINTER DISCIPLINE
   * (performance.md §1): the object is reached through one atomic
   * pointer; the message thread builds a successor, swaps it in and
   * retires the old one through the engine reclaimer, and the audio
   * thread only loads and reads — a delete inline would free what a
   * callback in flight still reads. Enable/param changes are
   * slot-internal atomics, with no republish. prepare() before enable. */
  dsp::FxChain* fxChain() const { return chain_.load(); }
  /** Swap in `fresh` (heap-owned); returns the OLD chain, which the
   * caller must retire — never delete inline while the node is live. */
  dsp::FxChain* exchangeFxChain(dsp::FxChain* fresh) {
    return chain_.exchange(fresh);
  }

  /** Pre-chain scope telemetry (stable across chain swaps). */
  dsp::FxScope& fxScope() { return fx_scope_; }

  /** True when the audio thread must run the fx path: an enabled slot
   * OR a watching scope panel (capture-only pass). */
  bool fxIsLive() const {
    return chain_.load()->anyEnabled() || fx_scope_.watching();
  }
  /** The node's fx pass: scope capture (pre-chain), then FxChain::run
   * with the Q-V1 stereo promotion. `stereo_in` says whether (l, r)
   * already carry two live channels; `r` may be null on a pure-mono
   * path (promotion then folds back internally). Returns whether the
   * caller's buffers now hold stereo. */
  bool fxProcess(float* l, float* r, int n, bool stereo_in,
                 const juce::MidiBuffer* live_midi = nullptr) const {
    fx_scope_.capture(l, stereo_in ? r : nullptr, n);
    return chain_.load()->run(l, r, n, stereo_in, live_midi);
  }

  /** This block's live MIDI for THIS node's fx pass: the context's
   * events iff the node is the armed play-through target. */
  const juce::MidiBuffer* liveMidiFor(const ProcessContext& context) const {
    return midi_armed.load() ? context.live_midi : nullptr;
  }

  /** The node's OWN period by the period law (period_law::ownPeriodOf,
   * judged against its island Q). Message thread: walks the tree. */
  int64_t getEffectivePeriod() const;

  /** The ACTIVE sequence's length: 0 except on a StackNode that has
   * one. On the base so the period law asks without a cast. */
  virtual int64_t activeSequenceLen() const { return 0; }

  // --- THE PRE-FX GATE (S7, sequencer.md §5) ---
  // Mute, solo-loss and sequence gates resolve to ONE dry-signal gain
  // applied BEFORE the node's fx chain. Edges fade over ~10 ms (a hard
  // cut pops) and the chain keeps running, so echo and reverb tails
  // ring out through a closed gate; silencing a node by skipping its
  // rack or zeroing its fader would freeze them. Every audibility verb
  // goes through this gate.
  //
  // The mute/solo half is a smoothed per-node ramp (a gesture cannot be
  // scheduled); the sequence half arrives as exact endpoints in the
  // context (gate_g0/g1). The ramp seeds at its first target, so a
  // freshly built graph starts with no phantom fade.

  /** This block's dry-gain endpoints: the mute/solo ramp toward
   * `audible`, times the context's sequence envelope. Advances the
   * ramp state. */
  void gateEndpoints(const ProcessContext& context, bool audible, float& g0,
                     float& g1) const {
    const float target = audible ? 1.0f : 0.0f;
    float s = user_gate_;
    if (s < 0.0f) s = target;  // unseeded: snap, no phantom fade
    float e = target;
    const double fade = context.sample_rate * 0.010;
    if (fade > 0.0 && s != target) {
      const float step = (float)((double)context.num_samples / fade);
      const float d = target - s;
      e = (d > step) ? s + step : ((d < -step) ? s - step : target);
    }
    user_gate_ = e;
    g0 = s * context.gate_g0;
    g1 = e * context.gate_g1;
  }

  // Quantum Logic
  virtual int64_t getIntrinsicDuration() const = 0;
  virtual int64_t getEffectiveQuantum() const {
    if (auto* p = parent.load()) return p->getEffectiveQuantum();
    return 0;
  }

  /** The island's zero: the clock moment of the cycle top. Every
   * cycle-relative projection (anchors, slots, effective positions)
   * must be measured from it — mixing it with absolute-frame math
   * splits audio from visuals. Answers 0 while Q is 0, even with a
   * provisional zero stored (StackNode::getZero reads that one). */
  virtual int64_t getIslandZero() const {
    if (auto* p = parent.load()) return p->getIslandZero();
    return 0;
  }

  // View telemetry written by render (`mutable`: see render()), 0..1.
  // A clip: the heard phase of its pass. A stack: the window phase
  // fraction — the phase of its active map's pass, 0 with no active map
  // or in a one-shot's rest.
  mutable std::atomic<double> playhead_pos{0.0};
  // The mute/solo gate ramp (gateEndpoints): −1 = unseeded. `mutable`:
  // DSP scratch (see render()).
  mutable float user_gate_{-1.0f};
  std::atomic<int64_t> duration_samples{0};       // Length of the loop
  std::atomic<int64_t> live_duration_samples{0};  // Live count during recording
  // THE MAP's storage (storedMap / setMap): the seqlock and its two
  // copies — map_[0] the primary, map_[1] the shadow (seq_locked.h).
  SeqLock map_lock_;
  struct MapCopy {
    std::atomic<int> n{0};
    std::atomic<int64_t> start[timing::TimeMap::kMaxSegments]{};
    std::atomic<int64_t> end[timing::TimeMap::kMaxSegments]{};
  };
  MapCopy map_[2];
  std::atomic<bool> loop_window_bypassed_{false};
  // THE PERIOD-SOURCE KNOB (Q5, kernel.md §2): false = the node loops
  // on its own length; true = a ONE-SHOT, whose period is the context
  // cycle (ProcessContext::context_cycle) — it sounds once per scope
  // cycle at its origin, then rests. A one-shot contributes nothing to
  // any period fold (period_law.h): it adopts the scope's cycle and
  // never extends it. Undoable (a musical fact).
  std::atomic<bool> period_from_context_{false};
  // The effect chain (fxChain above); every node is born with the
  // default built-in chain. The scope is a separate member so a chain
  // swap never disturbs its telemetry ring (`mutable`: see render()).
  std::atomic<dsp::FxChain*> chain_{dsp::FxChain::makeDefault().release()};
  mutable dsp::FxScope fx_scope_;
  std::atomic<bool> is_muted{false};
  // MIDI arm (vst3.md §8): THE live play-through target — incoming MIDI
  // reaches this node's chain. Single-armed (AudioEngine::setMidiArmed
  // clears every other node); not undoable, not persisted.
  std::atomic<bool> midi_armed{false};
  // SOLO (Q16): island-wide, additive, fractal — while any node in the
  // island is soloed, a leaf sounds only if it or an ancestor is. A
  // per-node flag the audio thread resolves per callback from the
  // snapshot (snapAnySolo, snapIsUnderSolo), so a toggle republishes
  // nothing. A monitoring gesture: not undoable.
  std::atomic<bool> is_soloed{false};
  // Stereo position (panGains). A MIXER fact: read by render, edited on
  // the message thread, not undoable (a dial drag would flood the log).
  std::atomic<float> pan{0.0f};
  // The fader, applied at the output stage after fx. [0, 1]: attenuate
  // only (boost lives in the compressor's makeup), so a full mix of
  // full-scale takes cannot clip the device. A mixer fact like pan.
  std::atomic<float> gain{1.0f};
  std::atomic<float> last_block_peak{0.0f};

  // THE ORIGIN (Q18, composition.md §1): the monotonic-clock moment this
  // node's inner time 0 belongs to, in samples. A CLIP: the moment
  // content[0] occurred, set when recording starts. A STACK: the zero of
  // its inner timeline, set when committed content first enters its
  // subtree (the earliest descendant's origin, AudioEngine::
  // settleAnchors) and cleared when the last leaves. Lane x and every
  // map's anchor are projections of it; a parent may move it, and the
  // whole subtree with it (composition.md §5), but never derives it.
  std::atomic<int64_t> origin_samples{0};
  // ANCHORED (stacks; composition.md §1): true once origin_samples is a
  // stored fact; until then the stack's inner zero is the received
  // cycle top. `anchored_` is the message thread's fact; the audio
  // thread reads `anchored_rt_`, adopted together with the origin at a
  // block top (adoptOriginGate), so no block pairs a new flag with an
  // old origin and both phases of a block agree on the frame.
  std::atomic<bool> anchored_{false};
  std::atomic<bool> anchored_rt_{false};
  bool isAnchored() const { return anchored_.load(); }
  /** Message thread: anchor at `origin`, or clear. The flag is only
   * ever set while the origin it selects is in place — the origin lands
   * before an anchor is set and leaves after one is cleared — so a
   * block top that falls between the two stores still adopts a coherent
   * pair. */
  void setAnchor(bool anchored, int64_t origin, uint32_t gate) {
    origin_gate_gen_.store(gate);
    if (anchored) {
      origin_samples.store(origin);
      anchored_.store(true);
    } else {
      anchored_.store(false);
      origin_samples.store(origin);
    }
  }
  // The origin the AUDIO thread renders with: adopted from
  // origin_samples at a block top whose island generation has reached
  // origin_gate_gen_. A writer that moves origins with the zero names
  // one generation for both, so a block renders new origins against the
  // new zero or neither. Audio-thread writers (arm, commit) store both
  // directly.
  std::atomic<int64_t> origin_rt_{0};
  std::atomic<uint32_t> origin_gate_gen_{0};
  /** Message thread: set the origin so that the audio thread adopts it
   * only at a block top carrying island generation >= `gate` (0 = the
   * next block top). */
  void setOriginGated(int64_t origin, uint32_t gate) {
    origin_gate_gen_.store(gate);
    origin_samples.store(origin);
  }
  /** Block-top adoption of the origin and the anchor flag (call first
   * in control()). The flag is read on both sides of the origin: a
   * setAnchor landing between the reads flips it, and the pair is then
   * left for the next block top. */
  void adoptOriginGate(const ProcessContext& context) {
    if (context.island_generation < origin_gate_gen_.load()) return;
    const bool anchored = anchored_.load();
    const int64_t origin = origin_samples.load();
    if (anchored_.load() != anchored) return;
    origin_rt_.store(origin);
    anchored_rt_.store(anchored);
  }
  /** THE FRAME ORIGIN (Q18, composition.md §2) a STACK's geometry
   * anchors at on the audio thread: its own rendering origin once the
   * anchor is adopted, else the received cycle top (an empty stack).
   * Asked of stacks only: a clip renders from origin_rt_.
   * Message-thread twin: heard::frameOriginOf. */
  int64_t frameOrigin(const ProcessContext& context) const {
    return anchored_rt_.load() ? origin_rt_.load() : context.frame_top;
  }

  // Message thread only (the threading note above); atomic for the
  // reorder/combine reparent, not as a sync point.
  std::atomic<AudioNode*> parent{nullptr};

 protected:
  juce::String node_name;
  juce::String node_uuid;
  // The top and the re-time (storedTop / retime above).
  std::atomic<int64_t> loop_top_{timing::kNoTop};
  std::atomic<int64_t> retime_{0};
};

}  // namespace celestrian
