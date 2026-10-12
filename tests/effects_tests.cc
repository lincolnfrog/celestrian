#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "../src/dsp/effects.h"
#include "../src/dsp/fx_chain.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::committedClip;
using test_utils::makeSine;
using test_utils::peakOf;
using test_utils::contextFor;
using test_utils::NodeContext;

/**
 * Built-in effects (src/dsp/effects.h): canonical-behavior tests.
 * Each effect is checked for its DEFINING audible property plus the
 * disabled-is-identity contract, on the mono path and — where the
 * stereo path promises the same numbers — on processStereo too; the
 * rack is checked in the real clip/stack process paths. The laws only
 * the stereo path has are in effects_stereo_tests.cc.
 */
class EffectsTests : public juce::UnitTest {
 public:
  EffectsTests() : juce::UnitTest("Effects", "DSP") {}

  /** RMS of a sine processed through fn, after a settle period. */
  template <typename Fn>
  static float sineRms(double freq, double sr, int n, Fn&& fn) {
    std::vector<float> x = makeSine(freq, sr, n);
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
      const float flat =
          sineRms(1000.0, sr, 8192, [&](float* x, int n) { eq.process(x, n); });
      expectWithinAbsoluteError(flat, 0.707f, 0.02f, "flat EQ passes through");

      // +12 dB low shelf: a 60 Hz sine gains ~4×
      eq.low_db.store(12.0f);
      eq.markDirty();
      eq.prepare(sr);  // reset state between measurements
      eq.markDirty();
      const float low =
          sineRms(60.0, sr, 16384, [&](float* x, int n) { eq.process(x, n); });
      expectGreaterThan(low, 0.707f * 3.0f, "low shelf boosts 60 Hz");

      // …while 6 kHz is nearly untouched by the low shelf
      eq.prepare(sr);
      eq.markDirty();
      const float hi =
          sineRms(6000.0, sr, 8192, [&](float* x, int n) { eq.process(x, n); });
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
      std::vector<float> x = makeSine(440.0, sr, 16384);
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
      expectWithinAbsoluteError(peakOf(q, q.size() / 2, q.size()), 0.1f, 0.005f,
                                "below threshold passes through");
    }

    beginTest("Echo: delayed copies at time*sr, scaled by mix then feedback "
              "(mono; stereo, where an L impulse does not echo on R)");
    for (const bool stereo : {false, true}) {
      const juce::String path = stereo ? " (stereo L)" : " (mono)";
      dsp::FxEcho echo;
      echo.prepare(sr);
      echo.time_s.store(0.1f);  // 4410 samples
      echo.feedback.store(0.5f);
      echo.mix.store(0.8f);
      std::vector<float> x(16384, 0.0f), right(16384, 0.0f);
      x[0] = 1.0f;
      if (stereo) {
        echo.processStereo(x.data(), right.data(), (int)x.size());
        expectWithinAbsoluteError(peakOf(right), 0.0f, 1.0e-6f,
                                  "R stays silent: its line is its own");
      } else {
        echo.process(x.data(), (int)x.size());
      }
      expectWithinAbsoluteError(x[0], 1.0f, 0.001f,
                                "dry passes through" + path);
      expectWithinAbsoluteError(x[4410], 0.8f, 0.001f,
                                "first echo = mix" + path);
      expectWithinAbsoluteError(x[8820], 0.4f, 0.001f,
                                "second echo = mix*feedback" + path);
    }

    beginTest("Reverb: an impulse grows a tail that decays (mono; stereo, "
              "on both channels)");
    {
      const auto expectTail = [this](const std::vector<float>& x,
                                     const juce::String& channel) {
        const float early = peakOf(x, 2000, 12000);
        const float late = peakOf(x, 30000, 44100);
        expectGreaterThan(early, 0.001f, channel + " tail exists");
        expectLessThan(late, early, channel + " tail decays");
      };
      std::vector<float> impulse(44100, 0.0f);
      impulse[0] = 1.0f;

      dsp::FxReverb mono_reverb;
      mono_reverb.prepare(sr);
      mono_reverb.mix.store(0.5f);
      std::vector<float> x = impulse;
      mono_reverb.process(x.data(), (int)x.size());
      expectTail(x, "mono");

      dsp::FxReverb stereo_reverb;
      stereo_reverb.prepare(sr);
      stereo_reverb.mix.store(0.5f);
      std::vector<float> left = impulse, right = impulse;
      stereo_reverb.processStereo(left.data(), right.data(), (int)left.size());
      expectTail(left, "L");
      expectTail(right, "R");
    }

