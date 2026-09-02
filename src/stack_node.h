#pragma once

#include <algorithm>
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

#include "audio_node.h"
#include "sequence.h"

namespace celestrian {

/**
 * Sink for graph objects that must outlive their removal from the audio
 * thread's view. The audio thread traverses the whole-graph snapshot
 * (graph_snapshot.h) it loaded at the top of the callback, so a removed
 * node, a swapped content buffer, a replaced fx chain or an outgoing
 * snapshot may still be read for the callback in flight when the message
 * thread replaced it; the reclaimer (the engine) defers the actual delete
 * until the audio thread has provably moved on (a two-callback grace).
 */
class GraphReclaimer {
 public:
  virtual ~GraphReclaimer() = default;

  /** Called on the message thread. deleter runs when it is safe to free. */
  virtual void retire(std::function<void()> deleter) = 0;
};

/**
 * A container node that sums its children into a single output.
 * This enables the hierarchical structure of stacks-within-stacks.
 *
 * Threading model: the `children` vector (ownership) belongs to the
 * message thread and the audio thread never reads it. After every
 * structural mutation the engine publishes ONE whole-graph snapshot
 * (AudioEngine::publishGraph, graph_snapshot.h); the audio thread loads
 * it once per callback (ProcessContext.snap) and control()/render()
 * iterate its integer child indices — no locks. Removed nodes and
 * replaced snapshots go through the GraphReclaimer so an in-flight
 * callback never reads freed memory. There is no other traversal: a
 * context without a snapshot is a contract violation (node-level tests
 * build one through tests/test_utils.h NodeContext).
 */
class StackNode : public AudioNode {
 public:
  StackNode(juce::String name);
  ~StackNode() override;

  // AudioNode implementation
  // §2.3 control/render split: control recurses decisions/capture down
  // the (snapshot) children with the window-mapped clock; render sums
  // children renders through the same map + the group fx rack. Both
  // iterate the whole-graph snapshot (ProcessContext.snap). When this
  // stack's map is ACTIVE, both split the block into runs at map seams
  // (time_maps.md §5) — the *Children helpers hold the pre-split
  // bodies.
  void control(const float* const* input_channels, int num_input_channels,
               const ProcessContext& context) override;
  void render(float* const* output_channels, int num_output_channels,
              const ProcessContext& context) const override;

  /**
   * Aggregate waveform visualization for all children.
   */
  juce::var getWaveform(int num_peaks) const override;

  /**
   * Aggregates metadata from all children for the UI.
   */
  juce::var getMetadata() const override;

  /**
   * Returns NodeType::Stack.
   */
  NodeType getNodeType() const override { return NodeType::Stack; }

  float getCurrentPeak() const override { return last_block_peak.load(); }

  int64_t getIntrinsicDuration() const override;
  int64_t getEffectiveQuantum() const override;

  // Stack-specific methods
  /**
   * Adds a child node to this container. (Message thread only.)
   */
  void addChild(std::unique_ptr<AudioNode> child);

  /**
   * Inserts a child node at a specific index. (Message thread only.)
   */
  void insertChildAt(std::unique_ptr<AudioNode> child, int index);

  /**
   * Removes and returns a child node by index (for moving between stacks).
   * The caller keeps the node alive; the audio thread may still be
   * processing it until the next callback. (Message thread only.)
   */
  std::unique_ptr<AudioNode> removeChild(int index);

  /**
   * Detaches and returns ALL children — the caller (the engine) owns
   * retirement, since the audio thread may still traverse them through
   * the outgoing graph snapshot. (Message thread only.)
   */
  std::vector<std::unique_ptr<AudioNode>> clearChildren();

  /**
   * Recursive UUID lookup, self included, through this stack and its
   * sub-stacks. (Message thread only.)
   */
  AudioNode* findByUuid(const juce::String& uuid) override;

  /**
   * True when any child (nested stacks recurse) is armed or recording.
   * (Message thread only.)
   */
  bool isArmedOrRecording() const override;

  /** Number of children. (Message thread only.) */
  int getNumChildren() const { return (int)children.size(); }

