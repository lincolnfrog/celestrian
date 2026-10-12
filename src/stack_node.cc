// StackNode — the container. This file owns
//   - child ownership edits (message thread only);
//   - scopeFacts(): one read per phase of what this stack renders
//     against (active map, sequence, origin, fold, scope cycle);
//   - forEachSeamRun(): the block cut into runs at this stack's seams,
//     each with its own clocks, gate stretch and live-MIDI slice;
//   - childContext(): the per-run re-scoping of ProcessContext (mapped
//     clock, scope cycle, active map, cue re-base, the one-shot's rest);
//   - control() / render(): recursion over the snapshot through those
//     runs, the sequencer gate and the group output stage;
//   - the take lifecycle events, and the period / duration / metadata
//     readouts.

#include "stack_node.h"

#include "graph_snapshot.h"
#include "midi_sequence.h"
#include "timing.h"

namespace celestrian {

namespace {
// The summing scratch is a stereo pair of the block ceiling, so render()
// never allocates on the audio thread.
constexpr int kMaxExpectedChannels = 2;
// The most one block's live MIDI can carry: the input queue's capacity
// (one drain per callback, midi_input_queue.h).
constexpr int kMaxLiveMidiBytes =
    MidiInputQueue::kCapacity * kMidiBufferEventBytes;
}  // namespace

StackNode::StackNode(juce::String node_name) : AudioNode(std::move(node_name)) {
  mix_buffer.setSize(kMaxExpectedChannels, kMaxBlockSamples);
  fx_accum_.setSize(kMaxExpectedChannels, kMaxBlockSamples);
  midi_slice_.ensureSize(kMaxLiveMidiBytes);
}

StackNode::~StackNode() {
  // As for chain_ (~AudioNode): no in-flight audio can still be reading
  // the sequence here.
  delete sequence_.load();
}

juce::var StackNode::getMetadata() const {
  const auto& kids = children;  // message thread: ownership vector
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)kids.size());
  // The island facts. A clip's `origin` is ABSOLUTE and its view-frame
  // anchor is (origin − zero) mod duration, so a state dump is
  // unreadable without the zero.
  obj->setProperty("quantum", (double)quantum_samples_.load());
  obj->setProperty("zero", (double)zero_samples_.load());
  // Under a step audition the DERIVED window is the one the UI must
  // draw: publish it over the base fields. The authored window is
  // untouched and returns to the metadata when the audition ends (I9).
  if (const timing::TimeMap a = auditionMap(); a.active()) {
    obj->setProperty("loopStart", (double)a.segs[0].start);
    obj->setProperty("loopEnd", (double)a.segs[0].end);
    obj->setProperty("loopBypassed", false);
    obj->setProperty("windowActive", true);
    obj->removeProperty("segments");
    // The derived window reads from its own start (the stored top
    // belongs to the authored region).
    obj->setProperty("loopTop", (double)a.segs[0].start);
  }
  obj->setProperty("windowDomain",
                   windowDomain() == WindowDomain::Sequence ? "sequence"
                                                             : "intrinsic");
  obj->setProperty("windowSuspended", windowSuspended());
  // The sequence, published RAW like segments: bypassed geometry
  // survives in the UI (I9). Step lengths in samples; gates as uuid →
  // one 0/1 per step (absent uuid = on everywhere); `next` per step
  // when explicit; and the seed, the derived program (step index per
  // visit) and the radio flag (sequencer.md §14).
  if (const Sequence* s = sequence_.load()) {
    auto* so = new juce::DynamicObject();
    so->setProperty("bypassed", (bool)sequence_bypassed_.load());
    juce::Array<juce::var> steps;
    for (const auto& st : s->steps) {
      auto* stepo = new juce::DynamicObject();
      stepo->setProperty("name", st.name);
      stepo->setProperty("len", (double)st.len);
      stepo->setProperty("cue", st.cue);
      if (!st.next.empty())
        stepo->setProperty("next", Sequence::successorsVar(st));
      if (st.fade_in > 0) stepo->setProperty("fadeIn", (double)st.fade_in);
      if (st.fade_out > 0) stepo->setProperty("fadeOut", (double)st.fade_out);
      steps.add(juce::var(stepo));
    }
    so->setProperty("steps", steps);
    so->setProperty("seed", (double)s->seed);
    juce::Array<juce::var> program;
    for (int k = 0; k < s->visit_count; ++k) program.add(s->visit_step[k]);
    so->setProperty("program", program);
    so->setProperty("radio", s->radio);
    auto* gateso = new juce::DynamicObject();
    for (const auto& row : s->gates) {
      juce::Array<juce::var> bits;
      for (int i = 0; i < s->numSteps(); ++i) bits.add(s->on(row.mask, i));
      gateso->setProperty(row.uuid, bits);
    }
    so->setProperty("gates", juce::var(gateso));
    // Which step is auditioned, −1 = none.
    so->setProperty("auditionStep", auditionActive() ? audition_step_.load() : -1);
    obj->setProperty("sequence", juce::var(so));
  }
  juce::Array<juce::var> childData;
  for (const auto& child : kids) {
    childData.add(child->getMetadata());
  }
  obj->setProperty("nodes", childData);
  return base;
}

