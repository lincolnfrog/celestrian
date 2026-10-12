#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>

#include "fx_chain.h"

namespace celestrian::dsp {

/**
 * A hosted plugin as a chain slot (docs/vst3.md §3): any
 * `juce::AudioPluginInstance` — VST3 everywhere, AudioUnit on macOS
 * (§11). The type id is "vst3" whatever the format (the save format and
 * UI key on it); the FORMAT rides the slot's identity (`pluginFormat`,
 * persisted as `format`) alongside the uid.
 *
 * Two modes, one class:
 *  - LIVE: owns a prepared instance; the audio path hands processBlock
 *    the two channel pointers, allocation-free.
 *  - PLACEHOLDER (missing plugin, docs/vst3.md §6): no instance; the
 *    audio path is a hard bypass, but identity (uid/name/file) and the
 *    last-known STATE BLOB are kept verbatim, so save→load→save never
 *    sheds a plugin the user merely hasn't installed here. Revival
 *    swaps a live twin in through the normal successor-chain publish.
 *
 * Channel shape (Q-V1): a slot is always stereo (2 in / 2 out) —
 * wantsStereo() makes the chain promote at it, so the mono process() is
 * never reached. A plugin that refuses that shape (mono out, an aux bus
 * it will not disable) is UNSUPPORTED: the slot keeps its instance
 * (identity, state, editor), hard-bypasses the audio, and says so in
 * its metadata.
 *
 * Threading: construction, prepare, state save/restore, and metadata
 * happen on the MESSAGE thread; the audio thread only calls the process
 * methods and reads `enabled`. What third-party `processBlock` does on
 * the audio thread is outside the contract (docs/vst3.md §2).
 */
class Vst3Slot : public FxSlot {
 public:
  /** The block size slots are prepared for: the block ceiling. A larger
   * callback block bypasses the slot (fail-silent, like an unprepared
   * echo). */
  static constexpr int kMaxBlockSize = kMaxBlockSamples;

  /** LIVE slot around a freshly created instance (message thread).
   * The instance is configured stereo (effects: 2-in/2-out;
   * instruments: 0-in/2-out) and prepared by prepare(). */
  Vst3Slot(std::unique_ptr<juce::AudioPluginInstance> instance,
           const juce::String& uid, const juce::String& display_name,
           const juce::String& file, bool is_instrument = false,
           const juce::String& format = kDefaultFormat);

  /** PLACEHOLDER slot (missing plugin on load): identity + state only. */
  Vst3Slot(const juce::String& uid, const juce::String& display_name,
           const juce::String& file, const juce::MemoryBlock& state,
           bool is_instrument = false,
           const juce::String& format = kDefaultFormat);

  /** The format name a slot carries when none is given —
   * `juce::PluginDescription::pluginFormatName` for VST3. */
  static constexpr const char* kDefaultFormat = "VST3";

  const char* typeId() const override { return "vst3"; }
  bool wantsStereo() const override { return true; }
  bool isInstrument() const override { return is_instrument_; }

  bool isMissing() const { return instance_ == nullptr; }
  /** The plugin refused the stereo shape at prepare (see the class
   * comment): the audio path is a hard bypass. */
  bool isUnsupported() const { return unsupported_.load(); }
  /** A share of this slot — and so of its plugin instance — for a
   * holder that must keep the instance alive on its own account (an
   * open editor window). Null for a slot no shared_ptr owns. */
  std::shared_ptr<Vst3Slot> owner() {
    return std::static_pointer_cast<Vst3Slot>(weak_from_this().lock());
  }
  const juce::String& pluginUid() const { return uid_; }
  const juce::String& displayName() const { return display_name_; }
  const juce::String& fileOrIdentifier() const { return file_; }
  /** The hosting format's name ("VST3", "AudioUnit"). */
  const juce::String& pluginFormat() const { return format_; }
  juce::AudioPluginInstance* instance() const { return instance_.get(); }

  /** Audio thread. Mono is never reached (see class comment). */
  void process(float* x, int sample_count) override;
  void processStereo(float* l, float* r, int sample_count) override;
  /** The MIDI-carrying pass: the events are copied into the
   * preallocated scratch (processBlock may consume or produce), then
   * fed to the plugin. */
  void processStereoMidi(float* l, float* r, int sample_count,
                         const juce::MidiBuffer& midi) override;

  /** A plugin's parameters belong to its editor — the bridge's
   * key/value surface is built-ins only, so every key is refused. */
  bool setParam(const juce::String& key, double value) override;

  /** The slot's identity and status for the metadata poll. The state
   * blob is NOT here: it rides fillPersistentExtras at save time only
   * (base64 at 20 Hz would be waste). */
  void fillParams(juce::DynamicObject& out) const override;

  /** Adds the base64 `state` property for the save format (message
   * thread): a fresh getStateInformation snapshot when live, the kept
   * blob verbatim when a placeholder. */
  void fillPersistentExtras(juce::DynamicObject& out) const override;

  /** The current state blob (fresh snapshot when live). */
  juce::MemoryBlock stateBlob() const;

  /** Restore plugin state (message thread, after prepare). Keeps the
   * blob for placeholder round-trips either way. */
  void restoreState(const juce::MemoryBlock& state);

  int latencySamples() const override;

 private:
  /** The width of every block a slot hands its plugin (Q-V1). */
  static constexpr int kChannels = 2;

  void doPrepare(double sample_rate) override;

  std::unique_ptr<juce::AudioPluginInstance> instance_;
  // Set by doPrepare (message thread), read by the audio path.
  std::atomic<bool> unsupported_{false};
  // prepareToPlay has run with no releaseResources since (message thread).
  bool instance_prepared_ = false;
  bool is_instrument_ = false;
  juce::String uid_;           // PluginDescription::createIdentifierString
  juce::String display_name_;  // plugin name for chips/windows
  juce::String file_;          // fileOrIdentifier (diagnostics/rescan)
  juce::String format_;        // PluginDescription::pluginFormatName
  juce::MemoryBlock state_;    // last-known state (placeholder keeps it)
  juce::MidiBuffer midi_scratch_;  // preallocated in doPrepare; empty on
                                   // the no-MIDI path
};

}  // namespace celestrian::dsp
