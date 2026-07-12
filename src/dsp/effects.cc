#include "effects.h"

#include <cmath>

namespace celestrian::dsp {

// ===== Biquad (RBJ Audio EQ Cookbook) =====

void Biquad::set(double b0, double b1, double b2, double a0, double a1,
                 double a2) {
  b0_ = b0 / a0;
  b1_ = b1 / a0;
  b2_ = b2 / a0;
  a1_ = a1 / a0;
  a2_ = a2 / a0;
}

void Biquad::setLowShelf(double sr, double f0, double gainDb) {
  const double A = std::pow(10.0, gainDb / 40.0);
  const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
  const double cw = std::cos(w0), sw = std::sin(w0);
  const double S = 0.9;
  const double alpha =
      sw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
  const double sq = 2.0 * std::sqrt(A) * alpha;
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
  const double A = std::pow(10.0, gainDb / 40.0);
  const double w0 = 2.0 * juce::MathConstants<double>::pi * f0 / sr;
  const double cw = std::cos(w0), sw = std::sin(w0);
  const double S = 0.9;
  const double alpha =
      sw / 2.0 * std::sqrt((A + 1.0 / A) * (1.0 / S - 1.0) + 2.0);
  const double sq = 2.0 * std::sqrt(A) * alpha;
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
  dirty_.store(true);
}

void FxEQ::updateCoeffs() {
  low_.setLowShelf(sr_, 120.0, low_db.load());
  mid_.setPeaking(sr_, 1000.0, 0.7, mid_db.load());
  high_.setHighShelf(sr_, 6000.0, high_db.load());
}

void FxEQ::process(float* x, int n) {
  if (dirty_.exchange(false)) updateCoeffs();  // cheap, allocation-free
  for (int i = 0; i < n; ++i) {
    x[i] = high_.processSample(mid_.processSample(low_.processSample(x[i])));
  }
}

// ===== Compressor =====

void FxCompressor::prepare(double sampleRate) {
  sr_ = sampleRate;
  env_ = 0.0f;
}

void FxCompressor::process(float* x, int n) {
  const float thr = threshold_db.load();
  const float rat = juce::jmax(1.0f, ratio.load());
  const float atk =
      std::exp(-1.0f / (juce::jmax(0.1f, attack_ms.load()) * 0.001f * (float)sr_));
  const float rel =
      std::exp(-1.0f / (juce::jmax(1.0f, release_ms.load()) * 0.001f * (float)sr_));
  const float makeup = std::pow(10.0f, makeup_db.load() / 20.0f);

  for (int i = 0; i < n; ++i) {
    const float a = std::abs(x[i]);
    // Peak envelope: fast attack, slow release
    env_ = a > env_ ? atk * env_ + (1.0f - atk) * a
                    : rel * env_ + (1.0f - rel) * a;
    float gain = 1.0f;
    if (env_ > 1.0e-6f) {
      const float envDb = 20.0f * std::log10(env_);
      if (envDb > thr) {
        const float outDb = thr + (envDb - thr) / rat;
        gain = std::pow(10.0f, (outDb - envDb) / 20.0f);
      }
    }
    x[i] *= gain * makeup;
  }
}

// ===== Echo =====

void FxEcho::prepare(double sampleRate) {
  sr_ = sampleRate;
  const int len = (int)(2.0 * sampleRate) + 64;  // max time_s = 2.0
  line_.assign((size_t)len, 0.0f);               // message thread only
  write_ = 0;
}

void FxEcho::process(float* x, int n) {
  const int len = (int)line_.size();
  if (len == 0) return;  // enabled before prepare: fail silent, not loud
  const int delay =
      juce::jlimit(1, len - 1, (int)(time_s.load() * (float)sr_));
  const float fb = juce::jlimit(0.0f, 0.9f, feedback.load());
  const float wet = juce::jlimit(0.0f, 1.0f, mix.load());

  for (int i = 0; i < n; ++i) {
    int read = write_ - delay;
    if (read < 0) read += len;
    const float delayed = line_[(size_t)read];
    line_[(size_t)write_] = x[i] + delayed * fb;
    x[i] += delayed * wet;
    if (++write_ >= len) write_ = 0;
  }
}

// ===== Reverb =====

void FxReverb::prepare(double sampleRate) {
  reverb_.setSampleRate(sampleRate);
  reverb_.reset();
  dirty_.store(true);
}

void FxReverb::process(float* x, int n) {
  if (dirty_.exchange(false)) {
    juce::Reverb::Parameters p;
    p.roomSize = juce::jlimit(0.0f, 1.0f, size.load());
    p.damping = juce::jlimit(0.0f, 1.0f, damp.load());
    p.wetLevel = juce::jlimit(0.0f, 1.0f, mix.load());
    p.dryLevel = 1.0f;
    p.width = 1.0f;
    reverb_.setParameters(p);
  }
  reverb_.processMono(x, n);
}

// ===== Rack =====

void EffectRack::prepare(double sampleRate) {
  if (prepared_sr_ == sampleRate) return;
  prepared_sr_ = sampleRate;
  eq.prepare(sampleRate);
  compressor.prepare(sampleRate);
  echo.prepare(sampleRate);
  reverb.prepare(sampleRate);
}

void EffectRack::process(float* x, int n) {
  // Canonical signal order: corrective (EQ) → dynamics → time effects
  if (eq.enabled.load()) eq.process(x, n);
  if (compressor.enabled.load()) compressor.process(x, n);
  if (echo.enabled.load()) echo.process(x, n);
  if (reverb.enabled.load()) reverb.process(x, n);
}

bool EffectRack::setEnabled(const juce::String& fx, bool on) {
  if (fx == "eq") eq.enabled.store(on);
  else if (fx == "compressor") compressor.enabled.store(on);
  else if (fx == "echo") echo.enabled.store(on);
  else if (fx == "reverb") reverb.enabled.store(on);
  else return false;
  return true;
}

bool EffectRack::setParam(const juce::String& fx, const juce::String& key,
                          double v) {
  const float f = (float)v;
  if (fx == "eq") {
    if (key == "low") eq.low_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else if (key == "mid") eq.mid_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else if (key == "high") eq.high_db.store(juce::jlimit(-12.0f, 12.0f, f));
    else return false;
    eq.markDirty();
    return true;
  }
  if (fx == "compressor") {
    if (key == "threshold") compressor.threshold_db.store(juce::jlimit(-60.0f, 0.0f, f));
    else if (key == "ratio") compressor.ratio.store(juce::jlimit(1.0f, 20.0f, f));
    else if (key == "attack") compressor.attack_ms.store(juce::jlimit(0.1f, 100.0f, f));
    else if (key == "release") compressor.release_ms.store(juce::jlimit(10.0f, 1000.0f, f));
    else if (key == "makeup") compressor.makeup_db.store(juce::jlimit(0.0f, 24.0f, f));
    else return false;
    return true;
  }
  if (fx == "echo") {
    if (key == "time") echo.time_s.store(juce::jlimit(0.05f, 2.0f, f));
    else if (key == "feedback") echo.feedback.store(juce::jlimit(0.0f, 0.9f, f));
    else if (key == "mix") echo.mix.store(juce::jlimit(0.0f, 1.0f, f));
    else return false;
    return true;
  }
  if (fx == "reverb") {
    if (key == "size") reverb.size.store(juce::jlimit(0.0f, 1.0f, f));
    else if (key == "damp") reverb.damp.store(juce::jlimit(0.0f, 1.0f, f));
    else if (key == "mix") reverb.mix.store(juce::jlimit(0.0f, 1.0f, f));
    else return false;
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
  return juce::var(fx.get());
}

}  // namespace celestrian::dsp
