/**
 * Latency Calibration Tests (docs/performance.md §7)
 *
 * Simulates a hardware loopback: each callback's output is fed back into
 * the next callbacks' input through a delay line of known length D. The
 * calibration must measure exactly D, and the measured value must show up
 * as the effective recording compensation in getGraphState().
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <vector>

#include "../src/audio_engine.h"

class LatencyCalibrationTests : public juce::UnitTest {
 public:
  LatencyCalibrationTests()
      : juce::UnitTest("Latency Calibration", "Audio Engine") {}

  void runTest() override {
    beginTest("Uncalibrated: reports idle and falls back to device latency");
    {
      AudioEngine engine;
      auto status = engine.getLatencyCalibration();
      expectEquals(status.getDynamicObject()->getProperty("phase").toString(),
                   juce::String("idle"));
      expect(!(bool)status.getDynamicObject()->getProperty("calibrated"));

      auto state = engine.getGraphState();
      auto perf = state.getDynamicObject()->getProperty("perf");
      expect(perf.getDynamicObject() != nullptr, "perf block present");
      expect(!(bool)perf.getDynamicObject()->getProperty("calibrated"));
    }

    beginTest("Loopback with known delay is measured exactly");
    {
      AudioEngine engine;
      engine.startLatencyCalibration();

      auto status = engine.getLatencyCalibration();
      expectEquals(status.getDynamicObject()->getProperty("phase").toString(),
                   juce::String("capturing"));

      const int D = 700;  // simulated round-trip in samples
      const int BLOCK = 512;
      runLoopback(engine, D, BLOCK, /*max_blocks=*/300);

      status = engine.getLatencyCalibration();
      auto *obj = status.getDynamicObject();
      expectEquals(obj->getProperty("phase").toString(), juce::String("done"));
      expect((bool)obj->getProperty("calibrated"));

      // Onset detection triggers on the first sample of the click, which
      // arrives exactly D samples after emission.
      expectEquals((int64_t)(double)obj->getProperty("roundTripSamples"),
                   (int64_t)D);

      // The empirical number becomes the effective recording compensation.
      auto state = engine.getGraphState();
      auto perf = state.getDynamicObject()->getProperty("perf");
      expect((bool)perf.getDynamicObject()->getProperty("calibrated"));
      expectEquals(
          (int64_t)(double)perf.getDynamicObject()->getProperty(
              "latencyCompensationSamples"),
          (int64_t)D);
    }

    beginTest("No loopback signal -> calibration fails cleanly");
    {
      AudioEngine engine;
      engine.startLatencyCalibration();

      // Drive the capture window with silent input (no feedback path).
      const int BLOCK = 512;
      std::vector<float> in((size_t)BLOCK, 0.0f);
      std::vector<float> outL((size_t)BLOCK, 0.0f), outR((size_t)BLOCK, 0.0f);
      const float *ins[] = {in.data()};
      float *outs[] = {outL.data(), outR.data()};

      for (int b = 0; b < 300; ++b) {
        engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, BLOCK, {});
        auto status = engine.getLatencyCalibration();
        auto phase =
            status.getDynamicObject()->getProperty("phase").toString();
        if (phase != "capturing") break;
      }

      auto status = engine.getLatencyCalibration();
      auto *obj = status.getDynamicObject();
      expectEquals(obj->getProperty("phase").toString(),
                   juce::String("failed"));
      expect(!(bool)obj->getProperty("calibrated"));
      expectEquals((int64_t)(double)obj->getProperty("roundTripSamples"),
                   (int64_t)-1);
    }

    beginTest("Instrumentation: perf meters update after callbacks");
    {
      AudioEngine engine;
      const int BLOCK = 512;
      std::vector<float> in((size_t)BLOCK, 0.0f);
      std::vector<float> outL((size_t)BLOCK, 0.0f), outR((size_t)BLOCK, 0.0f);
      const float *ins[] = {in.data()};
      float *outs[] = {outL.data(), outR.data()};

      for (int b = 0; b < 10; ++b) {
        engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, BLOCK, {});
      }

      auto state = engine.getGraphState();
      auto perf = state.getDynamicObject()->getProperty("perf");
      auto *obj = perf.getDynamicObject();
      expect(obj != nullptr);
      // An empty graph can complete in <1 µs (truncates to 0), so assert
      // presence and sanity rather than a strictly positive duration.
      expect(obj->hasProperty("maxBlockUs"));
      expect((double)obj->getProperty("maxBlockUs") >= 0.0);
      expect((double)obj->getProperty("avgLoadPct") >= 0.0);
      expect(obj->hasProperty("xruns"));
    }
  }

 private:
  /**
   * Feeds engine output back to engine input through a delay of D samples,
   * until the calibration capture completes or max_blocks is reached.
   */
  void runLoopback(AudioEngine &engine, int D, int block, int max_blocks) {
    std::vector<float> history;  // all output samples, global timeline
    history.reserve((size_t)(max_blocks * block));

    std::vector<float> in((size_t)block, 0.0f);
    std::vector<float> outL((size_t)block, 0.0f), outR((size_t)block, 0.0f);
    const float *ins[] = {in.data()};
    float *outs[] = {outL.data(), outR.data()};

    for (int b = 0; b < max_blocks; ++b) {
      // input[i] at global sample g = output emitted at g - D
      const int64_t block_start = (int64_t)b * block;
      for (int i = 0; i < block; ++i) {
        const int64_t src = block_start + i - D;
        in[(size_t)i] =
            (src >= 0 && src < (int64_t)history.size())
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

static LatencyCalibrationTests latencyCalibrationTests;
