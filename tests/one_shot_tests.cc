#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

namespace {

constexpr double kSr = 44100.0;
constexpr int64_t kQ = 4410;  // 0.1 s "quantum" for fast tests

/** A committed constant-amplitude clip, already playing. */
std::unique_ptr<ClipNode> makeClip(const char* name, float amp, int64_t len) {
  auto clip = std::make_unique<ClipNode>(name, kSr);
  std::vector<float> in((size_t)len, amp);
  float* const ins[] = {in.data()};
  NodeContext rec = contextFor(*clip, (int)len);
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec.ctx);
  clip->stopRecording();
  clip->startPlayback();
  return clip;
}

/** Render one Q-sized block at master position `pos` and return the
 * value at sample 100 of channel 0 (constant-amp content makes single
 * samples meaningful). */
float renderAt(AudioNode& node, int64_t pos) {
  std::vector<float> outL((size_t)kQ, 0.0f), outR((size_t)kQ, 0.0f);
  float* outs[] = {outL.data(), outR.data()};
  NodeContext play = contextFor(node, (int)kQ, pos);
  play.ctx.is_playing = true;
  node.process(nullptr, outs, 0, 2, play.ctx);
  return outL[100];
}

}  // namespace

/**
 * One-shots as a period-source knob (Q5 ruling / kernel.md §2 / audit
 * D7): period := context cycle instead of own length. Pins:
 *  - the render equation (sounds once per scope cycle at its origin,
 *    silence for the rest — recording.md Example 3),
 *  - exclusion from period/duration composition (a one-shot adopts the
 *    scope cycle, never extends it),
 *  - a windowed one-shot fires its window segment once per cycle,
 *  - the knob rides the undo log,
 *  - persistence (additive key; absent = loop).
 */
class OneShotTests : public juce::UnitTest {
 public:
  OneShotTests()
      : juce::UnitTest("One-Shots (period source)", "Audio Engine") {}

  void runTest() override {
    beginTest("One-shot at origin 0: sounds Q1 of a 4Q context, rests after");
    {
      StackNode stack("Ctx");
      auto shot = makeClip("Shot", 0.5f, kQ);       // 1Q content
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);  // defines the 4Q cycle
      ClipNode* shotRaw = shot.get();
      stack.addChild(std::move(shot));
      stack.addChild(std::move(loop));

      // As a LOOP the 1Q clip tiles every Q: block 1 carries both.
      expectWithinAbsoluteError(renderAt(stack, kQ), 0.75f, 1.0e-6f,
                                "looping: sounds every Q");

      shotRaw->period_from_context_.store(true);
      expectWithinAbsoluteError(renderAt(stack, 0), 0.75f, 1.0e-6f,
                                "cycle top: shot + loop");
      expectWithinAbsoluteError(renderAt(stack, kQ), 0.25f, 1.0e-6f,
                                "Q1: loop only (shot rests)");
      expectWithinAbsoluteError(renderAt(stack, 3 * kQ), 0.25f, 1.0e-6f,
                                "Q3: still resting");
      expectWithinAbsoluteError(renderAt(stack, 4 * kQ), 0.75f, 1.0e-6f,
                                "next cycle top: fires again");
    }

    beginTest("Origin anchors the firing (recording.md Example 3)");
    {
      StackNode stack("Ctx");
      auto shot = makeClip("Shot", 0.5f, kQ);
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);
      ClipNode* shotRaw = shot.get();
      stack.addChild(std::move(shot));
      stack.addChild(std::move(loop));
      shotRaw->period_from_context_.store(true);
      shotRaw->origin_samples.store(3 * kQ);  // performed at 3Q

