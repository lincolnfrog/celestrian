/**
 * Whole-graph immutable snapshot (unification_audit.md §2.2, Tier 3
 * Step 3): structure + lifetime invariants.
 *
 * The behavioral coverage is the ENTIRE existing suite — every engine
 * test now renders through the snapshot. What is pinned here is the
 * contract itself: the builder's shape, the snapshot-space timeline
 * math agreeing with the message-side node implementations, and the
 * publish discipline (every structural edit swaps the root pointer;
 * non-structural edits do not).
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/stack_node.h"

namespace celestrian {

class GraphSnapshotTests : public juce::UnitTest {
 public:
  GraphSnapshotTests() : juce::UnitTest("Whole-graph snapshot (Step 3)") {}

  void runTest() override {
    beginTest("builder: DFS shape, parents, child spans");
    {
      StackNode root("root");
      auto clipA = std::make_unique<ClipNode>("A", 1000.0);
      auto inner = std::make_unique<StackNode>("inner");
      auto clipB = std::make_unique<ClipNode>("B", 1000.0);
      auto* a = clipA.get();
      auto* in = inner.get();
      auto* b = clipB.get();
      inner->addChild(std::move(clipB));
      root.addChild(std::move(clipA));
      root.addChild(std::move(inner));

      std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));
      expectEquals((int)snap->entries.size(), 4, "root + A + inner + B");
      expect(snap->entries[0].node == &root && snap->entries[0].parent == -1,
             "entry 0 is the root");
      expectEquals(snap->entries[0].childCount, 2, "root has two children");
      const int ai = snap->childAt(0, 0), ii = snap->childAt(0, 1);
      expect(snap->entries[(size_t)ai].node == a, "first child is A");
      expect(snap->entries[(size_t)ii].node == in, "second child is inner");
      expectEquals(snap->entries[(size_t)ai].parent, 0, "A's parent is root");
      expectEquals(snap->entries[(size_t)ii].childCount, 1, "inner has B");
      const int bi = snap->childAt(ii, 0);
      expect(snap->entries[(size_t)bi].node == b, "inner's child is B");
      expectEquals(snap->entries[(size_t)bi].parent, ii, "B's parent is inner");

      // Solo ancestry (Q16 flags): B is under inner and root, not A —
      // and the any-solo scan sees a flag anywhere in the island.
      expect(!snapAnySolo(*snap), "no solo lit yet");
      in->is_soloed.store(true);
      expect(snapAnySolo(*snap), "any-solo scan sees inner");
      expect(snapIsUnderSolo(*snap, bi), "B under soloed inner");
      in->is_soloed.store(false);
      root.is_soloed.store(true);
      expect(snapIsUnderSolo(*snap, bi), "B under soloed root");
      root.is_soloed.store(false);
      a->is_soloed.store(true);
      expect(!snapIsUnderSolo(*snap, bi), "B NOT under soloed A");
      expect(snapIsUnderSolo(*snap, ai), "A is under its own solo");
      a->is_soloed.store(false);
    }

    beginTest("snapshot-space cycle math agrees with the node-side math");
    {
      StackNode root("root");
      auto c1 = std::make_unique<ClipNode>("c1", 1000.0);
      auto c2 = std::make_unique<ClipNode>("c2", 1000.0);
      c1->duration_samples.store(300);
      c2->duration_samples.store(400);
      c2->setLoopPoints(100, 300);  // active window, len 200
      root.addChild(std::move(c1));
      root.addChild(std::move(c2));

      std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));
      expectEquals(snapIntrinsicDuration(*snap, 0), root.getIntrinsicDuration(),
                   "intrinsic (LCM 300,400 = 1200)");
      expectEquals(snapEffectivePeriod(*snap, 0), root.getEffectivePeriod(),
                   "effective (LCM 300, window 200 = 600)");
      expectEquals(snapIntrinsicDuration(*snap, 0), (int64_t)1200, "…values");
      expectEquals(snapEffectivePeriod(*snap, 0), (int64_t)600, "…");
    }

    beginTest(
        "publish discipline: structural edits swap; parameter edits don't");
    {
      AudioEngine engine;
      auto snapOf = [&engine] {
        // White-box: the published pointer, via the context the callback
        // would receive. (Engine-internal atomic; read on this thread.)
        const juce::var s = engine.getGraphState();  // keep engine warm
        (void)s;
        return engine.currentGraphSnapshotForTest();
      };
      const auto* s0 = snapOf();
      expect(s0 != nullptr, "a snapshot exists from construction");

      engine.createNode("clip");  // structural (Insert)
      const auto* s1 = snapOf();
      expect(s1 != s0, "Insert published a new snapshot");
      expectEquals((int)s1->entries.size(), 2, "root + clip");

      // Non-structural edit: no republish.
      const juce::String id = s1->entries[1].node->getUuid();
      engine.renameNode(id, "renamed");
      expect(snapOf() == s1, "Rename does not republish");

      engine.undo();  // undo the rename (Nop for structure)
      expect(snapOf() == s1, "undo of a rename does not republish");
      engine.undo();  // undo the create (Remove — structural)
      const auto* s2 = snapOf();
      expect(s2 != s1, "undo of the create republished");
      expectEquals((int)s2->entries.size(), 1, "back to the bare root");
      engine.redo();
      expect(snapOf() != s2, "redo republished again");
    }
  }
};

static GraphSnapshotTests graphSnapshotTests;

}  // namespace celestrian
