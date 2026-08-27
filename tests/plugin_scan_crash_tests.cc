#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <cstdlib>

#include "../src/plugin_host_service.h"
#include "../src/plugin_scan_worker.h"

namespace celestrian {

/**
 * OUT-OF-PROCESS SCANNING with a REAL crashing plugin (owner-requested
 * 2026-08-26 after a user's scan crashed on a bad VST3): the
 * real-binary proof of docs/vst3.md §4.
 *
 * The bad plugin ("Celestrian Test Crash", test_plugin/) takes an
 * invalid memory access when probed. This suite scans a folder holding
 * it AND "Celestrian Test Gain" from THIS process, through
 * PluginHostService's ordinary startScan — and the fact that the suite
 * is still running to make its assertions is the headline: the crash
 * landed in the scan worker (this test binary re-launched with
 * --scan-worker), the coordinator blacklisted the culprit, respawned,
 * and finished with the good plugin found. Also pinned here: the
 * worker protocol itself, a HUNG probe (the worker's test hook), a
 * rescan being a no-op for excluded files, and a worker that cannot
 * launch ending the scan cleanly instead of spinning.
 *
 * Skips honestly (with a log line) when the bundles were not built
 * (CELESTRIAN_BUILD_TEST_PLUGIN=OFF) — never silently.
 */
class PluginScanCrashTests : public juce::UnitTest {
 public:
  PluginScanCrashTests()
      : juce::UnitTest("Plugin Scan (out-of-process, real crashing VST3)") {}

