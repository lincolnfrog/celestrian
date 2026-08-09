/**
 * Engine bridge contract tests: the UI-facing mutation surface that is
 * not covered by undo_tests.cc. Pins the mixer-knob rulings (pan/gain
 * clamp, non-undoable), the input-routing edits (undoable, -1 reverts
 * to mono), position-drag coalescing (one gesture = one undo step),
 * loop-window bypass round-trips, the prepare-before-enable effect
 * ordering on a device-less engine, effect-param plumbing, and the
 * undo depth cap (kUndoDepth eviction safety).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::nodesOf;
using test_utils::recordClip;

namespace {

/** The metadata var of the top-level node with the given uuid. */
juce::var nodeVar(const juce::var& state, const juce::String& uuid) {
  if (auto* nodes = nodesOf(state)) {
    for (auto& node : *nodes) {
      if (node.getProperty("id", "").toString() == uuid) return node;
    }
  }
  return {};
}

/** Number of top-level nodes in a getGraphState() var. */
int topLevelCount(const juce::var& state) {
  auto* nodes = nodesOf(state);
  return nodes ? nodes->size() : 0;
}

/** The uuid of the newest top-level node created by `engine.createNode`. */
juce::String lastTopLevelId(const AudioEngine& engine) {
  const juce::var state = engine.getGraphState();
  auto* nodes = nodesOf(state);
  return (nodes && nodes->size() > 0)
             ? nodes->getLast().getProperty("id", "").toString()
             : juce::String();
}

double doubleProperty(const AudioEngine& engine, const juce::String& uuid,
                      const juce::Identifier& property) {
  return (double)nodeVar(engine.getGraphState(), uuid)
      .getProperty(property, -999.0);
}

bool boolProperty(const AudioEngine& engine, const juce::String& uuid,
                  const juce::Identifier& property) {
  return (bool)nodeVar(engine.getGraphState(), uuid)
      .getProperty(property, false);
}

/** effects.<fx>.<key> from a node's metadata (numeric). */
double effectProperty(const AudioEngine& engine, const juce::String& uuid,
                      const juce::String& fx, const juce::Identifier& key) {
  const juce::var node = nodeVar(engine.getGraphState(), uuid);
  const juce::var effects = node.getProperty("effects", juce::var());
  const juce::var slot = effects.getProperty(fx, juce::var());
  return (double)slot.getProperty(key, -999.0);
}

}  // namespace

class EngineBridgeTests : public juce::UnitTest {
 public:
  EngineBridgeTests() : juce::UnitTest("Engine Bridge", "Audio Engine") {}

