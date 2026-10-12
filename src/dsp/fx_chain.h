#pragma once

#include <juce_audio_basics/juce_audio_basics.h>

#include <array>
#include <atomic>
#include <memory>
#include <vector>

#include "effects.h"

namespace celestrian {

/** THE BLOCK CEILING (performance.md §1): the largest block the graph
 * renders without touching the heap. Every per-block scratch — a clip's
 * pair, a stack's mix and accumulator, a chain's promotion buffer, a
 * hosted plugin's prepare — is sized for it up front, on the message
 * thread; device blocks do not exceed it. */
inline constexpr int kMaxBlockSamples = 8192;

}  // namespace celestrian

namespace celestrian::dsp {

/**
 * The per-node effect chain (docs/vst3.md §3): an ordered vector of
 * SLOTS. A slot wraps one of the four built-in effects (effects.h) or a
 * hosted plugin (vst3_slot.h) as a peer.
 *
 * PUBLICATION (performance.md §1): a node reaches its chain through ONE
 * atomic pointer. The MESSAGE thread builds a successor that shares the
 * untouched slot objects (shared_ptr — their DSP state survives a
 * reorder and dies with the last chain holding them), publishes it with
 * one exchange (AudioNode::exchangeFxChain) and retires the predecessor
 * through the engine reclaimer. The audio thread loads the pointer and
 * only READS the slot vector; parameter and enable changes are
 * slot-internal atomics, so a dial drag never republishes.
 *
 * A slot is addressed by its stable, persisted SLOT UUID — never by
 * index or type.
 */

/** One slot: a stable identity + enable flag around a processor.
 * `enabled` is a public atomic to match the effects.h house style.
 * Slots live in shared_ptrs (chains share them); a holder outside the
 * chains takes its own share through weak_from_this. */
class FxSlot : public std::enable_shared_from_this<FxSlot> {
 public:
  FxSlot() : slot_uuid_(juce::Uuid().toString()) {}
  virtual ~FxSlot() = default;

  const juce::String& slotUuid() const { return slot_uuid_; }
  /** Restore a persisted uuid on load (message thread, pre-publish). */
  void setSlotUuid(const juce::String& uuid) { slot_uuid_ = uuid; }

  /** The type id the save format and UI schema key on ("eq",
   * "compressor", "echo", "reverb", "vst3"). */
  virtual const char* typeId() const = 0;

  /** Message thread, before the first enable: the slot's FIRST prepare
   * allocates what process reads, at `sample_rate`. A slot that has
   * been prepared is left alone whatever rate is asked, so the call is
   * safe on a published chain — the audio thread never sees a prepared
   * slot's buffers move. A change of rate is followRate's. */
  void prepare(double sample_rate) {
    if (prepared_sample_rate_ > 0.0) return;
    prepared_sample_rate_ = sample_rate;
    doPrepare(sample_rate);
  }

  /** Message thread, and ONLY while no callback can run the slot (the
   * device is starting, or the slot's node is not in the graph): a slot
   * prepared at another rate re-prepares at this one, reallocating its
   * buffers. A slot never prepared stays so — its first enable
   * prepares it. */
  void followRate(double sample_rate) {
    if (prepared_sample_rate_ <= 0.0 || prepared_sample_rate_ == sample_rate)
      return;
    prepared_sample_rate_ = sample_rate;
    doPrepare(sample_rate);
  }

  // Audio thread: in-place, allocation-free.
  virtual void process(float* x, int sample_count) = 0;
  virtual void processStereo(float* l, float* r, int sample_count) = 0;
  /** Stereo pass WITH live MIDI (docs/vst3.md §8). Built-ins ignore the
   * events; VST3 slots feed them to processBlock. Only ever called on
   * the stereo path — instruments wantsStereo(), so the chain promotes
   * before any MIDI consumer runs. */
  virtual void processStereoMidi(float* l, float* r, int sample_count,
                                 const juce::MidiBuffer& midi) {
    juce::ignoreUnused(midi);
    processStereo(l, r, sample_count);
  }

  /** Message thread. False for an unknown key; the value is clamped to
   * the parameter's range (a built-in's is its row in fx_chain.cc). */
  virtual bool setParam(const juce::String& key, double value) = 0;

  /** Adds this slot's parameter properties to `out` (metadata/save). */
  virtual void fillParams(juce::DynamicObject& out) const = 0;

  /** Adds SAVE-ONLY properties (a VST3 slot's base64 state blob —
   * docs/vst3.md §6). Not part of the 20 Hz metadata poll. */
  virtual void fillPersistentExtras(juce::DynamicObject& out) const {
    juce::ignoreUnused(out);
  }

