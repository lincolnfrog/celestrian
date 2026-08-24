#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include "../src/plugin_host_service.h"

/**
 * PluginHostService (docs/vst3.md §4, phase 1): the known-plugin
 * registry, its persistence, and the dead-man's-pedal crash blacklist.
 *
 * No real VST3 binaries are involved anywhere in this suite (Q-V5
 * ruling): the registry is exercised by adding PluginDescriptions
 * directly, and the pedal path by writing the file a crashed scan would
 * have left behind. Scanning real directories is a manual macOS pass.
 */
class PluginHostTests : public juce::UnitTest {
 public:
  PluginHostTests() : juce::UnitTest("Plugin Host (VST3 phase 1)") {}

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
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                   .getChildFile("celestrian_plugin_host_tests")
                   .getChildFile(label);
    dir.deleteRecursively();
    return dir;
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
    }

    beginTest("dead-man's-pedal: crash leftovers are blacklisted on boot");
    {
      const auto dir = freshDataDir("pedal");
      const auto crashed_path = juce::String("/fake/CrashyPlugin.vst3");
      {
        // Simulate the file a scan writes before probing each plugin —
        // and a crash means it is still there on the next launch.
        dir.createDirectory();
        dir.getChildFile(celestrian::PluginHostService::kPedalFileName)
            .replaceWithText(crashed_path + "\n");
      }
      celestrian::PluginHostService service(dir);
      expect(service.knownPlugins().getBlacklistedFiles().contains(
                 crashed_path),
             "the culprit must be blacklisted at construction");
      const auto status = service.getScanStatusVar();
      expectEquals((int)status.getProperty("blacklistCount", 0), 1,
                   juce::String("status var reports the blacklist"));
      // And the blacklist itself persists.
      service.saveKnownPlugins();
      celestrian::PluginHostService reborn(dir);
      expect(reborn.knownPlugins().getBlacklistedFiles().contains(
                 crashed_path),
             "blacklist survives the round trip");
    }

    beginTest("pedal blacklist is durable without a completed scan");
    {
      // Prior bug (seen live 2026-08-19): crash on Kontakt 7, relaunch,
      // crash on Supercharger, relaunch — and Kontakt was probed AGAIN.
      // The constructor applied the pedal blacklist in memory only;
      // saveKnownPlugins() ran only after a clean scan. The next scan
      // removed the skipped culprit from the pedal file, so a later
      // crash erased the only durable record of it. With two or more
      // crashing plugins, recovery ping-pongs instead of converging.
      const auto dir = freshDataDir("pedal_durable");
      const auto crashed_path = juce::String("/fake/CrashyPlugin.vst3");
      dir.createDirectory();
      dir.getChildFile(celestrian::PluginHostService::kPedalFileName)
          .replaceWithText(crashed_path + "\n");
      { celestrian::PluginHostService service(dir); }
      // Simulate what the next scan does when it walks past the
      // blacklisted file: JUCE's scanner drops it from the pedal.
      dir.getChildFile(celestrian::PluginHostService::kPedalFileName)
          .deleteFile();
      celestrian::PluginHostService reborn(dir);
      expect(reborn.knownPlugins().getBlacklistedFiles().contains(
                 crashed_path),
             "constructor must persist the pedal blacklist, not hold it "
             "in memory until a clean scan");
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
