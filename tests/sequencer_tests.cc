/**
 * THE SEQUENCER (docs/sequencer.md — the fractal per-stack Sequence).
 * Pins the ruled canon, each test named for its ruling:
 *
 *   GATES (S1, mute-shaped + I5 fractal): a gated-off child is silent;
 *     a gate on a group covers its subtree; absent uuid inherits ON.
 *   SMOOTHNESS LAW (S7): gate edges are ~10 ms linear ramps, exact
 *     across arbitrary block splits (the envelope is schedule-derived,
 *     not integrator state); fx tails RING OUT through a closed gate —
 *     MUTE included (it rides the same pre-fx gate).
 *   AN ARM AT A STEP BOUNDARY is pending until the boundary's block and
 *     captures from the boundary's own sample, wherever a gate's ramp
 *     cuts the blocks before it.
 *   VERBS: setSequence/toggleSequence are undoable, publish in
 *     metadata, and round-trip through session save/load.
 *   THE STEP AUDITION (§11.2): auditionStep derives a one-segment map
 *     from the sequence (follows a resize, overrides the authored
 *     window, gone with the sequence), publishes it, is not undoable;
 *     S18: a take recorded INTO the looping step is a step-sized part
 *     (C = the step), and the song rides the zero.
 *
 * The period law of a song (steps concatenate, a gated child keeps its
 * phase, a cued step replays the song top, a take armed over the song
 * hears it as its frame) is pinned sample-exactly by scenarios S17-S19
 * and the golden period_law_cases; the refusal of a song edit under a
 * live take by S26 and undo_tests.cc.
 *
 * Twin: ui/js/tests/sequence.test.mjs (mock + view-model parity).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <initializer_list>
#include <map>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/sequence.h"
#include "../src/session_io.h"
#include "../src/track_template.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::posmod;
using scenario::seqPayload;
using test_utils::contextFor;
using test_utils::NodeContext;

namespace {

constexpr double kSr = 44100.0;
constexpr int kLen = 4410;   // one committed take = 4410 samples (Q)
constexpr int kFade = 441;   // Sequence::fadeSamples(44100) = 10 ms
constexpr int64_t kQ = 20000;  // the engine cases' first take

/** A committed constant-amplitude take, already sounding. */
std::unique_ptr<ClipNode> makeDcClip(const char* name, float amp,
                                     int len = kLen) {
  return test_utils::committedClip(name, kSr, len, amp);
}

/** A committed take whose content names its own index (content[i] =
 * i / len) — the phase probe. */
std::unique_ptr<ClipNode> makeRampClip(const char* name, int len = kLen) {
  return test_utils::committedClip(
      name, kSr, len, [len](int64_t i) { return (float)i / (float)len; });
}

/** A two-step sequence: step "one" of `l1`, step "two" of `l2`, with
 * explicit gate rows. */
Sequence* makeSeq(int64_t l1, int64_t l2,
                  std::vector<Sequence::GateRow> gates) {
  auto* s = new Sequence();
  s->steps.push_back({l1, "one"});
  s->steps.push_back({l2, "two"});
  s->gates = std::move(gates);
  s->finalize();
  return s;
}

/** makeSeq(kLen, 2 * kLen) with step "two" CUED. */
Sequence* makeCuedSeq(std::vector<Sequence::GateRow> gates = {}) {
  Sequence* s = makeSeq(kLen, 2 * kLen, std::move(gates));
  s->steps[1].cue = true;
  s->finalize();
  return s;
}

/** A step with one explicit successor. */
Sequence::Step stepTo(int64_t len, const char* name, int to) {
  Sequence::Step st;
  st.len = len;
  st.name = name;
  st.next.push_back({to, 1});
  return st;
}

/** The published sequence record of a root or node var. */
juce::var seqOf(const juce::var& node) {
  return node.getProperty("sequence", juce::var());
}

/** The step `id` auditions (-1 none; -2 when it publishes no sequence). */
int auditionOf(Island& is, const juce::String& id) {
  return (int)seqOf(is.node(id)).getProperty("auditionStep", -2);
}

/** 1000-sample steps with the given successor lists, under `seed`. */
juce::var routedPayload(const std::vector<std::vector<int>>& nexts, int seed) {
  std::vector<scenario::StepSpec> steps;
  for (const auto& next : nexts) steps.push_back({1000, false, next});
  return seqPayload(steps, {}, seed);
}

/** `outer` saved to a fresh bundle named `name` and loaded back (not ok
 * when either half failed); the bundle stays in `dir` for the caller to
 * edit or reload. */
session_io::LoadedSession roundTrip(const StackNode& outer,
                                    const juce::String& name,
                                    juce::File* dir = nullptr) {
  bool saved = false;
  auto trip = test_utils::roundTrip(outer, kSr, name, {}, &saved);
  if (dir != nullptr) *dir = trip.dir;
  trip.loaded.ok = trip.loaded.ok && saved;
  return std::move(trip.loaded);
}

/** The sequence of the first child of a loaded bundle (a group). */
const Sequence* firstGroupSequence(const session_io::LoadedSession& loaded) {
  if (!loaded.ok || loaded.children.empty()) return nullptr;
  auto* group = dynamic_cast<StackNode*>(loaded.children[0].get());
  return group != nullptr ? group->sequencePtr() : nullptr;
}

}  // namespace

class SequencerTests : public juce::UnitTest {
 public:
  SequencerTests() : juce::UnitTest("Sequencer (docs/sequencer.md)") {}

  void runTest() override {
    testEnvelopeMath();
    testGates();
    testSmoothness();
    testTailsRing();
    testArmAtAStepBoundary();
    testEngineVerbs();
    testSaveLoad();
    testAudition();
    testWindowDomain();
    testCueSteps();
    testSuccessors();
    testStepFades();
  }