int64_t StackNode::getIntrinsicDuration() const {
  // The composite duration: the LCM of the looping children's (docs/
  // recording.md "Nested Stacks and Composite Duration"); a one-shot
  // adds nothing (AudioNode::period_from_context_).
  const auto& kids = children;  // message thread: ownership vector
  if (kids.empty()) return 0;

  int64_t composite = 0;
  for (const auto& child : kids) {
    if (child->periodFromContext()) continue;
    composite = timing::foldPeriod(composite, child->getIntrinsicDuration());
  }
  return composite;
}

int64_t AudioNode::getEffectivePeriod() const {
  return period_law::ownPeriodOf(*this);
}

StackNode::ScopeFacts StackNode::scopeFacts(
    const ProcessContext& context) const {
  ScopeFacts facts;
  // One read of the sequence; the map is derived over that same read.
  facts.seq = activeSequence();
  facts.map = activeTimeMapOver(facts.seq);
  facts.origin = frameOrigin(context);
  // This stack's OWN period by the period law over the snapshot, judged
  // from the map and song read above: a one-shot's shot, and the source
  // of the cycle its children receive.
  const int64_t seq_len = facts.seq != nullptr ? facts.seq->total : 0;
  const int64_t own = period_law::ownPeriodWith(
      SnapProvider{*context.snap, context.quantum}, context.self, facts.map,
      seq_len);
  facts.fold = timing::stackFold(facts.map, period_from_context_.load(), own,
                                 context.context_cycle);
  facts.child_cycle =
      period_law::scopeCycle(own, facts.map.active() || seq_len > 0,
                             context.quantum, context.context_cycle);
  return facts;
}

int64_t StackNode::getEffectiveQuantum() const {
  // This scope's stored quantum, else the enclosing island's.
  int64_t q = quantum_samples_.load();
  if (q > 0) return q;

  if (auto* p = parent.load()) return p->getEffectiveQuantum();

  return 0;
}

// --- Take lifecycle ---

void StackNode::takeArmed() {
  if (active_takes_.fetch_add(1) == 0) {
    // The cycle a take generation begins against: the HEARD one (what
    // the performer is listening to; windows shorten it).
    const int64_t q = quantum_samples_.load();
    heard_cycle_at_arm_.store(timing::lcm(q, getEffectivePeriod()));
  }
}

void StackNode::addChild(std::unique_ptr<AudioNode> child) {
  child->setParent(this);
  // A live take arriving via a move re-registers with this island
  // (removeChild balanced it out on the way).
  if (child->isArmedOrRecording()) rootNode()->takeArmed();
  // Attaching content writes no island fact: (Q, zero) are established
  // by a commit or an import on the island root only. A DETACHED
  // assembly (a Combine's stack before insertion, a subtree the undo
  // log holds) is its own rootNode(), so an establishment here would
  // stamp a private grid onto a nested stack.
  children.push_back(std::move(child));
}

void StackNode::insertChildAt(std::unique_ptr<AudioNode> child, int index) {
  child->setParent(this);
  if (child->isArmedOrRecording()) rootNode()->takeArmed();
  if (index < 0) index = 0;
  if (index >= (int)children.size()) {
    children.push_back(std::move(child));
  } else {
    children.insert(children.begin() + index, std::move(child));
  }
}

