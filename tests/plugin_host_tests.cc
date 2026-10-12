#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include "../src/plugin_host_service.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

using celestrian::test_utils::waitForScan;

/**
 * PluginHostService (docs/vst3.md §4): the hosted formats, the
 * known-plugin registry, its persistence, the registry's bridge shape
 * (each entry names its `format`), and the worker-only probe rule.
 *
 * No real plugin binaries are involved anywhere in this suite
 * (docs/vst3.md Q-V5): the registry is exercised by adding
 * PluginDescriptions directly. Scanning real directories is a manual
 * macOS pass; the crash-isolation proof lives in
 * plugin_scan_crash_tests.cc.
 */
class PluginHostTests : public juce::UnitTest {
 public:
  PluginHostTests() : juce::UnitTest("Plugin Host") {}

  static juce::PluginDescription fakePlugin(const juce::String& name,
                                            const juce::String& file) {
    juce::PluginDescription description;
    description.name = name;
    description.pluginFormatName = "VST3";
    description.fileOrIdentifier = file;
    description.manufacturerName = "Testing";
    description.category = "Fx";
    description.version = "1.0";
    description.uniqueId = name.hashCode();
    return description;
  }

  /** A fresh temp data directory per test section. */
  static juce::File freshDataDir(const juce::String& label) {
    return celestrian::test_utils::freshTempDir("plugin_host_" + label);
  }

