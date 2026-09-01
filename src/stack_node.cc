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
  // Same lifetime argument as map_override_/chain_ (AudioNode's dtor):
  // nodes only die via the reclaimer's grace, so no in-flight audio can
  // still be reading the sequence here.
  delete sequence_.load();
}

// (The per-stack snapshot machinery — render_children_ +
// republishChildren + the reclaimer plumbed through every stack — is
// gone: the audio thread traverses the WHOLE-GRAPH snapshot published
// by the engine (graph_snapshot.h, Tier 3 Step 3). Node lifetime on
// structural edits is owned by the edit log / the engine's reclaimer.)

juce::var StackNode::getMetadata() const {
  const auto& kids = children;  // message thread: ownership vector
  auto base = AudioNode::getMetadata();
  auto* obj = base.getDynamicObject();
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
  // 0/1 per step (UI-friendly; absent uuid = inherit ON).
  if (const Sequence* s = sequence_.load()) {
    auto* so = new juce::DynamicObject();
    so->setProperty("bypassed", (bool)sequence_bypassed_.load());
    juce::Array<juce::var> steps;
    for (const auto& st : s->steps) {
      auto* stepo = new juce::DynamicObject();
      stepo->setProperty("name", st.name);
      stepo->setProperty("len", (double)st.len);
      stepo->setProperty("cue", st.cue);
      steps.add(juce::var(stepo));
    }
    so->setProperty("steps", steps);
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
  // Stacks and Composite Duration"). Previously this returned the MIN
  // child duration, which doubled as a derived quantum — both wrong;
  // the quantum is now stored island state (P0-3).
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

int64_t StackNode::getEffectivePeriod() const {
  // E-C: an active map on this stack IS the period (base class).
  if (const timing::TimeMap map = activeTimeMap(); map.active()) {
    return map.period();
  }
  // THE PERIOD LAW (docs/sequencer.md §2): an active sequence sets the
  // stack's effective period to the sequence length — the song is what
  // the stack IS from outside (steps concatenate; they never LCM).
  // Composition order per the S9 law: a map on this same node selects
  // spans OF the sequence timeline, which is why it won above.
  if (const int64_t seq_len = activeSequenceLen(); seq_len > 0) {
    return seq_len;
  }
  // Otherwise LCM of children's EFFECTIVE periods — windowed children
  // contribute their window length, so nested windows shorten the
  // audible cycle. Same shape as getIntrinsicDuration, one recursion
  // deeper in honesty.
  const auto& kids = children;  // message thread: ownership vector
  if (kids.empty()) return 0;

  int64_t composite = 0;
  for (const auto& child : kids) {
    if (child->periodFromContext()) continue;  // Q5: one-shots excluded
    composite = timing::foldPeriod(composite, child->getEffectivePeriod());
  }
  return composite;
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

void StackNode::maybeEstablishQuantumFrom(const AudioNode& child) {
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
  // Re-base FIRST, decrement LAST (audit 2026-08-31 E5): active_takes_
  // is the message thread's "island settled" signal (hasActiveTake);
  // decrementing before the epoch store opened a window where an edit
  // observed a settled island whose epoch re-base had not landed yet.
  rebaseEpochOnGrowth(origin, intrinsic_after);
  active_takes_.fetch_sub(1);
}

void StackNode::rebaseEpochOnGrowth(int64_t origin, int64_t intrinsic_after) {
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
  int64_t before = lcm_before_take_.load();
  if (before <= 0) return;  // first take: epoch was established at arm

  // Passed in (snapshot space) — this event fires on the AUDIO thread,
  // and the stack's own traversal is message-thread-only (Step 3).
  int64_t after = timing::lcm(quantum_samples_.load(), intrinsic_after);
  // THE SONG RIDES THE EPOCH (docs/sequencer.md §11, found building
  // step 2): an active sequence's steps are positioned from the cycle
  // epoch, so a whole-old-cycle re-base that is NOT a whole number of
  // songs would shift every section (a 4Q part recorded into an 8Q
  // song re-based the epoch by 4Q — the chorus became the intro).
  // The sequence length joins both sides of the growth comparison:
  // shifts happen in whole songs or not at all. (Sequence edits are
  // refused mid-take, so the length here is the one the take heard.)
  if (const int64_t seq_len = activeSequenceLen(); seq_len > 0) {
    before = timing::lcm(before, seq_len);
    after = timing::lcm(after, seq_len);
  }
  if (after <= before) return;

  const int64_t epoch = epoch_samples_.load();
  int64_t rel = origin - epoch;
  if (rel < 0) rel = 0;
  // Through the seqlock (audit 2026-08-31 E5): a raw epoch store here
  // bypassed setIslandFacts, so a block reading (Q, epoch) mid-commit
  // could take a mixed pair. Same generation — the re-base is a whole-
  // old-cycle move, phase-neutral for every committed clip's origin-
  // relative render, so no origin gating rides it. (Concurrent-writer
  // note: the only audio-thread writer is this commit event; message-
  // thread fact writers are refused under a live take, so the seqlock's
  // single-writer discipline holds.)
  setIslandFacts(quantum_samples_.load(), epoch + (rel / before) * before,
                 islandGeneration());
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
  return snap ? snap->entries[(size_t)self].childCount : (int)owned->size();
}
int StackNode::ChildView::entryAt(int k) const {
  return snap ? snap->childAt(self, k) : 0;
}
AudioNode* StackNode::ChildView::nodeAt(int k) const {
  return snap ? snap->entries[(size_t)snap->childAt(self, k)].node
              : (*owned)[(size_t)k].get();
}

ProcessContext StackNode::childContext(const ProcessContext& context) const {
  // === THE TIME-MAP (time_maps.md §2, reified) ===
  // The map applies iff it is ACTIVE (valid + not bypassed) —
  // independent of expansion (I6b: collapse is purely visual). Phase is
  // a pure function of the received clock:
  // walk_segments((t − cycle_epoch) mod period).
  // No private counter, no reset-on-collapse, fully deterministic.
  // Shared by BOTH §2.3 phases so control decisions and rendering see
  // the SAME mapped child clock.
  ProcessContext child_context = context;

  const timing::TimeMap map = activeTimeMap();
  if (map.active()) {
    const int64_t rel = context.master_pos - context.cycle_epoch;

    // The map selects VIEW positions of the received cycle, so the
    // mapped time stays IN THE RECEIVED FRAME:
    // t_child = epoch + mapOffset(rel). Children align by their
    // ABSOLUTE origins — dropping the epoch here shifted every child
    // whose origin ≢ 0 (mod duration): field bug 2026-07-09, "2Q clip
    // loops its Q2 when the window selects Q1". (mapOffset folds rel
    // by the map period, negatives included.)
    child_context.master_pos = context.cycle_epoch + map.mapOffset(rel);
    // Time-map facts for the subtree (phase 2): the map itself and the
    // RECEIVED frame's cycle top — the heard grid anchor through-map
    // arm math runs against. Captured BEFORE the re-base below.
    child_context.map = map;
    child_context.map_heard_epoch = context.cycle_epoch;
    ++child_context.map_count;
    // For nested maps: the child frame's cycle top is where the map
    // lands at heard phase 0 (the first segment's start).
    child_context.cycle_epoch = context.cycle_epoch + map.mapOffset(0);
  }

  // === THE CONTEXT CYCLE (Q5 one-shot period) ===
  // Under an active map the heard loop IS the map period (the
  // context_loop rule); otherwise the scope cycle is lcm(quantum, the
  // LOOPING children's effective periods) — one-shots are excluded from
  // the fold (they adopt this very value; including them would be
  // circular). A scope with no looping content falls back to the
  // RECEIVED context cycle so a one-shot inside an all-one-shot group
  // still sounds once per the enclosing cycle.
  if (map.active()) {
    child_context.context_cycle = map.period();
  } else if (const Sequence* seq = activeSequence()) {
    // Under an active SEQUENCE the scope cycle is the song (period
    // law): a one-shot child fires once per pass of the whole
    // sequence, and takes recorded over it hear the song as their
    // frame (docs/sequencer.md §4, record-over-the-song).
    child_context.context_cycle = seq->total;
  } else {
    int64_t fold = 0;
    const GraphSnapshot* snap = context.snap;
    const int n = snap ? snap->entries[(size_t)context.self].childCount
                       : (int)children.size();
    for (int k = 0; k < n; ++k) {
      int64_t p = 0;
      if (snap) {
        const int child = snap->childAt(context.self, k);
        if (snap->entries[(size_t)child].node->periodFromContext()) continue;
        p = snapEffectivePeriod(*snap, child);
      } else {
        const AudioNode* child = children[(size_t)k].get();
        if (child->periodFromContext()) continue;
        p = child->getEffectivePeriod();
      }
      fold = timing::foldPeriod(fold, p);
    }
    if (fold > 0) {
      child_context.context_cycle =
          context.quantum > 0 ? timing::lcm(context.quantum, fold) : fold;
    } else {
      // No looping content in this scope: inherit the enclosing cycle
      // (an all-one-shot GROUP still fires once per the outer cycle).
      child_context.context_cycle = context.context_cycle;
    }
  }

  // === CUE STEPS (docs/sequencer.md §3 — the Q6 serial primitive;
  // S11 ruled, built 2026-08-27 with S20-S22) ===
  // A CUED step re-bases the subtree's received frame to the step top:
  // children hear t' = epoch + (songRel - stepStart) — a derived
  // per-step time-map layered UNDER any authored/audition map (the S9
  // composition law: the map selects SONG positions; the cue maps song
  // positions to CONTENT positions). forEachSeamRun cuts blocks at
  // step bounds (they are envelope corners), so the step is constant
  // within any one call here. The child frame's cycle top is the
  // RECEIVED epoch again — the re-based content IS the song-top span,
  // so a nested song-stack restarts from its own top on every
  // entrance. Gate lookup is NOT affected: renderChildren derives the
  // song position independently of this re-base (gates live on the
  // song timeline).
  if (const Sequence* seq = activeSequence();
      seq != nullptr && seq->any_cue && seq->total > 0) {
    const int64_t srel =
        seq->fold(child_context.master_pos - context.cycle_epoch);
    const int i = seq->stepAt(srel);
    if (seq->cueAt(i)) {
      const int64_t step_len = seq->bounds[i + 1] - seq->bounds[i];
      child_context.master_pos =
          context.cycle_epoch + (srel - seq->bounds[i]);
      child_context.cycle_epoch = context.cycle_epoch;
      // Mode-2 record INTO a cued step (S21): the through-map arm math
      // places the take at context.map's inner positions — compose the
      // audition map with the cue so the take lands where cue playback
      // will read it (the song top, [0, stepLen)). Only the audition
      // aimed at THIS step composes; an authored multi-step window
      // over cued steps is refused at arm (audio_engine).
      if (auditionStep() == i && child_context.map.active() &&
          step_len > 0) {
        child_context.map = timing::TimeMap::single(0, step_len);
      }
    }
  }
  return child_context;
}

void StackNode::control(const float* const* input_channels,
                        int num_input_channels, const ProcessContext& context) {
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
  // per callback) or the ownership fallback — see ChildView.
  const ChildView kids = childView(context);
  const int child_count = kids.count();

  // Recording context, passed DOWN (P1-6): the longest committed child
  // duration in this scope. Recording/armed children contribute 0
  // (duration resets at arm); nested-stack children contribute their
  // stored duration_samples (0 — stacks don't store one), matching the
  // historical sibling-scan semantics exactly. A CONTROL fact: render
  // never needs it.
  int64_t longest_committed = 0;
  for (int k = 0; k < child_count; ++k) {
    const int64_t d = kids.nodeAt(k)->duration_samples.load();
    if (d > longest_committed) longest_committed = d;
  }
  // Under an ACTIVE map the heard loop IS the map period (time_maps.md
  // ruling 2): children listen to one map pass, not the intrinsic
  // sibling cycle.
  if (const timing::TimeMap own_map = activeTimeMap(); own_map.active()) {
    child_context.context_loop = own_map.period();
  } else if (const Sequence* seq = activeSequence()) {
    // Record over the song (docs/sequencer.md §4): children listen to
    // the sequence, so it is their context loop — takes wrap/stop
    // against the song's grid, and contextCycle snapshots the song.
    child_context.context_loop = seq->total;
  } else {
    child_context.context_loop = longest_committed;
  }

  for (int k = 0; k < child_count; ++k) {
    child_context.self = kids.entryAt(k);
    kids.nodeAt(k)->control(input_channels, num_input_channels, child_context);
  }
}

void StackNode::render(float* const* output_channels, int num_output_channels,
                       const ProcessContext& context) const {
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
      int64_t rel = context.master_pos - context.cycle_epoch;
      rel = ((rel % p) + p) % p;
      playhead_pos.store((double)rel / (double)p);
    } else {
      playhead_pos.store(0.0);
    }
  }

  const ChildView kids = childView(context);
  const int child_count = kids.count();

  // With the effect rack ON — or the group's OUTPUT STAGE not at unity
  // (panned, fader below 1) — or its GATE below unity — children sum
  // into the fx accumulator first: the rack shapes the GROUP's summed
  // signal (a stack reverb wets the whole kit), and the output-stage
  // gains scale the group as one. The accumulator is STEREO: children
  // may render panned/stereo signals, so folding channel 0 alone would
  // collapse their image (the pre-stereo rack's documented limitation).
  //
  // MUTE = THE PRE-FX GATE (S7 smoothness law, docs/sequencer.md §9 —
  // supersedes the output-stage-zero + frozen-tails model): the group's
  // mute and any parent-sequence gate (context.gate_*) resolve to one
  // ramped dry gain applied to the children's SUM before the rack, so
  // edges fade (~10 ms, no pops) and the rack keeps running — echo and
  // reverb tails RING OUT through a closed gate. Children still render
  // (their own tails and playhead telemetry keep flowing).
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
    int64_t mapped = context.master_pos;
    if (const timing::TimeMap map = activeTimeMap(); map.active()) {
      mapped = context.cycle_epoch +
               map.mapOffset(context.master_pos - context.cycle_epoch);
    }
    seq_rel0 = seq->fold(mapped - context.cycle_epoch);
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

    // Child renders into our mix_buffer.
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
    // PRE-FX gate above now (S7) — the fader here is always `gain`, so
    // a muted group's rack tail still reaches the parent while it
    // rings out. Channel 0 is L, channel 1 is R; any channels past the
    // stereo pair get the fader-scaled unpanned channel-0 signal (the
    // historical duplicate-mono behavior).
    float gl = 1.0f, gr = 1.0f, fader = 1.0f;
    outputStageGains(group_pan, group_gain, MuteState::AUDIBLE, gl, gr, fader);
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

  // Aggregate: Sum peaks from all children (simplified for now)
  // Future: Better recursive mixdown normalization
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

AudioNode* StackNode::findNodeByUuid(const juce::String& uuid) {
  if (getUuid() == uuid) return this;

  // Virtual recursion (findByUuid) — no per-child dynamic_cast.
  for (const auto& child : children) {
    if (auto* found = child->findByUuid(uuid)) return found;
  }

  return nullptr;
}

bool StackNode::isAnyChildRecording() const {
  // Virtual dispatch replaces the old per-child dynamic_cast: clips
  // answer from their recording state machine, nested stacks recurse
  // via their own isArmedOrRecording override.
  const auto& kids = children;  // message thread: ownership vector
  for (const auto& child : kids) {
    if (child->isArmedOrRecording()) return true;
  }
  return false;
}

}  // namespace celestrian
