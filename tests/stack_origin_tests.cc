/**
 * Q18 — every node has an origin (docs/composition.md).
 *
 * Render-level pins of the one anchoring law on STACKS: a group is
 * anchored at its first content's origin; its window selects inner
 * positions from that origin; an epoch-only move (a cycle-growth
 * re-base) never re-selects its content; a seek moves the group's origin
 * with the island; a one-shot group fires from its origin and rests;
 * Combine anchors at the earliest member; a session round trip keeps
 * the stack's origin. Same ramp-decoding method as
 * content_frame_tests.cc: the input is a ramp keyed by the monotonic
 * clock, so the output names which sample is heard.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <vector>

#include "../src/audio_engine.h"
#include "test_utils.h"

using celestrian::test_utils::nodesOf;

namespace {

const int BLOCK = 512;
const int64_t RAMP_P = int64_t{1} << 22;

float rampAt(int64_t clock) {
  return 0.1f + 0.8f * (float)((double)(clock % RAMP_P) / (double)RAMP_P);
}

void driveRamp(AudioEngine& engine, int64_t total, int64_t& clock,
               bool playing, std::vector<std::pair<int64_t, float>>* out,
               bool silent = false) {
  std::vector<float> in((size_t)BLOCK), l((size_t)BLOCK), r((size_t)BLOCK);
  float* ins[] = {in.data()};
  float* outs[] = {l.data(), r.data()};
  int64_t remaining = total;
  while (remaining > 0) {
    const int n = (int)std::min<int64_t>(remaining, BLOCK);
    for (int i = 0; i < n; ++i) in[(size_t)i] = silent ? 0.0f : rampAt(clock + i);
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
    if (out != nullptr)
      for (int i = 0; i < n; ++i) out->push_back({clock + i, l[(size_t)i]});
    if (playing) clock += n;
    remaining -= n;
  }
}

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
bool deepBool(AudioEngine& e, const juce::String& id, const char* prop) {
  const juce::var state = e.getGraphState();
  const juce::var node = findVar(state, id);
  return !node.isVoid() && (bool)node.getProperty(prop, false);
}
void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
  if (node.getProperty("type", "").toString() == "clip") {
    out.add(node.getProperty("id", "").toString());
    return;
  }
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) clipIdsUnder(k, out);
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
int64_t mod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

/** Drive until every id is committed (not recording, duration > 0). */
void settle(AudioEngine& engine, int64_t& clock, const juce::StringArray& ids,
            bool silent) {
  for (int i = 0; i < 400; ++i) {
    bool all = true;
    for (const auto& id : ids) {
      all = all && !deepBool(engine, id, "isRecording") &&
            deepProp(engine, id, "duration") > 0;
    }
    if (all) break;
    driveRamp(engine, BLOCK, clock, true, nullptr, silent);
  }
  driveRamp(engine, BLOCK, clock, true, nullptr, silent);
}

}  // namespace

class StackOriginTests : public juce::UnitTest {
 public:
  StackOriginTests() : juce::UnitTest("Stack origin (Q18, composition.md)") {}

  std::vector<float> buildTable(AudioEngine& engine, int64_t& clock,
                                int64_t origin, int64_t D) {
    if (D <= 0) return std::vector<float>(1, 0.0f);  // failed fixture: no crash
    std::vector<std::pair<int64_t, float>> out;
    driveRamp(engine, D + BLOCK, clock, true, &out, /*silent=*/true);
    std::vector<float> table((size_t)D, -1.0f);
    for (const auto& [t, v] : out) table[(size_t)mod(t - origin, D)] = v;
    return table;
  }

  int mismatches(const std::vector<std::pair<int64_t, float>>& out,
                 const std::vector<float>& table,
                 const std::function<int64_t(int64_t)>& expectIdx) {
    int bad = 0;
    if (table.size() <= 1) return (int)out.size();  // failed fixture
    for (const auto& [t, v] : out) {
      const float want = table[(size_t)expectIdx(t)];
      if (std::abs(want - v) > 1e-6f) ++bad;
    }
    return bad;
  }

