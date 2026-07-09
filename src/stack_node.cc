#include "stack_node.h"

#include "timing.h"

namespace celestrian {

namespace {
// Preallocation for the summing scratch buffer: enough for any common
// device block size so process() never allocates on the audio thread.
constexpr int kMaxExpectedChannels = 2;
constexpr int kMaxExpectedBlockSize = 8192;
}  // namespace

StackNode::StackNode(juce::String node_name) : AudioNode(std::move(node_name)) {
  mix_buffer.setSize(kMaxExpectedChannels, kMaxExpectedBlockSize);
  render_children_.store(new std::vector<AudioNode *>());
}

StackNode::~StackNode() {
  // By destruction time nothing else references this stack; the snapshot
  // can be freed directly.
  delete render_children_.load();
}

void StackNode::setReclaimer(GraphReclaimer *reclaimer) {
  reclaimer_ = reclaimer;
  for (auto &child : children) {
    if (auto *stack = dynamic_cast<StackNode *>(child.get())) {
      stack->setReclaimer(reclaimer);
    }
  }
}

void StackNode::retireOrDelete(std::function<void()> deleter) {
  if (reclaimer_) {
    reclaimer_->retire(std::move(deleter));
  } else {
    deleter();
  }
}

void StackNode::republishChildren() {
  auto *fresh = new std::vector<AudioNode *>();
  fresh->reserve(children.size());
  for (auto &child : children) fresh->push_back(child.get());

  const auto *old = render_children_.exchange(fresh, std::memory_order_acq_rel);
  if (old) retireOrDelete([old] { delete old; });
}

juce::var StackNode::getMetadata() const {
  const auto *kids = renderChildren();
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)kids->size());
  obj->setProperty("isExpanded", (bool)is_expanded.load());
  // Loop window state (time_maps.md): active is independent of
  // expansion; the stack's `playhead` field (base metadata) carries the
  // window phase fraction while the window is active.
  obj->setProperty("loopBypassed", (bool)loop_window_bypassed_.load());
  obj->setProperty("windowActive", isLoopWindowActive());
  // Island state, for diagnosability: `origin` on clips is ABSOLUTE;
  // the view-frame anchor is (origin − epoch) mod duration. Without the
  // epoch in dumps, "origin = 3Q" looks wrong for a clip recorded at
  // the cycle top (field confusion, 2026-07-09).
  obj->setProperty("quantum", (double)quantum_samples_.load());
  obj->setProperty("epoch", (double)epoch_samples_.load());
  juce::Array<juce::var> childData;
  for (auto *child : *kids) {
    childData.add(child->getMetadata());
  }
  obj->setProperty("nodes", childData);
  return base;
}

int64_t StackNode::getIntrinsicDuration() const {
  // Composite duration = LCM of children (docs/recording.md "Nested
  // Stacks and Composite Duration"). Previously this returned the MIN
  // child duration, which doubled as a derived quantum — both wrong;
  // the quantum is now stored island state (P0-3).
  const auto *kids = renderChildren();
  if (kids->empty()) return 0;

  int64_t composite = 0;
  for (auto *child : *kids) {
    int64_t d = child->getIntrinsicDuration();
    if (d > 0) {
      composite = (composite == 0) ? d : timing::lcm(composite, d);
    }
  }
  return composite;
}

int64_t StackNode::getEffectiveQuantum() const {
  // Stored island quantum — never derived from child durations, so it
  // cannot retroactively change when a shorter clip commits (the
  // "vibrating waveform" bug class) and it survives its creator.
  int64_t q = quantum_samples_.load();
  if (q > 0) return q;

  if (auto *p = parent.load()) return p->getEffectiveQuantum();

  return 0;
}

void StackNode::maybeEstablishQuantumFrom(const AudioNode &child) {
  // Find the island root (topmost stack in this hierarchy).
  const AudioNode *top = this;
  while (auto *p = top->getParent()) top = p;
  auto *island = dynamic_cast<StackNode *>(const_cast<AudioNode *>(top));
  if (island == nullptr || island->getQuantum() > 0) return;

  const int64_t d = child.getIntrinsicDuration();
  if (d > 0) {
    island->setQuantum(d, child.origin_samples.load());
  }
}

void StackNode::addChild(std::unique_ptr<AudioNode> child) {
  child->setParent(this);
  if (auto *stack = dynamic_cast<StackNode *>(child.get())) {
    if (reclaimer_) stack->setReclaimer(reclaimer_);
  }
  maybeEstablishQuantumFrom(*child);
  children.push_back(std::move(child));
  republishChildren();
}

void StackNode::insertChildAt(std::unique_ptr<AudioNode> child, int index) {
  child->setParent(this);
  if (auto *stack = dynamic_cast<StackNode *>(child.get())) {
    if (reclaimer_) stack->setReclaimer(reclaimer_);
  }
  maybeEstablishQuantumFrom(*child);
  if (index < 0) index = 0;
  if (index >= (int)children.size()) {
    children.push_back(std::move(child));
  } else {
    children.insert(children.begin() + index, std::move(child));
  }
  republishChildren();
}

