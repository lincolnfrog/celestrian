/**
 * TAKES AND COMPING (B4, docs/takes.md). A committed clip is a SLOT —
 * one origin, one period — holding N immutable takes; a new take arms
 * at the slot's next top (t ≡ origin mod period), captures exactly one
 * period and auto-finishes; selection is an atomic pointer swap; the
 * comp names one take per Q cell and the render cuts runs at cell
 * seams. Pins:
 *
 *   (a) new take: the arm rule, the one-period cap, slot facts
 *       unchanged, silence while the take is live, render = take 1;
 *       a stop before the period CANCELS (the previous take stands);
 *   (b) selectTake back to take 0 plays it sample-exact; undo/redo;
 *   (c) undo of a new take restores take 0 (count 1); redo re-appends;
 *   (d) deleteTake of the active falls back to a neighbour; undo brings
 *       the buffer back sample-exact (owned by the log, never freed);
 *   (e) comp [0,1,0,1] on a 4Q slot reads each cell's take, seam-exact
 *       across blocks that straddle cell boundaries; undo restores;
 *       malformed comps are refused;
 *   (f) newTake on a GROUP arms every committed member as ONE
 *       performance (one undo step);
 *   (g) session round trip: takes, active, comp survive; a single-take
 *       bundle carries no take keys and loads as one take;
 *   (h) lock-collapse shifts the shared base for every take.
 *
 * Method (tests/content_frame_tests.cc): the input is a slow ramp, so
 * every captured sample encodes its arrival clock; a take captured at
 * input clock T holds content[p] = ramp(T + p), and a render decodes
 * against that with no knowledge of pan, gain or latency constants.
 * Twin: ui/js/tests/takes_mock.test.mjs.
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <functional>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "test_utils.h"

using celestrian::test_utils::nodesOf;

namespace {

const int BLOCK = 512;
const int64_t RAMP_P = int64_t{1} << 22;

float rampAt(int64_t clock) {
  return 0.1f + 0.8f * (float)((double)(clock % RAMP_P) / (double)RAMP_P);
}

using Trace = std::vector<std::pair<int64_t, float>>;

/** Drives `total` samples of ramp (or silent) input through the real
 * callback; `clock` mirrors the transport (always playing here). */
void driveRamp(AudioEngine& engine, int64_t total, int64_t& clock,
               Trace* out = nullptr, bool silent = false) {
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
    clock += n;
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
juce::var deepVar(AudioEngine& e, const juce::String& id, const char* prop) {
  const juce::var state = e.getGraphState();
  const juce::var node = findVar(state, id);
  return node.isVoid() ? juce::var() : node.getProperty(prop, juce::var());
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
celestrian::ClipNode* clipOf(AudioEngine& e, const juce::String& id) {
  return dynamic_cast<celestrian::ClipNode*>(e.findNodeByUuidForTest(id));
}
void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
  if (node.getProperty("type", "").toString() == "clip") {
    out.add(node.getProperty("id", "").toString());
    return;
  }
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) clipIdsUnder(k, out);
}

/** Samples of `out` whose value differs from `expect(t)` by > 1e-6. */
int mismatches(const Trace& out,
               const std::function<float(int64_t)>& expect) {
  int bad = 0;
  for (const auto& [t, v] : out) {
    if (std::abs(expect(t) - v) > 1e-6f) ++bad;
  }
  return bad;
}
int nonSilent(const Trace& out) {
  int n = 0;
  for (const auto& [t, v] : out) {
    if (std::abs(v) > 1e-9f) ++n;
  }
  return n;
}

/** The first take of a fresh clip: `D` samples, an immediate commit
 * (Q := D). Returns its uuid; `clock` is re-synced to the engine. */
