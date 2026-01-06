#pragma once

#include <memory>
#include <mutex>
#include <vector>

#include "audio_node.h"

namespace celestrian {

/**
 * A container node that sums its children into a single output.
 * This enables the hierarchical structure of stacks-within-stacks.
 */
class StackNode : public AudioNode {
 public:
  StackNode(juce::String name);
  ~StackNode() override = default;

  // AudioNode implementation
  /**
   * Recursively sums the output of all child nodes into the provided output
   * channels.
   * @param input_channels Pointer to hardware input samples.
   * @param output_channels Pointer to output samples to be filled.
   * @param num_input_channels Number of hardware inputs.
   * @param num_output_channels Number of hardware outputs.
   * @param context Processing context (transport, sample rate).
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
   * Adds a child node to this container.
   */
  void addChild(std::unique_ptr<AudioNode> child);

  /**
   * Removes a child node from this container.
   */
  void removeChild(const juce::String &uuid);

  /**
   * Removes and returns a child node by index (for moving between stacks).
   */
  std::unique_ptr<AudioNode> removeChild(int index);

  /**
   * Removes and deletes all child nodes.
   */
  void clearChildren();

  /**
   * Recursively searches for a node by its UUID within this stack and its
   * sub-stacks.
   */
  AudioNode *findNodeByUuid(const juce::String &uuid);

  /**
   * Returns the number of children in this stack.
   */
  int getNumChildren() const { return (int)children.size(); }

  /**
   * Returns a raw pointer to the child at the specified index.
   */
  AudioNode *getChild(int index) { return children[index].get(); }

 private:
  std::vector<std::unique_ptr<AudioNode>> children;

  mutable std::recursive_mutex children_mutex;

  // Scratch buffer for summing children without affecting parent output
  // directly until ready
  juce::AudioBuffer<float> mix_buffer;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(StackNode)
};

}  // namespace celestrian