    beginTest("Reverb: mix law is unity-preserving (no +6 dB dry boost)");
    {
      // juce::Reverb scales the dry level x2 internally, so the slot
      // divides that back out: mix 0 is bit-exact dry, and a steady sine
      // at any mix never comes out hotter than ~+1 dB of unity
      // (equal-power sums of a dry tone and its own diffuse tail sit
      // near unity).
      const float dry_rms = sineRms(440.0, sr, 44100, [](float*, int) {});
      {
        dsp::FxReverb rv;
        rv.mix.store(0.0f);
        rv.prepare(sr);  // prepare applies (and snaps) the law
        std::vector<float> x(4096), ref(4096);
        for (size_t i = 0; i < x.size(); ++i)
          ref[i] = x[i] = (float)std::sin(0.02 * (double)i);
        rv.process(x.data(), (int)x.size());
        float max_err = 0.0f;
        for (size_t i = 0; i < x.size(); ++i)
          max_err = std::max(max_err, std::abs(x[i] - ref[i]));
        expectLessThan(max_err, 1e-4f, "mix 0 passes dry through at unity");
      }
      for (const float mix : {0.3f, 0.5f, 1.0f}) {
        dsp::FxReverb rv;
        rv.mix.store(mix);
        rv.prepare(sr);
        const float out = sineRms(440.0, sr, 88200, [&](float* x, int n) {
          rv.process(x, n);
        });
        expectLessThan(out, dry_rms * 1.15f,
                       "mix " + juce::String(mix) + " does not boost");
        expectGreaterThan(out, dry_rms * 0.3f,
                          "mix " + juce::String(mix) + " still sounds");
      }
    }

    beginTest("Chain: disabled is bit-identical passthrough, mono and "
              "stereo; default order; slot params reject and clamp");
    {
      auto chain = dsp::FxChain::makeDefault();
      chain->prepare(sr);
      std::vector<float> x(4096), ref(4096), right(4096);
      for (size_t i = 0; i < x.size(); ++i) {
        ref[i] = x[i] = (float)std::sin(0.01 * (double)i);
        right[i] = (float)std::cos(0.017 * (double)i);
      }
      chain->process(x.data(), (int)x.size());
      expect(x == ref, "all-disabled chain is identity");
      const std::vector<float> right_ref = right;
      chain->processStereo(x.data(), right.data(), (int)x.size());
      expect(x == ref, "all-disabled chain leaves L untouched");
      expect(right == right_ref, "all-disabled chain leaves R untouched");

      // Default chain: the four built-ins in canonical signal order.
      expectEquals((int)chain->slots().size(), 4);
      for (size_t i = 0; i < dsp::FxChain::kBuiltInTypes.size(); ++i) {
        expectEquals(juce::String(chain->slots()[i]->typeId()),
                     juce::String(dsp::FxChain::kBuiltInTypes[i]));
      }

      auto* echo_slot = chain->slots()[2].get();
      echo_slot->enabled.store(true);
      expect(echo_slot->setParam("mix", 0.5));
      expect(dsp::FxChain::makeBuiltIn("chorus") == nullptr,
             "unknown type has no factory");
      expect(!echo_slot->setParam("flutter", 1.0), "unknown param rejected");
      // Makeup is an output trim: cuts allowed, clamped at −12
      auto* comp_slot = chain->slots()[1].get();
      expect(comp_slot->setParam("makeup", -6.0));
      auto* comp = dynamic_cast<dsp::CompressorSlot*>(comp_slot);
      expectWithinAbsoluteError(comp->compressor.makeup_db.load(), -6.0f,
                                0.001f, "negative makeup accepted");
      comp_slot->setParam("makeup", -40.0);
      expectWithinAbsoluteError(comp->compressor.makeup_db.load(), -12.0f,
                                0.001f, "makeup clamps at -12");
      // A value past a bound is accepted and lands on the bound.
      expect(comp_slot->setParam("ratio", 999.0), "valid param accepted");
      expectWithinAbsoluteError(comp->compressor.ratio.load(), 20.0f, 0.001f,
                                "ratio clamps to 20");
      auto* echo = dynamic_cast<dsp::EchoSlot*>(echo_slot);
      expect(echo_slot->setParam("time", 99.0));
      expectWithinAbsoluteError(echo->echo.time_s.load(), 2.0f, 0.001f,
                                "echo time clamps to 2.0");
      expect(echo_slot->setParam("feedback", 5.0));
      expectWithinAbsoluteError(echo->echo.feedback.load(), 0.9f, 0.001f,
                                "echo feedback clamps to 0.9");
      expectEquals(chain->enabledCount(), 1);
      auto meta = chain->getMetadata();
      expect((bool)meta[2].getProperty("enabled", false));
      expectEquals(meta[2].getProperty("type", "").toString(),
                   juce::String("echo"));
      expect(meta[2].getProperty("slot", "").toString().isNotEmpty(),
             "slot uuid published");
    }

