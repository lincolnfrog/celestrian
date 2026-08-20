/**
 * SOLO CANON invariant tests (design_language.md Q16, ruled 2026-08-13)
 * — the group-arm treatment for solo. Three properties, each named:
 *
 *   ISLAND-WIDE: a solo anywhere silences every leaf without a soloed
 *     ancestor, across sibling stacks — not just within its own group.
 *   ADDITIVE:    multiple solos sum; solo is never a radio button.
 *   FRACTAL:     solo on a group covers its subtree (I5), resolved
 *     through snapshot parent indices on the audio thread.
 *
 * Plus the standing precedence rule (output_stage_tests): mute beats
 * solo — a muted node is silent even while soloed.
 *
 * Twin: ui/js/tests/solo.test.mjs (mock flags + view-model exposure).
 *
 * Method: committed DC clips with DISTINCT amplitudes (0.1 / 0.2 /
 * 0.4) under two sibling stacks; the root's summed output at any
 * sample identifies exactly which subset sounded. Rendering runs the
 * production path — whole-graph snapshot + any_solo context flag —
 * and once through the no-snapshot parent-pointer fallback.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <memory>
#include <vector>

#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** A committed clip carrying a constant-amplitude take, already
 * sounding (the output_stage_tests idiom). */
std::unique_ptr<ClipNode> makePlayingClip(const char* name, double sr,
                                          float amp, int len = 4410) {
  auto clip = std::make_unique<ClipNode>(name, sr);
  std::vector<float> in((size_t)len, amp);
  float* const ins[] = {in.data()};
  ProcessContext rec;
  rec.num_samples = len;
  rec.is_recording = true;
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec);
  clip->stopRecording();
  clip->startPlayback();
  return clip;
}

}  // namespace

class SoloTests : public juce::UnitTest {
 public:
  SoloTests() : juce::UnitTest("Solo Canon (Q16)", "Audio Engine") {}

  void runTest() override {
    constexpr double sr = 44100.0;
    constexpr int N = 441;

    // island root ── stackA ── a1 (0.1), a2 (0.2)
    //             └─ stackB ── b1 (0.4)
    StackNode root("island");
    auto stackA = std::make_unique<StackNode>("A");
    auto stackB = std::make_unique<StackNode>("B");
    auto a1o = makePlayingClip("a1", sr, 0.1f);
    auto a2o = makePlayingClip("a2", sr, 0.2f);
    auto b1o = makePlayingClip("b1", sr, 0.4f);
    ClipNode* a1 = a1o.get();
    ClipNode* a2 = a2o.get();
    ClipNode* b1 = b1o.get();
    StackNode* A = stackA.get();
    stackA->addChild(std::move(a1o));
    stackA->addChild(std::move(a2o));
    stackB->addChild(std::move(b1o));
    root.addChild(std::move(stackA));
    root.addChild(std::move(stackB));

    std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));

    // Render the root through the production path: snapshot attached,
    // any_solo scanned from the flags — exactly what the callback does.
    auto rendered = [&](bool use_snapshot = true) {
      std::vector<float> outL((size_t)N, 0.0f), outR((size_t)N, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = N;
      play.is_playing = true;
      if (use_snapshot) {
        play.snap = snap.get();
        play.self = 0;
        play.any_solo = snapAnySolo(*snap);
      } else {
        play.any_solo = a1->is_soloed.load() || a2->is_soloed.load() ||
                        b1->is_soloed.load() || A->is_soloed.load() ||
                        root.is_soloed.load();
      }
      // Two passes, read the second: solo edges FADE now (~10 ms, S7
      // smoothness law — sequencer.md §9; N = 441 = exactly one fade),
      // and these pins assert the SETTLED audibility resolution.
      root.process(nullptr, outs, 0, 2, play);
      std::fill(outL.begin(), outL.end(), 0.0f);
      std::fill(outR.begin(), outR.end(), 0.0f);
      root.process(nullptr, outs, 0, 2, play);
      return outL[(size_t)(N / 2)];  // DC content: any mid sample works
    };
    auto clearSolos = [&] {
      a1->is_soloed.store(false);
      a2->is_soloed.store(false);
      b1->is_soloed.store(false);
      A->is_soloed.store(false);
      root.is_soloed.store(false);
    };
    auto near = [&](float got, float want, const juce::String& what) {
      expectWithinAbsoluteError(got, want, 1.0e-5f, what);
    };

    beginTest("no solo: everything sounds");
    {
      clearSolos();
      near(rendered(), 0.7f, "0.1 + 0.2 + 0.4 all audible");
    }

    beginTest("ISLAND-WIDE: one solo silences siblings AND cousin stacks");
    {
      clearSolos();
      a1->is_soloed.store(true);
      near(rendered(), 0.1f,
           "solo a1: a2 (sibling) and b1 (other stack) both silent");
    }

    beginTest("ADDITIVE: two solos sum - never a radio button");
    {
      clearSolos();
      a1->is_soloed.store(true);
      b1->is_soloed.store(true);
      near(rendered(), 0.5f, "a1 + b1 both sound (0.1 + 0.4)");
      b1->is_soloed.store(false);
      near(rendered(), 0.1f, "un-solo b1: a1 keeps sounding alone");
    }

    beginTest("FRACTAL: solo on a group covers its subtree (I5)");
    {
      clearSolos();
      A->is_soloed.store(true);
      near(rendered(), 0.3f, "stack A soloed: a1 + a2 sound, b1 silent");
    }

    beginTest("mute beats solo (the output-stage precedence rule)");
    {
      clearSolos();
      a1->is_soloed.store(true);
      a1->is_muted.store(true);
      near(rendered(), 0.0f, "soloed-but-muted a1 is silent; rest soloed out");
      a1->is_muted.store(false);
    }

    beginTest("no-snapshot fallback resolves the same ancestry");
    {
      clearSolos();
      A->is_soloed.store(true);
      near(rendered(false), 0.3f,
           "parent-pointer walk (unit-test path) agrees with the snapshot");
      clearSolos();
    }
  }
};

static SoloTests soloTests;

}  // namespace celestrian
