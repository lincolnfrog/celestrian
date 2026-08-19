#include "effects.h"

#include <cmath>

namespace celestrian::dsp {

namespace {
// EQ band placement (fixed 3-band tone control — see FxEQ).
constexpr double kLowShelfHz = 120.0;
constexpr double kMidPeakHz = 1000.0;
constexpr double kMidQ = 0.7;
constexpr double kHighShelfHz = 6000.0;
constexpr double kShelfSlope = 0.9;

// Echo delay line: sized for the maximum time_s plus a little slack so
// the read head can never catch the write head at the extreme setting.
constexpr double kMaxEchoSeconds = 2.0;
constexpr int kEchoLineSlackSamples = 64;

// Below this the compressor envelope is treated as silence — log10 of a
// true 0 is -inf and the gain computer has nothing to act on anyway.
constexpr float kEnvelopeFloor = 1.0e-6f;

}  // namespace

// ===== Biquad (RBJ Audio EQ Cookbook) =====

void Biquad::set(double b0, double b1, double b2, double a0, double a1,
                 double a2) {
  b0_ = b0 / a0;
  b1_ = b1 / a0;
  b2_ = b2 / a0;
  a1_ = a1 / a0;
  a2_ = a2 / a0;
}

// Cookbook variable names kept on purpose (A, w0, cw, sw, alpha) so the
// formulas can be checked line-by-line against the RBJ reference.
Biquad::ShelfTerms Biquad::shelfTerms(double sample_rate, double f0,
                                      double gain_db) {
  const double A = std::pow(10.0, gain_db / 40.0);
  const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sample_rate;
  const double cw = std::cos(w0), sw = std::sin(w0);
  const double alpha =
      sw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / kShelfSlope - 1.0) + 2.0);
  return {A, cw, 2.0 * std::sqrt(A) * alpha};
}

void Biquad::setLowShelf(double sr, double f0, double gainDb) {
  const auto [A, cw, sq] = shelfTerms(sr, f0, gainDb);
  set(A * ((A + 1) - (A - 1) * cw + sq), 2 * A * ((A - 1) - (A + 1) * cw),
      A * ((A + 1) - (A - 1) * cw - sq), (A + 1) + (A - 1) * cw + sq,
      -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sq);
}

void Biquad::setPeaking(double sr, double f0, double q, double gainDb) {
  const double A = std::pow(10.0, gainDb / 40.0);
  const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
  const double cw = std::cos(w0);
  const double alpha = std::sin(w0) / (2.0 * q);
  set(1 + alpha * A, -2 * cw, 1 - alpha * A, 1 + alpha / A, -2 * cw,
      1 - alpha / A);
}

void Biquad::setHighShelf(double sr, double f0, double gainDb) {
  const auto [A, cw, sq] = shelfTerms(sr, f0, gainDb);
  set(A * ((A + 1) + (A - 1) * cw + sq), -2 * A * ((A - 1) + (A + 1) * cw),
      A * ((A + 1) + (A - 1) * cw - sq), (A + 1) - (A - 1) * cw + sq,
      2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sq);
}

// ===== EQ =====

void FxEQ::prepare(double sampleRate) {
  sr_ = sampleRate;
  low_.reset();
  mid_.reset();
  high_.reset();
  low_r_.reset();
  mid_r_.reset();
  high_r_.reset();
  dirty_.store(true);
}

void FxEQ::updateCoeffs() {
  low_.setLowShelf(sr_, kLowShelfHz, low_db.load());
  mid_.setPeaking(sr_, kMidPeakHz, kMidQ, mid_db.load());
  high_.setHighShelf(sr_, kHighShelfHz, high_db.load());
  low_r_.setLowShelf(sr_, kLowShelfHz, low_db.load());
  mid_r_.setPeaking(sr_, kMidPeakHz, kMidQ, mid_db.load());
  high_r_.setHighShelf(sr_, kHighShelfHz, high_db.load());
}

void FxEQ::process(float* x, int n) {
  if (dirty_.exchange(false)) updateCoeffs();  // cheap, allocation-free
  for (int i = 0; i < n; ++i) {
    x[i] = high_.processSample(mid_.processSample(low_.processSample(x[i])));
  }
}

void FxEQ::processStereo(float* l, float* r, int n) {
  if (dirty_.exchange(false)) updateCoeffs();
  for (int i = 0; i < n; ++i) {
    l[i] = high_.processSample(mid_.processSample(low_.processSample(l[i])));
    r[i] =
        high_r_.processSample(mid_r_.processSample(low_r_.processSample(r[i])));
  }
}

// ===== Compressor =====

void FxCompressor::prepare(double sampleRate) {
  sr_ = sampleRate;
  env_ = 0.0f;
}

FxCompressor::Coefficients FxCompressor::loadCoefficients() const {
  return {
      threshold_db.load(),
      juce::jmax(1.0f, ratio.load()),
      std::exp(-1.0f /
               (juce::jmax(0.1f, attack_ms.load()) * 0.001f * (float)sr_)),
      std::exp(-1.0f /
               (juce::jmax(1.0f, release_ms.load()) * 0.001f * (float)sr_)),
      std::pow(10.0f, makeup_db.load() / 20.0f),
  };
}

