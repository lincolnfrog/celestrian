#include "../src/box_node.h"
#include "../src/clip_node.h"
#include <juce_core/juce_core.h>

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
      BoxNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip1Ptr = clip1.get();
      root.addChild(std::move(clip1));

      auto subBox = std::make_unique<BoxNode>("SubBox");
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
      BoxNode root("Root");
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
      ctx.num_samples = 1100; // 1.1x Q. Threshold 15%.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expectEquals((int)slavePtr->getIntrinsicDuration(), 1000);
      expectEquals((int)slavePtr->getLoopEnd(), 1000);
    }

    beginTest("Hysteresis Snapping (Anticipatory Stop)");
    {
      BoxNode root("Root");
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
      ctx.num_samples = 950; // 0.95x Q. Tolerance is 10% (100 samples).
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expect(slavePtr->isRecording()); // Still recording!

      // Process past the 1000 boundary
      ctx.num_samples = 100;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expect(!slavePtr->isRecording());
      expectEquals((int)slavePtr->getIntrinsicDuration(), 1000);
      expectEquals((int)slavePtr->getLoopEnd(), 1000);
    }

    beginTest("Hysteresis Snapping (Raw Stop + Loop Snap)");
    {
      BoxNode root("Root");
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
      ctx.num_samples = 2500; // 2.5x Q. Threshold 15% (150 samples).
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expect(!slavePtr->isRecording()); // Stopped immediately
      expectEquals((int)slavePtr->getIntrinsicDuration(), 2500);

      // Loop Region should be snapped to 2000 (nearest previous multiple)
      expectEquals((int)slavePtr->getLoopEnd(), 2000);
    }

    beginTest("Hysteresis Snapping (Raw Stop + Short Q)");
    {
      BoxNode root("Root");
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
      ctx.num_samples = 700; // Outside 150 samples of 500 or 1000.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);
      slavePtr->stopRecording();

      expectEquals((int)slavePtr->getIntrinsicDuration(), 700);
      // Should default to Q/2 = 500
      expectEquals((int)slavePtr->getLoopEnd(), 500);
    }
  }
};

static QuantumPropagationTests quantumPropagationTests;

} // namespace celestrian
