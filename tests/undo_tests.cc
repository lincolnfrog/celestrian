/**
 * Undo / redo tests (edits-as-events).
 *
 * Drives the AudioEngine's public mutation surface and asserts every edit
 * kind round-trips: apply → undo restores the exact prior state (incl.
 * uuids), redo re-applies. The load-bearing case is delete-then-undo
 * preserving the node identity (a mis-click deleting a take must not be
 * fatal). Also pins the armed-take guard (cancel is the verb, not undo).
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/dsp/vst3_slot.h"
#include "scenario_utils.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::posmod;
using test_utils::nodesOf;

namespace {
/** The top-level ids, in order. */
juce::StringArray topIds(const juce::var& state) {
  juce::StringArray out;
  if (auto* arr = nodesOf(state))
    for (auto& n : *arr) out.add(n.getProperty("id", "").toString());
  return out;
}
/** How many nodes the published graph reaches below `node`. */
int reachableNodes(const juce::var& node) {
  int n = 0;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) n += 1 + reachableNodes(k);
  return n;
}
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
  UndoTests() : juce::UnitTest("Undo / Redo (edits-as-events)", "Undo") {}

  /** Expect the engine's published graph to be `want` (a graphFacts
   * capture); a failure names the first fact that differs. */
  void expectGraph(AudioEngine& engine, const juce::var& want,
                   const juce::String& label) {
    const juce::String diff =
        test_utils::firstDifference(want, test_utils::graphFacts(engine));
    expect(diff.isEmpty(), label + (diff.isEmpty() ? "" : " - " + diff));
  }

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

      // An index past the front: with a third clip, the first moves to
      // the end, and back.
      engine.createNode("clip", stackId);
      const juce::String third = nestedId(engine.getGraphState(), 0, 2);
      engine.reorderNode(first, stackId, 2);
      expect(nestedId(engine.getGraphState(), 0, 0) == second &&
                 nestedId(engine.getGraphState(), 0, 1) == third &&
                 nestedId(engine.getGraphState(), 0, 2) == first,
             "index 2: first moved to the end");
      engine.reorderNode(first, stackId, 0);
      expect(nestedId(engine.getGraphState(), 0, 0) == first &&
                 nestedId(engine.getGraphState(), 0, 1) == second,
             "index 0: first moved back to the front");
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

      // Two armed clips combined — refused, and the counter is still
      // balanced: cancelling both leaves no active take, so the very
      // same combine then succeeds.
      engine.startRecordingInNode(outside);
      expect(engine.combineNodes(hot, outside).isEmpty(),
             "combine of two armed clips refused");
      engine.stopRecordingInNode(hot);      // Armed -> cancel
      engine.stopRecordingInNode(outside);  // Armed -> cancel
      const juce::String combined = engine.combineNodes(hot, outside);
      expect(combined.isNotEmpty(), "idle again: combine succeeds");

      // Explode (the undo of a Combine) with a hot member is refused
      // and the undo entry is KEPT: cancel, then the same undo works.
      // (ANY live take refuses undo island-wide; the entry is kept
      // either way.)
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

    beginTest("combine -> undo restores the sibling order when a sibling "
              "sat between the two");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.createNode("clip");
      engine.createNode("clip");
      const juce::StringArray before = topIds(engine.getGraphState());
      // Dragged = the third, target = the first; the second sits between.
      const juce::String stack = engine.combineNodes(before[2], before[0]);
      expect(stack.isNotEmpty(), "combined");
      const juce::StringArray combined = topIds(engine.getGraphState());
      expect(combined.size() == 2 && combined[0] == stack &&
                 combined[1] == before[1],
             "the stack takes the target's slot");
      engine.undo();
      expect(topIds(engine.getGraphState()) == before,
             "undo restores the three siblings in their order");
      engine.redo();
      expect(topIds(engine.getGraphState()) == combined, "redo combines again");
      engine.undo();
      expect(topIds(engine.getGraphState()) == before,
             "...and the order survives a second undo");

      // The mirror: dragged = the first, target = the third.
      const juce::String mirror = engine.combineNodes(before[0], before[2]);
      expect(mirror.isNotEmpty(), "combined the other way");
      engine.undo();
      expect(topIds(engine.getGraphState()) == before,
             "undo restores the order from either direction");
    }

    beginTest("Combine refuses a group with its own member, either way "
              "round");
    {
      // A group dropped on one of its members would be inserted into
      // itself; a member dropped on its group would wrap the group it
      // still names as its parent. Refused at the applier, nothing
      // recorded, nothing detached.
      Island is;
      const juce::String c1 = is.record(20000);
      const juce::String c2 = is.record(is.Q());
      const juce::String group = is.engine.combineNodes(c1, c2);
      expect(group.isNotEmpty(), "two takes grouped");
      is.engine.createNode("stack", group);
      const juce::String inner = is.childIds(group)[2];
      const juce::String c3 = is.record(is.Q(), inner);
      const juce::var before = test_utils::graphFacts(is.engine);
      const int reachable = reachableNodes(is.state());

      expect(is.engine.combineNodes(group, c1).isEmpty(),
             "the group onto its member: refused");
      expect(is.engine.combineNodes(c1, group).isEmpty(),
             "a member onto its group: refused");
      expect(is.engine.combineNodes(group, c3).isEmpty(),
             "the group onto a member two levels down: refused");
      expect(is.engine.combineNodes(c3, group).isEmpty(),
             "...and that member onto the group: refused");
      expectEquals(reachableNodes(is.state()), reachable,
                   "every node is still in the session");
      expectGraph(is.engine, before, "the refused combines changed nothing");
      // The published snapshot still lists exactly the live nodes.
      is.blocks(8);

      is.engine.undo();  // the newest real entry: the take in the inner stack
      expectEquals(is.dur(c3), (int64_t)0,
                   "no entry was logged by the refused combines");
    }

    beginTest("two idle tracks cannot be combined while a third records");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.createNode("clip");
      engine.createNode("clip");
      const juce::StringArray ids = topIds(engine.getGraphState());
      engine.startRecordingInNode(ids[2]);  // -> Armed (a live take)
      expect(engine.combineNodes(ids[0], ids[1]).isEmpty(),
             "combine refused under the live take");
      expect(topIds(engine.getGraphState()) == ids, "the lanes stay as they were");
      engine.stopRecordingInNode(ids[2]);  // Armed -> cancel
      const juce::String stack = engine.combineNodes(ids[0], ids[1]);
      expect(stack.isNotEmpty(), "idle again: the same combine succeeds");
      const juce::StringArray after = topIds(engine.getGraphState());
      expect(after.size() == 2 && after[0] == stack && after[1] == ids[2],
             "the stack sits in the target's slot");
    }

    beginTest("a live drag is one undo step that restores the origin the "
              "gesture found, whichever commit moved it");
    {
      // Each lap: an 8Q take beside the Q-definer, playing in its second
      // half. The gesture's first commit keeps [0, 4Q) — the sounding
      // half is gone, so the origin stays; its live commit [0, 7Q) covers
      // the playing position again and re-anchors by a whole Q.
      enum class End { Undo, Cancel };
      for (const End end : {End::Undo, End::Cancel}) {
        const juce::String tag =
            end == End::Undo ? " (undo)" : " (cancelGesture)";
        Island is;
        is.record(20000);
        const int64_t Q = is.Q();
        const juce::String b = is.record(8 * Q);
        const int64_t origin = is.origin(b);
        is.driveToPhase(posmod(origin - is.zero() + 5 * Q, is.cycle()));
        is.drive(Q / 2);
        const juce::var before = test_utils::graphFacts(is.engine);

        is.engine.setLoopPoints(b, 0, 4 * Q);
        expectEquals(is.origin(b), origin,
                     "the cut removed what was sounding: the origin stays" + tag);
        is.engine.setLoopPoints(b, 0, 7 * Q, /*live=*/true);
        expect(is.origin(b) != origin,
               "the live commit re-anchors the take" + tag);

        if (end == End::Undo) is.engine.undo();
        else is.engine.cancelGesture(b);
        expectEquals(is.origin(b), origin,
                     "the origin the gesture found is back" + tag);
        expectEquals(is.iprop(b, "loopEnd"), (int64_t)0,
                     "...with the whole take" + tag);
        expectGraph(is.engine, before,
                    "the graph is the one the gesture found" + tag);
      }
    }

    beginTest("a live clear inside a drag: undo restores the bypass the "
              "gesture found");
    {
      Island is;
      is.record(20000);
      const int64_t Q = is.Q();
      const juce::String b = is.record(8 * Q);
      is.engine.setLoopPoints(b, 0, 4 * Q);
      is.engine.toggleLoopWindow(b);  // the window is bypassed
      expect(is.bprop(b, "loopBypassed"), "bypassed");
      const juce::var before = test_utils::graphFacts(is.engine);

      is.engine.setLoopPoints(b, 0, 2 * Q);  // the gesture's first commit
      expect(is.bprop(b, "loopBypassed"), "a window edit keeps the bypass");
      is.engine.setLoopPoints(b, 0, 0, /*live=*/true);  // dragged to whole
      expect(!is.bprop(b, "loopBypassed"), "a clear drops the bypass");
      is.engine.setLoopPoints(b, 0, 6 * Q, /*live=*/true);  // and back in
      const juce::var after = test_utils::graphFacts(is.engine);

      is.engine.undo();
      expect(is.bprop(b, "loopBypassed"), "undo: the bypass is back");
      expectGraph(is.engine, before, "...with the window the gesture found");
      is.engine.redo();
      expectGraph(is.engine, after, "redo: the drag's last commit, sounding");
    }

    // A verb that records an edit answers whether the edit was applied:
    // false leaves the graph and the log exactly as they were.
    const juce::String missing = "no-such-node";

    beginTest("structure verbs answer whether they applied");
    {
      Island is;
      AudioEngine& engine = is.engine;
      expect(engine.createNode("clip"), "createNode");
      const juce::String clip = is.childIds()[0];
      expect(!engine.createNode("clip", missing), "createNode: no such parent");
      expect(!engine.createNode("clip", clip), "createNode: a clip holds nothing");
      const juce::String group = is.createStack();
      const juce::String inner = is.createStack(group);
      expect(engine.insertTrackTemplate(engine.captureTrackTemplate(group), {}),
             "insertTrackTemplate");
      expect(!engine.insertTrackTemplate(juce::var(), {}),
             "insertTrackTemplate: not a template");
      expect(engine.renameNode(clip, "Bass"), "renameNode");
      expect(!engine.renameNode(missing, "Bass"), "renameNode: no such node");
      expect(engine.reorderNode(clip, group, 0), "reorderNode");
      expect(!engine.reorderNode(group, inner, 0),
             "reorderNode: into its own subtree");
      const juce::var before = test_utils::graphFacts(engine);
      expect(!engine.deleteNode(is.rootId()), "deleteNode: the root");
      expect(!engine.deleteNode(missing), "deleteNode: no such node");
      expectGraph(engine, before, "the refusals changed nothing");
      expect(engine.deleteNode(inner), "deleteNode");
    }

    beginTest("undo and redo answer whether an entry was applied");
    {
      Island is;
      AudioEngine& engine = is.engine;
      expect(!engine.undo(), "undo: an empty log");
      expect(!engine.redo(), "redo: an empty log");
      const juce::String clip = is.createClip();
      expect(engine.undo(), "undo");
      expect(!engine.undo(), "undo: nothing left");
      expect(engine.redo(), "redo");
      expect(!engine.redo(), "redo: nothing left");
      engine.startRecordingInNode(clip);  // -> Armed (a live take)
      expect(!engine.undo(), "undo: refused under a live take");
      expect(engine.canUndo(), "...and the entry is kept");
      engine.stopRecordingInNode(clip);  // Armed -> cancel
      expect(engine.undo(), "idle again: the kept entry applies");
    }

    beginTest("node-fact and chain verbs answer whether they applied");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String definer = is.record(20000);
      const juce::String clip = is.record(4 * is.Q());
      const juce::String group = is.createStack();
      expect(engine.toggleMute(clip), "toggleMute");
      expect(!engine.toggleMute(missing), "toggleMute: no such node");
      expect(engine.setNodeInput(clip, 1), "setNodeInput");
      expect(!engine.setNodeInput(group, 1), "setNodeInput: a stack has none");
      expect(engine.setNodeInputRight(clip, 2), "setNodeInputRight");
      expect(!engine.setNodeInputRight(missing, 2),
             "setNodeInputRight: no such node");
      expect(engine.setPeriodSource(clip, PeriodSource::CONTEXT_CYCLE),
             "setPeriodSource");
      expect(!engine.setPeriodSource(clip, PeriodSource::CONTEXT_CYCLE),
             "setPeriodSource: already a one-shot");
      expect(engine.deleteNode(clip), "the definer is the only content left");
      expect(!engine.setPeriodSource(definer, PeriodSource::CONTEXT_CYCLE),
             "setPeriodSource: the island's whole content cannot be a one-shot");

      const juce::String first_slot = is.node(definer)
                                          .getProperty("effects", juce::var())
                                          .getProperty("chain", juce::var())[0]
                                          .getProperty("slot", "")
                                          .toString();
      expect(first_slot.isNotEmpty(), "the clip's chain has slots");
      expect(engine.moveChainSlot(definer, first_slot, 2), "moveChainSlot");
      expect(!engine.moveChainSlot(definer, first_slot, 2),
             "moveChainSlot: already there");
      expect(!engine.moveChainSlot(definer, missing, 0),
             "moveChainSlot: no such slot");
      auto plugin = std::make_shared<dsp::Vst3Slot>(
          std::make_unique<test_utils::StubPluginInstance>(0.5f), "Stub-uid",
          "Stub Gain", "/stub/StubGain.vst3");
      expect(!engine.addPluginSlotToChain(missing, plugin, 0),
             "addPluginSlotToChain: no such node");
      expect(!engine.addPluginSlotToChain(definer, nullptr, 0),
             "addPluginSlotToChain: no slot");
      expect(engine.addPluginSlotToChain(definer, plugin, 0),
             "addPluginSlotToChain");
      expect(!engine.removeChainSlot(definer, first_slot),
             "removeChainSlot: a built-in effect stays");
      expect(engine.removeChainSlot(definer, plugin->slotUuid()),
             "removeChainSlot");
      expect(!engine.removeChainSlot(definer, plugin->slotUuid()),
             "removeChainSlot: already gone");
    }

    beginTest("map, re-time and sequence verbs answer whether they applied");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(20000);
      const int64_t Q = is.Q();
      const juce::String clip = is.record(8 * Q);
      const juce::String empty = is.createClip();
      const juce::String root = is.rootId();
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {0, Q};
      cells.segs[1] = {2 * Q, 3 * Q};
      timing::TimeMap overlapping = cells;
      overlapping.segs[1] = {Q / 2, 3 * Q};

      expect(engine.setLoopPoints(clip, 0, 4 * Q), "setLoopPoints");
      expect(!engine.setLoopPoints(clip, 0, 4 * Q),
             "setLoopPoints: the stored window again");
      expect(!engine.setLoopPoints(clip, 0, Q + 7),
             "setLoopPoints: a length off the Q grid");
      expect(!engine.setLoopPoints(missing, 0, Q), "setLoopPoints: no such node");
      expect(engine.setSegments(clip, cells), "setSegments");
      expect(!engine.setSegments(clip, cells), "setSegments: the stored map again");
      expect(!engine.setSegments(clip, overlapping),
             "setSegments: overlapping cells");
      expect(!engine.setSegments(empty, cells), "setSegments: nothing to map");
      expect(engine.toggleLoopWindow(clip), "toggleLoopWindow");
      expect(!engine.toggleLoopWindow(missing), "toggleLoopWindow: no such node");

      expect(engine.setTiming(clip, Q / 4), "setTiming");
      expect(!engine.setTiming(clip, 0), "setTiming: no shift, no top");
      expect(!engine.setTiming(empty, Q), "setTiming: nothing committed");
      expect(!engine.setTiming(root, Q), "setTiming: the root");
      expect(!engine.setTiming(clip, Q, 7 * Q),
             "setTiming: a top the map does not play");

      const juce::var song = scenario::seqPayload({{4 * Q}, {4 * Q}});
      expect(engine.setSequence(root, song), "setSequence");
      expect(!engine.setSequence(clip, song), "setSequence: not a stack");
      expect(!engine.setSequence(root, scenario::seqPayload({{0}})),
             "setSequence: a step of no length");
      expect(engine.toggleSequence(root), "toggleSequence");
      expect(!engine.toggleSequence(clip), "toggleSequence: not a stack");

      // Under a live take only the wiring kinds stay live.
      const juce::var before = test_utils::graphFacts(engine);
      engine.startRecordingInNode(empty);  // -> Armed
      expect(!engine.setLoopPoints(clip, 0, 2 * Q), "a take is live: no map edit");
      timing::TimeMap other_cells = cells;
      other_cells.segs[1] = {4 * Q, 5 * Q};
      expect(!engine.setSegments(clip, other_cells), "...no cell map");
      expect(!engine.toggleLoopWindow(clip), "...no bypass");
      expect(!engine.setTiming(clip, Q), "...no re-time");
      expect(!engine.setSequence(root, juce::var()), "...no song edit");
      expect(!engine.toggleSequence(root), "...no song bypass");
      expect(!engine.deleteNode(clip), "...no delete");
      expect(!engine.setPeriodSource(clip, PeriodSource::CONTEXT_CYCLE),
             "...no one-shot");
      expect(engine.renameNode(clip, "Lead"), "...but a rename applies");
      expect(engine.toggleMute(clip), "...and a mute");
      engine.stopRecordingInNode(empty);  // Armed -> cancel
      expect(engine.undo() && engine.undo(), "idle: the mute and the rename undo");
      expectGraph(engine, before, "the refused edits changed nothing");
    }

    beginTest("a definer's window that clamps to the one it has is an "
              "identity, clip or group: no step, no origin moved");
    for (const bool group : {false, true}) {
      const juce::String tag = group ? " (a group take)" : " (a clip)";
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String definer =
          group ? is.recordGroup(2, 20000) : is.record(20000);
      expectEquals(is.state().getProperty("definerId", "").toString(), definer,
                   "it defines Q" + tag);
      expect(engine.setLoopPoints(definer, 10000, 20000), "its trim" + tag);
      engine.renameNode(definer, "Kit");
      engine.undo();  // a redo branch an identity must leave standing
      is.drive(3 * 10000 + 1234);  // playing, whole passes later
      const juce::var before = test_utils::graphFacts(engine);

      // Past the take the window clamps to [10000, 20000): the stored one.
      expect(!engine.setLoopPoints(definer, 10000, 25000),
             "the clamped window is the stored one" + tag);
      expectGraph(engine, before, "nothing moved" + tag);
      expect(engine.canRedo(), "the redo branch stands" + tag);
      engine.undo();
      expectEquals(is.iprop(definer, "loopEnd"), (int64_t)0,
                   "the newest step is still the trim" + tag);
    }

    beginTest("a group's map selects INNER positions - within the LCM of its "
              "members' takes, whatever the members play (composition.md 1)");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(20000);
      const int64_t Q = is.Q();
      const auto cellsAt = [](int64_t second_start, int64_t q) {
        timing::TimeMap map;
        map.n = 2;
        map.segs[0] = {0, q};
        map.segs[1] = {second_start, second_start + q};
        return map;
      };

      // A member that plays 1Q of its 4Q take: the group plays 1Q, and
      // its map still selects over the 4Q take.
      const juce::String kit = is.createStack();
      const juce::String mic = is.record(4 * Q, kit);
      expect(engine.setLoopPoints(mic, 0, Q), "the member plays a 1Q window");
      expectEquals(is.nodePtr(kit)->getEffectivePeriod(), Q, "the group plays 1Q");
      expectEquals(is.nodePtr(kit)->getIntrinsicDuration(), 4 * Q,
                   "its inner cycle is the 4Q take");
      expect(engine.setLoopPoints(kit, 2 * Q, 4 * Q),
             "a window up to the take's end");
      expect(!engine.setLoopPoints(kit, 2 * Q, 6 * Q), "...and none past it");
      expect(engine.setSegments(kit, cellsAt(3 * Q, Q)), "cells inside it");
      expect(!engine.setSegments(kit, cellsAt(4 * Q, Q)), "...and none past it");

      // A member group whose 8Q song runs over a 2Q take: the outer group
      // plays 8Q, and its map still selects over the 2Q take.
      const juce::String outer = is.createStack();
      const juce::String band = is.createStack(outer);
      is.record(2 * Q, band);
      expect(engine.setSequence(
                 band, scenario::seqPayload({{2 * Q}, {4 * Q}, {2 * Q}})),
             "a song on the member group");
      expectEquals(is.nodePtr(outer)->getEffectivePeriod(), 8 * Q,
                   "the outer group plays the 8Q song");
      expectEquals(is.nodePtr(outer)->getIntrinsicDuration(), 2 * Q,
                   "its inner cycle is the 2Q take");
      const juce::var before = test_utils::graphFacts(engine);
      expect(!engine.setLoopPoints(outer, 0, 4 * Q),
             "no window past the take, though the song runs on");
      expect(!engine.setSegments(outer, cellsAt(4 * Q, Q)), "...and no cells");
      expectGraph(engine, before, "the refusals changed nothing");
      expect(engine.setLoopPoints(outer, Q, 2 * Q), "a window inside the take");
    }

    beginTest("the top rides a map edit as the edit leaves the node: a group "
              "window suspended with its song is in force once re-drawn, and "
              "the top lands on its start - by a window or by cells");
    for (const bool by_cells : {false, true}) {
      const juce::String tag = by_cells ? " (cells)" : " (a window)";
      Island is;
      AudioEngine& engine = is.engine;
      is.record(20000);
      const int64_t Q = is.Q();
      const juce::String group = is.createStack();
      is.record(8 * Q, group);
      engine.setSequence(group, scenario::seqPayload({{4 * Q}, {4 * Q}}));
      engine.setLoopPoints(group, 0, 4 * Q);  // drawn over the song
      engine.toggleSequence(group);           // the song off
      expect(is.bprop(group, "windowSuspended"),
             "the window is suspended with its song" + tag);
      expectEquals(is.iprop(group, "loopTop"), (int64_t)0, "the top is 0" + tag);
      const juce::var found = test_utils::graphFacts(engine);

      // A region that no longer keeps the top, drawn with no song playing.
      if (by_cells) {
        timing::TimeMap cells;
        cells.n = 2;
        cells.segs[0] = {2 * Q, 3 * Q};
        cells.segs[1] = {4 * Q, 5 * Q};
        expect(engine.setSegments(group, cells), "new cells" + tag);
      } else {
        expect(engine.setLoopPoints(group, 2 * Q, 4 * Q), "a new window" + tag);
      }
      expect(is.bprop(group, "windowActive") &&
                 !is.bprop(group, "windowSuspended"),
             "the region is in force" + tag);
      expectEquals(is.nodePtr(group)->storedTop(), 2 * Q,
                   "the top is stored on the new region's start" + tag);
      const juce::var made = test_utils::graphFacts(engine);
      engine.toggleLoopWindow(group);
      expectEquals(is.iprop(group, "loopTop"), 2 * Q,
                   "...and stays there under a bypass" + tag);

      engine.undo();  // the bypass
      engine.undo();  // the re-drawn region
      expectGraph(engine, found, "undone: the suspended window again" + tag);
      expectEquals(is.nodePtr(group)->storedTop(), (int64_t)0,
                   "...with the top it had" + tag);
      engine.redo();
      expectGraph(engine, made, "redone: the region in force" + tag);
      expectEquals(is.nodePtr(group)->storedTop(), 2 * Q,
                   "...with its top" + tag);
    }

    beginTest("the root's map is the island's loop region: an empty island "
              "has none to set or to bypass");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String root = is.rootId();
      timing::TimeMap one_cell;
      one_cell.n = 1;
      one_cell.segs[0] = {0, 10000};
      timing::TimeMap two_cells;
      two_cells.n = 2;
      two_cells.segs[0] = {0, 10000};
      two_cells.segs[1] = {20000, 30000};
      const auto expectRefused = [&](const juce::String& when) {
        const juce::var before = test_utils::graphFacts(engine);
        const bool could_undo = engine.canUndo();
        expect(!engine.setLoopPoints(root, 0, 10000), when + ": setLoopPoints");
        expect(!engine.setLoopPoints(root, 0, 10000, /*live=*/true),
               when + ": a live setLoopPoints");
        expect(!engine.setSegments(root, one_cell),
               when + ": setSegments, one segment");
        expect(!engine.setSegments(root, two_cells), when + ": setSegments, cells");
        expect(!engine.toggleLoopWindow(root), when + ": toggleLoopWindow");
        expect(engine.canUndo() == could_undo, when + ": no undo step");
        expectGraph(engine, before, when + ": nothing changed");
      };
      expectRefused("a fresh island");
      expect(!engine.canUndo(), "the log is still empty");
      const juce::String box = is.createStack();
      is.createClip();
      expectRefused("tracks, no take");
      // An empty GROUP is a part authored ahead of its first take: its
      // window is legal, and meets the scrub when Q is established.
      expect(engine.setLoopPoints(box, 0, 10000), "an empty group takes a window");
      expect(engine.undo(), "...as one undo step");

      // With content the root is a stack like any other.
      is.record(20000);
      const int64_t Q = is.Q();
      const juce::String long_take = is.record(4 * Q);
      expect(engine.setLoopPoints(root, 0, 2 * Q), "content: the root's window");
      expectEquals(is.rootProp("loopEnd"), 2 * Q, "...is stored");
      expect(engine.toggleLoopWindow(root), "content: its bypass");
      two_cells.segs[0] = {0, Q};
      two_cells.segs[1] = {2 * Q, 3 * Q};
      expect(engine.setSegments(root, two_cells), "content: the root's cells");

      // A delete that empties the island leaves the root's map stored
      // over nothing: it can be cleared, and nothing else.
      expect(engine.deleteNode(long_take) && engine.deleteNode(is.childIds()[2]),
             "the island is emptied");
      expectEquals(is.Q(), (int64_t)0, "no Q");
      expect(is.state().hasProperty("segments"), "the root's cells outlive it");
      expectRefused("an emptied island");
      expect(engine.setLoopPoints(root, 0, 0), "...but the stale map clears");
      expect(!is.state().hasProperty("segments"), "the root plays whole");
    }
  }
};

static UndoTests undoTests;

}  // namespace celestrian
