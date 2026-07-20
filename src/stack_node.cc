#include "stack_node.h"

#include "graph_snapshot.h"
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
  fx_accum_.setSize(1, kMaxExpectedBlockSize);
}

StackNode::~StackNode() = default;

// (The per-stack snapshot machinery — render_children_ +
// republishChildren + the reclaimer plumbed through every stack — is
// gone: the audio thread traverses the WHOLE-GRAPH snapshot published
// by the engine (graph_snapshot.h, Tier 3 Step 3). Node lifetime on
// structural edits is owned by the edit log / the engine's reclaimer.)

juce::var StackNode::getMetadata() const {
  const auto &kids = children;  // message thread: ownership vector
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)kids.size());
  obj->setProperty("isExpanded", (bool)is_expanded.load());
  // Loop window state (loopBypassed/windowActive) publishes from the
  // AudioNode base — fractal with clips (I5). The stack's `playhead`
  // field carries the window phase fraction while the window is active.
  // Island state, for diagnosability: `origin` on clips is ABSOLUTE;
  // the view-frame anchor is (origin − epoch) mod duration. Without the
  // epoch in dumps, "origin = 3Q" looks wrong for a clip recorded at
  // the cycle top (field confusion, 2026-07-09).
  obj->setProperty("quantum", (double)quantum_samples_.load());
  obj->setProperty("epoch", (double)epoch_samples_.load());
  juce::Array<juce::var> childData;
  for (const auto &child : kids) {
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
  const auto &kids = children;  // message thread: ownership vector
  if (kids.empty()) return 0;

  int64_t composite = 0;
  for (const auto &child : kids) {
    int64_t d = child->getIntrinsicDuration();
    if (d > 0) {
      composite = (composite == 0) ? d : timing::lcm(composite, d);
    }
  }
  return composite;
}

