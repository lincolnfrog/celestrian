/**
 * A rack runs at the device's rate: a device start at a new rate
 * re-prepares every rack in the graph, and one that reaches the graph
 * later follows too — loaded from a bundle saved at another rate, or
 * brought back from the undo log across a device restart (the
 * device-start sweep reaches only what is in the graph —
 * AudioEngine::audioDeviceAboutToStart).
 */

#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

namespace {
/** Turn on `uuid`'s echo at half a second, fully wet, no feedback. */
void enableEcho(AudioEngine& engine, const juce::String& uuid) {
  for (const auto& slot : engine.findNodeByUuidForTest(uuid)->fxChain()->slots()) {
    if (juce::String(slot->typeId()) != "echo") continue;
    engine.setSlotParam(uuid, slot->slotUuid(), "time", 0.5);
    engine.setSlotParam(uuid, slot->slotUuid(), "feedback", 0.0);
    engine.setSlotParam(uuid, slot->slotUuid(), "mix", 1.0);
    engine.setSlotEnabled(uuid, slot->slotUuid(), true);
  }
}

/** The samples an impulse takes to come back through `uuid`'s rack: half
 * the rate its echo is prepared at. */
int echoDelay(AudioEngine& engine, const juce::String& uuid) {
  std::vector<float> block(30000, 0.0f);
  block[0] = 1.0f;
  engine.findNodeByUuidForTest(uuid)->fxChain()->process(block.data(),
                                                         (int)block.size());
  for (int i = 1; i < (int)block.size(); ++i) {
    if (block[(size_t)i] != 0.0f) return i;
  }
  return -1;
}

/** An engine started on `device`; its device starts never touch the
 * user's calibration. */
std::unique_ptr<AudioEngine> makeEngine(const juce::File& dir,
                                        juce::AudioIODevice& device) {
  auto engine = std::make_unique<AudioEngine>();
  engine->setCalibrationFile(dir.getChildFile("calibration.json"));
  engine->audioDeviceAboutToStart(&device);
  return engine;
}

using test_utils::rootId;
}  // namespace

class RackRateTests : public juce::UnitTest {
 public:
  RackRateTests()
      : juce::UnitTest("Racks follow the device rate", "RackRate") {}

  void runTest() override {
    const juce::File dir = test_utils::freshTempDir("rack_rate_engine");
    test_utils::FakeDevice dev44("Rack Interface", 44100.0);
    test_utils::FakeDevice dev48("Rack Interface", 48000.0);

    beginTest("a device start at a new rate re-prepares every prepared rack");
    {
      const auto owner = makeEngine(dir, dev44);
      AudioEngine& engine = *owner;
      // A track inside a group, and the root's own (master) rack: the
      // sweep reaches every level of the tree.
      engine.createNode("stack");
      engine.createNode("clip", test_utils::firstNodeId(engine));
      const juce::String clip = test_utils::childId(engine, 0);
      const juce::String root = rootId(engine);
      enableEcho(engine, clip);
      enableEcho(engine, root);
      expectEquals(echoDelay(engine, clip), 22050, "prepared at 44.1 kHz");

      // A hosted plugin on the same track: prepared as it joins the chain.
      auto plugin_slot = test_utils::makeStubGainSlot();
      auto* plugin = static_cast<test_utils::StubPluginInstance*>(
          plugin_slot->instance());
      engine.addPluginSlotToChain(clip, plugin_slot, -1);
      expectEquals(plugin->prepared_rate, 44100.0, "the plugin too");

      // The rate changes with the device stopped; the next start is the
      // only moment no callback can be running the racks. No slot verb
      // runs between the start and the reads below.
      engine.audioDeviceAboutToStart(&dev48);
      expectEquals(plugin->prepared_rate, 48000.0,
                   "a hosted plugin is prepared again at the device's rate");
      plugin_slot->enabled.store(false);  // the echo alone, for the reads
      expectEquals(echoDelay(engine, clip), 24000,
                   "a nested track's echo follows the device to 48 kHz");
      expectEquals(echoDelay(engine, root), 24000,
                   "the root's rack follows it too");
    }

    beginTest("a loaded session's master rack is prepared at the device's "
              "rate, not the bundle's");
    {
      const juce::File bundle = dir.getChildFile("saved_at_44k");
      {
        const auto saver = makeEngine(dir, dev44);
        enableEcho(*saver, rootId(*saver));
        expectEquals(echoDelay(*saver, rootId(*saver)), 22050,
                     "saved at 44.1 kHz");
        expect(saver->saveSession(bundle.getFullPathName()), "saved");
      }
      const auto engine = makeEngine(dir, dev48);
      expect(engine->loadSession(bundle.getFullPathName()), "loaded");
      expectEquals(echoDelay(*engine, rootId(*engine)), 24000,
                   "the master echo runs at the device's 48 kHz");
    }

    beginTest("a track brought back from the undo log follows the rate the "
              "device took while it was away");
    {
      const auto owner = makeEngine(dir, dev44);
      AudioEngine& engine = *owner;
      engine.createNode("clip");
      const juce::String clip = test_utils::firstNodeId(engine);
      enableEcho(engine, clip);
      auto plugin_slot = test_utils::makeStubGainSlot();
      auto* plugin = static_cast<test_utils::StubPluginInstance*>(
          plugin_slot->instance());
      engine.addPluginSlotToChain(clip, plugin_slot, -1);
      expectEquals(plugin->prepared_rate, 44100.0, "prepared at 44.1 kHz");

      engine.deleteNode(clip);  // the track waits in the undo log
      engine.audioDeviceAboutToStart(&dev48);
      engine.undo();
      expectEquals(plugin->prepared_rate, 48000.0,
                   "undo of the delete: its plugin at 48 kHz");
      plugin_slot->enabled.store(false);  // the echo alone, for the read
      expectEquals(echoDelay(engine, clip), 24000, "and its echo");
      plugin_slot->enabled.store(true);

      engine.removeChainSlot(clip, plugin_slot->slotUuid());  // the slot waits
      engine.audioDeviceAboutToStart(&dev44);
      engine.undo();
      expectEquals(plugin->prepared_rate, 44100.0,
                   "undo of a slot's removal: the slot at 44.1 kHz");

      engine.undo();  // the plugin's add: the slot waits in the redo log
      engine.audioDeviceAboutToStart(&dev48);
      engine.redo();
      expectEquals(plugin->prepared_rate, 48000.0,
                   "redo of a slot's add: the slot at 48 kHz");
    }

    beginTest("a group re-made by redo follows the rate too");
    {
      const auto owner = makeEngine(dir, dev44);
      AudioEngine& engine = *owner;
      engine.createNode("clip");
      engine.createNode("clip");
      const juce::String group =
          engine.combineNodes(test_utils::firstNodeId(engine),
                              test_utils::lastTopLevelId(engine));
      enableEcho(engine, group);
      expectEquals(echoDelay(engine, group), 22050, "prepared at 44.1 kHz");
      engine.undo();  // the echo's enable is no log entry: this is the group
      engine.audioDeviceAboutToStart(&dev48);
      engine.redo();
      expectEquals(echoDelay(engine, group), 24000,
                   "the re-made group's echo at 48 kHz");
    }
  }
};

static RackRateTests rackRateTests;

}  // namespace celestrian
