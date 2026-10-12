#include "vst3_slot.h"

namespace celestrian::dsp {

Vst3Slot::Vst3Slot(std::unique_ptr<juce::AudioPluginInstance> instance,
                   const juce::String& uid, const juce::String& display_name,
                   const juce::String& file, bool is_instrument,
                   const juce::String& format)
    : instance_(std::move(instance)),
      is_instrument_(is_instrument),
      uid_(uid),
      display_name_(display_name),
      file_(file),
      format_(format.isNotEmpty() ? format : juce::String(kDefaultFormat)) {}

Vst3Slot::Vst3Slot(const juce::String& uid, const juce::String& display_name,
                   const juce::String& file, const juce::MemoryBlock& state,
                   bool is_instrument, const juce::String& format)
    : is_instrument_(is_instrument),
      uid_(uid),
      display_name_(display_name),
      file_(file),
      format_(format.isNotEmpty() ? format : juce::String(kDefaultFormat)),
      state_(state) {}

void Vst3Slot::doPrepare(double sample_rate) {
  if (instance_ == nullptr) return;  // placeholder: nothing to prepare
  // A repeat prepare is a change of rate. The host protocol pairs each
  // prepareToPlay with a releaseResources, and a hosted plugin that is
  // still active treats a second prepare as nothing to do.
  if (instance_prepared_) {
    instance_->releaseResources();
    instance_prepared_ = false;
  }
  // Stereo out (Q-V1) at the engine's block ceiling; instruments take
  // no audio input (synths generate). These are the steps of
  // AudioProcessor::setPlayConfigDetails, ASKED rather than asserted: a
  // plugin may refuse the arrangement, and the slot handles that below.
  const auto arrangeMainBus = [this](bool is_input, int channels) {
    if (instance_->getBusCount(is_input) == 0) return;
    const int current = is_input ? instance_->getTotalNumInputChannels()
                                 : instance_->getTotalNumOutputChannels();
    if (current != channels)
      instance_->setChannelLayoutOfBus(
          is_input, 0, juce::AudioChannelSet::canonicalChannelSet(channels));
  };
  arrangeMainBus(/*is_input=*/true, is_instrument_ ? 0 : kChannels);
  arrangeMainBus(/*is_input=*/false, kChannels);
  instance_->disableNonMainBuses();
  instance_->setRateAndBufferSizeDetails(sample_rate, kMaxBlockSize);

  // processBlock is handed exactly kChannels channels. A plugin left
  // with another output width, or with more inputs than that, would
  // read or write channels the buffer does not have: it stays bypassed.
  const bool fits = instance_->getTotalNumInputChannels() <= kChannels &&
                    instance_->getTotalNumOutputChannels() == kChannels;
  unsupported_.store(!fits);
  if (!fits) {
    juce::Logger::writeToLog(
        "Vst3Slot: '" + display_name_ + "' will not run stereo (" +
        juce::String(instance_->getTotalNumInputChannels()) + " in, " +
        juce::String(instance_->getTotalNumOutputChannels()) +
        " out) - bypassed");
    return;
  }
  // Processing shorter blocks than prepared is legal.
  instance_->prepareToPlay(sample_rate, kMaxBlockSize);
  instance_prepared_ = true;
  // Sized for a dense note-clip block plus live events, so addEvents
  // never grows the MIDI scratch on the audio thread.
  midi_scratch_.ensureSize(65536);
}

void Vst3Slot::process(float* x, int sample_count) {
  // Never reached: wantsStereo() makes the chain promote or skip.
  juce::ignoreUnused(x, sample_count);
}

void Vst3Slot::processStereo(float* l, float* r, int sample_count) {
  if (instance_ == nullptr) return;  // placeholder: hard bypass
  if (unsupported_.load()) return;   // refused layout: hard bypass
  if (sample_count > kMaxBlockSize) return;  // beyond prepare: fail silent
  float* channels[] = {l, r};
  // The pointer-referencing AudioBuffer constructor uses JUCE's
  // preallocated channel space for small channel counts — no heap
  // allocation on the audio thread.
  juce::AudioBuffer<float> buffer(channels, kChannels, sample_count);
  midi_scratch_.clear();  // stays empty; clear() never deallocates
  instance_->processBlock(buffer, midi_scratch_);
}

void Vst3Slot::processStereoMidi(float* l, float* r, int sample_count,
                                 const juce::MidiBuffer& midi) {
  if (instance_ == nullptr || unsupported_.load()) return;
  if (sample_count > kMaxBlockSize) return;
  float* channels[] = {l, r};
  juce::AudioBuffer<float> buffer(channels, kChannels, sample_count);
  // Copy into the preallocated scratch: processBlock takes a mutable
  // buffer (it may consume the events or produce its own), and the
  // caller's buffer is shared by every armed-path slot this block.
  midi_scratch_.clear();
  midi_scratch_.addEvents(midi, 0, sample_count, 0);
  instance_->processBlock(buffer, midi_scratch_);
}

bool Vst3Slot::setParam(const juce::String& key, double value) {
  juce::ignoreUnused(key, value);
  return false;
}

void Vst3Slot::fillParams(juce::DynamicObject& out) const {
  out.setProperty("name", display_name_);
  out.setProperty("uid", uid_);
  out.setProperty("file", file_);
  out.setProperty("format", format_);
  out.setProperty("missing", isMissing());
  out.setProperty("unsupported", isUnsupported());
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
