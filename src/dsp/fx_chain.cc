#include "fx_chain.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <string_view>

namespace celestrian::dsp {

namespace {
// Spectrum display range: log-spaced bins between these bounds (capped
// under Nyquist), normalized over the top kSpectrumRangeDb decibels.
constexpr double kSpectrumMinHz = 40.0;
constexpr double kSpectrumMaxHz = 16000.0;
constexpr double kNyquistFraction = 0.45;
constexpr double kSpectrumFloor = 1.0e-9;
constexpr double kSpectrumRangeDb = 60.0;

// ===== THE BUILT-IN PARAMETERS =====
//
// One row per parameter, and the only place one is declared: the key the
// bridge, the save format and the UI schema (ui/js/effect_schema.js)
// name it by, the atomic it lives in, and the range setParam clamps to.
// fillParams publishes a slot's rows in table order. The UI's schema
// mirrors the keys and ranges, and ui/js/tests/effect_contract.test.mjs
// parses these rows to hold it to them: keep a row on one line, its
// range as literals.
template <typename Fx>
struct Param {
  const char* key;
  std::atomic<float> Fx::*value;
  float min, max;
};

constexpr Param<FxEQ> kEqParams[] = {
    {"low", &FxEQ::low_db, -12.0f, 12.0f},
    {"mid", &FxEQ::mid_db, -12.0f, 12.0f},
    {"high", &FxEQ::high_db, -12.0f, 12.0f},
};

// `makeup` is an output trim: it may cut as well as raise.
constexpr Param<FxCompressor> kCompressorParams[] = {
    {"threshold", &FxCompressor::threshold_db, -60.0f, 0.0f},
    {"ratio", &FxCompressor::ratio, 1.0f, 20.0f},
    {"attack", &FxCompressor::attack_ms, 0.1f, 100.0f},
    {"release", &FxCompressor::release_ms, 10.0f, 1000.0f},
    {"makeup", &FxCompressor::makeup_db, -12.0f, 24.0f},
};

constexpr Param<FxEcho> kEchoParams[] = {
    {"time", &FxEcho::time_s, 0.05f, 2.0f},
    {"feedback", &FxEcho::feedback, 0.0f, 0.9f},
    {"mix", &FxEcho::mix, 0.0f, 1.0f},
};

constexpr Param<FxReverb> kReverbParams[] = {
    {"size", &FxReverb::size, 0.0f, 1.0f},
    {"damp", &FxReverb::damp, 0.0f, 1.0f},
    {"mix", &FxReverb::mix, 0.0f, 1.0f},
};

template <typename Fx, std::size_t N>
constexpr float maxOf(const Param<Fx> (&table)[N], std::string_view key) {
  for (const auto& p : table)
    if (key == p.key) return p.max;
  return 0.0f;
}
// A `time` past the echo's delay line would be cut to the line unheard.
static_assert(maxOf(kEchoParams, "time") <= FxEcho::kLineSeconds);

/** Stores `value`, clamped to its row's range, in the parameter `key`
 * names; false when the table has no such key. */
template <typename Fx, std::size_t N>
bool setFromTable(const Param<Fx> (&table)[N], Fx& fx, const juce::String& key,
                  double value) {
  for (const auto& p : table) {
    if (key != p.key) continue;
    (fx.*p.value).store(juce::jlimit(p.min, p.max, (float)value));
    return true;
  }
  return false;
}

template <typename Fx, std::size_t N>
void fillFromTable(const Param<Fx> (&table)[N], const Fx& fx,
                   juce::DynamicObject& out) {
  for (const auto& p : table) out.setProperty(p.key, (fx.*p.value).load());
}
}  // namespace

bool EqSlot::setParam(const juce::String& key, double value) {
  if (!setFromTable(kEqParams, eq, key, value)) return false;
  eq.markDirty();
  return true;
}

void EqSlot::fillParams(juce::DynamicObject& out) const {
  fillFromTable(kEqParams, eq, out);
}

bool CompressorSlot::setParam(const juce::String& key, double value) {
  return setFromTable(kCompressorParams, compressor, key, value);
}

void CompressorSlot::fillParams(juce::DynamicObject& out) const {
  fillFromTable(kCompressorParams, compressor, out);
}

bool EchoSlot::setParam(const juce::String& key, double value) {
  return setFromTable(kEchoParams, echo, key, value);
}

void EchoSlot::fillParams(juce::DynamicObject& out) const {
  fillFromTable(kEchoParams, echo, out);
}

bool ReverbSlot::setParam(const juce::String& key, double value) {
  if (!setFromTable(kReverbParams, reverb, key, value)) return false;
  reverb.markDirty();
  return true;
}

void ReverbSlot::fillParams(juce::DynamicObject& out) const {
  fillFromTable(kReverbParams, reverb, out);
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
  // Every chain is built here, so this is where the chain-head rule
  // holds: a slot upstream of an instrument would process silence and
  // be overwritten.
  std::stable_partition(slots.begin(), slots.end(),
                        [](const auto& s) { return s->isInstrument(); });
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

FxChain::FxChain(std::vector<std::shared_ptr<FxSlot>> slots)
    : slots_(std::move(slots)) {
  // Before publication: the audio thread reads the scratch's size and
  // data, so both are final by the time a chain can be run. Sized for
  // the block ceiling; a larger block skips the slots that need it
  // (run, fail-silent).
  if (std::any_of(slots_.begin(), slots_.end(),
                  [](const auto& s) { return s->wantsStereo(); })) {
    promotion_scratch_.assign((size_t)kMaxBlockSamples, 0.0f);
  }
}

void FxChain::prepare(double sample_rate) {
  for (const auto& slot : slots_) slot->prepare(sample_rate);
}

void FxChain::followRate(double sample_rate) {
  for (const auto& slot : slots_) slot->followRate(sample_rate);
}

bool FxChain::run(float* l, float* r, int sample_count, bool stereo_in,
                  const juce::MidiBuffer* live_midi) {
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
    if (stereo) {
      if (live_midi != nullptr)
        slot->processStereoMidi(l, right, sample_count, *live_midi);
      else
        slot->processStereo(l, right, sample_count);
    } else {
      slot->process(l, sample_count);
    }
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

bool FxChain::hasEnabledInstrument() const {
  for (const auto& slot : slots_)
    if (slot->enabled.load() && slot->isInstrument()) return true;
  return false;
}

bool FxChain::hasInstrumentSlot() const {
  return firstInstrumentSlot() != nullptr;
}

FxSlot* FxChain::firstInstrumentSlot() const {
  for (const auto& slot : slots_)
    if (slot->isInstrument()) return slot.get();
  return nullptr;
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
  prepared_sample_rate_ = sample_rate;
  if (!ring_.empty()) return;  // sized once: the audio thread writes it
  ring_.assign((size_t)kScopeSize, 0.0f);
  write_.store(0);
}

void FxScope::followRate(double sample_rate) {
  if (!ring_.empty()) prepared_sample_rate_ = sample_rate;
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
