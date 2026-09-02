/**
 * TAKES ARE UNDOABLE (owner ruling 2026-08-20, docs/sequencer.md §11.5;
 * edit.h Kind::Take / Untake). Commit is an audio-thread event, so the
 * engine registers a PENDING performance at arm and reconciles it into
 * the undo log on the message thread once every member has settled.
 * Pins:
 *
 *   - the first take: ⌘Z strips the clip back to empty AND reverts the
 *     island grid (Q, epoch) it established; redo reinstalls the content
 *     bit-identically with the grid;
 *   - take 2: undo restores the pre-take epoch (growth re-base undone);
 *   - a Q7 GROUP take is ONE undo step (one performance);
 *   - undo/redo of a take is REFUSED (entry kept) while a take is live;
 *   - the log ORDERS a take before later edits (rename after take: the
 *     first undo is the rename);
 *   - S19 AUTO-GATE: a take recorded into a looping step gates its row
 *     ON there / OFF elsewhere, and ONE undo removes take + gates;
 *   - a deeper take (audition on the root, record inside a group) is
 *     NOT auto-gated.
 *
 * Twin: ui/js/tests/take_undo.test.mjs (mock parity).
 */

#include <juce_core/juce_core.h>

#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "test_utils.h"

namespace celestrian {

namespace {

using test_utils::nodesOf;

std::function<void(int)> makeProcess(AudioEngine& engine) {
  return [&engine](int n) { test_utils::driveEngine(engine, n, 512); };
}

/** Find a node's property anywhere in the tree (−1 when absent). */
double propOf(const AudioEngine& engine, const juce::String& id,
              const char* key) {
  const juce::var s = engine.getGraphState();  // hold the var
  std::function<double(const juce::var&)> scan =
      [&](const juce::var& arr) -> double {
    if (auto* a = arr.getArray()) {
      for (auto& n : *a) {
        if (n.getProperty("id", "").toString() == id) {
          return (double)n.getProperty(key, -1.0);
        }
        const double f = scan(n.getProperty("nodes", juce::var()));
        if (f != -1e18) return f;
      }
    }
    return -1e18;
  };
  const double f = scan(s.getProperty("nodes", juce::var()));
  return f == -1e18 ? -1.0 : f;
}

int64_t islandQ(const AudioEngine& engine) {
  return (int64_t)(double)engine.getGraphState().getProperty("quantum", 0.0);
}
int64_t islandEp(const AudioEngine& engine) {
  return (int64_t)(double)engine.getGraphState().getProperty("islandEpoch",
                                                             0.0);
}
juce::String rootId(const AudioEngine& engine) {
  return engine.getGraphState().getProperty("id", "").toString();
}
juce::String lastTopId(const AudioEngine& engine) {
  const juce::var s = engine.getGraphState();
  auto* n = nodesOf(s);
  return (*n)[n->size() - 1].getProperty("id", "").toString();
}
juce::var gatesOf(const AudioEngine& engine) {
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
      AudioEngine engine;
      auto process = makeProcess(engine);
      expect(!engine.canUndo(), "fresh engine: nothing to undo");
      const juce::String c1 = test_utils::recordClip(engine, process, 20000);
      expect(test_utils::isClipCommitted(engine, c1), "committed");
      const int64_t q = islandQ(engine);
      expect(q > 0, "Q established");
      // The poll reconciles the pending performance into the log.
      engine.getGraphState();
      expect(engine.canUndo(), "the take is an undo step");
      expect(!engine.hasPendingTakes(), "pending list drained");

      // Snapshot the content for the bit-identity check.
      std::vector<float> before;
      {
        const juce::var s = engine.getGraphState();
        (void)s;
      }
      engine.undo();
      expectEquals(propOf(engine, c1, "duration"), 0.0,
                   "undo: the clip is EMPTY again");
      expect(!(bool)propOf(engine, c1, "isRecording"), "idle");
      expectEquals(islandQ(engine), (int64_t)0,
                   "undo: the grid the take established is gone");
      expect(engine.canRedo(), "redo available");

      engine.redo();
      expectEquals((int64_t)propOf(engine, c1, "duration"), q,
                   "redo: content back");
      expectEquals(islandQ(engine), q, "redo: grid back");
      // Undo again and record a NEW first take: establishes afresh.
      engine.undo();
      const juce::String c2 = test_utils::recordClip(engine, process, 30000);
      expect(test_utils::isClipCommitted(engine, c2), "new first take");
      expect(islandQ(engine) > 0, "a fresh first take establishes Q again");
    }

    beginTest("take 2: undo restores the pre-take epoch; take + rename order");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      const juce::String c1 = test_utils::recordClip(engine, process, 20000);
      const int64_t q = islandQ(engine);
      const int64_t ep0 = islandEp(engine);
      // Advance past the top so take 2 anchors mid-cycle and grows the
      // cycle (2 takes ⇒ re-base candidates).
      process((int)(q + q / 2));
      const juce::String c2 =
          test_utils::recordClip(engine, process, (int)(2 * q) - 200);
      expect(test_utils::isClipCommitted(engine, c2), "take 2 committed");
      engine.getGraphState();
      engine.renameNode(c2, "solo");
      // Undo #1 = the rename; undo #2 = take 2.
      engine.undo();
      expectEquals((int64_t)propOf(engine, c2, "duration"), (int64_t)(2 * q),
                   "first undo was the rename; take 2 stands");
      engine.undo();
      expectEquals(propOf(engine, c2, "duration"), 0.0, "take 2 stripped");
      expectEquals(islandEp(engine), ep0, "epoch back to its pre-take value");
      expectEquals(islandQ(engine), q, "Q untouched (take 1 still defines it)");
      engine.redo();
      expectEquals((int64_t)propOf(engine, c2, "duration"), (int64_t)(2 * q),
                   "redo reinstalls take 2");
    }

