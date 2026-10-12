/**
 * TAKES ARE UNDOABLE (docs/sequencer.md §11.5; edit.h Kind::Take /
 * Untake). Commit is an audio-thread event, so the engine registers a
 * PENDING performance at arm and reconciles it into the undo log on the
 * message thread once every member has settled. Pins:
 *
 *   - the first take: undo strips the clip back to empty AND reverts the
 *     island grid it established; redo reinstalls the take with the
 *     grid (what it then renders is scenario S13);
 *   - take 2: undo leaves the zero where it was before the take;
 *   - a Q7 GROUP take is ONE undo step (one performance);
 *   - undo/redo of a take is REFUSED (entry kept) while a take is live;
 *   - the log ORDERS a take before later edits (rename after take: the
 *     first undo is the rename);
 *   - S19 AUTO-GATE: a take recorded into a looping step gates its row
 *     ON there / OFF elsewhere, and ONE undo removes take + gates;
 *   - a deeper take (audition on the root, record inside a group) is
 *     NOT auto-gated;
 *   - a MIDI take's entry carries its instrument's state; an audio
 *     take's carries no plugin state.
 *
 * Twin: ui/js/tests/take_undo.test.mjs (mock parity).
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "../src/dsp/vst3_slot.h"
#include "scenario_utils.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

namespace {

using test_utils::addNode;
using test_utils::EngineRig;
using test_utils::presentProp;
using test_utils::rootId;
using test_utils::rootProp;

int64_t islandQ(AudioEngine& engine) { return rootProp(engine, "quantum"); }
juce::var gatesOf(AudioEngine& engine) {
  return engine.getGraphState()
      .getProperty("sequence", juce::var())
      .getProperty("gates", juce::var());
}
juce::String bitsOf(const juce::var& gates, const juce::String& id) {
  juce::String out;
  if (auto* a = gates.getProperty(id, juce::var()).getArray()) {
    for (auto& b : *a) out << ((bool)b ? "1" : "0");
  }
  return out;
}

}  // namespace

class TakeUndoTests : public juce::UnitTest {
 public:
  TakeUndoTests() : juce::UnitTest("Takes are undoable (docs/sequencer.md 11.5)") {}

  void runTest() override {
    beginTest("first take: undo strips + reverts the grid; redo restores");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      expect(!engine.canUndo(), "fresh engine: nothing to undo");
      // The take's settle polls: the poll reconciles the pending
      // performance into the log.
      const juce::String c1 = rig.recordClip(20000);
      expect(test_utils::isClipCommitted(engine, c1), "committed");
      const int64_t q = islandQ(engine);
      expect(q > 0, "Q established");
      expect(engine.canUndo(), "the take is an undo step");
      expect(!engine.hasPendingTakes(), "pending list drained");

      engine.undo();
      expectEquals(presentProp(engine, c1, "duration"), 0.0,
                   "undo: the clip is EMPTY again");
      expect(!(bool)presentProp(engine, c1, "isRecording"), "idle");
      expectEquals(islandQ(engine), (int64_t)0,
                   "undo: the grid the take established is gone");
      expect(engine.canRedo(), "redo available");

      engine.redo();
      expectEquals((int64_t)presentProp(engine, c1, "duration"), q,
                   "redo: content back");
      expectEquals(islandQ(engine), q, "redo: grid back");
      // Undo again and record a NEW first take: establishes afresh.
      engine.undo();
      const juce::String c2 = rig.recordClip(30000);
      expect(test_utils::isClipCommitted(engine, c2), "new first take");
      expect(islandQ(engine) > 0, "a fresh first take establishes Q again");
    }

    beginTest("take 2: undo restores the pre-take zero; take + rename order");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      rig.recordClip(20000);
      const int64_t q = islandQ(engine);
      const int64_t zero0 = rootProp(engine, "islandZero");
      // Take 2 is armed mid-cycle and grows the cycle.
      rig.drive(q + q / 2);
      const juce::String c2 = rig.recordClip(2 * q);
      expect(test_utils::isClipCommitted(engine, c2), "take 2 committed");
      engine.renameNode(c2, "solo");
      // Undo #1 = the rename; undo #2 = take 2.
      engine.undo();
      expectEquals((int64_t)presentProp(engine, c2, "duration"), (int64_t)(2 * q),
                   "first undo was the rename; take 2 stands");
      engine.undo();
      expectEquals(presentProp(engine, c2, "duration"), 0.0, "take 2 stripped");
      expectEquals(rootProp(engine, "islandZero"), zero0,
                   "zero back to its pre-take value");
      expectEquals(islandQ(engine), q, "Q untouched (take 1 still defines it)");
      engine.redo();
      expectEquals((int64_t)presentProp(engine, c2, "duration"), (int64_t)(2 * q),
                   "redo reinstalls take 2");
    }

    beginTest("Q7 group take = ONE undo step");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String group = addNode(engine, "stack");
      const juce::String a = addNode(engine, "clip", group);
      const juce::String b = addNode(engine, "clip", group);
      rig.record(group, 20000);
      expect(presentProp(engine, a, "duration") > 0 &&
                 presentProp(engine, b, "duration") > 0,
             "both members committed");
      engine.undo();
      expectEquals(presentProp(engine, a, "duration"), 0.0, "one undo strips A");
      expectEquals(presentProp(engine, b, "duration"), 0.0, "...and B");
      engine.redo();
      expect(presentProp(engine, a, "duration") > 0 &&
                 presentProp(engine, b, "duration") > 0,
             "one redo restores both");
    }

    beginTest("undo of a take is refused (kept) while a take is live");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String c1 = rig.recordClip(20000);
      const juce::String c2 = addNode(engine, "clip");
      engine.startRecordingInNode(c2);
      expect(rig.driveUntilCapturing(c2), "take 2 is capturing");
      rig.drive(1000);
      engine.undo();  // refused
      expect((int64_t)presentProp(engine, c1, "duration") > 0,
             "take 1 untouched under a live take");
      expect(engine.canUndo(), "the entry is kept, not dropped");
      engine.stopRecordingInNode(c2);
      rig.settle();
      engine.undo();  // now: take 2
      expectEquals(presentProp(engine, c2, "duration"), 0.0,
                   "after settle: take 2 undone");
    }

    beginTest("S19 AUTO-GATE: record into a looping step, one undo = take + gates");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String a = rig.recordClip(20000);
      const int64_t q = islandQ(engine);
      const juce::String root = rootId(engine);
      // intro 2Q | chorus 2Q.
      engine.setSequence(root, scenario::seqPayload({{2 * q}, {2 * q}}));
      engine.auditionStep(root, 1);
      const juce::String c = addNode(engine, "clip");
      engine.startRecordingInNode(c);
      rig.drive(6 * q);
      rig.settle();
      expectEquals((int64_t)presentProp(engine, c, "duration"), (int64_t)(2 * q),
                   "S18: a step-sized part");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String("01"),
                   "auto-gated: ON in the chorus, OFF in the intro");
      expectEquals(bitsOf(gatesOf(engine), a), juce::String(""),
                   "the other track's row untouched (inherits ON)");
      engine.undo();
      expectEquals(presentProp(engine, c, "duration"), 0.0, "one undo: take gone");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String(""),
                   "...and its gate row gone with it");
      engine.redo();
      expectEquals((int64_t)presentProp(engine, c, "duration"), (int64_t)(2 * q),
                   "redo: take back");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String("01"),
                   "redo: gates back");
    }

    beginTest("a deeper take (inside a group) is NOT auto-gated");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      rig.recordClip(20000);
      const int64_t q = islandQ(engine);
      const juce::String root = rootId(engine);
      engine.setSequence(root, scenario::seqPayload({{2 * q}, {2 * q}}));
      const juce::String g = addNode(engine, "stack");
      addNode(engine, "clip", g);
      engine.auditionStep(root, 1);
      engine.startRecordingInNode(g);  // group arm → the one empty clip
      rig.drive(6 * q);
      rig.settle();
      expectEquals(bitsOf(gatesOf(engine), g), juce::String(""),
                   "the group's row is untouched - a deeper take lands ungated");
      expect(engine.canUndo(), "the take itself is still undoable");
    }

    beginTest("a MIDI take's undo entry carries its instrument's state; an "
              "audio take's carries none");
    {
      // docs/vst3.md §8.4: the entry carries the instrument slot's state
      // at commit; undo restores it, the inverse taking the state
      // current at that moment (copy-swap), so redo brings that back.
      const auto recordWith = [&](EngineRig& rig,
                                  std::shared_ptr<dsp::Vst3Slot> slot) {
        const juce::String c = addNode(rig.engine, "clip");
        rig.engine.addPluginSlotToChain(c, std::move(slot), -1);
        rig.record(c, 20000);
        expect(test_utils::isClipCommitted(rig.engine, c), "take committed");
        return c;
      };
      {
        EngineRig rig;
        AudioEngine& engine = rig.engine;
        const auto slot = test_utils::makeStubSynthSlot();
        auto* synth =
            static_cast<test_utils::StubSynthInstance*>(slot->instance());
        synth->patch = 1.0f;  // the sound the take is recorded with
        const juce::String c = recordWith(rig, slot);
        expect(engine.canUndo(), "the take is an undo step");
        synth->patch = 2.0f;  // a tweak after the take
        engine.undo();
        expectEquals(presentProp(engine, c, "duration"), 0.0,
                     "undo: take stripped");
        expectWithinAbsoluteError(synth->patch, 1.0f, 1e-6f,
                                  "undo: the instrument sounds as the take did");
        expectEquals(synth->state_restores, 1, juce::String("one restore"));
        engine.redo();
        expect((int64_t)presentProp(engine, c, "duration") > 0,
               "redo: take back");
        expectWithinAbsoluteError(synth->patch, 2.0f, 1e-6f,
                                  "redo: the state current at undo time");
        engine.undo();
        expectWithinAbsoluteError(synth->patch, 1.0f, 1e-6f,
                                  "undo again: the take's state again");
      }
      {
        EngineRig rig;
        const auto slot = test_utils::makeStubGainSlot();
        auto* effect =
            static_cast<test_utils::StubPluginInstance*>(slot->instance());
        recordWith(rig, slot);
        rig.engine.undo();
        rig.engine.redo();
        expectEquals(effect->state_restores, 0,
                     juce::String("an audio take restores no plugin state"));
      }
    }
  }
};

static TakeUndoTests takeUndoTests;

}  // namespace celestrian