    beginTest("Chain: slot lookup by uuid; state survives a reorder");
    {
      auto chain = dsp::FxChain::makeDefault();
      chain->prepare(sr);
      auto* echo_slot = chain->slots()[2].get();
      const juce::String echo_uuid = echo_slot->slotUuid();
      echo_slot->setParam("time", 0.05);
      expect(chain->findSlot(echo_uuid) == echo_slot, "findSlot by uuid");
      expectEquals(chain->indexOfSlot(echo_uuid), 2);
      expect(chain->findSlot("nope") == nullptr, "unknown uuid is null");

      // Successor sharing the slots, echo moved to the head: the SAME
      // slot object (and so its DSP state + params) rides along.
      auto slots = chain->slots();
      auto moved = slots[2];
      slots.erase(slots.begin() + 2);
      slots.insert(slots.begin(), std::move(moved));
      auto successor = dsp::FxChain::makeFromSlots(std::move(slots));
      expectEquals(successor->indexOfSlot(echo_uuid), 0, juce::String("moved"));
      expect(successor->findSlot(echo_uuid) == echo_slot,
             "the reorder shares the slot object");
      auto meta = successor->getMetadata();
      expectWithinAbsoluteError((double)meta[0].getProperty("time", 0.0), 0.05,
                                1e-6, "param rode the reorder");
    }

    beginTest("Scope telemetry: gated on a watcher; spectrum discriminates");
    {
      auto chain = dsp::FxChain::makeDefault();
      dsp::FxScope scope_obj;
      chain->prepare(sr);
      scope_obj.prepare(sr);
      auto* comp_slot = chain->slots()[1].get();
      comp_slot->setParam("threshold", -20.0);
      comp_slot->setParam("attack", 1.0);
      comp_slot->enabled.store(true);

      // Feed a loud LOW sine (100 Hz) through capture + chain (the node
      // fx pass: AudioNode::fxProcess).
      std::vector<float> x = makeSine(100.0, sr, 4096);

      // NO WATCHER: processing captures nothing, publishes nothing
      scope_obj.capture(x.data(), nullptr, 2048);
      chain->process(x.data(), 2048);
      expect(scope_obj.metadataVar(0.0f).isVoid(),
             "no scope without a watcher");

      // Panel opens (setEffectScope): capture + telemetry live even
      // with ZERO enabled slots (line up the threshold, then commit).
      scope_obj.setActive(true);
      expect(scope_obj.watching());
      x = makeSine(100.0, sr, 4096);
      scope_obj.capture(x.data(), nullptr, 2048);
      chain->process(x.data(), 2048);
      scope_obj.capture(x.data() + 2048, nullptr, 2048);
      chain->process(x.data() + 2048, 2048);

      auto scope = scope_obj.metadataVar(chain->compressorGainReductionDb());
      expect(scope.isObject(), "scope published while watched");
      auto* spec = scope.getProperty("spectrum", {}).getArray();
      expect(spec != nullptr && spec->size() == dsp::FxScope::kSpectrumBins,
             "24 spectrum bins");
      // Low bins outweigh high bins for a 100 Hz tone
      const double lowE = (double)(*spec)[2] + (double)(*spec)[3];
      const double highE = (double)(*spec)[20] + (double)(*spec)[21];
      expectGreaterThan(lowE, highE + 0.2, "spectrum sees the low tone");
      expectGreaterThan((double)scope.getProperty("peak", 0.0), 0.5,
                        "pre-chain peak published");
      // 0 dBFS into thr -20/ratio 4 -> ~15 dB of reduction
      const double gr = (double)scope.getProperty("gr", 0.0);
      expect(gr > 8.0 && gr < 22.0,
             "gain reduction ~15 dB, got " + juce::String(gr));
    }

