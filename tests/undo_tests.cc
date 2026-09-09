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
#include "test_utils.h"

namespace celestrian {

using test_utils::nodesOf;

namespace {
juce::String idAt(const juce::var& state, int i) {
  auto* arr = nodesOf(state);
  return (arr && i < arr->size()) ? (*arr)[i].getProperty("id", "").toString()
                                  : juce::String();
}
juce::String nameOf(const juce::var& state, const juce::String& uuid) {
  if (auto* arr = nodesOf(state)) {
    for (auto& n : *arr) {
      if (n.getProperty("id", "").toString() == uuid)
        return n.getProperty("name", "").toString();
    }
  }
  return {};
}
int childCount(const juce::var& state) {
  auto* arr = nodesOf(state);
  return arr ? arr->size() : 0;
}
// The uuid of child `childIdx` inside top-level stack `stackIdx`. Holds
// the intermediate vars alive (getProperty returns BY VALUE — a pointer
// into its result dangles the moment the temporary dies; test_harness.md
// gotcha). Everything stays inside this call while `state` is alive.
juce::String nestedId(const juce::var& state, int stackIdx, int childIdx) {
  auto* top = nodesOf(state);
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
    beginTest("create -> undo removes it -> redo re-adds the SAME node");
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

    beginTest("delete -> undo restores the node (uuid + name preserved)");
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
        return (bool)(*nodesOf(engine.getGraphState()))[0].getProperty(
            "isMuted", false);
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

    beginTest("Move refuses a destination inside the moved subtree");
    {
      // A stack moved into its own descendant would become a self-owning
      // cycle (and the parent walks would never terminate): refused at
      // the applier, nothing recorded.
      AudioEngine engine;
      engine.createNode("stack");
      const juce::String outer = idAt(engine.getGraphState(), 0);
      engine.createNode("stack", outer);
      const juce::String inner = nestedId(engine.getGraphState(), 0, 0);
      const bool couldUndoBefore =
          (bool)engine.getGraphState().getProperty("canUndo", false);

      engine.reorderNode(outer, inner, 0);  // into its own child
      auto s = engine.getGraphState();
      expect(childCount(s) == 1 && idAt(s, 0) == outer, "graph untouched");
      expect(nestedId(s, 0, 0) == inner, "inner still inside outer");
      expect((bool)s.getProperty("canUndo", false) == couldUndoBefore,
             "no edit recorded for the refused move");

      engine.reorderNode(outer, outer, 0);  // into itself
      s = engine.getGraphState();
      expect(childCount(s) == 1 && idAt(s, 0) == outer &&
                 nestedId(s, 0, 0) == inner,
             "self-parent refused too");
    }

    beginTest("hot clips refuse Move and Combine; Explode refuses a hot "
              "member; the island take counter survives");
    {
      AudioEngine engine;
      engine.createNode("stack");
      const juce::String stackId = idAt(engine.getGraphState(), 0);
      engine.createNode("clip", stackId);
      engine.createNode("clip", stackId);
      engine.createNode("clip");
      const juce::String hot = nestedId(engine.getGraphState(), 0, 0);
      const juce::String peer = nestedId(engine.getGraphState(), 0, 1);
      const juce::String outside = idAt(engine.getGraphState(), 1);
      engine.startRecordingInNode(hot);  // -> Armed (a live take)
      const bool couldUndoBefore =
          (bool)engine.getGraphState().getProperty("canUndo", false);

      engine.reorderNode(hot, stackId, 1);
      auto s = engine.getGraphState();
      expect(nestedId(s, 0, 0) == hot, "armed clip not moved");
      expect((bool)s.getProperty("canUndo", false) == couldUndoBefore,
             "refused move recorded nothing");

      expect(engine.combineNodes(hot, outside).isEmpty(),
             "combine of an armed clip refused");
      expect(engine.combineNodes(outside, hot).isEmpty(),
             "combine INTO an armed clip refused");
      s = engine.getGraphState();
      expect(childCount(s) == 2 && idAt(s, 1) == outside,
             "graph untouched by the refused combines");

      // D4-16: two armed clips combined — refused, and the counter is
      // still balanced: cancelling both leaves no active take, so the
      // very same combine then succeeds.
      engine.startRecordingInNode(outside);
      expect(engine.combineNodes(hot, outside).isEmpty(),
             "combine of two armed clips refused");
      engine.stopRecordingInNode(hot);      // Armed -> cancel
      engine.stopRecordingInNode(outside);  // Armed -> cancel
      const juce::String combined = engine.combineNodes(hot, outside);
      expect(combined.isNotEmpty(), "idle again: combine succeeds");

      // Explode (the undo of a Combine) with a hot member is refused
      // and the undo entry is KEPT: cancel, then the same undo works.
      // (Since the live-take gate — owner ruling 2026-09-09 — ANY live
      // take refuses undo island-wide; the entry is kept either way.)
      juce::ignoreUnused(peer);
      const juce::String member = [&] {
        auto st = engine.getGraphState();
        for (int i = 0; i < childCount(st); ++i) {
          if (idAt(st, i) == combined) return nestedId(st, i, 0);
        }
        return juce::String();
      }();
      expect(member.isNotEmpty(), "combined stack has a member");
      engine.startRecordingInNode(member);
      engine.undo();  // Explode refused: a member is hot
      bool present = false;
      s = engine.getGraphState();
      for (int i = 0; i < childCount(s); ++i) {
        if (idAt(s, i) == combined) present = true;
      }
      expect(present, "combined stack survives the refused explode");
      engine.stopRecordingInNode(member);  // cancel
      engine.undo();  // the KEPT entry applies now
      present = false;
      s = engine.getGraphState();
      for (int i = 0; i < childCount(s); ++i) {
        if (idAt(s, i) == combined) present = true;
      }
      expect(!present, "after cancel the kept undo entry explodes it");
    }

    beginTest("Combine/Explode is an inverse pair: redo reuses the SAME "
              "stack (uuid, name, mute survive)");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.createNode("clip");
      auto s = engine.getGraphState();
      const juce::String a = idAt(s, 0);
      const juce::String b = idAt(s, 1);
      const juce::String stackId = engine.combineNodes(a, b);
      expect(stackId.isNotEmpty(), "combined");
      engine.renameNode(stackId, "Verse");
      engine.toggleMute(stackId);
      auto stackProp = [&](const char* key) {
        auto st = engine.getGraphState();
        for (int i = 0; i < childCount(st); ++i) {
          if (idAt(st, i) == stackId) {
            return (*nodesOf(st))[i].getProperty(key, juce::var());
          }
        }
        return juce::var();
      };
      expect(stackProp("name").toString() == "Verse", "renamed");
      expect((bool)stackProp("isMuted"), "muted");

      engine.undo();  // unmute
      engine.undo();  // rename back
      engine.undo();  // explode
      s = engine.getGraphState();
      expect(childCount(s) == 2 && idAt(s, 0) == a && idAt(s, 1) == b,
             "exploded back to two siblings in their original order");

      engine.redo();  // combine: must reuse the SAME stack object
      s = engine.getGraphState();
      expect(childCount(s) == 1 && idAt(s, 0) == stackId,
             "redo restored the stack with its ORIGINAL uuid");
      engine.redo();  // rename, addressed to that uuid
      expect(stackProp("name").toString() == "Verse",
             "redo of the rename resolves (not dropped)");
      engine.redo();  // mute
      expect((bool)stackProp("isMuted"), "redo of the mute resolves");
      expect(!(bool)engine.getGraphState().getProperty("canRedo", false),
             "redo branch fully replayed");
    }

    beginTest("combine -> undo restores the two siblings");
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
      for (auto& n : *nodesOf(s)) {
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
