#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <atomic>

#include "dsp/fx_chain.h"
#include "midi_input_queue.h"
#include "timing.h"

namespace celestrian {

class AudioNode;
struct GraphSnapshot;

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

  // Solo canon (Q16): true when ANY node in the island is soloed —
  // computed once per callback from the snapshot's per-node atomic
  // flags (additive: solos sum; island-wide: a solo anywhere silences
  // every leaf without a soloed ancestor; fractal: leaves resolve
  // ancestry through the snapshot's parent indices).
  bool any_solo = false;

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
  const float* const* prerecord_ring = nullptr;
  int prerecord_ring_len = 0;       // samples per channel
  int prerecord_ring_channels = 0;  // valid channels in the ring
  int64_t input_clock = 0;          // arrival index of this block's sample 0

  // --- Whole-graph snapshot (unification_audit §2.2, Tier 3 Step 3) ---
  // The engine loads ONE snapshot per callback and passes it down; each
  // node receives its own entry index (`self`) from its parent. All
  // audio-thread structure traversal (children, ancestors) goes through
  // `snap` — never through per-node pointers. Null only in node-level
  // unit tests driving process() directly (single-threaded, where the
  // ownership-vector fallback is race-free by construction).
  const GraphSnapshot* snap = nullptr;
  int self = 0;  // this node's entry index in `snap`

  // Island facts, passed DOWN so leaves never walk up (the audio-thread
  // parent walks are gone): the island quantum (0 = unestablished), the
  // INVARIANT island epoch (unlike cycle_epoch, never re-based by
  // windowed stacks on the way down), and the island root — the target
  // of take lifecycle events and establishIsland.
  int64_t quantum = 0;
  int64_t island_epoch = 0;
  AudioNode* island = nullptr;

  // The CONTEXT CYCLE for this scope (the Q5 one-shot period): each
  // stack sets it for its children — its active map's period when
  // mapped, else lcm(quantum, its LOOPING children's effective periods)
  // — falling back to the received value when the scope has no looping
  // content of its own. A one-shot node's period IS this value; it is
  // what "sounds once per cycle" means. Like context_loop this is
  // passed DOWN (P1-6), but unlike it this is a RENDER fact.
  int64_t context_cycle = 0;

  // --- Time-map facts (time_maps.md phase 2) ---
  // The INVARIANT monotonic island clock: the engine's transport
  // position, never folded by a mapping stack on the way down (the
  // master_pos twin of island_epoch). Through-map arm triggers compare
  // against THIS clock — the folded master_pos wraps every map period
  // and never crosses a target at/past the map's end.
  int64_t island_pos = 0;
  // Live MIDI (docs/vst3.md §8, phase 4): the block's incoming events,
  // drained once per callback by the engine from the lock-free queue.
  // Consumed ONLY by a node whose midi_armed_ flag is set (the single
  // live play-through target). Null in unit tests driving nodes
  // directly and on engines with no MIDI devices.
  const juce::MidiBuffer* live_midi = nullptr;
  // MIDI recording facts (docs/vst3.md §8, phase 5). `midi_history` is
  // the arrival-indexed history ring (midi_input_queue.h) MIDI takes
  // capture from — the note twin of the pre-record ring; null in unit
  // tests driving nodes directly (takes then capture from live_midi
  // at block offsets, the live-block fallback). `midi_latency` is the
  // compensation for a MIDI arrival: the performer plays against what
  // they HEAR, and a key pressed on the heard beat reaches the callback
  // OUTPUT-latency later — unlike audio there is no input-side device
  // delay to add. Content position of an arrival = heard time − this.
  const MidiHistory* midi_history = nullptr;
  int midi_latency = 0;

  // --- Sequencer gate (docs/sequencer.md, S7 smoothness law) ---
  // The parent stack's per-child dry-gain ramp for this block: linear
  // endpoints, exact because the parent splits blocks at envelope
  // corners (Sequence::cornerDistance). 1,1 when no sequence gates the
  // node. Applied by the child PRE-FX (composed with its own mute/solo
  // gate in gateEndpoints) so effect tails ring through a closed gate.
  float gate_g0 = 1.0f;
  float gate_g1 = 1.0f;

