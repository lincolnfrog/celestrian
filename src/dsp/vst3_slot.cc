#include "vst3_slot.h"

namespace celestrian::dsp {

Vst3Slot::Vst3Slot(std::unique_ptr<juce::AudioPluginInstance> instance,
                   const juce::String& uid, const juce::String& display_name,
                   const juce::String& file, bool is_instrument)
    : instance_(std::move(instance)),
      is_instrument_(is_instrument),
      uid_(uid),
      display_name_(display_name),
      file_(file) {}

Vst3Slot::Vst3Slot(const juce::String& uid, const juce::String& display_name,
                   const juce::String& file, const juce::MemoryBlock& state,
                   bool is_instrument)
    : is_instrument_(is_instrument),
      uid_(uid),
      display_name_(display_name),
      file_(file),
      state_(state) {}

void Vst3Slot::doPrepare(double sample_rate) {
  if (instance_ == nullptr) return;  // placeholder: nothing to prepare
  // Stereo out (Q-V1) at the engine's block ceiling; instruments take
  // no audio input (synths generate). Processing shorter blocks than
  // prepared is legal.
  instance_->setPlayConfigDetails(is_instrument_ ? 0 : 2, 2, sample_rate,
                                  kMaxBlockSize);
  instance_->prepareToPlay(sample_rate, kMaxBlockSize);
  // The MIDI scratch must never grow on the audio thread.
  // Sized for a dense note-clip block plus live events (phase 5), so
  // addEvents never grows it on the audio thread.
  midi_scratch_.ensureSize(65536);
}

void Vst3Slot::process(float* x, int sample_count) {
  // Never reached: wantsStereo() makes the chain promote or skip.
  juce::ignoreUnused(x, sample_count);
}

void Vst3Slot::processStereo(float* l, float* r, int sample_count) {
  if (instance_ == nullptr) return;  // placeholder: hard bypass
  if (sample_count > kMaxBlockSize) return;  // beyond prepare: fail silent
  float* channels[] = {l, r};
  // The pointer-referencing AudioBuffer constructor uses JUCE's
  // preallocated channel space for small channel counts — no heap
  // allocation on the audio thread.
  juce::AudioBuffer<float> buffer(channels, 2, sample_count);
  midi_scratch_.clear();  // stays empty; clear() never deallocates
  instance_->processBlock(buffer, midi_scratch_);
}

void Vst3Slot::processStereoMidi(float* l, float* r, int sample_count,
                                 const juce::MidiBuffer& midi) {
  if (instance_ == nullptr) return;
  if (sample_count > kMaxBlockSize) return;
  float* channels[] = {l, r};
  juce::AudioBuffer<float> buffer(channels, 2, sample_count);
  // Copy into the preallocated scratch: processBlock takes a mutable
  // buffer (it may consume the events or produce its own), and the
  // caller's buffer is shared by every armed-path slot this block.
  midi_scratch_.clear();
  midi_scratch_.addEvents(midi, 0, sample_count, 0);
  instance_->processBlock(buffer, midi_scratch_);
}

bool Vst3Slot::setParam(const juce::String& key, double value) {
  // VST3 parameters belong to the plugin's editor (owner ruling
  // 2026-08-15); the bridge's key/value surface is built-ins only.
  juce::ignoreUnused(key, value);
  return false;
}

void Vst3Slot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("name", display_name_);
  out.setProperty("uid", uid_);
  out.setProperty("file", file_);
  out.setProperty("missing", isMissing());
  out.setProperty("isInstrument", is_instrument_);
  out.setProperty("latency", latencySamples());
}

juce::MemoryBlock Vst3Slot::stateBlob() const {
  if (instance_ == nullptr) return state_;  // placeholder: kept verbatim
  juce::MemoryBlock fresh;
  instance_->getStateInformation(fresh);
  return fresh;
}

void Vst3Slot::fillPersistentExtras(juce::DynamicObject& out) const {
  const juce::MemoryBlock state = stateBlob();
  if (state.getSize() > 0) out.setProperty("state", state.toBase64Encoding());
}

void Vst3Slot::restoreState(const juce::MemoryBlock& state) {
  state_ = state;
  if (instance_ != nullptr && state.getSize() > 0) {
    instance_->setStateInformation(state.getData(), (int)state.getSize());
  }
}

int Vst3Slot::latencySamples() const {
  return instance_ != nullptr ? instance_->getLatencySamples() : 0;
}

}  // namespace celestrian::dsp
