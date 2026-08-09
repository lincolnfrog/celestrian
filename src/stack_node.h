#pragma once

#include <algorithm>
#include <atomic>
#include <functional>
#include <memory>
#include <vector>

#include "audio_node.h"

namespace celestrian {

/**
 * Sink for graph objects that must outlive their removal from the audio
 * thread's view. The audio thread may still be reading a retired child
 * snapshot (or a removed node) for the duration of the callback that was
 * in flight when the mutation happened; the reclaimer (the engine) defers
 * the actual delete until the audio thread has provably moved on.
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
 * message thread. Every structural mutation republishes an immutable
 * child-pointer snapshot that the audio thread reads with a single atomic
 * load — process() takes no locks. Retired snapshots and removed nodes go
 * through the GraphReclaimer so an in-flight callback never reads freed
 * memory. Without a reclaimer (single-threaded unit tests) retired
 * objects are freed immediately.
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

  juce::String getNodeTypeString() const override { return "stack"; }
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
   * Recursively searches for a node by its UUID within this stack and its
   * sub-stacks. (Message thread only.)
   */
  AudioNode* findNodeByUuid(const juce::String& uuid);
  AudioNode* findByUuid(const juce::String& uuid) override {
    return findNodeByUuid(uuid);
  }

  /**
   * Recursively checks if any child node (including nested stacks) is
   * armed or recording. (Message thread only.)
   */
  bool isAnyChildRecording() const;
  bool isArmedOrRecording() const override { return isAnyChildRecording(); }

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

  // --- Island quantum (P0-3 / kernel.md migration step 1) ---
  /**
   * Sets the island's quantum and cycle epoch. Called exactly once, when
   * the first committed clip enters this scope. Q survives its creator
   * (owner ruling, design_language.md Q1): muting or deleting the
   * establishing clip does not change it.
   */
  void setQuantum(int64_t quantum, int64_t epoch) {
    quantum_samples_.store(quantum);
    epoch_samples_.store(epoch);
  }
  int64_t getQuantum() const { return quantum_samples_.load(); }
  int64_t getEpoch() const { return epoch_samples_.load(); }

  /** Establish (Q, epoch) once; q == 0 sets a provisional epoch only
   * (first-clip arm). No-op once Q is locked. */
  void establishIsland(int64_t quantum, int64_t epoch) override {
    if (quantum_samples_.load() != 0) return;
    epoch_samples_.store(epoch);
    if (quantum > 0) quantum_samples_.store(quantum);
  }

  // --- Take lifecycle (commit as an EVENT, unification_audit.md §1.5).
  // Clips report arm/cancel/commit to the island root; the engine's
  // per-block edge detection and graph scans are gone. Counter drift on
  // node removal is guarded in removeChild/clearChildren.
  void takeArmed() override;
  void takeCancelled() override { active_takes_.fetch_sub(1); }
  void takeCommitted(int64_t origin, int64_t intrinsic_after) override;
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
   * otherwise the LCM of the children's EFFECTIVE periods — a windowed
   * child contributes its window length, so nested windows shorten the
   * audible cycle all the way up. Message thread only — the audio
   * thread uses the snapshot-space twin (snapEffectivePeriod,
   * graph_snapshot.h).
   */
  int64_t getEffectivePeriod() const override;

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

  /**
   * Audio-thread child lookup, shared by both phase bodies: the
   * whole-graph snapshot when the engine supplied one (Tier 3 Step 3 —
   * index spans, structural consistency for the whole callback), else
   * the ownership vector (the single-threaded node-level test path,
   * race-free by construction). entryAt() is the child's snapshot entry
   * index for ProcessContext.self (0 in the fallback, where `self` is
   * unused).
   */
  struct ChildView {
    const GraphSnapshot* snap;
    int self;
    const std::vector<std::unique_ptr<AudioNode>>* owned;
    int count() const;
    int entryAt(int k) const;
    AudioNode* nodeAt(int k) const;
  };
  ChildView childView(const ProcessContext& context) const {
    return {context.snap, context.self, &children};
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
   * which is why this is a template rather than two copies (the copies
   * had already begun to drift when they were unified).
   */
  template <typename Ch, typename Body>
  void forEachSeamRun(Ch* const* channels, int channel_count,
                      const ProcessContext& context, Body&& body) const {
    const timing::TimeMap own_map = activeTimeMap();
    if (!own_map.active() || context.num_samples <= 0) {
      body(channels, channel_count, context);
      return;
    }
    const int64_t period = own_map.period();
    int64_t rel = context.master_pos - context.cycle_epoch;
    rel = ((rel % period) + period) % period;
    int done = 0;
    while (done < context.num_samples) {
      const int run = (int)std::min<int64_t>(context.num_samples - done,
                                             own_map.seamDistance(rel));
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
      rel = (rel + run) % period;
    }
  }

  // Island state (P0-3): explicit, stored once — never derived from
  // child durations (deriving caused the retroactive-Q bug class).
  // 0 = no quantum established in this scope yet.
  std::atomic<int64_t> quantum_samples_{0};
  std::atomic<int64_t> epoch_samples_{0};

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
