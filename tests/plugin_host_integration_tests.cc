#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <memory>
#include <vector>

#include "../src/dsp/fx_chain.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/plugin_host_service.h"

namespace celestrian {

/**
 * REAL-BINARY hosting validation (docs/vst3.md phase 3; owner-requested
 * 2026-08-15): scans, instantiates, and processes the in-repo test
 * plugin ("Celestrian Test Gain", test_plugin/) through the ACTUAL
 * VST3 path — the real-binary twin of the stub suite. Everything the
 * stub pins by construction, this pins through Steinberg's plumbing:
 * discovery, instantiation, deterministic processing (x0.5 default),
 * the 64-sample latency report, and the 4-byte state round-trip.
 *
 * Skips honestly (with a log line) when the bundle was not built
 * (CELESTRIAN_BUILD_TEST_PLUGIN=OFF) — never silently.
 *
 * A MessageManager exists for the duration (VST3 instantiation is a
 * message-thread affair); the console runner has none of its own.
 */
class PluginHostIntegrationTests : public juce::UnitTest {
 public:
  PluginHostIntegrationTests()
      : juce::UnitTest("Plugin Host Integration (real VST3)") {}

  /** The built .vst3 bundle root, walking up from the binary dir the
   * build system passed in; invalid File when unavailable. */
  static juce::File testPluginBundle() {
#ifdef CELESTRIAN_TEST_GAIN_VST3_BINARY_DIR
    juce::File dir(CELESTRIAN_TEST_GAIN_VST3_BINARY_DIR);
    while (dir != juce::File() && !dir.getFileName().endsWith(".vst3"))
      dir = dir.getParentDirectory();
    return dir;
#else
    return {};
#endif
  }

