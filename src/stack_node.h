#pragma once

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
  /**
   * Recursively sums the output of all child nodes into the provided output
   * channels. Lock-free: iterates the published child snapshot.
   */
  void process(const float *const *input_channels,
               float *const *output_channels, int num_input_channels,
               int num_output_channels, const ProcessContext &context) override;

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
  AudioNode *findNodeByUuid(const juce::String &uuid);
  AudioNode *findByUuid(const juce::String &uuid) override {
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
  AudioNode *getChild(int index) { return children[(size_t)index].get(); }

  /**
   * The OWNERSHIP children — message thread only (the vector mutates on
   * structural edits with no synchronization). Audio-thread traversal
   * goes through the whole-graph snapshot (ProcessContext.snap /
   * graph_snapshot.h); this accessor exists for the snapshot builder
   * and message-side readers (metadata, session_io, engine helpers).
   */
  const std::vector<std::unique_ptr<AudioNode>> &ownedChildren() const {
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

  /**
   * Re-bases the island's cycle epoch (simple-extension commits move the
   * cycle top to the new phrase's origin — audio untouched).
   */
  void setEpoch(int64_t epoch) { epoch_samples_.store(epoch); }

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
    if (auto *p = parent.load()) return p->getIslandEpoch();
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
  // directly until ready. Preallocated so process() does not touch the
  // heap at normal block sizes.
  juce::AudioBuffer<float> mix_buffer;

  // Mono accumulator for the effect rack: children sum here, the rack
  // processes in place, the result adds to the parent. Same
  // preallocation/growth discipline as mix_buffer. Audio-thread only.
  juce::AudioBuffer<float> fx_accum_;

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
  void maybeEstablishQuantumFrom(const AudioNode &child);

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StackNode)
};

}  // namespace celestrian
