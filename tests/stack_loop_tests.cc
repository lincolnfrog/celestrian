#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {

/**
 * Tests for stack loop windows as time-maps (docs/time_maps.md phase 1).
 *
 * Ratified semantics:
 *  - A window is ACTIVE iff valid (end > start) and not bypassed —
 *    independent of expansion (I6b: collapse is purely visual).
 *  - Window phase is a pure function of the received clock:
 *    child_time = start + ((t − cycle_epoch) mod len). No private
 *    counter, no reset-on-collapse, fully deterministic (I8).
 */
class StackLoopTests : public juce::UnitTest {
 public:
  StackLoopTests() : juce::UnitTest("Stack Loop Window", "StackLoopDebug") {}

  void runTest() override {
    float dummy[10000] = {0.0f};
    float* const inputs[] = {dummy};
    float output[10000] = {0.0f};
    float* const outputs[] = {output};

    // Helper: a clip whose buffer holds a ramp so output identifies the
    // position the clip was asked to play.
    auto makeRampClip = [&](int len) {
      auto clip = std::make_unique<ClipNode>("Ramp", 44100.0);
      std::vector<float> ramp((size_t)len);
      for (int i = 0; i < len; ++i) ramp[(size_t)i] = (float)(i + 1) * 0.0001f;
      float* const rampIn[] = {ramp.data()};
      ProcessContext ctx;
      ctx.num_samples = len;
      ctx.is_recording = true;
      clip->startRecording();
      clip->process(rampIn, nullptr, 1, 0, ctx);
      clip->stopRecording();
      return clip;
    };
    auto rampValue = [](int pos) { return (float)(pos + 1) * 0.0001f; };

    beginTest("I6b: expansion does not change the sound");
    {
      // Identical processing with the stack expanded vs collapsed must
      // produce identical output — the invariant the old Loop-on-Collapse
      // model violated.
      for (bool expanded : {true, false}) {
        StackNode stack("TestStack");
        stack.addChild(makeRampClip(3000));
        static_cast<ClipNode*>(stack.getChild(0))->startPlayback();
        stack.setLoopPoints(0, 1000);
        stack.is_expanded.store(expanded);

        ProcessContext ctx;
        ctx.is_playing = true;
        ctx.num_samples = 1;
        ctx.master_pos = 1500;  // window active: maps to 1500 % 1000 = 500

        float out[1] = {0.0f};
        float* const outs[] = {out};
        stack.process(nullptr, outs, 0, 1, ctx);

        expectWithinAbsoluteError(
            out[0], rampValue(500), 0.0001f,
            juce::String("windowed output identical when ") +
                (expanded ? "expanded" : "collapsed"));
      }
    }

    beginTest("Bypass toggle silences the window (data, not view)");
    {
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(3000));
      static_cast<ClipNode*>(stack.getChild(0))->startPlayback();
      stack.setLoopPoints(0, 1000);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 1;
      ctx.master_pos = 1500;

      float out[1] = {0.0f};
      float* const outs[] = {out};

      // Active (default): mapped to 500
      stack.process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(500), 0.0001f,
                                "active window maps the clock");