  /** The built .vst3 bundle root, walking up from the binary dir the
   * build system passed in; invalid File when unavailable. */
  static juce::File bundleAbove(const juce::String& binary_dir) {
    if (binary_dir.isEmpty()) return {};
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

  /** Sets (or, with an empty value, clears) a process environment
   * variable — inherited by the scan workers this process launches. */
  static void setEnv(const char* name, const juce::String& value) {
#if JUCE_WINDOWS
    _putenv_s(name, value.toRawUTF8());
#else
    if (value.isEmpty())
      unsetenv(name);
    else
      setenv(name, value.toRawUTF8(), 1);
#endif
  }

  static bool waitForScan(PluginHostService& service, int max_ms) {
    for (int waited = 0; waited < max_ms && service.isScanning(); waited += 50)
      juce::Thread::sleep(50);
    return !service.isScanning();
  }

  static bool anyEntryContains(const juce::StringArray& entries,
                               const juce::String& needle) {
    for (const auto& entry : entries)
      if (entry.contains(needle)) return true;
    return false;
  }

  static juce::StringArray varStrings(const juce::var& array) {
    juce::StringArray out;
    if (auto* items = array.getArray())
      for (const auto& item : *items) out.add(item.toString());
    return out;
  }

  static bool registryHas(PluginHostService& service, const juce::String& name) {
    const auto known = service.getKnownPluginsVar();  // named: getArray()
    for (const auto& entry : *known.getArray())
      if (entry.getProperty("name", "").toString() == name) return true;
    return false;
  }

  void runTest() override {
    const juce::File gain = gainBundle();
    const juce::File crash = crashBundle();
    beginTest("both test plugin bundles are present");
    if (gain == juce::File() || !gain.exists() || crash == juce::File() ||
        !crash.exists()) {
      logMessage(
          "SKIPPED: test plugins not built "
          "(CELESTRIAN_BUILD_TEST_PLUGIN=OFF?) - out-of-process scan "
          "validation did not run");
      expect(true);
      return;
    }

    const juce::ScopedJuceInitialiser_GUI juce_runtime;  // MessageManager

    // One folder holding a good plugin and a bad one, the way a user's
    // plugin folder would.
    const auto root = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("celestrian_plugin_scan_crash");
    root.deleteRecursively();
    const auto plugins = root.getChildFile("plugins");
    plugins.createDirectory();
    const auto gain_copy = plugins.getChildFile(gain.getFileName());
    const auto crash_copy = plugins.getChildFile(crash.getFileName());
    expect(gain.copyDirectoryTo(gain_copy), "good bundle copied");
    expect(crash.copyDirectoryTo(crash_copy), "bad bundle copied");
    const auto crash_name = crash_copy.getFileName();  // "...Crash.vst3"

    beginTest("worker protocol: probing the good plugin writes its description");
    {
      const auto results = root.getChildFile("protocol_results.txt");
      const int code = scan_worker::probeFiles(
          juce::StringArray{gain_copy.getFullPathName()}, results);
      expectEquals(code, (int)scan_worker::kOk, juce::String("probe ok"));
      juce::StringArray lines;
      results.readLines(lines);
      lines.removeEmptyStrings();
      expectEquals(lines.size(), 4, juce::String("BEGIN, FOUND, END, DONE"));
      if (lines.size() == 4) {
        expect(lines[0] == scan_worker::kBegin + gain_copy.getFullPathName(),
               "BEGIN names the file");
        expect(lines[1].startsWith(scan_worker::kFound), "FOUND line");
        juce::MemoryOutputStream decoded;
        juce::Base64::convertFromBase64(
            decoded,
            lines[1].fromFirstOccurrenceOf(scan_worker::kFound, false, false));
        juce::PluginDescription description;
        auto xml = juce::parseXML(decoded.toString());
        expect(xml != nullptr && description.loadFromXml(*xml),
               "FOUND decodes to a PluginDescription");
        expectEquals(description.name, juce::String("Celestrian Test Gain"),
                     juce::String("...of the good plugin"));
        expect(lines[2] == scan_worker::kEnd + gain_copy.getFullPathName(),
               "END names the file");
        expect(lines[3] == juce::String(scan_worker::kDone), "DONE last");
      }
    }

    const auto data = root.getChildFile("data");
    beginTest("the scan survives the crashing plugin (THIS process is alive)");
    {
      PluginHostService service(data);
      expect(service.scanWorkerCommand().size() == 2 &&
                 service.scanWorkerCommand()[1] == scan_worker::kFlag,
             "default worker is this executable + --scan-worker");
      service.startScan(plugins.getFullPathName(),
                        /*include_default_locations=*/false);
      expect(waitForScan(service, 120000), "scan completed within 2 min");
      // Reaching here at all is the point; now the bookkeeping.
      expect(registryHas(service, "Celestrian Test Gain"),
             "the good plugin was found");
      expect(!registryHas(service, "Celestrian Test Crash"),
             "the bad plugin is excluded from the registry");
      expect(anyEntryContains(service.knownPlugins().getBlacklistedFiles(),
                              crash_name),
             "the bad plugin is blacklisted");
      const auto status = service.getScanStatusVar();
      expect((bool)status.getProperty("outOfProcess", false),
             "status reports out-of-process scanning");
      expectEquals((int)status.getProperty("crashedCount", 0), 1,
                   juce::String("status reports one crashed probe"));
      expect(varStrings(status.getProperty("crashed", juce::var())).contains(crash_name),
             "status names the crashed bundle for the UI");
      expectEquals(status.getProperty("error", "?").toString(), juce::String(),
                   juce::String("no scan error"));
      expectWithinAbsoluteError((double)status.getProperty("progress", 0.0),
                                1.0, 1e-6, "progress ends at 1");
      expect(service.knownPluginsFile().existsAsFile(),
             "completed scan persisted the registry");
      expect(!service.pedalFile().existsAsFile(),
             "no pedal file: nothing was probed in-process");
      const auto work = service.scanWorkDirectory();
      expect(work.getChildFile("list_1.txt").existsAsFile() &&
                 work.getChildFile("results_1.txt").existsAsFile(),
             "the worker was fed through the work directory");
    }

    beginTest("a rescan re-probes nothing and keeps the exclusion");
    {
      PluginHostService again(data);  // fresh service on the persisted registry
      expect(anyEntryContains(again.knownPlugins().getBlacklistedFiles(),
                              crash_name),
             "blacklist persisted across services");
      again.startScan(plugins.getFullPathName(), false);
      expect(waitForScan(again, 60000), "rescan completed");
      expectEquals((int)again.getScanStatusVar().getProperty("crashedCount", -1),
                   0, juce::String("nothing crashed: nothing was probed"));
      expect(!again.scanWorkDirectory().getChildFile("list_1.txt").existsAsFile(),
             "no worker was launched (nothing pending)");
      expect(registryHas(again, "Celestrian Test Gain"), "good plugin still known");
    }

    beginTest("a hung probe is killed after the timeout and excluded");
    {
      // The worker's test hook makes it sleep forever on the GOOD
      // plugin, so this exercises the timeout path on a bundle that
      // would otherwise scan fine.
      const auto hang_data = root.getChildFile("data_hang");
      setEnv(scan_worker::kHangOnEnvVar, "Test Gain");
      {
        PluginHostService service(hang_data);
        service.setProbeTimeoutMs(2000);
        service.startScan(plugins.getFullPathName(), false);
        expect(waitForScan(service, 60000), "scan completed despite the hang");
        expect(!registryHas(service, "Celestrian Test Gain"),
               "the hung plugin is not in the registry");
        expect(anyEntryContains(service.knownPlugins().getBlacklistedFiles(),
                                "Test Gain"),
               "the hung plugin is blacklisted");
        expect(anyEntryContains(service.knownPlugins().getBlacklistedFiles(),
                                crash_name),
               "and the crasher is too");
        expectEquals(
            (int)service.getScanStatusVar().getProperty("crashedCount", 0), 2,
            juce::String("both excluded probes are reported"));
      }
      setEnv(scan_worker::kHangOnEnvVar, "");
    }

    beginTest("a worker that cannot launch ends the scan with an error");
    {
      const auto broken_data = root.getChildFile("data_broken");
      PluginHostService service(broken_data);
      service.setScanWorkerCommand(juce::StringArray{
          root.getChildFile("no_such_worker").getFullPathName(),
          scan_worker::kFlag});
      service.startScan(plugins.getFullPathName(), false);
      expect(waitForScan(service, 30000), "scan ended (no respawn loop)");
      const auto status = service.getScanStatusVar();
      expect(status.getProperty("error", "").toString().isNotEmpty(),
             "status carries the error");
      expectEquals((int)status.getProperty("crashedCount", -1), 0,
                   juce::String("nothing blamed on a plugin"));
      expectEquals(service.knownPlugins().getBlacklistedFiles().size(), 0,
                   juce::String("nothing blacklisted"));
    }
  }
};

static PluginScanCrashTests plugin_scan_crash_tests;

}  // namespace celestrian