 private:
  /** Process `root` at master_pos `t` for `n` samples through the
   * production path (whole-graph snapshot, control + render); returns
   * channel L. `warm` runs one extra settle block first (a fresh
   * commit renders silent for its own block; the mute/solo ramp seeds
   * on first render) — sequential drivers pass warm=false. */
  static std::vector<float> renderAt(StackNode& root, int64_t t, int n,
                                     bool warm = true) {
    auto once = [&](int64_t at, int count) {
      std::vector<float> outL((size_t)count, 0.0f), outR((size_t)count, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      NodeContext play = contextFor(root, count, at);
      play.ctx.is_playing = true;
      root.process(nullptr, outs, 0, 2, play.ctx);
      return outL;
    };
    if (warm) once(t, n);
    return once(t, n);
  }

  struct GainRow {
    uint64_t mask;
    int64_t at;
    float want;
    float tolerance;
    const char* what;
  };
  /** Each row: the gate envelope of `mask` at song position `at`. */
  void expectGains(const Sequence& s, int64_t fade,
                   std::initializer_list<GainRow> rows) {
    for (const auto& row : rows) {
      expectWithinAbsoluteError(s.gainAt(row.mask, row.at, fade), row.want,
                                row.tolerance, row.what);
    }
  }

  void testEnvelopeMath() {
    beginTest("envelope: pure, piecewise-linear, wraps with the loop");
    {
      Sequence s;
      s.steps.push_back({1000, "a"});
      s.steps.push_back({2000, "b"});
      s.steps.push_back({1000, "c"});
      s.finalize();
      expectEquals(s.total, (int64_t)4000, "steps concatenate");
      expectEquals(s.stepAt(0), 0);
      expectEquals(s.stepAt(999), 0);
      expectEquals(s.stepAt(1000), 1);
      expectEquals(s.stepAt(3999), 2);

      // Mask 0b011 (a+b on, c off) is one run [0, 3000); mask 0b101 (c
      // and a on) is ONE run across the loop seam; all-on has no edges.
      const uint64_t m = 0b011, w = 0b101;
      expectGains(s, 100, {
          {m, 50, 0.5f, 1e-6f, "fade-in at run start"},
          {m, 1500, 1.0f, 1e-6f, "interior = 1 (a+b merge into one run)"},
          {m, 2950, 0.5f, 1e-6f, "fade-out into the off step"},
          {m, 3500, 0.0f, 1e-6f, "off step = 0"},
          {w, 3999, 1.0f, 1e-6f, "run wraps: end of c is mid-run"},
          {w, 0, 1.0f, 1e-6f, "run wraps: start of a is mid-run"},
          {w, 950, 0.5f, 1e-6f, "fade-out approaching b"},
          {~0ull, 0, 1.0f, 1e-6f, "all-on = constant 1"},
      });
    }
  }

  void testGates() {
    // island ── a (0.1, inherits ON everywhere)
    //        └─ groupB ── b1 (0.4), b2 (0.2)  — gated ON in step 2 only
    beginTest("GATES: mute-shaped, fractal, absent uuid inherits ON");
    {
      StackNode root("island");
      auto groupB = std::make_unique<StackNode>("B");
      groupB->addChild(makeDcClip("b1", 0.4f));
      groupB->addChild(makeDcClip("b2", 0.2f));
      const juce::String bId = groupB->getUuid();
      root.addChild(makeDcClip("a", 0.1f));
      root.addChild(std::move(groupB));

      delete root.exchangeSequence(
          makeSeq(kLen, 2 * kLen, {{bId, 0b10ull}}));

      // Step-1 interior (past every fade): only a sounds.
      auto s1 = renderAt(root, kLen / 2, 64);
      expectWithinAbsoluteError(s1[32], 0.1f, 1e-4f,
                                "step 1: group B gated off (fractal)");
      // Step-2 interior: a + the whole group (0.1 + 0.4 + 0.2).
      auto s2 = renderAt(root, 2 * kLen, 64);
      expectWithinAbsoluteError(s2[32], 0.7f, 1e-4f,
                                "step 2: group B enters, a inherits ON");
      // Bypass = the jam: everything sounds in step 1's span too.
      root.setSequenceBypassed(true);
      auto jam = renderAt(root, kLen / 2, 64);
      expectWithinAbsoluteError(jam[32], 0.7f, 1e-4f,
                                "bypassed sequence changes nothing (I9)");
      root.setSequenceBypassed(false);
    }
  }

  void testSmoothness() {
    beginTest("S7: gate edges ramp over 10 ms, block-split independent");
    {
      StackNode root("island");
      root.addChild(makeDcClip("b", 0.4f));
      const juce::String bId = root.ownedChildren()[0]->getUuid();
      delete root.exchangeSequence(makeSeq(kLen, 2 * kLen, {{bId, 0b10ull}}));

      // One big render straddling the step-1/step-2 boundary: silence,
      // then a linear 441-sample rise to 0.4 — no jumps anywhere.
      const int n = 2 * kFade;
      const int64_t t0 = (int64_t)kLen - kFade;
      auto big = renderAt(root, t0, n);
      expectWithinAbsoluteError(big[0], 0.0f, 1e-5f, "closed before entry");
      expectWithinAbsoluteError(big[(size_t)kFade], 0.0f, 2e-3f,
                                "the edge itself starts from 0");
      expectWithinAbsoluteError(big[(size_t)(kFade + kFade / 2)], 0.2f, 2e-3f,
                                "mid-fade = half amplitude");
      expectWithinAbsoluteError(big[(size_t)(n - 1)], 0.4f, 2e-3f,
                                "fade completes at 10 ms");
      float max_jump = 0.0f;
      for (int i = 1; i < n; ++i) {
        max_jump = std::max(max_jump,
                            std::abs(big[(size_t)i] - big[(size_t)(i - 1)]));
      }
      expect(max_jump < 0.4f / (float)kFade + 1e-4f,
             "no sample-to-sample jump exceeds the ramp slope (no pops)");

      // The envelope is schedule-derived (I6): odd chunks render the
      // same span.
      expectSplitIndependent(root, t0, n, big, 1e-6f);
    }

    beginTest("S7: a gated child that is itself a windowed group ramps ONCE "
              "- its own seam inside the ramp does not restart the envelope");
    {
      // The gated child is a group whose free-cut window wraps 200
      // samples into the parent's 10 ms entrance ramp: the group renders
      // that ramp in two runs of its own, and each must carry its slice.
      const int seam_into_ramp = 200;
      StackNode root("island");
      root.addChild(makeWindowedGroup("g", 0.4f, kLen + seam_into_ramp));
      const juce::String gId = root.ownedChildren()[0]->getUuid();
      delete root.exchangeSequence(makeSeq(kLen, 2 * kLen, {{gId, 0b10ull}}));

      const int n = 2 * kFade;
      const int64_t t0 = (int64_t)kLen - kFade;
      auto big = renderAt(root, t0, n);
      expectWithinAbsoluteError(big[0], 0.0f, 1e-5f, "closed before entry");
      for (int k = 0; k < kFade; k += 21) {
        expectWithinAbsoluteError(big[(size_t)(kFade + k)],
                                  0.4f * (float)k / (float)kFade, 2e-3f,
                                  "one straight rise across the group's seam");
      }
      expectWithinAbsoluteError(big[(size_t)(n - 1)], 0.4f, 2e-3f,
                                "fade completes at 10 ms");
      float max_jump = 0.0f;
      for (int i = 1; i < n; ++i) {
        max_jump = std::max(max_jump,
                            std::abs(big[(size_t)i] - big[(size_t)(i - 1)]));
      }
      expect(max_jump < 0.4f / (float)kFade + 1e-4f,
             "no step where the group wraps (the ramp is not replayed)");

      expectSplitIndependent(root, t0, n, big, 1e-5f);
    }
  }

  /** A group holding one 2Q DC clip, with a single window
   * [0, window_len) of its own (window_len <= 2Q) - the gated child
   * that splits the runs it is handed. */
  static std::unique_ptr<StackNode> makeWindowedGroup(const char* name,
                                                      float amp,
                                                      int64_t window_len) {
    auto group = std::make_unique<StackNode>(name);
    group->addChild(makeDcClip("member", amp, 2 * kLen));
    group->setLoopPoints(0, window_len);
    return group;
  }

  /** The span [t0, t0 + n) rendered in `chunk`-sample pieces equals
   * `whole`, the same span rendered as one block (probed every `stride`
   * samples). */
  void expectSplitIndependent(StackNode& root, int64_t t0, int n,
                              const std::vector<float>& whole,
                              float tolerance, int chunk = 97,
                              int stride = 37) {
    std::vector<float> chunks;
    int64_t t = t0;
    int left = n;
    while (left > 0) {
      const int c = std::min(left, chunk);
      auto part = renderAt(root, t, c);
      chunks.insert(chunks.end(), part.begin(), part.begin() + c);
      t += c;
      left -= c;
    }
    for (int i = 0; i < n; i += stride) {
      expectWithinAbsoluteError(chunks[(size_t)i], whole[(size_t)i], tolerance,
                                "block splits do not change the output");
    }
  }

  /** Turns on the echo of `clip`'s own chain: 50 ms delay, wet 0.8, no
   * feedback. prepare() first — a node-level test has no device start,
   * and an unprepared echo has no delay line. */
  void enableEcho(ClipNode& clip) {
    auto* echo = clip.fxChain()->slots()[2].get();
    echo->prepare(kSr);
    echo->enabled.store(true);
    expect(echo->setParam("time", 0.05), "echo time set");
    expect(echo->setParam("mix", 0.8), "echo mix set");
    expect(echo->setParam("feedback", 0.0), "echo feedback set");
  }

  void testTailsRing() {
    beginTest("S7: fx tails ring through a closed gate (sequence)");
    {
      StackNode root("island");
      auto clip = makeDcClip("b", 0.5f);
      enableEcho(*clip);
      const juce::String bId = clip->getUuid();
      root.addChild(std::move(clip));
      delete root.exchangeSequence(makeSeq(kLen, 2 * kLen, {{bId, 0b01ull}}));

      // Warm the echo line across step 1's tail, then cross into the
      // OFF step: sequential single-pass renders (echo state is real
      // DSP state — no warm double-render here).
      const int block = kFade;
      renderAt(root, 0, 64, /*warm=*/false);  // flush the commit block
      int64_t t = (int64_t)kLen - 4 * block;
      for (int k = 0; k < 4; ++k, t += block)
        renderAt(root, t, block, /*warm=*/false);
      // Fade block at the boundary, then fully closed:
      renderAt(root, t, block, /*warm=*/false);
      t += block;
      expect(test_utils::peakOf(renderAt(root, t, block, false)) > 0.05f,
             "the echo of the audible material still sounds after the gate "
             "closed (tails ring, never freeze)");
    }

    beginTest("S7: MUTE rides the same gate - tail rings, edge fades");
    {
      StackNode root("island");
      auto clip = makeDcClip("m", 0.5f);
      enableEcho(*clip);
      ClipNode* m = clip.get();
      root.addChild(std::move(clip));

      // Audible for a few blocks (seeds the ramp at 1, warms the echo).
      int64_t t = 0;
      for (int k = 0; k < 6; ++k, t += kFade)
        renderAt(root, t, kFade, /*warm=*/false);
      m->is_muted.store(true);
      auto fadeBlock = renderAt(root, t, kFade, /*warm=*/false);
      t += kFade;
      // The mute edge is a ramp, not a cliff: the first muted block
      // still carries signal, decreasing.
      expect(std::abs(fadeBlock[0]) > 0.1f, "mute edge starts audible");
      expect(test_utils::peakOf(renderAt(root, t, kFade, false)) > 0.05f,
             "muted clip's echo tail rings out");
    }
  }

  /** What an arm aimed at a step boundary published and captured. */
  struct BoundaryArm {
    bool pending_before = false;  // after the block that ends short of it
    bool recording_at = false;    // after the block that holds it
    int64_t captured_at = 0;      // the live length after that block
    int64_t origin = 0;           // the committed take's origin
    int64_t duration = 0;
    int off_ramp = 0;  // committed samples that are not the input's
  };

  /** A song of two 2Q steps on the root of a one-clip island. A fresh
   * clip is armed `lead` samples (one to two blocks) before the step
   * boundary — its arm target — and the two blocks up to and across the
   * boundary are driven one by one; the take then runs 2Q.
   * `gated`: the first clip is off in the second step, so its gate
   * ramps out over the fade before the boundary and the root cuts the
   * block at the ramp's corner (StackNode::forEachSeamRun). */
  BoundaryArm armBeforeStepBoundary(int64_t lead, bool gated) {
    Island is;
    const juce::String a = is.record(kQ);
    std::map<juce::String, std::vector<bool>> gates;
    if (gated) gates[a] = {true, false};
    is.engine.setSequence(is.rootId(), seqPayload({{2 * kQ}, {2 * kQ}}, gates));
    // The song is anchored at the island zero.
    const int64_t boundary = is.zero() + 2 * kQ;
    const juce::String c = is.createClip();
    is.drive(boundary - lead - is.clock);
    is.engine.startRecordingInNode(c);

    BoundaryArm arm;
    is.drive(scenario::BLOCK);
    arm.pending_before =
        is.bprop(c, "isPendingStart") && !is.bprop(c, "isRecording");
    is.drive(scenario::BLOCK);
    arm.recording_at = is.bprop(c, "isRecording");
    arm.captured_at = is.dur(c);

    // Stopped a block short of 2Q: the take runs on to that boundary.
    is.drive(2 * kQ - arm.captured_at - scenario::BLOCK);
    is.engine.stopRecordingInNode(c);
    is.settle();
    arm.origin = is.origin(c);
    arm.duration = is.dur(c);
    auto* clip = dynamic_cast<ClipNode*>(is.nodePtr(c));
    const juce::AudioBuffer<float>& content = clip->getAudioBuffer();
    const int64_t base = clip->getContentBase();
    for (int64_t k = 0; k < arm.duration; ++k) {
      if (content.getSample(0, (int)(base + k)) !=
          scenario::rampAt(boundary + k)) {
        ++arm.off_ramp;
      }
    }
    return arm;
  }

  void testArmAtAStepBoundary() {
    beginTest("an arm aimed at a step boundary is pending until the block "
              "that holds it and captures from the boundary's own sample, "
              "wherever a gate's ramp cuts the blocks before it");
    {
      // The ramp's corner sits kFade before the boundary: each lead puts
      // it at another offset of the block that ends short of the
      // boundary (159, 200, 459 of 512).
      for (const int64_t lead : {kFade + 159, kFade + 200, kFade + 459}) {
        const int64_t past_boundary = 2 * scenario::BLOCK - lead;
        for (const bool gated : {false, true}) {
          const juce::String cut = gated ? " (block cut)" : " (block whole)";
          const BoundaryArm arm = armBeforeStepBoundary(lead, gated);
          expect(arm.pending_before,
                 "pending while the clock is short of the boundary" + cut);
          expect(arm.recording_at,
                 "recording in the block the boundary is in" + cut);
          expectEquals(arm.captured_at, past_boundary,
                       "captured exactly what arrived since the boundary" + cut);
          expectEquals(arm.origin, (int64_t)(2 * kQ),
                       "the take's origin is the boundary" + cut);
          expectEquals(arm.duration, (int64_t)(2 * kQ), "the take is 2Q" + cut);
          expectEquals(arm.off_ramp, 0,
                       "content[k] is the input at boundary + k, from k = 0" +
                           cut);
        }
      }
    }
  }

  void testEngineVerbs() {
    beginTest("setSequence: undoable, publishes, toggle round-trips");
    {
      Island is;
      const juce::String root = is.rootId();
      expect(root.isNotEmpty(), "root uuid published");
      auto seq = [&] { return seqOf(is.state()); };
      auto stepCount = [&] {
        return seq().getProperty("steps", juce::var()).getArray()->size();
      };
      is.engine.setSequence(
          root, seqPayload({{1000}, {2000}}, {{"some-child", {false, true}}}));
      expect(seq().isObject(), "sequence published in metadata");
      expectEquals(stepCount(), 2, "two steps published");
      expect(!(bool)seq().getProperty("bypassed", true),
             "born active (not bypassed)");

      is.engine.undo();
      expect(!seq().isObject(), "undo removes the sequence");
      is.engine.redo();
      expect(seq().isObject(), "redo restores the sequence");

      is.engine.toggleSequence(root);
      expect((bool)seq().getProperty("bypassed", false),
             "toggle bypasses (the jam comes back)");
      is.engine.undo();
      expect(!(bool)seq().getProperty("bypassed", true),
             "bypass toggle is undoable");

      // A malformed payload is refused: no edit is recorded.
      is.engine.setSequence(root, seqPayload({{0}}));
      expectEquals(stepCount(), 2,
                   "zero-length step refused; sequence unchanged");
    }
  }

  void testAudition() {
    beginTest("AUDITION: derived map, precedence over the authored window");
    {
      StackNode root("island");
      root.addChild(makeDcClip("a", 0.1f));
      root.setQuantum(kLen, 0);
      root.setLoopPoints(0, kLen);  // an authored window underneath
      delete root.exchangeSequence(makeSeq(2 * kLen, 4 * kLen, {}));
      expectEquals(root.activeTimeMap().period(), (int64_t)kLen,
                   "authored window wins with no audition");
      root.setAuditionStep(1);
      const timing::TimeMap a = root.activeTimeMap();
      expect(a.active(), "audition map active");
      expectEquals(a.segs[0].start, (int64_t)(2 * kLen), "step 1 top");
      expectEquals(a.segs[0].end, (int64_t)(6 * kLen), "step 1 end");
      expectEquals(root.getEffectivePeriod(), (int64_t)(4 * kLen),
                   "effective period = the step (map over sequence, S9)");
      expect(root.isLoopWindowActive(), "windowActive publishes true");
      // Follows a resize (same count), not a shape change.
      delete root.exchangeSequence(makeSeq(2 * kLen, 6 * kLen, {}));
      expectEquals(root.activeTimeMap().segs[0].end, (int64_t)(8 * kLen),
                   "derived: follows the step resize");
      // Gone with the sequence; the authored window returns (I9).
      root.setSequenceBypassed(true);
      expectEquals(root.activeTimeMap().period(), (int64_t)kLen,
                   "sequence bypassed: audition gone, authored window back");
      root.setSequenceBypassed(false);
      root.setAuditionStep(-1);
      expectEquals(root.activeTimeMap().period(), (int64_t)kLen, "-1 stops");
      // Out-of-range index = none.
      root.setAuditionStep(7);
      expectEquals(root.activeTimeMap().period(), (int64_t)kLen,
                   "no such step: no audition");
      // Metadata: auditionStep + the derived window over the base fields.
      root.setAuditionStep(0);
      const juce::var md = root.getMetadata();
      const juce::var sq = md.getProperty("sequence", juce::var());
      expectEquals((int)sq.getProperty("auditionStep", -1), 0,
                   "auditionStep published");
      expectEquals((int64_t)(double)md.getProperty("loopStart", -1.0),
                   (int64_t)0, "loopStart = step top");
      expectEquals((int64_t)(double)md.getProperty("loopEnd", -1.0),
                   (int64_t)(2 * kLen), "loopEnd = step end");
      expect((bool)md.getProperty("windowActive", false), "windowActive");
      root.setAuditionStep(-1);
      expectEquals((int)root.getMetadata()
                       .getProperty("sequence", juce::var())
                       .getProperty("auditionStep", 0),
                   -1, "none publishes -1");
    }

    beginTest("AUDITION: the engine verb (not undoable; mid-take refusal)");
    {
      Island is;
      const juce::String root = is.rootId();
      auto auditioned = [&] { return auditionOf(is, root); };
      // The verb needs only an active sequence (no Q).
      is.engine.setSequence(root, seqPayload({{1000}, {2000}}));
      const bool can_undo_before = is.engine.canUndo();
      is.engine.auditionStep(root, 1);
      const juce::var st = is.state();
      expectEquals(auditioned(), 1, "audition set through the engine");
      expect((bool)st.getProperty("windowActive", false),
             "root publishes the derived window");
      expectEquals((int64_t)(double)st.getProperty("loopStart", -1.0),
                   (int64_t)1000, "loopStart");
      expect(is.engine.canUndo() == can_undo_before,
             "not an edit: undo log untouched");
      is.engine.auditionStep(root, 5);
      expectEquals(auditioned(), 1, "out-of-range refused, previous kept");
      // A shape change clears it (delete a step).
      is.engine.setSequence(root, seqPayload({{1000}}));
      expectEquals(auditioned(), -1, "shape change clears the audition");
      is.engine.auditionStep(root, 0);
      expectEquals(auditioned(), 0, "the remaining step auditions");
      is.engine.auditionStep(root, -1);
      expect(!(bool)is.state().getProperty("windowActive", true), "-1 stops");

      // Mid-take: an audition changes what the performer hears, so the
      // verb refuses while a take is live anywhere in the island.
      const juce::String clip = is.createClip();
      is.engine.startRecordingInNode(clip);
      is.engine.auditionStep(root, 0);
      expectEquals(auditioned(), -1, "refused while a take is armed/recording");
      is.engine.stopRecordingInNode(clip);
    }

    beginTest("S18: record INTO a looping step = a step-sized part; "
              "the song rides the zero");
    {
      Island is;
      const juce::String root = is.rootId();
      is.record(kQ);
      const int64_t Q = is.Q();
      expectEquals(Q, kQ, "Q established");
      const juce::String b = is.record(2 * Q);
      expectEquals(is.dur(b), 2 * Q, "B = 2Q");
      const int64_t zero_before = is.zero();

      // The song: intro 2Q | chorus 4Q | out 2Q = 8Q. Loop the chorus.
      is.engine.setSequence(root, seqPayload({{2 * Q}, {4 * Q}, {2 * Q}}));
      is.engine.auditionStep(root, 1);

      // Record C into the chorus: never stop — the one-period cap
      // commits it at exactly the step.
      const juce::String c = is.createClip();
      is.engine.startRecordingInNode(c);
      is.drive(8 * Q);
      is.settle();
      expect(!is.bprop(c, "isRecording"), "C committed");
      expectEquals(is.dur(c), 4 * Q,
                   "S18: C = the STEP length, not the 8Q song");
      expectEquals(is.zero(), zero_before,
                   "the zero stays: a 4Q part in an 8Q song is not a whole song");
      const int64_t rel = posmod(is.origin(c) - is.zero(), 8 * Q);
      expect(rel >= 2 * Q && rel < 6 * Q,
             "origin inside the chorus in song coordinates (got " +
                 juce::String(rel / (double)Q) + "Q)");
      expectEquals(rel % Q, (int64_t)0, "on the Q grid");
      expectEquals(auditionOf(is, root), 1,
                   "the loop stays on after the commit");
      // The frame: still the song (no silence-padded 8Q clip).
      expectEquals(is.rootProp("loopEnd"), 6 * Q,
                   "derived window still published");
    }
  }

  void testWindowDomain() {
    beginTest("S16: a window authored over the song suspends with the sequence");
    {
      Island is;
      const juce::String sId = is.createStack();
      auto* stack = dynamic_cast<StackNode*>(is.nodePtr(sId));
      expect(stack != nullptr, "stack found");
      // A window with NO sequence: intrinsic domain, stays active.
      is.window(sId, 0, 1000);
      expect(stack->windowDomain() == StackNode::WindowDomain::Intrinsic,
             "no sequence: intrinsic domain");
      // Now a sequence, then a window authored over it: sequence domain.
      is.engine.setSequence(sId, seqPayload({{4000}}));
      is.window(sId, 1000, 3000);
      expect(stack->windowDomain() == StackNode::WindowDomain::Sequence,
             "authored over the song: sequence domain");
      expect(stack->activeTimeMap().active(), "active while the sequence is on");
      expect(!stack->windowSuspended(), "not suspended");
      // Bypass the sequence: SUSPENDED (no map, geometry kept).
      is.engine.toggleSequence(sId);
      expect(!stack->activeTimeMap().active(), "suspended: reads as no map");
      expect(stack->windowSuspended(), "windowSuspended");
      expectEquals(stack->getLoopStart(), (int64_t)1000, "geometry kept (I9)");
      expect(is.bprop(sId, "windowSuspended"), "metadata: windowSuspended");
      expect(!is.bprop(sId, "windowActive"),
             "metadata: windowActive false while suspended");
      expectEquals(is.sprop(sId, "windowDomain"), juce::String("sequence"),
                   "metadata: windowDomain");
      // Reactivate: it returns.
      is.engine.toggleSequence(sId);
      expect(stack->activeTimeMap().active(), "returns with the sequence");
      // Undo the window edit: the stamp reverts to intrinsic.
      is.engine.undo();  // the second toggle
      is.engine.undo();  // the first toggle
      is.engine.undo();  // the sequence-domain window edit
      expect(stack->windowDomain() == StackNode::WindowDomain::Intrinsic,
             "undo restores the old stamp");
      is.engine.redo();
      expect(stack->windowDomain() == StackNode::WindowDomain::Sequence,
             "redo re-stamps");
    }
    beginTest("S16: the domain survives save/load");
    {
      Island is;
      const juce::String sId = is.createStack();
      is.engine.setSequence(sId, seqPayload({{4000}}));
      is.window(sId, 1000, 3000);
      const juce::File dir = test_utils::freshTempDir("seq_window_domain");
      expect(is.engine.saveSession(dir.getFullPathName()), "saved");
      Island fresh;
      expect(fresh.engine.loadSession(dir.getFullPathName()), "loaded");
      expectEquals(fresh.sprop(fresh.lastChild(), "windowDomain"),
                   juce::String("sequence"), "domain round-trips");
      dir.deleteRecursively();
    }
  }

  void testSaveLoad() {
    beginTest("session round trip: a group's sequence and its bypass flag "
              "survive save and load");
    {
      StackNode outer("island2");
      auto group = std::make_unique<StackNode>("song");
      auto c2 = makeDcClip("b", 0.2f);
      const juce::String bId = c2->getUuid();
      group->addChild(std::move(c2));
      delete group->exchangeSequence(makeSeq(kLen, 2 * kLen, {{bId, 0b01ull}}));
      StackNode* g = group.get();
      outer.addChild(std::move(group));
      outer.setQuantum(kLen, 0);
      expect(g->activeSequenceLen() == 3 * kLen, "group sequence active");
      g->setSequenceBypassed(true);  // bypassed geometry must survive (I9)

      const auto back = roundTrip(outer, "seq_io");
      expect(back.ok, "group saved and loaded");
      expectEquals((int)back.children.size(), 1, "one child back");
      auto* gBack = back.children.empty()
                        ? nullptr
                        : dynamic_cast<StackNode*>(back.children[0].get());
      expect(gBack != nullptr, "group came back as a stack");
      expect(gBack != nullptr && gBack->isSequenceBypassed(),
             "the bypass flag came back set");
      expect(gBack != nullptr && gBack->activeSequenceLen() == 0,
             "a bypassed sequence is not active");
      const Sequence* s = gBack != nullptr ? gBack->sequencePtr() : nullptr;
      expect(s != nullptr, "the bypassed sequence came back");
      if (s != nullptr) {
        expectEquals((int)s->steps.size(), 2, "two steps back");
        expectEquals(s->steps[0].len, (int64_t)kLen, "step 1 length back");
        expectEquals(s->steps[1].len, (int64_t)(2 * kLen),
                     "step 2 length back");
        expectEquals(s->steps[0].name, juce::String("one"), "name back");
        expectEquals((int64_t)s->maskFor(bId), (int64_t)0b01ull,
                     "gates re-keyed to the child uuid");
        expect(s->maskFor("unknown") == ~0ull, "absent uuid inherits ON");
      }
    }

    beginTest("S14: a track template carries its sequence, gates re-keyed");
    {
      StackNode group("song");
      auto c1 = makeDcClip("kick", 0.1f);
      auto c2 = makeDcClip("snare", 0.2f);
      const juce::String kickId = c1->getUuid();
      group.addChild(std::move(c1));
      group.addChild(std::move(c2));
      delete group.exchangeSequence(
          makeSeq(kLen, 2 * kLen, {{kickId, 0b01ull}}));

      const juce::var tpl = track_templates::capture(group, kLen);
      expect(tpl.getProperty("sequence", juce::var()).isObject(),
             "capture carries the sequence (S14)");

      auto rebuilt = track_templates::build(tpl, kSr, /*q_samples=*/2205);
      auto* g = dynamic_cast<StackNode*>(rebuilt.get());
      expect(g != nullptr, "rebuilt as a stack");
      const Sequence* s = g->sequencePtr();
      expect(s != nullptr, "sequence rebuilt");
      if (s != nullptr) {
        // lenQ counts materialize against the DESTINATION Q (2205).
        expectEquals(s->steps[0].len, (int64_t)2205, "1Q step at new Q");
        expectEquals(s->steps[1].len, (int64_t)4410, "2Q step at new Q");
        // Gates re-keyed onto the FRESH child uuids (index precedent).
        const juce::String newKick = g->getChild(0)->getUuid();
        expect(newKick != kickId, "template stamps fresh uuids");
        expectEquals((int64_t)s->maskFor(newKick), (int64_t)0b01ull,
                     "gate row followed the child across the rebuild");
        expect(s->maskFor(g->getChild(1)->getUuid()) == ~0ull,
               "un-gated child still inherits ON");
      }
      // Pre-Q destination: the sequence is skipped, the subtree lands.
      auto preQ = track_templates::build(tpl, kSr, /*q_samples=*/0);
      auto* g2 = dynamic_cast<StackNode*>(preQ.get());
      expect(g2 != nullptr && g2->sequencePtr() == nullptr,
             "no Q yet: subtree builds, sequence skipped");
    }
  }

  // === PER-STEP FADES (S13, docs/sequencer.md §15): a run ramps in
  // over its first step's fade_in and out over its last step's
  // fade_out; the anti-pop micro-fade is the floor. ===
  void testStepFades() {
    /** makeSeq(kLen, 2 * kLen) whose step "two" fades in over half a Q,
     * with `child` gated ON in step two only. */
    auto fadeInSeq = [](const juce::String& child) {
      Sequence* s = makeSeq(kLen, 2 * kLen, {{child, 0b10ull}});
      s->steps[1].fade_in = kLen / 2;
      s->finalize();
      return s;
    };

    beginTest("S13: a step's fade_in / fade_out set the run's ramps; the "
              "anti-pop micro-fade is the floor");
    {
      Sequence s;
      s.steps.push_back({kLen, "a"});
      Sequence::Step b;
      b.len = 4 * kLen;
      b.name = "b";
      b.fade_in = kLen;
      b.fade_out = 2 * kLen;
      s.steps.push_back(b);
      s.finalize();
      // b alone: the run is [kLen, 5kLen). Step a has no musical fade:
      // the 10 ms anti-pop still applies.
      const uint64_t m = 0b10ull;
      expectGains(s, kFade, {
          {m, kLen + kLen / 2, 0.5f, 1e-6f, "mid fade-in (1Q ramp)"},
          {m, 2 * kLen, 1.0f, 1e-6f, "fade-in complete after 1Q"},
          {m, 3 * kLen, 1.0f, 1e-6f, "interior"},
          {m, 4 * kLen, 0.5f, 1e-6f,
           "mid fade-out (2Q ramp, 1Q before the end)"},
          {m, 5 * kLen - 1, 0.0f, 1e-3f, "closed at the run's end"},
          {0b01ull, kFade / 2, 0.5f, 2e-3f,
           "anti-pop floor on an unfaded step"},
      });
      // Corners for THIS mask: the ramp ends are corners; a foreign
      // mask sees only the visit boundary.
      expectEquals(s.cornerDistance(kLen, kFade, m), (int64_t)kLen,
                   "next corner from the run start = end of the fade-in");
      expectEquals(s.cornerDistance(2 * kLen, kFade, m), (int64_t)kLen,
                   "then the start of the fade-out (3Q)");
      expectEquals(s.cornerDistance(kLen, kFade, 0b01ull), (int64_t)(4 * kLen),
                   "a mask off here sees only the visit boundary");
    }

    beginTest("S13: fades longer than the run shrink proportionally and meet");
    {
      Sequence s;
      s.steps.push_back({kLen, "a"});
      Sequence::Step b;
      b.len = kLen;
      b.fade_in = 3 * kLen;
      b.fade_out = kLen;
      s.steps.push_back(b);
      s.finalize();
      const uint64_t m = 0b10ull;  // run = [kLen, 2kLen): 3:1 → 3/4Q, 1/4Q
      const int64_t start = kLen;
      expectGains(s, kFade, {
          {m, start + 3 * kLen / 4, 1.0f, 2e-3f,
           "the ramps meet at 3/4 of the run"},
          {m, start + 3 * kLen / 8, 0.5f, 2e-3f,
           "mid fade-in of the shrunk ramp"},
          {m, 2 * kLen - kLen / 8, 0.5f, 2e-3f,
           "mid fade-out of the shrunk ramp"},
      });
      expectEquals(s.cornerDistance(start, kFade, m), (int64_t)(3 * kLen / 4),
                   "the meeting point is the one corner");
    }

    beginTest("S13: render purity with a musical fade (block-split "
              "independent), and the ramp replaces the 10 ms one");
    {
      StackNode root("island");
      root.addChild(makeDcClip("b", 0.4f));
      delete root.exchangeSequence(
          fadeInSeq(root.ownedChildren()[0]->getUuid()));

      const int n = kLen;  // from 100 before the seam through the ramp
      const int64_t t0 = (int64_t)kLen - 100;
      auto big = renderAt(root, t0, n);
      expectWithinAbsoluteError(big[0], 0.0f, 1e-5f, "closed before entry");
      expectWithinAbsoluteError(big[(size_t)(100 + kLen / 4)], 0.2f, 3e-3f,
                                "a quarter Q in: half amplitude (2205-sample "
                                "ramp, not 441)");
      expectWithinAbsoluteError(big[(size_t)(100 + kLen / 2 + 50)], 0.4f,
                                3e-3f, "full after half a Q");
      // The envelope is exact at every corner; within a ramp the child
      // applies a float32 per-sample increment, so a 2205-sample ramp
      // rendered as one block differs from 97-sample pieces by float
      // noise only (observed ≤ 4e-6, well under one LSB of 16-bit).
      expectSplitIndependent(root, t0, n, big, 2e-5f);
    }

    beginTest("S13: a musical fade over a windowed group is one continuous "
              "ramp (block-split independent)");
    {
      // The gated child's own window wraps every 1000 samples, so the
      // half-Q fade-in crosses two of its seams.
      StackNode root("island");
      root.addChild(makeWindowedGroup("g", 0.4f, 1000));
      delete root.exchangeSequence(
          fadeInSeq(root.ownedChildren()[0]->getUuid()));

      const int n = kLen;
      const int64_t t0 = (int64_t)kLen - 100;
      const int ramp = kLen / 2;
      auto big = renderAt(root, t0, n);
      expectWithinAbsoluteError(big[0], 0.0f, 1e-5f, "closed before entry");
      for (int k = 0; k < ramp; k += 105) {
        expectWithinAbsoluteError(big[(size_t)(100 + k)],
                                  0.4f * (float)k / (float)ramp, 3e-3f,
                                  "the ramp runs straight through the seams");
      }
      float max_jump = 0.0f;
      for (int i = 1; i < n; ++i) {
        max_jump = std::max(max_jump,
                            std::abs(big[(size_t)i] - big[(size_t)(i - 1)]));
      }
      expect(max_jump < 0.4f / (float)ramp + 1e-4f,
             "no step at the group's seams");
      expectSplitIndependent(root, t0, n, big, 2e-5f);
    }

    beginTest("S13: fades persist - metadata, session (QTime), template "
              "(scaled), and they retime with Q");
    {
      // The verb + metadata.
      Island is;
      const juce::var payload = seqPayload({{2000}, {2000}});
      const juce::Array<juce::var>& authored =
          *payload.getDynamicObject()->getProperty("steps").getArray();
      auto* first = authored[0].getDynamicObject();
      first->setProperty("fadeIn", 500.0);
      first->setProperty("fadeOut", -7.0);  // clamps to 0 (absent)
      authored[1].getDynamicObject()->setProperty("fadeOut", 1000.0);
      is.engine.setSequence(is.rootId(), payload);
      const juce::var st = seqOf(is.state());
      const juce::var s0 = st.getProperty("steps", {})[0];
      const juce::var s1v = st.getProperty("steps", {})[1];
      expectEquals((int)(double)s0.getProperty("fadeIn", 0.0), 500, "fadeIn published");
      expect(!s0.hasProperty("fadeOut"), "a clamped-to-0 fade is absent");
      expectEquals((int)(double)s1v.getProperty("fadeOut", 0.0), 1000,
                   "fadeOut published");

      // Session round trip on a group (QTime), and a template rebuilt
      // at another Q (fades are Q counts).
      StackNode outer("island");
      auto group = std::make_unique<StackNode>("song");
      auto c = makeDcClip("b", 0.2f);
      group->addChild(std::move(c));
      auto* gs = new Sequence();
      gs->steps.push_back({kLen, "a"});
      Sequence::Step two;
      two.len = 2 * kLen;
      two.fade_in = kLen / 2;
      two.fade_out = kLen;
      gs->steps.push_back(two);
      gs->finalize();
      delete group->exchangeSequence(gs);
      StackNode* g = group.get();
      outer.addChild(std::move(group));
      outer.setQuantum(kLen, 0);
      const auto back = roundTrip(outer, "seq_fade_io");
      const Sequence* s = firstGroupSequence(back);
      expect(s != nullptr, "sequence back");
      if (s != nullptr) {
        expectEquals(s->steps[1].fade_in, (int64_t)(kLen / 2), "fade_in back");
        expectEquals(s->steps[1].fade_out, (int64_t)kLen, "fade_out back");
        expectEquals(s->steps[0].fade_in, (int64_t)0, "absent = 0");
      }
      const juce::var tpl = track_templates::capture(*g, kLen);
      auto rebuilt = track_templates::build(tpl, kSr, /*q_samples=*/2 * kLen);
      auto* rg = dynamic_cast<StackNode*>(rebuilt.get());
      const Sequence* rs = rg ? rg->sequencePtr() : nullptr;
      expect(rs != nullptr, "template sequence rebuilt");
      if (rs != nullptr) {
        expectEquals(rs->steps[1].fade_in, (int64_t)kLen,
                     "a half-Q fade at 2xQ is a whole old Q");
        expectEquals(rs->steps[1].fade_out, (int64_t)(2 * kLen),
                     "fade_out scaled with Q");
      }
    }
  }

  // === SUCCESSOR GRAPHS + THE SEED (docs/sequencer.md §6, §14; S12
  // root-only radio) — the PROGRAM is the timeline. ===
  void testSuccessors() {
    // The programs themselves (visits, total, radio) are the golden
    // sequence_program_cases; these pin what hangs off a program.
    beginTest("S12: in a deterministic jump graph an unreachable step "
              "never sounds");
    {
      // 0 -> 2 -> 0: step 1 is orphaned.
      Sequence s;
      s.steps.push_back(stepTo(kLen, "a", 2));
      s.steps.push_back({kLen, "b"});
      s.steps.push_back(stepTo(kLen, "c", 0));
      s.finalize();
      expect(!s.reachableStep(1), "step 1 is unreachable");
      expectEquals(s.first_visit[1], -1);
      expectEquals(s.first_visit[2], 1);
      expectEquals(s.stepAt(kLen + 1), 2, "position lookup runs on visits");
      // A mask off only on the orphan is effectively all-on; a mask on
      // only the orphan is silence.
      expectGains(s, kFade, {
          {0b101ull, 10, 1.0f, 1e-6f, "orphan gate is irrelevant: constant 1"},
          {0b010ull, 10, 0.0f, 1e-6f, "only the orphan on: silence"},
      });
      // Default successors are the plain loop.
      Sequence plain;
      plain.steps.push_back({kLen, "a"});
      plain.steps.push_back({kLen, "b"});
      plain.finalize();
      expect(plain.isPlainLoop() && !plain.radio, "default successors = the loop");
    }

    beginTest("S12: linearize demotes a radio to the plain loop");
    {
      // intro | a | b -> a: no deterministic return to step 0.
      Sequence s;
      s.steps.push_back({kLen, "intro"});
      s.steps.push_back({kLen, "a"});
      s.steps.push_back(stepTo(kLen, "b", 1));
      s.finalize();
      expect(s.radio, "no deterministic return to step 0 = period-less");
      s.linearize();
      expect(!s.radio && s.isPlainLoop(), "linearize demotes it to the loop");
    }

    beginTest("the seed is data: one seed, one program; weights bias the draw");
    {
      Sequence s;
      Sequence::Step a;
      a.len = kLen;
      a.next = {{1, 1}, {2, 3}};
      s.steps.push_back(a);
      s.steps.push_back(stepTo(kLen, "one", 0));
      s.steps.push_back(stepTo(kLen, "two", 0));
      s.seed = 0x1234;
      s.finalize();
      expect(s.radio, "a branch with chance is a radio");
      Sequence again = s;
      again.finalize();
      bool same = again.visit_count == s.visit_count;
      for (int k = 0; same && k < s.visit_count; ++k) {
        same = again.visit_step[k] == s.visit_step[k];
      }
      expect(same, "the same (sequence, seed) unrolls identically");
      Sequence other = s;
      other.seed = 0x1235;
      other.finalize();
      bool differs = false;
      for (int k = 0; k < s.visit_count && !differs; ++k) {
        differs = other.visit_step[k] != s.visit_step[k];
      }
      expect(differs, "another seed is another performance");
      int ones = 0, twos = 0;
      for (int k = 0; k < s.visit_count; ++k) {
        if (s.visit_step[k] == 1) ++ones;
        if (s.visit_step[k] == 2) ++twos;
      }
      expect(twos > ones, "3:1 weighting lands on 'two' more often");
    }

    beginTest("CUE on a revisited step re-bases EVERY entrance; the audition "
              "loops the first visit; an orphan cannot be auditioned");
    {
      // intro | A (cued) | B -> A ...: A is visited at k = 1, 3, 5, ...
      auto* cs = new Sequence();
      cs->steps.push_back({kLen, "intro"});
      cs->steps.push_back({kLen, "A", true});
      cs->steps.push_back(stepTo(kLen, "B", 1));
      cs->finalize();
      expectEquals(cs->visit_step[3], 1, "A again at visit 3");
      expectEquals(cs->songToContent(cs->bounds[1] + 100), (int64_t)100,
                   "first visit re-bases to the song top");
      expectEquals(cs->songToContent(cs->bounds[3] + 100), (int64_t)100,
                   "the revisit re-bases too");
      expectEquals(cs->songToContent(cs->bounds[2] + 100),
                   cs->bounds[2] + 100, "a plain visit is identity");
      expect(cs->cutBetween(2, 3), "the seam into the revisit is a cut");
      StackNode stack("island");
      stack.addChild(makeRampClip("r"));
      delete stack.exchangeSequence(cs);
      stack.setAuditionStep(1);
      const timing::TimeMap m = stack.auditionMap();
      expect(m.active(), "audition of a revisited step has a span");
      expectEquals(m.segs[0].start, cs->bounds[1], "...its FIRST visit");
      expectEquals(m.segs[0].end, cs->bounds[2]);
      // Orphan: no span.
      auto* os = new Sequence();
      os->steps.push_back(stepTo(kLen, "a", 2));
      os->steps.push_back({kLen, "orphan"});
      os->steps.push_back(stepTo(kLen, "c", 0));
      os->finalize();
      delete stack.exchangeSequence(os);
      stack.setAuditionStep(1);
      expect(!stack.auditionMap().active(), "an orphan has no audition span");
      stack.setAuditionStep(-1);
    }

    beginTest("engine: a radio is ROOT-ONLY; the root publishes program, "
              "seed and radio; re-roll is one undoable edit");
    {
      Island is;
      const juce::String root = is.rootId();
      const juce::String group = is.createStack();
      expect(group.isNotEmpty(), "nested stack created");
      auto seedOf = [&] {
        return (int)(double)seqOf(is.state()).getProperty("seed", -1.0);
      };

      // Nested: the branch is refused, nothing recorded.
      is.engine.setSequence(group, routedPayload({{1, 2}, {0}, {0}}, 5));
      expect(!seqOf(is.node(group)).isObject(),
             "a nested radio is refused (S12)");
      // Nested: a deterministic graph that returns to 0 is fine.
      is.engine.setSequence(group, routedPayload({{2}, {}, {0}}, 0));
      const juce::var g = seqOf(is.node(group));
      expect(g.isObject(), "a periodic jump graph is legal nested");
      expect(!(bool)g.getProperty("radio", true), "...and is not a radio");
      expectEquals(g.getProperty("program", juce::var()).getArray()->size(),
                   2, "program published: [0, 2]");

      // Root: the branch is accepted and published.
      is.engine.setSequence(root, routedPayload({{1, 2}, {0}, {0}}, 5));
      const juce::var r = seqOf(is.state());
      expect(r.isObject(), "the root takes a radio");
      expect((bool)r.getProperty("radio", false), "radio flag published");
      expectEquals(seedOf(), 5, "seed echoes");
      expectEquals(r.getProperty("program", juce::var()).getArray()->size(),
                   Sequence::kMaxVisits, "the program fills the horizon");
      expect(r.getProperty("steps", juce::var())[0]
                 .getProperty("next", juce::var())
                 .isArray(),
             "successors published per step");
      // Re-roll = the same payload with another seed: one edit.
      is.engine.setSequence(root, routedPayload({{1, 2}, {0}, {0}}, 6));
      expectEquals(seedOf(), 6, "re-rolled");
      is.engine.undo();
      expectEquals(seedOf(), 5, "undo restores the previous seed");
      // A successor out of range is malformed: refused.
      is.engine.setSequence(root, routedPayload({{7}, {0}, {0}}, 5));
      expectEquals(seedOf(), 5, "out-of-range successor refused; unchanged");
      // Auditioning an orphan is refused.
      is.engine.setSequence(root, routedPayload({{2}, {}, {0}}, 0));
      is.engine.auditionStep(root, 1);
      expectEquals(auditionOf(is, root), -1, "orphan audition refused");
      is.engine.auditionStep(root, 2);
      expectEquals(auditionOf(is, root), 2, "a reachable step auditions");
      is.engine.auditionStep(root, -1);
    }

    beginTest("session: successors + seed round-trip on a group AND on the "
              "root; a nested radio in a bundle is demoted");
    {
      juce::File dir = test_utils::freshTempDir("seq_successors_root");
      {
        // The root's own song, with a branch: bundle-level. A committed
        // take establishes Q (the grid's exchange rate).
        Island is;
        is.record(kQ);
        expect(is.Q() > 0, "Q established");
        is.engine.setSequence(is.rootId(),
                              routedPayload({{1, 2}, {0}, {0}}, 99));
        expect(is.engine.saveSession(dir.getFullPathName()), "save ok");
      }
      {
        Island is;
        expect(is.engine.loadSession(dir.getFullPathName()), "load ok");
        const juce::var r = seqOf(is.state());
        expect(r.isObject(), "the root's song came back");
        expect((bool)r.getProperty("radio", false), "...still a radio");
        expectEquals((int)(double)r.getProperty("seed", -1.0), 99,
                     "...with its seed (the run is reproducible)");
      }

      // A nested stack: successors and the seed persist; a hand-written
      // radio in the block is demoted to the loop on load.
      StackNode outer("island");
      auto group = std::make_unique<StackNode>("song");
      auto c = makeDcClip("b", 0.2f);
      group->addChild(std::move(c));
      auto* gs = new Sequence();
      gs->steps.push_back(stepTo(kLen, "a", 2));
      gs->steps.push_back({kLen, "orphan"});
      gs->steps.push_back(stepTo(kLen, "c", 0));
      gs->seed = 7;
      gs->finalize();
      delete group->exchangeSequence(gs);
      outer.addChild(std::move(group));
      outer.setQuantum(kLen, 0);
      const auto back = roundTrip(outer, "seq_successors_group", &dir);
      const Sequence* s = firstGroupSequence(back);
      expect(s != nullptr, "sequence came back");
      if (s != nullptr) {
        expectEquals((int)s->steps[0].next.size(), 1, "successor back");
        expectEquals(s->steps[0].next[0].to, 2);
        expectEquals((int)s->seed, 7, "seed back");
        expectEquals(s->visit_count, 2, "program rebuilt: [0, 2]");
      }
      // Hand-edit the bundle: make the group a radio (2 -> 1).
      const auto jf = dir.getChildFile("session.json");
      auto json = juce::JSON::parse(jf.loadFileAsString());
      auto* nodes = json.getProperty("root", juce::var())
                        .getProperty("nodes", juce::var())
                        .getArray();
      auto seqVar = (*nodes)[0].getProperty("sequence", juce::var());
      auto* steps = seqVar.getProperty("steps", juce::var()).getArray();
      {
        auto* n = new juce::DynamicObject();
        n->setProperty("to", 1);
        n->setProperty("w", 1);
        juce::Array<juce::var> next;
        next.add(juce::var(n));
        (*steps)[2].getDynamicObject()->setProperty("next", next);
      }
      jf.replaceWithText(juce::JSON::toString(json));
      const auto demoted = session_io::load(dir, kSr);
      const Sequence* ds = firstGroupSequence(demoted);
      expect(ds != nullptr && !ds->radio && ds->isPlainLoop(),
             "a nested radio is demoted to the loop on load (S12)");
    }

    beginTest("S14: a template carries successors + seed; a radio builds "
              "linear (templates are nested)");
    {
      StackNode group("song");
      auto c1 = makeDcClip("kick", 0.1f);
      group.addChild(std::move(c1));
      auto* gs = new Sequence();
      Sequence::Step a;
      a.len = kLen;
      a.next = {{1, 1}, {2, 2}};
      gs->steps.push_back(a);
      gs->steps.push_back(stepTo(kLen, "one", 0));
      gs->steps.push_back(stepTo(kLen, "two", 0));
      gs->seed = 11;
      gs->finalize();
      delete group.exchangeSequence(gs);
      const juce::var tpl = track_templates::capture(group, kLen);
      const juce::var so = tpl.getProperty("sequence", juce::var());
      expect(so.isObject(), "capture carries the sequence");
      expectEquals((int)(double)so.getProperty("seed", -1.0), 11, "seed captured");
      expect(so.getProperty("steps", juce::var())[0]
                 .getProperty("next", juce::var())
                 .isArray(),
             "successors captured");
      auto rebuilt = track_templates::build(tpl, kSr, kLen);
      auto* g = dynamic_cast<StackNode*>(rebuilt.get());
      const Sequence* s = g ? g->sequencePtr() : nullptr;
      expect(s != nullptr && !s->radio, "a template's radio builds linear");
      if (s != nullptr) {
        expectEquals((int)s->seed, 11, "the seed still rides along");
        expect(s->isPlainLoop(), "...as the plain loop");
      }
    }
  }

  // === CUE STEPS (docs/sequencer.md ss3 - the Q6 serial primitive;
  // S11, S20-S22) ===
  void testCueSteps() {
    beginTest("S20: a cue seam is a hard cut - the gate dips through zero");
    {
      // Two steps, BOTH gated on; step 2 cued. The envelope must dip
      // at every cued edge (the clock jumps there), including the
      // song-wrap edge out of the cued last step.
      const std::unique_ptr<Sequence> s(makeCuedSeq());
      const uint64_t m = 0b11ull;
      expectGains(*s, kFade, {
          {m, kLen, 0.0f, 1e-6f, "entering the cued step: gain 0 at the seam"},
          {m, kLen - kFade, 1.0f, 1e-6f, "one fade before the seam: full"},
          {m, kLen + kFade, 1.0f, 1e-6f,
           "one fade after the seam: full again"},
          {m, kLen - kFade / 2, 0.5f, 2e-3f, "mid-ramp out"},
          {m, kLen + kFade / 2, 0.5f, 2e-3f, "mid-ramp back in"},
          {m, 0, 0.0f, 1e-6f, "the wrap OUT of the cued step cuts too"},
          {m, kFade, 1.0f, 1e-6f, "recovered one fade into step 1"},
      });
      // Control: the same schedule with NO cue never dips (all-on).
      const std::unique_ptr<Sequence> p(makeSeq(kLen, 2 * kLen, {}));
      expectGains(*p, kFade, {
          {m, kLen, 1.0f, 1e-6f, "no cue: an all-on mask is constant 1"},
          {m, 0, 1.0f, 1e-6f, "no cue: no dip at the wrap either"},
      });
    }

    beginTest("CUE: a cued span renders the same whatever the block split");
    {
      // Inside the cued step the child plays the content it plays at
      // the song top (scenario S18 pins which); the re-base is
      // schedule-derived, so odd chunks render the same span (I6).
      StackNode cued("island");
      cued.addChild(makeRampClip("r"));
      delete cued.exchangeSequence(makeCuedSeq());
      const int64_t t0 = (int64_t)kLen + 3 * kFade;  // clear of the seam dip
      const auto whole = renderAt(cued, t0, 64);
      expect(std::abs(whole[0]) > 1e-3f, "probe content is non-trivial");
      expectSplitIndependent(cued, t0, 64, whole, 1e-6f, /*chunk=*/23,
                             /*stride=*/16);
    }

    beginTest("CUE: gates stay on the SONG timeline under a re-base");
    {
      // A child gated ON only in step 1 (not cued) must be SILENT
      // during the cued step 2 - even though the re-based child clock
      // lands in step 1's span: the gate is looked up at the song
      // position, never at the re-based one.
      StackNode root("island");
      root.addChild(makeDcClip("b", 0.4f));
      const juce::String bId = root.ownedChildren()[0]->getUuid();
      delete root.exchangeSequence(makeCuedSeq({{bId, 0b01ull}}));
      auto out = renderAt(root, (int64_t)kLen + 3 * kFade, 64);
      for (int i = 0; i < 64; i += 16) {
        expectWithinAbsoluteError(out[(size_t)i], 0.0f, 1e-5f,
                                  "step-1-only child silent in cued step 2");
      }
    }

    beginTest("CUE: audition of a cued step presents the re-based frame");
    {
      StackNode root("island");
      root.addChild(makeRampClip("r"));
      delete root.exchangeSequence(makeCuedSeq());
      root.setAuditionStep(1);

      StackNode plain("island2");
      plain.addChild(makeRampClip("r2"));

      // The audition loops the step span; the cue re-bases it to the
      // song top: heard rel folds on the step, child hears fold(rel).
      const int64_t t = 2 * (int64_t)(2 * kLen) + 700;  // fold = 700
      auto got = renderAt(root, t, 64);
      auto want = renderAt(plain, 700, 64);
      for (int i = 0; i < 64; i += 16) {
        expectWithinAbsoluteError(got[(size_t)i], want[(size_t)i], 1e-5f,
                                  "cued audition = song-top content");
      }
      root.setAuditionStep(-1);
    }

    beginTest("S21: arm inside a cued step auto-targets it; the take "
              "lands at the song top, auto-gated");
    {
      Island is;
      const juce::String root = is.rootId();
      is.record(kQ);
      const int64_t Q = is.Q();
      expectEquals(Q, kQ, "Q established");
      // The root's song position: its song is anchored at the island zero.
      auto songRel = [&] { return posmod(is.islandPos(), 4 * Q); };
      auto driveSongInto = [&](int64_t lo, int64_t hi) {
        is.waitFor([&] { return songRel() > lo && songRel() < hi; });
      };

      // The song: verse 2Q | chorus 2Q (CUED) = 4Q.
      is.engine.setSequence(root, seqPayload({{2 * Q}, {2 * Q, true}}));
      {
        const juce::var steps = seqOf(is.state()).getProperty("steps", {});
        expect(!(bool)steps[0].getProperty("cue", true),
               "step 1 publishes cue=false");
        expect((bool)steps[1].getProperty("cue", false),
               "step 2 publishes cue=true");
      }

      // Drive the playhead INTO the chorus, then arm with no audition.
      driveSongInto(2 * Q + Q / 4, 3 * Q + Q / 2);
      expect(songRel() > 2 * Q, "playhead inside the cued chorus");
      const juce::String c = is.createClip();
      is.engine.startRecordingInNode(c);
      expectEquals(auditionOf(is, root), 1,
                   "S21: the arm auto-targeted the cued step");
      is.drive(8 * Q);
      is.settle();
      expect(!is.bprop(c, "isRecording"), "C committed");
      expectEquals(is.dur(c), 2 * Q, "S18 through S21: a step-sized part");
      const int64_t rel = posmod(is.origin(c) - is.zero(), 4 * Q);
      expect(rel < 2 * Q,
             "the take lands at the SONG TOP - where cue playback "
             "reads it (got " +
                 juce::String(rel / (double)Q) + "Q)");
      expectEquals(rel % Q, (int64_t)0, "on the Q grid");
      // S19 auto-gate composed: C sounds only in the chorus.
      {
        const juce::var bits =
            seqOf(is.state()).getProperty("gates", {}).getProperty(c, {});
        expect(bits.isArray(), "auto-gate row exists for the take");
        if (bits.isArray()) {
          expect(!(bool)bits[0], "gated OFF in the verse");
          expect((bool)bits[1], "gated ON in the chorus");
        }
      }

      // Esc, then arm in the PLAIN verse: no auto-target (Mode 1).
      is.engine.auditionStep(root, -1);
      driveSongInto(Q / 4, Q);
      expect(songRel() < 2 * Q, "playhead inside the plain verse");
      const juce::String d = is.createClip();
      is.engine.startRecordingInNode(d);
      expectEquals(auditionOf(is, root), -1,
                   "a plain step arms as Mode 1 - no auto-target");
      is.engine.stopRecordingInNode(d);
      is.settle();

      // An AUTHORED window over a sequence with cued steps refuses the
      // arm (multi-step composition is out of scope).
      is.window(root, 0, 2 * Q);
      const juce::String e = is.createClip();
      is.engine.startRecordingInNode(e);
      expect(!is.bprop(e, "isRecording"),
             "refused: authored window over cued steps");
      expect(!is.bprop(e, "isPendingStart"),
             "not pending either - the whole arm was refused");
    }

    // The S21 lookup reads the SONG POSITION the sequenced stack itself
    // reads — from its own frame origin (Q18: a group's origin), not the
    // raw clock from the island zero. A group whose origin sits 2Q past
    // the zero has its verse where the island frame has its chorus.
    beginTest("S21 at depth: a GROUP song's cued step is looked up from the "
              "group's origin, not the island zero");
    {
      Island is;
      is.record(kQ);
      const int64_t Q = is.Q();
      expectEquals(Q, kQ, "Q established");
      // Drive until the island phase (t − zero), folded on the 4Q song
      // grid, is inside (lo, hi).
      auto drivePhaseInto = [&](int64_t lo, int64_t hi) {
        is.waitFor([&] {
          const int64_t phase = posmod(is.islandPos(), 4 * Q);
          return phase > lo && phase < hi;
        });
      };

      // A group whose first take lands at island phase 2Q: arm inside
      // [1Q, 2Q) so the take starts at the 2Q boundary. One Q long, so
      // the cycle does not grow.
      const juce::String g = is.createStack();
      const juce::String m = is.createClip(g);
      drivePhaseInto(Q + Q / 4, Q + (3 * Q) / 4);
      is.recordInto(m, Q);
      expectEquals(is.dur(m), Q, "the group's take is 1Q");
      expectEquals(posmod(is.origin(g) - is.zero(), 4 * Q), 2 * Q,
                   "the group's origin sits 2Q past the zero (Q18 anchoring)");

      // The GROUP's song: verse 2Q | chorus 2Q (CUED) = 4Q, measured
      // from the group's origin.
      is.engine.setSequence(g, seqPayload({{2 * Q}, {2 * Q, true}}));
      expectEquals(
          seqOf(is.node(g)).getProperty("steps", {}).getArray()->size(), 2,
          "the group carries the song");

      // Island phase [2Q + Q/4, 2Q + 3Q/4): the ISLAND frame's chorus,
      // the GROUP frame's verse (phase − 2Q). An arm in the group is
      // Mode 1 — no auto-target.
      drivePhaseInto(2 * Q + Q / 4, 2 * Q + (3 * Q) / 4);
      const juce::String n = is.createClip(g);
      is.engine.startRecordingInNode(n);
      expectEquals(auditionOf(is, g), -1,
                   "island-phase chorus is the group's VERSE: no auto-target");
      is.engine.stopRecordingInNode(n);  // cancel before capture
      is.settle();
      expectEquals(is.dur(n), (int64_t)0, "nothing recorded");

      // Island phase [Q/4, 3Q/4): the island frame's verse, the group's
      // CHORUS (phase + 2Q) — the arm auto-targets the cued step.
      drivePhaseInto(Q / 4, (3 * Q) / 4);
      is.engine.startRecordingInNode(n);
      expectEquals(auditionOf(is, g), 1,
                   "island-phase verse is the group's CHORUS: auto-targeted");
      is.engine.stopRecordingInNode(n);
    }

    beginTest("CUE: the flag survives session save/load and templates");
    {
      StackNode outer("island");
      auto group = std::make_unique<StackNode>("song");
      group->addChild(makeDcClip("b", 0.2f));
      delete group->exchangeSequence(makeCuedSeq());
      StackNode* g = group.get();
      outer.addChild(std::move(group));
      outer.setQuantum(kLen, 0);

      const auto back = roundTrip(outer, "seq_cue_io");
      expect(back.ok, "saved and loaded");
      const Sequence* sb = firstGroupSequence(back);
      expect(sb != nullptr, "sequence came back");
      if (sb != nullptr) {
        expect(!sb->steps[0].cue, "step 1 cue=false back");
        expect(sb->steps[1].cue, "step 2 cue=true back");
        expect(sb->any_cue, "finalize recomputed any_cue");
      }

      const juce::var tpl = track_templates::capture(*g, kLen);
      auto rebuilt = track_templates::build(tpl, kSr, /*q_samples=*/2205);
      auto* rg = dynamic_cast<StackNode*>(rebuilt.get());
      expect(rg != nullptr && rg->sequencePtr() != nullptr,
             "template rebuilt with a sequence");
      if (rg != nullptr && rg->sequencePtr() != nullptr) {
        expect(!rg->sequencePtr()->steps[0].cue, "template step 1 plain");
        expect(rg->sequencePtr()->steps[1].cue, "template step 2 cued");
      }
    }

    beginTest("CUE: an ORPHAN cued step (unreachable) is not a cue and "
              "never hangs the envelope walk");
    {
      // Cue step 2, then route step 1 back to step 0: the program is
      // 0 -> 1 -> 0 and step 2 is never visited. `any_cue` is a fact of
      // the VISITS, not of the step list: were it set here, every fast
      // path would be off with no cued visit to stop at, and under the
      // all-on mask (every row-less child) cornerDistance/gainAt would
      // walk forever on the audio thread.
      Sequence s;
      s.steps.push_back({1000, "a"});
      s.steps.push_back({1000, "b"});
      s.steps.push_back({1000, "c", true});
      s.steps[1].next.push_back({0, 1});
      s.finalize();
      expectEquals(s.visit_count, 2, "two visits: 0 -> 1 -> (0)");
      expectEquals(s.total, (int64_t)2000, "the orphan is not in the program");
      expect(!s.any_cue, "any_cue means 'some VISIT is cued': false");
      expect((s.reachable & (1ull << 2)) == 0, "step 2 unreachable");

      const int64_t F = 100;
      // All-on mask over every reachable visit: constant gain, and the
      // corner distance is the next visit boundary — both must return.
      expectWithinAbsoluteError(s.gainAt(~0ull, 500, F), 1.0f, 1e-6f,
                                "all-on: constant 1");
      expectEquals(s.cornerDistance(250, F, ~0ull), (int64_t)750,
                   "all-on: next visit boundary");
      // A mask that is on across every reachable visit but off on the
      // orphan is the same program to the walk.
      expectWithinAbsoluteError(s.gainAt(0b011, 1500, F), 1.0f, 1e-6f,
                                "reachable-on: constant 1");
      expectEquals(s.cornerDistance(1500, F, 0b011), (int64_t)500,
                   "reachable-on: next visit boundary");
      // The re-base fast path keys off the same flag: an orphan cue
      // leaves the song map the identity.
      expectEquals(s.songToContent(1500), (int64_t)1500,
                   "no cued visit: identity cue map");

      // A REACHABLE cue still cuts (S20): re-route so step 2 is visited.
      s.steps[1].next.clear();
      s.finalize();
      expect(s.any_cue, "reachable cue sets the flag");
      expectEquals(s.visit_count, 3, "three visits");
      // With all on, the cued visit's edges are hard cuts: gain dips
      // at the seam into step 2.
      expectWithinAbsoluteError(s.gainAt(~0ull, 2000 - 50, F), 0.5f, 1e-6f,
                                "fade-out into the cued visit");
    }
  }
};

static SequencerTests sequencerTests;

}  // namespace celestrian