  void runTest() override {
    beginTest("setNodePan clamps to [-1, 1]; unknown uuid is a no-op");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = lastTopLevelId(engine);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "pan"), 0.0, 1e-9,
                                "pan defaults to center");

      engine.setNodePan(uuid, 2.5);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "pan"), 1.0, 1e-9,
                                "pan clamped to +1 (hard right)");
      engine.setNodePan(uuid, -7.0);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "pan"), -1.0, 1e-9,
                                "pan clamped to -1 (hard left)");

      engine.setNodePan("nonsense", 0.5);  // unknown uuid: must not crash
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "pan"), -1.0, 1e-9,
                                "unknown-uuid pan left the real node alone");
    }

    beginTest("setNodeGain clamps to [0, 1] (attenuate-only law)");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = lastTopLevelId(engine);
      engine.renameNode(uuid, "Named");  // a second undoable edit to peel off

      const bool could_undo_before = engine.canUndo();
      const bool could_redo_before = engine.canRedo();

      engine.setNodeGain(uuid, 5.0);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "gain"), 1.0, 1e-9,
                                "gain clamped to unity (no boost)");
      engine.setNodeGain(uuid, -1.0);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "gain"), 0.0, 1e-9,
                                "gain clamped to 0 (silent)");
      engine.setNodePan(uuid, 0.5);

      // Mixer knobs are NOT edits: the undo/redo state is untouched.
      expect(engine.canUndo() == could_undo_before,
             "canUndo unchanged by pan/gain");
      expect(engine.canRedo() == could_redo_before,
             "canRedo unchanged by pan/gain");

      // Undo peels the RENAME, not the knobs: pan and gain stay put.
      engine.undo();
      const juce::var node = nodeVar(engine.getGraphState(), uuid);
      expect(node.getProperty("name", "").toString() == "New Clip",
             "undo reverted the rename (the newest real edit)");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "pan"), 0.5, 1e-9,
                                "undo did NOT revert the pan");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "gain"), 0.0, 1e-9,
                                "undo did NOT revert the gain");
    }

    beginTest(
        "setNodeInput / setNodeInputRight ride the undo log; "
        "-1 reverts to mono");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = lastTopLevelId(engine);
      const double original_left = doubleProperty(engine, uuid, "inputChannel");
      const double original_right =
          doubleProperty(engine, uuid, "inputChannelR");
      expectWithinAbsoluteError(original_right, -1.0, 1e-9,
                                "fresh clip has no right input (mono)");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "channels"), 1.0,
                                1e-9, "fresh clip is mono");

      engine.setNodeInput(uuid, 3);
      engine.setNodeInputRight(uuid, 4);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannel"),
                                3.0, 1e-9, "left input set to 3");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannelR"),
                                4.0, 1e-9, "right input set to 4");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "channels"), 2.0,
                                1e-9, "stereo pair assigned -> 2 channels");

      engine.setNodeInputRight(uuid, -1);
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannelR"),
                                -1.0, 1e-9, "-1 clears the right input");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "channels"), 1.0,
                                1e-9, "-1 reverts the clip to mono");

      engine.undo();  // back to right = 4
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannelR"),
                                4.0, 1e-9, "undo restores right input 4");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "channels"), 2.0,
                                1e-9, "undo restores the stereo pair");

      engine.undo();  // back to right = original (-1)
      engine.undo();  // back to left = original
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannel"),
                                original_left, 1e-9,
                                "two more undos restore the original left");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "inputChannelR"),
                                original_right, 1e-9,
                                "and the original (mono) right");
    }

    beginTest("setNodePosition is undoable and drags coalesce to ONE step");
    {
      AudioEngine engine;
      engine.createNode("stack");
      const juce::String uuid = lastTopLevelId(engine);
      const double original_x = doubleProperty(engine, uuid, "x");
      const double original_y = doubleProperty(engine, uuid, "y");

      double final_x = 0.0, final_y = 0.0;
      for (int i = 0; i < 10; ++i) {
        final_x = 100.0 + 7.0 * i;
        final_y = 200.0 + 11.0 * i;
        engine.setNodePosition(uuid, final_x, final_y);
      }
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "x"), final_x,
                                1e-9, "final drag position applied (x)");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "y"), final_y,
                                1e-9, "final drag position applied (y)");

      // ONE undo returns to the ORIGINAL position: the ten drags
      // coalesced (editsCoalesce keeps the oldest inverse).
      engine.undo();
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "x"), original_x,
                                1e-9, "one undo restores the original x");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "y"), original_y,
                                1e-9, "one undo restores the original y");
      expect(topLevelCount(engine.getGraphState()) == 1,
             "the stack itself survived the position undo");

      // Proof the whole drag was exactly ONE entry: the next undo is the
      // stack's create, not another position step.
      engine.undo();
      expect(topLevelCount(engine.getGraphState()) == 0,
             "second undo removes the stack (no intermediate drag steps)");

      engine.redo();  // re-insert the stack
      expect(topLevelCount(engine.getGraphState()) == 1,
             "redo re-adds the stack");
      engine.redo();  // re-apply the position step
      // Redo restores the FINAL dragged position, not the first
      // coalesced edit's target: the forward stored on the redo stack is
      // captured live at undo time (applyEditImpl reads the node's
      // current coordinates — the end of the drag — before restoring the
      // original), so coalescing keeps the oldest INVERSE but redo
      // lands on the newest position. That is the desirable gesture
      // semantics: undo/redo hop between "before the drag" and "after
      // the drag".
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "x"), final_x,
                                1e-9, "redo restores the final x");
      expectWithinAbsoluteError(doubleProperty(engine, uuid, "y"), final_y,
                                1e-9, "redo restores the final y");
    }

    beginTest("toggleLoopWindow (LoopBypass) round-trips through undo/redo");
    {
      AudioEngine engine;
      const int block_size = 512;
      std::vector<float> input_block((size_t)block_size, 0.1f);
      std::vector<float> output_block((size_t)block_size, 0.0f);
      auto process = [&](int total_samples) {
        float* inputs[] = {input_block.data()};
        float* outputs[] = {output_block.data(), output_block.data()};
        int remaining = total_samples;
        while (remaining > 0) {
          const int count = std::min(remaining, block_size);
          engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2, count,
                                                  {});
          remaining -= count;
        }
      };
      const juce::String uuid = recordClip(engine, process, 44100);
      expect(test_utils::isClipCommitted(engine, uuid), "take committed");

      const bool bypassed_before = boolProperty(engine, uuid, "loopBypassed");
      engine.toggleLoopWindow(uuid);
      expect(boolProperty(engine, uuid, "loopBypassed") == !bypassed_before,
             "toggle flipped loopBypassed");
      engine.undo();
      expect(boolProperty(engine, uuid, "loopBypassed") == bypassed_before,
             "undo restored the original bypass state");
      engine.redo();
      expect(boolProperty(engine, uuid, "loopBypassed") == !bypassed_before,
             "redo flipped it again");
    }

    beginTest("setEffectEnabled via the engine prepares before enabling");
    {
      // Fresh engine: no device ever started, so the effect prepare must
      // fall back to kFallbackSampleRate — an unprepared-but-enabled
      // reverb would emit NaNs or crash on the first block.
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = lastTopLevelId(engine);

      engine.setEffectEnabled(uuid, "reverb", true);
      expect(effectProperty(engine, uuid, "reverb", "enabled") != 0.0,
             "metadata shows reverb enabled");

      test_utils::driveEngine(engine, 8192);
      const double master_vu_left =
          (double)engine.getGraphState().getProperty("masterVuL", -1.0);
      expect(std::isfinite(master_vu_left),
             "master VU is finite after driving an enabled reverb");
      expect(master_vu_left >= 0.0, "master VU is non-negative (no NaN/junk)");

      // Unknown effect id: a safe no-op (EffectRack::setEnabled returns
      // false; nothing flips, nothing crashes).
      engine.setEffectEnabled(uuid, "flanger", true);
      expect(effectProperty(engine, uuid, "reverb", "enabled") != 0.0,
             "known slots untouched by the unknown-fx call");
      const juce::var effects = nodeVar(engine.getGraphState(), uuid)
                                    .getProperty("effects", juce::var());
      expect(!effects.hasProperty("flanger"),
             "no phantom slot appears for an unknown fx id");
    }

    beginTest("setEffectParam via the engine updates metadata");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = lastTopLevelId(engine);

      engine.setEffectParam(uuid, "echo", "time", 0.5);
      expectWithinAbsoluteError(effectProperty(engine, uuid, "echo", "time"),
                                0.5, 1e-6, "echo time set to 0.5 s");

      // Unknown key: a no-op — the known value is unchanged.
      engine.setEffectParam(uuid, "echo", "wobble", 0.9);
      expectWithinAbsoluteError(effectProperty(engine, uuid, "echo", "time"),
                                0.5, 1e-6,
                                "unknown key left the echo time alone");
    }

    beginTest(
        "undo depth cap: history never exceeds 128 entries and "
        "evictions are safe");
    {
      AudioEngine engine;
      const int created_count = 130;  // two beyond kUndoDepth (128)
      for (int i = 0; i < created_count; ++i) engine.createNode("clip");
      expect(topLevelCount(engine.getGraphState()) == created_count,
             "130 clips created");

      for (int i = 0; i < 140; ++i) engine.undo();  // beyond exhaustion: safe

      expect(!engine.canUndo(), "undo stack exhausted");
      // Only kUndoDepth (128) inverses were retained: the two oldest
      // creates were evicted, so exactly 130 - 128 = 2 clips survive.
      expect(topLevelCount(engine.getGraphState()) == created_count - 128,
             "at most 128 undos applied (2 evicted creates survive)");
    }
  }
};

static EngineBridgeTests engineBridgeTests;

}  // namespace celestrian
