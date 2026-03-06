#include "stack_node.h"

namespace celestrian {

StackNode::StackNode(juce::String node_name) : AudioNode(std::move(node_name)) {
  // Basic stereo buffer for summing, resized as needed in process()
  mix_buffer.setSize(2, 512);
}

juce::var StackNode::getMetadata() const {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)children.size());
  obj->setProperty("isExpanded", (bool)is_expanded.load());
  // Expose internal transport for UI synchronization when collapsed
  obj->setProperty("internalTransport", (double)internal_transport_.load());
  juce::Array<juce::var> childData;
  for (const auto &child : children) {
    childData.add(child->getMetadata());
  }
  obj->setProperty("nodes", childData);
  return base;
}

int64_t StackNode::getIntrinsicDuration() const {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  if (children.empty()) return 0;

  int64_t minDuration = 0;
  for (const auto &child : children) {
    int64_t d = child->getIntrinsicDuration();
    if (d > 0) {
      if (minDuration == 0 || d < minDuration) minDuration = d;
    }
  }
  return minDuration;
}

int64_t StackNode::getEffectiveQuantum() const {
  // 1. Try children
  int64_t d = getIntrinsicDuration();
  if (d > 0) return d;

  // 2. Try parent
  if (parent) return parent->getEffectiveQuantum();

  return 0;
}

void StackNode::addChild(std::unique_ptr<AudioNode> child) {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  child->setParent(this);
  children.push_back(std::move(child));
}

void StackNode::insertChildAt(std::unique_ptr<AudioNode> child, int index) {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  child->setParent(this);
  if (index < 0) index = 0;
  if (index >= (int)children.size()) {
    children.push_back(std::move(child));
  } else {
    children.insert(children.begin() + index, std::move(child));
  }
}

void StackNode::removeChild(const juce::String &uuid) {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  auto it = std::find_if(children.begin(), children.end(),
                         [&uuid](const std::unique_ptr<AudioNode> &node) {
                           return node->getUuid() == uuid;
                         });
  if (it != children.end()) {
    (*it)->setParent(nullptr);
    children.erase(it);
  }
}

void StackNode::clearChildren() {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  for (auto &child : children) {
    child->setParent(nullptr);
  }
  children.clear();
}

std::unique_ptr<AudioNode> StackNode::removeChild(int index) {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);
  if (index >= 0 && index < (int)children.size()) {
    auto child = std::move(children[index]);
    children.erase(children.begin() + index);
    child->setParent(nullptr);
    return child;
  }
  return nullptr;
}

void StackNode::process(const float *const *input_channels,
                        float *const *output_channels, int num_input_channels,
                        int num_output_channels,
                        const ProcessContext &context) {
  // Ensure our mix buffer is large enough for this block
  if (mix_buffer.getNumSamples() < context.num_samples ||
      mix_buffer.getNumChannels() < num_output_channels) {
    mix_buffer.setSize(num_output_channels, context.num_samples, false, true,
                       true);
  }

  std::lock_guard<std::recursive_mutex> lock(children_mutex);

  // === LOOP-ON-COLLAPSE MODEL (Internal Transport) ===
  // When collapsed, stack uses its OWN transport counter that wraps at
  // loop_duration. This solves the issue where global transport wrapping at LCM
  // caused alternating loop cycles (e.g., 2Q then 1Q when LCM=3Q, loop=2Q).
  int64_t child_master_pos;

  if (!is_expanded.load()) {
    int64_t stack_loop_start = loop_start_samples.load();
    int64_t stack_loop_end = loop_end_samples.load();

    if (stack_loop_end > stack_loop_start) {
      int64_t loop_duration = stack_loop_end - stack_loop_start;

      // Use internal transport (increments independently, wraps at
      // loop_duration)
      int64_t current_internal = internal_transport_.load();
      child_master_pos = stack_loop_start + (current_internal % loop_duration);

      // Advance internal transport if playing
      if (context.is_playing) {
        internal_transport_.fetch_add(context.num_samples);

        // Prevent overflow (optional - modulo handles it, but keeps numbers
        // small)
        if (internal_transport_.load() >= loop_duration * 1000) {
          internal_transport_.store(internal_transport_.load() % loop_duration);
        }
      }

    } else {
      // No valid loop region - pass through global transport
      child_master_pos = context.master_pos;
    }
  } else {
    // === EXPANDED: Pass through global transport unchanged ===
    child_master_pos = context.master_pos;
  }

  // Create modified context for children
  ProcessContext child_context = context;
  child_context.master_pos = child_master_pos;

  // Process each child and sum their results
  for (const auto &child : children) {
    // Clear mix buffer for this specific child
    mix_buffer.clear();

    // Pass the same input to children (effectively parallel input)
    // Output from child goes into our mix_buffer
    child->process(input_channels, mix_buffer.getArrayOfWritePointers(),
                   num_input_channels, num_output_channels, child_context);

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

juce::var StackNode::getWaveform(int num_peaks) const {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);

  if (children.empty()) return juce::Array<juce::var>();

  // If we only have one child, return its waveform directly to save compute
  if (children.size() == 1) return children[0]->getWaveform(num_peaks);

  // Aggregate: Sum peaks from all children (simplified for now)
  // Future: Better recursive mixdown normalization
  juce::Array<juce::var> aggregatePeaks;
  for (int i = 0; i < num_peaks; ++i) aggregatePeaks.add(0.0f);

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
    aggregatePeaks.set(
        i, (float)aggregatePeaks[i] / (float)std::max(1, (int)children.size()));
  }

  return aggregatePeaks;
}

AudioNode *StackNode::findNodeByUuid(const juce::String &uuid) {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);

  if (getUuid() == uuid) return this;

  for (auto &child : children) {
    if (child->getUuid() == uuid) return child.get();

    if (auto *stack = dynamic_cast<StackNode *>(child.get())) {
      if (auto *found = stack->findNodeByUuid(uuid)) return found;
    }
  }

  return nullptr;
}

bool StackNode::isAnyChildRecording() const {
  std::lock_guard<std::recursive_mutex> lock(children_mutex);

  for (const auto &child : children) {
    // Check if this child is recording
    if (child->is_node_recording.load()) return true;

    // If child is a stack, recursively check its children
    if (auto *stack = dynamic_cast<StackNode *>(child.get())) {
      if (stack->isAnyChildRecording()) return true;
    }
  }

  return false;
}

}  // namespace celestrian
