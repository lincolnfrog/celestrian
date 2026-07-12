#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <atomic>
#include <vector>

namespace celestrian::dsp {

/**
 * Built-in effects (docs/ui_overhaul.md effects bar; VST3 later).
 *
 * Design: a FIXED rack of the four canonical effects per node, in
 * canonical signal order EQ → Compressor → Echo → Reverb. "Adding an
 * effect" is enabling a slot. This deliberately avoids a dynamic chain:
 * the audio-thread contract (performance.md §1) then needs no new
 * lock-free collection machinery — every parameter is an atomic, and
 * enable is a flag flip whose buffers were prepared on the message
 * thread beforehand. The dynamic-chain complexity arrives with VST3,
 * which will replace the rack's internals, not its bridge surface.
 *
 * All effects are MONO (the engine records mono; the Mono→Stereo
 * roadmap item upgrades the rack alongside). process() runs on the
 * audio thread: no allocation, no locks. prepare() runs on the MESSAGE
 * thread (allocates the echo line, resets reverb) and MUST be called
 * before the first enable at a given sample rate.
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
  void set(double b0, double b1, double b2, double a0, double a1, double a2);
  double b0_ = 1, b1_ = 0, b2_ = 0, a1_ = 0, a2_ = 0;
  double z1_ = 0, z2_ = 0;
};

/** 3-band tone EQ: low shelf @120 Hz, peak @1 kHz, high shelf @6 kHz. */
class FxEQ {
 public:
  std::atomic<bool> enabled{false};
  std::atomic<float> low_db{0.0f}, mid_db{0.0f}, high_db{0.0f};

  void prepare(double sampleRate);
  void process(float* x, int n);
  void markDirty() { dirty_.store(true); }

 private:
  void updateCoeffs();
  double sr_ = 44100.0;
  std::atomic<bool> dirty_{true};
  Biquad low_, mid_, high_;
};

/** Feed-forward peak compressor: threshold/ratio/attack/release/makeup. */
class FxCompressor {
 public:
  std::atomic<bool> enabled{false};
  std::atomic<float> threshold_db{-18.0f};
  std::atomic<float> ratio{4.0f};        // 1..20
  std::atomic<float> attack_ms{10.0f};   // 0.1..100
  std::atomic<float> release_ms{100.0f}; // 10..1000
  std::atomic<float> makeup_db{0.0f};    // 0..24

  void prepare(double sampleRate);
  void process(float* x, int n);

 private:
  double sr_ = 44100.0;
  float env_ = 0.0f;  // peak envelope, linear
};

/** Echo: preallocated delay line; time/feedback/mix. */
class FxEcho {
 public:
  std::atomic<bool> enabled{false};
  std::atomic<float> time_s{0.35f};    // 0.05..2.0
  std::atomic<float> feedback{0.35f};  // 0..0.9
  std::atomic<float> mix{0.35f};       // 0..1

  void prepare(double sampleRate);  // message thread: allocates 2s line
  void process(float* x, int n);

 private:
  double sr_ = 44100.0;
  std::vector<float> line_;  // sized in prepare; empty = not ready
  int write_ = 0;
};

/** Reverb: juce::Reverb (Freeverb — the canonical implementation). */
class FxReverb {
 public:
  std::atomic<bool> enabled{false};
  std::atomic<float> size{0.5f};  // 0..1 room size
  std::atomic<float> damp{0.5f};  // 0..1
  std::atomic<float> mix{0.3f};   // 0..1 wet level

  void prepare(double sampleRate);
  void process(float* x, int n);
  void markDirty() { dirty_.store(true); }

 private:
  std::atomic<bool> dirty_{true};
  juce::Reverb reverb_;
};

/** The per-node rack: fixed slots, canonical order. */
class EffectRack {
 public:
  FxEQ eq;
  FxCompressor compressor;
  FxEcho echo;
  FxReverb reverb;

  /** Message thread. Idempotent per sample rate; call before enabling. */
  void prepare(double sampleRate);

  /** Audio thread: in-place, mono. No-op when nothing is enabled. */
  void process(float* x, int n);

  bool anyEnabled() const {
    return eq.enabled.load() || compressor.enabled.load() ||
           echo.enabled.load() || reverb.enabled.load();
  }
  int enabledCount() const {
    return (eq.enabled.load() ? 1 : 0) + (compressor.enabled.load() ? 1 : 0) +
           (echo.enabled.load() ? 1 : 0) + (reverb.enabled.load() ? 1 : 0);
  }

  /** Message thread. Returns false for an unknown effect/param key. */
  bool setEnabled(const juce::String& fx, bool on);
  bool setParam(const juce::String& fx, const juce::String& key, double v);

  /** Nested state for getGraphState: { eq: {...}, compressor: {...}, … } */
  juce::var getMetadata() const;

  bool isPrepared() const { return prepared_sr_ > 0.0; }

 private:
  double prepared_sr_ = 0.0;
};

}  // namespace celestrian::dsp