  // The innermost enclosing ACTIVE map (empty when none): set by a
  // mapping stack in childContext for its whole subtree, alongside
  // map_heard_epoch — the RECEIVED frame's cycle top at that stack,
  // i.e. the heard grid anchor (pass tops occur at island times
  // ≡ map_heard_epoch mod map.period()). map_count counts active maps
  // on the delivered chain: > 1 means composed maps (multi-segment
  // product), which recording refuses until phase 3+.
  timing::TimeMap map{};
  int64_t map_heard_epoch = 0;
  int map_count = 0;
};

/**
 * Enumeration of available node types in the Celestrian ecosystem.
 */
enum class NodeType { Clip, Stack, Unknown };

/** The period-source knob's two positions (Q5): a LOOP's period is its
 * own length; a ONE-SHOT adopts the context cycle (sounds once per
 * scope cycle at its origin, then rests). */
enum class PeriodSource { OWN_LENGTH, CONTEXT_CYCLE };

/**
 * Pan gains, BALANCE law: center is unity on both channels (existing
 * sessions keep their exact loudness), panning attenuates the far
 * channel only — no boost anywhere, so a full-scale take hard-panned
 * cannot clip the device. pan ∈ [−1 (L) .. +1 (R)].
 */
inline void panGains(float pan, float& gain_l, float& gain_r) {
  const float p = pan < -1.0f ? -1.0f : (pan > 1.0f ? 1.0f : pan);
  gain_l = p > 0.0f ? 1.0f - p : 1.0f;
  gain_r = p < 0.0f ? 1.0f + p : 1.0f;
}

/** Mute at the output stage (an enum so call sites read as intent,
 * not a bare bool — style.md). */
enum class MuteState { AUDIBLE, MUTED };

/**
 * THE OUTPUT STAGE scalars (unification_audit.md §2.4): every node's
 * signal reaches its parent through one resolution — render/sum →
 * time-map → fx → gain·pan → parent. `gl`/`gr` are that stage's
 * channel gains: the balance-law pan gains scaled by the fader, and 0
 * when muted — mute IS gain 0 at the output stage, not a separate
 * audibility mechanism (fixes D1: containers silence like leaves).
 * `fader` is the mono/extra-channel scalar (pan does not apply there).
 */
inline void outputStageGains(float pan, float gain, MuteState mute, float& gl,
                             float& gr, float& fader) {
  panGains(pan, gl, gr);
  fader = mute == MuteState::MUTED ? 0.0f : gain;
  gl *= fader;
  gr *= fader;
}

/**
 * Interface for all audio-producing or processing nodes in the Celestrian
 * graph.
 */
class AudioNode {
 public:
  AudioNode(juce::String node_name)
      : node_name(std::move(node_name)), node_uuid(juce::Uuid().toString()) {}
  virtual ~AudioNode() {
    // Nodes only die via the reclaimer (2-callback grace), so no
    // in-flight audio can still be reading the override or chain here.
    delete map_override_.load();
    delete chain_.load();
  }

  /**
   * CONTROL/INGEST phase (unification_audit.md §2.3 — the control
   * plane): everything that DECIDES or CAPTURES. Arm targets, stop
   * boundaries, input capture, commit events (and their island
   * consequences: establish, epoch re-base). Mutates node state.
   * Inputs flow in here; nothing is rendered.
   */
  virtual void control(const float* const* input_channels,
                       int num_input_channels,
                       const ProcessContext& context) = 0;

