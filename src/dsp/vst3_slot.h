#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <atomic>
#include <memory>

#include "fx_chain.h"

namespace celestrian::dsp {

/**
 * A VST3 plugin as a chain slot (docs/vst3.md §3, phase 3).
 *
 * Two modes, one class:
 *  - LIVE: owns a prepared `juce::AudioPluginInstance`; processStereo
 *    wraps the channel pointers in a stack AudioBuffer (JUCE's
 *    preallocated-channel-space path — no allocation) and calls
 *    processBlock with an empty MidiBuffer.
 *  - PLACEHOLDER (missing plugin, docs/vst3.md §6): no instance; the
 *    audio path is a hard bypass, but identity (uid/name/file) and the
 *    last-known STATE BLOB are kept verbatim, so save→load→save never
 *    sheds a plugin the user merely hasn't installed here. Revival
 *    swaps a live twin in through the normal successor-chain publish.
 *
 * Channel shape ruling (Q-V1): VST3 slots are always stereo (2 in /
 * 2 out) — wantsStereo() drives the chain's promote-at-first-VST3-slot
 * behavior; the mono process() is never reached (the chain either
 * promotes or skips the slot).
 *
 * Threading: construction, prepare, state save/restore, and metadata
 * happen on the MESSAGE thread (before the slot's chain is published,
 * or on already-published slots only through the plugin's own
 * thread-safe surfaces); the audio thread only calls processStereo and
 * reads `enabled`. `processBlock` of third-party code is the one
 * honesty caveat the doc records (§2) — our side stays contract-clean.
 */
class Vst3Slot : public FxSlot {
 public:
  /** The block size slots are prepared for — matches the engine's
   * mix_buffer ceiling; larger callback blocks bypass VST3 slots
   * (fail-silent, same discipline as the unprepared echo). */
  static constexpr int kMaxBlockSize = 8192;

  /** LIVE slot around a freshly created instance (message thread).
   * The instance is configured stereo and prepared by prepare(). */
  Vst3Slot(std::unique_ptr<juce::AudioPluginInstance> instance,
           const juce::String& uid, const juce::String& display_name,
           const juce::String& file);

  /** PLACEHOLDER slot (missing plugin on load): identity + state only. */
  Vst3Slot(const juce::String& uid, const juce::String& display_name,
           const juce::String& file, const juce::MemoryBlock& state);

  const char* typeId() const override { return "vst3"; }
  bool wantsStereo() const override { return true; }

  bool isMissing() const { return instance_ == nullptr; }
  const juce::String& pluginUid() const { return uid_; }
  const juce::String& displayName() const { return display_name_; }
  const juce::String& fileOrIdentifier() const { return file_; }
  juce::AudioPluginInstance* instance() const { return instance_.get(); }

  /** Audio thread. Mono is never reached (see class comment). */
  void process(float* x, int sample_count) override;
  void processStereo(float* l, float* r, int sample_count) override;

  /** VST3 parameters belong to the plugin's editor (owner ruling
   * 2026-08-15) — the bridge param surface rejects everything. */
  bool setParam(const juce::String& key, double value) override;

  /** Metadata: {name, uid, file, missing, latency} — the state blob is
   * deliberately NOT here (it rides fillPersistentState at save time
   * only; base64 at 20 Hz poll cadence would be waste). */
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
  void doPrepare(double sample_rate) override;

  std::unique_ptr<juce::AudioPluginInstance> instance_;
  juce::String uid_;           // PluginDescription::createIdentifierString
  juce::String display_name_;  // plugin name for chips/windows
  juce::String file_;          // fileOrIdentifier (diagnostics/rescan)
  juce::MemoryBlock state_;    // last-known state (placeholder keeps it)
  juce::MidiBuffer midi_scratch_;  // always empty; processBlock needs one
};

}  // namespace celestrian::dsp
