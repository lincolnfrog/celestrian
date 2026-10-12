#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

/**
 * Tests for stack loop windows as time-maps (docs/time_maps.md).
 *
 * Ratified semantics:
 *  - A window is ACTIVE iff valid (end > start) and not bypassed —
 *    independent of expansion (I6b: collapse is purely visual; the
 *    engine holds no view state to toggle).
 *  - Window phase is a pure function of the received clock, folded
 *    from the stack's frame origin O (the received cycle top while the
 *    stack is unanchored):
 *    child_time = O + start + ((t − O − start) mod len). No private
 *    counter, no reset-on-collapse, fully deterministic (I8).
 */
class StackLoopTests : public juce::UnitTest {
 public:
  StackLoopTests() : juce::UnitTest("Stack Loop Window", "StackLoopDebug") {}

  void runTest() override {
    // A clip whose content is a ramp, so the output identifies the
    // position the clip was asked to play.
    auto rampValue = [](int64_t pos) { return (float)(pos + 1) * 0.0001f; };
    auto makeRampClip = [&](int len) {
      return test_utils::committedClip("Ramp", 44100.0, len, rampValue);
    };
    // The sample `node` (an island root) plays at clock t.
    auto playedAt = [](AudioNode& node, int64_t t) {
      return test_utils::renderBlock(node, 1, t).left[0];
    };

    beginTest("A loop window on a stack or on a clip (I5): active maps the "
              "clock and shortens the period, bypass restores both, "
              "re-activation restores the mapping");
    {
      // The windowed node is a 3000-sample ramp clip, or a stack holding
      // one; at clock `t` it plays `mapped` through its window and `t`
      // itself bypassed.
      struct Row {
        const char* kind;
        int64_t start, end, t, mapped;
      };
      const Row rows[] = {{"stack", 0, 1000, 1500, 500},
                          {"clip", 1000, 2000, 2500, 1500}};
      for (const Row& row : rows) {
        const juce::String kind(row.kind);
        std::unique_ptr<AudioNode> owned = makeRampClip(3000);
        if (kind == "stack") {
          auto stack = std::make_unique<StackNode>("TestStack");
          stack->addChild(std::move(owned));
          owned = std::move(stack);
        }
        AudioNode& node = *owned;
        node.setLoopPoints(row.start, row.end);

        expect(node.isLoopWindowActive(), kind + ": a valid window is active");
        expectEquals(node.getEffectivePeriod(), row.end - row.start,
                     kind + ": active, the period is the window length");
        expectWithinAbsoluteError(playedAt(node, row.t), rampValue(row.mapped),
                                  0.0001f,
                                  kind + ": active window maps the clock");

        node.setLoopWindowBypassed(true);
        expect(!node.isLoopWindowActive(), kind + ": bypassed is not active");
        expectEquals(node.getEffectivePeriod(), (int64_t)3000,
                     kind + ": bypassed, the period is the whole content");
        expectWithinAbsoluteError(
            playedAt(node, row.t), rampValue(row.t), 0.0001f,
            kind + ": bypassed window passes the clock through");

        // Nothing was baked: the mapping returns identically.
        node.setLoopWindowBypassed(false);
        expectWithinAbsoluteError(playedAt(node, row.t), rampValue(row.mapped),
                                  0.0001f,
                                  kind + ": re-activation restores the mapping");
      }
    }

    beginTest("Window phase derives from the zero");
    {
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(3000));
      stack.setLoopPoints(200, 1200);  // len 1000, start 200

      NodeContext nc = contextFor(stack, 1, 7500);
      ProcessContext& ctx = nc.ctx;
      ctx.is_playing = true;
      ctx.frame_top = 7000;  // a received cycle top off the island zero

      float out[1] = {0.0f};
      float* const outs2[] = {out};
      stack.process(nullptr, outs2, 0, 1, ctx);

      // Q18 (composition.md §2): an UNANCHORED stack measures from the
      // received cycle top O = 7000, and the map anchors at O + a0 like
      // a clip's: inner = 200 + ((7500 − 7000 − 200) mod 1000) = 500 →
      // t_child = 7000 + 500 = 7500 → ramp clip (origin 0, dur 3000)
      // plays 7500 mod 3000 = 1500 (window content sounds at its own
      // performed moment: content 200 at t ≡ 7200).
      expectWithinAbsoluteError(out[0], rampValue(1500), 0.0001f,
                                "t_child = O + start + ((t - O - start) mod "
                                "len) (the one anchoring law)");

      // Deterministic: same t, same zero, same output.
      out[0] = 0.0f;
      stack.process(nullptr, outs2, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(1500), 0.0001f,
                                "phase is a pure function of (t, zero)");
    }

