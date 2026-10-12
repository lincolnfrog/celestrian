/**
 * TAKES AND COMPING (docs/takes.md). A committed clip is a SLOT —
 * one origin, one period — holding N immutable takes; a new take arms
 * at the slot's next top (t ≡ origin mod period), captures exactly one
 * period and auto-finishes; selection is an atomic pointer swap; the
 * comp names one take per Q cell and the render cuts runs at cell
 * seams. Pins:
 *
 *   (a) new take: the arm rule, the one-period cap, slot facts
 *       unchanged, silence while the take is live, render = take 1;
 *   (a') a stop before the period CANCELS: the previous take, the undo
 *       log and the slot's context cycle stand;
 *   (b) selectTake back to take 0 plays it sample-exact; undo/redo;
 *   (c) undo of a new take restores take 0 (count 1); redo re-appends;
 *   (d) deleteTake of the active falls back to a neighbour; undo brings
 *       the buffer back sample-exact (owned by the log, never freed);
 *   (e) comp [0,1,0,1] on a 4Q slot publishes its cells; undo restores
 *       the active take throughout; malformed comps are refused;
 *   (f) newTake on a GROUP arms every committed member as ONE
 *       performance (one undo step);
 *   (g) session round trip: takes, active, comp survive; a single-take
 *       bundle carries no take keys and loads as one take;
 *   (h) lock-collapse shifts the shared base for every take.
 *
 * Method: the input is a slow ramp (test_utils.h EngineRig), so every
 * captured sample encodes its arrival clock; a take captured at input
 * clock T holds content[p] = ramp(T + p), and a render decodes against
 * that with no knowledge of pan, gain or latency constants. The renders
 * of a comp's cells and of a cancelled take are scenarios S15 and S16.
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

namespace {

using celestrian::test_utils::addNode;
using celestrian::test_utils::clipOf;
using celestrian::test_utils::deepProp;
using celestrian::test_utils::EngineRig;
using celestrian::test_utils::findVar;
using celestrian::test_utils::mod;
using celestrian::test_utils::peakOf;
using celestrian::test_utils::RigInput;
using celestrian::test_utils::rootProp;

const int BLOCK = EngineRig::BLOCK;

/** Samples of `out` (its left side) that are not `expect(t)`. The ramp
 * steps 1.9e-7 a sample, so the tolerance sits under one step: a take
 * heard one sample out of place counts. */
int mismatches(const EngineRig::Heard& out,
               const std::function<float(int64_t)>& expect) {
  int bad = 0;
  for (size_t i = 0; i < out.left.size(); ++i) {
    if (std::abs(expect(out.start + (int64_t)i) - out.left[i]) > 1e-7f) ++bad;
  }
  return bad;
}

}  // namespace

class TakesTests : public juce::UnitTest {
 public:
  TakesTests() : juce::UnitTest("Takes and comping") {}

  /** Arms a new take on slot `id` (period `D`, at `origin`) from
   * mid-period, pins the arm rule and drives until it settles; answers
   * the new take's capture start (its input clock). `out` takes what
   * sounded from the arm on. */
  int64_t addTake(EngineRig& rig, const juce::String& id, int64_t D,
                  int64_t origin, EngineRig::Heard* out = nullptr) {
    rig.drive(D / 3);  // mid-period: the arm must wait
    const int64_t at_arm = rig.clock;
    rig.engine.newTake(id);
    auto* clip = clipOf(rig.engine, id);
    expect(clip != nullptr, "clip");
    rig.drive(BLOCK, out);
    expect(clip->isPendingStart(), "armed, waiting for the slot top");
    const int64_t target = clip->getAwaitingStartAt();
    expectEquals(mod(target - origin, D), (int64_t)0,
                 "arm target: t == origin (mod period)");
    expect(target > at_arm, "the NEXT top, ahead of the arm");
    rig.settle(out);
    return target;
  }

  /** One period of the slot at `origin` plays the take captured from
   * input clock `target`: ramp(target + phase), sample-exact. */
  void expectPlays(EngineRig& rig, int64_t origin, int64_t D, int64_t target,
                   const juce::String& what) {
    expectEquals(mismatches(rig.hear(D), [&](int64_t t) {
                   return EngineRig::rampAt(target + mod(t - origin, D));
                 }), 0, what);
  }