  /** Child at index. (Message thread only.) */
  AudioNode* getChild(int index) { return children[(size_t)index].get(); }

  /**
   * The OWNERSHIP children — message thread only (the vector mutates on
   * structural edits with no synchronization). Audio-thread traversal
   * goes through the whole-graph snapshot (ProcessContext.snap /
   * graph_snapshot.h); this accessor exists for the snapshot builder
   * and message-side readers (metadata, session_io, engine helpers).
   */
  const std::vector<std::unique_ptr<AudioNode>>& ownedChildren() const {
    return children;
  }

  // --- Island quantum (kernel.md) ---
  /**
   * Sets the island's quantum and cycle epoch. Called when the first
   * committed clip establishes the island, and again whenever a
   * message-thread edit re-establishes the grid: a definer re-trim, a
   * revert to empty, a geometry scrub, a seek, a session load. Q survives
   * its creator otherwise (Q1, design_language.md): muting or deleting
   * the establishing clip does not change it.
   */
  void setQuantum(int64_t quantum, int64_t epoch) {
    setIslandFacts(quantum, epoch, island_generation_.load());
  }
  /** SEQLOCK'D TRIPLE: the audio thread reads (Q, epoch, generation) as
   * ONE fact (readIslandFacts) — three separate loads would let a
   * re-trim land between them and hand one block a mixed pair. The
   * generation gates the clips' rendering origins
   * (ClipNode::setOriginGated): a writer that moves origins with the
   * epoch names a new generation, so a block adopts the new origins
   * iff it read the new epoch. Single writer at a time: the message
   * thread, or the audio-thread commit re-base (rebaseEpochOnGrowth) —
   * message-thread fact writers are refused under a live take. */
  void setIslandFacts(int64_t quantum, int64_t epoch, uint32_t generation) {
    island_seq_.fetch_add(1, std::memory_order_release);  // odd = writing
    quantum_samples_.store(quantum);
    epoch_samples_.store(epoch);
    island_generation_.store(generation);
    island_seq_.fetch_add(1, std::memory_order_release);  // even = stable
  }
  int64_t getQuantum() const { return quantum_samples_.load(); }
  int64_t getEpoch() const { return epoch_samples_.load(); }
  struct IslandFacts {
    int64_t quantum = 0;
    int64_t epoch = 0;
    uint32_t generation = 0;
  };
  /** (Q, epoch) read consistently — never a mixed pair. Audio-thread
   * safe: the writer's critical section is two stores, so the bounded
   * retry never spins for real; after the bound it takes what it has
   * (a write storm that long does not exist on the message thread). */
  IslandFacts readIslandFacts() const {
    IslandFacts f;
    for (int attempt = 0; attempt < 16; ++attempt) {
      const uint32_t s1 = island_seq_.load(std::memory_order_acquire);
      f.quantum = quantum_samples_.load();
      f.epoch = epoch_samples_.load();
      f.generation = island_generation_.load();
      const uint32_t s2 = island_seq_.load(std::memory_order_acquire);
      if ((s1 & 1u) == 0 && s1 == s2) break;
    }
    return f;
  }

  /**
   * Transport seek (AudioEngine::seekTransport): re-base the cycle
   * epoch so the monotonic clock reads as a chosen phase. The clock
   * itself is never reset (kernel.md); moving the epoch is how the
   * island's phase moves — the same lever takeCommitted's re-base
   * uses. Message thread only; the audio thread picks it up at the
   * next block top (pc.cycle_epoch = islandEpoch()).
   */
  void seekEpochTo(int64_t epoch, uint32_t generation) {
    setIslandFacts(quantum_samples_.load(), epoch, generation);
  }

  /** Group-stop generation (ProcessContext::stop_generation): the
   * engine reserves the next value, parks it on every member, then
   * publishes it here in ONE store. Island root only. */
  uint32_t nextStopGeneration() { return stop_generation_.load() + 1; }
  /** Island generation (ProcessContext::island_generation): a writer
   * names the next one, gates the origins on it, then writes it with
   * the epoch in ONE setIslandFacts. */
  uint32_t nextIslandGeneration() { return island_generation_.load() + 1; }
  uint32_t islandGeneration() const { return island_generation_.load(); }
  void publishStopGeneration(uint32_t g) { stop_generation_.store(g); }
  uint32_t stopGeneration() const { return stop_generation_.load(); }

