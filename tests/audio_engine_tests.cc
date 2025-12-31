#include "../src/audio_engine.h"
#include "../src/box_node.h"
#include "../src/clip_node.h"
#include <juce_core/juce_core.h>

namespace celestrian {

class AudioEngineTests : public juce::UnitTest {
public:
  AudioEngineTests() : juce::UnitTest("AudioEngine", "Audio Engine") {}

  void runTest() override {
    beginTest("Navigation: Enter/Exit Box");
    {
      AudioEngine engine;
      // Root is already a box
      engine.createNode("box", 10, 10);
      auto state = engine.getGraphState();
      auto nodesVar = state.getDynamicObject()->getProperty("nodes");
      expect(nodesVar.isArray());
      auto *nodes = nodesVar.getArray();
      expect(nodes->size() == 1);
      juce::String subBoxUuid =
          (*nodes)[0].getDynamicObject()->getProperty("id");

      engine.enterBox(subBoxUuid);
      auto newState = engine.getGraphState();
      expectEquals(
          newState.getDynamicObject()->getProperty("focusedId").toString(),
          subBoxUuid);

      engine.exitBox();
      auto rootState = engine.getGraphState();
      expect(rootState.getDynamicObject()->getProperty("focusedId") !=
             subBoxUuid);
    }

    beginTest("Node Management: Create/Rename/Input");
    {
      AudioEngine engine;
      engine.createNode("clip", 50, 50);
      auto state = engine.getGraphState();
      auto *obj = state.getDynamicObject();
      expect(obj != nullptr, "Graph state should be an object");

      auto nodesVar = obj->getProperty("nodes");
      expect(nodesVar.isArray(), "Graph state should have nodes array");

      auto *nodes = nodesVar.getArray();
      expect(nodes != nullptr, "Nodes pointer should not be null");
      expect(nodes->size() == 1);
      juce::String clipUuid = (*nodes)[0].getDynamicObject()->getProperty("id");

      engine.renameNode(clipUuid, "Guitar");
      auto renamedState = engine.getGraphState();
      auto renamedNodesVar =
          renamedState.getDynamicObject()->getProperty("nodes");
      expect(renamedNodesVar.isArray());
      auto *renamedNodes = renamedNodesVar.getArray();
      expectEquals(
          (*renamedNodes)[0].getDynamicObject()->getProperty("name").toString(),
          juce::String("Guitar"));

      engine.setNodeInput(clipUuid, 3);
      // We'd need to expose inputChannel in AudioNode to verify this directly,
      // but we can check if it shows up in metadata if it were exposed.
    }

    beginTest("Playback Controls: TogglePlay/Solo");
    {
      AudioEngine engine;
      engine.createNode("clip", 0, 0);
      auto state = engine.getGraphState();
      auto nodesVar = state.getDynamicObject()->getProperty("nodes");
      expect(nodesVar.isArray());
      auto *nodes = nodesVar.getArray();
      juce::String uuid = (*nodes)[0].getDynamicObject()->getProperty("id");

      engine.toggleSolo(uuid);
      expectEquals(engine.getGraphState()
                       .getDynamicObject()
                       ->getProperty("soloedId")
                       .toString(),
                   uuid);

      engine.toggleSolo(uuid); // Toggle off
      expect(engine.getGraphState()
                 .getDynamicObject()
                 ->getProperty("soloedId")
                 .toString()
                 .isEmpty());

      // Toggle Play: First record something so it has duration
      engine.startRecordingInNode(uuid);
      // Process some samples to give it length
      float in[1] = {0.0f};
      float *const ins[] = {in};
      celestrian::ProcessContext ctx;
      ctx.num_samples = 1;
      ctx.is_recording = true;
      // We need to bypass the real audio device callback in the engine for this
      // test or just call engine.audioDeviceIOCallback directly
      engine.audioDeviceIOCallbackWithContext(
          ins, 1, nullptr, 0, 1, juce::AudioIODeviceCallbackContext{});

      engine.stopRecordingInNode(uuid);

      auto playState = engine.getGraphState();
      auto *nodeData = playState.getDynamicObject()
                           ->getProperty("nodes")
                           .getArray()
                           ->getReference(0)
                           .getDynamicObject();
      expect(nodeData->getProperty("isPlaying"),
             "Should be playing after recording stops");

      engine.togglePlay(uuid);
      auto stopState = engine.getGraphState();
      auto *nodeDataStop = stopState.getDynamicObject()
                               ->getProperty("nodes")
                               .getArray()
                               ->getReference(0)
                               .getDynamicObject();
      expect(!nodeDataStop->getProperty("isPlaying"),
             "Should NOT be playing after togglePlay");
    }
  }
};

static AudioEngineTests audioEngineTests;

} // namespace celestrian
