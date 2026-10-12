#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

namespace {

constexpr double kSr = 44100.0;
constexpr int64_t kQ = 4410;  // 0.1 s "quantum" for fast tests

/** A committed constant-amplitude clip, already playing. */
std::unique_ptr<ClipNode> makeClip(const char* name, float amp, int64_t len) {
  return test_utils::committedClip(name, kSr, len, amp);
}

/** Render one Q-sized block at master position `pos` and return the
 * value at sample 100 of channel 0 (constant-amp content makes single
 * samples meaningful). */
float renderAt(AudioNode& node, int64_t pos) {
  return test_utils::renderBlock(node, (int)kQ, pos).left[100];
}

}  // namespace

/**
 * One-shots as a period-source knob (design_language.md Q5, kernel.md
 * §2): period := context cycle instead of own length. Pins:
 *  - a one-shot GROUP's render equation (one firing per context cycle
 *    from content[0], rest after; its song and its members' racks),
 *  - a windowed one-shot fires its window segment once per cycle and
 *    adds nothing to the composite duration,
 *  - the knob rides the undo log.
 * A one-shot clip's firing at its origin is scenario S6's; the knob's
 * persistence (additive key; absent = loop) is session_io_tests.cc's.
 */
class OneShotTests : public juce::UnitTest {
 public:
  OneShotTests()
      : juce::UnitTest("One-Shots (period source)", "Audio Engine") {}

