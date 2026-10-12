#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/dsp/effects.h"
#include "../src/dsp/fx_chain.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::makeSine;
using test_utils::peakOf;

/**
 * The laws only the stereo paths of the built-in effects have
 * (src/dsp/effects.h): every effect keeps SEPARATE per-channel DSP
 * state (biquads, echo lines) so one channel never leaks into the
 * other, EXCEPT the compressor, which is stereo-LINKED (one envelope
 * from the channel maximum, the same gain to both); and an echo nobody
 * prepared is fail-silent on both paths. What processStereo shares with
 * the mono path number for number — the echo's taps, the reverb's
 * tail, the disabled rack's passthrough — is in effects_tests.cc.
 */
class EffectsStereoTests : public juce::UnitTest {
 public:
  EffectsStereoTests() : juce::UnitTest("Effects Stereo", "DSP") {}

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

    beginTest(
        "Chain processStereo: enabled effect shapes both channels through "
        "separate state");
    {
      auto chain = dsp::FxChain::makeDefault();
      chain->prepare(sample_rate);
      auto* echo_slot = chain->slots()[2].get();
      echo_slot->enabled.store(true);
      expect(echo_slot->setParam("time", 0.05));  // 2205 samples
      expect(echo_slot->setParam("mix", 0.8));
      expect(echo_slot->setParam("feedback", 0.0));

      const int left_impulse_position = 0;
      const int right_impulse_position = 100;
      std::vector<float> left(8192, 0.0f), right(8192, 0.0f);
      left[(size_t)left_impulse_position] = 1.0f;
      right[(size_t)right_impulse_position] = 1.0f;
      chain->processStereo(left.data(), right.data(), (int)left.size());

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
        "prepare before enable: an enabled-but-unprepared echo slot is a "
        "safe no-op signal path");
    {
      // The documented fail-silent path: an echo whose lines were never
      // allocated must pass audio through untouched, mono and stereo.
      dsp::EchoSlot unprepared_slot;
      unprepared_slot.enabled.store(true);
      dsp::FxEcho& unprepared_echo = unprepared_slot.echo;

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