int64_t StackNode::getEffectivePeriod() const {
  // E-C: an active window on this stack IS the period (base class).
  if (isLoopWindowActive()) return getLoopEnd() - getLoopStart();
  // Otherwise LCM of children's EFFECTIVE periods — windowed children
  // contribute their window length, so nested windows shorten the
  // audible cycle. Same shape as getIntrinsicDuration, one recursion
  // deeper in honesty.
  const auto &kids = children;  // message thread: ownership vector
  if (kids.empty()) return 0;

  int64_t composite = 0;
  for (const auto &child : kids) {
    int64_t p = child->getEffectivePeriod();
    if (p > 0) {
      composite = (composite == 0) ? p : timing::lcm(composite, p);
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
  const int64_t d = child.getIntrinsicDuration();
  if (d > 0) {
    rootNode()->establishIsland(d, child.origin_samples.load());
  }
}

// --- Take lifecycle (commit as an EVENT — unification_audit.md §1.5) ---

void StackNode::takeArmed() {
  if (active_takes_.fetch_add(1) == 0) {
    // Snapshot the cycles the take begins against: the INTRINSIC
    // committed cycle (growth baseline for the commit re-base; windows
    // must not leak into epoch permanence) and the HEARD cycle (E-C —
    // what the performer is actually listening to; windows shorten it).
    const int64_t q = quantum_samples_.load();
    lcm_before_take_.store(timing::lcm(q, getIntrinsicDuration()));
    heard_cycle_at_arm_.store(timing::lcm(q, getEffectivePeriod()));
  }
}

void StackNode::takeCommitted(int64_t origin, int64_t intrinsic_after) {
  active_takes_.fetch_sub(1);

  // Epoch re-base on cycle growth (recording.md "LCM Expansion Snap",
  // completed 2026-07-16): the cycle top moves to the HEARD top the
  // take was performed against — its origin floored to a whole multiple
  // of the pre-take cycle. Whole-old-cycle moves are PHASE-NEUTRAL for
  // every committed clip (their periods divide the old cycle), so audio
  // alignment and I3 are untouched; what it buys is that the frame the
  // performer WATCHED while recording (the take-anchored whole-cycle
  // shift in the view, view_model.js) persists at commit instead of
  // snapping back (field 2026-07-16: a 5Q take recorded from a heard
  // cycle top displayed at 12Q–17Q of the exploded 20Q frame).
  //   - Simple extension armed at a top: floor(rel/before)·before = rel,
  //     so epoch := origin — the historical rule, unchanged.
  //   - Polyrhythmic growth: previously "keep the old epoch" (the
  //     cursor-sails-on ruling, which predates the recording view
  //     shift); now the WATCHED cursor is what sails on.
  const int64_t before = lcm_before_take_.load();
  if (before <= 0) return;  // first take: epoch was established at arm

  // Passed in (snapshot space) — this event fires on the AUDIO thread,
  // and the stack's own traversal is message-thread-only (Step 3).
  const int64_t after = timing::lcm(quantum_samples_.load(), intrinsic_after);
  if (after <= before) return;

  const int64_t epoch = epoch_samples_.load();
  int64_t rel = origin - epoch;
  if (rel < 0) rel = 0;
  epoch_samples_.store(epoch + (rel / before) * before);
}

void StackNode::addChild(std::unique_ptr<AudioNode> child) {
  child->setParent(this);
  // A live take arriving via a move re-registers with this island
  // (removeChild balanced it out on the way).
  if (child->isArmedOrRecording()) rootNode()->takeArmed();
  maybeEstablishQuantumFrom(*child);
  children.push_back(std::move(child));
}

void StackNode::insertChildAt(std::unique_ptr<AudioNode> child, int index) {
  child->setParent(this);
  if (child->isArmedOrRecording()) rootNode()->takeArmed();
  maybeEstablishQuantumFrom(*child);
  if (index < 0) index = 0;
  if (index >= (int)children.size()) {
    children.push_back(std::move(child));
  } else {
    children.insert(children.begin() + index, std::move(child));
  }
}

std::vector<std::unique_ptr<AudioNode>> StackNode::clearChildren() {
  // DETACH ONLY: the caller (the engine) owns retirement — the audio
  // thread may still traverse these nodes through the outgoing graph
  // snapshot for ≤2 callbacks after the next publish.
  std::vector<std::unique_ptr<AudioNode>> removed;
  for (auto &child : children) {
    if (child->isArmedOrRecording()) rootNode()->takeCancelled();
    child->setParent(nullptr);
    removed.push_back(std::move(child));
  }
  children.clear();
  return removed;
}

std::unique_ptr<AudioNode> StackNode::removeChild(int index) {
  if (index >= 0 && index < (int)children.size()) {
    auto child = std::move(children[index]);
    children.erase(children.begin() + index);
    if (child->isArmedOrRecording()) rootNode()->takeCancelled();
    child->setParent(nullptr);
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

  // Children come from the WHOLE-GRAPH snapshot (one engine-side load
  // per callback — Tier 3 Step 3): index spans, no per-stack atomics,
  // structural consistency across the entire callback. The ownership
  // fallback is the node-level unit-test path only (no engine, single
  // thread, race-free by construction).
  const GraphSnapshot *snap = context.snap;
  const int child_count =
      snap ? snap->entries[(size_t)context.self].childCount
           : (int)children.size();
  auto childEntry = [&](int k) -> int {
    return snap ? snap->childAt(context.self, k) : 0;
  };
  auto childNode = [&](int k) -> AudioNode * {
    return snap ? snap->entries[(size_t)snap->childAt(context.self, k)].node
                : children[(size_t)k].get();
  };

  // Recording context, passed DOWN (P1-6): the longest committed child
  // duration in this scope. Recording/armed children contribute 0
  // (duration resets at arm); nested-stack children contribute their
  // stored duration_samples (0 — stacks don't store one), matching the
  // historical sibling-scan semantics exactly.
  int64_t longest_committed = 0;
  for (int k = 0; k < child_count; ++k) {
    const int64_t d = childNode(k)->duration_samples.load();
    if (d > longest_committed) longest_committed = d;
  }
  child_context.context_loop = longest_committed;

  // With the effect rack ON, children sum into the mono fx accumulator
  // first — the rack shapes the GROUP's summed signal (a stack reverb
  // wets the whole kit), then the result adds to the parent. Children
  // render identical mono to every channel, so folding channel 0 is
  // lossless (the rack goes stereo with the Mono→Stereo roadmap item).
  const bool use_fx = fx_.isLive();
  if (use_fx) {
    if (fx_accum_.getNumSamples() < context.num_samples ||
        fx_accum_.getNumChannels() < 1) {
      fx_accum_.setSize(1, context.num_samples, false, true, true);
    }
    fx_accum_.clear();
  }

  for (int k = 0; k < child_count; ++k) {
    AudioNode *child = childNode(k);
    // Clear mix buffer for this specific child
    mix_buffer.clear();

    // Pass the same input to children (effectively parallel input)
    // Output from child goes into our mix_buffer
    child_context.self = childEntry(k);
    child->process(input_channels, mix_buffer.getArrayOfWritePointers(),
                   num_input_channels, num_output_channels, child_context);

    if (use_fx) {
      fx_accum_.addFrom(0, 0, mix_buffer.getReadPointer(0),
                        context.num_samples);
      continue;
    }

    // Sum child output into our actual output channels
    for (int ch = 0; ch < num_output_channels; ++ch) {
      if (output_channels[ch] != nullptr && ch < mix_buffer.getNumChannels()) {
        juce::FloatVectorOperations::add(output_channels[ch],
                                         mix_buffer.getReadPointer(ch),
                                         context.num_samples);
      }
    }
  }

  if (use_fx) {
    fx_.process(fx_accum_.getWritePointer(0), context.num_samples);
    for (int ch = 0; ch < num_output_channels; ++ch) {
      if (output_channels[ch] != nullptr) {
        juce::FloatVectorOperations::add(output_channels[ch],
                                         fx_accum_.getReadPointer(0),
                                         context.num_samples);
      }
    }
  }
}

juce::var StackNode::getWaveform(int num_peaks) const {
  const auto &kids = children;  // message thread: ownership vector

  if (kids.empty()) return juce::Array<juce::var>();

  // If we only have one child, return its waveform directly to save compute
  if (kids.size() == 1) return kids[0]->getWaveform(num_peaks);

  // Aggregate: Sum peaks from all children (simplified for now)
  // Future: Better recursive mixdown normalization
  juce::Array<juce::var> aggregatePeaks;
  for (int i = 0; i < num_peaks; ++i) aggregatePeaks.add(0.0f);

  for (const auto &child : kids) {
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
        i, (float)aggregatePeaks[i] / (float)std::max(1, (int)kids.size()));
  }

  return aggregatePeaks;
}

AudioNode *StackNode::findNodeByUuid(const juce::String &uuid) {
  if (getUuid() == uuid) return this;

  // Virtual recursion (findByUuid) — no per-child dynamic_cast.
  for (const auto &child : children) {
    if (auto *found = child->findByUuid(uuid)) return found;
  }

  return nullptr;
}

bool StackNode::isAnyChildRecording() const {
  // Virtual dispatch replaces the old per-child dynamic_cast: clips
  // answer from their recording state machine, nested stacks recurse
  // via their own isArmedOrRecording override.
  const auto &kids = children;  // message thread: ownership vector
  for (const auto &child : kids) {
    if (child->isArmedOrRecording()) return true;
  }
  return false;
}

}  // namespace celestrian