  void runTest() override {
    const int64_t D = 40000;

    beginTest("(a) new take: slot top arm, one-period cap, facts unchanged, render = take 1");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "take 0 committed");
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      auto* clip = clipOf(engine, id);
      expectEquals(clip->takeCount(), 1, "one take");
      expectEquals((int64_t)deepProp(engine, id, "takes"), (int64_t)1, "metadata: takes = 1");
      // A first clip's capture starts at its origin.
      expectPlays(rig, origin, D, origin, "take 0 renders ramp(origin + phase)");
      const int64_t base0 = clip->getContentBase();
      const int64_t ls0 = clip->getLoopStart(), le0 = clip->getLoopEnd();
      EngineRig::Heard live;
      const int64_t target1 = addTake(rig, id, D, origin, &live);
      expect(peakOf(live.left) <= 1e-9f,
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
      expectPlays(rig, origin, D, target1,
                  "render now plays take 1: ramp(target1 + phase)");
      // The take-list waveform verb sees both takes.
      const juce::var w0 = engine.getTakeWaveform(id, 0, 50);
      const juce::var w1 = engine.getTakeWaveform(id, 1, 50);
      expectEquals(w0.getArray()->size(), 50, "take 0 peaks");
      expectEquals(w1.getArray()->size(), 50, "take 1 peaks");
      // The widest gap between two 50-peak drawings.
      const auto gap = [](const juce::var& a, const juce::var& b) {
        double widest = 0.0;
        for (int i = 0; i < 50; ++i) {
          widest = std::max(widest, std::abs((double)(*a.getArray())[i] -
                                             (double)(*b.getArray())[i]));
        }
        return widest;
      };
      expect(gap(w0, w1) > 1e-6, "the two takes draw differently");
      expectEquals(engine.getTakeWaveform(id, 2, 50).getArray()->size(), 0,
                   "no take 2");
      const juce::var active = engine.getWaveform(id, 50);
      expect(active.getArray()->size() == 50 && gap(active, w1) < 1e-9,
             "getWaveform reads the ACTIVE take");
    }

