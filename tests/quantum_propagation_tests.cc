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