float FxCompressor::gainStep(float detector, const Coefficients& c) {
  // Peak envelope: fast attack, slow release.
  env_ = detector > env_ ? c.attack * env_ + (1.0f - c.attack) * detector
                         : c.release * env_ + (1.0f - c.release) * detector;
  if (env_ <= kEnvelopeFloor) return 1.0f;
  const float envelope_db = 20.0f * std::log10(env_);
  if (envelope_db <= c.threshold_db) return 1.0f;
  const float output_db =
      c.threshold_db + (envelope_db - c.threshold_db) / c.ratio;
  return std::pow(10.0f, (output_db - envelope_db) / 20.0f);
}

void FxCompressor::process(float* x, int n) {
  const Coefficients c = loadCoefficients();
  float min_gain = 1.0f;  // deepest reduction this block → GR meter
  for (int i = 0; i < n; ++i) {
    const float gain = gainStep(std::abs(x[i]), c);
    if (gain < min_gain) min_gain = gain;
    x[i] *= gain * c.makeup;
  }
  gr_db_.store(min_gain < 1.0f ? -20.0f * std::log10(min_gain) : 0.0f);
}

void FxCompressor::processStereo(float* l, float* r, int n) {
  const Coefficients c = loadCoefficients();
  float min_gain = 1.0f;
  for (int i = 0; i < n; ++i) {
    // Stereo-linked: one envelope from the louder channel, one gain to
    // both — per-channel envelopes would pull the image toward the
    // quieter side on every transient.
    const float gain = gainStep(juce::jmax(std::abs(l[i]), std::abs(r[i])), c);
    if (gain < min_gain) min_gain = gain;
    l[i] *= gain * c.makeup;
    r[i] *= gain * c.makeup;
  }
  gr_db_.store(min_gain < 1.0f ? -20.0f * std::log10(min_gain) : 0.0f);
}

// ===== Echo =====

void FxEcho::prepare(double sampleRate) {
  sr_ = sampleRate;
  const int line_length =
      (int)(kMaxEchoSeconds * sampleRate) + kEchoLineSlackSamples;
  line_.assign((size_t)line_length, 0.0f);  // message thread only
  line_r_.assign((size_t)line_length, 0.0f);
  write_ = 0;
}

FxEcho::Parameters FxEcho::loadParameters(int line_length) const {
  return {
      juce::jlimit(1, line_length - 1, (int)(time_s.load() * (float)sr_)),
      juce::jlimit(0.0f, 0.9f, feedback.load()),
      juce::jlimit(0.0f, 1.0f, mix.load()),
  };
}

void FxEcho::process(float* x, int n) {
  const int line_length = (int)line_.size();
  if (line_length == 0) return;  // enabled before prepare: fail silent
  const Parameters p = loadParameters(line_length);

  for (int i = 0; i < n; ++i) {
    int read = write_ - p.delay;
    if (read < 0) read += line_length;
    const float delayed = line_[(size_t)read];
    line_[(size_t)write_] = x[i] + delayed * p.feedback;
    x[i] += delayed * p.wet;
    if (++write_ >= line_length) write_ = 0;
  }
}

void FxEcho::processStereo(float* l, float* r, int n) {
  const int line_length = (int)line_.size();
  if (line_length == 0 || (int)line_r_.size() != line_length) return;
  const Parameters p = loadParameters(line_length);

  for (int i = 0; i < n; ++i) {
    int read = write_ - p.delay;
    if (read < 0) read += line_length;
    const float delayed_left = line_[(size_t)read];
    const float delayed_right = line_r_[(size_t)read];
    line_[(size_t)write_] = l[i] + delayed_left * p.feedback;
    line_r_[(size_t)write_] = r[i] + delayed_right * p.feedback;
    l[i] += delayed_left * p.wet;
    r[i] += delayed_right * p.wet;
    if (++write_ >= line_length) write_ = 0;
  }
}

// ===== Reverb =====

void FxReverb::prepare(double sampleRate) {
  // Apply the law BEFORE setSampleRate: juce::Reverb's level smoothers
  // snap to their targets on reset, so the first block runs at our
  // dry/wet instead of ramping in from Freeverb's defaults.
  applyParams();
  reverb_.setSampleRate(sampleRate);
  reverb_.reset();
  dirty_.store(false);
}

void FxReverb::applyParams() {
  juce::Reverb::Parameters p;
  p.roomSize = juce::jlimit(0.0f, 1.0f, size.load());
  p.damping = juce::jlimit(0.0f, 1.0f, damp.load());
  // MIX LAW: an equal-power crossfade, unity-preserving — dry cos(θ),
  // wet sin(θ) with θ = mix·π/2 (mix 0 = bit-exact dry, mix 1 = fully
  // wet, mix 0.5 = both at −3 dB). juce::Reverb SCALES its levels
  // internally (dry ×2, wet ×3 — Freeverb's convention, where the
  // defaults are 0.4/0.33); passing dry = 1.0 boosted the dry signal
  // +6 dB the moment the slot enabled (field: "reverb makes the track
  // louder", 2026-08-18). Divide the scales back out here.
  const float m = juce::jlimit(0.0f, 1.0f, mix.load());
  const float theta = m * juce::MathConstants<float>::halfPi;
  p.wetLevel = std::sin(theta) / 3.0f;
  p.dryLevel = std::cos(theta) / 2.0f;
  p.width = 1.0f;
  reverb_.setParameters(p);
}

void FxReverb::process(float* x, int n) {
  if (dirty_.exchange(false)) applyParams();
  reverb_.processMono(x, n);
}

void FxReverb::processStereo(float* l, float* r, int n) {
  if (dirty_.exchange(false)) applyParams();
  reverb_.processStereo(l, r, n);
}

}  // namespace celestrian::dsp
