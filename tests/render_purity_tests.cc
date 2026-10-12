/**
 * Render is a PURE function of (structure, settled state, t):
 * `assert(render(state, t) == golden)`, made literal.
 *
 * The const qualifier enforces at compile time that render leaves
 * the musical state alone (the only mutables are DSP scratch and
 * playhead telemetry); what is pinned here is the runtime contract:
 * determinism and the control→render sequencing (a commit block
 * renders silent).
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "../src/clip_node.h"
#include "../src/sequence.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

class RenderPurityTests : public juce::UnitTest {
 public:
  RenderPurityTests() : juce::UnitTest("Pure render") {}

  // One-sample render at master time t. The node is the island root of
  // the context (mutable only to build its snapshot); render itself is
  // called through the const interface, with no control pass before it.
  static float renderAt(AudioNode& node, int64_t t) {
    return test_utils::renderBlock(node, 1, t,
                                     test_utils::BlockPass::RenderOnly)
        .left[0];
  }

  void runTest() override {
    // A committed take with a recognizable ramp.
    const int N = 1000;
    std::vector<float> ramp(N);
    for (int i = 0; i < N; ++i) ramp[i] = (float)i / N;
    const auto rampClip = [&](const char* name) {
      return test_utils::committedClip(
          name, 44100.0, N, [&](int64_t i) { return ramp[(size_t)i]; });
    };
    const std::unique_ptr<ClipNode> owned_clip = rampClip("pure-clip");
    ClipNode& clip = *owned_clip;

    beginTest("the block a commit falls in renders SILENT; the next control "
              "pass re-arms it");
    {
      // A take finishing at a boundary commits inside the block that
      // crosses it: no control pass has run since, and render gates, so
      // that block never plays.
      StackNode island("island");
      auto owned = std::make_unique<ClipNode>("boundary-take", 44100.0);
      ClipNode& take = *owned;
      island.addChild(std::move(owned));
      island.setQuantum(N, 0);
      NodeContext rec = contextFor(island, 600);
      rec.driveFrom(take);
      float* const head[] = {ramp.data()};
      take.startRecording();
      take.control(head, 1, rec.ctx);  // on a grid line: captures [0, 600)
      take.stopRecording();            // asked: on to the boundary at N
      float* const tail[] = {ramp.data() + 600};
      rec.ctx.master_pos = rec.ctx.island_pos = 600;
      rec.ctx.num_samples = N - 600;
      take.control(tail, 1, rec.ctx);  // crosses N: the commit
      expectEquals(take.getIntrinsicDuration(), (int64_t)N,
                   "committed at the boundary");
      expectWithinAbsoluteError(renderAt(island, 100), 0.0f, 1e-9f,
                                "no playback in the commit block");
      // One control pass (idle clip: clears the gate, decides nothing).
      NodeContext ctl = contextFor(island, 1);
      island.control(nullptr, 0, ctl.ctx);
      expectWithinAbsoluteError(renderAt(island, 100), ramp[100], 1e-6f,
                                "playback from the next block on");
    }

    beginTest("the block top that commits a first take captured nothing: "
              "that block plays the take");
    {
      // (rampClip's take: stopped, then committed by the next block top.)
      expectWithinAbsoluteError(renderAt(clip, 100), ramp[100], 1e-6f,
                                "playback in the block the commit opened");
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

    beginTest("stack render is pure too (mix through the fractal)");
    {
      StackNode root("root");
      auto child = rampClip("child");
      NodeContext ctl = contextFor(*child, 1);  // clear the commit gate
      child->control(nullptr, 0, ctl.ctx);
      root.addChild(std::move(child));
      const float a = renderAt(root, 123);
      const float b = renderAt(root, 123);
      expectWithinAbsoluteError(a, ramp[123], 1e-6f, "summed child content");
      expectWithinAbsoluteError(a, b, 0.0f, "repeatable through the stack");
    }

    beginTest("a block of the ceiling size grows no scratch: a clip's pair "
              "and a group's buffers hold kMaxBlockSamples from construction");
    {
      StackNode root("root");
      auto member = rampClip("member");
      const ClipNode& clip_ref = *member;
      root.addChild(std::move(member));
      root.gain.store(0.5f);  // off unity: the group sums through its own
      const int clip_before = clip_ref.renderScratchSamplesForTest();
      const int group_before = root.renderScratchSamplesForTest();
      expect(clip_before >= 2 * kMaxBlockSamples,
             "the clip's scratch pair is sized for the ceiling up front");
      expect(group_before >= 2 * kMaxBlockSamples,
             "and the group's mix buffer and accumulator");
      const auto out = test_utils::renderBlock(root, kMaxBlockSamples, 0);
      expectWithinAbsoluteError(out.left[500], 0.5f * ramp[500], 1e-6f,
                                "the block rendered through both");
      expectEquals(clip_ref.renderScratchSamplesForTest(), clip_before,
                   "rendering it did not grow the clip's scratch");
      expectEquals(root.renderScratchSamplesForTest(), group_before,
                   "nor the group's");
    }

    beginTest("a nested graph renders the same whatever the block size: map "
              "seams, a song's gate ramps and a one-shot's rest all fall "
              "mid-block");
    {
      // root (song 2Q + 3Q; `win` enters in step two over a 700-sample
      // fade)
      //  ├─ bed   a 1Q ramp loop
      //  ├─ win   a group with a free-cut window [150, 650) over a ramp
      //  └─ shot  a one-shot group: its 1Q ramp once per 5Q song, then rest
      StackNode root("root");
      root.addChild(rampClip("bed"));
      auto win = std::make_unique<StackNode>("win");
      win->addChild(rampClip("win-member"));
      win->setLoopPoints(150, 650);
      const juce::String win_id = win->getUuid();
      root.addChild(std::move(win));
      auto shot = std::make_unique<StackNode>("shot");
      shot->period_from_context_.store(true);
      shot->addChild(rampClip("shot-member"));
      root.addChild(std::move(shot));
      auto* song = new Sequence();
      song->steps.push_back({2 * N, "one"});
      Sequence::Step two;
      two.len = 3 * N;
      two.name = "two";
      two.fade_in = 700;
      song->steps.push_back(two);
      song->gates.push_back({win_id, 0b10ull});
      song->finalize();
      delete root.exchangeSequence(song);

      const int span = 6 * N;  // a whole song and the next one's first Q
      const auto renderIn = [&](int block) {
        std::vector<float> all;
        for (int t = 0; t < span; t += block) {
          const std::vector<float> piece =
              test_utils::renderBlock(root, std::min(block, span - t), t)
                  .left;
          all.insert(all.end(), piece.begin(), piece.end());
        }
        return all;
      };
      const std::vector<float> whole = renderIn(span);
      // The pieces of the picture are really there: the one-shot sounds
      // in the first Q only, and the gated group is silent in step one.
      expectWithinAbsoluteError(whole[500], 2.0f * ramp[500], 1e-5f,
                                "Q0: bed + the one-shot's shot");
      expectWithinAbsoluteError(whole[1500], ramp[500], 1e-5f,
                                "Q1: bed alone (the shot rests, win is gated)");
      expect(whole[4500] > ramp[500] + 0.01f, "step two: win has entered");
      for (int block : {97, 256, 1024}) {
        const std::vector<float> pieces = renderIn(block);
        float worst = 0.0f;
        for (int i = 0; i < span; ++i) {
          worst = std::max(worst, std::abs(pieces[(size_t)i] - whole[(size_t)i]));
        }
        expect(worst < 2e-5f, "blocks of " + juce::String(block) +
                                  " differ from one block by " +
                                  juce::String(worst, 7));
      }
    }
  }
};

static RenderPurityTests renderPurityTests;

}  // namespace celestrian