  /** A silent Q-definer clip at the top level, then a ramp group take
   * of `take_len` samples in a fresh 2-mic stack. Returns the stack id;
   * fills `ids` with the mic ids. */
  juce::String buildIsland(AudioEngine& engine, int64_t& clock, int64_t Q,
                           int64_t take_len, juce::StringArray& ids) {
    engine.createNode("clip");
    const juce::String a = lastTopLevelId(engine);
    engine.startRecordingInNode(a);
    driveRamp(engine, Q, clock, true, nullptr, /*silent=*/true);
    engine.stopRecordingInNode(a);
    driveRamp(engine, BLOCK, clock, true, nullptr, true);
    engine.createNode("stack");
    const juce::String stack_id = lastTopLevelId(engine);
    engine.createNode("clip", stack_id);
    engine.createNode("clip", stack_id);
    {
      const juce::var s = engine.getGraphState();
      clipIdsUnder(findVar(s, stack_id), ids);
    }
    engine.startRecordingInNode(stack_id);
    // The arm lands on the next Q boundary (up to a Q away): wait for
    // capture to begin, THEN perform `take_len` samples.
    for (int i = 0; i < 100 && !deepBool(engine, ids[0], "isRecording"); ++i)
      driveRamp(engine, BLOCK, clock, true, nullptr);
    driveRamp(engine, take_len, clock, true, nullptr);
    engine.stopRecordingInNode(stack_id);
    settle(engine, clock, ids, /*silent=*/true);
    clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
    return stack_id;
  }

