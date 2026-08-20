/**
 * THE SEQUENCER (docs/sequencer.md — the fractal per-stack Sequence).
 * Pins the ruled canon, each test named for its ruling:
 *
 *   PERIOD LAW (S9/§2): an active sequence sets the stack's effective
 *     period to the sequence length; intrinsic stays LCM-of-children;
 *     the snapshot twin agrees; bypass restores the jam.
 *   CONCATENATION (S10 correction): steps SUM, they never LCM — an
 *     11Q step beside a 12Q step is a 23Q song.
 *   GATES (S1, mute-shaped + I5 fractal): a gated-off child is silent,
 *     a gated-on child sounds AT ITS OWN PHASE (entrances land in
 *     phase — the I1 guarantee); a gate on a group covers its subtree;
 *     absent uuid inherits ON.
 *   SMOOTHNESS LAW (S7): gate edges are ~10 ms linear ramps, exact
 *     across arbitrary block splits (the envelope is schedule-derived,
 *     not integrator state); fx tails RING OUT through a closed gate —
 *     including MUTE, which now rides the same pre-fx gate.
 *   HEARD FRAME (§4): a take armed under an active sequence snapshots
 *     the song as its heard cycle (record-over-the-song).
 *   VERBS: setSequence/toggleSequence are undoable, refuse mid-take,
 *     publish in metadata, and round-trip through session save/load.
 *
 * Twin: ui/js/tests/sequence.test.mjs (mock + view-model parity).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <memory>
#include <vector>

#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/sequence.h"
#include "../src/session_io.h"
#include "../src/track_template.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

namespace {

constexpr double kSr = 44100.0;
constexpr int kLen = 4410;   // one committed take = 4410 samples (Q)
constexpr int kFade = 441;   // Sequence::fadeSamples(44100) = 10 ms

/** A committed clip carrying a constant-amplitude take, already
 * sounding (the solo/output-stage tests' idiom). */
std::unique_ptr<ClipNode> makeDcClip(const char* name, float amp,
                                     int len = kLen) {
  auto clip = std::make_unique<ClipNode>(name, kSr);
  std::vector<float> in((size_t)len, amp);
  const float* const ins[] = {in.data()};
  ProcessContext rec;
  rec.num_samples = len;
  rec.is_recording = true;
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec);
  clip->stopRecording();
  clip->startPlayback();
  return clip;
}

/** A committed clip whose content is an identifiable per-sample ramp
 * (content[i] = i / len) — the I1 phase probe. */
std::unique_ptr<ClipNode> makeRampClip(const char* name, int len = kLen) {
  auto clip = std::make_unique<ClipNode>(name, kSr);
  std::vector<float> in((size_t)len);
  for (int i = 0; i < len; ++i) in[(size_t)i] = (float)i / (float)len;
  const float* const ins[] = {in.data()};
  ProcessContext rec;
  rec.num_samples = len;
  rec.is_recording = true;
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec);
  clip->stopRecording();
  clip->startPlayback();
  return clip;
}

/** Build a two-step sequence: step "one" of `l1`, step "two" of `l2`,
 * with explicit gate rows. */
const Sequence* makeSeq(int64_t l1, int64_t l2,
                        std::vector<Sequence::GateRow> gates) {
  auto* s = new Sequence();
  s->steps.push_back({l1, "one"});
  s->steps.push_back({l2, "two"});
  s->gates = std::move(gates);
  s->finalize();
  return s;
}

}  // namespace

class SequencerTests : public juce::UnitTest {
 public:
  SequencerTests() : juce::UnitTest("Sequencer (docs/sequencer.md)") {}

  void runTest() override {
    testEnvelopeMath();
    testPeriodLaw();
    testGates();
    testEntrancePhase();
    testSmoothness();
    testTailsRing();
    testHeardFrame();
    testEngineVerbs();
    testSaveLoad();
  }

