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
      ctx.num_samples = 950; // 0.95x Q. Tolerance is 10%.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expect(slavePtr->isRecording()); // Still recording!

      // Process past the 1000 boundary
      ctx.num_samples = 100;
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      expect(!slavePtr->isRecording());
      expectEquals((int)slavePtr->getIntrinsicDuration(), 1000);
    }

    beginTest("Hysteresis Snapping (Early but outside threshold)");
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
      ctx.num_samples = 800; // 0.8x Q. Threshold 10%.
      slavePtr->process(inputs, nullptr, 1, 0, ctx);

      slavePtr->stopRecording();
      expect(!slavePtr->isRecording()); // Stopped immediately
      expectEquals((int)slavePtr->getIntrinsicDuration(), 800);
    }

    beginTest("Loop Region Check");
    {
      BoxNode root("Root");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();
      root.addChild(std::move(clip));

      clipPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 1234;
      ctx.is_recording = true;
      ctx.master_pos = 0;
      clipPtr->process(inputs, nullptr, 1, 0, ctx);
      clipPtr->stopRecording();

      expectEquals((int)clipPtr->getLoopStart(), 0);
      expectEquals((int)clipPtr->getLoopEnd(), 1234);
    }
  }
};

static QuantumPropagationTests quantumPropagationTests;

} // namespace celestrian
