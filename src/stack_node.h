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
 * thread's view: a removed node, a swapped content buffer, a replaced
 * fx chain or an outgoing snapshot may still be read by the callback in
 * flight. The reclaimer (the engine) defers the delete until the audio
 * thread has provably moved on (a two-callback grace).
 */
class GraphReclaimer {
 public:
  virtual ~GraphReclaimer() = default;

  /** Message thread. `deleter` runs when it is safe to free. */
  virtual void retire(std::function<void()> deleter) = 0;
};

/**
 * A container node: it sums its children through the group fx rack, and
 * stacks nest. The session root is one, and owns the island facts.
 *
 * The `children` vector is OWNERSHIP and belongs to the message thread
 * (AudioNode's threading note). control() and render() iterate this
 * stack's child span in the whole-graph snapshot, which the engine
 * republishes after every structural edit (AudioEngine::publishGraph);
 * removed nodes go through the GraphReclaimer.
 */
class StackNode : public AudioNode {
 public:
  StackNode(juce::String name);
  ~StackNode() override;

  // Both phases run through forEachSeamRun: one read of this stack's
  // scope facts per phase, the block cut into runs at its seams
  // (time_maps.md §4), the *Children helpers as the per-run bodies — so
  // control and render see the same child clock, run for run.
  void control(const float* const* input_channels, int num_input_channels,
               const ProcessContext& context) override;
  void render(float* const* output_channels, int num_output_channels,
              const ProcessContext& context) const override;

  /** Empty: peaks are per clip, and the UI composites a group's picture
   * from its members. */
  juce::var getWaveform(int) const override { return juce::Array<juce::var>(); }

  /** The base metadata plus the island facts, the sequence and every
   * child's metadata. */
  juce::var getMetadata() const override;

  NodeType getNodeType() const override { return NodeType::Stack; }

  int64_t getIntrinsicDuration() const override;
  int64_t getEffectiveQuantum() const override;

  // --- Ownership: MESSAGE THREAD ONLY (AudioNode's threading note) ---
  void addChild(std::unique_ptr<AudioNode> child);
  void insertChildAt(std::unique_ptr<AudioNode> child, int index);

  /** Detach and return one child (null when out of range) / every
   * child. The caller owns retirement: the audio thread may still
   * traverse them through the outgoing snapshot. */
  std::unique_ptr<AudioNode> removeChild(int index);
  std::vector<std::unique_ptr<AudioNode>> clearChildren();

  AudioNode* findByUuid(const juce::String& uuid) override;

  /** True when any child (nested stacks recurse) is armed or recording. */
  bool isArmedOrRecording() const override;

  /** TEST-ONLY: the samples per channel the mix buffer and the
   * accumulator hold, together (a growth of either shows). */
  int renderScratchSamplesForTest() const {
    return mix_buffer.getNumSamples() + fx_accum_.getNumSamples();
  }

  int getNumChildren() const { return (int)children.size(); }
  AudioNode* getChild(int index) { return children[(size_t)index].get(); }
  const std::vector<std::unique_ptr<AudioNode>>& ownedChildren() const {
    return children;
  }

  // --- Island facts (kernel.md): meaningful on the island root ---
  /** Set the island's quantum and zero: at the first commit, and
   * whenever a message-thread edit re-establishes the grid (a definer
   * re-trim, a revert to empty, a geometry scrub, a seek, a session
   * load). Otherwise Q survives its creator (Q1, design_language.md):
   * muting or deleting the establishing clip does not change it. */
  void setQuantum(int64_t quantum, int64_t zero) {
    setIslandFacts(quantum, zero, island_generation_.load());
  }
  /** (Q, zero, generation) are ONE fact behind a seqlock: three
   * separate loads would let a re-trim land between them and hand a
   * block a mixed pair. The generation gates every node's rendering
   * origin (AudioNode::setOriginGated): a writer that moves origins
   * with the zero names a new generation, so a block adopts the new
   * origins iff it read the new zero. Single writer at a time: the
   * message thread, or the audio thread's first-take establishment —
   * message-thread fact writers are refused under a live take. */
  void setIslandFacts(int64_t quantum, int64_t zero, uint32_t generation) {
    island_lock_.write([&](int slot) {
      if (slot == 0) {
        quantum_samples_.store(quantum);
        zero_samples_.store(zero);
        island_generation_.store(generation);
      } else {
        island_shadow_.quantum.store(quantum);
        island_shadow_.zero.store(zero);
        island_shadow_.generation.store(generation);
      }
    });
  }
  int64_t getQuantum() const { return quantum_samples_.load(); }
  int64_t getZero() const { return zero_samples_.load(); }
  struct IslandFacts {
    int64_t quantum = 0;
    int64_t zero = 0;
    uint32_t generation = 0;
  };
  /** (Q, zero, generation) read as one fact. Audio-thread safe. */
  IslandFacts readIslandFacts() const {
    IslandFacts f;
    island_lock_.read([&](int slot) {
      if (slot == 0) {
        f.quantum = quantum_samples_.load();
        f.zero = zero_samples_.load();
        f.generation = island_generation_.load();
      } else {
        f.quantum = island_shadow_.quantum.load();
        f.zero = island_shadow_.zero.load();
        f.generation = island_shadow_.generation.load();
      }
    });
    return f;
  }

