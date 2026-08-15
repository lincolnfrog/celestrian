#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>
#include <vector>

namespace celestrian::dsp {

/**
 * Built-in effect DSP (docs/ui_overhaul.md effects bar).
 *
 * These four classes are the DSP truth for the built-in effects. They
 * used to live behind a FIXED per-node rack (EffectRack); the rack was
 * replaced by the dynamic slot CHAIN in fx_chain.h (docs/vst3.md
 * phase 2) — exactly the migration the old rack comment predicted
 * ("the dynamic-chain complexity arrives with VST3"). Slot identity,
 * ordering, param clamps, and the scope now live there; nothing in
 * THIS file knows about slots.
 *
 * Every effect has a mono path (process — the historical rack surface)
 * and a stereo path (processStereo, the Mono→Stereo roadmap item):
 * stereo clips and panned groups carry two channels through the rack.
 * The two paths share the same atomic parameters but keep SEPARATE DSP
 * state per channel (biquads, echo lines) — interleaving one mono state
 * across channels would garble both. The compressor is stereo-LINKED:
 * one envelope from the channel maximum, the same gain applied to both
 * (per-channel envelopes would smear the stereo image). process() /
 * processStereo() run on the audio thread: no allocation, no locks.
 * prepare() runs on the MESSAGE thread (allocates the echo lines,
 * resets reverb) and MUST be called before the first enable at a given
 * sample rate.
 */

/** RBJ biquad (Audio EQ Cookbook), transposed direct form II. */
class Biquad {
 public:
  void setLowShelf(double sr, double f0, double gainDb);
  void setPeaking(double sr, double f0, double q, double gainDb);
  void setHighShelf(double sr, double f0, double gainDb);
  void reset() { z1_ = z2_ = 0.0; }
  inline float processSample(float x) {
    const double y = b0_ * x + z1_;
    z1_ = b1_ * x - a1_ * y + z2_;
    z2_ = b2_ * x - a2_ * y;
    return (float)y;
  }

 private:
  /** The terms shared by the two shelf recipes (cookbook notation:
   * A = 10^(dB/40), cw = cos ω0, sq = 2√A·α at slope S). */
  struct ShelfTerms {
    double A, cw, sq;
  };
  static ShelfTerms shelfTerms(double sample_rate, double f0, double gain_db);

  void set(double b0, double b1, double b2, double a0, double a1, double a2);
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double z1_ = 0, z2_ = 0;
};

/** 3-band tone EQ: low shelf @120 Hz, peak @1 kHz, high shelf @6 kHz. */
class FxEQ {
 public:
  std::atomic<float> low_db{0.0f}, mid_db{0.0f}, high_db{0.0f};

  void prepare(double sampleRate);
  void process(float* x, int n);
  void processStereo(float* l, float* r, int n);
  void markDirty() { dirty_.store(true); }

 private:
  void updateCoeffs();
  double sr_ = 44100.0;
  std::atomic<bool> dirty_{true};
  Biquad low_, mid_, high_;
  Biquad low_r_, mid_r_, high_r_;  // right-channel twin state
};

/** Feed-forward peak compressor: threshold/ratio/attack/release/makeup. */
class FxCompressor {
 public:
  std::atomic<float> threshold_db{-18.0f};
  std::atomic<float> ratio{4.0f};         // 1..20
  std::atomic<float> attack_ms{10.0f};    // 0.1..100
  std::atomic<float> release_ms{100.0f};  // 10..1000
  std::atomic<float> makeup_db{0.0f};     // −12..24 (output trim; makeup
                                          // convention is raise-only, but
                                          // cutting is harmless and useful)

  void prepare(double sampleRate);
  void process(float* x, int n);
  /** Stereo-linked: one envelope from max(|l|,|r|), same gain to both. */
  void processStereo(float* l, float* r, int n);

  /** Live gain reduction in dB (≥ 0), for the UI's GR meter. */
  float currentGainReductionDb() const { return gr_db_.load(); }

 private:
  /** One coherent snapshot of the atomic parameters, taken per block so
   * a mid-block UI edit cannot tear the gain computer. `attack`/
   * `release` are the derived one-pole coefficients, not the ms values. */
  struct Coefficients {
    float threshold_db, ratio, attack, release, makeup;
  };
  Coefficients loadCoefficients() const;
  /** Advance the envelope by one detector sample and return the gain
   * (≤ 1) the gain computer chooses for it. Shared by the mono and
   * stereo paths — only the detector differs between them. */
  float gainStep(float detector, const Coefficients& c);

  double sr_ = 44100.0;
  float env_ = 0.0f;  // peak envelope, linear
  std::atomic<float> gr_db_{0.0f};
};

/** Echo: preallocated delay line; time/feedback/mix. */
class FxEcho {
 public:
  std::atomic<float> time_s{0.35f};    // 0.05..2.0
  std::atomic<float> feedback{0.35f};  // 0..0.9
  std::atomic<float> mix{0.35f};       // 0..1

  void prepare(double sampleRate);  // message thread: allocates 2s lines
  void process(float* x, int n);
  void processStereo(float* l, float* r, int n);

 private:
  /** Per-block snapshot of the delay parameters (delay in samples,
   * clamped to the line; feedback/wet clamped to their legal ranges). */
  struct Parameters {
    int delay;
    float feedback, wet;
  };
  Parameters loadParameters(int line_length) const;

  double sr_ = 44100.0;
  std::vector<float> line_;    // sized in prepare; empty = not ready
  std::vector<float> line_r_;  // right-channel twin line
  int write_ = 0;
};

/** Reverb: juce::Reverb (Freeverb — the canonical implementation). */
class FxReverb {
 public:
  std::atomic<float> size{0.5f};  // 0..1 room size
  std::atomic<float> damp{0.5f};  // 0..1
  std::atomic<float> mix{0.3f};   // 0..1 wet level

  void prepare(double sampleRate);
  void process(float* x, int n);
  void processStereo(float* l, float* r, int n);
  void markDirty() { dirty_.store(true); }

 private:
  void applyParams();
  std::atomic<bool> dirty_{true};
  juce::Reverb reverb_;
};

}  // namespace celestrian::dsp