  /** Establish (Q, epoch) once; q == 0 sets a provisional epoch only
   * (first-clip arm). No-op once Q is locked. */
  void establishIsland(int64_t quantum, int64_t epoch) override {
    if (quantum_samples_.load() != 0) return;
    setQuantum(quantum > 0 ? quantum : 0, epoch);
  }

  // --- Take lifecycle (commit as an EVENT, unification_audit.md §1.5).
  // Clips report arm/cancel/commit to the island root; the engine does
  // no per-block edge detection. Counter drift on node removal is
  // guarded in removeChild/clearChildren.
  void takeArmed() override;
  void takeCancelled() override { active_takes_.fetch_sub(1); }
  void takeCommitted(int64_t origin, int64_t intrinsic_after) override;
  void rebaseEpochOnGrowth(int64_t origin, int64_t intrinsic_after);
  bool hasActiveTake() const override { return active_takes_.load() > 0; }
  int64_t activeTakeHeardCycle() const override {
    return heard_cycle_at_arm_.load();
  }
  int64_t activeTakeIntrinsicCycle() const override {
    return lcm_before_take_.load();
  }

  int64_t getIslandEpoch() const override {
    if (quantum_samples_.load() > 0) return epoch_samples_.load();
    if (auto* p = parent.load()) return p->getIslandEpoch();
    return 0;
  }

  // Loop window state lives on AudioNode (fractal, I5): bypass flag,
  // isLoopWindowActive(), and the metadata publish are shared with
  // ClipNode. Window phase derives from the received clock
  // ((t − cycle_epoch) mod len) — no private counter, no dependence on
  // when the user collapsed anything.

  /**
   * E-C, recursive: an active window on THIS stack wins (base class);
   * else an active SEQUENCE contributes its total length (the period
   * law, docs/sequencer.md §2 — composition order: map over sequence);
   * otherwise the LCM of the children's EFFECTIVE periods — a windowed
   * child contributes its window length, so nested windows shorten the
   * audible cycle all the way up. Message thread only — the audio
   * thread uses the snapshot-space twin (snapEffectivePeriod,
   * graph_snapshot.h).
   */
  int64_t getEffectivePeriod() const override;
  /** THE message-thread effective-period fold (composition.md §3): the
   * period `node` presents to its parent, with `skip` (and every
   * one-shot) left out of the composition. getEffectivePeriod() is
   * this with no skip; the audio thread uses snapEffectivePeriod. */
  static int64_t effectivePeriodOf(const AudioNode& node,
                                   const AudioNode* skip);

  // --- The SEQUENCE (docs/sequencer.md — the fractal sequencer) ---
  // One atomic pointer, the FxChain discipline: the
  // message thread swaps immutable Sequence objects (finalize()d) and
  // retires predecessors through the engine reclaimer; the audio
  // thread only loads. The bypass flag is the jam toggle (bypassed =
  // everything sounds; geometry survives, I9).
  const Sequence* sequencePtr() const { return sequence_.load(); }
  /** Swap in `fresh` (heap-owned, or null to clear); returns the OLD
   * pointer, which the caller must retire — never delete inline. */
  const Sequence* exchangeSequence(const Sequence* fresh) {
    return sequence_.exchange(fresh);
  }
  bool isSequenceBypassed() const { return sequence_bypassed_.load(); }
  void setSequenceBypassed(bool b) { sequence_bypassed_.store(b); }
  /** The sequence iff it is ACTIVE (present, non-empty, not bypassed).
   * Audio-thread safe: one pointer load + one flag load. */
  const Sequence* activeSequence() const {
    if (sequence_bypassed_.load()) return nullptr;
    const Sequence* s = sequence_.load();
    return (s != nullptr && s->total > 0) ? s : nullptr;
  }
  int64_t activeSequenceLen() const override {
    const Sequence* s = activeSequence();
    return s != nullptr ? s->total : 0;
  }