  void runTest() override {
    const int64_t Q = 20000;

    beginTest("The first group take anchors its group at the take's origin (undoable)");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var s = engine.getGraphState();
        clipIdsUnder(findVar(s, stack_id), ids);
      }
      expect(!deepBool(engine, stack_id, "anchored"), "empty group: unanchored");
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, Q, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);
      settle(engine, clock, ids, true);
      const int64_t origin = (int64_t)deepProp(engine, ids[0], "origin");
      expect(deepBool(engine, stack_id, "anchored"), "group anchored at commit");
      expectEquals((int64_t)deepProp(engine, stack_id, "origin"), origin,
                   "stack origin == the take's origin");
      engine.undo();  // the take
      expect(!deepBool(engine, stack_id, "anchored"), "undo un-anchors");
      engine.redo();
      expect(deepBool(engine, stack_id, "anchored"), "redo re-anchors");
      expectEquals((int64_t)deepProp(engine, stack_id, "origin"), origin,
                   "the exact stored origin comes back");
    }

    beginTest("A windowed group anchors at ITS origin: epoch re-bases and seeks never re-select content");
    {
      AudioEngine engine;
      int64_t clock = 0;
      juce::StringArray ids;
      const juce::String stack_id = buildIsland(engine, clock, Q, 2 * Q, ids);
      const int64_t D2 = (int64_t)deepProp(engine, ids[0], "duration");
      expect(D2 >= 2 * Q && D2 % Q == 0, "group take committed on the grid");
      const int64_t O = (int64_t)deepProp(engine, ids[0], "origin");
      expect(deepBool(engine, stack_id, "anchored"), "group anchored");
      expectEquals((int64_t)deepProp(engine, stack_id, "origin"), O,
                   "stack origin == members' origin");
      // Output = the two mics (the definer is silent): decode against a
      // full un-windowed pass.
      const std::vector<float> table = buildTable(engine, clock, O, D2);

      // A plain (non-definer) window on the group: inner [Q, 2Q).
      const int64_t ws = Q, we = 2 * Q, len = Q;
      const int64_t t0 = clock;
      const int64_t p0 = mod(t0 - O, D2);
      const int64_t pT = ws + mod(p0 - ws, len);
      engine.setLoopPoints(stack_id, ws, we);
      expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), ws, "window landed");
      const int64_t O1 = (int64_t)deepProp(engine, stack_id, "origin");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "origin"), O1,
                     "members moved WITH their group (no riders)");
      }
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, 2 * len, clock, true, &out, true);
      expectEquals(mismatches(out, table, [&](int64_t t) {
                     return ws + mod(pT - ws + (t - t0), len);
                   }),
                   0, "heard = buffer[ws + phase], continuous at the edit");
      // The one law, stated from the published facts: inner(t) =
      // ws + ((t − O1 − ws) mod len).
      expectEquals(mismatches(out, table, [&](int64_t t) {
                     return ws + mod(t - O1 - ws, len);
                   }),
                   0, "inner(t) = mapOffset((t - origin - a0) mod P)");

      // EPOCH-ONLY MOVE: a longer top-level take grows the cycle and
      // re-bases the island epoch by whole old cycles. Under the old
      // epoch-anchored stack law this re-tiled the window (the reason
      // epochViewStep existed); under Q18 nothing selects content by
      // the epoch, so the group keeps its material.
      const int64_t epoch_before = rootProp(engine, "islandEpoch");
      engine.createNode("clip");
      const juce::String c = lastTopLevelId(engine);
      engine.startRecordingInNode(c);
      driveRamp(engine, 4 * Q, clock, true, nullptr, true);
      engine.stopRecordingInNode(c);
      {
        juce::StringArray cid;
        cid.add(c);
        settle(engine, clock, cid, true);
      }
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      juce::ignoreUnused(epoch_before);
      expectEquals((int64_t)deepProp(engine, stack_id, "origin"), O1,
                   "a cycle-growth re-base moves the epoch only");
      out.clear();
      driveRamp(engine, 2 * len, clock, true, &out, true);
      expectEquals(mismatches(out, table, [&](int64_t t) {
                     return ws + mod(t - O1 - ws, len);
                   }),
                   0, "the window still selects buffer [ws, we)");

      // SEEK: the island phase jumps; every origin — the stack's too —
      // rides the epoch delta, so the selection is invariant.
      const int64_t e0 = rootProp(engine, "islandEpoch");
      expect(engine.seekTransport((double)(Q / 3)), "seek accepted");
      const int64_t delta = rootProp(engine, "islandEpoch") - e0;
      const int64_t O2 = (int64_t)deepProp(engine, stack_id, "origin");
      expectEquals(O2, O1 + delta, "the stack's origin rode the seek");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "origin"), O2,
                     "members rode with it");
      }
      out.clear();
      driveRamp(engine, 2 * len, clock, true, &out, true);
      expectEquals(mismatches(out, table, [&](int64_t t) {
                     return ws + mod(t - O2 - ws, len);
                   }),
                   0, "after the seek: same law, new origin");
    }

    beginTest("A one-shot GROUP fires from its origin and rests (G-2)");
    {
      AudioEngine engine;
      int64_t clock = 0;
      juce::StringArray ids;
      // Drums: a half-Q group take (commits at the Q/2 subdivision).
      const juce::String stack_id = buildIsland(engine, clock, Q, Q / 2 - 1000, ids);
      const int64_t Dd = (int64_t)deepProp(engine, ids[0], "duration");
      expectEquals(Dd, Q / 2, "drums committed at Q/2");
      const int64_t O = (int64_t)deepProp(engine, stack_id, "origin");
      expectEquals(O, (int64_t)deepProp(engine, ids[0], "origin"), "anchored at the take");
      const std::vector<float> table = buildTable(engine, clock, O, Dd);

      engine.setPeriodSource(stack_id, celestrian::PeriodSource::CONTEXT_CYCLE);
      {
        const juce::var s = engine.getGraphState();
        expect(findVar(s, stack_id).getProperty("periodSource", "").toString() ==
                   "context",
               "the knob took on a stack");
      }
      if (Dd > 0) {
      // Context cycle for the top-level scope = lcm(Q, the looping
      // definer's Q) = Q: the drums sound while (t − O) mod Q < Q/2 and
      // rest (silence through the group) otherwise.
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, 3 * Q, clock, true, &out, true);
      int bad = 0, shots = 0, rests = 0;
      for (const auto& [t, v] : out) {
        const int64_t h = mod(t - O, Q);
        if (h < Dd) {
          ++shots;
          if (std::abs(table[(size_t)h] - v) > 1e-6f) ++bad;
        } else {
          ++rests;
          if (std::abs(v) > 1e-6f) ++bad;
        }
      }
      expect(shots > 0 && rests > 0, "both regions sampled");
      expectEquals(bad, 0, "shot = the take from its origin; rest = silence");

      // Undoable (a musical fact): back to a loop.
      engine.undo();
      out.clear();
      driveRamp(engine, 2 * Dd, clock, true, &out, true);
      expectEquals(mismatches(out, table, [&](int64_t t) { return mod(t - O, Dd); }),
                   0, "undo: the group loops again");
      }
    }

    beginTest("A definer re-anchor lifts its ancestors: the outer group follows the inner definer");
    {
      // Outer stack > inner stack > 2 mics (the island's only content):
      // the inner stack is the definer; a trim re-anchors it AND the
      // outer stack (anchored because of it), so the frame every
      // ancestor measures from stays congruent with the epoch.
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("stack");
      const juce::String outer = lastTopLevelId(engine);
      engine.createNode("stack", outer);
      juce::String inner;
      {
        const juce::var s = engine.getGraphState();
        auto* kids = findVar(s, outer).getProperty("nodes", juce::var()).getArray();
        inner = kids->getReference(0).getProperty("id", "").toString();
      }
      engine.createNode("clip", inner);
      engine.createNode("clip", inner);
      juce::StringArray ids;
      {
        const juce::var s = engine.getGraphState();
        clipIdsUnder(findVar(s, inner), ids);
      }
      engine.startRecordingInNode(inner);
      driveRamp(engine, Q, clock, true, nullptr);
      engine.stopRecordingInNode(inner);
      settle(engine, clock, ids, true);
      const int64_t O = (int64_t)deepProp(engine, inner, "origin");
      expect(deepBool(engine, outer, "anchored") && deepBool(engine, inner, "anchored"),
             "both groups anchored");
      expectEquals((int64_t)deepProp(engine, outer, "origin"), O,
                   "the outer anchored at the same content");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      driveRamp(engine, 3 * BLOCK, clock, true, nullptr, true);
      const int64_t ws = Q / 4, we = (3 * Q) / 4;
      engine.setLoopPoints(inner, ws, we);
      expectEquals(rootProp(engine, "quantum"), we - ws, "the inner is the definer");
      const int64_t O1 = (int64_t)deepProp(engine, inner, "origin");
      expectEquals((int64_t)deepProp(engine, outer, "origin"), O1,
                   "the outer's origin followed the definer's shift");
      expectEquals((int64_t)deepProp(engine, ids[0], "origin"), O1,
                   "the members followed too");
      expectEquals(rootProp(engine, "islandEpoch"), O1 + ws,
                   "epoch == origin + start");
      engine.undo();
      expectEquals((int64_t)deepProp(engine, outer, "origin"), O,
                   "undo: the outer's origin is back");
      expectEquals((int64_t)deepProp(engine, inner, "origin"), O,
                   "undo: the inner's too");
    }

    beginTest("Combine anchors the new group at the earliest member's origin");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      driveRamp(engine, Q, clock, true, nullptr, true);
      engine.stopRecordingInNode(a);
      driveRamp(engine, 3 * BLOCK, clock, true, nullptr, true);
      engine.createNode("clip");
      const juce::String b = lastTopLevelId(engine);
      engine.startRecordingInNode(b);
      driveRamp(engine, Q, clock, true, nullptr, true);
      engine.stopRecordingInNode(b);
      {
        juce::StringArray bid;
        bid.add(b);
        settle(engine, clock, bid, true);
      }
      const int64_t oa = (int64_t)deepProp(engine, a, "origin");
      const int64_t ob = (int64_t)deepProp(engine, b, "origin");
      expect(ob > oa, "b was performed after a");
      const juce::String stack_id = engine.combineNodes(b, a);
      expect(stack_id.isNotEmpty(), "combined");
      expect(deepBool(engine, stack_id, "anchored"), "the new group is anchored");
      expectEquals((int64_t)deepProp(engine, stack_id, "origin"), oa,
                   "at the earliest member's origin");
      engine.undo();  // explode
      expect(findVar(engine.getGraphState(), stack_id).isVoid(), "exploded");
    }

    beginTest("A session round trip keeps the stack's origin");
    {
      AudioEngine engine;
      int64_t clock = 0;
      juce::StringArray ids;
      const juce::String stack_id = buildIsland(engine, clock, Q, Q, ids);
      const int64_t O = (int64_t)deepProp(engine, stack_id, "origin");
      const int64_t epoch = rootProp(engine, "islandEpoch");
      const juce::File dir =
          juce::File::getSpecialLocation(juce::File::tempDirectory)
              .getChildFile("celestrian_q18_" + juce::Uuid().toString());
      expect(engine.saveSession(dir.getFullPathName()), "saved");
      AudioEngine engine2;
      expect(engine2.loadSession(dir.getFullPathName()), "loaded");
      expect(deepBool(engine2, stack_id, "anchored"), "anchored after load");
      expectEquals((int64_t)deepProp(engine2, stack_id, "origin") -
                       rootProp(engine2, "islandEpoch"),
                   O - epoch, "origin - epoch (placement) survives the round trip");
      dir.deleteRecursively();
    }
  }
};

static StackOriginTests stackOriginTests;
