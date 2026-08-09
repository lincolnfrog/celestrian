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
#include "test_utils.h"

using celestrian::test_utils::runLoopback;

namespace {

/**
 * Minimal AudioIODevice for driving audioDeviceAboutToStart in tests:
 * reports a fixed config (44.1 kHz, 512 block, 200/300 sample latencies)
 * under a configurable name so device-keyed calibration persistence can be
 * exercised without hardware.
 */
class FakeDevice : public juce::AudioIODevice {
 public:
  explicit FakeDevice(const juce::String& name, double sample_rate = 44100.0)
      : juce::AudioIODevice(name, "Test"), sample_rate_(sample_rate) {}

  juce::StringArray getOutputChannelNames() override { return {"L", "R"}; }
  juce::StringArray getInputChannelNames() override { return {"In"}; }
  juce::Array<double> getAvailableSampleRates() override {
    return {sample_rate_};
  }
  juce::Array<int> getAvailableBufferSizes() override { return {512}; }
  int getDefaultBufferSize() override { return 512; }
  juce::String open(const juce::BigInteger&, const juce::BigInteger&, double,
                    int) override {
    return {};
  }
  void close() override {}
  bool isOpen() override { return true; }
  void start(juce::AudioIODeviceCallback*) override {}
  void stop() override {}
  bool isPlaying() override { return false; }
  juce::String getLastError() override { return {}; }
  int getCurrentBufferSizeSamples() override { return 512; }
  double getCurrentSampleRate() override { return sample_rate_; }
  int getCurrentBitDepth() override { return 24; }
  juce::BigInteger getActiveOutputChannels() const override {
    juce::BigInteger b;
    b.setRange(0, 2, true);
    return b;
  }
  juce::BigInteger getActiveInputChannels() const override {
    juce::BigInteger b;
    b.setBit(0);
    return b;
  }
  int getOutputLatencyInSamples() override { return 300; }
  int getInputLatencyInSamples() override { return 200; }

