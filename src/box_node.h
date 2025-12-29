#pragma once

#include "audio_node.h"
#include <memory>
#include <mutex>
#include <vector>

namespace celestrian {

/**
 * A container node that sums its children into a single output.
 * This enables the "boxes-within-boxes" hierarchical structure.
 */
class BoxNode : public AudioNode {
public:
  BoxNode(juce::String name);
  ~BoxNode() override = default;

  // AudioNode implementation
  void process(const float *const *inputChannels, float *const *outputChannels,
               int numInputChannels, int numOutputChannels,
               const ProcessContext &context) override;

  juce::var getWaveform(int numPeaks) const override;
  juce::var getMetadata() const override;
  juce::String getNodeType() const override { return "box"; }

  // Box-specific methods
  void addChild(std::unique_ptr<AudioNode> child);
  void removeChild(const AudioNode *child);
  void clearChildren();

  int getNumChildren() const { return (int)children.size(); }
  AudioNode *getChild(int index) { return children[index].get(); }

  int64_t get_primary_quantum() const { return primary_quantum_samples; }
  void set_primary_quantum(int64_t samples) {
    primary_quantum_samples = samples;
  }

private:
  int64_t primary_quantum_samples = 0;
  std::vector<std::unique_ptr<AudioNode>> children;

  mutable std::mutex children_mutex;

  // Scratch buffer for summing children without affecting parent output
  // directly until ready
  juce::AudioBuffer<float> mix_buffer;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(BoxNode)
};

} // namespace celestrian