      // Bypassed: passes 1500 straight through
      stack.setLoopWindowBypassed(true);
      out[0] = 0.0f;
      stack.process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(1500), 0.0001f,
                                "bypassed window passes the clock through");

      // Re-activated: mapping returns identically (nothing was baked)
      stack.setLoopWindowBypassed(false);
      out[0] = 0.0f;
      stack.process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(500), 0.0001f,
                                "re-activation restores the mapping");
    }

    beginTest("Window phase derives from the cycle epoch");
    {
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(3000));
      static_cast<ClipNode*>(stack.getChild(0))->startPlayback();
      stack.setLoopPoints(200, 1200);  // len 1000, start 200

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 1;
      ctx.master_pos = 7500;
      ctx.cycle_epoch = 7000;  // epoch-rebased frame (e.g. after a commit)

      float out[1] = {0.0f};
      float* const outs2[] = {out};
      stack.process(nullptr, outs2, 0, 1, ctx);

      // rel = (7500 − 7000) mod 1000 = 500. The window selects VIEW
      // positions, staying in the received frame:
      // t_child = 7000 + 200 + 500 = 7700 → ramp clip (origin 0,
      // dur 3000) plays 7700 mod 3000 = 1700.
      expectWithinAbsoluteError(out[0], rampValue(1700), 0.0001f,
                                "t_child = epoch + start + rel (view "
                                "positions, frame preserved)");

      // Deterministic: same t, same epoch, same output — regardless of
      // any interleaved view changes.
      stack.is_expanded.store(!stack.is_expanded.load());
      out[0] = 0.0f;
      stack.process(nullptr, outs2, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(1700), 0.0001f,
                                "phase independent of view state changes");
    }

    beginTest("Windowed stack re-bases cycle_epoch for children");
    {
      // Nested windows: the inner stack's phase locks to the OUTER
      // window's frame — its cycle top is the outer window's start.
      StackNode outer("Outer");
      auto inner = std::make_unique<StackNode>("Inner");
      auto* innerPtr = inner.get();
      innerPtr->addChild(makeRampClip(3000));
      static_cast<ClipNode*>(innerPtr->getChild(0))->startPlayback();
      innerPtr->setLoopPoints(0, 300);  // inner window: [0, 300)
      outer.addChild(std::move(inner));
      outer.setLoopPoints(1000, 2000);  // outer window: [1000, 2000)

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 1;
      ctx.master_pos = 2500;
      ctx.cycle_epoch = 0;

      float out[1] = {0.0f};
      float* const outs[] = {out};
      outer.process(nullptr, outs, 0, 1, ctx);

      // Outer: rel = 2500 mod 1000 = 500 → child time 0+1000+500 = 1500,
      // child epoch 1000. Inner: rel = (1500 − 1000) mod 300 = 200 →
      // clip time 1000 + 0 + 200 = 1200 (the inner window selects the
      // first 300 of the inner cycle, whose top is the outer window top).
      expectWithinAbsoluteError(out[0], rampValue(1200), 0.0001f,
                                "nested window phases from parent window top");
    }

    beginTest("No window applied when loop_end <= loop_start");
    {
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(3000));
      static_cast<ClipNode*>(stack.getChild(0))->startPlayback();
      stack.setLoopPoints(1000, 500);  // invalid
      expect(!stack.isLoopWindowActive());

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 1;
      ctx.master_pos = 2500;

      float out[1] = {0.0f};
      float* const outs[] = {out};
      stack.process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(2500), 0.0001f,
                                "invalid window passes the clock through");
    }

    beginTest(
        "Clip loop window is fractal (I5): subset loops, bypass restores");
    {
      // A clip's loop region is the single-segment case of the stack's
      // time-map: same active/bypass semantics, same toggle. Commit set
      // [0, duration); the user windows Q2 of a 3Q take.
      auto clip = makeRampClip(3000);
      clip->startPlayback();
      clip->setLoopPoints(1000, 2000);
      expect(clip->isLoopWindowActive(), "subset window is active");

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 1;
      ctx.master_pos = 2500;

      float out[1] = {0.0f};
      float* const outs[] = {out};

      // Active: period = window length (1000); (2500 mod 1000) = 500
      // into the window → content position 1500
      clip->process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(1500), 0.0001f,
                                "active clip window loops the subset");

      // Bypassed: the FULL take plays (period back to 3000)
      clip->setLoopWindowBypassed(true);
      expect(!clip->isLoopWindowActive());
      out[0] = 0.0f;
      clip->process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(2500), 0.0001f,
                                "bypassed clip window plays the full take");

      // Re-activated: mapping returns identically (nothing was baked)
      clip->setLoopWindowBypassed(false);
      out[0] = 0.0f;
      clip->process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(out[0], rampValue(1500), 0.0001f,
                                "re-activation restores the clip window");
    }

    beginTest("E-C: getEffectivePeriod — windows shorten the audible cycle");
    {
      // A lone 2Q-ish stack windowed to 1000: the audible period IS the
      // window (the field bug: the playhead sailed past the window
      // because the transport wrapped on the intrinsic length).
      StackNode stack("TestStack");
      stack.addChild(makeRampClip(2000));
      expectEquals(stack.getEffectivePeriod(), (int64_t)2000,
                   "no window: effective = intrinsic (children LCM)");

      stack.setLoopPoints(0, 1000);
      expectEquals(stack.getEffectivePeriod(), (int64_t)1000,
                   "active window: effective = window length");

      stack.setLoopWindowBypassed(true);
      expectEquals(stack.getEffectivePeriod(), (int64_t)2000,
                   "bypassed window: effective back to intrinsic");
      stack.setLoopWindowBypassed(false);

      // Nested: an outer stack sees the windowed inner stack as a
      // 1000-sample clip (E-C is recursive through getEffectivePeriod)
      StackNode outer("Outer");
      auto inner = std::make_unique<StackNode>("Inner");
      inner->addChild(makeRampClip(2000));
      inner->setLoopPoints(0, 1000);
      outer.addChild(std::move(inner));
      outer.addChild(makeRampClip(3000));
      expectEquals(outer.getEffectivePeriod(), (int64_t)3000,
                   "outer LCM(window 1000, clip 3000) = 3000");

      // A windowed CLIP contributes its window length too (fractal)
      StackNode withClipWin("ClipWin");
      auto wc = makeRampClip(3000);
      wc->setLoopPoints(1000, 2000);
      withClipWin.addChild(std::move(wc));
      withClipWin.addChild(makeRampClip(2000));
      expectEquals(withClipWin.getEffectivePeriod(), (int64_t)2000,
                   "LCM(clip window 1000, clip 2000) = 2000");
    }

    beginTest("High transport stays wrap-consistent (repro, monotonic)");
    {
      // Successor of the old high-internal-transport repro: with phase
      // derived from a monotonic clock, wraps must land at the window
      // length forever, with no drift and no overflow special cases.
      StackNode stack("ReproStack");
      stack.addChild(makeRampClip(9000));
      static_cast<ClipNode*>(stack.getChild(0))->startPlayback();

      const int64_t loop_2q = 88200;
      stack.setLoopPoints(0, loop_2q);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 100;
      ctx.master_pos = 132295000;  // very high monotonic position

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
