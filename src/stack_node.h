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
   * Removes and destroys a child node (via the reclaimer when set).
   * (Message thread only.)
   */
  void removeChild(const juce::String &uuid);

  /**
   * Removes and returns a child node by index (for moving between stacks).
   * The caller keeps the node alive; the audio thread may still be
   * processing it until the next callback. (Message thread only.)
   */
  std::unique_ptr<AudioNode> removeChild(int index);

  /**
   * Removes and deletes all child nodes. (Message thread only.)
   */
  void clearChildren();

  /**
   * Recursively searches for a node by its UUID within this stack and its
   * sub-stacks.
   */
  AudioNode *findNodeByUuid(const juce::String &uuid);

  /**
   * Recursively checks if any child node (including nested stacks) is
   * recording. Safe on the audio thread.
   */
  bool isAnyChildRecording() const;

  /**
   * Returns the number of children in this stack.
   */
  int getNumChildren() const { return (int)renderChildren()->size(); }

  /**
   * Returns a raw pointer to the child at the specified index.
   */
  AudioNode *getChild(int index) { return (*renderChildren())[(size_t)index]; }

  /**
   * Returns the current immutable child snapshot. Audio-thread iteration
   * must use this (one atomic load for the whole loop) rather than paired
   * getNumChildren()/getChild() calls, which could straddle a republish.
   * The reference stays valid for the remainder of the current callback.
   */
  const std::vector<AudioNode *> &getChildrenSnapshot() const {
    return *renderChildren();
  }

  /**
   * Wires the deferred-free sink for this stack and (recursively) any
   * nested stacks. New stacks added later inherit it automatically.
   */
  void setReclaimer(GraphReclaimer *reclaimer);

  /**
   * Resets the internal transport counter. Call when:
   * - Stack is collapsed
   * - Loop region changes
   * - Playback stops/resets
   */
  void resetInternalTransport(int64_t initial_pos = 0) {
    internal_transport_.store(initial_pos);
  }

  /**
   * Gets the current internal transport position.
   */
  int64_t getInternalTransport() const { return internal_transport_.load(); }

 private:
  const std::vector<AudioNode *> *renderChildren() const {
    return render_children_.load(std::memory_order_acquire);
  }

  /**
   * Rebuilds the immutable child-pointer snapshot from `children` and
   * atomically publishes it. Call after every mutation, on the message
   * thread, before returning to the caller.
   */
  void republishChildren();

  /** Hands an object to the reclaimer, or frees it now if there is none. */
  void retireOrDelete(std::function<void()> deleter);

  // Ownership: message thread only.
  std::vector<std::unique_ptr<AudioNode>> children;

  // Immutable snapshot read by the audio thread. Never null after
  // construction.
  std::atomic<const std::vector<AudioNode *> *> render_children_{nullptr};

  GraphReclaimer *reclaimer_ = nullptr;

  // Scratch buffer for summing children without affecting parent output
  // directly until ready. Preallocated so process() does not touch the
  // heap at normal block sizes.
  juce::AudioBuffer<float> mix_buffer;

  // Stack's own transport counter for collapsed playback
  // Wraps at (loop_end - loop_start), independent of global transport
  std::atomic<int64_t> internal_transport_{0};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StackNode)
};

}  // namespace celestrian
