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
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/dsp/vst3_slot.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

using celestrian::test_utils::runLoopback;

namespace {

/** A device that reports latencies of its own (200 samples in, 300
 * out): what an engine with no calibration compensates by. */
class LatentDevice : public celestrian::test_utils::FakeDevice {
 public:
  using celestrian::test_utils::FakeDevice::FakeDevice;
  int getOutputLatencyInSamples() override { return 300; }
  int getInputLatencyInSamples() override { return 200; }
};

/** A calibration file that does not exist yet, in a fresh directory. */
juce::File freshCalibrationFile(const juce::String& name) {
  return celestrian::test_utils::freshTempDir("calibration_" + name)
      .getChildFile("calibration.json");
}

/** Silent blocks until the capture window closes (or `max_blocks`
 * ran); returns how many were driven. */
int driveSilenceUntilCaptured(AudioEngine& engine, int max_blocks) {
  int driven = 0;
  while (driven < max_blocks &&
         engine.getLatencyCalibration().getProperty("phase", "").toString() ==
             "capturing") {
    celestrian::test_utils::driveEngine(engine, 512);
    ++driven;
  }
  return driven;
}

/** A stub synth whose every block spins for kBlockUs of the clock the
 * perf meters read: a callback of a known minimum duration. */
struct SlowSynth : celestrian::test_utils::StubSynthInstance {
  static constexpr int kBlockUs = 3000;
  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer& midi) override {
    const juce::int64 until =
        juce::Time::getHighResolutionTicks() +
        juce::Time::getHighResolutionTicksPerSecond() * kBlockUs / 1000000;
    while (juce::Time::getHighResolutionTicks() < until) {
    }
    StubSynthInstance::processBlock(buffer, midi);
  }
};

}  // namespace

class LatencyCalibrationTests : public juce::UnitTest {
 public:
  LatencyCalibrationTests()
      : juce::UnitTest("Latency Calibration", "Audio Engine") {}

  void runTest() override {
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
      // The capture window, driven with silent input (no feedback path).
      driveSilenceUntilCaptured(engine, 300);

      auto status = engine.getLatencyCalibration();
      auto* obj = status.getDynamicObject();
      expectEquals(obj->getProperty("phase").toString(),
                   juce::String("failed"));
      expect(!(bool)obj->getProperty("calibrated"));
      expectEquals((int64_t)(double)obj->getProperty("roundTripSamples"),
                   (int64_t)-1);
    }

    beginTest("Uncalibrated falls back to the device's latency; a "
              "calibration persists across engine instances per device");
    {
      const auto calFile = freshCalibrationFile("persist");
      LatentDevice deviceA("Test Interface");

      // Session 1: uncalibrated fallback, then calibrate -> persists.
      {
        AudioEngine engine;
        const auto fresh = engine.getLatencyCalibration();
        expectEquals(fresh.getProperty("phase", "").toString(),
                     juce::String("idle"), "a fresh engine is idle");
        expect(!(bool)fresh.getProperty("calibrated", true),
               "and holds no calibration");
        expect(!(bool)engine.getGraphState()
                    .getProperty("perf", juce::var())
                    .getProperty("calibrated", true),
               "perf says so before any device has started");

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
        LatentDevice deviceB("Other Interface");
        engine.audioDeviceAboutToStart(&deviceB);

        auto cal = engine.getLatencyCalibration();
        expect(!(bool)cal.getDynamicObject()->getProperty("calibrated"),
               "calibration from another device config is not applied");
      }
    }

    beginTest("Device sample rate threads through engine state");
    {
      AudioEngine engine;
      engine.setCalibrationFile(freshCalibrationFile("48k"));
      LatentDevice dev48("48k Interface", 48000.0);
      engine.audioDeviceAboutToStart(&dev48);

      // perf reports the true rate for UI samples->ms conversions
      auto perf =
          engine.getGraphState().getDynamicObject()->getProperty("perf");
      expectEquals((double)perf.getDynamicObject()->getProperty("sampleRate"),
                   48000.0, "perf.sampleRate is the device rate");

      // Clips created after device start carry the device rate
      engine.createNode("stack");
      engine.createNode("clip", celestrian::test_utils::firstNodeId(engine));
      const juce::var clip = celestrian::test_utils::childVar(engine, 0);
      expectEquals((double)clip.getProperty("sampleRate", 0.0), 48000.0,
                   "clip metadata reports the device rate");

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
    }

