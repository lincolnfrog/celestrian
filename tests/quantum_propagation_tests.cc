#include <juce_core/juce_core.h>

#include "../src/stack_node.h"
#include "../src/clip_node.h"

namespace celestrian {

class QuantumPropagationTests : public juce::UnitTest {
 public:
  QuantumPropagationTests()
      : juce::UnitTest("Quantum Propagation", "Audio Engine") {}

  void runTest() override {
    float dummy[10000] = {0.0f};
    float *const inputs[] = {dummy};

    beginTest("Recursive Discovery");
    {
      StackNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip1Ptr = clip1.get();
      root.addChild(std::move(clip1));

      auto subBox = std::make_unique<StackNode>("SubBox");
      auto subBoxPtr = subBox.get();
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);
      auto clip2Ptr = clip2.get();
      subBoxPtr->addChild(std::move(clip2));
      root.addChild(std::move(subBox));

      // Establish quantum in clip1
      clip1Ptr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 100;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);

      clip1Ptr->stopRecording();
      expectEquals((int)clip1Ptr->getIntrinsicDuration(), 100);
      expectEquals((int)root.getEffectiveQuantum(), 100);
    }

    beginTest("Stored Quantum: survives shorter clips and its creator");
    {
      // P0-3 (kernel.md step 1) + owner rulings (design_language.md Q1):
      // Q is stored island state — a shorter committed clip must not
      // retroactively change it, and deleting the establishing clip must
      // not orphan it ("the DNA of the original scratch track remains").
      StackNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("QClip", 44100.0);
      auto *c1 = clip1.get();
      root.addChild(std::move(clip1));

      ProcessContext ctx;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      c1->startRecording();
      ctx.num_samples = 1000;
      c1->process(inputs, nullptr, 1, 0, ctx);
      c1->stopRecording();  // first clip -> immediate commit, Q = 1000
      expectEquals(root.getQuantum(), (int64_t)1000);
      expectEquals(root.getEpoch(), (int64_t)0);

      // A short overdub snapping to the Q/2 subdivision (480 -> 500)
      // must NOT halve Q (the old min-derivation did exactly that).
      auto clip2 = std::make_unique<ClipNode>("Short", 44100.0);
      auto *c2 = clip2.get();
      root.addChild(std::move(clip2));

      c2->startRecording();
      ctx.num_samples = 480;
      c2->process(inputs, nullptr, 1, 0, ctx);
      c2->stopRecording();  // L=480 < Q/2 -> awaits the 500 subdivision
      ctx.master_pos = 480;
      ctx.num_samples = 100;
      c2->process(inputs, nullptr, 1, 0, ctx);  // crosses 500 -> commit

      expectEquals(c2->getIntrinsicDuration(), (int64_t)500);
      expectEquals(root.getEffectiveQuantum(), (int64_t)1000,
                   "Q must not change when a shorter clip commits");

      // Q survives its creator: delete the establishing clip.
      root.removeChild(c1->getUuid());
      expectEquals(root.getEffectiveQuantum(), (int64_t)1000,
                   "Q survives deletion of the clip that established it");
    }

    beginTest("Composite duration is the LCM of children, not the min");
    {
      StackNode root("Root");
      auto q = std::make_unique<ClipNode>("QClip", 44100.0);
      auto *qPtr = q.get();
      root.addChild(std::move(q));

      ProcessContext ctx;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      qPtr->startRecording();
      ctx.num_samples = 1000;
      qPtr->process(inputs, nullptr, 1, 0, ctx);
      qPtr->stopRecording();  // Q = 1000

      // Nested stack with 1000- and 1500-sample clips: composite = 3000.
      auto makeCommitted = [&](int len) {
        auto clip = std::make_unique<ClipNode>("C", 44100.0);
        clip->startRecording();
        ProcessContext c;
        c.is_recording = true;
        c.num_samples = len;
        clip->process(inputs, nullptr, 1, 0, c);
        clip->stopRecording();
        return clip;
      };
      auto sub = std::make_unique<StackNode>("Sub");
      auto *subPtr = sub.get();
      root.addChild(std::move(sub));  // attach BEFORE filling: shares island
      subPtr->addChild(makeCommitted(1000));
      subPtr->addChild(makeCommitted(1500));

      expectEquals(subPtr->getIntrinsicDuration(), (int64_t)3000,
                   "composite duration = LCM(1000, 1500)");
      expectEquals(subPtr->getEffectiveQuantum(), (int64_t)1000,
                   "nested stack inherits the island quantum");
    }

