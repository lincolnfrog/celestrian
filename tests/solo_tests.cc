/**
 * SOLO CANON invariant tests (design_language.md Q16). Three
 * properties, each named:
 *
 *   ISLAND-WIDE: a solo anywhere silences every leaf without a soloed
 *     ancestor, across sibling stacks — not just within its own group.
 *   ADDITIVE:    multiple solos sum; solo is never a radio button.
 *   FRACTAL:     solo on a group covers its subtree (I5), resolved
 *     through snapshot parent indices on the audio thread.
 *
 * Plus the precedence rule: mute beats solo — a muted node, and every
 * node under a muted container, is silent even while soloed. And the
 * engine publishes solo as a per-node `isSoloed` flag.
 *
 * Twin: ui/js/tests/solo.test.mjs (mock flags + view-model exposure).
 *
 * Method: committed DC clips with DISTINCT amplitudes (0.1 / 0.2 /
 * 0.4) under two sibling stacks; the root's summed output at any
 * sample identifies exactly which subset sounded. Rendering runs the
 * production path — whole-graph snapshot + any_solo context flag.
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

class SoloTests : public juce::UnitTest {
 public:
  SoloTests() : juce::UnitTest("Solo Canon (Q16)", "Audio Engine") {}

  void runTest() override {
    constexpr double sr = 44100.0;
    constexpr int N = 441;  // exactly one solo fade

    // island root ── stackA ── a1 (0.1), a2 (0.2)
    //             └─ stackB ── b1 (0.4)
    StackNode root("island");
    auto stackA = std::make_unique<StackNode>("A");
    auto stackB = std::make_unique<StackNode>("B");
    auto a1o = test_utils::committedClip("a1", sr, 10 * N, 0.1f);
    auto a2o = test_utils::committedClip("a2", sr, 10 * N, 0.2f);
    auto b1o = test_utils::committedClip("b1", sr, 10 * N, 0.4f);
    ClipNode* a1 = a1o.get();
    ClipNode* a2 = a2o.get();
    ClipNode* b1 = b1o.get();
    StackNode* A = stackA.get();
    stackA->addChild(std::move(a1o));
    stackA->addChild(std::move(a2o));
    stackB->addChild(std::move(b1o));
    root.addChild(std::move(stackA));
    root.addChild(std::move(stackB));

    // The SETTLED audibility resolution, through the production path:
    // snapshot attached, any_solo scanned from the flags at the block
    // top. DC content: any mid sample works.
    auto rendered = [&]() {
      return test_utils::renderSettled(root, N).left[(size_t)(N / 2)];
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

    beginTest("mute beats solo: on the soloed node, and on its container");
    {
      clearSolos();
      a1->is_soloed.store(true);
      a1->is_muted.store(true);
      near(rendered(), 0.0f, "soloed-but-muted a1 is silent; rest soloed out");
      a1->is_muted.store(false);
      A->is_muted.store(true);
      near(rendered(), 0.0f, "a muted ancestor silences even a soloed child");
      A->is_muted.store(false);
      near(rendered(), 0.1f, "unmuted, the solo sounds");
      clearSolos();
    }

    beginTest("the engine publishes solo as a per-node isSoloed flag");
    {
      auto engine = std::make_unique<AudioEngine>();
      engine->createNode("clip");
      const juce::String a = test_utils::lastTopLevelId(*engine);
      engine->createNode("clip");
      const juce::String b = test_utils::lastTopLevelId(*engine);
      const auto soloed = [&](const juce::String& id) {
        return test_utils::deepBool(*engine, id, "isSoloed");
      };

      engine->toggleSolo(a);
      expect(soloed(a), "A soloed");
      engine->toggleSolo(b);  // ADDITIVE: B joins, A stays lit
      expect(soloed(a) && soloed(b), "solos sum - never radio-button");
      engine->toggleSolo(a);  // A off, B still lit
      expect(!soloed(a) && soloed(b), "un-solo is per-node too");
      engine->toggleSolo(b);
      expect(!soloed(a) && !soloed(b), "all clear");
    }
  }
};

static SoloTests soloTests;

}  // namespace celestrian