  /** Transport seek: move the zero so the clock reads as a chosen phase
   * — the clock itself is never reset (kernel.md). Message thread; the
   * audio thread adopts it at the next block top. */
  void seekZeroTo(int64_t zero, uint32_t generation) {
    setIslandFacts(quantum_samples_.load(), zero, generation);
  }

  /** Group-stop generation (ProcessContext::stop_generation): the
   * engine reserves the next value, parks it on every member, then
   * publishes it here in ONE store. */
  uint32_t nextStopGeneration() { return stop_generation_.load() + 1; }
  /** Island generation (ProcessContext::island_generation): a writer
   * names the next one, gates the origins on it, then writes it with
   * the zero in ONE setIslandFacts. */
  uint32_t nextIslandGeneration() { return island_generation_.load() + 1; }
  uint32_t islandGeneration() const { return island_generation_.load(); }
  void publishStopGeneration(uint32_t g) { stop_generation_.store(g); }
  uint32_t stopGeneration() const { return stop_generation_.load(); }

  void establishIsland(int64_t quantum, int64_t zero) override {
    if (quantum_samples_.load() != 0) return;
    setQuantum(quantum > 0 ? quantum : 0, zero);
  }

  // --- THE Q HAND-OFF (Q22, design_language.md §5) ---
  /** The island's DESIGNATED Q-definer: the uuid the last hand-off
   * named, empty = none. engine_internal::definer answers it first
   * while it names a valid definer target; a stale one (the node
   * deleted, made a one-shot, …) is ignored but kept, so undoing what
   * made it stale revives it. Message thread only; changed only through
   * Edit::Definer and a session load. */
  const juce::String& definerDesignation() const { return definer_designation_; }
  void setDefinerDesignation(const juce::String& uuid) {
    definer_designation_ = uuid;
  }

  // --- Take lifecycle (the events AudioNode declares). Structural
  // edits keep the count balanced (addChild / removeChild /
  // clearChildren).
  void takeArmed() override;
  void takeCancelled() override { active_takes_.fetch_sub(1); }
  void takeCommitted() override { active_takes_.fetch_sub(1); }
  bool hasActiveTake() const override { return active_takes_.load() > 0; }
  int64_t activeTakeHeardCycle() const override {
    return heard_cycle_at_arm_.load();
  }

  int64_t getIslandZero() const override {
    if (quantum_samples_.load() > 0) return zero_samples_.load();
    if (auto* p = parent.load()) return p->getIslandZero();
    return 0;
  }

  // --- THE SEQUENCE (sequencer.md): an immutable Sequence behind one
  // atomic pointer (the one-pointer discipline, AudioNode::fxChain).
  // The bypass flag is the jam toggle: bypassed = everything sounds,
  // and the geometry survives (I9).
  const Sequence* sequencePtr() const { return sequence_.load(); }
  /** Swap in `fresh` (heap-owned and finalize()d, or null to clear);
   * returns the OLD pointer, which the caller must retire. */
  const Sequence* exchangeSequence(const Sequence* fresh) {
    return sequence_.exchange(fresh);
  }
  bool isSequenceBypassed() const { return sequence_bypassed_.load(); }
  void setSequenceBypassed(bool b) { sequence_bypassed_.store(b); }
  /** The sequence iff it is ACTIVE: present, non-empty, not bypassed. */
  const Sequence* activeSequence() const {
    if (sequence_bypassed_.load()) return nullptr;
    const Sequence* s = sequence_.load();
    return (s != nullptr && s->total > 0) ? s : nullptr;
  }
  int64_t activeSequenceLen() const override {
    const Sequence* s = activeSequence();
    return s != nullptr ? s->total : 0;
  }

