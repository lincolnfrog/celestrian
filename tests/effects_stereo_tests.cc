#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/dsp/effects.h"

namespace celestrian {

/**
 * Stereo paths of the built-in effects (src/dsp/effects.h).
 *
 * Pins the header's stereo invariants: every effect keeps SEPARATE
 * per-channel DSP state (biquads, echo lines) so one channel never
 * leaks into the other, EXCEPT the compressor, which is stereo-LINKED
 * (one envelope from the channel maximum, the same gain to both). The
 * rack's processStereo mirrors the mono rack contracts: bit-identical
 * passthrough when nothing is enabled, and fail-silent before prepare.
 */
class EffectsStereoTests : public juce::UnitTest {
 public:
  EffectsStereoTests() : juce::UnitTest("Effects Stereo", "DSP") {}

  static float peakOf(const std::vector<float>& samples, size_t from,
                      size_t to) {
    float peak = 0.0f;
    for (size_t i = from; i < to && i < samples.size(); ++i) {
      peak = std::max(peak, std::abs(samples[i]));
    }
    return peak;
  }

  static std::vector<float> makeSine(double frequency, double sample_rate,
                                     int length, float amplitude) {
    std::vector<float> samples((size_t)length);
    for (int i = 0; i < length; ++i) {
      samples[(size_t)i] =
          amplitude * (float)std::sin(2.0 * juce::MathConstants<double>::pi *
                                      frequency * (double)i / sample_rate);
    }
    return samples;
  }

