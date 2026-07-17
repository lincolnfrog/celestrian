/**
 * Undo / redo tests (edits-as-events, unification_audit.md §2.2 Step 1).
 *
 * Drives the AudioEngine's public mutation surface and asserts every edit
 * kind round-trips: apply → undo restores the exact prior state (incl.
 * uuids), redo re-applies. The load-bearing case is delete-then-undo
 * preserving the node identity (the audit's "mis-click deleting a take is
 * fatal"). Also pins the armed-take guard (cancel is the verb, not undo).
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"

namespace celestrian {

namespace {
juce::Array<juce::var>* kids(const juce::var& state) {
  return state.getProperty("nodes", juce::var()).getArray();
}
juce::String idAt(const juce::var& state, int i) {
  auto* arr = kids(state);
  return (arr && i < arr->size()) ? (*arr)[i].getProperty("id", "").toString()
                                  : juce::String();
}
juce::String nameOf(const juce::var& state, const juce::String& uuid) {
  if (auto* arr = kids(state)) {
    for (auto& n : *arr) {
      if (n.getProperty("id", "").toString() == uuid)
        return n.getProperty("name", "").toString();
    }
  }
  return {};
}
int childCount(const juce::var& state) {
  auto* arr = kids(state);
  return arr ? arr->size() : 0;
}
// The uuid of child `childIdx` inside top-level stack `stackIdx`. Holds
// the intermediate vars alive (getProperty returns BY VALUE — a pointer
// into its result dangles the moment the temporary dies; test_harness.md
// gotcha). Everything stays inside this call while `state` is alive.
juce::String nestedId(const juce::var& state, int stackIdx, int childIdx) {
  auto* top = kids(state);
  if (!top || stackIdx >= top->size()) return {};
  const juce::var stackVar = (*top)[stackIdx];
  const juce::var nodesVar = stackVar.getProperty("nodes", juce::var());
  auto* arr = nodesVar.getArray();
  return (arr && childIdx < arr->size())
             ? (*arr)[childIdx].getProperty("id", "").toString()
             : juce::String();
}
}  // namespace

class UndoTests : public juce::UnitTest {
 public:
  UndoTests() : juce::UnitTest("Undo / Redo (edits-as-events)") {}

  void runTest() override {
    beginTest("create → undo removes it → redo re-adds the SAME node");
    {
      AudioEngine engine;
      engine.createNode("clip");
      auto s = engine.getGraphState();
      expect(childCount(s) == 1, "one child after create");
      const juce::String uuid = idAt(s, 0);
      expect((bool)s.getProperty("canUndo", false), "canUndo after create");
      expect(!(bool)s.getProperty("canRedo", true), "no redo yet");

      engine.undo();
      s = engine.getGraphState();
      expect(childCount(s) == 0, "child removed by undo");
      expect((bool)s.getProperty("canRedo", false), "canRedo after undo");
      expect(!(bool)s.getProperty("canUndo", true), "no undo left");

      engine.redo();
      s = engine.getGraphState();
      expect(childCount(s) == 1, "child restored by redo");
      expect(idAt(s, 0) == uuid, "SAME uuid after redo (identity preserved)");
    }

    beginTest("rename round-trips across two edits");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = idAt(engine.getGraphState(), 0);
      engine.renameNode(uuid, "A");
      engine.renameNode(uuid, "B");
      expect(nameOf(engine.getGraphState(), uuid) == "B", "renamed to B");
      engine.undo();
      expect(nameOf(engine.getGraphState(), uuid) == "A", "undo -> A");
      engine.undo();
      expect(nameOf(engine.getGraphState(), uuid) == "New Clip",
             "undo -> original create name");
      engine.redo();
      expect(nameOf(engine.getGraphState(), uuid) == "A", "redo -> A");
    }

    beginTest("delete → undo restores the node (uuid + name preserved)");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = idAt(engine.getGraphState(), 0);
      engine.renameNode(uuid, "Keep");

      engine.deleteNode(uuid);
      expect(childCount(engine.getGraphState()) == 0, "deleted");

      engine.undo();
      auto s = engine.getGraphState();
      expect(childCount(s) == 1, "restored");
      expect(idAt(s, 0) == uuid, "same uuid after delete-undo");
      expect(nameOf(s, uuid) == "Keep", "name preserved through delete-undo");
    }

    beginTest("a fresh edit clears the redo branch");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.undo();  // removes it; redo available
      expect((bool)engine.getGraphState().getProperty("canRedo", false),
             "redo available after undo");
      engine.createNode("stack");  // fresh action
      expect(!(bool)engine.getGraphState().getProperty("canRedo", true),
             "redo branch cleared by a new edit");
    }

    beginTest("mute toggle is undoable");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = idAt(engine.getGraphState(), 0);
      engine.toggleMute(uuid);
      auto muted = [&] {
        return (bool)(*kids(engine.getGraphState()))[0].getProperty("isMuted",
                                                                    false);
      };
      expect(muted(), "muted after toggle");
      engine.undo();
      expect(!muted(), "unmuted after undo");
    }

    beginTest("armed take is NOT deletable (cancel is the verb)");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String uuid = idAt(engine.getGraphState(), 0);
      engine.startRecordingInNode(uuid);  // -> Armed
      const bool couldUndoBefore =
          (bool)engine.getGraphState().getProperty("canUndo", false);

      engine.deleteNode(uuid);  // must be a no-op
      auto s = engine.getGraphState();
      expect(childCount(s) == 1, "armed node not deleted");
      expect(idAt(s, 0) == uuid, "same node still present");
      expect((bool)s.getProperty("canUndo", false) == couldUndoBefore,
             "no edit was recorded for the refused delete");
    }

    beginTest("reorder (Move) round-trips within a stack");
    {
      AudioEngine engine;
      engine.createNode("stack");
      const juce::String stackId = idAt(engine.getGraphState(), 0);
      engine.createNode("clip", stackId);
      engine.createNode("clip", stackId);
      const juce::String first = nestedId(engine.getGraphState(), 0, 0);
      const juce::String second = nestedId(engine.getGraphState(), 0, 1);

      engine.reorderNode(second, stackId, 0);  // move second to front
      expect(nestedId(engine.getGraphState(), 0, 0) == second,
             "second moved to front");
      engine.undo();
      expect(nestedId(engine.getGraphState(), 0, 0) == first,
             "order restored by undo");
    }

    beginTest("combine → undo restores the two siblings");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.createNode("clip");
      auto s = engine.getGraphState();
      const juce::String a = idAt(s, 0);
      const juce::String b = idAt(s, 1);

      const juce::String stackUuid = engine.combineNodes(a, b);
      s = engine.getGraphState();
      expect(childCount(s) == 1, "root has just the combined stack");
      expect(idAt(s, 0) == stackUuid, "the new stack is at root");

      engine.undo();
      s = engine.getGraphState();
      expect(childCount(s) == 2, "two siblings restored at root");
      // Both original nodes are back at the top level (not nested).
      bool haveA = false, haveB = false;
      for (auto& n : *kids(s)) {
        const auto id = n.getProperty("id", "").toString();
        if (id == a) haveA = true;
        if (id == b) haveB = true;
      }
      expect(haveA && haveB, "both original nodes restored to root");
    }
  }
};

static UndoTests undoTests;

}  // namespace celestrian