std::vector<std::unique_ptr<AudioNode>> StackNode::clearChildren() {
  std::vector<std::unique_ptr<AudioNode>> removed;
  for (auto& child : children) {
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

int StackNode::ChildView::count() const {
  return snap->entries[(size_t)self].childCount;
}
int StackNode::ChildView::entryAt(int k) const { return snap->childAt(self, k); }
AudioNode* StackNode::ChildView::nodeAt(int k) const {
  return snap->entries[(size_t)snap->childAt(self, k)].node;
}

template <typename Ch, typename Body>
void StackNode::forEachSeamRun(Ch* const* channels, int channel_count,
                               const ProcessContext& context,
                               Body&& body) const {
  const ScopeFacts facts = scopeFacts(context);
  const int block = context.num_samples;
  const int64_t fade = Sequence::fadeSamples(context.sample_rate);
  const bool has_midi =
      context.live_midi != nullptr && !context.live_midi->isEmpty();
  int done = 0;
  do {
    // THE ONE EQUATION (timing::innerAt) from this stack's own origin,
    // read once per run: the same value cuts the run, maps the child
    // clock (childContext) and places the song (the gate lookup).
    const int64_t t = context.master_pos + done;
    const int remaining = block - done;
    int64_t reach = remaining;
    timing::InnerAt at;
    if (facts.fold.folds()) {
      at = timing::innerAt(t, facts.origin, facts.fold.eff, facts.fold.fold);
      reach = std::min<int64_t>(reach, at.run);
    } else {
      at.inner = t - facts.origin;  // transparent: the clock passes through
    }
    if (facts.seq != nullptr) {
      // Envelope corners at the song position the fold lands on (S9: a
      // map selects song positions), per gate row plus the all-on mask
      // every row-less child inherits: each run then has constant-slope
      // gates and a single visit.
      const int64_t srel = facts.seq->fold(at.inner);
      reach = std::min<int64_t>(reach,
                                facts.seq->cornerDistance(srel, fade, ~0ull));
      for (const auto& row : facts.seq->gates) {
        reach = std::min<int64_t>(
            reach, facts.seq->cornerDistance(srel, fade, row.mask));
      }
    }
    const int run =
        remaining <= 0 ? remaining
                       : (int)std::clamp<int64_t>(reach, 1, remaining);
    if (done == 0 && run >= block) {
      body(channels, channel_count, context, facts, at);  // unsplit
      return;
    }
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
    const bool last = done + run >= block;
    ProcessContext sub = context;
    sub.master_pos = t;
    sub.island_pos = context.island_pos + done;
    sub.input_clock = context.input_clock + done;
    sub.num_samples = run;
    // The gate line: this run's stretch of the parent's (g0, g1). The
    // block's own endpoints pass through exactly.
    const float gate_span = context.gate_g1 - context.gate_g0;
    if (done > 0) {
      sub.gate_g0 =
          context.gate_g0 + gate_span * ((float)done / (float)block);
    }
    if (!last) {
      sub.gate_g1 =
          context.gate_g0 + gate_span * ((float)(done + run) / (float)block);
    }
    // The live MIDI: the events that fall in this run, re-based to its
    // first sample. The first run also takes anything stamped before
    // the block and the last anything stamped past it, so every event
    // is delivered exactly once.
    if (has_midi) {
      midi_slice_.clear();
      for (const auto event : *context.live_midi) {
        const int offset = event.samplePosition;
        if (offset >= done + run && !last) break;  // sorted by position
        if (offset < done && done > 0) continue;
        midi_slice_.addEvent(event.data, event.numBytes, offset - done);
      }
      sub.live_midi = &midi_slice_;
    }
    body(run_channels, run_channel_count, sub, facts, at);
    done += run;
  } while (done < block);
}

ProcessContext StackNode::childContext(const ProcessContext& context,
                                       const ScopeFacts& facts,
                                       const timing::InnerAt& at) const {
  ProcessContext child_context = context;
  const timing::TimeMap& map = facts.map;
  const int64_t O = facts.origin;

  // Children hear O + inner(t): the render equation (timing::innerAt)
  // from this stack's origin, under the fold timing::stackFold chose. A
  // windowed group of mics recorded as one take therefore renders
  // exactly as each mic windowed alone (the content-frame law).
  child_context.master_pos = O + at.inner;
  // A one-shot's rest: the children still render, so their racks, live
  // input and gates run on and tails ring (AudioNode::gateEndpoints),
  // but every leaf's content is silence. Content a context above has
  // already silenced keeps that context's reason
  // (ProcessContext::resting).
  if (at.rest && !child_context.content_silent) {
    child_context.content_silent = true;
    child_context.resting = true;
  }
  if (map.active()) {
    const int64_t a0 = map.mapOffset(0);
    // The map facts through-map arm math runs against
    // (ProcessContext::map).
    child_context.map = map;
    child_context.map_origin = O;
    child_context.map_heard_top = O + a0;
    // The child frame's cycle top: where the map lands at heard phase 0.
    child_context.frame_top = O + a0;
  }

  child_context.context_cycle = facts.child_cycle;

  // CUE STEPS (S11, S20–S22; sequencer.md §3, §13). A cued visit
  // re-bases the subtree's received frame to the visit top: children
  // hear O + (songRel − visitStart), layered UNDER any authored or
  // audition map (S9: the map selects SONG positions; the cue maps
  // song positions to CONTENT positions). The child frame's cycle top
  // is this stack's origin again, so a nested song-stack restarts from
  // its own top on every entrance. forEachSeamRun cuts at visit bounds,
  // so the visit is constant here; the gate lookup is unaffected
  // (renderChildren reads the song position from `at`).
  if (const Sequence* seq = facts.seq; seq != nullptr && seq->any_cue) {
    const int64_t srel = seq->fold(at.inner);
    // By VISIT (§14): a step the program revisits re-bases on every
    // entrance.
    const int k = seq->visitAt(srel);
    if (seq->cueOfVisit(k)) {
      const int64_t step_len = seq->visitLen(k);
      child_context.master_pos = O + (srel - seq->bounds[k]);
      child_context.frame_top = O;
      // Record INTO a cued step (S21): through-map arm math places the
      // take at context.map's inner positions, so the audition map is
      // composed with the cue and the take lands where cue playback
      // reads it, [0, stepLen). Only the audition aimed at THIS step
      // composes; an authored multi-step window over cued steps is
      // refused at arm.
      if (auditionStep() == seq->visit_step[k] && child_context.map.active() &&
          step_len > 0) {
        child_context.map = timing::TimeMap::single(0, step_len);
      }
    }
  }
  return child_context;
}

void StackNode::control(const float* const* input_channels,
                        int num_input_channels, const ProcessContext& context) {
  jassert(context.snap != nullptr && context.island != nullptr);
  adoptOriginGate(context);
  forEachSeamRun(input_channels, num_input_channels, context,
                 [this](const float* const* ins, int input_count,
                        const ProcessContext& sub, const ScopeFacts& facts,
                        const timing::InnerAt& at) {
                   controlChildren(ins, input_count, sub, facts, at);
                 });
}

void StackNode::controlChildren(const float* const* input_channels,
                                int num_input_channels,
                                const ProcessContext& context,
                                const ScopeFacts& facts,
                                const timing::InnerAt& at) {
  ProcessContext child_context = childContext(context, facts, at);
  const ChildView kids = childView(context);
  const int child_count = kids.count();

  for (int k = 0; k < child_count; ++k) {
    child_context.self = kids.entryAt(k);
    kids.nodeAt(k)->control(input_channels, num_input_channels, child_context);
  }
}

void StackNode::render(float* const* output_channels, int num_output_channels,
                       const ProcessContext& context) const {
  jassert(context.snap != nullptr && context.island != nullptr);
  forEachSeamRun(output_channels, num_output_channels, context,
                 [this](float* const* outs, int output_count,
                        const ProcessContext& sub, const ScopeFacts& facts,
                        const timing::InnerAt& at) {
                   renderChildren(outs, output_count, sub, facts, at);
                 });
}

void StackNode::renderChildren(float* const* output_channels,
                               int num_output_channels,
                               const ProcessContext& context,
                               const ScopeFacts& facts,
                               const timing::InnerAt& at) const {
  // Guard for atypical block sizes/channel counts. At normal sizes the
  // buffer was preallocated in the constructor and this never triggers.
  if (mix_buffer.getNumSamples() < context.num_samples ||
      mix_buffer.getNumChannels() < num_output_channels) {
    mix_buffer.setSize(num_output_channels, context.num_samples,
                       /*keepExistingContent=*/false, /*clearExtraSpace=*/true,
                       /*avoidReallocating=*/true);
  }

  ProcessContext child_context = childContext(context, facts, at);

  // The window phase fraction for the UI (AudioNode::playhead_pos).
  {
    const int64_t p = facts.map.period();
    const bool sounding = facts.map.active() && p > 0 && !at.rest;
    playhead_pos.store(sounding ? (double)at.h / (double)p : 0.0);
  }

  const ChildView kids = childView(context);
  const int child_count = kids.count();

  // With the rack live, the gate below unity or the output stage off
  // unity, the children sum into the accumulator first, so the gate
  // (AudioNode::gateEndpoints, on the dry sum), the rack and the
  // output-stage gains act on the GROUP's signal. The accumulator is
  // stereo: children may render panned or stereo signals, and folding
  // channel 0 alone would collapse their image. The children render
  // whatever the gate says.
  const float group_pan = pan.load();
  const bool muted = is_muted.load();
  float gate_g0 = 1.0f, gate_g1 = 1.0f;
  gateEndpoints(context, !muted, gate_g0, gate_g1);
  const bool gate_unity = gate_g0 >= 1.0f && gate_g1 >= 1.0f;
  const float group_gain = gain.load();
  const bool use_fx = fxIsLive();
  const bool use_accum =
      use_fx || !gate_unity || group_pan != 0.0f || group_gain != 1.0f;
  const int accum_ch = std::min(2, std::max(1, num_output_channels));
  if (use_accum) {
    if (fx_accum_.getNumSamples() < context.num_samples ||
        fx_accum_.getNumChannels() < accum_ch) {
      fx_accum_.setSize(accum_ch, context.num_samples,
                        /*keepExistingContent=*/false,
                        /*clearExtraSpace=*/true, /*avoidReallocating=*/true);
    }
    // Only this run's samples: the buffers are preallocated far past a
    // run, and nothing beyond num_samples is read.
    fx_accum_.clear(0, context.num_samples);
  }

  // THE SEQUENCE GATES (sequencer.md §1): per child, the dry-gain
  // endpoints for this run — exact, because forEachSeamRun cut the
  // block at envelope corners. The lookup runs at the SONG position
  // (`at.inner`, what the splitter cut with), not at
  // child_context.master_pos: a cue re-base moves the child clock to
  // the song top, but a child gated off in a cued step is off in THAT
  // step, not in step 0.
  const Sequence* seq = facts.seq;
  const int64_t gate_fade = Sequence::fadeSamples(context.sample_rate);
  const int64_t seq_rel0 = seq != nullptr ? seq->fold(at.inner) : 0;

  for (int k = 0; k < child_count; ++k) {
    const AudioNode* child = kids.nodeAt(k);
    mix_buffer.clear(0, context.num_samples);

    if (seq != nullptr) {
      const uint64_t m = seq->maskFor(child->getUuid());
      child_context.gate_g0 = seq->gainAt(m, seq_rel0, gate_fade);
      child_context.gate_g1 =
          seq->gainAt(m, seq_rel0 + context.num_samples, gate_fade);
    } else {
      child_context.gate_g0 = 1.0f;
      child_context.gate_g1 = 1.0f;
    }

    child_context.self = kids.entryAt(k);
    child->render(mix_buffer.getArrayOfWritePointers(), num_output_channels,
                  child_context);

    if (use_accum) {
      for (int ch = 0; ch < accum_ch; ++ch) {
        fx_accum_.addFrom(ch, 0, mix_buffer.getReadPointer(ch),
                          context.num_samples);
      }
      continue;
    }

    for (int ch = 0; ch < num_output_channels; ++ch) {
      if (output_channels[ch] != nullptr && ch < mix_buffer.getNumChannels()) {
        juce::FloatVectorOperations::add(output_channels[ch],
                                         mix_buffer.getReadPointer(ch),
                                         context.num_samples);
      }
    }
  }

  if (use_accum) {
    if (!gate_unity) {
      for (int ch = 0; ch < accum_ch; ++ch) {
        fx_accum_.applyGainRamp(ch, 0, context.num_samples, gate_g0, gate_g1);
      }
    }
    if (use_fx) {
      // An armed group's chain takes the run's live MIDI (liveMidiFor).
      if (accum_ch >= 2) {
        fxProcess(fx_accum_.getWritePointer(0), fx_accum_.getWritePointer(1),
                  context.num_samples, /*stereo_in=*/true,
                  liveMidiFor(context));
      } else {
        // Mono device: no right buffer — a promoting chain folds back
        // to mono internally (FxChain::run).
        fxProcess(fx_accum_.getWritePointer(0), nullptr, context.num_samples,
                  /*stereo_in=*/false, liveMidiFor(context));
      }
    }
    // The accumulator is a stereo pair on a stereo device, else mono.
    sumOutputStage(output_channels, num_output_channels,
                   fx_accum_.getReadPointer(0),
                   accum_ch >= 2 ? fx_accum_.getReadPointer(1) : nullptr,
                   context.num_samples, group_pan, group_gain);
  }
}

AudioNode* StackNode::findByUuid(const juce::String& uuid) {
  if (getUuid() == uuid) return this;

  for (const auto& child : children) {
    if (auto* found = child->findByUuid(uuid)) return found;
  }

  return nullptr;
}

bool StackNode::isArmedOrRecording() const {
  const auto& kids = children;  // message thread: ownership vector
  for (const auto& child : kids) {
    if (child->isArmedOrRecording()) return true;
  }
  return false;
}

}  // namespace celestrian
