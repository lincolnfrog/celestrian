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

// Spectrum display range: log-spaced bins between these bounds (capped
// under Nyquist), normalized over the top kSpectrumRangeDb decibels.
constexpr double kSpectrumMinHz = 40.0;
constexpr double kSpectrumMaxHz = 16000.0;
constexpr double kNyquistFraction = 0.45;
constexpr double kSpectrumFloor = 1.0e-9;
constexpr double kSpectrumRangeDb = 60.0;
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
  reverb_.setSampleRate(sampleRate);
  reverb_.reset();
  dirty_.store(true);
}

void FxReverb::applyParams() {
  juce::Reverb::Parameters p;
  p.roomSize = juce::jlimit(0.0f, 1.0f, size.load());
  p.damping = juce::jlimit(0.0f, 1.0f, damp.load());
  p.wetLevel = juce::jlimit(0.0f, 1.0f, mix.load());
  p.dryLevel = 1.0f;
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

// ===== Rack =====

void EffectRack::prepare(double sampleRate) {
  if (prepared_sr_ == sampleRate) return;
  prepared_sr_ = sampleRate;
  eq.prepare(sampleRate);
  compressor.prepare(sampleRate);
  echo.prepare(sampleRate);
  reverb.prepare(sampleRate);
  scope_.assign((size_t)kScopeSize, 0.0f);  // message thread only
  scope_write_.store(0);
}

void EffectRack::captureScope(const float* left, const float* right, int n) {
  // Copy + peak only — analysis happens on the message thread at poll
  // time (getMetadata). GATED on a panel watching: no watcher, no copy.
  if (!scope_on_.load() || scope_.empty()) return;
  float peak = 0.0f;
  int w = scope_write_.load();
  for (int i = 0; i < n; ++i) {
    const float sample = right ? 0.5f * (left[i] + right[i]) : left[i];
    scope_[(size_t)w] = sample;
    w = (w + 1) & (kScopeSize - 1);
    const float a = std::abs(sample);
    if (a > peak) peak = a;
  }
  scope_write_.store(w);
  in_peak_.store(peak);
}

void EffectRack::process(float* x, int n) {
  captureScope(x, nullptr, n);

  // Canonical signal order: corrective (EQ) → dynamics → time effects
  if (eq.enabled.load()) eq.process(x, n);
  if (compressor.enabled.load()) compressor.process(x, n);
  if (echo.enabled.load()) echo.process(x, n);
  if (reverb.enabled.load()) reverb.process(x, n);
}

void EffectRack::processStereo(float* l, float* r, int n) {
  captureScope(l, r, n);

  if (eq.enabled.load()) eq.processStereo(l, r, n);
  if (compressor.enabled.load()) compressor.processStereo(l, r, n);
  if (echo.enabled.load()) echo.processStereo(l, r, n);
  if (reverb.enabled.load()) reverb.processStereo(l, r, n);
}

bool EffectRack::setEnabled(const juce::String& fx, bool on) {
  if (fx == "eq")
    eq.enabled.store(on);
  else if (fx == "compressor")
    compressor.enabled.store(on);
  else if (fx == "echo")
    echo.enabled.store(on);
  else if (fx == "reverb")
    reverb.enabled.store(on);
  else
    return false;
  return true;
}

bool EffectRack::setParam(const juce::String& fx, const juce::String& key,
                          double v) {
  const float f = (float)v;
  if (fx == "eq") {
    if (key == "low")
      eq.low_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else if (key == "mid")
      eq.mid_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else if (key == "high")
      eq.high_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else
      return false;
    eq.markDirty();
    return true;
  }
  if (fx == "compressor") {
    if (key == "threshold")
      compressor.threshold_db.store(juce::jlimit(-60.0f, 0.0f, f));
    else if (key == "ratio")
      compressor.ratio.store(juce::jlimit(1.0f, 20.0f, f));
    else if (key == "attack")
      compressor.attack_ms.store(juce::jlimit(0.1f, 100.0f, f));
    else if (key == "release")
      compressor.release_ms.store(juce::jlimit(10.0f, 1000.0f, f));
    else if (key == "makeup")
      compressor.makeup_db.store(juce::jlimit(-12.0f, 24.0f, f));
    else
      return false;
    return true;
  }
  if (fx == "echo") {
    if (key == "time")
      echo.time_s.store(juce::jlimit(0.05f, 2.0f, f));
    else if (key == "feedback")
      echo.feedback.store(juce::jlimit(0.0f, 0.9f, f));
    else if (key == "mix")
      echo.mix.store(juce::jlimit(0.0f, 1.0f, f));
    else
      return false;
    return true;
  }
  if (fx == "reverb") {
    if (key == "size")
      reverb.size.store(juce::jlimit(0.0f, 1.0f, f));
    else if (key == "damp")
      reverb.damp.store(juce::jlimit(0.0f, 1.0f, f));
    else if (key == "mix")
      reverb.mix.store(juce::jlimit(0.0f, 1.0f, f));
    else
      return false;
    reverb.markDirty();
    return true;
  }
  return false;
}

juce::var EffectRack::getMetadata() const {
  auto make = [](std::initializer_list<std::pair<const char*, double>> kv,
                 bool on) {
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty("enabled", on);
    for (auto& [k, v] : kv) o->setProperty(k, v);
    return juce::var(o.get());
  };
  juce::DynamicObject::Ptr fx = new juce::DynamicObject();
  fx->setProperty("eq", make({{"low", eq.low_db.load()},
                              {"mid", eq.mid_db.load()},
                              {"high", eq.high_db.load()}},
                             eq.enabled.load()));
  fx->setProperty("compressor",
                  make({{"threshold", compressor.threshold_db.load()},
                        {"ratio", compressor.ratio.load()},
                        {"attack", compressor.attack_ms.load()},
                        {"release", compressor.release_ms.load()},
                        {"makeup", compressor.makeup_db.load()}},
                       compressor.enabled.load()));
  fx->setProperty("echo", make({{"time", echo.time_s.load()},
                                {"feedback", echo.feedback.load()},
                                {"mix", echo.mix.load()}},
                               echo.enabled.load()));
  fx->setProperty("reverb", make({{"size", reverb.size.load()},
                                  {"damp", reverb.damp.load()},
                                  {"mix", reverb.mix.load()}},
                                 reverb.enabled.load()));

  // Scope telemetry for the card visualizations — computed HERE, on the
  // message thread at poll cadence (~20 Hz), never on the audio thread.
  // Published only while a panel WATCHES (setEffectScope): closed
  // panels pay nothing, and an open panel gets live data even before
  // any slot is enabled (line up the threshold first, then commit).
  if (scope_on_.load() && !scope_.empty() && prepared_sr_ > 0) {
    juce::Array<juce::var> spectrum;
    const double sr = prepared_sr_;
    const double low_hz = kSpectrumMinHz;
    const double high_hz = juce::jmin(kSpectrumMaxHz, sr * kNyquistFraction);
    for (int b = 0; b < kSpectrumBins; ++b) {
      const double f =
          low_hz * std::pow(high_hz / low_hz, (double)b / (kSpectrumBins - 1));
      // Goertzel over the ring. Ring order doesn't matter for the
      // magnitude of quasi-steady content; the seam only smears
      // transients — fine for a visualization.
      const double w = 2.0 * juce::MathConstants<double>::pi * f / sr;
      const double coeff = 2.0 * std::cos(w);
      double s1 = 0.0, s2 = 0.0;
      for (int i = 0; i < kScopeSize; ++i) {
        const double s0 = (double)scope_[(size_t)i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const double magnitude =
          std::sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (kScopeSize / 2.0);
      const double db = 20.0 * std::log10(magnitude + kSpectrumFloor);
      spectrum.add(
          juce::jlimit(0.0, 1.0, (db + kSpectrumRangeDb) / kSpectrumRangeDb));
    }
    juce::DynamicObject::Ptr scope = new juce::DynamicObject();
    scope->setProperty("spectrum", spectrum);
    scope->setProperty("peak", in_peak_.load());
    scope->setProperty("gr", compressor.currentGainReductionDb());
    fx->setProperty("scope", juce::var(scope.get()));
  }
  return juce::var(fx.get());
}

}  // namespace celestrian::dsp
