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
  low_r_.reset();
  mid_r_.reset();
  high_r_.reset();
  dirty_.store(true);
}

void FxEQ::updateCoeffs() {
  low_.setLowShelf(sr_, 120.0, low_db.load());
  mid_.setPeaking(sr_, 1000.0, 0.7, mid_db.load());
  high_.setHighShelf(sr_, 6000.0, high_db.load());
  low_r_.setLowShelf(sr_, 120.0, low_db.load());
  mid_r_.setPeaking(sr_, 1000.0, 0.7, mid_db.load());
  high_r_.setHighShelf(sr_, 6000.0, high_db.load());
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
    r[i] = high_r_.processSample(
        mid_r_.processSample(low_r_.processSample(r[i])));
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

  float min_gain = 1.0f;  // deepest reduction this block → GR meter
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
    if (gain < min_gain) min_gain = gain;
    x[i] *= gain * makeup;
  }
  gr_db_.store(min_gain < 1.0f ? -20.0f * std::log10(min_gain) : 0.0f);
}

void FxCompressor::processStereo(float* l, float* r, int n) {
  const float thr = threshold_db.load();
  const float rat = juce::jmax(1.0f, ratio.load());
  const float atk =
      std::exp(-1.0f / (juce::jmax(0.1f, attack_ms.load()) * 0.001f * (float)sr_));
  const float rel =
      std::exp(-1.0f / (juce::jmax(1.0f, release_ms.load()) * 0.001f * (float)sr_));
  const float makeup = std::pow(10.0f, makeup_db.load() / 20.0f);

  float min_gain = 1.0f;
  for (int i = 0; i < n; ++i) {
    // Stereo-linked: one envelope from the louder channel, one gain to
    // both — per-channel envelopes would pull the image toward the
    // quieter side on every transient.
    const float a = juce::jmax(std::abs(l[i]), std::abs(r[i]));
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
    if (gain < min_gain) min_gain = gain;
    l[i] *= gain * makeup;
    r[i] *= gain * makeup;
  }
  gr_db_.store(min_gain < 1.0f ? -20.0f * std::log10(min_gain) : 0.0f);
}

// ===== Echo =====

void FxEcho::prepare(double sampleRate) {
  sr_ = sampleRate;
  const int len = (int)(2.0 * sampleRate) + 64;  // max time_s = 2.0
  line_.assign((size_t)len, 0.0f);               // message thread only
  line_r_.assign((size_t)len, 0.0f);
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

void FxEcho::processStereo(float* l, float* r, int n) {
  const int len = (int)line_.size();
  if (len == 0 || (int)line_r_.size() != len) return;
  const int delay =
      juce::jlimit(1, len - 1, (int)(time_s.load() * (float)sr_));
  const float fb = juce::jlimit(0.0f, 0.9f, feedback.load());
  const float wet = juce::jlimit(0.0f, 1.0f, mix.load());

  for (int i = 0; i < n; ++i) {
    int read = write_ - delay;
    if (read < 0) read += len;
    const float dl = line_[(size_t)read];
    const float dr = line_r_[(size_t)read];
    line_[(size_t)write_] = l[i] + dl * fb;
    line_r_[(size_t)write_] = r[i] + dr * fb;
    l[i] += dl * wet;
    r[i] += dr * wet;
    if (++write_ >= len) write_ = 0;
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

void EffectRack::process(float* x, int n) {
  // Scope capture (pre-rack): copy + peak only — analysis happens on
  // the message thread at poll time (getMetadata). GATED on a panel
  // watching: no watcher, no copy.
  if (scope_on_.load() && !scope_.empty()) {
    float pk = 0.0f;
    int w = scope_write_.load();
    for (int i = 0; i < n; ++i) {
      scope_[(size_t)w] = x[i];
      w = (w + 1) & (kScopeSize - 1);
      const float a = std::abs(x[i]);
      if (a > pk) pk = a;
    }
    scope_write_.store(w);
    in_peak_.store(pk);
  }

  // Canonical signal order: corrective (EQ) → dynamics → time effects
  if (eq.enabled.load()) eq.process(x, n);
  if (compressor.enabled.load()) compressor.process(x, n);
  if (echo.enabled.load()) echo.process(x, n);
  if (reverb.enabled.load()) reverb.process(x, n);
}

void EffectRack::processStereo(float* l, float* r, int n) {
  // Scope capture: the L/R mean — the spectrum/peak displays are mono
  // by design and the mean is what a listener centers on.
  if (scope_on_.load() && !scope_.empty()) {
    float pk = 0.0f;
    int w = scope_write_.load();
    for (int i = 0; i < n; ++i) {
      const float m = 0.5f * (l[i] + r[i]);
      scope_[(size_t)w] = m;
      w = (w + 1) & (kScopeSize - 1);
      const float a = std::abs(m);
      if (a > pk) pk = a;
    }
    scope_write_.store(w);
    in_peak_.store(pk);
  }

  if (eq.enabled.load()) eq.processStereo(l, r, n);
  if (compressor.enabled.load()) compressor.processStereo(l, r, n);
  if (echo.enabled.load()) echo.processStereo(l, r, n);
  if (reverb.enabled.load()) reverb.processStereo(l, r, n);
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
    else if (key == "makeup") compressor.makeup_db.store(juce::jlimit(-12.0f, 24.0f, f));
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

  // Scope telemetry for the card visualizations — computed HERE, on the
  // message thread at poll cadence (~20 Hz), never on the audio thread.
  // Published only while a panel WATCHES (setEffectScope): closed
  // panels pay nothing, and an open panel gets live data even before
  // any slot is enabled (line up the threshold first, then commit).
  if (scope_on_.load() && !scope_.empty() && prepared_sr_ > 0) {
    juce::Array<juce::var> spec;
    const double sr = prepared_sr_;
    const double fLo = 40.0;
    const double fHi = juce::jmin(16000.0, sr * 0.45);
    for (int b = 0; b < kSpectrumBins; ++b) {
      const double f =
          fLo * std::pow(fHi / fLo, (double)b / (kSpectrumBins - 1));
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
      const double mag =
          std::sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / (kScopeSize / 2.0);
      const double db = 20.0 * std::log10(mag + 1.0e-9);
      spec.add(juce::jlimit(0.0, 1.0, (db + 60.0) / 60.0));
    }
    juce::DynamicObject::Ptr scope = new juce::DynamicObject();
    scope->setProperty("spectrum", spec);
    scope->setProperty("peak", in_peak_.load());
    scope->setProperty("gr", compressor.currentGainReductionDb());
    fx->setProperty("scope", juce::var(scope.get()));
  }
  return juce::var(fx.get());
}

}  // namespace celestrian::dsp
