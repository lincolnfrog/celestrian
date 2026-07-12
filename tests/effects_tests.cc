#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "../src/dsp/effects.h"
#include "../src/stack_node.h"

namespace celestrian {

/**
 * Built-in effects (src/dsp/effects.h): canonical-behavior tests.
 * Each effect is checked for its DEFINING audible property plus the
 * disabled-is-identity contract; the rack is checked in the real
 * clip/stack process paths.
 */
class EffectsTests : public juce::UnitTest {
 public:
  EffectsTests() : juce::UnitTest("Effects", "DSP") {}

  static float peakOf(const std::vector<float>& v, size_t from, size_t to) {
    float p = 0.0f;
    for (size_t i = from; i < to && i < v.size(); ++i) {
      p = std::max(p, std::abs(v[i]));
    }
    return p;
  }

  /** RMS of a sine processed through fn, after a settle period. */
  template <typename Fn>
  static float sineRms(double freq, double sr, int n, Fn&& fn) {
    std::vector<float> x((size_t)n);
    for (int i = 0; i < n; ++i) {
      x[(size_t)i] =
          (float)std::sin(2.0 * juce::MathConstants<double>::pi * freq * i / sr);
    }
    fn(x.data(), n);
    double acc = 0.0;
    const int settle = n / 2;
    for (int i = settle; i < n; ++i) acc += x[(size_t)i] * x[(size_t)i];
    return (float)std::sqrt(acc / (n - settle));
  }