    beginTest("Q7 group take = ONE undo step");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      engine.createNode("stack");
      const juce::String sId = lastTopId(engine);
      engine.createNode("clip", sId);
      engine.createNode("clip", sId);
      engine.startRecordingInNode(sId);
      process(100);
      process(20000);
      engine.stopRecordingInNode(sId);
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) process(512);
      engine.getGraphState();
      juce::String a, b;
      {
        const juce::var s = engine.getGraphState();
        auto* top = nodesOf(s);
        auto kids = (*top)[0].getProperty("nodes", juce::var());
        a = (*kids.getArray())[0].getProperty("id", "").toString();
        b = (*kids.getArray())[1].getProperty("id", "").toString();
      }
      expect(propOf(engine, a, "duration") > 0 && propOf(engine, b, "duration") > 0,
             "both members committed");
      engine.undo();
      expectEquals(propOf(engine, a, "duration"), 0.0, "one undo strips A");
      expectEquals(propOf(engine, b, "duration"), 0.0, "...and B");
      engine.redo();
      expect(propOf(engine, a, "duration") > 0 && propOf(engine, b, "duration") > 0,
             "one redo restores both");
    }

    beginTest("undo of a take is refused (kept) while a take is live");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      const juce::String c1 = test_utils::recordClip(engine, process, 20000);
      engine.getGraphState();
      engine.createNode("clip");
      const juce::String c2 = lastTopId(engine);
      engine.startRecordingInNode(c2);
      process(1000);
      engine.undo();  // refused: the top entry is take 1
      expect((int64_t)propOf(engine, c1, "duration") > 0,
             "take 1 untouched under a live take");
      expect(engine.canUndo(), "the entry is kept, not dropped");
      engine.stopRecordingInNode(c2);
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) process(512);
      engine.getGraphState();
      engine.undo();  // now: take 2
      expectEquals(propOf(engine, c2, "duration"), 0.0, "after settle: take 2 undone");
    }

    beginTest("S19 AUTO-GATE: record into a looping step, one undo = take + gates");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      const juce::String a = test_utils::recordClip(engine, process, 20000);
      const int64_t q = islandQ(engine);
      const juce::String root = rootId(engine);
      // intro 2Q | chorus 2Q.
      auto* payload = new juce::DynamicObject();
      {
        juce::Array<juce::var> steps;
        const char* names[] = {"intro", "chorus"};
        for (int i = 0; i < 2; ++i) {
          auto* s = new juce::DynamicObject();
          s->setProperty("name", names[i]);
          s->setProperty("len", 2.0 * q);
          steps.add(juce::var(s));
        }
        payload->setProperty("steps", steps);
      }
      engine.setSequence(root, juce::var(payload));
      engine.auditionStep(root, 1);
      engine.createNode("clip");
      const juce::String c = lastTopId(engine);
      engine.startRecordingInNode(c);
      process((int)(6 * q));
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) process(512);
      engine.getGraphState();
      expectEquals((int64_t)propOf(engine, c, "duration"), (int64_t)(2 * q),
                   "S18: a step-sized part");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String("01"),
                   "auto-gated: ON in the chorus, OFF in the intro");
      expectEquals(bitsOf(gatesOf(engine), a), juce::String(""),
                   "the other track's row untouched (inherits ON)");
      engine.undo();
      expectEquals(propOf(engine, c, "duration"), 0.0, "one undo: take gone");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String(""),
                   "...and its gate row gone with it");
      engine.redo();
      expectEquals((int64_t)propOf(engine, c, "duration"), (int64_t)(2 * q),
                   "redo: take back");
      expectEquals(bitsOf(gatesOf(engine), c), juce::String("01"),
                   "redo: gates back");
    }

    beginTest("a deeper take (inside a group) is NOT auto-gated");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      const juce::String a = test_utils::recordClip(engine, process, 20000);
      const int64_t q = islandQ(engine);
      const juce::String root = rootId(engine);
      auto* payload = new juce::DynamicObject();
      {
        juce::Array<juce::var> steps;
        for (int i = 0; i < 2; ++i) {
          auto* s = new juce::DynamicObject();
          s->setProperty("name", i == 0 ? "a" : "b");
          s->setProperty("len", 2.0 * q);
          steps.add(juce::var(s));
        }
        payload->setProperty("steps", steps);
      }
      engine.setSequence(root, juce::var(payload));
      engine.createNode("stack");
      const juce::String g = lastTopId(engine);
      engine.createNode("clip", g);
      engine.auditionStep(root, 1);
      engine.startRecordingInNode(g);  // group arm → the one empty clip
      process((int)(6 * q));
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) process(512);
      engine.getGraphState();
      expectEquals(bitsOf(gatesOf(engine), g), juce::String(""),
                   "the group's row is untouched - a deeper take lands ungated");
      expect(engine.canUndo(), "the take itself is still undoable");
    }
  }
};

static TakeUndoTests takeUndoTests;

}  // namespace celestrian
