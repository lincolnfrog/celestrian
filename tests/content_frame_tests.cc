/**
 * CONTENT-FRAME tests — "which buffer sample is heard" (2026-08-30).
 *
 * The engine keeps two time frames: clips read their buffers anchored
 * on the MONOTONIC clock (`(t − origin) mod dur`, kernel.md §2) while a
 * stack's window selects EPOCH-relative view positions of its cycle
 * (`t_child = epoch + mapOffset(t − epoch)`, time_maps.md §2). They
 * agree only while epoch ≡ origin (mod dur). Every gesture that moves
 * the epoch on its own therefore re-selects a windowed group's content
 * — the Q13 definer-stack re-trim solved the epoch alone (the trimmed
 * loop audibly jumped by `start` on every release — the 2026-08-29
 * "loop region shifts to a different part of the take" report), and a
 * transport seek re-based the epoch alone (plain clips did not move at
 * all; windowed groups moved). These tests pin the law that closes the
 * class: CONTENT-SELECTING FRAMES MOVE TOGETHER — a definer re-trim
 * re-anchors the members' origins with the epoch (the sole-clip path's
 * math, fractal), and a seek carries every origin by the epoch delta.
 *
 * Method: the input is a slow ramp, so every recorded sample encodes
 * its own index; one full pass BEFORE the gesture builds a table
 * `heard[idx] → output`, and the render AFTER the gesture is decoded
 * against it. No pan law, latency or gain constant needs to be known.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <map>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/heard_index.h"
#include "test_utils.h"

using celestrian::test_utils::nodesOf;

namespace {

const int BLOCK = 512;
const int64_t RAMP_P = int64_t{1} << 22;  // longer than any take here

float rampAt(int64_t clock) {
  return 0.1f + 0.8f * (float)((double)(clock % RAMP_P) / (double)RAMP_P);
}

/** Drives `total` samples of ramp input; appends (clock, left output)
 * pairs to `out` when given. `clock` is the caller's mirror of the
 * engine's monotonic transport (advances only while playing). */
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

}  // namespace

class ContentFrameTests : public juce::UnitTest {
 public:
  ContentFrameTests() : juce::UnitTest("Content frame (which sample is heard)") {}

  /** One full pass of the un-windowed take: heard[(t − origin) mod D]. */
  std::vector<float> buildTable(AudioEngine& engine, int64_t& clock,
                                int64_t origin, int64_t D) {
    std::vector<std::pair<int64_t, float>> out;
    driveRamp(engine, D + BLOCK, clock, true, &out);
    std::vector<float> table((size_t)D, -1.0f);
    for (const auto& [t, v] : out) table[(size_t)mod(t - origin, D)] = v;
    return table;
  }

  /** Decode a render against the table; returns the number of samples
   * whose heard index disagrees with `expectIdx(t)`. */
  int mismatches(const std::vector<std::pair<int64_t, float>>& out,
                 const std::vector<float>& table,
                 const std::function<int64_t(int64_t)>& expectIdx) {
    int bad = 0;
    for (const auto& [t, v] : out) {
      const float want = table[(size_t)expectIdx(t)];
      if (std::abs(want - v) > 1e-6f) ++bad;
    }
    return bad;
  }

