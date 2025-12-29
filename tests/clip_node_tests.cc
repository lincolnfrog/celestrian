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
      expect(node.isRecording());

      node.stopRecording();
      // Test might fail if no samples, but let's check current logic
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

      float input[10] = {0.8f};
      float *const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = false; // If false, node should NOT capture

      node.process(inputs, nullptr, 1, 0, context);
      expectEquals(node.getWritePos(), 0);
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
      expectWithinAbsoluteError(node.get_current_peak(), 0.7f, 0.001f);
    }
  }
};

static ClipNodeTests clipNodeTests;

} // namespace celestrian
