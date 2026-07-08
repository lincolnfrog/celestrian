/**
 * Pre-Record Ring / Arrival-Time Capture Tests (docs/performance.md §3)
 *
 * The alignment invariant under test: a note played on the HEARD beat must
 * land ON the beat in the committed clip. The note's audio arrives at the
 * input `round-trip latency` samples after the beat, so capture must map
 * clip position 0 to the input that arrived at (boundary + latency) — not
 * to whatever arrived when the recording state flipped.
 *
 * Scenario:
 *   1. Calibrate a synthetic loopback of exactly D samples.
 *   2. Record clip A (1Q = 1000 samples) to establish the grid.
 *   3. Arm clip B mid-loop; it waits for the 1000 boundary.
 *   4. Inject an impulse whose ARRIVAL is exactly D samples after the
 *      boundary — the arrival time of a note played on the heard beat.
 *   5. After commit, the impulse must sit at clip position 0.
 *      (Pre-fix behavior put it at position D + block remainder.)
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <vector>

#include "../src/audio_engine.h"

class PreRecordTests : public juce::UnitTest {
 public:
  PreRecordTests() : juce::UnitTest("Pre-Record Capture", "Audio Engine") {}

  void runTest() override {
    beginTest("Note played on the heard beat lands at clip position 0");
    {
      const int D = 137;      // calibrated round-trip latency
      const int BLOCK = 500;  // even divisor of the 1000-sample loop

      AudioEngine engine;

      // --- 1. Calibrate a synthetic loopback of exactly D samples ---
      // Loopback block must be < D: the harness can only feed back output
      // from *previous* callbacks (real hardware has no such limit).
      engine.startLatencyCalibration();
      runLoopback(engine, D, 128, 800);
      auto cal = engine.getLatencyCalibration();
      expectEquals(
          (int64_t)(double)cal.getDynamicObject()->getProperty(
              "roundTripSamples"),
          (int64_t)D, "calibration must measure the loopback exactly");

      // --- 2. Record clip A: 1000 samples -> Q = 1000 ---
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);  // resets transport to 0
      processSilence(engine, BLOCK);
      processSilence(engine, BLOCK);
      engine.stopRecordingInNode(clipA);  // no Q yet -> immediate commit
      expectEquals(nodeDuration(engine, 0), (int64_t)1000,
                   "clip A defines a 1000-sample grid");

      // --- 3. Walk the transport to master == 500 (mid-loop) ---
      bool at_mid = false;
      for (int i = 0; i < 8; ++i) {
        if (masterPos(engine) == 500) {
          at_mid = true;
          break;
        }
        processSilence(engine, BLOCK);
      }
      expect(at_mid, "transport reaches master == 500");

      // --- 4. Arm clip B and cross the boundary ---
      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);

      // Block master 500 -> 1000: B arms for the 1000 boundary and starts
      // recording as the block crosses it. Its capture window begins at
      // the arrival time of performance-time 1000, i.e. D samples after
      // the boundary — which is D-BLOCK+... into the NEXT block's input.
      processSilence(engine, BLOCK);

      // --- 5. The "note on the heard beat": arrival = boundary + D ---
      // Relative to this next block (arrivals cover boundary..boundary+500),
      // the note's arrival offset is exactly D.
      std::vector<float> in((size_t)BLOCK, 0.0f);
      in[(size_t)D] = 0.8f;
      processBlock(engine, in.data(), BLOCK);

      // --- 6. Stop; capture runs until the 1000-sample window closes ---
      processSilence(engine, BLOCK);
      engine.stopRecordingInNode(clipB);  // L < 1000 -> awaits boundary 1000
      for (int i = 0; i < 4 && nodeIsRecording(engine, 1); ++i) {
        processSilence(engine, BLOCK);
      }

      expectEquals(nodeDuration(engine, 1), (int64_t)1000,
                   "clip B snaps to 1Q");

      // --- 7. The impulse must be at clip position 0 ---
      auto wf = engine.getWaveform(clipB, 1000);
      expect(wf.isArray());
      auto *peaks = wf.getArray();
      expectWithinAbsoluteError((float)peaks->getReference(0), 0.8f, 0.0001f,
                                "note played on the heard beat lands at "
                                "clip position 0");

      // Regression guard: the pre-fix live-block capture would have placed
      // the impulse D samples late (plus block remainder). Ensure the rest
      // of the clip is silent.
      float residual = 0.0f;
      for (int i = 1; i < 1000; ++i) {
        residual = std::max(residual, (float)peaks->getReference(i));
      }
      expectWithinAbsoluteError(residual, 0.0f, 0.0001f,
                                "no misplaced copy of the note elsewhere");
    }

    beginTest("Uncalibrated engines still capture from the block start");
    {
      // With zero latency the window collapses to the boundary itself:
      // first-clip capture must be byte-identical to the old behavior.
      AudioEngine engine;
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      std::vector<float> in(500, 0.0f);
      in[0] = 0.5f;  // first captured sample
      processBlock(engine, in.data(), 500);
      processSilence(engine, 500);
      engine.stopRecordingInNode(clipA);

      expectEquals(nodeDuration(engine, 0), (int64_t)1000);
      auto wf = engine.getWaveform(clipA, 1000);
      expectWithinAbsoluteError((float)wf.getArray()->getReference(0), 0.5f,
                                0.0001f,
                                "first arrival lands at position 0");
    }
  }

 private:
  void processBlock(AudioEngine &engine, const float *in, int n) {
    std::vector<float> outL((size_t)n, 0.0f), outR((size_t)n, 0.0f);
    const float *ins[] = {in};
    float *outs[] = {outL.data(), outR.data()};
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
  }

  void processSilence(AudioEngine &engine, int n) {
    std::vector<float> in((size_t)n, 0.0f);
    processBlock(engine, in.data(), n);
  }

  int64_t masterPos(AudioEngine &engine) {
    return (int64_t)(double)engine.getGraphState()
        .getDynamicObject()
        ->getProperty("masterPos");
  }

  juce::String firstNodeId(AudioEngine &engine) {
    return engine.getGraphState()
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(0)
        .getDynamicObject()
        ->getProperty("id");
  }

  juce::var childVar(AudioEngine &engine, int index) {
    return engine.getGraphState()
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(0)
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(index);
  }

  juce::String childId(AudioEngine &engine, int index) {
    return childVar(engine, index).getDynamicObject()->getProperty("id");
  }

  int64_t nodeDuration(AudioEngine &engine, int index) {
    return (int64_t)(double)childVar(engine, index)
        .getDynamicObject()
        ->getProperty("duration");
  }

  bool nodeIsRecording(AudioEngine &engine, int index) {
    return (bool)childVar(engine, index).getDynamicObject()->getProperty(
        "isRecording");
  }

  /** Output→input feedback through a delay of D samples (see
      latency_calibration_tests.cc). */
  void runLoopback(AudioEngine &engine, int D, int block, int max_blocks) {
    std::vector<float> history;
    history.reserve((size_t)(max_blocks * block));

    std::vector<float> in((size_t)block, 0.0f);
    std::vector<float> outL((size_t)block, 0.0f), outR((size_t)block, 0.0f);
    const float *ins[] = {in.data()};
    float *outs[] = {outL.data(), outR.data()};

    for (int b = 0; b < max_blocks; ++b) {
      const int64_t block_start = (int64_t)b * block;
      for (int i = 0; i < block; ++i) {
        const int64_t src = block_start + i - D;
        in[(size_t)i] = (src >= 0 && src < (int64_t)history.size())
                            ? history[(size_t)src]
                            : 0.0f;
      }
      std::fill(outL.begin(), outL.end(), 0.0f);
      std::fill(outR.begin(), outR.end(), 0.0f);
      engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, block, {});
      history.insert(history.end(), outL.begin(), outL.end());

      auto status = engine.getLatencyCalibration();
      if (status.getDynamicObject()->getProperty("phase").toString() !=
          "capturing")
        return;
    }
  }
};

static PreRecordTests preRecordTests;