    beginTest("Hysteresis Snapping (Late Snap)");
    {
      StackNode root("Root");
      auto masterClip = std::make_unique<ClipNode>("Master", 44100.0);
      auto masterPtr = masterClip.get();
      root.addChild(std::move(masterClip));

      masterPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      masterPtr->process(inputs, nullptr, 1, 0, ctx);
      masterPtr->stopRecording();

      auto slaveClip = std::make_unique<ClipNode>("Slave", 44100.0);
      auto slavePtr = slaveClip.get();
      root.addChild(std::move(slaveClip));

      slavePtr->startRecording();
      ctx.num_samples = 1100;  // 1.1x Q. Threshold 15%.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      // Need to process past the 2000 boundary (next Q after 1100)
      ctx.master_pos = 1100;
      ctx.num_samples = 1000;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expectEquals((int)slavePtr->getIntrinsicDuration(), 2000);
      expectEquals((int)slavePtr->getLoopEnd(), 2000);
    }

    beginTest("Hysteresis Snapping (Anticipatory Stop)");
    {
      StackNode root("Root");
      auto masterClip = std::make_unique<ClipNode>("Master", 44100.0);
      auto masterPtr = masterClip.get();
      root.addChild(std::move(masterClip));

      masterPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      masterPtr->process(inputs, nullptr, 1, 0, ctx);
      masterPtr->stopRecording();

      auto slaveClip = std::make_unique<ClipNode>("Slave", 44100.0);
      auto slavePtr = slaveClip.get();
      root.addChild(std::move(slaveClip));

      slavePtr->startRecording();
      ctx.num_samples = 950;  // 0.95x Q. Tolerance is 10% (100 samples).
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expect(slavePtr->isRecording());  // Still recording!

      // Process past the 1000 boundary
      ctx.num_samples = 100;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expect(!slavePtr->isRecording());
      expectEquals((int)slavePtr->getIntrinsicDuration(), 1000);
      expectEquals((int)slavePtr->getLoopEnd(), 1000);
    }

    beginTest("Hysteresis Snapping (Raw Stop + Loop Snap)");
    {
      StackNode root("Root");
      auto masterClip = std::make_unique<ClipNode>("Master", 44100.0);
      auto masterPtr = masterClip.get();
      root.addChild(std::move(masterClip));

      masterPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      masterPtr->process(inputs, nullptr, 1, 0, ctx);
      masterPtr->stopRecording();

      auto slaveClip = std::make_unique<ClipNode>("Slave", 44100.0);
      auto slavePtr = slaveClip.get();
      root.addChild(std::move(slaveClip));

      slavePtr->startRecording();
      ctx.num_samples = 2500;  // 2.5x Q. Threshold 15% (150 samples).
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      // Process past the 3000 boundary (next Q after 2500)
      ctx.master_pos = 2500;
      ctx.num_samples = 600;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expect(!slavePtr->isRecording());  // Should be stopped now
      expectEquals((int)slavePtr->getIntrinsicDuration(), 3000);

      // Loop Region should be snapped to 3000
      expectEquals((int)slavePtr->getLoopEnd(), 3000);
    }

    beginTest("Hysteresis Snapping (Raw Stop + Short Q)");
    {
      StackNode root("Root");
      auto masterClip = std::make_unique<ClipNode>("Master", 44100.0);
      auto masterPtr = masterClip.get();
      root.addChild(std::move(masterClip));

      masterPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      masterPtr->process(inputs, nullptr, 1, 0, ctx);
      masterPtr->stopRecording();

      auto slaveClip = std::make_unique<ClipNode>("Slave", 44100.0);
      auto slavePtr = slaveClip.get();
      root.addChild(std::move(slaveClip));

      slavePtr->startRecording();
      ctx.num_samples = 700;  // Outside 150 samples of 500 or 1000.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);
      slavePtr->stopRecording();

      // Process past the 1000 boundary (next Q after 700)
      ctx.master_pos = 700;
      ctx.num_samples = 400;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expectEquals((int)slavePtr->getIntrinsicDuration(), 1000);
      // Should snap to Q = 1000
      expectEquals((int)slavePtr->getLoopEnd(), 1000);
    }
  }
};

static QuantumPropagationTests quantumPropagationTests;

}  // namespace celestrian
