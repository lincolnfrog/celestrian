#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"

namespace celestrian {

class FirstClipBugTests : public juce::UnitTest {
 public:
  FirstClipBugTests() : juce::UnitTest("FirstClipBug", "Bug Reproduction") {}

  void runTest() override {
    beginTest("Repro: First Recorded Clip Loops Incorrectly");
    {
      AudioEngine engine;  // New engine (starts fresh)

      // Helper to process audio
      const int BLOCK_SIZE = 512;
      std::vector<float> buffer(BLOCK_SIZE, 0.0f);
      float* ins[] = {buffer.data()};
      float* outs[] = {buffer.data(), buffer.data()};

      auto process = [&](int total_samples) {
        int remaining = total_samples;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK_SIZE);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };

      // 1. Create a single clip node
      engine.createNode("clip", 0, 0);
      auto state = engine.getGraphState();
      juce::String clipId = state.getDynamicObject()
                                ->getProperty("nodes")
                                .getArray()
                                ->getReference(0)
                                .getDynamicObject()
                                ->getProperty("id");

      // 2. Start Recording
      // This is the FIRST clip.
      // Expected: AudioEngine resets global transport to 0 internally on start.
      engine.startRecordingInNode(clipId);

      // 3. Record for a specific duration (e.g., 3s = 132300 samples)
      // This is 3Q at 44100.
      const int64_t REC_DUR = 132300;
      process(REC_DUR);

      // 4. Stop Recording
      engine.stopRecordingInNode(clipId);

      // 5. Commit (process small block to trigger logic)
      process(512);

      // 6. Verify Key State
      // - Loop Start should be 0
      // - Loop End should be REC_DUR
      // - Transport Position should be ~0 (snapped to start)

      state = engine.getGraphState();
      int64_t masterPos =
          (int64_t)state.getDynamicObject()->getProperty("masterPos");

      auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
      int64_t loopStart =
          (int64_t)nodes->getReference(0).getDynamicObject()->getProperty(
              "loopStart");
      int64_t loopEnd =
          nodes->getReference(0).getDynamicObject()->getProperty("loopEnd");

      juce::Logger::writeToLog("REPRO TEST: Post-Commit MasterPos = " +
                               juce::String(masterPos));
      juce::Logger::writeToLog(
          "REPRO TEST: LoopStart=" + juce::String(loopStart) +
          " LoopEnd=" + juce::String(loopEnd));

      expectEquals(loopStart, (int64_t)0);
      expectEquals(loopEnd, REC_DUR);

      // FIX VERIFICATION:
      // If the bug occurs, masterPos might be REC_DUR (not snapped) or some
      // random value. If the fix (First Clip Snap) works, it should be very
      // small (just the last block processed). We expect it to snap to 0 +
      // block_size.
      expect(masterPos < 2000,
             "Transport should snap to near 0 after first clip recording. "
             "Actual: " +
                 juce::String(masterPos));
    }

    beginTest("Repro: Short First Clip (< Q) Snap");
    {
      AudioEngine engine;
      const int BLOCK_SIZE = 512;
      std::vector<float> buffer(BLOCK_SIZE, 0.0f);
      float* ins[] = {buffer.data()};
      float* outs[] = {buffer.data(), buffer.data()};

      auto process = [&](int total_samples) {
        int remaining = total_samples;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK_SIZE);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };

      engine.createNode("clip", 0, 0);
      auto state = engine.getGraphState();
      juce::String clipId = state.getDynamicObject()
                                ->getProperty("nodes")
                                .getArray()
                                ->getReference(0)
                                .getDynamicObject()
                                ->getProperty("id");

      engine.startRecordingInNode(clipId);

      // Record VERY SHORT clip (e.g. 1000 samples). Less than default Q=44100.
      const int64_t SHORT_DUR = 1000;
      process(SHORT_DUR);

      engine.stopRecordingInNode(clipId);
      process(512);  // Commit

      state = engine.getGraphState();
      int64_t masterPos =
          (int64_t)state.getDynamicObject()->getProperty("masterPos");

      juce::Logger::writeToLog("SHORT REPRO: MasterPos=" +
                               juce::String(masterPos));

      // Even for short clips, if it's the FIRST clip, we probably want to snap
      // to 0 so the loop starts comfortably.
      expect(masterPos < 2000,
             "Short first clip should also snap transport to 0. Actual: " +
                 juce::String(masterPos));
    }
  }
};

static FirstClipBugTests firstClipBugTests;

}  // namespace celestrian
