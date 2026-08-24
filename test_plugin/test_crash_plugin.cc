#include <juce_audio_processors/juce_audio_processors.h>

#include <cstdlib>

/**
 * "Celestrian Test Crash" — the in-repo hostile VST3.
 *
 * Its one job is to kill whatever process loads it: a static
 * initializer calls abort() during dlopen, before any factory call.
 * This mirrors the real crash class seen on 2026-08-19, where
 * Native Instruments plugins trapped the app inside module load
 * (main-thread-only macOS calls from the scan thread).
 *
 * The scan-isolation test scans this bundle and asserts that the
 * host process survives and blacklists it. Built only when
 * CELESTRIAN_BUILD_TEST_PLUGIN=ON, with VST3_AUTO_MANIFEST FALSE so
 * the build's manifest helper never loads it. Never ship this to
 * users' plugin folders.
 */
namespace {
struct CrashOnLoad {
  CrashOnLoad() { std::abort(); }
};
const CrashOnLoad crash_on_load;
}  // namespace

/** Unreachable (the initializer above fires first); exists because the
 * VST3 wrapper needs a filter factory to link. */
class TestCrashProcessor : public juce::AudioProcessor {
 public:
  TestCrashProcessor()
      : juce::AudioProcessor(
            BusesProperties()
                .withInput("Input", juce::AudioChannelSet::stereo(), true)
                .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {}

  const juce::String getName() const override {
    return "Celestrian Test Crash";
  }

  void prepareToPlay(double, int) override {}
  void releaseResources() override {}
  void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override {}

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

  void getStateInformation(juce::MemoryBlock&) override {}
  void setStateInformation(const void*, int) override {}

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(TestCrashProcessor)
};

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  return new TestCrashProcessor();
}