juce::String recordFirst(AudioEngine& engine, int64_t& clock, int64_t D,
                         const juce::String& parent = "") {
  engine.createNode("clip", parent);
  juce::String id;
  {
    const juce::var s = engine.getGraphState();
    juce::StringArray ids;
    clipIdsUnder(s, ids);
    id = ids[ids.size() - 1];
  }
  engine.startRecordingInNode(id);
  driveRamp(engine, D, clock);
  engine.stopRecordingInNode(id);
  driveRamp(engine, BLOCK, clock);
  clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
  return id;
}

/** Pump blocks until no take is live, then poll (the settle). */
void settle(AudioEngine& engine, int64_t& clock, Trace* out = nullptr) {
  for (int i = 0; i < 4000 && engine.hasActiveTake(); ++i)
    driveRamp(engine, BLOCK, clock, out);
  engine.getGraphState();
}

}  // namespace

class TakesTests : public juce::UnitTest {
 public:
  TakesTests() : juce::UnitTest("Takes and comping (B4)") {}

  /** Arm a new take on `id` with the clock MID-period (the caller
   * places it), pin the arm rule, drive until it settles; returns the
   * new take's capture start (its input clock). */
  int64_t addTake(AudioEngine& engine, int64_t& clock, const juce::String& id,
                  int64_t D, int64_t origin, Trace* out = nullptr) {
    const int64_t at_arm = clock;
    engine.newTake(id);
    auto* clip = clipOf(engine, id);
    expect(clip != nullptr, "clip");
    driveRamp(engine, BLOCK, clock, out);
    expect(clip->isPendingStart(), "armed, waiting for the slot top");
    const int64_t target = clip->getAwaitingStartAt();
    expectEquals(mod(target - origin, D), (int64_t)0,
                 "arm target: t == origin (mod period)");
    expect(target > at_arm, "the NEXT top, ahead of the arm");
    settle(engine, clock, out);
    return target;
  }

