#include "fx_chain.h"

#include <algorithm>
#include <cmath>

namespace celestrian::dsp {

namespace {
// Spectrum display range (moved verbatim from the rack): log-spaced
// bins between these bounds (capped under Nyquist), normalized over the
// top kSpectrumRangeDb decibels.
constexpr double kSpectrumMinHz = 40.0;
constexpr double kSpectrumMaxHz = 16000.0;
constexpr double kNyquistFraction = 0.45;
constexpr double kSpectrumFloor = 1.0e-9;
constexpr double kSpectrumRangeDb = 60.0;
}  // namespace

// ===== Built-in slot params (clamps moved verbatim from the rack) =====

bool EqSlot::setParam(const juce::String& key, double value) {
  const float f = (float)value;
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

void EqSlot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("low", eq.low_db.load());
  out.setProperty("mid", eq.mid_db.load());
  out.setProperty("high", eq.high_db.load());
}

bool CompressorSlot::setParam(const juce::String& key, double value) {
  const float f = (float)value;
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

void CompressorSlot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("threshold", compressor.threshold_db.load());
  out.setProperty("ratio", compressor.ratio.load());
  out.setProperty("attack", compressor.attack_ms.load());
  out.setProperty("release", compressor.release_ms.load());
  out.setProperty("makeup", compressor.makeup_db.load());
}

bool EchoSlot::setParam(const juce::String& key, double value) {
  const float f = (float)value;
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

void EchoSlot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("time", echo.time_s.load());
  out.setProperty("feedback", echo.feedback.load());
  out.setProperty("mix", echo.mix.load());
}

bool ReverbSlot::setParam(const juce::String& key, double value) {
  const float f = (float)value;
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

void ReverbSlot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("size", reverb.size.load());
  out.setProperty("damp", reverb.damp.load());
  out.setProperty("mix", reverb.mix.load());
}

// ===== Chain =====

std::unique_ptr<FxChain> FxChain::makeDefault() {
  std::vector<std::shared_ptr<FxSlot>> slots;
  slots.reserve(kBuiltInTypes.size());
  for (const char* type : kBuiltInTypes) slots.push_back(makeBuiltIn(type));
  return makeFromSlots(std::move(slots));
}

std::unique_ptr<FxChain> FxChain::makeFromSlots(
    std::vector<std::shared_ptr<FxSlot>> slots) {
  return std::unique_ptr<FxChain>(new FxChain(std::move(slots)));
}

std::shared_ptr<FxSlot> FxChain::makeBuiltIn(const juce::String& type_id) {
  if (type_id == "eq") return std::make_shared<EqSlot>();
  if (type_id == "compressor") return std::make_shared<CompressorSlot>();
  if (type_id == "echo") return std::make_shared<EchoSlot>();
  if (type_id == "reverb") return std::make_shared<ReverbSlot>();
  return nullptr;
}

FxSlot* FxChain::findSlot(const juce::String& slot_uuid) const {
  for (const auto& slot : slots_)
    if (slot->slotUuid() == slot_uuid) return slot.get();
  return nullptr;
}

int FxChain::indexOfSlot(const juce::String& slot_uuid) const {
  for (size_t i = 0; i < slots_.size(); ++i)
    if (slots_[i]->slotUuid() == slot_uuid) return (int)i;
  return -1;
}

namespace {
// The promotion scratch ceiling — matches the engine's mix_buffer
// ceiling (blocks are never larger in practice; a larger one skips
// promotion-needing slots, fail-silent).
constexpr int kMaxPromotionBlock = 8192;
}  // namespace

void FxChain::prepare(double sample_rate) {
  for (const auto& slot : slots_) slot->prepare(sample_rate);
  if (promotion_scratch_.empty() &&
      std::any_of(slots_.begin(), slots_.end(),
                  [](const auto& s) { return s->wantsStereo(); })) {
    promotion_scratch_.assign((size_t)kMaxPromotionBlock, 0.0f);
  }
}

bool FxChain::run(float* l, float* r, int sample_count, bool stereo_in) {
  bool stereo = stereo_in;
  bool internal_right = false;  // r is the chain's own scratch
  float* right = stereo ? r : nullptr;
  for (const auto& slot : slots_) {
    if (!slot->enabled.load()) continue;
    if (!stereo && slot->wantsStereo()) {
      // Q-V1 promotion at the first enabled VST3 slot: duplicate the
      // mono signal into the right channel and go stereo from here.
      if (r != nullptr) {
        right = r;
      } else if ((int)promotion_scratch_.size() >= sample_count) {
        right = promotion_scratch_.data();
        internal_right = true;
      } else {
        continue;  // no usable right buffer: skip the slot, fail silent
      }
      juce::FloatVectorOperations::copy(right, l, sample_count);
      stereo = true;
    }
    if (stereo)
      slot->processStereo(l, right, sample_count);
    else
      slot->process(l, sample_count);
  }
  if (internal_right) {
    // Mono caller: fold the promoted pair back down, equal halves.
    juce::FloatVectorOperations::multiply(l, 0.5f, sample_count);
    juce::FloatVectorOperations::addWithMultiply(l, right, 0.5f,
                                                 sample_count);
    return false;
  }
  return stereo;
}

bool FxChain::anyEnabled() const {
  for (const auto& slot : slots_)
    if (slot->enabled.load()) return true;
  return false;
}

int FxChain::enabledCount() const {
  int count = 0;
  for (const auto& slot : slots_)
    if (slot->enabled.load()) ++count;
  return count;
}

juce::var FxChain::getMetadata(bool include_persistent_state) const {
  juce::Array<juce::var> chain;
  for (const auto& slot : slots_) {
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty("slot", slot->slotUuid());
    o->setProperty("type", slot->typeId());
    o->setProperty("enabled", slot->enabled.load());
    slot->fillParams(*o);
    if (include_persistent_state) slot->fillPersistentExtras(*o);
    chain.add(juce::var(o.get()));
  }
  return juce::var(chain);
}

float FxChain::compressorGainReductionDb() const {
  for (const auto& slot : slots_) {
    if (auto* comp = dynamic_cast<const CompressorSlot*>(slot.get()))
      return comp->compressor.currentGainReductionDb();
  }
  return 0.0f;
}

int FxChain::totalLatencySamples() const {
  int total = 0;
  for (const auto& slot : slots_)
    if (slot->enabled.load()) total += slot->latencySamples();
  return total;
}

// ===== Scope =====

void FxScope::prepare(double sample_rate) {
  if (prepared_sample_rate_ == sample_rate) return;
  prepared_sample_rate_ = sample_rate;
  ring_.assign((size_t)kScopeSize, 0.0f);  // message thread only
  write_.store(0);
}

void FxScope::capture(const float* left, const float* right,
                      int sample_count) {
  // Copy + peak only — analysis happens on the message thread at poll
  // time (metadataVar). GATED on a panel watching: no watcher, no copy.
  if (!scope_on_.load() || ring_.empty()) return;
  float peak = 0.0f;
  int w = write_.load();
  for (int i = 0; i < sample_count; ++i) {
    const float sample = right ? 0.5f * (left[i] + right[i]) : left[i];
    ring_[(size_t)w] = sample;
    w = (w + 1) & (kScopeSize - 1);
    const float a = std::abs(sample);
    if (a > peak) peak = a;
  }
  write_.store(w);
  in_peak_.store(peak);
}

juce::var FxScope::metadataVar(float gr) const {
  // Published only while a panel WATCHES (setEffectScope): closed
  // panels pay nothing, and an open panel gets live data even before
  // any slot is enabled (line up the threshold first, then commit).
  if (!scope_on_.load() || ring_.empty() || prepared_sample_rate_ <= 0)
    return juce::var();
  juce::Array<juce::var> spectrum;
  const double sr = prepared_sample_rate_;
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
      const double s0 = (double)ring_[(size_t)i] + coeff * s1 - s2;
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
  scope->setProperty("gr", gr);
  return juce::var(scope.get());
}

}  // namespace celestrian::dsp