  void runTest() override {
    const double sample_rate = 44100.0;

    beginTest("EQ stereo: per-channel state is independent");
    {
      dsp::FxEQ eq;
      eq.prepare(sample_rate);
      eq.low_db.store(12.0f);
      eq.markDirty();

      // Impulse on L only: the boost shapes L while R stays silent —
      // shared biquad state would smear the impulse into R.
      std::vector<float> left(4096, 0.0f), right(4096, 0.0f);
      left[0] = 1.0f;
      eq.processStereo(left.data(), right.data(), (int)left.size());
      expectWithinAbsoluteError(peakOf(right, 0, right.size()), 0.0f, 1.0e-6f,
                                "R stays silent for an L-only impulse");
      expectGreaterThan(peakOf(left, 1, left.size()), 1.0e-4f,
                        "L impulse grows a shaped tail");

      // Same params, same signal on both channels: the R twin filters
      // must equal an identical mono chain sample-for-sample.
      eq.prepare(sample_rate);  // reset state between measurements
      eq.markDirty();
      const std::vector<float> input = makeSine(60.0, sample_rate, 4096, 0.5f);
      std::vector<float> stereo_left = input, stereo_right = input;
      eq.processStereo(stereo_left.data(), stereo_right.data(),
                       (int)input.size());

      dsp::FxEQ mono_eq;
      mono_eq.prepare(sample_rate);
      mono_eq.low_db.store(12.0f);
      mono_eq.markDirty();
      std::vector<float> mono = input;
      mono_eq.process(mono.data(), (int)mono.size());

      float max_difference = 0.0f;
      for (size_t i = 0; i < mono.size(); ++i) {
        max_difference =
            std::max(max_difference, std::abs(stereo_right[i] - mono[i]));
      }
      expectWithinAbsoluteError(max_difference, 0.0f, 1.0e-6f,
                                "R path matches an identical mono chain");
    }

    beginTest("Echo stereo: L impulse does not echo on R");
    {
      dsp::FxEcho echo;
      echo.prepare(sample_rate);
      echo.time_s.store(0.1f);  // 4410 samples
      echo.feedback.store(0.5f);
      echo.mix.store(0.8f);

      std::vector<float> left(16384, 0.0f), right(16384, 0.0f);
      left[0] = 1.0f;
      echo.processStereo(left.data(), right.data(), (int)left.size());

      expectWithinAbsoluteError(left[0], 1.0f, 0.001f, "dry passes through");
      expectWithinAbsoluteError(left[4410], 0.8f, 0.001f,
                                "delayed copy appears on L");
      expectWithinAbsoluteError(left[8820], 0.4f, 0.001f,
                                "second L echo = mix times feedback");
      expectWithinAbsoluteError(peakOf(right, 0, right.size()), 0.0f, 1.0e-6f,
                                "R stays silent (line_r_ independence)");
    }

    beginTest("Compressor stereo link: loud L reduces R by the same gain");
    {
      const int length = 16384;
      const float quiet_amplitude = 0.1f;
      const std::vector<float> loud =
          makeSine(440.0, sample_rate, length, 1.0f);
      const std::vector<float> quiet =
          makeSine(440.0, sample_rate, length, quiet_amplitude);

      dsp::FxCompressor linked;
      linked.prepare(sample_rate);
      linked.threshold_db.store(-30.0f);
      linked.ratio.store(8.0f);
      linked.attack_ms.store(1.0f);
      linked.release_ms.store(200.0f);
      std::vector<float> left = loud, right = quiet;
      linked.processStereo(left.data(), right.data(), length);

      // The same quiet signal through a FRESH compressor with the same
      // params: its own envelope barely crosses threshold, so it comes
      // out LOUDER than the linked case driven by the loud channel.
      dsp::FxCompressor solo;
      solo.prepare(sample_rate);
      solo.threshold_db.store(-30.0f);
      solo.ratio.store(8.0f);
      solo.attack_ms.store(1.0f);
      solo.release_ms.store(200.0f);
      std::vector<float> quiet_alone = quiet;
      solo.process(quiet_alone.data(), length);

      const float linked_peak = peakOf(right, (size_t)length / 2, right.size());
      const float alone_peak =
          peakOf(quiet_alone, (size_t)length / 2, quiet_alone.size());
      expectLessThan(linked_peak, alone_peak * 0.7f,
                     "linked R is attenuated harder than the quiet "
                     "signal alone");

      // Identical gain on both channels: with R = 0.1 * L at the input,
      // the linked outputs must keep exactly that ratio every sample.
      float max_difference = 0.0f;
      for (int i = 0; i < length; ++i) {
        max_difference = std::max(
            max_difference,
            std::abs(right[(size_t)i] - quiet_amplitude * left[(size_t)i]));
      }
      expectWithinAbsoluteError(max_difference, 0.0f, 1.0e-4f,
                                "both channels receive the identical gain");
    }

    beginTest("Reverb stereo: tail appears and decays");
    {
      dsp::FxReverb reverb;
      reverb.prepare(sample_rate);
      reverb.mix.store(0.5f);

      std::vector<float> left(44100, 0.0f), right(44100, 0.0f);
      left[0] = 1.0f;
      right[0] = 1.0f;
      reverb.processStereo(left.data(), right.data(), (int)left.size());

      const float early_left = peakOf(left, 2000, 12000);
      const float late_left = peakOf(left, 30000, 44100);
      const float early_right = peakOf(right, 2000, 12000);
      const float late_right = peakOf(right, 30000, 44100);
      expectGreaterThan(early_left, 0.001f, "L tail exists");
      expectGreaterThan(early_right, 0.001f, "R tail exists");
      expectLessThan(late_left, early_left, "L tail decays");
      expectLessThan(late_right, early_right, "R tail decays");
    }

    beginTest("Rack processStereo: disabled is bit-identical passthrough");
    {
      dsp::EffectRack rack;
      rack.prepare(sample_rate);
      std::vector<float> left(4096), right(4096);
      for (size_t i = 0; i < left.size(); ++i) {
        left[i] = (float)std::sin(0.01 * (double)i);
        right[i] = (float)std::cos(0.017 * (double)i);
      }
      const std::vector<float> left_reference = left;
      const std::vector<float> right_reference = right;
      rack.processStereo(left.data(), right.data(), (int)left.size());
      expect(left == left_reference, "all-disabled rack leaves L untouched");
      expect(right == right_reference, "all-disabled rack leaves R untouched");
    }

    beginTest(
        "Rack processStereo: enabled effect shapes both channels through "
        "separate state");
    {
      dsp::EffectRack rack;
      rack.prepare(sample_rate);
      expect(rack.setEnabled("echo", true));
      expect(rack.setParam("echo", "time", 0.05));  // 2205 samples
      expect(rack.setParam("echo", "mix", 0.8));
      expect(rack.setParam("echo", "feedback", 0.0));

      const int left_impulse_position = 0;
      const int right_impulse_position = 100;
      std::vector<float> left(8192, 0.0f), right(8192, 0.0f);
      left[(size_t)left_impulse_position] = 1.0f;
      right[(size_t)right_impulse_position] = 1.0f;
      rack.processStereo(left.data(), right.data(), (int)left.size());

      expectWithinAbsoluteError(left[(size_t)(left_impulse_position + 2205)],
                                0.8f, 0.01f, "L echo lands at L's position");
      expectWithinAbsoluteError(right[(size_t)(right_impulse_position + 2205)],
                                0.8f, 0.01f, "R echo lands at R's position");
      expectWithinAbsoluteError(right[(size_t)(left_impulse_position + 2205)],
                                0.0f, 0.001f, "L's echo does not land on R");
      expectWithinAbsoluteError(left[(size_t)(right_impulse_position + 2205)],
                                0.0f, 0.001f, "R's echo does not land on L");
    }

    beginTest(
        "setEnabled/setParam: unknown ids return false, valid ones true; "
        "params clamp");
    {
      dsp::EffectRack rack;
      rack.prepare(sample_rate);
      expect(!rack.setEnabled("flanger", true), "unknown effect rejected");
      expect(!rack.setParam("echo", "nonsense", 1.0), "unknown param rejected");

      expect(rack.setParam("compressor", "ratio", 999.0),
             "valid param accepted");
      expectWithinAbsoluteError(rack.compressor.ratio.load(), 20.0f, 0.001f,
                                "ratio clamps to 20");
      expect(rack.setParam("echo", "time", 99.0));
      expectWithinAbsoluteError(rack.echo.time_s.load(), 2.0f, 0.001f,
                                "echo time clamps to 2.0");
      expect(rack.setParam("echo", "feedback", 5.0));
      expectWithinAbsoluteError(rack.echo.feedback.load(), 0.9f, 0.001f,
                                "echo feedback clamps to 0.9");
    }

    beginTest(
        "prepare before enable: enabling echo on an unprepared rack is a safe "
        "no-op signal path");
    {
      // The documented fail-silent path: an echo whose lines were never
      // allocated must pass audio through untouched, mono and stereo.
      dsp::FxEcho unprepared_echo;
      unprepared_echo.enabled.store(true);

      std::vector<float> mono(2048);
      for (size_t i = 0; i < mono.size(); ++i) {
        mono[i] = (float)std::sin(0.02 * (double)i);
      }
      const std::vector<float> mono_reference = mono;
      unprepared_echo.process(mono.data(), (int)mono.size());
      expect(mono == mono_reference, "unprepared mono echo is identity");

      std::vector<float> left = mono_reference, right = mono_reference;
      unprepared_echo.processStereo(left.data(), right.data(),
                                    (int)left.size());
      expect(left == mono_reference, "unprepared stereo echo leaves L alone");
      expect(right == mono_reference, "unprepared stereo echo leaves R alone");
    }
  }
};

static EffectsStereoTests effectsStereoTests;

}  // namespace celestrian