  void runTest() override {
    const int64_t D = 40000;

    beginTest("(a) new take: slot top arm, one-period cap, facts unchanged, render = take 1");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "take 0 committed");
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      const int64_t target0 = origin;  // first-clip capture starts at its origin
      auto* clip = clipOf(engine, id);
      expectEquals(clip->takeCount(), 1, "one take");
      expectEquals((int64_t)deepProp(engine, id, "takes"), (int64_t)1, "metadata: takes = 1");
      {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target0 + mod(t - origin, D));
                     }), 0, "take 0 renders ramp(target0 + phase)");
      }
      const int64_t base0 = clip->getContentBase();
      const int64_t ls0 = clip->getLoopStart(), le0 = clip->getLoopEnd();
      driveRamp(engine, D / 3, clock);  // mid-period: the arm must wait
      Trace live;
      const int64_t target1 = addTake(engine, clock, id, D, origin, &live);
      expectEquals(nonSilent(live), 0,
                   "the slot renders SILENCE while the new take is live");
      expectEquals(clip->takeCount(), 2, "two takes");
      expectEquals(clip->activeTake(), 1, "the new take is active");
      expectEquals((int64_t)deepProp(engine, id, "takes"), (int64_t)2, "metadata: takes = 2");
      expectEquals((int64_t)deepProp(engine, id, "activeTake"), (int64_t)1, "metadata: activeTake");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "duration unchanged");
      expectEquals((int64_t)deepProp(engine, id, "origin"), origin, "origin unchanged");
      expectEquals(clip->getContentBase(), base0, "base unchanged");
      expectEquals(clip->getLoopStart(), ls0, "loop start unchanged");
      expectEquals(clip->getLoopEnd(), le0, "loop end unchanged");
      expectEquals(rootProp(engine, "quantum"), D, "Q unchanged");
      expect(!engine.hasPendingTakes(), "settled into the log");
      {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target1 + mod(t - origin, D));
                     }), 0, "render now plays take 1: ramp(target1 + phase)");
      }
      // The take-list waveform verb sees both takes.
      const juce::var w0 = engine.getTakeWaveform(id, 0, 50);
      const juce::var w1 = engine.getTakeWaveform(id, 1, 50);
      expectEquals(w0.getArray()->size(), 50, "take 0 peaks");
      expectEquals(w1.getArray()->size(), 50, "take 1 peaks");
      bool differ = false;
      for (int i = 0; i < 50; ++i)
        if (std::abs((double)(*w0.getArray())[i] - (double)(*w1.getArray())[i]) > 1e-6)
          differ = true;
      expect(differ, "the two takes draw differently");
      expectEquals(engine.getTakeWaveform(id, 2, 50).getArray()->size(), 0,
                   "no take 2");
      {
        const juce::var active = engine.getWaveform(id, 50);
        bool same = active.getArray()->size() == 50;
        for (int i = 0; same && i < 50; ++i)
          same = std::abs((double)(*active.getArray())[i] -
                          (double)(*w1.getArray())[i]) < 1e-9;
        expect(same, "getWaveform reads the ACTIVE take");
      }
    }

    beginTest("(a) new take stopped before its period CANCELS: the previous take stands");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      engine.getGraphState();
      auto* clip = clipOf(engine, id);
      driveRamp(engine, D / 3, clock);
      engine.newTake(id);
      // Reach capture, then stop half way through the period.
      for (int i = 0; i < 400 && !clip->isRecording(); ++i) driveRamp(engine, BLOCK, clock);
      expect(clip->isRecording(), "capturing");
      driveRamp(engine, D / 2, clock);
      engine.stopRecordingInNode(id);
      settle(engine, clock);
      expectEquals(clip->takeCount(), 1, "cancelled: still one take");
      expectEquals(clip->activeTake(), 0, "take 0 active");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "duration unchanged");
      expect(clip->isPlaying(), "the slot sounds again");
      Trace out;
      driveRamp(engine, D, clock, &out);
      expectEquals(mismatches(out, [&](int64_t t) {
                     return rampAt(origin + mod(t - origin, D));
                   }), 0, "take 0 plays again, sample-exact");
      // Nothing was logged: the top undo entry is still take 0 itself.
      engine.undo();
      expectEquals(deepProp(engine, id, "duration"), 0.0,
                   "the only entry above the clip creation was take 0");
    }

    beginTest("(b) selectTake back to take 0 is sample-exact; undo/redo of the selection");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      driveRamp(engine, D / 3, clock);
      const int64_t target1 = addTake(engine, clock, id, D, origin);
      auto* clip = clipOf(engine, id);
      auto plays = [&](int64_t target, const char* what) {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target + mod(t - origin, D));
                     }), 0, what);
      };
      engine.selectTake(id, 0);
      expectEquals(clip->activeTake(), 0, "take 0 selected");
      plays(origin, "take 0 sample-exact");
      engine.undo();
      expectEquals(clip->activeTake(), 1, "undo: take 1 active again");
      plays(target1, "take 1 sample-exact after undo");
      engine.redo();
      expectEquals(clip->activeTake(), 0, "redo: take 0");
      plays(origin, "take 0 after redo");
      engine.selectTake(id, 5);
      expectEquals(clip->activeTake(), 0, "out of range: refused");
    }

    beginTest("(c) undo of a new take restores take 0 (count 1); redo re-appends");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      driveRamp(engine, D / 3, clock);
      const int64_t target1 = addTake(engine, clock, id, D, origin);
      auto* clip = clipOf(engine, id);
      engine.undo();
      expectEquals(clip->takeCount(), 1, "undo: one take");
      expectEquals(clip->activeTake(), 0, "undo: take 0 active");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "never an empty clip");
      {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(origin + mod(t - origin, D));
                     }), 0, "take 0 plays");
      }
      engine.redo();
      expectEquals(clip->takeCount(), 2, "redo: two takes");
      expectEquals(clip->activeTake(), 1, "redo: take 1 active");
      {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target1 + mod(t - origin, D));
                     }), 0, "take 1 plays after redo, bit-identical");
      }
      engine.undo();
      expectEquals(clip->takeCount(), 1, "undo again: one take");
      engine.undo();
      expectEquals(deepProp(engine, id, "duration"), 0.0,
                   "the next entry down is take 0: the clip empties");
    }

    beginTest("(d) deleteTake of the active falls back to a neighbour; undo restores the buffer");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      driveRamp(engine, D / 3, clock);
      const int64_t target1 = addTake(engine, clock, id, D, origin);
      auto* clip = clipOf(engine, id);
      engine.deleteTake(id, 1);
      expectEquals(clip->takeCount(), 1, "one take left");
      expectEquals(clip->activeTake(), 0, "the neighbour became active");
      {
        Trace out;  // the callback runs across the delete
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(origin + mod(t - origin, D));
                     }), 0, "take 0 plays");
      }
      engine.deleteTake(id, 0);
      expectEquals(clip->takeCount(), 1, "the last take never deletes");
      engine.undo();
      expectEquals(clip->takeCount(), 2, "undo: take 1 is back");
      expectEquals(clip->activeTake(), 1, "...and active again");
      {
        Trace out;
        driveRamp(engine, D, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target1 + mod(t - origin, D));
                     }), 0, "the restored buffer is the same samples (owned, never freed)");
      }
      engine.redo();
      expectEquals(clip->takeCount(), 1, "redo: deleted again");
      driveRamp(engine, BLOCK * 4, clock);
    }

    beginTest("(e) comp [0,1,0,1] on a 4Q slot: per-cell takes, seam-exact; undo; refusals");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const int64_t Q = 10000;
      const juce::String c1 = recordFirst(engine, clock, Q);
      expectEquals(rootProp(engine, "quantum"), Q, "Q");
      // A 4Q slot: arm at the next boundary, stop just short of 4Q so
      // the stop pads forward to exactly 4Q.
      engine.createNode("clip");
      const juce::String c2 = lastTopLevelId(engine);
      auto* clip = clipOf(engine, c2);
      engine.startRecordingInNode(c2);
      for (int i = 0; i < 400 && !clip->isRecording(); ++i) driveRamp(engine, BLOCK, clock);
      expect(clip->isRecording(), "capturing");
      driveRamp(engine, 4 * Q - 2048, clock);
      engine.stopRecordingInNode(c2);
      settle(engine, clock);
      expectEquals((int64_t)deepProp(engine, c2, "duration"), 4 * Q, "a 4Q slot");
      const int64_t origin = (int64_t)deepProp(engine, c2, "origin");
      // Only c2 shall sound: drop the Q-definer (Q survives, 2 -> 1).
      engine.deleteNode(c1);
      expectEquals(rootProp(engine, "quantum"), Q, "Q survives its creator");
      driveRamp(engine, Q / 3, clock);
      const int64_t target1 = addTake(engine, clock, c2, 4 * Q, origin);
      expectEquals(clip->takeCount(), 2, "two takes on the slot");
      engine.setComp(c2, {0, 1, 0, 1});
      {
        const juce::var comp = deepVar(engine, c2, "comp");
        expectEquals(comp.getArray()->size(), 4, "metadata: 4 comp cells");
        expectEquals((int)(*comp.getArray())[1], 1, "cell 1 names take 1");
      }
      const int64_t targets[2] = {origin, target1};
      const int cells[4] = {0, 1, 0, 1};
      {
        Trace out;
        driveRamp(engine, 8 * Q, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       const int64_t p = mod(t - origin, 4 * Q);
                       return rampAt(targets[cells[p / Q]] + p);
                     }), 0, "each cell reads its take; runs cut at cell seams (Q is not a block multiple)");
      }
      engine.undo();
      expect(clip->compCells().empty(), "undo: no comp");
      {
        Trace out;
        driveRamp(engine, 4 * Q, clock, &out);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target1 + mod(t - origin, 4 * Q));
                     }), 0, "the active take throughout");
      }
      engine.redo();
      expectEquals((int)clip->compCells().size(), 4, "redo: comp back");
      engine.setComp(c2, {0, 1, 0});
      expectEquals((int)clip->compCells().size(), 4, "wrong cell count refused");
      engine.setComp(c2, {0, 1, 0, 7});
      expectEquals(clip->compCells()[3], 1, "out-of-range take refused");
      engine.setComp(c2, {});
      expect(clip->compCells().empty(), "an empty comp clears");
      // Deleting a comped take renumbers the cells; undo restores them.
      engine.setComp(c2, {1, 0, 1, 0});
      engine.deleteTake(c2, 0);
      expectEquals(clip->takeCount(), 1, "take 0 removed");
      // One read: begin()/end() must come from the SAME vector.
      const std::vector<int> after_delete = clip->compCells();
      expect(after_delete.empty() ||
                 std::all_of(after_delete.begin(), after_delete.end(),
                             [](int c) { return c <= 0; }),
             "cells never name a missing take");
      engine.undo();
      expectEquals(clip->takeCount(), 2, "undo: back");
      expectEquals(clip->compCells()[0], 1, "undo: the comp is back");
    }

    beginTest("(f) newTake on a GROUP arms every committed member as one performance");
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
      driveRamp(engine, D, clock);
      engine.stopRecordingInNode(stack_id);
      driveRamp(engine, BLOCK, clock);
      clock = rootProp(engine, "islandPos") + rootProp(engine, "islandEpoch");
      engine.getGraphState();
      const int64_t origin = (int64_t)deepProp(engine, ids[0], "origin");
      auto* a = clipOf(engine, ids[0]);
      auto* b = clipOf(engine, ids[1]);
      driveRamp(engine, D / 3, clock);
      engine.newTake(stack_id);
      driveRamp(engine, BLOCK, clock);
      expect(a->isPendingStart() && b->isPendingStart(), "both members armed");
      expectEquals(a->getAwaitingStartAt(), b->getAwaitingStartAt(),
                   "one arm target for the group");
      expectEquals(mod(a->getAwaitingStartAt() - origin, D), (int64_t)0,
                   "at the slot top");
      settle(engine, clock);
      expectEquals(a->takeCount(), 2, "A: two takes");
      expectEquals(b->takeCount(), 2, "B: two takes");
      expectEquals(a->activeTake(), 1, "A: new take active");
      expectEquals((int64_t)deepProp(engine, ids[1], "origin"), origin,
                   "origins unchanged");
      engine.undo();
      expectEquals(a->takeCount(), 1, "ONE undo strips A's new take");
      expectEquals(b->takeCount(), 1, "...and B's");
      expectEquals((int64_t)deepProp(engine, ids[0], "duration"), D,
                   "the group still sounds (never emptied)");
      engine.redo();
      expectEquals(a->takeCount(), 2, "redo: both back");
      expectEquals(b->takeCount(), 2, "redo: both back");
    }

    beginTest("(g) session round trip: takes, active, comp survive; a single-take bundle has no take keys");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      // A single-take bundle is exactly what shipped before takes.
      const juce::File one = celestrian::test_utils::freshTempDir("takes_one");
      expect(engine.saveSession(one.getFullPathName()), "save (one take)");
      const juce::String json = one.getChildFile("session.json").loadFileAsString();
      expect(!json.contains("\"takes\"") && !json.contains("\"comp\""),
             "no take keys on a single-take clip");
      driveRamp(engine, D / 3, clock);
      const int64_t target1 = addTake(engine, clock, id, D, origin);
      engine.selectTake(id, 0);
      engine.setComp(id, {1});  // one Q cell: the whole period plays take 1
      auto* clip = clipOf(engine, id);
      const juce::File dir = celestrian::test_utils::freshTempDir("takes_rt");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      expect(dir.getChildFile("audio").getChildFile(id + ".wav").existsAsFile(),
             "take 0 keeps <uuid>.wav");
      expect(dir.getChildFile("audio").getChildFile(id + ".take1.wav").existsAsFile(),
             "take 1 is <uuid>.take1.wav");

      AudioEngine loaded;
      expect(loaded.loadSession(dir.getFullPathName()), "load");
      auto* lc = clipOf(loaded, id);
      expect(lc != nullptr, "the clip is back");
      expectEquals(lc->takeCount(), 2, "two takes");
      expectEquals(lc->activeTake(), 0, "active take restored");
      expectEquals((int)lc->compCells().size(), 1, "comp restored");
      expectEquals(lc->compCells()[0], 1, "comp cell restored");
      for (int k = 0; k < 2; ++k) {
        const auto* src = clip->takeBuffer(k);
        const auto* dst = lc->takeBuffer(k);
        float err = 0.0f;
        for (int i = 0; i < (int)D; ++i)
          err = std::max(err, std::abs(src->getSample(0, i) - dst->getSample(0, i)));
        expect(err < 1e-6f, "take " + juce::String(k) + " audio round-trips");
      }
      // The loaded session renders the comp: take 1 throughout.
      int64_t lclock = rootProp(loaded, "islandPos") + rootProp(loaded, "islandEpoch");
      loaded.togglePlayback();
      Trace out;
      driveRamp(loaded, D + BLOCK, lclock, &out);
      const int64_t lorigin = (int64_t)deepProp(loaded, id, "origin");
      int bad = 0;
      for (const auto& [t, v] : out) {
        // The loaded clip's origin is a re-derived absolute; decode by
        // phase against the ORIGINAL capture clock through its content.
        const int64_t p = mod(t - lorigin, D);
        if (std::abs(rampAt(target1 + p) - v) > 1e-6f) ++bad;
      }
      expectEquals(bad, 0, "after load the comp reads take 1 while take 0 is active");
      AudioEngine loaded_one;
      expect(loaded_one.loadSession(one.getFullPathName()), "load (one take)");
      expectEquals(clipOf(loaded_one, id)->takeCount(), 1, "a pre-takes bundle loads as one take");
      expect(clipOf(loaded_one, id)->compCells().empty(), "...with no comp");
    }

    beginTest("(h) lock-collapse shifts the shared base for every take");
    {
      AudioEngine engine;
      int64_t clock = 0;
      const juce::String id = recordFirst(engine, clock, D);
      const int64_t origin0 = (int64_t)deepProp(engine, id, "origin");
      driveRamp(engine, D / 3, clock);
      const int64_t target1 = addTake(engine, clock, id, D, origin0);
      auto* clip = clipOf(engine, id);
      // Q13 re-trim of the sole definer (two takes on it), then a second
      // clip's arm collapses the slot to its window.
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      engine.setLoopPoints(id, ws, we);
      expectEquals(rootProp(engine, "quantum"), len, "Q := window length");
      engine.createNode("clip");
      const juce::String c2 = lastTopLevelId(engine);
      engine.startRecordingInNode(c2);
      expectEquals(clip->getIntrinsicDuration(), len, "collapsed at the arm");
      expectEquals(clip->takeBase(0), ws, "take 0 base = window start");
      expectEquals(clip->takeBase(1), ws, "take 1 base = window start (same shift)");
      expectEquals(clip->takeCount(), 2, "both takes kept");
      const int64_t origin1 = (int64_t)deepProp(engine, id, "origin");
      {
        Trace out;
        driveRamp(engine, 2 * len, clock, &out, /*silent=*/true);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(target1 + ws + mod(t - origin1, len));
                     }), 0, "take 1 plays its window [ws, we)");
      }
      engine.stopRecordingInNode(c2);
      settle(engine, clock);
      engine.selectTake(id, 0);
      engine.toggleMute(c2);
      driveRamp(engine, 4096, clock, nullptr, true);  // the mute ramp lands
      {
        Trace out;
        driveRamp(engine, 2 * len, clock, &out, /*silent=*/true);
        expectEquals(mismatches(out, [&](int64_t t) {
                       return rampAt(origin0 + ws + mod(t - origin1, len));
                     }), 0, "take 0 plays its window [ws, we) too");
      }
    }
  }
};

static TakesTests takesTests;
