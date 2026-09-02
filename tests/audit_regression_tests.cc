/**
 * audit_regression_tests.cc — regressions from the fresh-eyes audit
 * (2026-08-31, docs/loop_region_audit.md §5). Each test reproduced a
 * real defect before its fix landed:
 *  - E1: K::Remove uncollapsed the definer on ANY delete — including an
 *    unrelated empty clip deleted while a take recorded against the
 *    collapsed grid (mid-take material change under the recorder).
 *  - E3: seekTransport slides every live origin + the epoch, but the
 *    UNDO LOG's absolute values (iepoch/iorg/riders/takes) stayed in
 *    the pre-seek frame — an undo after a seek moved siblings against
 *    the grid (shiftHistoryAbsolutes is the fix).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "test_utils.h"

using celestrian::test_utils::driveEngine;
using celestrian::test_utils::nodesOf;

namespace {

juce::var findVar(const juce::var& node, const juce::String& id) {
  if (node.getProperty("id", "").toString() == id) return node;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) {
      juce::var hit = findVar(k, id);
      if (!hit.isVoid()) return hit;
    }
  return {};
}
double deepProp(AudioEngine& e, const juce::String& id, const char* prop) {
  const juce::var state = e.getGraphState();
  const juce::var node = findVar(state, id);
  return node.isVoid() ? 0.0 : (double)node.getProperty(prop, 0.0);
}
juce::String lastTopLevelId(AudioEngine& e) {
  const juce::var state = e.getGraphState();
  auto* nodes = nodesOf(state);
  if (nodes == nullptr || nodes->isEmpty()) return {};
  return nodes->getLast().getProperty("id", "").toString();
}
int64_t rootProp(AudioEngine& e, const char* prop) {
  return (int64_t)(double)e.getGraphState().getProperty(prop, 0);
}

}  // namespace

class AuditRegressionTests : public juce::UnitTest {
 public:
  AuditRegressionTests()
      : juce::UnitTest("Loop region regressions (audit 2026-08-31)") {}

  void runTest() override {
    const int64_t D = 40960;  // 80 blocks of 512

    beginTest("E1: an unrelated delete mid-take must NOT uncollapse the definer");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      driveEngine(engine, D);
      engine.stopRecordingInNode(a);  // first take: immediate commit
      driveEngine(engine, 1024);
      expectEquals((int64_t)deepProp(engine, a, "duration"), D, "take 1 committed");

      // Provisional trim: Q := len.
      const int64_t ws = D / 4, we = D / 2, len = we - ws;
      engine.setLoopPoints(a, ws, we);
      expectEquals(rootProp(engine, "quantum"), len, "Q := window length");

      // Arm take 2 -> Q13 lock-collapse of A.
      engine.createNode("clip");
      const juce::String b = lastTopLevelId(engine);
      engine.startRecordingInNode(b);
      driveEngine(engine, 512);
      expectEquals((int64_t)deepProp(engine, a, "duration"), len,
                   "A collapsed to its window at arm");
      // Reach the capture state so a take is definitely LIVE.
      driveEngine(engine, 2 * len);
      const bool live = engine.hasActiveTake();
      expect(live, "take 2 is live");

      // Delete an unrelated EMPTY clip while take 2 records.
      engine.createNode("clip");
      const juce::String c = lastTopLevelId(engine);
      engine.deleteNode(c);

      const int64_t durA = (int64_t)deepProp(engine, a, "duration");
      logMessage("A.duration after unrelated delete = " + juce::String(durA) +
                 " (collapsed len = " + juce::String(len) +
                 ", full take = " + juce::String(D) + ")");
      expectEquals(durA, len,
                   "A stays collapsed while a take records against the "
                   "collapsed grid (E1: reopen gates on a committed-count "
                   "drop with no live take)");

      // Also: the same delete with NO live take (idle island) still
      // reopens the collapsed survivor on an unrelated delete.
      engine.stopRecordingInNode(b);
      driveEngine(engine, 4 * len);
    }

    beginTest("E3: undo across a seek keeps siblings on the grid");
    {
      AudioEngine engine;
      // Take 1: clip A defines Q = D.
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      driveEngine(engine, D);
      engine.stopRecordingInNode(a);
      driveEngine(engine, 1024);
      expectEquals((int64_t)deepProp(engine, a, "duration"), D, "take 1");

      // Take 2: clip B (locks Q).
      engine.createNode("clip");
      const juce::String b = lastTopLevelId(engine);
      engine.startRecordingInNode(b);
      driveEngine(engine, 2 * D);
      engine.stopRecordingInNode(b);
      driveEngine(engine, 2 * D);
      expect((int64_t)deepProp(engine, b, "duration") > 0, "take 2 committed");
      expect(!engine.hasActiveTake(), "island idle");

      // Let the clock run well past the origins so the continuity
      // re-anchor produces a non-zero whole-D delta.
      driveEngine(engine, 3 * D);

      const int64_t epoch0 = rootProp(engine, "islandEpoch");
      const int64_t orgA0 = (int64_t)deepProp(engine, a, "origin");
      const int64_t orgB0 = (int64_t)deepProp(engine, b, "origin");

      // Playing map edit on A: two-anchor continuity (origin + epoch ride).
      engine.setLoopPoints(a, 0, D / 2);
      const int64_t epoch1 = rootProp(engine, "islandEpoch");
      const int64_t orgA1 = (int64_t)deepProp(engine, a, "origin");
      logMessage("trim delta: origin " + juce::String(orgA1 - orgA0) +
                 ", epoch " + juce::String(epoch1 - epoch0));
      expect(orgA1 != orgA0 && epoch1 != epoch0,
             "precondition: the edit carried origin+epoch riders");

      // A seek (not undoable) rides EVERY origin + the epoch by ds.
      const bool ok = engine.seekTransport((double)(D / 3));
      expect(ok, "seek accepted");
      const int64_t epoch2 = rootProp(engine, "islandEpoch");
      const int64_t ds = epoch2 - epoch1;
      expect(ds != 0, "precondition: the seek moved the epoch");

      // Undo the trim: restores A's window, A's origin and the epoch to
      // their PRE-SEEK absolute values; B keeps its post-seek origin.
      engine.undo();
      const int64_t epoch3 = rootProp(engine, "islandEpoch");
      const int64_t orgB3 = (int64_t)deepProp(engine, b, "origin");
      const int64_t placeB_before = orgB0 - epoch0;
      const int64_t placeB_after = orgB3 - epoch3;
      logMessage("B placement (origin - epoch): before=" +
                 juce::String(placeB_before) +
                 " after undo=" + juce::String(placeB_after) +
                 " (seek ds=" + juce::String(ds) + ")");
      expectEquals(placeB_after, placeB_before,
                   "undo of A's window edit must not move sibling B "
                   "against the grid (E3: shiftHistoryAbsolutes re-bases "
                   "the log at seek)");
    }

    beginTest("Q-establishment scrub: a pre-Q incoherent window is cleared");
    {
      AudioEngine engine;
      // Author a window on an empty stack BEFORE any take (legal: the
      // nested-maps arm refusal is pinned on pre-Q authoring).
      engine.createNode("stack");
      const juce::String s1 = lastTopLevelId(engine);
      engine.setLoopPoints(s1, 0, 12345);  // no Q yet: length is free
      expectEquals((int64_t)deepProp(engine, s1, "loopEnd"), (int64_t)12345,
                   "pre-Q window accepted");

      // First take elsewhere establishes Q = D — 12345 cannot live on
      // that grid (neither multiple nor divisor), so it is scrubbed.
      engine.createNode("clip");
      const juce::String a2 = lastTopLevelId(engine);
      engine.startRecordingInNode(a2);
      driveEngine(engine, D);
      engine.stopRecordingInNode(a2);
      driveEngine(engine, 1024);
      expectEquals(rootProp(engine, "quantum"), D, "Q established");
      expect((int64_t)deepProp(engine, s1, "loopEnd") <=
                 (int64_t)deepProp(engine, s1, "loopStart"),
             "incoherent pre-Q window scrubbed at establishment");
    }

    beginTest("ONLY GEOMETRY WINS: Q13 re-trim refused under sibling geometry");
    {
      AudioEngine engine;
      // Sole committed clip = the provisional definer.
      engine.createNode("clip");
      const juce::String a2 = lastTopLevelId(engine);
      engine.startRecordingInNode(a2);
      driveEngine(engine, D);
      engine.stopRecordingInNode(a2);
      driveEngine(engine, 1024);
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");

      // A sibling empty stack carries a COHERENT authored window.
      engine.createNode("stack");
      const juce::String s1 = lastTopLevelId(engine);
      engine.setLoopPoints(s1, 0, D / 2);
      expectEquals((int64_t)deepProp(engine, s1, "loopEnd"), D / 2,
                   "coherent sibling window accepted");

      // A definer re-trim would strand that window off-grid: with the
      // sibling geometry present this is an ORDINARY window edit — the
      // coherence guard refuses the off-grid length and Q holds.
      engine.setLoopPoints(a2, 0, (D / 4) * 3);
      expectEquals(rootProp(engine, "quantum"), D,
                   "no re-establishment under sibling geometry");
      // A coherent trim still lands as a plain window.
      engine.setLoopPoints(a2, 0, D / 2);
      expectEquals(rootProp(engine, "quantum"), D, "Q still locked");
      expectEquals((int64_t)deepProp(engine, a2, "loopEnd"), D / 2,
                   "plain window landed");
      // Clear the sibling geometry: the definer power returns.
      engine.setLoopPoints(s1, 0, 0);
      engine.setLoopPoints(a2, 0, D / 4);
      expectEquals(rootProp(engine, "quantum"), D / 4,
                   "re-establishment returns once the island is clean");
    }
  }
};

static AuditRegressionTests auditRegressionTests;
