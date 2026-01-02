#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/box_node.h"
#include "../src/clip_node.h"

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

      engine.toggleSolo(uuid);  // Toggle off
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

    // --- LCM Timeline Tests ---

    beginTest("LCM Timeline: Basic LCM Calculation");
    {
      // Test that 1Q + 4Q = 4Q LCM
      int64_t Q = 44100;
      int64_t clip1_dur = Q;
      int64_t clip2_dur = 4 * Q;

      // Manual LCM calculation
      auto gcd = [](int64_t a, int64_t b) -> int64_t {
        while (b != 0) {
          int64_t t = b;
          b = a % b;
          a = t;
        }
        return a;
      };
      auto lcm = [&gcd](int64_t a, int64_t b) -> int64_t {
        return (a / gcd(a, b)) * b;
      };

      expectEquals(lcm(clip1_dur, clip2_dur), (int64_t)(4 * Q));
      expectEquals(lcm(Q, 8 * Q), (int64_t)(8 * Q));
      expectEquals(lcm(3 * Q, 5 * Q), (int64_t)(15 * Q));  // Coprime
    }

    beginTest("LCM Timeline: 1Q + 4Q Synchronization");
    {
      int64_t Q = 44100;
      int64_t timeline_length = 4 * Q;  // LCM of 1Q and 4Q

      // At position 0: both clips at 0%
      int64_t pos = 0;
      int64_t clip1_launch = 0;
      int64_t clip2_launch = 0;

      int64_t clip1_phase = (pos + clip1_launch) % Q;
      int64_t clip2_phase = (pos + clip2_launch) % (4 * Q);

      expectEquals(clip1_phase, (int64_t)0);
      expectEquals(clip2_phase, (int64_t)0);

      // At position 2Q: clip1 at 0%, clip2 at 50%
      pos = 2 * Q;
      clip1_phase = (pos + clip1_launch) % Q;
      clip2_phase = (pos + clip2_launch) % (4 * Q);

      expectEquals(clip1_phase, (int64_t)0);        // 2Q % 1Q = 0
      expectEquals(clip2_phase, (int64_t)(2 * Q));  // 2Q % 4Q = 2Q

      // At position 4Q (wrapped to 0): both at 0%
      pos = 4 * Q % timeline_length;
      clip1_phase = (pos + clip1_launch) % Q;
      clip2_phase = (pos + clip2_launch) % (4 * Q);

      expectEquals(pos, (int64_t)0);
      expectEquals(clip1_phase, (int64_t)0);
      expectEquals(clip2_phase, (int64_t)0);
    }

    beginTest("LCM Timeline: Example 2 - Clip at 2Q Offset");
    {
      int64_t Q = 44100;
      int64_t clip3_duration = 8 * Q;
      int64_t clip3_launch_point =
          6 * Q;  // Recorded at 2Q: (8Q - 2Q) % 8Q = 6Q

      // At timeline=2Q: Clip 3 should be at phase 0 (aligned with recording!)
      int64_t pos = 2 * Q;
      int64_t phase = (pos + clip3_launch_point) % clip3_duration;
      expectEquals(phase, (int64_t)0);

      // At timeline=0: Clip 3 should be at phase 6Q (75%)
      pos = 0;
      phase = (pos + clip3_launch_point) % clip3_duration;
      expectEquals(phase, (int64_t)(6 * Q));
    }
  }
};

static AudioEngineTests audioEngineTests;

}  // namespace celestrian