void StackNode::removeChild(const juce::String &uuid) {
  auto it = std::find_if(children.begin(), children.end(),
                         [&uuid](const std::unique_ptr<AudioNode> &node) {
                           return node->getUuid() == uuid;
                         });
  if (it != children.end()) {
    (*it)->setParent(nullptr);
    AudioNode *removed = it->release();
    children.erase(it);
    republishChildren();
    // The audio thread may still be processing this node for one more
    // callback; defer destruction.
    retireOrDelete([removed] { delete removed; });
  }
}

void StackNode::clearChildren() {
  if (children.empty()) return;
  auto *removed = new std::vector<std::unique_ptr<AudioNode>>();
  for (auto &child : children) {
    child->setParent(nullptr);
    removed->push_back(std::move(child));
  }
  children.clear();
  republishChildren();
  retireOrDelete([removed] { delete removed; });
}

std::unique_ptr<AudioNode> StackNode::removeChild(int index) {
  if (index >= 0 && index < (int)children.size()) {
    auto child = std::move(children[index]);
    children.erase(children.begin() + index);
    child->setParent(nullptr);
    republishChildren();
    return child;
  }
  return nullptr;
}

void StackNode::process(const float *const *input_channels,
                        float *const *output_channels, int num_input_channels,
                        int num_output_channels,
                        const ProcessContext &context) {
  // Guard for atypical block sizes/channel counts. At normal sizes the
  // buffer was preallocated in the constructor and this never triggers.
  if (mix_buffer.getNumSamples() < context.num_samples ||
      mix_buffer.getNumChannels() < num_output_channels) {
    mix_buffer.setSize(num_output_channels, context.num_samples, false, true,
                       true);
  }

  // === LOOP WINDOW AS TIME-MAP (time_maps.md phase 1) ===
  // The window applies iff it is ACTIVE (valid + not bypassed) —
  // independent of expansion (I6b: collapse is purely visual). Phase is
  // a pure function of the received clock: (t − cycle_epoch) mod len.
  // No private counter, no reset-on-collapse, fully deterministic.
  ProcessContext child_context = context;

  const int64_t window_start = loop_start_samples.load();
  const int64_t window_end = loop_end_samples.load();
  const bool window_active =
      !loop_window_bypassed_.load() && window_end > window_start;

  if (window_active) {
    const int64_t len = window_end - window_start;
    int64_t rel = context.master_pos - context.cycle_epoch;
    rel = ((rel % len) + len) % len;

    // The window selects VIEW positions [start, end) of the received
    // cycle, so the mapped time stays IN THE RECEIVED FRAME:
    // t_child = epoch + start + rel. Children align by their ABSOLUTE
    // origins — dropping the epoch here shifted every child whose
    // origin ≢ 0 (mod duration): field bug 2026-07-09, "2Q clip loops
    // its Q2 when the window selects Q1".
    child_context.master_pos = context.cycle_epoch + window_start + rel;
    // For nested maps: the child frame's cycle top is the window top.
    child_context.cycle_epoch = context.cycle_epoch + window_start;

    // Publish the window phase for the UI (fraction within the window).
    playhead_pos.store((double)rel / (double)len);
  } else {
    playhead_pos.store(0.0);
  }

  // Process each child and sum their results — iterating the immutable
  // published snapshot, no locks on the audio thread.
  const auto *kids = renderChildren();
  for (AudioNode *child : *kids) {
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
  const auto *kids = renderChildren();

  if (kids->empty()) return juce::Array<juce::var>();

  // If we only have one child, return its waveform directly to save compute
  if (kids->size() == 1) return (*kids)[0]->getWaveform(num_peaks);

  // Aggregate: Sum peaks from all children (simplified for now)
  // Future: Better recursive mixdown normalization
  juce::Array<juce::var> aggregatePeaks;
  for (int i = 0; i < num_peaks; ++i) aggregatePeaks.add(0.0f);

  for (auto *child : *kids) {
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
        i, (float)aggregatePeaks[i] / (float)std::max(1, (int)kids->size()));
  }

  return aggregatePeaks;
}

AudioNode *StackNode::findNodeByUuid(const juce::String &uuid) {
  if (getUuid() == uuid) return this;

  const auto *kids = renderChildren();
  for (auto *child : *kids) {
    if (child->getUuid() == uuid) return child;

    if (auto *stack = dynamic_cast<StackNode *>(child)) {
      if (auto *found = stack->findNodeByUuid(uuid)) return found;
    }
  }

  return nullptr;
}

bool StackNode::isAnyChildRecording() const {
  const auto *kids = renderChildren();
  for (auto *child : *kids) {
    // Check if this child is recording
    if (child->is_node_recording.load()) return true;

    // If child is a stack, recursively check its children
    if (auto *stack = dynamic_cast<const StackNode *>(child)) {
      if (stack->isAnyChildRecording()) return true;
    }
  }

  return false;
}

}  // namespace celestrian