  void runTest() override {
    beginTest("VST3 format is registered");
    {
      celestrian::PluginHostService service(freshDataDir("format"));
      juce::StringArray format_names;
      for (auto* format : service.formats().getFormats())
        format_names.add(format->getName());
      expect(format_names.contains("VST3"),
             "format manager should host the VST3 format");
#if JUCE_MAC && JUCE_PLUGINHOST_AU
      expect(format_names.contains("AudioUnit"),
             "macOS hosts AudioUnits alongside VST3 (docs/vst3.md 4)");
#else
      expect(!format_names.contains("AudioUnit"),
             "AudioUnit hosting is macOS-only");
#endif
      expect(!service.isScanning(), "fresh service must not be scanning");
    }

    beginTest("known list persists across service lifetimes");
    {
      const auto dir = freshDataDir("persist");
      {
        celestrian::PluginHostService service(dir);
        service.knownPlugins().addType(
            fakePlugin("Fake Verb", "/fake/FakeVerb.vst3"));
        service.knownPlugins().addType(
            fakePlugin("Aardvark EQ", "/fake/AardvarkEQ.vst3"));
        service.saveKnownPlugins();
        expect(service.knownPluginsFile().existsAsFile(),
               "save must write known_plugins.xml");
      }
      celestrian::PluginHostService reborn(dir);
      expectEquals(reborn.knownPlugins().getNumTypes(), 2,
                   juce::String("reloaded registry keeps both plugins"));
      expect(reborn.knownPlugins().getTypeForFile("/fake/FakeVerb.vst3") !=
                 nullptr,
             "identity survives the round trip");
    }

    beginTest("getKnownPluginsVar: name-sorted, bridge-ready shape");
    {
      celestrian::PluginHostService service(freshDataDir("shape"));
      service.knownPlugins().addType(
          fakePlugin("Zebra Comp", "/fake/ZebraComp.vst3"));
      service.knownPlugins().addType(
          fakePlugin("Aardvark EQ", "/fake/AardvarkEQ.vst3"));
      const auto list = service.getKnownPluginsVar();
      expect(list.isArray(), "var must be an array");
      expectEquals((int)list.getArray()->size(), 2, juce::String("two entries"));
      const auto& first = list[0];
      expectEquals(first.getProperty("name", "").toString(),
                   juce::String("Aardvark EQ"));
      expect(first.getProperty("uid", "").toString().isNotEmpty(),
             "uid (identifier string) must be present; the save format "
             "keys on it");
      expectEquals(first.getProperty("file", "").toString(),
                   juce::String("/fake/AardvarkEQ.vst3"));
      expectEquals(first.getProperty("maker", "").toString(),
                   juce::String("Testing"));
      expect(!(bool)first.getProperty("isInstrument", true),
             "Fx category is not an instrument");
      expectEquals(first.getProperty("format", "").toString(),
                   juce::String("VST3"),
                   juce::String("the entry names its hosting format"));
    }

    beginTest("instantiateAsync refuses a uid the registry does not hold");
    {
      celestrian::PluginHostService service(freshDataDir("instantiate"));
      const auto known = fakePlugin("Fake Verb", "/fake/FakeVerb.vst3");
      service.knownPlugins().addType(known);
      bool completed = false;
      // A neighbour's uid with one character changed: the match is on the
      // whole identity string.
      expect(!service.instantiateAsync(
                 known.createIdentifierString() + "x", 44100.0,
                 [&completed](std::unique_ptr<juce::AudioPluginInstance>,
                              const juce::PluginDescription&) {
                   completed = true;
                 }),
             "an unknown uid answers false");
      expect(!completed, "and its completion does not run");
    }

    beginTest("instantiateAsync completes once the outcome is known: with "
              "the instance, or with none when the plugin could not be "
              "loaded");
    {
      celestrian::PluginHostService service(freshDataDir("outcome"));
      const auto known = fakePlugin("Fake Verb", "/fake/FakeVerb.vst3");
      const juce::String uid = known.createIdentifierString();
      service.knownPlugins().addType(known);
      // The creation in flight, held until the test lets it land.
      juce::AudioPluginFormat::PluginCreationCallback landing;
      double asked_rate = 0.0;
      service.setCreatorForTest(
          [&landing, &asked_rate](
              const juce::PluginDescription&, double rate, int,
              juce::AudioPluginFormat::PluginCreationCallback created) {
            asked_rate = rate;
            landing = std::move(created);
          });
      int completions = 0;
      bool got_instance = false;
      juce::String described;
      const auto done = [&](std::unique_ptr<juce::AudioPluginInstance> instance,
                            const juce::PluginDescription& description) {
        ++completions;
        got_instance = instance != nullptr;
        described = description.createIdentifierString();
      };

      expect(service.instantiateAsync(uid, 48000.0, done),
             "a known uid answers true");
      expectEquals(asked_rate, 48000.0, "at the rate asked for");
      expectEquals(completions, 0,
                   juce::String("nothing completes before the outcome"));
      landing(nullptr, "the module would not open");
      expectEquals(completions, 1, juce::String("a failed load completes"));
      expect(!got_instance, "with no instance");
      expectEquals(described, uid,
                   juce::String("and the registry's description of it"));

      expect(service.instantiateAsync(uid, 48000.0, done));
      landing(std::make_unique<celestrian::test_utils::StubPluginInstance>(),
              {});
      expectEquals(completions, 2, juce::String("a loaded plugin completes"));
      expect(got_instance, "with its instance");
      expectEquals(described, uid);
    }

    beginTest("blacklist persists with the registry");
    {
      const auto dir = freshDataDir("blacklist");
      {
        celestrian::PluginHostService service(dir);
        service.knownPlugins().addToBlacklist("/fake/CrashyPlugin.vst3");
        const auto status = service.getScanStatusVar();
        expectEquals((int)status.getProperty("blacklistCount", 0), 1,
                     juce::String("status var reports the blacklist"));
        service.saveKnownPlugins();
      }
      celestrian::PluginHostService reborn(dir);
      expect(reborn.knownPlugins().getBlacklistedFiles().contains(
                 "/fake/CrashyPlugin.vst3"),
             "blacklist survives the round trip");
    }

    beginTest("no worker command: a pending file ends the scan with an error");
    {
      // The scan worker is the ONLY probe path (docs/vst3.md §4):
      // nothing is ever probed in this process. A bundle-shaped
      // directory is enough to be enumerated; with no worker to hand it
      // to, the scan reports the error and touches no plugin code.
      const auto dir = freshDataDir("no_worker");
      const auto plugins = dir.getChildFile("plugins");
      plugins.getChildFile("Fake.vst3").createDirectory();
      celestrian::PluginHostService service(dir);
      service.setScanWorkerCommand({});
      service.startScan(plugins.getFullPathName(),
                        /*include_default_locations=*/false);
      expect(waitForScan(service, 5000), "scan ended");
      const auto status = service.getScanStatusVar();
      expect(status.getProperty("error", "").toString().isNotEmpty(),
             "status carries the no-worker error");
      expect((bool)status.getProperty("outOfProcess", false),
             "the status names the one probe path: out of process");
      expectEquals(service.knownPlugins().getNumTypes(), 0,
                   juce::String("nothing probed, nothing listed"));
      expectEquals(service.knownPlugins().getBlacklistedFiles().size(), 0,
                   juce::String("nothing blamed on the file"));
    }

    beginTest("a worker that never starts probing times out with an error");
    {
#if JUCE_WINDOWS
      logMessage("SKIPPED: the silent stand-in worker is a POSIX shell");
#else
      const auto dir = freshDataDir("silent_worker");
      const auto plugins = dir.getChildFile("plugins");
      plugins.getChildFile("Fake.vst3").createDirectory();
      celestrian::PluginHostService service(dir);
      // Alive and silent: it never writes a line to the results file.
      service.setScanWorkerCommand({"/bin/sh", "-c", "exec sleep 30"});
      service.setWorkerIdleTimeoutMs(300);
      service.startScan(plugins.getFullPathName(),
                        /*include_default_locations=*/false);
      expect(waitForScan(service, 5000),
             "the scan ended instead of waiting on the worker");
      const auto status = service.getScanStatusVar();
      expect(status.getProperty("error", "").toString().isNotEmpty(),
             "status carries the silent-worker error");
      expectEquals((int)status.getProperty("crashedCount", -1), 0,
                   juce::String("no file was in flight: none is blamed"));
      expectEquals((int)status.getProperty("blacklistCount", -1), 0,
                   juce::String("nothing blacklisted"));
#endif
    }

    beginTest("startScan can be confined to one directory (no defaults)");
    {
      // An empty directory scanned WITHOUT the platform defaults
      // completes immediately with nothing found — the switch the
      // crash test relies on to keep its child scans off the machine's
      // real plugin folders.
      const auto dir = freshDataDir("confined");
      const auto empty = dir.getChildFile("empty_plugins");
      empty.createDirectory();
      celestrian::PluginHostService service(dir);
      service.startScan(empty.getFullPathName(),
                        /*include_default_locations=*/false);
      expect(waitForScan(service, 2000),
             "confined scan of an empty dir finishes");
      expectEquals(service.knownPlugins().getNumTypes(), 0,
                   juce::String("and finds nothing"));
    }

    beginTest("scan status var shape (idle)");
    {
      celestrian::PluginHostService service(freshDataDir("status"));
      const auto status = service.getScanStatusVar();
      expect(!(bool)status.getProperty("scanning", true), "idle: not scanning");
      expectEquals((int)status.getProperty("count", -1), 0,
                   juce::String("idle: empty registry"));
      expect(status.hasProperty("progress") && status.hasProperty("current"),
             "poll shape carries progress + current");
    }
  }
};

static PluginHostTests plugin_host_tests;
