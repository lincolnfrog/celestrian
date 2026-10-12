#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <cstring>
#include <memory>

#include "../src/audio_node.h"
#include "../src/dsp/vst3_slot.h"

namespace celestrian::test_utils {

/**
 * What both in-tree stubs answer the same way: the AudioProcessor
 * virtuals no test asks a stub about, and a state blob of ONE float
 * (each stub names which), `state_restores` counting the
 * setStateInformation calls.
 */
class StubInstanceBase : public juce::AudioPluginInstance {
 public:
  int state_restores = 0;

  void releaseResources() override {}
  double getTailLengthSeconds() const override { return 0.0; }
  bool producesMidi() const override { return false; }
  juce::AudioProcessorEditor* createEditor() override { return nullptr; }
  bool hasEditor() const override { return false; }
  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}
  void getStateInformation(juce::MemoryBlock& dest) override {
    dest.replaceAll(&stateValue(), sizeof(float));
  }
  void setStateInformation(const void* data, int size) override {
    ++state_restores;
    if (size == (int)sizeof(float)) memcpy(&stateValue(), data, sizeof(float));
  }

 protected:
  /** The one float this stub saves and restores. */
  virtual float& stateValue() = 0;
};

/**
 * The in-tree stub plugin: a minimal AudioPluginInstance with
 * DETERMINISTIC, assertable behavior — no real plugin binaries in unit
 * tests. Multiplies every sample by `gain` (default 0.5), reports
 * kLatency samples of latency, and round-trips `gain` as its state
 * blob. The real-binary twin of this stub is the in-repo test plugin
 * (test_plugin/ — "Celestrian Test Gain"), which the plugin_host
 * integration test hosts through the actual VST3 path.
 */
class StubPluginInstance : public StubInstanceBase {
 public:
  static constexpr int kLatency = 64;

  explicit StubPluginInstance(float gain_value = 0.5f) : gain(gain_value) {}

  float gain;
  int prepare_count = 0;
  double prepared_rate = 0.0;
  int prepared_block = 0;

  void fillInPluginDescription(juce::PluginDescription& d) const override {
    d.name = "Stub Gain";
    d.pluginFormatName = "Stub";
    d.manufacturerName = "Celestrian Tests";
    d.uniqueId = 0x51b6a1;
  }

  const juce::String getName() const override { return "Stub Gain"; }
  void prepareToPlay(double sample_rate, int block_size) override {
    ++prepare_count;
    prepared_rate = sample_rate;
    prepared_block = block_size;
    setLatencySamples(kLatency);
  }
  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer&) override {
    buffer.applyGain(gain);
  }
  bool acceptsMidi() const override { return false; }

 protected:
  float& stateValue() override { return gain; }
};

/**
 * The stub INSTRUMENT: acceptsMidi, generates a constant 0.25 level
 * while any note is held (note-on sets held, note-off clears it —
 * SAMPLE-ACCURATE from the event's block offset, no envelope math:
 * deterministic assertions on where a note starts and stops).
 * OVERWRITES the buffer, the chain-head instrument semantic
 * (docs/vst3.md §8). Counts note-ons/offs and records the SOUND-OFF
 * pair (CC 123 / CC 120, docs/vst3.md §8.3): each clears the held note,
 * is counted, and marks its channel. Its state blob is `patch`.
 */
class StubSynthInstance : public StubInstanceBase {
 public:
  static constexpr float kLevel = 0.25f;

  bool note_held = false;
  int note_ons = 0;
  int note_offs = 0;
  int all_notes_off = 0;               // CC 123 received
  int all_sound_off = 0;               // CC 120 received
  juce::uint16 sound_off_channels = 0;  // bit c: channel c got the pair
  float patch = 0.0f;

  void fillInPluginDescription(juce::PluginDescription& d) const override {
    d.name = "Stub Synth";
    d.pluginFormatName = "Stub";
    d.manufacturerName = "Celestrian Tests";
    d.isInstrument = true;
    d.uniqueId = 0x51b6a2;
  }

  const juce::String getName() const override { return "Stub Synth"; }
  void prepareToPlay(double, int) override {}
  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer& midi) override {
    // Overwrite: an instrument GENERATES (the incoming buffer is the
    // chain's promoted silence on the play-through path). Segment by
    // event offset: [prev, offset) carries the state before the event.
    const int n = buffer.getNumSamples();
    int cursor = 0;
    auto fillTo = [&](int end) {
      for (int ch = 0; ch < buffer.getNumChannels(); ++ch) {
        juce::FloatVectorOperations::fill(buffer.getWritePointer(ch) + cursor,
                                          note_held ? kLevel : 0.0f,
                                          end - cursor);
      }
      cursor = end;
    };
    for (const auto metadata : midi) {
      const auto message = metadata.getMessage();
      const int at = juce::jlimit(0, n, metadata.samplePosition);
      if (at > cursor) fillTo(at);
      if (message.isNoteOn()) {
        note_held = true;
        ++note_ons;
      }
      if (message.isNoteOff()) {
        note_held = false;
        ++note_offs;
      }
      if (message.isAllNotesOff() || message.isAllSoundOff()) {
        note_held = false;
        if (message.isAllNotesOff()) ++all_notes_off;
        if (message.isAllSoundOff()) ++all_sound_off;
        sound_off_channels |= (juce::uint16)(1u << (message.getChannel() - 1));
      }
    }
    if (cursor < n) fillTo(n);
  }
  bool acceptsMidi() const override { return true; }

 protected:
  float& stateValue() override { return patch; }
};

/** A live slot around a fresh stub gain plugin, as the engine's add
 * path receives one. */
inline std::shared_ptr<dsp::Vst3Slot> makeStubGainSlot(float gain = 0.5f) {
  return std::make_shared<dsp::Vst3Slot>(
      std::make_unique<StubPluginInstance>(gain), "Stub-uid", "Stub Gain",
      "/stub/StubGain.vst3");
}

/** A live INSTRUMENT slot around a fresh stub synth. */
inline std::shared_ptr<dsp::Vst3Slot> makeStubSynthSlot() {
  return std::make_shared<dsp::Vst3Slot>(
      std::make_unique<StubSynthInstance>(), "Stub-synth-uid", "Stub Synth",
      "/stub/StubSynth.vst3", /*is_instrument=*/true);
}

/** Appends a stub-synth instrument slot to `node`'s chain, prepared at
 * `sample_rate` and enabled. Returns the stub, for assertions on what
 * the instrument was sent. */
inline StubSynthInstance* installStubSynth(AudioNode& node,
                                           double sample_rate) {
  auto slots = node.fxChain()->slots();
  auto synth = makeStubSynthSlot();
  auto* slot = synth.get();
  slots.push_back(std::move(synth));
  delete node.exchangeFxChain(
      dsp::FxChain::makeFromSlots(std::move(slots)).release());
  node.fxChain()->prepare(sample_rate);
  slot->enabled.store(true);
  return static_cast<StubSynthInstance*>(slot->instance());
}

}  // namespace celestrian::test_utils