    beginTest("(a') a new take stopped before its period CANCELS: the previous "
              "take, the log and the slot's context cycle stand");
    {
      // The context cycle is a SLOT fact, captured for the slot's first
      // take: a new take cancelled under a grown island cycle leaves it.
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      // The island's first take has no cycle to perform against (its
      // context cycle is 0 by construction); the SECOND clip performs
      // against the 1D cycle - that is the slot fact under test.
      rig.recordClip(D);
      const juce::String id = rig.recordClip(D);
      expectEquals((int64_t)deepProp(engine, id, "duration"), D,
                   "second clip is 1D");
      const int64_t cc = (int64_t)deepProp(engine, id, "contextCycle");
      expectEquals(cc, D, "slot context cycle captured at its first take");
      // A third, longer clip grows the heard cycle (LCM = 2D).
      const juce::String big = rig.recordClip(2 * D);
      expectEquals((int64_t)deepProp(engine, big, "duration"), 2 * D,
                   "third clip is 2D");
      auto* clip = clipOf(engine, id);
      rig.drive(D / 3);
      engine.newTake(id);
      expect(rig.driveUntilCapturing(id), "capturing");
      rig.drive(D / 2);
      engine.stopRecordingInNode(id);  // short of the period: cancels
      rig.settle();
      expectEquals(clip->takeCount(), 1, "cancelled: still one take");
      expectEquals(clip->activeTake(), 0, "take 0 active");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "duration unchanged");
      expect(clip->isPlaying(), "the slot sounds again");
      expectEquals((int64_t)deepProp(engine, id, "contextCycle"), cc,
                   "the slot's context cycle is exactly what it was");
      // Nothing was logged: the top undo entry is still the third clip's
      // take.
      engine.undo();
      expectEquals(deepProp(engine, big, "duration"), 0.0,
                   "the top entry was the third clip's take");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D,
                   "...and the slot is untouched by that undo");
    }

    beginTest("(b) selectTake back to take 0 is sample-exact; undo/redo of the selection");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      const int64_t target1 = addTake(rig, id, D, origin);
      auto* clip = clipOf(engine, id);
      engine.selectTake(id, 0);
      expectEquals(clip->activeTake(), 0, "take 0 selected");
      expectPlays(rig, origin, D, origin, "take 0 sample-exact");
      engine.undo();
      expectEquals(clip->activeTake(), 1, "undo: take 1 active again");
      expectPlays(rig, origin, D, target1, "take 1 sample-exact after undo");
      engine.redo();
      expectEquals(clip->activeTake(), 0, "redo: take 0");
      expectPlays(rig, origin, D, origin, "take 0 after redo");
      engine.selectTake(id, 5);
      expectEquals(clip->activeTake(), 0, "out of range: refused");
    }

    beginTest("(c) undo of a new take restores take 0 (count 1); redo re-appends");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      const int64_t target1 = addTake(rig, id, D, origin);
      auto* clip = clipOf(engine, id);
      engine.undo();
      expectEquals(clip->takeCount(), 1, "undo: one take");
      expectEquals(clip->activeTake(), 0, "undo: take 0 active");
      expectEquals((int64_t)deepProp(engine, id, "duration"), D, "never an empty clip");
      expectPlays(rig, origin, D, origin, "take 0 plays");
      engine.redo();
      expectEquals(clip->takeCount(), 2, "redo: two takes");
      expectEquals(clip->activeTake(), 1, "redo: take 1 active");
      expectPlays(rig, origin, D, target1, "take 1 plays after redo, bit-identical");
      engine.undo();
      expectEquals(clip->takeCount(), 1, "undo again: one take");
      engine.undo();
      expectEquals(deepProp(engine, id, "duration"), 0.0,
                   "the next entry down is take 0: the clip empties");
    }

    beginTest("(d) deleteTake of the active falls back to a neighbour; undo restores the buffer");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      const int64_t target1 = addTake(rig, id, D, origin);
      auto* clip = clipOf(engine, id);
      engine.deleteTake(id, 1);
      expectEquals(clip->takeCount(), 1, "one take left");
      expectEquals(clip->activeTake(), 0, "the neighbour became active");
      // The callback runs across the delete.
      expectPlays(rig, origin, D, origin, "take 0 plays");
      engine.deleteTake(id, 0);
      expectEquals(clip->takeCount(), 1, "the last take never deletes");
      engine.undo();
      expectEquals(clip->takeCount(), 2, "undo: take 1 is back");
      expectEquals(clip->activeTake(), 1, "...and active again");
      expectPlays(rig, origin, D, target1,
                  "the restored buffer is the same samples (owned, never freed)");
      engine.redo();
      expectEquals(clip->takeCount(), 1, "redo: deleted again");
      rig.drive(BLOCK * 4);
    }

    beginTest("(e) comp [0,1,0,1] on a 4Q slot: the cells publish; undo; refusals");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const int64_t Q = 10000;
      const juce::String c1 = rig.recordClip(Q);
      expectEquals(rootProp(engine, "quantum"), Q, "Q");
      const juce::String c2 = rig.recordClip(4 * Q);
      auto* clip = clipOf(engine, c2);
      expectEquals((int64_t)deepProp(engine, c2, "duration"), 4 * Q, "a 4Q slot");
      const int64_t origin = (int64_t)deepProp(engine, c2, "origin");
      // Only c2 shall sound: drop the Q-definer (Q survives, 2 -> 1).
      engine.deleteNode(c1);
      expectEquals(rootProp(engine, "quantum"), Q, "Q survives its creator");
      const int64_t target1 = addTake(rig, c2, 4 * Q, origin);
      expectEquals(clip->takeCount(), 2, "two takes on the slot");
      engine.setComp(c2, {0, 1, 0, 1});
      {
        const juce::var comp = findVar(engine.getGraphState(), c2)
                                   .getProperty("comp", juce::var());
        expectEquals(comp.getArray()->size(), 4, "metadata: 4 comp cells");
        expectEquals((int)(*comp.getArray())[1], 1, "cell 1 names take 1");
      }
      engine.undo();
      expect(clip->compCells().empty(), "undo: no comp");
      expectPlays(rig, origin, 4 * Q, target1, "the active take throughout");
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
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String stack_id = addNode(engine, "stack");
      const juce::String a_id = addNode(engine, "clip", stack_id);
      const juce::String b_id = addNode(engine, "clip", stack_id);
      rig.record(stack_id, D);
      const int64_t origin = (int64_t)deepProp(engine, a_id, "origin");
      auto* a = clipOf(engine, a_id);
      auto* b = clipOf(engine, b_id);
      rig.drive(D / 3);
      engine.newTake(stack_id);
      rig.drive(BLOCK);
      expect(a->isPendingStart() && b->isPendingStart(), "both members armed");
      expectEquals(a->getAwaitingStartAt(), b->getAwaitingStartAt(),
                   "one arm target for the group");
      expectEquals(mod(a->getAwaitingStartAt() - origin, D), (int64_t)0,
                   "at the slot top");
      rig.settle();
      expectEquals(a->takeCount(), 2, "A: two takes");
      expectEquals(b->takeCount(), 2, "B: two takes");
      expectEquals(a->activeTake(), 1, "A: new take active");
      expectEquals((int64_t)deepProp(engine, b_id, "origin"), origin,
                   "origins unchanged");
      engine.undo();
      expectEquals(a->takeCount(), 1, "ONE undo strips A's new take");
      expectEquals(b->takeCount(), 1, "...and B's");
      expectEquals((int64_t)deepProp(engine, a_id, "duration"), D,
                   "the group still sounds (never emptied)");
      engine.redo();
      expectEquals(a->takeCount(), 2, "redo: both back");
      expectEquals(b->takeCount(), 2, "redo: both back");
    }

    beginTest("(g) session round trip: takes, active, comp survive; a single-take bundle has no take keys");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      const int64_t origin = (int64_t)deepProp(engine, id, "origin");
      const juce::File one = celestrian::test_utils::freshTempDir("takes_one");
      expect(engine.saveSession(one.getFullPathName()), "save (one take)");
      const juce::String json = one.getChildFile("session.json").loadFileAsString();
      expect(!json.contains("\"takes\"") && !json.contains("\"comp\""),
             "no take keys on a single-take clip");
      const int64_t target1 = addTake(rig, id, D, origin);
      engine.selectTake(id, 0);
      engine.setComp(id, {1});  // one Q cell: the whole period plays take 1
      auto* clip = clipOf(engine, id);
      const juce::File dir = celestrian::test_utils::freshTempDir("takes_rt");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      expect(dir.getChildFile("audio").getChildFile(id + ".wav").existsAsFile(),
             "take 0 keeps <uuid>.wav");
      expect(dir.getChildFile("audio").getChildFile(id + ".take1.wav").existsAsFile(),
             "take 1 is <uuid>.take1.wav");

      EngineRig loaded;
      expect(loaded.engine.loadSession(dir.getFullPathName()), "load");
      auto* lc = clipOf(loaded.engine, id);
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
      // The loaded session renders the comp: take 1 throughout. The
      // loaded clip's origin is a re-derived absolute: decode by phase
      // against the capture clock.
      loaded.syncClock();
      loaded.engine.togglePlayback();
      const EngineRig::Heard out = loaded.hear(D + BLOCK);
      const int64_t lorigin = (int64_t)deepProp(loaded.engine, id, "origin");
      expectEquals(mismatches(out, [&](int64_t t) {
                     return EngineRig::rampAt(target1 + mod(t - lorigin, D));
                   }), 0, "after load the comp reads take 1 while take 0 is active");
      const auto loaded_one = std::make_unique<AudioEngine>();
      expect(loaded_one->loadSession(one.getFullPathName()), "load (one take)");
      expectEquals(clipOf(*loaded_one, id)->takeCount(), 1,
                   "a bundle with no take keys loads as one take");
      expect(clipOf(*loaded_one, id)->compCells().empty(), "...with no comp");
    }

    beginTest("(h) lock-collapse shifts the shared base for every take");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
      const int64_t origin0 = (int64_t)deepProp(engine, id, "origin");
      const int64_t target1 = addTake(rig, id, D, origin0);
      auto* clip = clipOf(engine, id);
      // Q13 re-trim of the sole definer (two takes on it), then a second
      // clip's arm collapses the slot to its window.
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      engine.setLoopPoints(id, ws, we);
      expectEquals(rootProp(engine, "quantum"), len, "Q := window length");
      const juce::String c2 = addNode(engine, "clip");
      engine.startRecordingInNode(c2);
      expectEquals(clip->getIntrinsicDuration(), len, "collapsed at the arm");
      expectEquals(clip->getContentBase(), ws,
                   "the slot's shared base = window start");
      expectEquals(clip->takeCount(), 2, "both takes kept");
      const int64_t origin1 = (int64_t)deepProp(engine, id, "origin");
      // Two passes of the window, the input silent: the take captured
      // from `target` plays its [ws, we).
      const auto playsWindow = [&](int64_t target, const char* what) {
        expectEquals(mismatches(rig.hear(2 * len, RigInput::Silence),
                                [&](int64_t t) {
                                  return EngineRig::rampAt(
                                      target + ws + mod(t - origin1, len));
                                }), 0, what);
      };
      playsWindow(target1, "take 1 plays its window [ws, we)");
      engine.stopRecordingInNode(c2);
      rig.settle();
      engine.selectTake(id, 0);
      engine.toggleMute(c2);
      rig.drive(4096, nullptr, RigInput::Silence);  // the mute ramp lands
      playsWindow(origin0, "take 0 plays its window [ws, we) too");
    }
  }
};

static TakesTests takesTests;