  void runTest() override {
    const juce::File bundle = testPluginBundle();
    beginTest("test plugin bundle is present");
    if (bundle == juce::File() || !bundle.exists()) {
      logMessage(
          "SKIPPED: Celestrian Test Gain not built "
          "(CELESTRIAN_BUILD_TEST_PLUGIN=OFF?) - real-binary validation "
          "did not run");
      expect(true);
      return;
    }
    expect(bundle.getFileName().endsWith(".vst3"), "bundle root located");

    const juce::ScopedJuceInitialiser_GUI juce_runtime;  // MessageManager

    beginTest("background scan discovers the real plugin (pedal path)");
    juce::String uid;
    {
      auto data_dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                          .getChildFile("celestrian_plugin_integration");
      data_dir.deleteRecursively();
      PluginHostService service(data_dir);
      service.startScan(bundle.getParentDirectory().getFullPathName(),
                        /*include_defaults=*/false);
      // The scan runs on its own thread; bounded wait.
      for (int i = 0; i < 600 && service.isScanning(); ++i)
        juce::Thread::sleep(50);
      expect(!service.isScanning(), "scan completed within 30 s");
      const auto plugins = service.getKnownPluginsVar();
      bool found = false;
      for (const auto& entry : *plugins.getArray()) {
        if (entry.getProperty("name", "").toString() ==
            "Celestrian Test Gain") {
          found = true;
          uid = entry.getProperty("uid", "").toString();
          expect(!(bool)entry.getProperty("isInstrument", true),
                 "registered as an effect");
        }
      }
      expect(found, "scan found Celestrian Test Gain");
      expect(service.knownPluginsFile().existsAsFile(),
             "completed scan persisted the registry");
      expect(!service.pedalFile().existsAsFile() ||
                 service.pedalFile().loadFileAsString().trim().isEmpty(),
             "clean scan leaves no pedal residue");
    }

    beginTest("instantiate through the VST3 path; process; latency");
    std::unique_ptr<juce::AudioPluginInstance> instance;
    juce::PluginDescription scanned_description;
    {
      juce::AudioPluginFormatManager formats;
      formats.addFormat(new juce::VST3PluginFormat());
      juce::KnownPluginList list;
      juce::OwnedArray<juce::PluginDescription> found;
      list.scanAndAddFile(bundle.getFullPathName(), true, found,
                          *formats.getFormat(0));
      expect(found.size() == 1, "one plugin in the bundle");
      if (found.size() != 1) return;
      scanned_description = *found[0];

      juce::String error;
      instance = formats.createPluginInstance(scanned_description, 44100.0,
                                              512, error);
      expect(instance != nullptr, "instantiation succeeded: " + error);
      if (instance == nullptr) return;
    }

    // Host it exactly the way the engine does: a Vst3Slot in a chain.
    {
      juce::PluginDescription description;
      instance->fillInPluginDescription(description);
      auto slot = std::make_shared<dsp::Vst3Slot>(
          std::move(instance), description.createIdentifierString(),
          description.name, description.fileOrIdentifier);
      auto* raw = slot.get();
      auto slots = dsp::FxChain::makeDefault()->slots();
      slots.push_back(std::move(slot));
      auto chain = dsp::FxChain::makeFromSlots(std::move(slots));
      chain->prepare(44100.0);
      raw->enabled.store(true);

      expectEquals(raw->latencySamples(), 64,
                   juce::String("real plugin reports its 64-sample figure"));
      expectEquals(chain->totalLatencySamples(), 64,
                   juce::String("chain latency sums the real report"));

      std::vector<float> l(512, 0.8f), r(512, 0.8f);
      chain->run(l.data(), r.data(), 512, true);
      expectWithinAbsoluteError(l[100], 0.4f, 1e-4f,
                                "default gain 0.5 applied through VST3, L");
      expectWithinAbsoluteError(r[500], 0.4f, 1e-4f, "and R");

      // Promotion with the real binary: mono in, stereo out.
      std::vector<float> mono(512, 0.8f), right(512, 0.0f);
      expect(chain->run(mono.data(), right.data(), 512, false),
             "mono pass promotes at the real vst3 slot");
      expectWithinAbsoluteError(right[100], 0.4f, 1e-4f,
                                "promoted right channel processed");

      beginTest("state round-trip through the real binary");
      {
        // Drive the gain parameter to 1.0 through the plugin's own
        // parameter surface (what its editor would do), snapshot, and
        // restore into a FRESH instance of the real binary.
        auto& parameters = raw->instance()->getParameters();
        juce::AudioProcessorParameter* gain_parameter = nullptr;
        for (auto* parameter : parameters)
          if (parameter->getName(16) == "Gain") gain_parameter = parameter;
        expect(gain_parameter != nullptr, "gain parameter exposed");
        if (gain_parameter == nullptr) return;
        gain_parameter->setValueNotifyingHost(1.0f);
        const juce::MemoryBlock saved = raw->stateBlob();

        // Re-instantiate from the SCANNED description (what the known
        // list stores — a description refilled from a hosted instance
        // loses the format tag, which is itself worth pinning here).
        juce::AudioPluginFormatManager formats;
        formats.addFormat(new juce::VST3PluginFormat());
        juce::String error;
        auto fresh = formats.createPluginInstance(scanned_description,
                                                  44100.0, 512, error);
        expect(fresh != nullptr, "second instantiation: " + error);
        if (fresh == nullptr) return;
        auto twin = std::make_shared<dsp::Vst3Slot>(
            std::move(fresh), scanned_description.createIdentifierString(),
            scanned_description.name, scanned_description.fileOrIdentifier);
        twin->prepare(44100.0);
        twin->restoreState(saved);
        twin->enabled.store(true);
        std::vector<float> x(256, 0.8f), y(256, 0.8f);
        twin->processStereo(x.data(), y.data(), 256);
        expectWithinAbsoluteError(x[10], 0.8f, 1e-4f,
                                  "restored gain 1.0 is unity through the "
                                  "real binary");
      }
    }
  }
};

static PluginHostIntegrationTests plugin_host_integration_tests;

}  // namespace celestrian
