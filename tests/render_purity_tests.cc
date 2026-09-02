/**
 * §2.3 pure-render split: render is a PURE function of
 * (structure, settled state, t) — the audit's endgame,
 * `assert(render(state, t) == golden)`, made literal.
 *
 * The const qualifier already enforces most of this at compile time
 * (the only mutables are DSP scratch and playhead telemetry); what is
 * pinned here is the runtime contract: determinism, musical-state
 * invariance, and the control→render sequencing (a commit block
 * renders silent — the historical semantics).
 */

#include <juce_core/juce_core.h>

#include <vector>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

class RenderPurityTests : public juce::UnitTest {
 public:
  RenderPurityTests() : juce::UnitTest("Pure render (section 2.3)") {}

  // One-sample render at master time t (distinct channel buffers — the
  // clip sums into every channel). The node is the island root of the
  // context (mutable only to build its snapshot); render itself is
  // called through the const interface.
  static float renderAt(AudioNode& node, int64_t t) {
    float outL[4] = {0.0f}, outR[4] = {0.0f};
    float* outs[] = {outL, outR};
    NodeContext nc = contextFor(node, 1, t);
    nc.ctx.is_playing = true;
    static_cast<const AudioNode&>(node).render(outs, 2, nc.ctx);
    return outL[0];
  }

  void runTest() override {
    // A committed take with a recognizable ramp.
    const int N = 1000;
    ClipNode clip("pure-clip");
    std::vector<float> ramp(N);
    for (int i = 0; i < N; ++i) ramp[i] = (float)i / N;
    {
      float* ins[] = {ramp.data()};
      NodeContext rec = contextFor(clip, N);
      rec.ctx.is_recording = true;
      clip.startRecording();
      clip.process(ins, nullptr, 1, 0, rec.ctx);
      clip.stopRecording();  // Q == 0 → immediate commit (message path)
    }

    beginTest("commit block renders SILENT; the next control pass re-arms it");
    {
      // The commit just fired and no control pass has run since: render
      // must gate (the historical process() returned right after commit,
      // so the commit block never played).
      expectWithinAbsoluteError(renderAt(clip, 100), 0.0f, 1e-9f,
                                "no playback in the commit block");
      // One control pass (idle clip: clears the gate, decides nothing).
      NodeContext ctl = contextFor(clip, 1);
      clip.control(nullptr, 0, ctl.ctx);
      expectWithinAbsoluteError(renderAt(clip, 100), ramp[100], 1e-6f,
                                "playback from the next block on");
    }

    beginTest("render(state, t) == golden: deterministic, repeatable");
    {
      // The kernel equation, sampled directly.
      for (int64_t t : {0, 1, 250, 999, 1000, 1234, 5000}) {
        const float expected = ramp[(size_t)(t % N)];
        expectWithinAbsoluteError(renderAt(clip, t), expected, 1e-6f,
                                  "content[(t - origin) mod dur]");
        expectWithinAbsoluteError(renderAt(clip, t), renderAt(clip, t), 0.0f,
                                  "bit-identical on repeat");
      }
    }

    beginTest("render mutates no musical state");
    {
      const int64_t origin = clip.origin_samples.load();
      const int64_t dur = clip.getIntrinsicDuration();
      const int64_t ls = clip.getLoopStart(), le = clip.getLoopEnd();
      for (int i = 0; i < 100; ++i) renderAt(clip, i * 37);
      expectEquals(clip.origin_samples.load(), origin, "origin untouched");
      expectEquals(clip.getIntrinsicDuration(), dur, "duration untouched");
      expectEquals(clip.getLoopStart(), ls, "window untouched");
      expectEquals(clip.getLoopEnd(), le, "...");
    }

    beginTest("stack render is pure too (mix through the fractal)");
    {
      StackNode root("root");
      auto owned = std::make_unique<ClipNode>("child");
      auto* child = owned.get();
      {
        float* ins[] = {ramp.data()};
        NodeContext rec = contextFor(*child, N);
        rec.ctx.is_recording = true;
        child->startRecording();
        child->process(ins, nullptr, 1, 0, rec.ctx);
        child->stopRecording();
        NodeContext ctl = contextFor(*child, 1);  // clear the commit gate
        child->control(nullptr, 0, ctl.ctx);
      }
      root.addChild(std::move(owned));
      const float a = renderAt(root, 123);
      const float b = renderAt(root, 123);
      expectWithinAbsoluteError(a, ramp[123], 1e-6f, "summed child content");
      expectWithinAbsoluteError(a, b, 0.0f, "repeatable through the stack");
    }
  }
};

static RenderPurityTests renderPurityTests;

}  // namespace celestrian