  void runTest() override {
    beginTest("G-2b: a one-shot GROUP folds its child clock on the CONTEXT "
              "cycle - a 3Q kit over a 4Q bass fires from content[0] every "
              "time, mapped and unmapped");
    {
      // The shot (3Q) does not divide the cycle (4Q), so a fold on the
      // map period, or none at all, would hand the mic t = 4Q at the
      // second firing: content[Q], one Q late. The one equation folds
      // the child clock on the context cycle from the group's origin.
      auto makeStepClip = [](const char* name,
                             const std::vector<float>& levels_per_q) {
        return test_utils::committedClip(
            name, kSr, kQ * (int64_t)levels_per_q.size(),
            [&](int64_t i) { return levels_per_q[(size_t)(i / kQ)]; });
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
                                "(not content[Q])");
      expectWithinAbsoluteError(renderAt(ctx, 5 * kQ), 0.35f, 1e-6f,
                                "firing 2, Q5: mic content[Q]");
      expectWithinAbsoluteError(renderAt(ctx, 7 * kQ), 0.25f, 1e-6f,
                                "Q7: rests again");

      // MAPPED: a 3Q window [Q, 4Q) on a 5Q mic — the shot is the
      // window, fired at O + a0 = Q; the second firing at 5Q must read
      // inner Q (a fold on the map period would read inner 2Q).
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
      expectWithinAbsoluteError((float)kit2Raw->playhead_pos.load(), 0.0f,
                                1e-6f, "the rest publishes no window phase");
      expectWithinAbsoluteError(renderAt(ctx2, 5 * kQ), 0.35f, 1e-6f,
                                "firing 2, Q5: inner Q again "
                                "(not inner 2Q)");
      // The published window phase is the phase of the pass the members
      // hear: firing 2 starts the window over.
      expectWithinAbsoluteError((float)kit2Raw->playhead_pos.load(), 0.0f,
                                1e-6f, "firing 2, Q5: window phase 0");
      expectWithinAbsoluteError(renderAt(ctx2, 6 * kQ), 0.45f, 1e-6f,
                                "firing 2, Q6: inner 2Q");
      expectWithinAbsoluteError((float)kit2Raw->playhead_pos.load(),
                                1.0f / 3.0f, 1e-6f,
                                "firing 2, Q6: a third of the way through");
    }

    beginTest("A one-shot group with a song reads its gates at the song "
              "position its members hear, at every firing");
    {
      // A 3Q song (steps Q + 2Q) fired once per 4Q cycle; the mic sounds
      // in step 1 only. Firing 2 starts the song over at 4Q: the mic is
      // back in step 1, and its gate must say so.
      StackNode ctx("Ctx");
      ctx.addChild(makeClip("Bass", 0.25f, 4 * kQ));
      auto kit = std::make_unique<StackNode>("Kit");
      kit->period_from_context_.store(true);
      auto mic = makeClip("Mic", 0.5f, 3 * kQ);
      const juce::String mic_id = mic->getUuid();
      kit->addChild(std::move(mic));
      auto* song = new Sequence();
      song->steps.push_back({kQ, "one"});
      song->steps.push_back({2 * kQ, "two"});
      song->gates.push_back({mic_id, 0b01ull});
      song->finalize();
      delete kit->exchangeSequence(song);
      ctx.addChild(std::move(kit));

      // Each probe is sample 100 of a block that starts mid-step, clear
      // of the gate ramps at the step edges.
      const int64_t mid = kQ / 2;
      expectWithinAbsoluteError(renderAt(ctx, mid), 0.75f, 1e-5f,
                                "firing 1, step 1: the mic sounds");
      expectWithinAbsoluteError(renderAt(ctx, kQ + mid), 0.25f, 1e-5f,
                                "firing 1, step 2: gated off");
      expectWithinAbsoluteError(renderAt(ctx, 3 * kQ + mid / 2), 0.25f, 1e-5f,
                                "Q3: the kit rests");
      expectWithinAbsoluteError(renderAt(ctx, 4 * kQ + mid), 0.75f, 1e-5f,
                                "firing 2, step 1: the mic sounds again");
      expectWithinAbsoluteError(renderAt(ctx, 5 * kQ + mid), 0.25f, 1e-5f,
                                "firing 2, step 2: gated off");
    }

    beginTest("A one-shot group's rest keeps its members' racks running: a "
              "member's echo tail rings after the shot");
    {
      StackNode ctx("Ctx");
      ctx.addChild(makeClip("Bass", 0.0f, 4 * kQ));  // silent: the 4Q cycle
      auto kit = std::make_unique<StackNode>("Kit");
      kit->period_from_context_.store(true);
      auto hit = makeClip("Hit", 0.5f, kQ);  // the 1Q shot
      // A 50 ms echo on the MEMBER's own rack (prepared here: node-level
      // tests run without the engine's device-start prepare).
      dsp::FxSlot* echo = nullptr;
      for (const auto& slot : hit->fxChain()->slots())
        if (juce::String(slot->typeId()) == "echo") echo = slot.get();
      expect(echo != nullptr, "the built-in echo slot");
      echo->prepare(kSr);
      echo->enabled.store(true);
      expect(echo->setParam("time", 0.05), "echo time set");
      expect(echo->setParam("mix", 0.8), "echo mix set");
      expect(echo->setParam("feedback", 0.0), "echo feedback set");
      kit->addChild(std::move(hit));
      ctx.addChild(std::move(kit));

      // One pass, block by block (the echo line is real DSP state).
      const int block = 441;
      auto peakOf = [&](int64_t pos) {
        return test_utils::renderBlock(ctx, block, pos).peak();
      };
      for (int64_t t = 0; t < kQ; t += block) peakOf(t);  // the shot
      const float tail = peakOf(kQ);  // the first block of the rest
      expect(tail > 0.05f,
             "the echo of the shot still sounds in the rest (the member's "
             "rack is not frozen)");
      // Long after the echo has passed, the rest is silent.
      float late = 0.0f;
      for (int64_t t = kQ + block; t < 3 * kQ; t += block) late = peakOf(t);
      expectWithinAbsoluteError(late, 0.0f, 1e-6f,
                                "the rest itself adds no content");
    }

    beginTest("Windowed one-shot fires its window segment once per cycle; "
              "bypassed, its whole take");
    {
      StackNode stack("Ctx");
      auto shot = makeClip("Shot", 0.5f, 3 * kQ);  // 3Q: divides no 4Q cycle
      auto loop = makeClip("Loop", 0.25f, 4 * kQ);
      ClipNode* shotRaw = shot.get();
      stack.addChild(std::move(shot));
      stack.addChild(std::move(loop));
      shotRaw->setLoopPoints(0, kQ);  // window = first 1Q of the take
      shotRaw->period_from_context_.store(true);
      expectEquals(stack.getIntrinsicDuration(), (int64_t)(4 * kQ),
                   "composite duration ignores the one-shot (not lcm(3Q, 4Q))");

      expectWithinAbsoluteError(renderAt(stack, 0), 0.75f, 1.0e-6f,
                                "cycle top: window fires");
      expectWithinAbsoluteError(renderAt(stack, kQ), 0.25f, 1.0e-6f,
                                "Q1: window (1Q) done - rest, not the "
                                "take's second Q");
      expectWithinAbsoluteError(renderAt(stack, 4 * kQ), 0.75f, 1.0e-6f,
                                "next cycle: fires again");

      // Bypassed, the shot is the whole 3Q take: it plays [0, 3Q), then
      // rests [3Q, 4Q).
      shotRaw->setLoopWindowBypassed(true);
      expectWithinAbsoluteError(renderAt(stack, 2 * kQ), 0.75f, 1.0e-6f,
                                "Q2: still inside the 3Q shot");
      expectWithinAbsoluteError(renderAt(stack, 3 * kQ), 0.25f, 1.0e-6f,
                                "Q3: shot over, loop remains");
    }

    beginTest("The knob rides the undo log");
    {
      auto engine = std::make_unique<AudioEngine>();
      engine->createNode("clip");
      const juce::String uuid = test_utils::firstNodeId(*engine);
      const auto source = [&] {
        return test_utils::findVar(engine->getGraphState(), uuid)
            .getProperty("periodSource", "")
            .toString();
      };

      expectEquals(source(), juce::String("own"), "born a loop");
      engine->setPeriodSource(uuid, PeriodSource::CONTEXT_CYCLE);
      expectEquals(source(), juce::String("context"), "knob set");
      engine->undo();
      expectEquals(source(), juce::String("own"), "undo restores");
      engine->redo();
      expectEquals(source(), juce::String("context"), "redo re-applies");
    }
  }
};

static OneShotTests oneShotTests;

}  // namespace celestrian
