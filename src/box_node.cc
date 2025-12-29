#include "box_node.h"

namespace celestrian {

BoxNode::BoxNode(juce::String node_name) : AudioNode(std::move(node_name)) {
  // Basic stereo buffer for summing, resized as needed in process()
  mix_buffer.setSize(2, 512);
}

juce::var BoxNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)children.size());
  obj->setProperty("primary_quantum", (juce::int64)primary_quantum_samples);
  return base;
}

void BoxNode::addChild(std::unique_ptr<AudioNode> child) {
  std::lock_guard<std::mutex> lock(children_mutex);
  children.push_back(std::move(child));
}

void BoxNode::removeChild(const AudioNode *child) {
  std::lock_guard<std::mutex> lock(children_mutex);
  children.erase(
      std::remove_if(children.begin(), children.end(),
                     [child](const auto &ptr) { return ptr.get() == child; }),
      children.end());
}

void BoxNode::clearChildren() {
  std::lock_guard<std::mutex> lock(children_mutex);
  children.clear();
}

void BoxNode::process(const float *const *input_channels,
                      float *const *output_channels, int num_input_channels,
                      int num_output_channels, const ProcessContext &context) {

  // Ensure our mix buffer is large enough for this block
  if (mix_buffer.getNumSamples() < context.num_samples ||
      mix_buffer.getNumChannels() < num_output_channels) {
    mix_buffer.setSize(num_output_channels, context.num_samples, false, true,
                       true);
  }

  std::lock_guard<std::mutex> lock(children_mutex);

  // Process each child and sum their results
  for (const auto &child : children) {
    // Clear mix buffer for this specific child
    mix_buffer.clear();

    // Pass the same input to children (effectively parallel input)
    // Output from child goes into our mix_buffer
    child->process(input_channels, mix_buffer.getArrayOfWritePointers(),
                   num_input_channels, num_output_channels, context);

    // Sum child output into our actual output channels
    for (int ch = 0; ch < num_output_channels; ++ch) {
      if (output_channels[ch] != nullptr && ch < mix_buffer.getNumChannels()) {
        juce::FloatVectorOperations::add(output_channels[ch],
                                         mix_buffer.getReadPointer(ch),
                                         context.num_samples);
      }
    }
  }
}

juce::var BoxNode::getWaveform(int num_peaks) const {
  std::lock_guard<std::mutex> lock(children_mutex);

  if (children.empty())
    return juce::Array<juce::var>();

  // If we only have one child, return its waveform directly to save compute
  if (children.size() == 1)
    return children[0]->getWaveform(num_peaks);

  // Aggregate: Sum peaks from all children (simplified for now)
  // Future: Better recursive mixdown normalization
  juce::Array<juce::var> aggregatePeaks;
  for (int i = 0; i < num_peaks; ++i)
    aggregatePeaks.add(0.0f);

  for (const auto &child : children) {
    juce::var childWaveform = child->getWaveform(num_peaks);
    if (childWaveform.isArray()) {
      auto *childArr = childWaveform.getArray();
      for (int i = 0; i < num_peaks && i < childArr->size(); ++i) {
        float p = (float)aggregatePeaks[i] + (float)childArr->getReference(i);
        aggregatePeaks.set(i, p);
      }
    }
  }

  // Normalize slightly so it doesn't just look like a solid block if many
  // children exist
  for (int i = 0; i < num_peaks; ++i) {
    aggregatePeaks.set(i, (float)aggregatePeaks[i] /
                              (float)std::max(1, (int)children.size()));
  }

  return aggregatePeaks;
}

} // namespace celestrian
