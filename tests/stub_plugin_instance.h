#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

namespace celestrian::test_utils {

/**
 * The in-tree stub plugin (Q-V5 ruling): a minimal AudioPluginInstance
 * with DETERMINISTIC, assertable behavior — no real plugin binaries in
 * unit tests. Multiplies every sample by `gain` (default 0.5), reports
 * kLatency samples of latency, and round-trips `gain` as its state
 * blob (a single float). The real-binary twin of this stub is the
 * in-repo test plugin (test_plugin/ — "Celestrian Test Gain"), which
 * the plugin_host integration test hosts through the actual VST3 path.
 */
class StubPluginInstance : public juce::AudioPluginInstance {
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
  void releaseResources() override {}
  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer&) override {
    buffer.applyGain(gain);
  }
  double getTailLengthSeconds() const override { return 0.0; }
  bool acceptsMidi() const override { return false; }
  bool producesMidi() const override { return false; }
  juce::AudioProcessorEditor* createEditor() override { return nullptr; }
  bool hasEditor() const override { return false; }
  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}
  void getStateInformation(juce::MemoryBlock& dest) override {
    dest.replaceAll(&gain, sizeof(gain));
  }
  void setStateInformation(const void* data, int size) override {
    if (size == (int)sizeof(gain)) memcpy(&gain, data, sizeof(gain));
  }
};

/**
 * The stub INSTRUMENT (phase 4): acceptsMidi, generates a constant
 * 0.25 level while any note is held (note-on sets held, note-off
 * clears it — SAMPLE-ACCURATE from the event's block offset, no
 * envelope math: deterministic assertions on where a note starts and
 * stops). OVERWRITES the buffer, the chain-head instrument semantic
 * (docs/vst3.md §8). Counts note-ons/offs for the phase-5 tests.
 */
class StubSynthInstance : public juce::AudioPluginInstance {
 public:
  static constexpr float kLevel = 0.25f;

  bool note_held = false;
  int blocks_processed = 0;
  int note_ons = 0;
  int note_offs = 0;

  void fillInPluginDescription(juce::PluginDescription& d) const override {
    d.name = "Stub Synth";
    d.pluginFormatName = "Stub";
    d.manufacturerName = "Celestrian Tests";
    d.isInstrument = true;
    d.uniqueId = 0x51b6a2;
  }

  const juce::String getName() const override { return "Stub Synth"; }
  void prepareToPlay(double, int) override {}
  void releaseResources() override {}
  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer& midi) override {
    ++blocks_processed;
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
    }
    if (cursor < n) fillTo(n);
  }
  double getTailLengthSeconds() const override { return 0.0; }
  bool acceptsMidi() const override { return true; }
  bool producesMidi() const override { return false; }
  juce::AudioProcessorEditor* createEditor() override { return nullptr; }
  bool hasEditor() const override { return false; }
  int getNumPrograms() override { return 1; }
  int getCurrentProgram() override { return 0; }
  void setCurrentProgram(int) override {}
  const juce::String getProgramName(int) override { return {}; }
  void changeProgramName(int, const juce::String&) override {}
  void getStateInformation(juce::MemoryBlock&) override {}
  void setStateInformation(const void*, int) override {}
};

}  // namespace celestrian::test_utils