  // --- THE STEP AUDITION (sequencer.md §11.2) ---
  // "Loop this step": a monitoring gesture (not undoable, not
  // persisted). While set and the sequence is active, the stack's
  // time-map IS the step's span, derived from the sequence: it follows
  // a step resize, cannot outlive the sequence, and leaves any authored
  // window untouched underneath (I9). Recording through it is
  // through-map recording aimed at the step (§4 Mode 2).
  int auditionStep() const { return audition_step_.load(); }
  void setAuditionStep(int step) { audition_step_.store(step); }
  /** The audition's derived map, or none when no audition applies (no
   * step set, sequence inactive, or the index gone). A step the program
   * visits more than once loops its FIRST visit (sequencer.md §14); an
   * unreachable step has no span. */
  timing::TimeMap auditionMap() const {
    return auditionMapOver(activeSequence());
  }
  bool auditionActive() const { return auditionMap().active(); }

  // --- THE WINDOW DOMAIN (S16, sequencer.md §11.8) ---
  // A window authored over a sequence timeline selects spans of the
  // song, and means nothing once the sequence is bypassed. The
  // authoring edit stamps the domain; a sequence-domain window is
  // SUSPENDED — it reads as no map, and is never deleted (I9) — while
  // the sequence is off, and returns with it.
  enum class WindowDomain : int { Intrinsic = 0, Sequence = 1 };
  WindowDomain windowDomain() const {
    return (WindowDomain)window_domain_.load();
  }
  void setWindowDomain(WindowDomain d) { window_domain_.store((int)d); }
  /** The authored window is suspended: sequence-domain, sequence off. */
  bool windowSuspended() const {
    return windowDomain() == WindowDomain::Sequence &&
           activeSequence() == nullptr &&
           AudioNode::activeTimeMap().active();
  }
  timing::TimeMap activeTimeMap() const override {
    return activeTimeMapOver(activeSequence());
  }

 private:
  // Ownership (message thread only).
  std::vector<std::unique_ptr<AudioNode>> children;

  // Scratch for one child's render before it joins the sum, and the
  // accumulator the group rack processes in place. Preallocated so
  // render() touches no heap at normal block sizes. `mutable`: DSP
  // scratch (AudioNode::render).
  mutable juce::AudioBuffer<float> mix_buffer;
  mutable juce::AudioBuffer<float> fx_accum_;

  // One seam run's slice of the block's live MIDI, re-based to the
  // run's first sample (forEachSeamRun). Preallocated for the most the
  // input queue can deliver in a block, so slicing never touches the
  // heap. `mutable`: DSP scratch.
  mutable juce::MidiBuffer midi_slice_;

  /** auditionMap() over `seq` — the ACTIVE sequence as the caller read
   * it (null = none). */
  timing::TimeMap auditionMapOver(const Sequence* seq) const {
    const int i = audition_step_.load();
    if (i < 0 || seq == nullptr || i >= seq->numSteps())
      return timing::TimeMap::none();
    const int k = seq->first_visit[i];
    if (k < 0) return timing::TimeMap::none();
    return timing::TimeMap::single(seq->bounds[k], seq->bounds[k + 1]);
  }
  /** activeTimeMap() over `seq` — the ACTIVE sequence as the caller
   * read it: the audition's derived map, else the authored one unless
   * it is suspended. */
  timing::TimeMap activeTimeMapOver(const Sequence* seq) const {
    if (const timing::TimeMap a = auditionMapOver(seq); a.active()) return a;
    if (windowDomain() == WindowDomain::Sequence && seq == nullptr)
      return timing::TimeMap::none();
    return AudioNode::activeTimeMap();
  }