  // --- THE STEP AUDITION (docs/sequencer.md §11.2) ---
  // "Loop this step": a MONITORING gesture (the solo / midi_armed
  // class — not undoable, not persisted). While set and the sequence
  // is active, the stack's time-map IS the step's span, DERIVED from
  // the sequence: it follows a step resize, cannot outlive the
  // sequence (bypass it and the audition is simply gone), and leaves
  // any authored window untouched underneath (I9: Esc restores it
  // exactly). Recording through it is the phase-2 through-map path
  // aimed at the step — "record into a step" (§4 Mode 2).
  int auditionStep() const { return audition_step_.load(); }
  void setAuditionStep(int step) { audition_step_.store(step); }
  /** The audition's derived map, or none when no audition applies
   * (no step set, sequence inactive, or the index no longer exists). */
  timing::TimeMap auditionMap() const {
    const int i = audition_step_.load();
    if (i < 0) return timing::TimeMap::none();
    const Sequence* s = activeSequence();
    if (s == nullptr || i >= s->numSteps()) return timing::TimeMap::none();
    return timing::TimeMap::single(s->bounds[i], s->bounds[i + 1]);
  }
  bool auditionActive() const { return auditionMap().active(); }

  // --- S16: THE WINDOW DOMAIN (docs/sequencer.md §11.8) ---
  // A window AUTHORED over a sequence timeline (the S9 composition:
  // the map selects spans of the song) loses its meaning when the
  // sequence is bypassed — [8Q, 16Q) of an 8Q jam is nonsense. The
  // authoring edit stamps the domain; a sequence-domain window is
  // SUSPENDED (reads as no map, never deleted — I9) while the sequence
  // is off, and returns with it. Message thread writes, audio reads.
  enum class WindowDomain : int { Intrinsic = 0, Sequence = 1 };
  WindowDomain windowDomain() const {
    return (WindowDomain)window_domain_.load();
  }
  void setWindowDomain(WindowDomain d) { window_domain_.store((int)d); }
  /** The authored window is suspended: sequence-domain, sequence off. */
  bool windowSuspended() const {
    return windowDomain() == WindowDomain::Sequence &&
           activeSequence() == nullptr && AudioNode::isLoopWindowActive();
  }
  timing::TimeMap activeTimeMap() const override {
    if (const timing::TimeMap a = auditionMap(); a.active()) return a;
    if (windowDomain() == WindowDomain::Sequence && activeSequence() == nullptr)
      return timing::TimeMap::none();  // suspended (S16)
    return AudioNode::activeTimeMap();
  }
  bool isLoopWindowActive() const override {
    return auditionActive() ||
           (!windowSuspended() && AudioNode::isLoopWindowActive());
  }

 private:
  // Ownership: message thread only. The audio thread traverses the
  // WHOLE-GRAPH snapshot (graph_snapshot.h) — never this vector.
  std::vector<std::unique_ptr<AudioNode>> children;

  // Scratch buffer for summing children without affecting parent output
  // directly until ready. Preallocated so render() does not touch the
  // heap at normal block sizes. `mutable`: DSP scratch written by the
  // CONST render phase (§2.3).
  mutable juce::AudioBuffer<float> mix_buffer;

  // Mono accumulator for the effect rack: children sum here, the rack
  // processes in place, the result adds to the parent. Same
  // preallocation/growth discipline as mix_buffer. Audio-thread only.
  // `mutable`: same §2.3 DSP-scratch exception.
  mutable juce::AudioBuffer<float> fx_accum_;

  /** The window-mapped context handed to children — the time-map
   * primitive, shared by BOTH phases so control and render see the
   * same child clock. `self`/`context_loop` are set by the caller. */
  ProcessContext childContext(const ProcessContext& context) const;

