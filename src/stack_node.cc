// StackNode — the container: sums its children through the group fx
// rack, and when it is the session root owns the island facts. This
// file owns
//   - child ownership edits (add / insert / remove / clear; message
//     thread only — the audio thread reads the graph snapshot);
//   - childContext(): the per-scope re-scoping of ProcessContext
//     (window-mapped clock, context loop/cycle, active map, gate);
//   - control() / render(): recursion over the snapshot with map-seam
//     block splitting, the summing scratch buffer, the sequencer gate
//     and the group output stage;
//   - the seqlock'd island triple (Q, zero, generation) and the take
//     lifecycle events (takeArmed / takeCommitted — no fact moves at
//     commit, docs/frame.md);
//   - period / duration / metadata / waveform readouts.

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
  fx_accum_.setSize(kMaxExpectedChannels, kMaxExpectedBlockSize);
}

StackNode::~StackNode() {
  // Same lifetime argument as chain_ (AudioNode's dtor):
  // nodes only die via the reclaimer's grace, so no in-flight audio can
  // still be reading the sequence here.
  delete sequence_.load();
}

// The audio thread traverses the WHOLE-GRAPH snapshot published by the
// engine (graph_snapshot.h); node lifetime on structural edits is owned
// by the edit log / the engine's reclaimer.

juce::var StackNode::getMetadata() const {
  const auto& kids = children;  // message thread: ownership vector
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
  obj->setProperty("childCount", (int)kids.size());
  // Loop window state (loopBypassed/windowActive) publishes from the
  // AudioNode base — fractal with clips (I5). The stack's `playhead`
  // field carries the window phase fraction while the window is active.
  // Island state, for diagnosability: `origin` on clips is ABSOLUTE;
  // the view-frame anchor is (origin − zero) mod duration, so without
  // the zero a dump's "origin = 3Q" reads wrong for a clip recorded at
  // the cycle top.
  obj->setProperty("quantum", (double)quantum_samples_.load());
  obj->setProperty("zero", (double)zero_samples_.load());
  // Under a step audition the DERIVED window is the one the UI must
  // draw (brackets, cursor honesty, frame): publish it over the base
  // fields. The authored window survives untouched in the atomics and
  // returns to the metadata the moment the audition ends (I9).
  if (const timing::TimeMap a = auditionMap(); a.active()) {
    obj->setProperty("loopStart", (double)a.segs[0].start);
    obj->setProperty("loopEnd", (double)a.segs[0].end);
    obj->setProperty("loopBypassed", false);
    obj->setProperty("windowActive", true);
    obj->removeProperty("segments");
    // A stack keeps no top (Phase 2): its `loopTop` is the region
    // start of the window it publishes — the derived one here.
    obj->setProperty("loopTop", (double)a.segs[0].start);
  }
  // S16 (§11.8): the authored window's domain, and whether it is
  // suspended right now (sequence-domain, sequence off) — the UI draws
  // suspended brackets dimmed with a chip saying why.
  obj->setProperty("windowDomain",
                   windowDomain() == WindowDomain::Sequence ? "sequence"
                                                             : "intrinsic");
  obj->setProperty("windowSuspended", windowSuspended());
  // The sequence (docs/sequencer.md), published RAW like segments —
  // bypassed geometry survives in the UI (I9; the VM derives active).
  // Steps in samples like every metadata length; gates as uuid → one
  // 0/1 per step (UI-friendly; absent uuid = inherit ON). The
  // successor graph rides each step (`next`, absent = the loop
  // successor); the seed, the derived PROGRAM (step index per visit)
  // and the radio flag publish beside them (sequencer.md §14) — the
  // UI lays its timeline out over the program.
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
    // The step audition (§11.2): which step is looping, −1 = none. The
    // derived window itself publishes through the base fields
    // (windowActive/loopStart/loopEnd) like any map.
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
  // Composite duration = LCM of children (docs/recording.md "Nested
  // Stacks and Composite Duration"). Not a quantum: Q is stored island
  // state, never derived from child durations.
  const auto& kids = children;  // message thread: ownership vector
  if (kids.empty()) return 0;

  int64_t composite = 0;
  for (const auto& child : kids) {
    // One-shots excluded (Q5): period := context cycle — they adopt the
    // scope's cycle, never extend it (snapshot twin agrees).
    if (child->periodFromContext()) continue;
    composite = timing::foldPeriod(composite, child->getIntrinsicDuration());
  }
  return composite;
}