    beginTest("Scope: the spectrum is read at the rate the scope follows");
    {
      // A full-scale tone exactly on one bin's frequency AT 48 kHz, in a
      // scope prepared at 44.1 kHz: read at that rate the bin misses
      // the tone by several analysis widths; once the scope follows the
      // device to 48 kHz the bin is full.
      const int bin = 13;
      const double device_rate = 48000.0;
      const double low_hz = 40.0, high_hz = 16000.0;  // the display range
      const double tone_hz =
          low_hz * std::pow(high_hz / low_hz,
                            (double)bin / (dsp::FxScope::kSpectrumBins - 1));
      dsp::FxScope scope;
      scope.prepare(44100.0);
      scope.setActive(true);
      std::vector<float> x =
          makeSine(tone_hz, device_rate, (int)dsp::FxScope::kScopeSize);
      scope.capture(x.data(), nullptr, (int)x.size());
      const auto binLevel = [&] {
        const juce::var spectrum =
            scope.metadataVar(0.0f).getProperty("spectrum", juce::var());
        return (double)spectrum[bin];
      };

      const double at_prepared_rate = binLevel();
      scope.followRate(device_rate);
      const double at_device_rate = binLevel();
      expectGreaterThan(at_device_rate, 0.95,
                        "at the device's rate the bin holds the tone");
      expectLessThan(at_prepared_rate, at_device_rate - 0.1,
                     "read at the rate it was prepared at, it did not");

      // A scope nobody prepared has no ring to read and stays so.
      dsp::FxScope unprepared;
      unprepared.setActive(true);
      unprepared.followRate(device_rate);
      expect(unprepared.metadataVar(0.0f).isVoid(),
             "following a rate prepares nothing");
    }

    // An impulse-then-silence take of 8820 samples (0.2 s).
    const auto impulseClip = [sr](const char* name) {
      return committedClip(name, sr, 8820,
                           [](int64_t i) { return i == 0 ? 1.0f : 0.0f; });
    };

    beginTest("Clip playback runs its chain (echo audible in the output)");
    {
      const auto clip_owner = impulseClip("FxClip");
      ClipNode& clip = *clip_owner;

      clip.fxChain()->prepare(sr);
      auto* clip_echo = clip.fxChain()->slots()[2].get();
      clip_echo->setParam("time", 0.05);  // 2205 samples
      clip_echo->setParam("mix", 0.8);
      clip_echo->setParam("feedback", 0.0);
      clip_echo->enabled.store(true);

      std::vector<float> out(8820, 0.0f);
      float* outs[] = {out.data()};
      NodeContext play = contextFor(clip, (int)out.size(), 0);
      play.ctx.is_playing = true;
      clip.process(nullptr, outs, 0, 1, play.ctx);

      expectWithinAbsoluteError(out[0], 1.0f, 0.01f, "dry impulse");
      expectWithinAbsoluteError(out[2205], 0.8f, 0.01f,
                                "clip chain produced the echo");
    }

    beginTest("Stack chain shapes the SUMMED group");
    {
      StackNode stack("FxStack");
      stack.addChild(impulseClip("Child"));

      stack.fxChain()->prepare(sr);
      auto* stack_echo = stack.fxChain()->slots()[2].get();
      stack_echo->setParam("time", 0.05);
      stack_echo->setParam("mix", 0.8);
      stack_echo->setParam("feedback", 0.0);
      stack_echo->enabled.store(true);

      std::vector<float> out(8820, 0.0f);
      float* outs[] = {out.data()};
      NodeContext play = contextFor(stack, (int)out.size(), 0);
      play.ctx.is_playing = true;
      stack.process(nullptr, outs, 0, 1, play.ctx);

      expectWithinAbsoluteError(out[0], 1.0f, 0.01f, "dry impulse via stack");
      expectWithinAbsoluteError(out[2205], 0.8f, 0.01f,
                                "stack chain produced the echo");
    }
  }
};

static EffectsTests effectsTests;

}  // namespace celestrian