  // --- Q18 (composition.md §2): the stack's frame ---
  /** The origin this stack's inner timeline is measured from, for the
   * block: its own rendering origin once anchored, else the RECEIVED
   * cycle top (the empty case — no member exists to disagree). */
  int64_t frameOrigin(const ProcessContext& context) const {
    return anchored_.load() ? origin_rt_.load() : context.cycle_epoch;
  }
  /** inner(t) for this block's first sample: mapOffset((t − O − a0) mod
   * P) under an active map, else t − O. */
  int64_t innerOf(const ProcessContext& context,
                  const timing::TimeMap& own_map) const {
    const int64_t O = frameOrigin(context);
    if (!own_map.active()) return context.master_pos - O;
    return own_map.mapOffset(context.master_pos - O - own_map.mapOffset(0));
  }
  /** ONE-SHOT STACK facts (Q5 generalized by Q18): true when this stack
   * sounds once per context cycle. `shot` = the span that sounds (map
   * period, else the inner cycle); `cycle` = the context cycle it
   * rests against. Audio-thread safe (snapshot-space intrinsic). */
  bool oneShotFacts(const ProcessContext& context,
                    const timing::TimeMap& own_map, int64_t& shot,
                    int64_t& cycle) const;
  /** The phase within the one-shot cycle for this block's first sample
   * is in the REST region (nothing sounds; tails ring). */
  bool inRest(const ProcessContext& context) const;

  /**
   * Audio-thread child lookup, shared by both phase bodies: this
   * stack's child span in the whole-graph snapshot (index spans,
   * structural consistency for the whole callback). entryAt() is the
   * child's snapshot entry index — what ProcessContext.self carries
   * down to it.
   */
  struct ChildView {
    const GraphSnapshot* snap;
    int self;
    int count() const;
    int entryAt(int k) const;
    AudioNode* nodeAt(int k) const;
  };
  ChildView childView(const ProcessContext& context) const {
    jassert(context.snap != nullptr);  // the audio thread's only traversal
    return {context.snap, context.self};
  }

  // Pre-split phase bodies (see control/render): each receives a
  // context whose [master_pos, +num_samples) crosses no map seam.
  void controlChildren(const float* const* input_channels,
                       int num_input_channels, const ProcessContext& context);
  void renderChildren(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context) const;

  // Channel-pointer bound for the seam split's shifted-pointer arrays
  // (stack storage; devices never approach this).
  static constexpr int kMaxSplitChannels = 64;

