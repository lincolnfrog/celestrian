#include <juce_audio_processors/juce_audio_processors.h>

#include <cstdlib>

/**
 * "Celestrian Test Crash" — the in-repo BAD plugin (owner-requested
 * 2026-08-26 after a user's scan crashed on a misbehaving VST3).
 *
 * Its one job is to die the moment a host instantiates it, the way a
 * broken third-party plugin does: the scanner loads the bundle, asks
 * the factory for an instance to read its description, and the
 * process takes an invalid memory access before a processor ever
 * exists. That makes it the real-binary fixture for the scan crash
 * protection (docs/vst3.md §4, dead-man's-pedal): the child-process
 * test in tests/plugin_scan_crash_tests.cc scans a directory holding
 * this bundle and "Celestrian Test Gain", proves the scanning process
 * dies with the pedal naming this file, and proves the relaunched scan
 * completes with this plugin blacklisted and the gain plugin found.
 *
 * NEVER probe this bundle in-process from the test suite — the crash
 * is real. Built only when CELESTRIAN_BUILD_TEST_PLUGIN=ON, and never
 * to be copied into a user's plugin folder.
 */
namespace {

/** Never constructed: the factory dies before reaching `new`. The
 * class only exists so the bundle is a well-formed JUCE plugin up to
 * the instant it is asked for an instance. */
class TestCrashProcessor : public juce::AudioProcessor {
 public:
  TestCrashProcessor()
      : juce::AudioProcessor(
            BusesProperties()
                .withInput("Input", juce::AudioChannelSet::stereo(), true)
                .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
  }

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

/** A genuine invalid memory access (not an exception, not a jassert —
 * neither would model a crashed plugin, and both can be caught).
 * `volatile` keeps the compiler from folding the undefined behaviour
 * away; abort() is the fallback for a platform that somehow survives
 * the write. */
[[noreturn]] void crashLikeABadPlugin() {
  volatile int* const nowhere = nullptr;
  *nowhere = 0xDEAD;
  std::abort();
}

}  // namespace

/** The JUCE plugin-client entry point — this is what the scanner's
 * probe reaches, and where the crash happens. */
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
  crashLikeABadPlugin();
  return new TestCrashProcessor();  // unreachable: keeps the class linked
}