  void runTest() override {
    const double sr = 44100.0;

    beginTest("EQ: shelves boost their bands, flat is identity");
    {
      dsp::FxEQ eq;
      eq.prepare(sr);
      // Flat EQ ≈ identity
      const float flat = sineRms(1000.0, sr, 8192,
                                 [&](float* x, int n) { eq.process(x, n); });
      expectWithinAbsoluteError(flat, 0.707f, 0.02f, "flat EQ passes through");

      // +12 dB low shelf: a 60 Hz sine gains ~4×
      eq.low_db.store(12.0f);
      eq.markDirty();
      eq.prepare(sr);  // reset state between measurements
      eq.markDirty();
      const float low = sineRms(60.0, sr, 16384,
                                [&](float* x, int n) { eq.process(x, n); });
      expectGreaterThan(low, 0.707f * 3.0f, "low shelf boosts 60 Hz");

      // …while 6 kHz is nearly untouched by the low shelf
      eq.prepare(sr);
      eq.markDirty();
      const float hi = sineRms(6000.0, sr, 8192,
                               [&](float* x, int n) { eq.process(x, n); });
      expectWithinAbsoluteError(hi, 0.707f, 0.05f,
                                "low shelf leaves highs alone");
    }

    beginTest("Compressor: gain above threshold is reduced by the ratio");
    {
      dsp::FxCompressor comp;
      comp.prepare(sr);
      comp.threshold_db.store(-20.0f);
      comp.ratio.store(4.0f);
      comp.attack_ms.store(1.0f);
      comp.release_ms.store(100.0f);
      // 0 dBFS sine → out ≈ thr + (0 − thr)/ratio = −15 dB ≈ 0.178 amp
      std::vector<float> x(16384);
      for (size_t i = 0; i < x.size(); ++i) {
        x[i] = (float)std::sin(2.0 * juce::MathConstants<double>::pi * 440.0 *
                               (double)i / sr);
      }
      comp.process(x.data(), (int)x.size());
      const float p = peakOf(x, x.size() / 2, x.size());
      expect(p > 0.12f && p < 0.26f,
             "compressed peak ~-15dB, got " + juce::String(p));

      // Below threshold: identity (fresh state)
      dsp::FxCompressor gentle;
      gentle.prepare(sr);
      gentle.threshold_db.store(-6.0f);
      std::vector<float> q(8192, 0.1f);  // −20 dB DC-ish signal
      gentle.process(q.data(), (int)q.size());
      expectWithinAbsoluteError(peakOf(q, q.size() / 2, q.size()), 0.1f,
                                0.005f, "below threshold passes through");
    }

    beginTest("Echo: delayed copies at time·sr, scaled by mix then feedback");
    {
      dsp::FxEcho echo;
      echo.prepare(sr);
      echo.time_s.store(0.1f);  // 4410 samples
      echo.feedback.store(0.5f);
      echo.mix.store(0.8f);
      std::vector<float> x(16384, 0.0f);
      x[0] = 1.0f;
      echo.process(x.data(), (int)x.size());
      expectWithinAbsoluteError(x[0], 1.0f, 0.001f, "dry passes through");
      expectWithinAbsoluteError(x[4410], 0.8f, 0.001f, "first echo = mix");
      expectWithinAbsoluteError(x[8820], 0.4f, 0.001f,
                                "second echo = mix·feedback");
    }

    beginTest("Reverb: an impulse grows a tail that decays");
    {
      dsp::FxReverb rv;
      rv.prepare(sr);
      rv.mix.store(0.5f);
      std::vector<float> x(44100, 0.0f);
      x[0] = 1.0f;
      rv.process(x.data(), (int)x.size());
      const float early = peakOf(x, 2000, 12000);
      const float late = peakOf(x, 30000, 44100);
      expectGreaterThan(early, 0.001f, "tail exists");
      expectLessThan(late, early, "tail decays");
    }

    beginTest("Rack: disabled is bit-identical passthrough; order is fixed");
    {
      dsp::EffectRack rack;
      rack.prepare(sr);
      std::vector<float> x(4096), ref(4096);
      for (size_t i = 0; i < x.size(); ++i) {
        ref[i] = x[i] = (float)std::sin(0.01 * (double)i);
      }
      rack.process(x.data(), (int)x.size());
      expect(x == ref, "all-disabled rack is identity");

      expect(rack.setEnabled("echo", true));
      expect(rack.setParam("echo", "mix", 0.5));
      expect(!rack.setEnabled("chorus", false), "unknown effect rejected");
      expect(!rack.setParam("echo", "flutter", 1.0), "unknown param rejected");
      expectEquals(rack.enabledCount(), 1);
      auto meta = rack.getMetadata();
      expect((bool)meta.getProperty("echo", {}).getProperty("enabled", false));
    }

    beginTest("Clip playback runs its rack (echo audible in the output)");
    {
      ClipNode clip("FxClip", sr);
      // Record an impulse-then-silence take of 8820 samples (0.2 s)
      std::vector<float> in(8820, 0.0f);
      in[0] = 1.0f;
      float* const ins[] = {in.data()};
      ProcessContext rec;
      rec.num_samples = (int)in.size();
      rec.is_recording = true;
      clip.startRecording();
      clip.process(ins, nullptr, 1, 0, rec);
      clip.stopRecording();
      clip.startPlayback();

      clip.effects().prepare(sr);
      clip.effects().setParam("echo", "time", 0.05);  // 2205 samples
      clip.effects().setParam("echo", "mix", 0.8);
      clip.effects().setParam("echo", "feedback", 0.0);
      clip.effects().setEnabled("echo", true);

      std::vector<float> out(8820, 0.0f);
      float* outs[] = {out.data()};
      ProcessContext play;
      play.num_samples = (int)out.size();
      play.is_playing = true;
      play.master_pos = 0;
      clip.process(nullptr, outs, 0, 1, play);

      expectWithinAbsoluteError(out[0], 1.0f, 0.01f, "dry impulse");
      expectWithinAbsoluteError(out[2205], 0.8f, 0.01f,
                                "clip rack produced the echo");
    }

    beginTest("Stack rack shapes the SUMMED group");
    {
      StackNode stack("FxStack");
      auto clip = std::make_unique<ClipNode>("Child", sr);
      std::vector<float> in(8820, 0.0f);
      in[0] = 1.0f;
      float* const ins[] = {in.data()};
      ProcessContext rec;
      rec.num_samples = (int)in.size();
      rec.is_recording = true;
      clip->startRecording();
      clip->process(ins, nullptr, 1, 0, rec);
      clip->stopRecording();
      clip->startPlayback();
      stack.addChild(std::move(clip));

      stack.effects().prepare(sr);
      stack.effects().setParam("echo", "time", 0.05);
      stack.effects().setParam("echo", "mix", 0.8);
      stack.effects().setParam("echo", "feedback", 0.0);
      stack.effects().setEnabled("echo", true);

      std::vector<float> out(8820, 0.0f);
      float* outs[] = {out.data()};
      ProcessContext play;
      play.num_samples = (int)out.size();
      play.is_playing = true;
      play.master_pos = 0;
      stack.process(nullptr, outs, 0, 1, play);

      expectWithinAbsoluteError(out[0], 1.0f, 0.01f, "dry impulse via stack");
      expectWithinAbsoluteError(out[2205], 0.8f, 0.01f,
                                "stack rack produced the echo");
    }
  }
};

static EffectsTests effectsTests;

}  // namespace celestrian
