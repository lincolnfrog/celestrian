#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include "../src/plugin_host_service.h"

namespace celestrian {

/**
 * Scan crash isolation (docs/vst3.md §4): a plugin that crashes while
 * it loads must not kill the app. The in-repo hostile VST3
 * ("Celestrian Test Crash", test_plugin/test_crash_plugin.cc) calls
 * abort() in a static initializer, exactly like the 2026-08-19 field
 * crashes where NI plugins trapped during module load. The scan must
 * complete, keep the good plugin, and blacklist the hostile one.
 *
 * Before out-of-process scanning, this test killed the whole test
 * runner — that WAS the bug.
 *
 * Skips honestly (with a log line) when either test bundle was not
 * built (CELESTRIAN_BUILD_TEST_PLUGIN=OFF) — never silently.
 */
class PluginScanCrashTests : public juce::UnitTest {
 public:
  PluginScanCrashTests()
      : juce::UnitTest("Plugin Scan Crash Isolation (out-of-process)") {}

  /** Walks up from a build-system binary dir to the .vst3 bundle root;
   * invalid File when unavailable. */
  static juce::File bundleAbove(const char* binary_dir) {
    juce::File dir(binary_dir);
    while (dir != juce::File() && !dir.getFileName().endsWith(".vst3"))
      dir = dir.getParentDirectory();
    return dir;
  }

  static juce::File gainBundle() {
#ifdef CELESTRIAN_TEST_GAIN_VST3_BINARY_DIR
    return bundleAbove(CELESTRIAN_TEST_GAIN_VST3_BINARY_DIR);
#else
    return {};
#endif
  }

  static juce::File crashBundle() {
#ifdef CELESTRIAN_TEST_CRASH_VST3_BINARY_DIR
    return bundleAbove(CELESTRIAN_TEST_CRASH_VST3_BINARY_DIR);
#else
    return {};
#endif
  }

  void runTest() override {
    const juce::File gain = gainBundle();
    const juce::File crash = crashBundle();

    beginTest("both test bundles are present");
    if (gain == juce::File() || !gain.exists() || crash == juce::File() ||
        !crash.exists()) {
      logMessage(
          "SKIPPED: test bundles not built "
          "(CELESTRIAN_BUILD_TEST_PLUGIN=OFF?) - crash isolation did not "
          "run");
      expect(true);
      return;
    }

    const juce::ScopedJuceInitialiser_GUI juce_runtime;

    beginTest("a plugin that crashes on load cannot kill the scan");
    {
      // One scan directory that holds the good and the hostile bundle.
      auto scan_dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("celestrian_scan_crash_dir");
      scan_dir.deleteRecursively();
      scan_dir.createDirectory();
      expect(gain.copyDirectoryTo(scan_dir.getChildFile(gain.getFileName())),
             "staged the good bundle");
      expect(crash.copyDirectoryTo(scan_dir.getChildFile(crash.getFileName())),
             "staged the hostile bundle");
      const auto staged_crash_path =
          scan_dir.getChildFile(crash.getFileName()).getFullPathName();

      auto data_dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("celestrian_scan_crash_data");
      data_dir.deleteRecursively();
      PluginHostService service(data_dir);
      service.startScan(scan_dir.getFullPathName(),
                        /*include_defaults=*/false);
      for (int i = 0; i < 1200 && service.isScanning(); ++i)
        juce::Thread::sleep(50);
      expect(!service.isScanning(), "scan completed within 60 s");

      bool found_gain = false;
      const auto plugins = service.getKnownPluginsVar();
      for (const auto& entry : *plugins.getArray())
        if (entry.getProperty("name", "").toString() == "Celestrian Test Gain")
          found_gain = true;
      expect(found_gain, "the good plugin survived the hostile neighbour");

      expect(service.knownPlugins().getBlacklistedFiles().contains(
                 staged_crash_path),
             "the hostile plugin is blacklisted");
      expect(service.knownPluginsFile().existsAsFile(),
             "the completed scan persisted the registry");
      expect(!service.pedalFile().existsAsFile() ||
                 service.pedalFile().loadFileAsString().trim().isEmpty(),
             "the host never crashed, so the pedal is clean");
    }
  }
};

static PluginScanCrashTests plugin_scan_crash_tests;

}  // namespace celestrian