 private:
  /** Process `root` at master_pos `t` for `n` samples through the
   * production path (whole-graph snapshot, control + render); returns
   * channel L. `warm` runs one extra settle block first (a fresh
   * commit renders silent for its own block; the mute/solo ramp seeds
   * on first render) — sequential drivers pass warm=false. */
  static std::vector<float> renderAt(StackNode& root, int64_t t, int n,
                                     bool warm = true) {
    std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));
    auto once = [&](int64_t at, int count) {
      std::vector<float> outL((size_t)count, 0.0f), outR((size_t)count, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = count;
      play.is_playing = true;
      play.master_pos = at;
      play.island_pos = at;
      play.snap = snap.get();
      play.self = 0;
      play.any_solo = snapAnySolo(*snap);
      root.process(nullptr, outs, 0, 2, play);
      return outL;
    };
    if (warm) once(t, n);
    return once(t, n);
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

      // Mask 0b011 (a+b on, c off): one run [0, 3000).
      const uint64_t m = 0b011;
      const int64_t F = 100;
      expectWithinAbsoluteError(s.gainAt(m, 50, F), 0.5f, 1e-6f,
                                "fade-in at run start");
      expectWithinAbsoluteError(s.gainAt(m, 1500, F), 1.0f, 1e-6f,
                                "interior = 1 (a+b merge into one run)");
      expectWithinAbsoluteError(s.gainAt(m, 2950, F), 0.5f, 1e-6f,
                                "fade-out into the off step");
      expectWithinAbsoluteError(s.gainAt(m, 3500, F), 0.0f, 1e-6f,
                                "off step = 0");
      // Wrap: mask 0b101 (c and a on) is ONE run across the loop seam.
      const uint64_t w = 0b101;
      expectWithinAbsoluteError(s.gainAt(w, 3999, F), 1.0f, 1e-6f,
                                "run wraps: end of c is mid-run");
      expectWithinAbsoluteError(s.gainAt(w, 0, F), 1.0f, 1e-6f,
                                "run wraps: start of a is mid-run");
      expectWithinAbsoluteError(s.gainAt(w, 950, F), 0.5f, 1e-6f,
                                "fade-out approaching b");
      // All-on mask: constant 1 (no run edges anywhere).
      expectWithinAbsoluteError(s.gainAt(~0ull, 0, F), 1.0f, 1e-6f,
                                "all-on = constant 1");
    }
  }

  void testPeriodLaw() {
    beginTest("PERIOD LAW: active sequence = the stack's effective period");
    {
      StackNode root("island");
      root.addChild(makeDcClip("a", 0.1f));
      root.addChild(makeDcClip("b", 0.4f));
      expectEquals(root.getIntrinsicDuration(), (int64_t)kLen,
                   "intrinsic = LCM of children");
      expectEquals(root.getEffectivePeriod(), (int64_t)kLen,
                   "no sequence: effective = intrinsic");

      delete root.exchangeSequence(makeSeq(kLen, 2 * kLen, {}));
      expectEquals(root.getEffectivePeriod(), (int64_t)(3 * kLen),
                   "active sequence: effective = seq total");
      expectEquals(root.getIntrinsicDuration(), (int64_t)kLen,
                   "intrinsic untouched by the sequence");
      std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));
      expectEquals(snapEffectivePeriod(*snap, 0), (int64_t)(3 * kLen),
                   "snapshot twin agrees (period law)");

      root.setSequenceBypassed(true);
      expectEquals(root.getEffectivePeriod(), (int64_t)kLen,
                   "bypassed: the jam comes back");
      root.setSequenceBypassed(false);
    }

    beginTest("CONCATENATION: 11Q + 12Q steps = a 23Q song, never LCM");
    {
      StackNode root("island");
      delete root.exchangeSequence(makeSeq(11 * 1000, 12 * 1000, {}));
      expectEquals(root.activeSequenceLen(), (int64_t)(23 * 1000),
                   "steps sum (the S10 correction)");
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

  void testEntrancePhase() {
    beginTest("I1: an entrance lands at the phase it always had");
    {
      // The gated render at t must equal the ungated render at t —
      // mute-shaped gates keep the clock; nothing relaunches.
      const int64_t t = (int64_t)kLen + 4590;  // step-2 interior
      StackNode gated("island");
      gated.addChild(makeRampClip("r"));
      const juce::String rId = gated.ownedChildren()[0]->getUuid();
      delete gated.exchangeSequence(makeSeq(kLen, 2 * kLen, {{rId, 0b10ull}}));

      StackNode plain("island2");
      plain.addChild(makeRampClip("r2"));

      auto got = renderAt(gated, t, 64);
      auto want = renderAt(plain, t, 64);
      for (int i = 0; i < 64; i += 16) {
        expectWithinAbsoluteError(got[(size_t)i], want[(size_t)i], 1e-5f,
                                  "gated-on phase == always-on phase");
      }
      expect(std::abs(want[0]) > 1e-3f, "probe content is non-trivial");
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

      // Purity across splits: the same span rendered in odd chunks is
      // byte-identical (the envelope is schedule-derived, I6).
      std::vector<float> chunks;
      int64_t t = t0;
      int left = n;
      while (left > 0) {
        const int c = std::min(left, 97);
        auto part = renderAt(root, t, c);
        chunks.insert(chunks.end(), part.begin(), part.begin() + c);
        t += c;
        left -= c;
      }
      for (int i = 0; i < n; i += 37) {
        expectWithinAbsoluteError(chunks[(size_t)i], big[(size_t)i], 1e-6f,
                                  "block splits do not change the output");
      }
    }
  }

  void testTailsRing() {
    beginTest("S7: fx tails ring through a closed gate (sequence)");
    {
      StackNode root("island");
      auto clip = makeDcClip("b", 0.5f);
      // Echo on the CLIP's own chain: 50 ms delay, wet 0.8, no feedback.
      // prepare() first — node-level tests bypass the engine's
      // device-start prepare, and an unprepared echo has no delay line.
      auto* echo = clip->fxChain()->slots()[2].get();
      echo->prepare(kSr);
      echo->enabled.store(true);
      expect(echo->setParam("time", 0.05), "echo time set");
      expect(echo->setParam("mix", 0.8), "echo mix set");
      expect(echo->setParam("feedback", 0.0), "echo feedback set");
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
      auto closed = renderAt(root, t, block, /*warm=*/false);
      float peak = 0.0f;
      for (float v : closed) peak = std::max(peak, std::abs(v));
      expect(peak > 0.05f,
             "the echo of the audible material still sounds after the gate "
             "closed (tails ring, never freeze)");
    }

    beginTest("S7: MUTE rides the same gate - tail rings, edge fades");
    {
      StackNode root("island");
      auto clip = makeDcClip("m", 0.5f);
      auto* echo = clip->fxChain()->slots()[2].get();
      echo->prepare(kSr);
      echo->enabled.store(true);
      expect(echo->setParam("time", 0.05));
      expect(echo->setParam("mix", 0.8));
      expect(echo->setParam("feedback", 0.0));
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
      auto after = renderAt(root, t, kFade, /*warm=*/false);
      float peak = 0.0f;
      for (float v : after) peak = std::max(peak, std::abs(v));
      expect(peak > 0.05f, "muted clip's echo tail rings out");
    }
  }

  void testHeardFrame() {
    beginTest("record over the song: the heard frame IS the sequence");
    {
      StackNode root("island");
      root.addChild(makeDcClip("a", 0.1f));
      root.setQuantum(kLen, 0);
      delete root.exchangeSequence(makeSeq(kLen, 2 * kLen, {}));
      root.takeArmed();
      expectEquals(root.activeTakeHeardCycle(), (int64_t)(3 * kLen),
                   "heard cycle at arm = lcm(Q, seq total)");
      expectEquals(root.activeTakeIntrinsicCycle(), (int64_t)kLen,
                   "intrinsic snapshot ignores the sequence");
      root.takeCancelled();
    }
  }

  void testEngineVerbs() {
    beginTest("setSequence: undoable, publishes, toggle round-trips");
    {
      AudioEngine engine;
      const juce::String rootId =
          engine.getGraphState().getProperty("id", "").toString();
      expect(rootId.isNotEmpty(), "root uuid published");

      auto* payload = new juce::DynamicObject();
      {
        juce::Array<juce::var> steps;
        auto* s1 = new juce::DynamicObject();
        s1->setProperty("name", "intro");
        s1->setProperty("len", 1000.0);
        steps.add(juce::var(s1));
        auto* s2 = new juce::DynamicObject();
        s2->setProperty("name", "full");
        s2->setProperty("len", 2000.0);
        steps.add(juce::var(s2));
        payload->setProperty("steps", steps);
        auto* gates = new juce::DynamicObject();
        juce::Array<juce::var> bits;
        bits.add(false);
        bits.add(true);
        gates->setProperty("some-child", bits);
        payload->setProperty("gates", juce::var(gates));
      }
      engine.setSequence(rootId, juce::var(payload));

      auto seqOf = [&](const juce::var& state) {
        return state.getProperty("sequence", juce::var());
      };
      juce::var s = engine.getGraphState();
      expect(seqOf(s).isObject(), "sequence published in metadata");
      expectEquals(
          (int)seqOf(s).getProperty("steps", juce::var()).getArray()->size(),
          2, "two steps published");
      expect(!(bool)seqOf(s).getProperty("bypassed", true),
             "born active (not bypassed)");

      engine.undo();
      expect(!seqOf(engine.getGraphState()).isObject(),
             "undo removes the sequence");
      engine.redo();
      expect(seqOf(engine.getGraphState()).isObject(),
             "redo restores the sequence");

      engine.toggleSequence(rootId);
      expect((bool)seqOf(engine.getGraphState()).getProperty("bypassed", false),
             "toggle bypasses (the jam comes back)");
      engine.undo();
      expect(!(bool)seqOf(engine.getGraphState()).getProperty("bypassed", true),
             "bypass toggle is undoable");

      // Malformed payloads refuse (no edit recorded).
      auto* bad = new juce::DynamicObject();
      {
        juce::Array<juce::var> steps;
        auto* s0 = new juce::DynamicObject();
        s0->setProperty("len", 0.0);
        steps.add(juce::var(s0));
        bad->setProperty("steps", steps);
      }
      const juce::var before = engine.getGraphState();
      engine.setSequence(rootId, juce::var(bad));
      expectEquals(
          (int)seqOf(engine.getGraphState())
              .getProperty("steps", juce::var())
              .getArray()
              ->size(),
          2, "zero-length step refused; sequence unchanged");
    }

    beginTest("mid-take gate: setSequence refuses while recording");
    {
      AudioEngine engine;
      const juce::String rootId =
          engine.getGraphState().getProperty("id", "").toString();
      engine.createNode("clip");
      const juce::var st = engine.getGraphState();
      const juce::String clipId = test_utils::nodesOf(st)
                                      ->getReference(0)
                                      .getProperty("id", "")
                                      .toString();
      engine.startRecordingInNode(clipId);
      auto* payload = new juce::DynamicObject();
      {
        juce::Array<juce::var> steps;
        auto* s1 = new juce::DynamicObject();
        s1->setProperty("name", "x");
        s1->setProperty("len", 1000.0);
        steps.add(juce::var(s1));
        payload->setProperty("steps", steps);
      }
      engine.setSequence(rootId, juce::var(payload));
      expect(!engine.getGraphState()
                  .getProperty("sequence", juce::var())
                  .isObject(),
             "refused while a take is armed/recording");
      engine.stopRecordingInNode(clipId);
    }
  }

  void testSaveLoad() {
    beginTest("session round trip: sequence survives save and load");
    {
      StackNode root("island");
      auto clip = makeDcClip("a", 0.1f);
      const juce::String aId = clip->getUuid();
      root.addChild(std::move(clip));
      root.setQuantum(kLen, 0);
      delete root.exchangeSequence(
          makeSeq(kLen, 2 * kLen, {{aId, 0b10ull}}));
      root.setSequenceBypassed(true);  // bypassed geometry must survive

      auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                     .getChildFile("celestrian_seq_io_test");
      dir.deleteRecursively();
      expect(session_io::save(root, kSr, dir, {}), "save ok");
      auto loaded = session_io::load(dir, kSr);
      expect(loaded.ok, "load ok");
      expectEquals((int)loaded.children.size(), 1, "one child back");

      // The saved graph nests children directly under the root; the
      // sequence block lives on the root's serialized node — but save()
      // writes the ROOT's children, not the root itself. The sequence
      // belongs to a GROUP in the general case: rebuild with a group.
      dir.deleteRecursively();

      StackNode outer("island2");
      auto group = std::make_unique<StackNode>("song");
      auto c2 = makeDcClip("b", 0.2f);
      const juce::String bId = c2->getUuid();
      group->addChild(std::move(c2));
      delete group->exchangeSequence(makeSeq(kLen, 2 * kLen, {{bId, 0b01ull}}));
      group->setSequenceBypassed(false);
      StackNode* g = group.get();
      outer.addChild(std::move(group));
      outer.setQuantum(kLen, 0);
      expect(g->activeSequenceLen() == 3 * kLen, "group sequence active");

      expect(session_io::save(outer, kSr, dir, {}), "group save ok");
      auto back = session_io::load(dir, kSr);
      expect(back.ok, "group load ok");
      auto* gBack = dynamic_cast<StackNode*>(back.children[0].get());
      expect(gBack != nullptr, "group came back as a stack");
      const Sequence* s = gBack->sequencePtr();
      expect(s != nullptr, "sequence came back");
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
      dir.deleteRecursively();
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
};

static SequencerTests sequencerTests;

}  // namespace celestrian