int64_t AudioNode::getEffectivePeriod() const {
  return period_law::ownPeriodOf(*this);
}

bool StackNode::oneShotFacts(const ProcessContext& context,
                             const timing::TimeMap& own_map, int64_t& shot,
                             int64_t& cycle) const {
  if (!period_from_context_.load()) return false;
  // THE SHOT is this stack's OWN period (period_law.h: map ▸ sequence
  // ▸ composite) — a one-shot group with a song fires its whole song
  // (D2-5 ruling (a)); `own_map` is that law's first rung, passed in
  // because the callers already hold it.
  shot = own_map.active()
             ? own_map.period()
             : snapEffectivePeriod(*context.snap, context.self, context.quantum);
  cycle = context.context_cycle;
  return shot > 0 && cycle > shot;
}

bool StackNode::inRest(const ProcessContext& context) const {
  const timing::TimeMap own_map = activeTimeMap();
  int64_t shot = 0, cycle = 0;
  if (!oneShotFacts(context, own_map, shot, cycle)) return false;
  const timing::TimeMap eff =
      own_map.active() ? own_map : timing::TimeMap::single(0, shot);
  return timing::innerAt(context.master_pos, frameOrigin(context), eff, cycle)
      .rest;
}

int64_t StackNode::getEffectiveQuantum() const {
  // Stored island quantum — never derived from child durations, so it
  // cannot retroactively change when a shorter clip commits (the
  // "vibrating waveform" bug class) and it survives its creator.
  int64_t q = quantum_samples_.load();
  if (q > 0) return q;

  if (auto* p = parent.load()) return p->getEffectiveQuantum();

  return 0;
}

// --- Take lifecycle (commit as an EVENT — unification_audit.md §1.5) ---

void StackNode::takeArmed() {
  if (active_takes_.fetch_add(1) == 0) {
    // Snapshot the cycles the take begins against: the INTRINSIC
    // committed cycle (growth baseline for the commit re-base; windows
    // must not leak into zero permanence) and the HEARD cycle (E-C —
    // what the performer is actually listening to; windows shorten it).
    const int64_t q = quantum_samples_.load();
    lcm_before_take_.store(timing::lcm(q, getIntrinsicDuration()));
    heard_cycle_at_arm_.store(timing::lcm(q, getEffectivePeriod()));
  }
}

void StackNode::takeCommitted(int64_t origin, int64_t intrinsic_after) {
  // A commit moves no island fact: the island's zero is the first
  // take's origin and stays there (docs/frame.md — where a new take
  // sits on screen is seated by the view from the lanes, which puts it
  // in the cycle it started in without anything here moving). The
  // audio thread's only island write is the first establishment.
  (void)origin;
  (void)intrinsic_after;
  active_takes_.fetch_sub(1);
}

