#include <juce_audio_processors/juce_audio_processors.h>

/**
 * "Celestrian Test Gain" — the in-repo test VST3 (docs/vst3.md phase 3,
 * owner-requested 2026-08-15).
 *
 * A deliberately trivial, fully DETERMINISTIC effect whose one job is
 * validating the hosting path with a REAL plugin binary: scan finds it,
 * instantiation succeeds, processBlock audibly does what the parameter
 * says (output = input × gain, default 0.5), state round-trips (the
 * gain value), and the host's latency readout has something to read
 * (it REPORTS kReportedLatency samples on purpose — it adds no actual
 * delay; latency handling is report-only by owner ruling Q-V2, and a
 * test plugin that exercises the readout is worth the white lie, which
 * this comment documents).
 *
 * It is the real-binary twin of tests/stub_plugin_instance.h — same
 * gain semantics, same latency figure, same 4-byte float state — so
 * the unit suite (stub) and the integration suite (this binary) pin
 * the same contract. hasEditor() is false: the host shows its
 * GenericAudioProcessorEditor, which also exercises the editor-window
 * fallback path (docs/vst3.md §5).
 *
 * Built only when CELESTRIAN_BUILD_TEST_PLUGIN=ON. Never ship this to
 * users' plugin folders.
 */
class TestGainProcessor : public juce::AudioProcessor {
 public:
  static constexpr int kReportedLatency = 64;

  TestGainProcessor()
      : juce::AudioProcessor(
            BusesProperties()
                .withInput("Input", juce::AudioChannelSet::stereo(), true)
                .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
    addParameter(gain_ = new juce::AudioParameterFloat(
                     juce::ParameterID{"gain", 1}, "Gain",
                     juce::NormalisableRange<float>(0.0f, 1.0f), 0.5f));
  }

  const juce::String getName() const override {
    return "Celestrian Test Gain";
  }

  void prepareToPlay(double, int) override {
    setLatencySamples(kReportedLatency);
  }
  void releaseResources() override {}

  bool isBusesLayoutSupported(const BusesLayout& layouts) const override {
    return layouts.getMainInputChannelSet() ==
               layouts.getMainOutputChannelSet() &&
           !layouts.getMainInputChannelSet().isDisabled();
  }

  void processBlock(juce::AudioBuffer<float>& buffer,
                    juce::MidiBuffer&) override {
    buffer.applyGain(gain_->get());
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

  // State: the gain as one float — byte-compatible with the stub's
  // blob, so state fixtures are shared between suites.
  void getStateInformation(juce::MemoryBlock& dest) override {
    const float value = gain_->get();
    dest.replaceAll(&value, sizeof(value));
  }
  void setStateInformation(const void* data, int size) override {
    if (size == (int)sizeof(float)) {
      float value = 0.0f;
      memcpy(&value, data, sizeof(value));
      *gain_ = value;
    }
  }

 private:
  juce::AudioParameterFloat* gain_ = nullptr;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TestGainProcessor)
};

/** The JUCE plugin-client entry point. */
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new TestGainProcessor();
}