  /** Reported processing latency (docs/vst3.md §3.4). Built-ins are 0;
   * VST3 slots forward the plugin's report. */
  virtual int latencySamples() const { return 0; }

  /** True for slots that only process stereo (VST3, Q-V1): the chain
   * PROMOTES a mono signal to stereo at the first enabled such slot. */
  virtual bool wantsStereo() const { return false; }

  /** True for instrument slots (VST3 synths): they GENERATE the signal
   * (processBlock overwrites the buffer) and consume live MIDI, so the
   * chain keeps them at its head (FxChain::makeFromSlots). */
  virtual bool isInstrument() const { return false; }

  std::atomic<bool> enabled{false};

 private:
  virtual void doPrepare(double sample_rate) = 0;

  juce::String slot_uuid_;
  double prepared_sample_rate_ = 0.0;
};

/** The four built-in slots: identity and parameter shells around the
 * effects.h DSP classes. */
class EqSlot : public FxSlot {
 public:
  FxEQ eq;
  const char* typeId() const override { return "eq"; }
  void process(float* x, int n) override { eq.process(x, n); }
  void processStereo(float* l, float* r, int n) override {
    eq.processStereo(l, r, n);
  }
  bool setParam(const juce::String& key, double value) override;
  void fillParams(juce::DynamicObject& out) const override;

 private:
  void doPrepare(double sample_rate) override { eq.prepare(sample_rate); }
};

class CompressorSlot : public FxSlot {
 public:
  FxCompressor compressor;
  const char* typeId() const override { return "compressor"; }
  void process(float* x, int n) override { compressor.process(x, n); }
  void processStereo(float* l, float* r, int n) override {
    compressor.processStereo(l, r, n);
  }
  bool setParam(const juce::String& key, double value) override;
  void fillParams(juce::DynamicObject& out) const override;

 private:
  void doPrepare(double sample_rate) override {
    compressor.prepare(sample_rate);
  }
};

class EchoSlot : public FxSlot {
 public:
  FxEcho echo;
  const char* typeId() const override { return "echo"; }
  void process(float* x, int n) override { echo.process(x, n); }
  void processStereo(float* l, float* r, int n) override {
    echo.processStereo(l, r, n);
  }
  bool setParam(const juce::String& key, double value) override;
  void fillParams(juce::DynamicObject& out) const override;

 private:
  void doPrepare(double sample_rate) override { echo.prepare(sample_rate); }
};

class ReverbSlot : public FxSlot {
 public:
  FxReverb reverb;
  const char* typeId() const override { return "reverb"; }
  void process(float* x, int n) override { reverb.process(x, n); }
  void processStereo(float* l, float* r, int n) override {
    reverb.processStereo(l, r, n);
  }
  bool setParam(const juce::String& key, double value) override;
  void fillParams(juce::DynamicObject& out) const override;

 private:
  void doPrepare(double sample_rate) override { reverb.prepare(sample_rate); }
};

/** The chain: an IMMUTABLE ordered slot vector — a structure change
 * builds a successor with the static builders (PUBLICATION, above). */
class FxChain {
 public:
  /** The built-in type ids, canonical signal order — the ONE list the
   * default chain, the loader, and the UI schema key on. */
  static constexpr std::array<const char*, 4> kBuiltInTypes = {
      "eq", "compressor", "echo", "reverb"};

  /** A fresh default chain: the four built-ins, canonical order, all
   * disabled (audibly transparent). */
  static std::unique_ptr<FxChain> makeDefault();

  /** A chain over existing slots (successor build / loader). Instrument
   * slots are moved to the HEAD (stable): they overwrite the buffer, so
   * nothing may sit upstream of them (docs/vst3.md §8). */
  static std::unique_ptr<FxChain> makeFromSlots(
      std::vector<std::shared_ptr<FxSlot>> slots);

  /** A fresh built-in slot by type id; null for an unknown id. */
  static std::shared_ptr<FxSlot> makeBuiltIn(const juce::String& type_id);

  const std::vector<std::shared_ptr<FxSlot>>& slots() const { return slots_; }
  FxSlot* findSlot(const juce::String& slot_uuid) const;
  int indexOfSlot(const juce::String& slot_uuid) const;

  /** Message thread: every slot's first prepare (FxSlot::prepare) —
   * safe on a published chain. */
  void prepare(double sample_rate);
  /** Message thread, no callback able to run the chain: every prepared
   * slot moves to `sample_rate` (FxSlot::followRate). */
  void followRate(double sample_rate);