 private:
  double sample_rate_;
};

}  // namespace

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
      auto* obj = status.getDynamicObject();
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
      expectEquals((int64_t)(double)perf.getDynamicObject()->getProperty(
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
      const float* ins[] = {in.data()};
      float* outs[] = {outL.data(), outR.data()};

      for (int b = 0; b < 300; ++b) {
        engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, BLOCK, {});
        auto status = engine.getLatencyCalibration();
        auto phase = status.getDynamicObject()->getProperty("phase").toString();
        if (phase != "capturing") break;
      }

      auto status = engine.getLatencyCalibration();
      auto* obj = status.getDynamicObject();
      expectEquals(obj->getProperty("phase").toString(),
                   juce::String("failed"));
      expect(!(bool)obj->getProperty("calibrated"));
      expectEquals((int64_t)(double)obj->getProperty("roundTripSamples"),
                   (int64_t)-1);
    }

    beginTest("Calibration persists across engine instances per device");
    {
      auto calFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("celestrian_test_calibration.json");
      calFile.deleteFile();

      FakeDevice deviceA("Test Interface");

      // Session 1: uncalibrated fallback, then calibrate -> persists.
      {
        AudioEngine engine;
        engine.setCalibrationFile(calFile);
        engine.audioDeviceAboutToStart(&deviceA);

        auto perf =
            engine.getGraphState().getDynamicObject()->getProperty("perf");
        expect(!(bool)perf.getDynamicObject()->getProperty("calibrated"));
        expectEquals((int64_t)(double)perf.getDynamicObject()->getProperty(
                         "latencyCompensationSamples"),
                     (int64_t)500,
                     "uncalibrated: reported in+out latency (200+300)");

        engine.startLatencyCalibration();
        runLoopback(engine, 700, 512, 300);
        engine.getLatencyCalibration();  // detection + persist
      }
      expect(calFile.existsAsFile(), "calibration file written");

      // Session 2, same device config: value restored and effective.
      {
        AudioEngine engine;
        engine.setCalibrationFile(calFile);
        engine.audioDeviceAboutToStart(&deviceA);

        auto cal = engine.getLatencyCalibration();
        expect((bool)cal.getDynamicObject()->getProperty("calibrated"),
               "restored calibration is active");
        expectEquals((int64_t)(double)cal.getDynamicObject()->getProperty(
                         "roundTripSamples"),
                     (int64_t)700);

        auto perf =
            engine.getGraphState().getDynamicObject()->getProperty("perf");
        expectEquals((int64_t)(double)perf.getDynamicObject()->getProperty(
                         "latencyCompensationSamples"),
                     (int64_t)700,
                     "restored value drives recording compensation");
      }

      // Session 3, different device: stored value must NOT carry over.
      {
        AudioEngine engine;
        engine.setCalibrationFile(calFile);
        FakeDevice deviceB("Other Interface");
        engine.audioDeviceAboutToStart(&deviceB);

        auto cal = engine.getLatencyCalibration();
        expect(!(bool)cal.getDynamicObject()->getProperty("calibrated"),
               "calibration from another device config is not applied");
      }

      calFile.deleteFile();
    }

    beginTest("Device sample rate threads through engine state (P0-5)");
    {
      auto calFile = juce::File::getSpecialLocation(juce::File::tempDirectory)
                         .getChildFile("celestrian_test_calibration_48k.json");
      calFile.deleteFile();

      AudioEngine engine;
      engine.setCalibrationFile(calFile);
      FakeDevice dev48("48k Interface", 48000.0);
      engine.audioDeviceAboutToStart(&dev48);

      // perf reports the true rate for UI samples->ms conversions
      auto perf =
          engine.getGraphState().getDynamicObject()->getProperty("perf");
      expectEquals((double)perf.getDynamicObject()->getProperty("sampleRate"),
                   48000.0, "perf.sampleRate is the device rate");

      // Clips created after device start carry the device rate
      engine.createNode("stack");
      juce::String stackId = engine.getGraphState()
                                 .getDynamicObject()
                                 ->getProperty("nodes")
                                 .getArray()
                                 ->getReference(0)
                                 .getDynamicObject()
                                 ->getProperty("id");
      engine.createNode("clip", stackId);
      auto clip = engine.getGraphState()
                      .getDynamicObject()
                      ->getProperty("nodes")
                      .getArray()
                      ->getReference(0)
                      .getDynamicObject()
                      ->getProperty("nodes")
                      .getArray()
                      ->getReference(0);
      expectEquals((double)clip.getDynamicObject()->getProperty("sampleRate"),
                   48000.0, "clip metadata reports the device rate");

      // Calibration ms conversion uses the device rate: measure a 960-sample
      // loopback (= exactly 20.0 ms at 48 kHz; would read 21.8 at 44.1).
      engine.startLatencyCalibration();
      runLoopback(engine, 960, 512, 400);
      auto cal = engine.getLatencyCalibration();
      expectEquals((int64_t)(double)cal.getDynamicObject()->getProperty(
                       "roundTripSamples"),
                   (int64_t)960);
      expectWithinAbsoluteError(
          (double)cal.getDynamicObject()->getProperty("roundTripMs"), 20.0,
          0.001, "ms conversion uses the 48 kHz device rate");

      calFile.deleteFile();
    }

    beginTest("Instrumentation: perf meters update after callbacks");
    {
      AudioEngine engine;
      const int BLOCK = 512;
      std::vector<float> in((size_t)BLOCK, 0.0f);
      std::vector<float> outL((size_t)BLOCK, 0.0f), outR((size_t)BLOCK, 0.0f);
      const float* ins[] = {in.data()};
      float* outs[] = {outL.data(), outR.data()};

      for (int b = 0; b < 10; ++b) {
        engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, BLOCK, {});
      }

      auto state = engine.getGraphState();
      auto perf = state.getDynamicObject()->getProperty("perf");
      auto* obj = perf.getDynamicObject();
      expect(obj != nullptr);
      // An empty graph can complete in <1 µs (truncates to 0), so assert
      // presence and sanity rather than a strictly positive duration.
      expect(obj->hasProperty("maxBlockUs"));
      expect((double)obj->getProperty("maxBlockUs") >= 0.0);
      expect((double)obj->getProperty("avgLoadPct") >= 0.0);
      expect(obj->hasProperty("xruns"));
    }
  }
};

static LatencyCalibrationTests latencyCalibrationTests;