  /**
   * RENDER phase (§2.3 — the data plane): the kernel playback equation
   * as a PURE function of (structure, settled state, t). CONST-ENFORCED:
   * render decides nothing and mutates no musical state — the only
   * `mutable` members are DSP scratch (mix/fx buffers, effect state)
   * and view telemetry (playhead phase), both explicitly marked.
   * Outputs flow out of here; inputs are not visible.
   */
  virtual void render(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const = 0;

  /**
   * Phase sequencer: control, then render. NON-virtual — the split is
   * the contract. Called at the ROOT by the engine, this yields
   * whole-graph phase separation: every decision in the graph settles
   * before the first sample renders, so render never observes state
   * that changes mid-pass (§2.3 "events applied between blocks").
   * Node-level tests call it for the historical single-node behavior.
   */
  void process(const float* const* input_channels,
               float* const* output_channels, int num_input_channels,
               int num_output_channels, const ProcessContext& context) {
    control(input_channels, num_input_channels, context);
    render(output_channels, num_output_channels, context);
  }

  /**
   * Generates waveform peaks for visualization.
   * @param num_peaks The number of peak samples to return.
   */
  virtual juce::var getWaveform(int num_peaks) const = 0;

  /**
   * Returns a JSON object containing node metadata for UI rendering.
   */
  virtual juce::var getMetadata() const {
    auto* obj = new juce::DynamicObject();
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
    // The period-source knob (Q5): "own" = loops at its own length,
    // "context" = one-shot (sounds once per context cycle).
    obj->setProperty("periodSource",
                     period_from_context_.load() ? "context" : "own");
    // Multi-segment map (phase 3): flat [s0,e0,s1,e1,...] in samples,
    // present only when an override is installed.
    if (const timing::TimeMap* m = map_override_.load()) {
      juce::Array<juce::var> segs;
      for (int i = 0; i < m->n; ++i) {
        segs.add((double)m->segs[i].start);
        segs.add((double)m->segs[i].end);
      }
      obj->setProperty("segments", segs);
    }
    // Effect chain state (fractal like windows): {chain: [...slots],
    // scope: {...}?} — the chain array doubles as the save format
    // (docs/vst3.md §6); scope telemetry only while a panel watches.
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
    obj->setProperty("originQ", qtimeVar(timing::originQ(origin_samples.load(),
                                                         epoch, q_samples)));
    obj->setProperty("periodQ", qtimeVar(timing::periodQ(
                                    duration_samples.load(), q_samples)));
    obj->setProperty(
        "windowStartQ",
        qtimeVar(timing::fromSamples(loop_start_samples.load(), q_samples)));
    obj->setProperty("windowEndQ", qtimeVar(timing::fromSamples(
                                       loop_end_samples.load(), q_samples)));
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
  /** Restore a persisted uuid on load (session_io) so save→load→save is
   * stable and references survive. Message thread, before the node joins
   * the graph. */
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

  // Hierarchy. The parent pointer is a MESSAGE-THREAD convenience
  // (metadata walks, engine helpers) plus the single-threaded unit-test
  // fallback; the audio thread resolves ancestry through the
  // whole-graph snapshot (ProcessContext.snap) and receives island
  // facts in the context — it never walks these pointers (Tier 3
  // Step 3).
  void setParent(AudioNode* p) { parent.store(p); }
  AudioNode* getParent() const { return parent.load(); }

  /** Topmost node of this subtree — the island root under the current
   * one-island model. Message thread / unit-test fallback only; the
   * audio thread uses ProcessContext.island. */
  AudioNode* rootNode() {
    AudioNode* n = this;
    while (auto* p = n->getParent()) n = p;
    return n;
  }

  /** Recursive UUID lookup (self included). */
  virtual AudioNode* findByUuid(const juce::String& uuid) {
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
  /** Commit event. `intrinsic_after` = the island's composite duration
   * INCLUDING the just-committed take — computed by the caller (in
   * snapshot space on the audio thread; graph_snapshot.h), because the
   * island's own tree traversal is message-thread-only. */
  virtual void takeCommitted(int64_t origin, int64_t intrinsic_after) {
    (void)origin;
    (void)intrinsic_after;
  }
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
           (map_override_.load() != nullptr ||
            loop_end_samples.load() > loop_start_samples.load());
  }

  /** The period-source knob (Q5): true = one-shot (period := context
   * cycle). Audio-thread safe (one atomic load). */
  bool periodFromContext() const { return period_from_context_.load(); }

  /**
   * The node's ACTIVE time-map as the reified value type (time_maps.md
   * §2): the multi-segment override when one is installed (phase 3),
   * else a single segment from the phase-1 window atomics; empty when
   * bypassed/invalid (the bypass flag gates BOTH forms). Consumers must
   * be segment-general — use period()/mapOffset()/seamDistance(), never
   * the raw loop atomics. Audio-thread safe: one atomic pointer load /
   * atomic scalar loads into a POD value.
   */
  timing::TimeMap activeTimeMap() const {
    if (loop_window_bypassed_.load()) return timing::TimeMap::none();
    if (const timing::TimeMap* m = map_override_.load()) return *m;
    return timing::TimeMap::single(loop_start_samples.load(),
                                   loop_end_samples.load());
  }

  // --- Multi-segment map storage (time_maps.md phase 3) ---
  // The override is reached through ONE atomic pointer (the D4
  // content-buffer discipline): null = the single-segment window in the
  // loop atomics; non-null = an immutable multi-segment TimeMap. The
  // MESSAGE thread swaps it and retires the old pointer through the
  // engine reclaimer (an in-flight callback may read it for ≤2 more
  // callbacks); the audio thread only loads it.
  const timing::TimeMap* mapOverride() const { return map_override_.load(); }
  /** Swap in `fresh` (heap-owned, or null to clear); returns the OLD
   * pointer, which the caller must retire — never delete inline. */
  const timing::TimeMap* exchangeMapOverride(const timing::TimeMap* fresh) {
    return map_override_.exchange(fresh);
  }

  // --- The effect chain (docs/vst3.md phase 2) ---
  /**
   * The node's effect chain — FRACTAL like windows: a clip's chain
   * processes its rendered playback; a stack's chain processes the
   * summed group (so a stack reverb wets the whole kit). Reached
   * through ONE atomic pointer (the D4 discipline): the MESSAGE thread
   * builds successors (sharing slot objects) and retires the old chain
   * through the engine reclaimer; the audio thread loads the pointer
   * per block and only reads. Enable/param changes are slot-internal
   * atomics — no republish. prepare() before enable, as ever.
   */
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
   * caller's buffers now hold stereo. Called from the CONST render
   * phase — chain DSP state and the scope ring are DSP scratch
   * (performance.md §2.3 sanctioned exception). */
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
    const timing::TimeMap map = activeTimeMap();
    if (map.active()) return map.period();
    return getIntrinsicDuration();
  }

  /** The node's ACTIVE sequence length (docs/sequencer.md §2, the
   * period law) — 0 everywhere except a StackNode with an active
   * sequence. Lives on the base so the snapshot twins
   * (graph_snapshot.h) can ask without a cast. Audio-thread safe. */
  virtual int64_t activeSequenceLen() const { return 0; }

  // --- The PRE-FX audibility gate (docs/sequencer.md S7, ruled
  // 2026-08-19: "all transitions smooth as much as possible") ---
  //
  // Mute, solo-loss, and sequence gates all resolve to ONE dry-signal
  // gain applied BEFORE the node's fx chain: edges fade over ~10 ms
  // (never a hard cut — speaker pops), and the chain keeps running, so
  // echo/reverb tails RING OUT through a closed gate. This supersedes
  // the freeze-tails mute (mute as output-stage gain 0 + skipped rack)
  // — one mechanism for every audibility verb, resolving the standing
  // "effect tails on mute" question (tasks.md).
  //
  // The mute/solo half is a smoothed per-node ramp (user gestures are
  // not schedulable); the sequence half arrives as exact (g0, g1)
  // endpoints in the context (schedule-derived — see sequence.h). The
  // ramp state seeds AT its first observed target, so a freshly built
  // graph starts silent-or-audible with no phantom fade (deterministic
  // for tests and loads).

  /** Compose this block's dry-gain endpoints: the smoothed mute/solo
   * ramp toward `audible`, times the context's sequence envelope.
   * Advances the ramp state (render-phase DSP scratch). */
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

  /**
   * The island's cycle epoch: the master-clock moment of the visual cycle
   * top. ALL cycle-relative projections (anchors, slots, effective
   * positions) must be computed relative to this — mixing epoch-relative
   * views with absolute-frame math re-splits audio from visuals.
   */
  virtual int64_t getIslandEpoch() const {
    if (auto* p = parent.load()) return p->getIslandEpoch();
    return 0;
  }

  // Freeform canvas position for TOP-LEVEL stacks only — an opaque
  // blob the engine persists for the frontend (ui.md). Clips never
  // write these: lane x is a UI projection of `origin` (I6).
  std::atomic<double> x_pos{0.0}, y_pos{0.0};
  std::atomic<double> width{200.0}, height{100.0};

  // Transport state
  // View telemetry, written by the CONST render phase (§2.3): an output
  // for the UI, not musical state — the sanctioned exception to render
  // purity, hence `mutable`.
  mutable std::atomic<double> playhead_pos{0.0};  // 0.0 to 1.0 (normalized)
  // The mute/solo gate ramp state (see gateEndpoints): −1 = unseeded.
  // Render-phase DSP scratch (§2.3 sanctioned mutable) — the audio
  // thread alone advances it.
  mutable float user_gate_{-1.0f};
  std::atomic<int64_t> duration_samples{0};       // Length of the loop
  std::atomic<int64_t> live_duration_samples{0};  // Live count during recording
  std::atomic<int64_t> loop_start_samples{0};
  std::atomic<int64_t> loop_end_samples{0};
  // Loop window bypass flag (time_maps.md). Window phase is pure
  // arithmetic on the received clock — no private counter, fractal.
  std::atomic<bool> loop_window_bypassed_{false};
  // THE PERIOD-SOURCE KNOB (Q5 ruling / kernel.md §2 / audit D7): false
  // = the node's period is its own length (a loop, the default); true =
  // its period is the CONTEXT CYCLE (ProcessContext.context_cycle) — a
  // ONE-SHOT, sounding once per scope cycle at its origin, then
  // resting. A period choice, not a clip type. One-shots are EXCLUDED
  // from every period/duration composition fold (stack LCMs, snapshot
  // twins): they adopt the scope's cycle, never extend it — that is
  // what keeps a composite honestly periodic in its claimed period
  // (I1). Undoable (a musical fact, unlike the mixer knobs).
  std::atomic<bool> period_from_context_{false};
  // Multi-segment map override (phase 3; see mapOverride above): owned
  // here, swapped on the message thread, retired via the reclaimer.
  std::atomic<const timing::TimeMap*> map_override_{nullptr};

  // The effect chain (dsp/fx_chain.h): ONE atomic pointer, message
  // thread swaps + reclaimer retirement, audio thread loads per block
  // (D4 discipline — see fxChain above). Every node is born with the
  // default four-built-in chain. The scope is a separate STABLE member
  // so chain swaps never disturb the telemetry ring; both are touched
  // from the CONST render phase as sanctioned DSP scratch (§2.3).
  std::atomic<dsp::FxChain*> chain_{dsp::FxChain::makeDefault().release()};
  mutable dsp::FxScope fx_scope_;
  std::atomic<bool> is_muted{false};
  // MIDI arm (docs/vst3.md §8, phase 4): THE live play-through target —
  // incoming MIDI reaches this node's chain (its instrument slot).
  // Single-armed: AudioEngine::setMidiArmed clears every other node.
  // A monitoring gesture like solo: not undoable, not persisted.
  std::atomic<bool> midi_armed{false};
  // Solo canon (Q16, ruled 2026-08-13): island-wide, ADDITIVE, fractal.
  // A per-node flag like mute; the audio thread resolves audibility per
  // callback from the snapshot (any_solo + ancestor scan), so toggling
  // never republishes structure. Not undoable (a monitoring gesture —
  // matches the mock's UNDOABLE set).
  std::atomic<bool> is_soloed{false};
  // Stereo mix position (balance law — see panGains). A MIXER fact like
  // mute, not a musical fact: read by render, edited on the message
  // thread, deliberately not undoable (dial drags would flood the undo
  // log; same ruling as effect params).
  std::atomic<float> pan{0.0f};
  // The volume fader (unification_audit §2.4 — the missing gain
  // primitive), applied at the node's output stage after fx. Range
  // [0, 1]: unity default, attenuate-only per the pan no-boost law (a
  // full mix of full-scale takes cannot clip the device; boost lives in
  // the compressor's makeup). A MIXER fact like pan: not undoable.
  std::atomic<float> gain{1.0f};
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
  std::atomic<AudioNode*> parent{nullptr};

 protected:
  juce::String node_name;
  juce::String node_uuid;
};

}  // namespace celestrian