  /**
   * Audio thread: run every ENABLED slot in order, in place.
   *
   * The canonical fx pass with the Q-V1 stereo promotion: `stereo_in`
   * says whether (l, r) already carry two live channels. On a MONO
   * pass, the first enabled wantsStereo() slot promotes — the mono
   * signal is duplicated into `r` and the rest of the chain runs
   * stereo. When the caller has no right buffer (`r` null — a mono
   * output device), promotion runs through the chain's internal
   * scratch and the result FOLDS back to mono (equal halves) before
   * returning. Returns whether the CALLER's buffers now hold stereo.
   * A promotion-needing slot with no usable scratch is skipped
   * (fail-silent, the unprepared-echo discipline).
   *
   * `live_midi`: the block's live events for MIDI-consuming slots —
   * null on every path except a MIDI-armed node's fx pass.
   */
  bool run(float* l, float* r, int sample_count, bool stereo_in,
           const juce::MidiBuffer* live_midi = nullptr);

  // Thin wrappers over run() for the pure-built-in paths and the DSP
  // tests.
  void process(float* x, int sample_count) { run(x, nullptr, sample_count, false); }
  void processStereo(float* l, float* r, int sample_count) {
    run(l, r, sample_count, true);
  }

  bool anyEnabled() const;
  int enabledCount() const;
  /** An ENABLED instrument slot exists — the live play-through
   * precondition (docs/vst3.md §8). Audio-thread safe. */
  bool hasEnabledInstrument() const;
  /** ANY instrument slot (enabled or not, live or placeholder) — what
   * makes a clip a MIDI track: its takes record notes, not audio
   * (docs/vst3.md §8). Message thread (arm-time decision). */
  bool hasInstrumentSlot() const;
  /** THE instrument slot — the first one in signal order, whose state
   * a MIDI take's undo entry carries (docs/vst3.md §8.4); null without
   * one. Message thread. */
  FxSlot* firstInstrumentSlot() const;

  /** The chain array for metadata AND the save format (docs/vst3.md
   * §6): [{slot, type, enabled, ...params}] in signal order. Pass
   * include_persistent_state=true at SAVE time only — it adds the
   * VST3 state blobs (base64), which the 20 Hz poll must not carry. */
  juce::var getMetadata(bool include_persistent_state = false) const;

  /** Live GR of the first compressor slot (the scope's `gr` display);
   * 0 when the chain has none. */
  float compressorGainReductionDb() const;

  /** Sum of enabled slots' reported latency (docs/vst3.md §3.4 —
   * report-only; no compensation is applied). */
  int totalLatencySamples() const;

 private:
  explicit FxChain(std::vector<std::shared_ptr<FxSlot>> slots);

  const std::vector<std::shared_ptr<FxSlot>> slots_;
  // Promotion scratch (right channel for the fold-back path): sized
  // when the chain is built, if any slot wants stereo, and written only
  // by the audio thread from then on. Empty on an all-built-in chain.
  std::vector<float> promotion_scratch_;
};

/**
 * Pre-chain signal telemetry (the scope, docs/session_view.md effects
 * bar): a STABLE per-node object, so chain swaps never disturb it.
 * The audio thread only COPIES the chain's input into a
 * small ring (single writer, atomic index); all analysis (the 24-bin
 * Goertzel spectrum) runs on the MESSAGE thread at poll time inside
 * metadataVar. GATED on the UI's panel being open (setEffectScope):
 * when nobody is looking, the audio thread doesn't even copy.
 */
class FxScope {
 public:
  static constexpr int kScopeSize = 2048;   // power of two
  static constexpr int kSpectrumBins = 24;  // log-spaced 40 Hz..16 kHz

  /** Message thread. Sizes the ring once (before the first setActive)
   * and records the rate the spectrum is read at; safe on a live node. */
  void prepare(double sample_rate);
  /** Message thread: a prepared scope reads its spectrum at the
   * device's new rate. The ring does not depend on the rate. */
  void followRate(double sample_rate);

  /** Audio thread. `right` may be null (mono); when present the ring
   * records the L/R mean. No-op unless a panel is watching. */
  void capture(const float* left, const float* right, int sample_count);

  void setActive(bool on) { scope_on_.store(on); }
  bool watching() const { return scope_on_.load(); }

  /** {spectrum, peak, gr} for the metadata blob, or void() when not
   * watching / not prepared. `gr` is passed in by the caller (it lives
   * on the chain's compressor slot). Message thread. */
  juce::var metadataVar(float gr) const;

 private:
  double prepared_sample_rate_ = 0.0;
  std::atomic<bool> scope_on_{false};
  std::vector<float> ring_;  // sized in prepare; empty = not ready
  std::atomic<int> write_{0};
  std::atomic<float> in_peak_{0.0f};
};

}  // namespace celestrian::dsp