  /**
   * SUB-BLOCK SEAM-SPLIT driver (time_maps.md §5), shared verbatim by
   * BOTH §2.3 phases: an active map's seam mid-block would hand children
   * a linearly-advancing clock across a mapped-time JUMP — up to a block
   * of wrong positions per seam. Splits the block into runs at seam
   * boundaries (bounded: ≤ segments + 1 per pass crossing,
   * allocation-free) and calls `body(channels, channel_count, sub)` per
   * run; with no active map the body runs once with the original
   * arguments. `Ch` is `const float` on the control side and `float` on
   * the render side — the only difference between the two call sites,
   * which is why this is one template rather than two copies that
   * would drift apart.
   */
  template <typename Ch, typename Body>
  void forEachSeamRun(Ch* const* channels, int channel_count,
                      const ProcessContext& context, Body&& body) const {
    const timing::TimeMap own_map = activeTimeMap();
    // The SEQUENCE splits blocks too (docs/sequencer.md S7): gate
    // envelopes are piecewise linear, so runs are cut at envelope
    // corners — the (g0, g1) endpoints renderChildren hands each child
    // are then exact, and output never depends on block boundaries.
    const Sequence* seq = activeSequence();
    // A ONE-SHOT stack (Q18) splits at its shot/rest boundaries too, so
    // no run straddles the moment the group falls silent or fires.
    int64_t shot = 0, cycle = 0;
    const bool one_shot = oneShotFacts(context, own_map, shot, cycle);
    if ((!own_map.active() && seq == nullptr && !one_shot) ||
        context.num_samples <= 0) {
      body(channels, channel_count, context);
      return;
    }
    const int64_t period = own_map.active() ? own_map.period() : 0;
    const int64_t fade = Sequence::fadeSamples(context.sample_rate);
    // THE ANCHOR (Q18): every fold here is measured from this stack's
    // own origin + a0 — the same anchor childContext maps with, so the
    // runs and the mapped child clock agree sample for sample.
    const int64_t O = frameOrigin(context);
    const int64_t a0 = own_map.active() ? own_map.mapOffset(0) : 0;
    const int64_t fold = one_shot ? cycle : period;
    int64_t rel = context.master_pos - O - a0;
    rel = timing::posMod(rel, fold);
    int done = 0;
    while (done < context.num_samples) {
      int64_t dist = context.num_samples - done;
      const bool resting = one_shot && rel >= shot;
      if (one_shot) {
        dist = std::min<int64_t>(dist, resting ? cycle - rel : shot - rel);
      }
      if (period > 0 && !resting) {
        dist = std::min<int64_t>(dist, own_map.seamDistance(rel));
      }
      if (seq != nullptr && !resting) {
        // Corner distance in the CHILD clock (composition law: the map
        // selects song positions; the sequence is looked up there).
        const int64_t crel = period > 0 ? own_map.mapOffset(rel) : rel;
        dist = std::min<int64_t>(dist,
                                 seq->cornerDistance(seq->fold(crel), fade));
      }
      const int run = (int)std::min<int64_t>(context.num_samples - done, dist);
      Ch* shifted[kMaxSplitChannels];
      Ch* const* run_channels = channels;
      int run_channel_count = channel_count;
      if (channels != nullptr && done > 0) {
        run_channel_count = std::min(channel_count, kMaxSplitChannels);
        for (int ch = 0; ch < run_channel_count; ++ch) {
          shifted[ch] = channels[ch] ? channels[ch] + done : nullptr;
        }
        run_channels = shifted;
      }
      ProcessContext sub = context;
      sub.master_pos = context.master_pos + done;
      sub.island_pos = context.island_pos + done;
      sub.num_samples = run;
      sub.input_clock = context.input_clock + done;
      body(run_channels, run_channel_count, sub);
      done += run;
      rel = fold > 0 ? (rel + run) % fold : rel + run;
    }
  }

  // Island state: explicit, stored once — never derived from child
  // durations (a derived Q would change retroactively when a shorter
  // clip commits). 0 = no quantum established in this scope yet.
  std::atomic<int64_t> quantum_samples_{0};
  std::atomic<uint32_t> stop_generation_{0};
  std::atomic<uint32_t> island_generation_{0};
  std::atomic<uint32_t> island_seq_{0};  // seqlock for (Q, epoch)
  std::atomic<int64_t> epoch_samples_{0};

  // The sequence (docs/sequencer.md): immutable object behind ONE
  // atomic pointer (the FxChain discipline — message thread swaps +
  // reclaimer retirement; audio thread loads). The bypass flag gates
  // it exactly like loop_window_bypassed_ gates the map.
  std::atomic<const Sequence*> sequence_{nullptr};
  std::atomic<bool> sequence_bypassed_{false};
  // The step audition (§11.2): −1 = none. Monitoring state, like solo.
  std::atomic<int> audition_step_{-1};
  // S16 window domain (§11.8): stamped by the authoring edit.
  std::atomic<int> window_domain_{0};

  // Take lifecycle: count of armed/capturing takes in this island, and
  // two cycle snapshots taken when the first of them armed: the
  // INTRINSIC committed cycle (epoch re-base growth baseline + origin
  // fold frame) and the HEARD/effective cycle (the take's context
  // frame + audible-equivalence step, Q15).
  std::atomic<int> active_takes_{0};
  std::atomic<int64_t> lcm_before_take_{0};
  std::atomic<int64_t> heard_cycle_at_arm_{0};

  /**
   * If this child's island has no quantum yet and the child carries
   * committed content, its duration establishes Q (covers pre-recorded
   * clips being added to a fresh island).
   */
  void maybeEstablishQuantumFrom(const AudioNode& child);

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StackNode)
};

}  // namespace celestrian