      expectWithinAbsoluteError(renderAt(stack, 0), 0.25f, 1.0e-6f,
                                "cycle top: silent before its moment");
      expectWithinAbsoluteError(renderAt(stack, 2 * kQ), 0.25f, 1.0e-6f,
                                "2Q: still silent");
      expectWithinAbsoluteError(renderAt(stack, 3 * kQ), 0.75f, 1.0e-6f,
                                "3Q: the shot fires");
      expectWithinAbsoluteError(renderAt(stack, 7 * kQ), 0.75f, 1.0e-6f,
                                "3Q of the next cycle: fires again");
    }

    beginTest("G-2b: a one-shot GROUP folds its child clock on the CONTEXT "
              "cycle - a 3Q kit over a 4Q bass fires from content[0] every "
              "time, mapped and unmapped");
    {
      // The shot (3Q) does not divide the cycle (4Q): under the old law
      // (child clock folded on the map period, or not at all) the second
      // firing handed the mic t = 4Q and it rendered content[Q] — one Q
      // late on every odd bar. The one equation folds the child clock
      // on the context cycle from the group's origin.
      auto makeStepClip = [](const char* name,
                             const std::vector<float>& levels_per_q) {
        auto clip = std::make_unique<ClipNode>(name, kSr);
        const int64_t len = kQ * (int64_t)levels_per_q.size();
        std::vector<float> in((size_t)len, 0.0f);
        for (int64_t i = 0; i < len; ++i)
          in[(size_t)i] = levels_per_q[(size_t)(i / kQ)];
        float* const ins[] = {in.data()};
        NodeContext rec = contextFor(*clip, (int)len);
        clip->startRecording();
        clip->process(ins, nullptr, 1, 0, rec.ctx);
        clip->stopRecording();
        clip->startPlayback();
        return clip;
      };
      StackNode ctx("Ctx");
      auto bass = makeClip("Bass", 0.25f, 4 * kQ);  // the 4Q cycle
      auto kit = std::make_unique<StackNode>("Kit");
      StackNode* kitRaw = kit.get();
      kitRaw->period_from_context_.store(true);  // a one-shot GROUP
      kit->addChild(makeStepClip("Mic", {0.5f, 0.1f, 0.2f}));  // 3Q
      ctx.addChild(std::move(bass));
      ctx.addChild(std::move(kit));

      // UNMAPPED: fires at the group's frame origin (0) once per 4Q.
      expectWithinAbsoluteError(renderAt(ctx, 0), 0.75f, 1e-6f,
                                "firing 1, Q0: bass + mic content[0]");
      expectWithinAbsoluteError(renderAt(ctx, kQ), 0.35f, 1e-6f,
                                "firing 1, Q1: mic content[Q]");
      expectWithinAbsoluteError(renderAt(ctx, 3 * kQ), 0.25f, 1e-6f,
                                "Q3: the kit rests");
      expectWithinAbsoluteError(renderAt(ctx, 4 * kQ), 0.75f, 1e-6f,
                                "firing 2, Q4: mic content[0] again "
                                "(was content[Q] under the old fold)");
      expectWithinAbsoluteError(renderAt(ctx, 5 * kQ), 0.35f, 1e-6f,
                                "firing 2, Q5: mic content[Q]");
      expectWithinAbsoluteError(renderAt(ctx, 7 * kQ), 0.25f, 1e-6f,
                                "Q7: rests again");

      // MAPPED: a 3Q window [Q, 4Q) on a 5Q mic — the shot is the
      // window, fired at O + a0 = Q; the second firing at 5Q must read
      // inner Q (the old law's map-period fold read inner 2Q).
      auto kit2 = std::make_unique<StackNode>("Kit2");
      StackNode* kit2Raw = kit2.get();
      kit2Raw->period_from_context_.store(true);
      kit2->addChild(makeStepClip("Mic2", {0.5f, 0.1f, 0.2f, 0.3f, 0.4f}));
      StackNode ctx2("Ctx2");
      ctx2.addChild(makeClip("Bass2", 0.25f, 4 * kQ));
      ctx2.addChild(std::move(kit2));
      kit2Raw->setLoopPoints(kQ, 4 * kQ);
      kit2Raw->setLoopWindowBypassed(false);
      expectWithinAbsoluteError(renderAt(ctx2, 0), 0.25f, 1e-6f,
                                "Q0: before the window's moment, rest");
      expectWithinAbsoluteError(renderAt(ctx2, kQ), 0.35f, 1e-6f,
                                "firing 1, Q1: inner Q");
      expectWithinAbsoluteError(renderAt(ctx2, 3 * kQ), 0.55f, 1e-6f,
                                "firing 1, Q3: inner 3Q");
      expectWithinAbsoluteError(renderAt(ctx2, 4 * kQ), 0.25f, 1e-6f,
                                "Q4: rest (h = 3Q >= the 3Q shot)");
      expectWithinAbsoluteError(renderAt(ctx2, 5 * kQ), 0.35f, 1e-6f,
                                "firing 2, Q5: inner Q again "
                                "(was inner 2Q under the old fold)");
      expectWithinAbsoluteError(renderAt(ctx2, 6 * kQ), 0.45f, 1e-6f,
                                "firing 2, Q6: inner 2Q");
    }

    beginTest("One-shots are excluded from period composition");
    {
      StackNode stack("Ctx");
      auto shot = makeClip("Shot", 0.5f, 3 * kQ);   // 3Q content
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);  // 4Q loop
      ClipNode* shotRaw = shot.get();
      stack.addChild(std::move(shot));
      stack.addChild(std::move(loop));

      expectEquals(stack.getEffectivePeriod(), (int64_t)(12 * kQ),
                   "looping: lcm(3Q, 4Q) = 12Q");
      shotRaw->period_from_context_.store(true);
      expectEquals(stack.getEffectivePeriod(), (int64_t)(4 * kQ),
                   "one-shot adopts the cycle: scope stays 4Q");
      expectEquals(stack.getIntrinsicDuration(), (int64_t)(4 * kQ),
                   "composite duration ignores the one-shot too");
      // A 3Q one-shot in a 4Q cycle overhangs its own next firing point
      // by nothing — it plays [0,3Q) then rests [3Q,4Q).
      expectWithinAbsoluteError(renderAt(stack, 2 * kQ), 0.75f, 1.0e-6f,
                                "Q2: still inside the 3Q shot");
      expectWithinAbsoluteError(renderAt(stack, 3 * kQ), 0.25f, 1.0e-6f,
                                "Q3: shot over, loop remains");
    }

    beginTest("Windowed one-shot fires its window segment once per cycle");
    {
      StackNode stack("Ctx");
      auto shot = makeClip("Shot", 0.5f, 2 * kQ);
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);
      ClipNode* shotRaw = shot.get();
      stack.addChild(std::move(shot));
      stack.addChild(std::move(loop));
      shotRaw->setLoopPoints(0, kQ);  // window = first 1Q of the take
      shotRaw->period_from_context_.store(true);

      expectWithinAbsoluteError(renderAt(stack, 0), 0.75f, 1.0e-6f,
                                "cycle top: window fires");
      expectWithinAbsoluteError(renderAt(stack, kQ), 0.25f, 1.0e-6f,
                                "Q1: window (1Q) done - rest, not the "
                                "take's second Q");
      expectWithinAbsoluteError(renderAt(stack, 4 * kQ), 0.75f, 1.0e-6f,
                                "next cycle: fires again");
    }

    beginTest("The knob rides the undo log");
    {
      AudioEngine engine;
      engine.createNode("clip");
      auto s = engine.getGraphState();
      auto* arr = s.getProperty("nodes", juce::var()).getArray();
      const juce::String uuid = (*arr)[0].getProperty("id", "").toString();

      auto sourceOf = [&](const juce::String& u) {
        auto st = engine.getGraphState();
        auto* nodes = st.getProperty("nodes", juce::var()).getArray();
        for (auto& n : *nodes) {
          if (n.getProperty("id", "").toString() == u)
            return n.getProperty("periodSource", "").toString();
        }
        return juce::String();
      };

      expectEquals(sourceOf(uuid), juce::String("own"), "born a loop");
      engine.setPeriodSource(uuid, PeriodSource::CONTEXT_CYCLE);
      expectEquals(sourceOf(uuid), juce::String("context"), "knob set");
      engine.undo();
      expectEquals(sourceOf(uuid), juce::String("own"), "undo restores");
      engine.redo();
      expectEquals(sourceOf(uuid), juce::String("context"), "redo re-applies");
    }

    beginTest("Session round-trip; absent key loads as a loop");
    {
      StackNode root("OneShotSession");
      root.setQuantum(kQ, 0);

      auto shot = makeClip("Shot", 0.5f, kQ);
      shot->period_from_context_.store(true);
      root.addChild(std::move(shot));
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);
      root.addChild(std::move(loop));

      auto dir = test_utils::freshTempDir("one_shot");
      expect(session_io::save(root, kSr, dir), "save");
      auto loaded = session_io::load(dir, kSr);
      expect(loaded.ok, "load ok");
      expect(loaded.children[0]->period_from_context_.load(),
             "one-shot restored");
      expect(!loaded.children[1]->period_from_context_.load(),
             "loop stays a loop");

      // Legacy session (no periodSource key) loads as a LOOP.
      auto jf = dir.getChildFile("session.json");
      auto parsed = juce::JSON::parse(jf.loadFileAsString());
      auto* shotObj = parsed.getProperty("nodes", {})[0].getDynamicObject();
      expect(shotObj != nullptr && shotObj->hasProperty("periodSource"),
             "key was present to strip");
      shotObj->removeProperty("periodSource");
      jf.replaceWithText(juce::JSON::toString(parsed, true));
      auto legacy = session_io::load(dir, kSr);
      expect(legacy.ok, "legacy load ok");
      expect(!legacy.children[0]->period_from_context_.load(),
             "absent key = loop");
      dir.deleteRecursively();
    }
  }
};

static OneShotTests oneShotTests;

}  // namespace celestrian