void StackNode::addChild(std::unique_ptr<AudioNode> child) {
  child->setParent(this);
  // A live take arriving via a move re-registers with this island
  // (removeChild balanced it out on the way).
  if (child->isArmedOrRecording()) rootNode()->takeArmed();
  // Attaching content never writes island facts (audit D14-1): (Q,
  // zero) are established by a commit or an import on the island
  // root, and by nothing else. A DETACHED assembly (Combine builds its
  // stack before inserting it; a subtree held by the undo log) is its
  // own rootNode(), so an establishment here would stamp a private
  // grid onto a nested stack.
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
  // DETACH ONLY: the caller (the engine) owns retirement — the audio
  // thread may still traverse these nodes through the outgoing graph
  // snapshot for ≤2 callbacks after the next publish.
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

ProcessContext StackNode::childContext(const ProcessContext& context) const {
  // === THE TIME-MAP (time_maps.md §2, reified) ===
  // The map applies iff it is ACTIVE (valid + not bypassed) —
  // independent of expansion (I6b: collapse is purely visual). Phase is
  // a pure function of the received clock:
  // walk_segments((t − frame_top) mod period).
  // No private counter, no reset-on-collapse, fully deterministic.
  // Shared by BOTH §2.3 phases so control decisions and rendering see
  // the SAME mapped child clock.
  ProcessContext child_context = context;

  const timing::TimeMap map = activeTimeMap();
  // THE ANCHOR (Q18, composition.md §2): this stack's own origin once
  // anchored, else the received cycle top (the empty case).
  const int64_t O = frameOrigin(context);
  int64_t shot = 0, cycle = 0;
  const bool one_shot = oneShotFacts(context, map, shot, cycle);
  if (map.active() || one_shot) {
    // THE ONE EQUATION (timing::innerAt), stack form: children hear
    // t_child = O + inner(t) — the clip law (clip_node.cc render) with
    // the stack's origin in place of the clip's. A looping stack folds
    // on its map period; a ONE-SHOT stack folds on the CONTEXT CYCLE
    // (Q5) so every firing hands its members the same clock from O —
    // folding on the map period (or not at all) phase-shifts a shot
    // that does not divide the cycle on every firing after the first
    // (G-2b). Window content sounds at its own performed moment; a
    // windowed group of mics recorded as one take renders identically
    // to each mic windowed alone (the content-frame law, by
    // construction). A plain looping stack with no map is transparent:
    // the clock passes through and each child folds on its own.
    const timing::TimeMap eff =
        map.active() ? map : timing::TimeMap::single(0, shot);
    const timing::InnerAt at = timing::innerAt(
        context.master_pos, O, eff, one_shot ? cycle : eff.period());
    child_context.master_pos = O + at.inner;
  }
  if (map.active()) {
    const int64_t a0 = map.mapOffset(0);
    // Time-map facts for the subtree (phase 2): the map, its origin, and
    // the heard grid anchor (O + a0 — pass tops occur at island times ≡
    // it mod the period) that through-map arm math runs against.
    child_context.map = map;
    child_context.map_origin = O;
    child_context.map_heard_top = O + a0;
    ++child_context.map_count;
    // The child frame's cycle top is where the map lands at heard phase
    // 0 (the first segment's start).
    child_context.frame_top = O + a0;
  }

  // === THE CONTEXT CYCLE (the one scope cycle: the Q5 one-shot period
  // and the arm grid) ===
  // This stack's OWN period by THE PERIOD LAW (period_law.h over the
  // snapshot): its map's period when mapped (children listen to one map
  // pass); its song under an active sequence (a one-shot child fires
  // once per pass of the whole sequence, takes recorded over it hear
  // the song as their frame — docs/sequencer.md §4); else the LCM of
  // its LOOPING children's contributions — one-shots are excluded from
  // the fold (they adopt this very value; including them would be
  // circular) — seeded with Q; a child that DRIFTS against the island Q
  // is excluded the same way (Q22: it never extends a cycle). A scope
  // with no looping content falls back to the RECEIVED context cycle so
  // a one-shot inside an all-one-shot group still sounds once per the
  // enclosing cycle.
  {
    const int64_t own =
        snapEffectivePeriod(*context.snap, context.self, context.quantum);
    if (map.active() || activeSequence() != nullptr) {
      child_context.context_cycle = own;
    } else if (own > 0) {
      child_context.context_cycle =
          context.quantum > 0 ? timing::lcm(context.quantum, own) : own;
    } else {
      child_context.context_cycle = context.context_cycle;
    }
  }

  // === CUE STEPS (docs/sequencer.md §3 — the Q6 serial primitive;
  // S11, S20–S22) ===
  // A CUED step re-bases the subtree's received frame to the step top:
  // children hear t' = zero + (songRel - stepStart) — a derived
  // per-step time-map layered UNDER any authored/audition map (the S9
  // composition law: the map selects SONG positions; the cue maps song
  // positions to CONTENT positions). forEachSeamRun cuts blocks at
  // step bounds (they are envelope corners), so the step is constant
  // within any one call here. The child frame's cycle top is the
  // RECEIVED zero again — the re-based content IS the song-top span,
  // so a nested song-stack restarts from its own top on every
  // entrance. Gate lookup is NOT affected: renderChildren derives the
  // song position independently of this re-base (gates live on the
  // song timeline).
  if (const Sequence* seq = activeSequence();
      seq != nullptr && seq->any_cue && seq->total > 0) {
    // The song position is inner(t) measured from this stack's frame
    // (Q18: its origin, not the received zero).
    const int64_t srel = seq->fold(child_context.master_pos - O);
    // The PROGRAM is the timeline (§14): the lookup is by VISIT, so a
    // step the program revisits re-bases on every entrance.
    const int k = seq->visitAt(srel);
    if (seq->cueOfVisit(k)) {
      const int64_t step_len = seq->visitLen(k);
      child_context.master_pos = O + (srel - seq->bounds[k]);
      child_context.frame_top = O;
      // Mode-2 record INTO a cued step (S21): the through-map arm math
      // places the take at context.map's inner positions — compose the
      // audition map with the cue so the take lands where cue playback
      // will read it (the song top, [0, stepLen)). Only the audition
      // aimed at THIS step composes; an authored multi-step window
      // over cued steps is refused at arm (audio_engine).
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
  // Block-top origin adoption (Q18): a stack renders with a gated
  // origin exactly like a clip — see AudioNode::adoptOriginGate.
  adoptOriginGate(context);
  forEachSeamRun(input_channels, num_input_channels, context,
                 [this](const float* const* ins, int input_count,
                        const ProcessContext& sub) {
                   controlChildren(ins, input_count, sub);
                 });
}

void StackNode::controlChildren(const float* const* input_channels,
                                int num_input_channels,
                                const ProcessContext& context) {
  ProcessContext child_context = childContext(context);

  // Children come from the WHOLE-GRAPH snapshot (one engine-side load
  // per callback) — see ChildView.
  const ChildView kids = childView(context);
  const int child_count = kids.count();

  // The arm grid a child take wraps against is the scope's CONTEXT
  // CYCLE (childContext — the one scope cycle, composition.md §3): the
  // map pass under a map, the song under a sequence, else the fold of
  // the looping siblings. No second "context loop" walk.

  for (int k = 0; k < child_count; ++k) {
    child_context.self = kids.entryAt(k);
    kids.nodeAt(k)->control(input_channels, num_input_channels, child_context);
  }
}

void StackNode::render(float* const* output_channels, int num_output_channels,
                       const ProcessContext& context) const {
  jassert(context.snap != nullptr && context.island != nullptr);
  // Render twin of control's seam split: both phases must see the SAME
  // mapped child clock, run for run (the shared driver guarantees it).
  forEachSeamRun(
      output_channels, num_output_channels, context,
      [this](float* const* outs, int output_count, const ProcessContext& sub) {
        renderChildren(outs, output_count, sub);
      });
}

void StackNode::renderChildren(float* const* output_channels,
                               int num_output_channels,
                               const ProcessContext& context) const {
  // Guard for atypical block sizes/channel counts. At normal sizes the
  // buffer was preallocated in the constructor and this never triggers.
  if (mix_buffer.getNumSamples() < context.num_samples ||
      mix_buffer.getNumChannels() < num_output_channels) {
    mix_buffer.setSize(num_output_channels, context.num_samples,
                       /*keepExistingContent=*/false, /*clearExtraSpace=*/true,
                       /*avoidReallocating=*/true);
  }

  ProcessContext child_context = childContext(context);

  // Window-phase telemetry for the UI (render output, not state —
  // playhead_pos is the sanctioned mutable). Heard phase comes from the
  // RECEIVED clock (the child-frame difference only equals it in the
  // single-segment case; under a multi-segment override it doesn't).
  {
    const timing::TimeMap map = activeTimeMap();
    const int64_t p = map.period();
    if (map.active() && p > 0) {
      // Heard phase from this stack's own anchor (Q18) — the one
      // equation's h over the map period.
      const int64_t h =
          timing::innerAt(context.master_pos, frameOrigin(context), map, p).h;
      playhead_pos.store((double)h / (double)p);
    } else {
      playhead_pos.store(0.0);
    }
  }
  // ONE-SHOT REST (Q18): in the rest region the group's children are
  // not rendered — the sum is silence, the gate and rack still run so
  // tails ring — exactly a one-shot clip's rest (clip_node.cc render).
  const bool rest = inRest(context);

  const ChildView kids = childView(context);
  const int child_count = kids.count();

  // With the effect rack ON — or the group's OUTPUT STAGE not at unity
  // (panned, fader below 1) — or its GATE below unity — children sum
  // into the fx accumulator first: the rack shapes the GROUP's summed
  // signal (a stack reverb wets the whole kit), and the output-stage
  // gains scale the group as one. The accumulator is STEREO: children
  // may render panned/stereo signals, so folding channel 0 alone would
  // collapse their image.
  //
  // MUTE = THE PRE-FX GATE (S7 smoothness law, docs/sequencer.md §9):
  // the group's mute and any parent-sequence gate (context.gate_*)
  // resolve to one ramped dry gain applied to the children's SUM before
  // the rack, so edges fade (~10 ms, no pops) and the rack keeps
  // running — echo and reverb tails RING OUT through a closed gate.
  // Children still render (their own tails and playhead telemetry keep
  // flowing).
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
    fx_accum_.clear();
  }

  // THE SEQUENCE GATES (docs/sequencer.md §1): per child, the dry-gain
  // envelope endpoints for this block — exact, because forEachSeamRun
  // split the block at envelope corners. The sequence phase is the
  // CHILD clock relative to this stack's received frame top (the S9
  // composition law: a map on this node selects song positions, and
  // the step lookup happens there).
  const Sequence* seq = activeSequence();
  const int64_t gate_fade = Sequence::fadeSamples(context.sample_rate);
  // The step lookup runs in SONG positions — derived from the received
  // clock through the own map alone, NOT from child_context.master_pos:
  // the cue re-base (childContext) moves the CHILD clock to the song
  // top, but the gate schedule stays on the song timeline (a child
  // gated off in a cued step is off in THAT step, not in step 0).
  int64_t seq_rel0 = 0;
  if (seq != nullptr) {
    // inner(t) from this stack's own anchor (Q18) — the same fold
    // childContext's cue lookup uses.
    seq_rel0 = seq->fold(innerOf(context, activeTimeMap()));
  }

  for (int k = 0; k < child_count; ++k) {
    const AudioNode* child = kids.nodeAt(k);
    // Clear mix buffer for this specific child
    mix_buffer.clear();

    if (seq != nullptr) {
      const uint64_t m = seq->maskFor(child->getUuid());
      child_context.gate_g0 = seq->gainAt(m, seq_rel0, gate_fade);
      child_context.gate_g1 =
          seq->gainAt(m, seq_rel0 + context.num_samples, gate_fade);
    } else {
      child_context.gate_g0 = 1.0f;
      child_context.gate_g1 = 1.0f;
    }

    // Child renders into our mix_buffer (not in a one-shot rest region:
    // the cleared buffer IS the silence).
    child_context.self = kids.entryAt(k);
    if (!rest) {
      child->render(mix_buffer.getArrayOfWritePointers(),
                    num_output_channels, child_context);
    }

    if (use_accum) {
      for (int ch = 0; ch < accum_ch; ++ch) {
        fx_accum_.addFrom(ch, 0, mix_buffer.getReadPointer(ch),
                          context.num_samples);
      }
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

  if (use_accum) {
    // THE GATE (pre-rack): the group's mute ramp × any parent-sequence
    // envelope, applied to the summed dry signal — the rack below then
    // rings the tail out naturally.
    if (!gate_unity) {
      for (int ch = 0; ch < accum_ch; ++ch) {
        fx_accum_.applyGainRamp(ch, 0, context.num_samples, gate_g0, gate_g1);
      }
    }
    if (use_fx) {
      // Armed groups hand the block's live MIDI to their chain (phase
      // 4): the stack's fx pass runs every block over the summed group
      // (silence included), so a group instrument speaks with no extra
      // machinery.
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
    // The group's output stage: gain·pan (balance law). Mute is the
    // PRE-FX gate above (S7) — the fader here is always `gain`, so a
    // muted group's rack tail still reaches the parent while it rings
    // out. Channel 0 is L, channel 1 is R; any channels past the stereo
    // pair get the fader-scaled unpanned channel-0 signal (duplicate
    // mono).
    float gl = 1.0f, gr = 1.0f, fader = 1.0f;
    outputStageGains(group_pan, group_gain, gl, gr, fader);
    for (int ch = 0; ch < num_output_channels; ++ch) {
      if (output_channels[ch] == nullptr) continue;
      const int src = std::min(ch, accum_ch - 1);
      const float g =
          num_output_channels >= 2 && ch < 2 ? (ch == 0 ? gl : gr) : fader;
      if (g <= 0.0f) continue;
      if (g == 1.0f) {
        juce::FloatVectorOperations::add(output_channels[ch],
                                         fx_accum_.getReadPointer(src),
                                         context.num_samples);
      } else {
        juce::FloatVectorOperations::addWithMultiply(
            output_channels[ch], fx_accum_.getReadPointer(src), g,
            context.num_samples);
      }
    }
  }
}
juce::var StackNode::getWaveform(int num_peaks) const {
  const auto& kids = children;  // message thread: ownership vector

  if (kids.empty()) return juce::Array<juce::var>();

  // If we only have one child, return its waveform directly to save compute
  if (kids.size() == 1) return kids[0]->getWaveform(num_peaks);

  // Aggregate: the per-bin average of the children's peak arrays — a
  // display approximation, not a mixdown (gain, pan and fx are not
  // applied).
  juce::Array<juce::var> aggregatePeaks;
  for (int i = 0; i < num_peaks; ++i) aggregatePeaks.add(0.0f);

  for (const auto& child : kids) {
    juce::var childWaveform = child->getWaveform(num_peaks);
    if (childWaveform.isArray()) {
      auto* childArr = childWaveform.getArray();
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

AudioNode* StackNode::findByUuid(const juce::String& uuid) {
  if (getUuid() == uuid) return this;

  // Virtual recursion (findByUuid) — no per-child dynamic_cast.
  for (const auto& child : children) {
    if (auto* found = child->findByUuid(uuid)) return found;
  }

  return nullptr;
}

bool StackNode::isArmedOrRecording() const {
  // Virtual dispatch, no per-child dynamic_cast: clips answer from their
  // recording state machine, nested stacks recurse via their own
  // isArmedOrRecording override.
  const auto& kids = children;  // message thread: ownership vector
  for (const auto& child : kids) {
    if (child->isArmedOrRecording()) return true;
  }
  return false;
}

}  // namespace celestrian