    beginTest("Windowed stack re-bases frame_top for children");
    {
      // Nested windows: the inner stack's phase locks to the OUTER
      // window's frame — its cycle top is the outer window's start.
      StackNode outer("Outer");
      auto inner = std::make_unique<StackNode>("Inner");
      inner->addChild(makeRampClip(3000));
      inner->setLoopPoints(0, 300);  // inner window: [0, 300)
      outer.addChild(std::move(inner));
      outer.setLoopPoints(1000, 2000);  // outer window: [1000, 2000)

      // Outer: rel = 2500 mod 1000 = 500 → child time 0+1000+500 = 1500,
      // child zero 1000. Inner: rel = (1500 − 1000) mod 300 = 200 →
      // clip time 1000 + 0 + 200 = 1200 (the inner window selects the
      // first 300 of the inner cycle, whose top is the outer window top).
      expectWithinAbsoluteError(playedAt(outer, 2500), rampValue(1200),
                                0.0001f,
                                "nested window phases from parent window top");
    }

    beginTest("An inner window under a plain outer stack: the outer passes "
              "the clock through, the inner maps it");
    {
      StackNode outer("Outer");  // no window: transparent
      auto inner = std::make_unique<StackNode>("Inner");
      inner->addChild(makeRampClip(3000));
      inner->setLoopPoints(100, 400);  // inner window: [100, 400)
      outer.addChild(std::move(inner));

      // Inner: h = (2550 − 0 − 100) mod 300 = 50 → inner position 150.
      expectWithinAbsoluteError(playedAt(outer, 2550), rampValue(150),
                                0.00001f,
                                "the inner window selects from its own top");
    }

    beginTest("No window applied when loop_end <= loop_start");
    {
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(3000));
      stack.setLoopPoints(1000, 500);  // invalid
      expect(!stack.isLoopWindowActive());
      expectWithinAbsoluteError(playedAt(stack, 2500), rampValue(2500),
                                0.0001f,
                                "invalid window passes the clock through");
    }

    beginTest("A very high clock still wraps at the window length");
    {
      // Phase derives from the monotonic clock: however far it has run,
      // every wrap lands at the window end, with no drift.
      StackNode stack("HighClockStack");
      stack.addChild(makeRampClip(9000));

      const int64_t loop_2q = 88200;
      stack.setLoopPoints(0, loop_2q);

      // A very high monotonic position.
      NodeContext nc = contextFor(stack, 100, 132295000);
      ProcessContext& ctx = nc.ctx;
      ctx.is_playing = true;

      float out[100] = {0.0f};
      float* const outs[] = {out};

      int wraps = 0;
      double last_phase = -1.0;
      for (int i = 0; i < 4000; ++i) {
        stack.process(nullptr, outs, 0, 1, ctx);
        const double phase = stack.playhead_pos.load();
        if (last_phase >= 0.0 && phase < last_phase) {
          ++wraps;
          expect(last_phase > 0.99, "wrap only at the window end (phase=" +
                                        juce::String(last_phase) + ")");
        }
        last_phase = phase;
        ctx.master_pos += ctx.num_samples;
      }
      expectGreaterThan(wraps, 3);
    }
  }
};

static StackLoopTests stackLoopTests;

}  // namespace celestrian