    beginTest("A failed re-calibration keeps the device's stored calibration");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      engine.setCalibrationFile(freshCalibrationFile("recal"));
      LatentDevice device("Recal Interface");
      engine.audioDeviceAboutToStart(&device);
      engine.startLatencyCalibration();
      runLoopback(engine, 700, 512, 300);
      expect((bool)engine.getLatencyCalibration().getProperty("calibrated", false),
             "first run measured the loopback");

      // The cable is gone: the second run hears nothing.
      engine.startLatencyCalibration();
      driveSilenceUntilCaptured(engine, 400);
      const auto status = engine.getLatencyCalibration();
      expectEquals(status.getProperty("phase", "").toString(),
                   juce::String("failed"), "the second run failed");
      expect((bool)status.getProperty("calibrated", false),
             "the stored calibration is still in force");
      expectEquals((int64_t)(double)status.getProperty("roundTripSamples", -1.0),
                   (int64_t)700, "at the value measured before");
      const auto perf = engine.getGraphState().getProperty("perf", juce::var());
      expectEquals(
          (int64_t)(double)perf.getProperty("latencyCompensationSamples", -1.0),
          (int64_t)700, "and it still drives recording compensation");
    }

    beginTest("A second start while capturing is refused");
    {
      const auto baseline = std::make_unique<AudioEngine>();
      baseline->startLatencyCalibration();
      const int window_blocks = driveSilenceUntilCaptured(*baseline, 1000);
      expect(window_blocks > 10 && window_blocks < 1000,
             "the capture window is a bounded number of blocks");

      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      engine.startLatencyCalibration();
      const int before = window_blocks / 2;
      expectEquals(driveSilenceUntilCaptured(engine, before), before,
                   "half the window captured");
      engine.startLatencyCalibration();  // the audio thread owns the buffer
      expectEquals(before + driveSilenceUntilCaptured(engine, 1000),
                   window_blocks,
                   "the window still closes where the first start put it");
    }

    beginTest("Perf meters: the worst block and the average load follow a "
              "block of a known duration");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      const int block = 512;
      const auto perf = [&](const char* key) {
        return (double)engine.getGraphState()
            .getProperty("perf", juce::var())
            .getProperty(key, -1.0);
      };
      const double block_seconds = block / perf("sampleRate");

      // An instrument track whose synth takes 3 ms a block. Armed, it
      // plays through whatever the transport does: its rack runs in
      // every block.
      engine.createNode("clip");
      const juce::String id = celestrian::test_utils::lastTopLevelId(engine);
      engine.addPluginSlotToChain(
          id,
          std::make_shared<celestrian::dsp::Vst3Slot>(
              std::make_unique<SlowSynth>(), "Slow-uid", "Slow Synth",
              "/stub/SlowSynth.vst3", /*is_instrument=*/true),
          -1);
      engine.setMidiArmed(id, true);
      celestrian::test_utils::driveEngine(engine, block);

      // Asserted a millisecond under what the synth spins, clear of the
      // clock's rounding; nothing bounds a block from above.
      const double floor_us = SlowSynth::kBlockUs - 1000;
      expect(perf("maxBlockUs") >= floor_us,
             "the worst block is at least the slow one, got " +
                 juce::String(perf("maxBlockUs")) + " us");
      // The load is a running average: one block moves it a tenth of the
      // way to that block's share of its period.
      const double floor_pct = 0.1 * 100.0 * (floor_us / 1.0e6) / block_seconds;
      expect(perf("avgLoadPct") >= floor_pct,
             "one slow block lifts the average load, got " +
                 juce::String(perf("avgLoadPct")) + " %");
      expect(perf("xruns") >= 0.0, "the xrun count is published beside them");
    }
  }
};

static LatencyCalibrationTests latencyCalibrationTests;
