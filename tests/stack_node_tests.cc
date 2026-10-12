#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {

class StackNodeTests : public juce::UnitTest {
 public:
  StackNodeTests() : juce::UnitTest("StackNode", "Audio Engine") {}

  void runTest() override {
    // (Q, zero) are written by a commit or an import on the island root
    // and by NOTHING else — attaching committed content, attached or
    // detached, establishes no facts.
    beginTest("Attaching committed content establishes no island facts");
    {
      auto committed = [](const char* name, int64_t origin, int64_t len) {
        auto clip = std::make_unique<ClipNode>(name, 44100.0);
        clip->origin_samples.store(origin);
        juce::AudioBuffer<float> audio(1, (int)len);
        audio.clear();
        clip->loadCommitted(audio, 0);
        return clip;
      };
      StackNode root("Root");
      root.addChild(committed("A", 500, 1000));
      expectEquals(root.getQuantum(), (int64_t)0, "addChild writes no Q");
      expectEquals(root.getZero(), (int64_t)0, "nor a zero");

      // A DETACHED assembly (Combine builds its stack before inserting
      // it; the undo log holds subtrees) is its own rootNode(): it must
      // hold no private grid when it is attached.
      auto group = std::make_unique<StackNode>("Group");
      group->addChild(committed("B", 700, 2000));
      expectEquals(group->getQuantum(), (int64_t)0,
                   "a detached assembly holds no island facts");
      root.insertChildAt(std::move(group), 0);
      expectEquals(root.getQuantum(), (int64_t)0,
                   "insertChildAt writes no Q either");
      expectEquals(root.getEffectiveQuantum(), (int64_t)0,
                   "the island has no Q until a take commits");

      expectEquals(root.getNumChildren(), 2, "both are children of the root");
      root.clearChildren();
      expectEquals(root.getNumChildren(), 0, "clearChildren detaches them all");
    }

    beginTest("The window predicate is the active map: bypass, suspension "
              "and the step audition");
    {
      StackNode stack("Group");
      const auto check = [&](bool want_active, bool want_suspended,
                             const juce::String& state) {
        expect(stack.activeTimeMap().active() == want_active,
               state + ": the active map");
        expect(stack.isLoopWindowActive() == want_active,
               state + ": isLoopWindowActive agrees with it");
        expect(stack.windowSuspended() == want_suspended,
               state + ": windowSuspended");
      };
      check(false, false, "no geometry");
      stack.setLoopPoints(1000, 3000);
      check(true, false, "an intrinsic window");
      stack.setLoopWindowBypassed(true);
      check(false, false, "bypassed");
      stack.setLoopWindowBypassed(false);

      // A sequence-domain window with no active sequence is suspended;
      // bypassed, there is nothing left to suspend.
      stack.setWindowDomain(StackNode::WindowDomain::Sequence);
      check(false, true, "sequence domain, no sequence");
      stack.setLoopWindowBypassed(true);
      check(false, false, "sequence domain, no sequence, bypassed");
      stack.setLoopWindowBypassed(false);

      auto* song = new Sequence();
      song->steps.push_back({4000, "a"});
      song->finalize();
      delete stack.exchangeSequence(song);
      check(true, false, "sequence domain, sequence on");
      stack.setSequenceBypassed(true);
      check(false, true, "sequence domain, sequence bypassed");
      stack.setSequenceBypassed(false);

      // The audition's derived map is active with no authored geometry.
      stack.setLoopPoints(0, 0);
      check(false, false, "no geometry under a sequence");
      stack.setAuditionStep(0);
      check(true, false, "a step audition");
      expectEquals(stack.activeTimeMap().period(), (int64_t)4000,
                   "the audition's map is the step");
    }
  }
};

static StackNodeTests stackNodeTests;

}  // namespace celestrian
