#include "../src/box_node.h"
#include "../src/clip_node.h"
#include <juce_core/juce_core.h>

namespace celestrian {

class ClipNodeTests : public juce::UnitTest {
public:
  ClipNodeTests() : juce::UnitTest("ClipNode", "Audio Engine") {}

  void runTest() override {
    beginTest("Recording State");
    {
      ClipNode node("TestClip", 44100.0);
      expect(!node.isRecording());

      node.startRecording();
      expect(node.isPendingStart()); // New behavior: waits for audio thread
      expect(!node.isRecording());

      // Trigger the audio thread start
      ProcessContext ctx;
      ctx.num_samples = 1;
      ctx.is_recording = true;
      node.process(nullptr, nullptr, 0, 0, ctx);

      expect(node.isRecording());
      expect(!node.isPendingStart());

      node.stopRecording();
      expect(!node.isRecording());
    }

    beginTest("Buffer Writing");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      // Simulate processing 100 samples
      float input[100];
      for (int i = 0; i < 100; ++i)
        input[i] = 1.0f; // DC signal
      float *const inputs[] = {input};

      ProcessContext context;
      context.num_samples = 100;
      context.is_recording = true;

      // First process starts it and captures 100 samples
      node.process(inputs, nullptr, 1, 0, context);

      expectEquals(node.getWritePos(), 100);

      // Verify peek
      auto waveform = node.getWaveform(1);
      expect(waveform.isArray());
      expectEquals((float)waveform[0], 1.0f);
    }

    beginTest("Playback State");
    {
      ClipNode node("TestClip", 44100.0);
      expect(!node.isPlaying());

      // Can't play if no samples
      node.startPlayback();
      expect(!node.isPlaying());

      // Write some samples
      float input[10] = {0.5f};
      float *const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true;
      node.startRecording();
      node.process(inputs, nullptr, 1, 0, context);
      node.stopRecording();

      node.startPlayback();
      expect(node.isPlaying());
    }

    beginTest("Auto-Playback After Recording");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      float input[10] = {0.8f};
      float *const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true; // MUST be true for node to capture

      node.process(inputs, nullptr, 1, 0, context);
      node.stopRecording();

      expect(node.isPlaying()); // New behavior: auto-starts playback
      expectEquals(node.getWritePos(), 10);
    }

    beginTest("Capture Validation (Requires Context Flag)");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      // First process call to start the recording
      ProcessContext context;
      context.num_samples = 1;
      context.is_recording = true;
      node.process(nullptr, nullptr, 0, 0, context);
      expect(node.isRecording());
      int initialWritePos = node.getWritePos();

      float input[10] = {0.8f};
      float *const inputs[] = {input};
      context.num_samples = 10;
      context.is_recording = false; // If false, node should NOT capture

      node.process(inputs, nullptr, 1, 0, context);
      expectEquals(node.getWritePos(), initialWritePos);
    }

    beginTest("Peak Tracking");
    {
      ClipNode node("TestPeak", 44100.0);
      node.startRecording();

      float input[10] = {0.5f, -0.7f, 0.2f, 0.0f, 0.0f,
                         0.0f, 0.0f,  0.0f, 0.0f, 0.0f};
      float *const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true;

      node.process(inputs, nullptr, 1, 0, context);
      expectWithinAbsoluteError(node.getCurrentPeak(), 0.7f, 0.001f);
    }

    beginTest("Cyclic Shift (Rotation)");
    {
      const double SR = 100.0;
      auto node = std::make_unique<ClipNode>("TestRotation", SR);
      auto *nodePtr = node.get();

      BoxNode parent("Parent");
      // Set parent quantum by adding a dummy clip that defines it
      auto dummy = std::make_unique<ClipNode>("Dummy", SR);
      float dummyIn[100] = {0.0f};
      float *const dummyIns[] = {dummyIn};
      ProcessContext dummyCtx;
      dummyCtx.num_samples = 100;
      dummyCtx.is_recording = true;
      dummy->startRecording();
      dummy->process(dummyIns, nullptr, 1, 0, dummyCtx);
      dummy->stopRecording();
      parent.addChild(std::move(dummy));

      expectEquals(parent.getEffectiveQuantum(), (int64_t)100);

      parent.addChild(std::move(node));

      // Start recording at master_pos = 125 (Phase = 25 relative to Q=100)
      ProcessContext ctx;
      ctx.num_samples = 50;
      ctx.master_pos = 125;
      ctx.is_recording = true;

      // First sample is 0.5, rest 0.0
      float input[50] = {0.0f};
      input[0] = 0.5f;
      float *const inputs[] = {input};

      nodePtr->startRecording();
      // This process call should anchor at 125 and capture 50 samples
      nodePtr->process(inputs, nullptr, 1, 0, ctx);

      // Stop recording at L=50.
      // Q=100, hysteresis will snap L=50 to B=50?
      // Actually candidates are {Q, 2Q..., Q/2, Q/4...}.
      // 50 is Q/2. 50 is exactly Q/2, so it snaps to 50.
      nodePtr->stopRecording();

      expectEquals(nodePtr->duration_samples.load(), (int64_t)50);

      // The phase was 125 % 50 (if snapped to 50) = 25.
      // Or 125 % 100 = 25.
      // Either way, shift is 25.
      // Original buffer[0] (0.5) should move to buffer[(0 + 25) % 50] =
      // buffer[25].

      const float *data = nodePtr->getAudioBuffer().getReadPointer(0);
      expectEquals(data[25], 0.5f);
      expectEquals(data[0], 0.0f);
    }
  }
};

static ClipNodeTests clipNodeTests;

} // namespace celestrian