  /**
   * THE SCOPE FACTS: everything about this stack that one phase of one
   * block renders against, read ONCE (scopeFacts) and handed to every
   * seam run. The runs, the child clock, the rest, the gate lookup and
   * the playhead must come from the same map, sequence and origin: a
   * second read could land after an edit, cutting runs for one map and
   * mapping the clock with another.
   */
  struct ScopeFacts {
    timing::TimeMap map;            // the active map (none = no window)
    const Sequence* seq = nullptr;  // the active sequence
    int64_t origin = 0;             // the frame origin O (frameOrigin)
    timing::StackFold fold;         // how the child clock folds
    int64_t child_cycle = 0;        // the scope cycle the children receive
  };
  ScopeFacts scopeFacts(const ProcessContext& context) const;

  /** The context handed to children for one seam run, shared by both
   * phases. `at` is the run's read of the render equation
   * (forEachSeamRun); `self` is set by the caller. */
  ProcessContext childContext(const ProcessContext& context,
                              const ScopeFacts& facts,
                              const timing::InnerAt& at) const;

  /** This stack's child span in the whole-graph snapshot. entryAt() is
   * the child's entry index — what ProcessContext::self carries down. */
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

  // The per-run phase bodies: each receives a context whose
  // [master_pos, +num_samples) crosses no seam of this stack.
  void controlChildren(const float* const* input_channels,
                       int num_input_channels, const ProcessContext& context,
                       const ScopeFacts& facts, const timing::InnerAt& at);
  void renderChildren(float* const* output_channels, int num_output_channels,
                      const ProcessContext& context, const ScopeFacts& facts,
                      const timing::InnerAt& at) const;

  // Channel-pointer bound for the seam split's shifted-pointer arrays
  // (stack storage; devices never approach this).
  static constexpr int kMaxSplitChannels = 64;

  /**
   * THE SEAM-RUN DRIVER (time_maps.md §4), shared by both phases. Reads
   * the scope facts once, then cuts the block into runs so that no run
   * crosses a moment the child clock jumps or a gate envelope bends: a
   * map seam, a one-shot's shot or rest boundary, a sequence visit
   * boundary or gate-ramp corner. Calls `body(channels, channel_count,
   * sub, facts, at)` per run; `at` is the render equation at the run's
   * first sample (for a transparent stack, `at.inner` is the received
   * clock's offset from the origin). Bounded and allocation-free.
   *
   * `sub` is the run's context. Its clocks advance (master_pos,
   * island_pos, input_clock) and its BLOCK-RELATIVE fields
   * (ProcessContext) are re-sliced: gate_g0/g1 become the run's stretch
   * of the parent's line, and live_midi the run's own events, re-based
   * to the run — every event belongs to exactly one run. An unsplit
   * block passes the original context through.
   *
   * `Ch` is `const float` for control and `float` for render. Defined
   * in stack_node.cc, its only user.
   */
  template <typename Ch, typename Body>
  void forEachSeamRun(Ch* const* channels, int channel_count,
                      const ProcessContext& context, Body&& body) const;

  // The island quantum: stored, never derived from child durations (a
  // derived Q would change retroactively when a shorter clip commits).
  // 0 = none established in this scope.
  std::atomic<int64_t> quantum_samples_{0};
  std::atomic<uint32_t> stop_generation_{0};
  std::atomic<uint32_t> island_generation_{0};
  SeqLock island_lock_;  // seqlock for (Q, zero, generation)
  std::atomic<int64_t> zero_samples_{0};
  // The seqlock's shadow copy of (Q, zero, generation) (seq_locked.h).
  struct {
    std::atomic<int64_t> quantum{0};
    std::atomic<int64_t> zero{0};
    std::atomic<uint32_t> generation{0};
  } island_shadow_;
  juce::String definer_designation_;  // message thread only

  std::atomic<const Sequence*> sequence_{nullptr};
  std::atomic<bool> sequence_bypassed_{false};
  std::atomic<int> audition_step_{-1};  // −1 = none
  std::atomic<int> window_domain_{0};   // a WindowDomain

  // Take lifecycle: the count of armed/capturing takes in this island,
  // and the heard cycle snapshotted when the first of them armed
  // (activeTakeHeardCycle).
  std::atomic<int> active_takes_{0};
  std::atomic<int64_t> heard_cycle_at_arm_{0};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StackNode)
};

}  // namespace celestrian