  void runTest() override {
    const int64_t D = 40000;  // one take, under 1 s at 44.1k

    beginTest("Definer stack re-trim: the window selects BUFFER samples [start, end)");
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
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);  // first take: immediate commit
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t dur = (int64_t)deepProp(engine, ids[0], "duration");
      expectEquals(dur, D, "the whole take committed at its own length");
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      const int64_t origin0 = (int64_t)deepProp(engine, ids[0], "origin");
      // Mirror the engine clock exactly from here on.
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);

      // Trim the group to [ws, we): Q := len. Phase-preserving: the
      // sample sounding at the moment of the edit keeps sounding
      // (folded into the window), and from there the heard index
      // advances through [ws, we) — buffer coordinates, exactly what
      // the brackets over the raw take say.
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      const int64_t t0 = clock;
      const int64_t p0 = mod(t0 - origin0, D);
      const int64_t pT = ws + mod(p0 - ws, len);
      engine.setLoopPoints(stack_id, ws, we);
      expectEquals(rootProp(engine, "quantum"), len, "Q := window length");
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, 2 * len, clock, true, &out);
      const int bad = mismatches(out, table, [&](int64_t t) {
        return ws + mod(pT - ws + (t - t0), len);
      });
      expectEquals(bad, 0, "heard = buffer[ws + phase] (continuous at the edit)");

      // The published cursor agrees with the audio: masterPos is the
      // window phase, and the UI maps it to ws + phase.
      const int64_t mp = rootProp(engine, "masterPos");
      expectEquals(ws + mp, ws + mod(pT - ws + (clock - t0), len),
                   "cursor phase = heard phase");

      // A SECOND trim (left bracket moves right) must not compound: the
      // field symptom was the loop drifting by `start` per release.
      const int64_t ws2 = D / 2, we2 = (7 * D) / 8, len2 = we2 - ws2;
      const int64_t t1 = clock;
      const int64_t org1 = (int64_t)deepProp(engine, ids[0], "origin");
      // Heard index right before the second edit, by the FIRST window's law.
      const int64_t q0 = ws + mod(t1 - rootProp(engine, "islandEpoch"), len);
      juce::ignoreUnused(org1);
      const int64_t qT = ws2 + mod(q0 - ws2, len2);
      engine.setLoopPoints(stack_id, ws2, we2);
      out.clear();
      driveRamp(engine, 2 * len2, clock, true, &out);
      const int bad2 = mismatches(out, table, [&](int64_t t) {
        return ws2 + mod(qT - ws2 + (t - t1), len2);
      });
      expectEquals(bad2, 0, "second trim: still buffer coordinates, continuous");

      // Members stay one take (definer detection needs equal origins).
      expectEquals((int64_t)deepProp(engine, ids[0], "origin"),
                   (int64_t)deepProp(engine, ids[1], "origin"),
                   "members share one origin after re-anchoring");
      // Undo restores the previous frame exactly: the first window's
      // content selection comes back.
      engine.undo();
      expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), ws,
                   "undo: first window back");
      const int64_t t2 = clock;
      const int64_t r0 = ws + mod(t2 - rootProp(engine, "islandEpoch"), len);
      out.clear();
      driveRamp(engine, len, clock, true, &out);
      const int bad3 = mismatches(out, table, [&](int64_t t) {
        return ws + mod(r0 - ws + (t - t2), len);
      });
      expectEquals(bad3, 0, "after undo: window [ws, we) selects buffer [ws, we)");
    }

    beginTest("Definer stack MULTI-SEGMENT re-trim: the map selects buffer segments");
    {
      // The punch/cell twin of the window trim (audit 2026-08-30 §4.8):
      // a two-segment map on the definer stack re-establishes Q := its
      // period and — content-frame law — the members' origins ride, so
      // the segments name BUFFER material and the walk is exact.
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
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, ids[0], "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);

      celestrian::timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {5000, 15000};
      m.segs[1] = {20000, 30000};
      const int64_t P = 20000;
      engine.setSegments(stack_id, m);
      expectEquals(rootProp(engine, "quantum"), P, "Q := the map period");
      const int64_t epoch1 = rootProp(engine, "islandEpoch");
      for (const auto& id : ids) {
        // Q18: the map anchors at the stack's origin + mapOffset(0); the
        // members moved with their group (origin == the stack's).
        expectEquals((int64_t)deepProp(engine, id, "origin"),
                     epoch1 - m.segs[0].start,
                     "members' origins == stack origin == epoch - a0");
        expectEquals((int64_t)deepProp(engine, stack_id, "origin"),
                     (int64_t)deepProp(engine, id, "origin"),
                     "the stack carries the same origin");
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), D, "members whole");
      }
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, 2 * P, clock, true, &out);
      const int bad = mismatches(out, table, [&](int64_t t) {
        const int64_t h = mod(t - epoch1, P);
        return h < 10000 ? 5000 + h : 20000 + (h - 10000);
      });
      expectEquals(bad, 0, "heard walks the segments in buffer coordinates");
      // Continuity at the edit is covered by heardOffsetOf/fold; the
      // walk itself is the law being pinned here.
    }

    beginTest("Group lock-collapse is audio-neutral (take 2 arms against a trimmed group)");
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
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, ids[0], "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      engine.setLoopPoints(stack_id, ws, we);
      driveRamp(engine, len + 777, clock, true, nullptr);
      // Take 2 on a new track, SILENT input: arming collapses the group.
      engine.createNode("clip");
      const juce::String t2 = lastTopLevelId(engine);
      const int64_t tA = clock;
      const int64_t hA = ws + mod(tA - rootProp(engine, "islandEpoch"), len);
      engine.startRecordingInNode(t2);
      expectEquals((int64_t)deepProp(engine, ids[0], "duration"), len,
                   "members collapsed at arm");
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, 3 * len, clock, true, &out, /*silent=*/true);
      engine.stopRecordingInNode(t2);
      const int bad = mismatches(out, table, [&](int64_t t) {
        return ws + mod(hA - ws + (t - tA), len);
      });
      expectEquals(bad, 0, "the collapsed members still play buffer[ws + phase]");
    }

    beginTest("heard_index.h equals the render (windowed clip, windowed group)");
    {
      // THE SOLVER IS THE RENDER: every phase-preserving edit computes
      // "which sample sounds now" through heard_index.h; this pins that
      // statement against the audio thread's actual output.
      AudioEngine engine;
      int64_t clock = 0;
      // A windowed sole clip (Q13 clip trim re-anchors its origin).
      engine.createNode("clip");
      const juce::String c = lastTopLevelId(engine);
      engine.startRecordingInNode(c);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(c);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, c, "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);
      engine.setLoopPoints(c, D / 5, (4 * D) / 5);
      auto* clip = dynamic_cast<celestrian::ClipNode*>(engine.findNodeByUuidForTest(c));
      expect(clip != nullptr, "clip node");
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, D, clock, true, &out);
      int bad = 0;
      for (const auto& [t, v] : out) {
        const int64_t idx = celestrian::heard::clipHeardIndex(*clip, t);
        if (std::abs(table[(size_t)idx] - v) > 1e-6f) ++bad;
      }
      expectEquals(bad, 0, "clipHeardIndex(t) names the rendered sample");
    }
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
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, ids[0], "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);
      engine.setLoopPoints(stack_id, D / 3, (2 * D) / 3);
      auto* stack = dynamic_cast<celestrian::StackNode*>(engine.findNodeByUuidForTest(stack_id));
      auto* member = dynamic_cast<celestrian::ClipNode*>(engine.findNodeByUuidForTest(ids[0]));
      expect(stack != nullptr && member != nullptr, "nodes");
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, D, clock, true, &out);
      const int64_t epoch = rootProp(engine, "islandEpoch");
      int bad = 0;
      for (const auto& [t, v] : out) {
        const int64_t idx = celestrian::heard::memberHeardIndex(*stack, *member, t, epoch);
        if (std::abs(table[(size_t)idx] - v) > 1e-6f) ++bad;
      }
      expectEquals(bad, 0, "memberHeardIndex(t) names the rendered sample");
    }

    beginTest("Seek moves the AUDIO, not just the cursor (plain clip)");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String id = lastTopLevelId(engine);
      engine.startRecordingInNode(id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(id);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, id, "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);

      const int64_t target = D / 3;
      expect(engine.seekTransport((double)target), "seek accepted");
      const int64_t t0 = clock;
      expectEquals(rootProp(engine, "masterPos"), target, "published phase = target");
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, D, clock, true, &out);
      const int bad = mismatches(out, table, [&](int64_t t) {
        return mod(target + (t - t0), D);
      });
      expectEquals(bad, 0, "heard = buffer[target + elapsed]: the audio teleported too");
    }

    beginTest("Seek keeps a windowed group's content selection");
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
      engine.startRecordingInNode(stack_id);
      driveRamp(engine, D, clock, true, nullptr);
      engine.stopRecordingInNode(stack_id);
      driveRamp(engine, BLOCK, clock, true, nullptr);
      const int64_t origin0 = (int64_t)deepProp(engine, ids[0], "origin");
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      const std::vector<float> table = buildTable(engine, clock, origin0, D);
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      engine.setLoopPoints(stack_id, ws, we);
      driveRamp(engine, len, clock, true, nullptr);
      // Seek to window phase len/3: heard = ws + len/3 from here.
      const int64_t target = len / 3;
      expect(engine.seekTransport((double)target), "seek accepted");
      const int64_t t0 = clock;
      std::vector<std::pair<int64_t, float>> out;
      driveRamp(engine, len, clock, true, &out);
      const int bad = mismatches(out, table, [&](int64_t t) {
        return ws + mod(target + (t - t0), len);
      });
      expectEquals(bad, 0, "the window still selects buffer [ws, we); phase = target");
    }
  }
};

static ContentFrameTests contentFrameTests;
