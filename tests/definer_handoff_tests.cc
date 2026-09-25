/**
 * THE Q HAND-OFF (Q22, design_language.md §5): `setDefiner(uuid)` makes
 * another track the island's Q-definer. Pinned with the worked example
 * of the owner's story, relative to the keys' origin (k0):
 *
 *   keys  — the first take, 1000 samples: Q = 1000, zero = k0;
 *   drums — recorded over five keys passes: origin k0 + 2000, 5000.
 *
 *   setDefiner(drums)            → Q 5000, zero k0 + 2000, nothing moves;
 *   setLoopPoints(drums, 700, 3100) → Q 2400, zero k0 + 2700, the drums'
 *                                  origin STAYS k0 + 2000; the keys DRIFT
 *                                  (island cycle 2400, not lcm 12000);
 *   arm a new track              → the drums lock-collapse to [700, 3100)
 *                                  and the designation clears;
 *   undo walks it all back.
 *
 * Driven through the real engine with the scenario harness's ramp input
 * (tests/scenario_utils.h): every committed sample encodes its capture
 * clock, so each render is checked against the analytic law.
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/period_law.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::posmod;
using scenario::rampAt;

namespace {

/** A clip's render facts, read once (the expectation lambdas run per
 * sample): origin, duration, single window, content base. */
struct ClipFacts {
  int64_t origin = 0, dur = 0, ls = 0, le = 0, base = 0;
};

ClipFacts clipFacts(Island& is, const juce::String& id) {
  ClipFacts f;
  if (auto* c = dynamic_cast<ClipNode*>(is.nodePtr(id))) {
    f.origin = c->origin_samples.load();
    f.dur = c->getIntrinsicDuration();
    if (c->isLoopWindowActive() && c->getLoopEnd() > c->getLoopStart()) {
      f.ls = c->getLoopStart();
      f.le = c->getLoopEnd();
    }
    f.base = c->getContentBase();
  }
  return f;
}

/** THE CLIP RENDER LAW: a window [ls, le) anchors at origin + ls and
 * folds on its length; with none the take folds whole from its origin.
 * Content index k of the take reads buffer position base + k, which the
 * ramp captured at captured + base + k. */
float clipLaw(Island& is, const juce::String& id, const ClipFacts& f, int64_t t) {
  const bool win = f.le > f.ls;
  const int64_t start = win ? f.ls : 0;
  const int64_t len = win ? f.le - f.ls : f.dur;
  const int64_t k = start + posmod(t - f.origin - start, len);
  return rampAt(is.captured.at(id) + f.base + k);
}

juce::String definerId(Island& is) {
  return is.state().getProperty("definerId", "").toString();
}

StackNode* rootOf(Island& is) {
  return dynamic_cast<StackNode*>(is.nodePtr(is.rootId()));
}

/** Drive `span` samples and count those whose output differs from the
 * sum of the named clips' render laws, facts read NOW. */
int lawMismatches(Island& is, const juce::StringArray& ids, int64_t span) {
  std::vector<ClipFacts> facts;
  for (const auto& id : ids) facts.push_back(clipFacts(is, id));
  return is.mismatches(span, [&](int64_t t) {
    float s = 0.0f;
    for (int i = 0; i < ids.size(); ++i) s += clipLaw(is, ids[i], facts[(size_t)i], t);
    return s;
  });
}

/** THE OWNER'S STORY up to the hand-off: keys (1000, the first take),
 * then drums (5000) armed two keys passes on — origin k0 + 2000. */
struct Story {
  Island is;
  juce::String keys, drums;
  int64_t k0 = 0;
  void build() {
    keys = is.record(1000);
    k0 = is.origin(keys);
    is.driveToPhase(0);  // the next block crosses k0 + 2000
    drums = is.record(5000);
  }
};

}  // namespace

class DefinerHandoffTests : public juce::UnitTest {
 public:
  DefinerHandoffTests() : juce::UnitTest("Q hand-off (Q22, setDefiner)", "Definer") {}

  /** The worked example's starting facts; false (with failures logged)
   * when the harness did not reproduce them. */
  bool storyHolds(Story& s) {
    auto& is = s.is;
    expectEquals(is.Q(), (int64_t)1000, "the keys define Q = 1000");
    expectEquals(is.zero(), s.k0, "zero = the keys' origin");
    expectEquals(is.dur(s.keys), (int64_t)1000, "keys: 1000");
    expectEquals(is.origin(s.drums) - s.k0, (int64_t)2000, "drums: origin k0 + 2000");
    expectEquals(is.dur(s.drums), (int64_t)5000, "drums: 5000 (five keys passes)");
    expectEquals(definerId(is), juce::String(), "two takes: no definer");
    return is.Q() == 1000 && is.origin(s.drums) - s.k0 == 2000 &&
           is.dur(s.drums) == 5000 && is.dur(s.keys) == 1000;
  }

  void runTest() override {
    // ------------------------------------------------------------------
    beginTest("hand-off: sound-neutral; Q := the drums' period, zero := their "
              "origin, definerId = drums; one undo restores all three");
    {
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      const juce::StringArray both{s.keys, s.drums};
      expectEquals(lawMismatches(is, both, 6000), 0, "before: both play as recorded");
      expectEquals(is.cycle(), (int64_t)5000, "the island cycles on 5000");

      // One island cycle before and one after, a whole cycle apart: the
      // island is 5000-periodic, so an untouched render is identical.
      std::vector<std::pair<int64_t, float>> before, after;
      is.drive(5000, &before);
      is.engine.setDefiner(s.drums);
      expectEquals(is.Q(), (int64_t)5000, "Q := the drums' own period");
      expectEquals(is.zero(), s.k0 + 2000, "zero := the drums' origin");
      expectEquals(definerId(is), s.drums, "the drums define Q");
      expectEquals(rootOf(is)->definerDesignation(), s.drums, "the designation is stored");
      expectEquals(is.origin(s.keys), s.k0, "the keys did not move");
      expectEquals(is.origin(s.drums), s.k0 + 2000, "the drums did not move");
      expectEquals(is.cycle(), (int64_t)5000, "keys 1000 = Q/5: coherent, cycle 5000");
      is.drive(5000, &after);
      int differ = 0;
      for (size_t i = 0; i < before.size() && i < after.size(); ++i) {
        if (after[i].first != before[i].first + 5000 ||
            after[i].second != before[i].second) {
          ++differ;
        }
      }
      expectEquals(before.size(), after.size(), "equal spans");
      expectEquals(differ, 0, "the output is sample-identical across the hand-off");
      expectEquals(lawMismatches(is, both, 6000), 0, "after: both play as recorded");

      is.engine.undo();
      expectEquals(is.Q(), (int64_t)1000, "undo: Q back to the keys'");
      expectEquals(is.zero(), s.k0, "undo: zero back to the keys'");
      expectEquals(definerId(is), juce::String(), "undo: no definer");
      expectEquals(rootOf(is)->definerDesignation(), juce::String(), "undo: no designation");
      is.engine.redo();
      expectEquals(is.Q(), (int64_t)5000, "redo: Q 5000");
      expectEquals(definerId(is), s.drums, "redo: the drums define Q");
    }

    // ------------------------------------------------------------------
    beginTest("the designated definer's trim re-grids (Q, zero) and KEEPS its "
              "origin; the coherence guard lets it through; the keys drift "
              "(cycle = Q, not the lcm) and still play as recorded");
    {
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      is.engine.setDefiner(s.drums);
      const int64_t d0 = is.origin(s.drums);
      // 2400 is neither a multiple nor a divisor of Q = 5000: any other
      // window would be refused.
      is.engine.setLoopPoints(s.drums, 700, 3100);
      expectEquals(is.iprop(s.drums, "loopStart"), (int64_t)700, "the trim landed");
      expectEquals(is.iprop(s.drums, "loopEnd"), (int64_t)3100, "...");
      expectEquals(is.Q(), (int64_t)2400, "Q := the window length");
      expectEquals(is.zero(), d0 + 700, "zero := origin + window start (k0 + 2700)");
      expectEquals(is.origin(s.drums), d0, "the drums' origin STAYS (no re-anchor)");
      expectEquals(definerId(is), s.drums, "still the definer");
      expectEquals(is.cycle(), (int64_t)2400, "the keys drift: cycle 2400, not lcm 12000");
      {
        const period_law::TreeProvider tp{is.Q()};
        expect(period_law::drifts(tp, is.nodePtr(s.keys)), "the keys drift against 2400");
        expect(!period_law::drifts(tp, is.nodePtr(s.drums)), "the definer does not");
      }
      // The engine's own cycle (the snapshot provider): the published
      // cursor wraps on 2400.
      int64_t max_master = 0;
      for (int i = 0; i < 12; ++i) {
        is.drive(512);
        max_master = std::max(max_master, is.masterPos());
      }
      expect(max_master < 2400 && max_master > 1800,
             "masterPos wraps on the 2400 cycle (max " + juce::String(max_master) + ")");
      // keys: content[(t − k0) mod 1000]; drums: content[700 + ((t − d0 −
      // 700) mod 2400)].
      expectEquals(lawMismatches(is, {s.keys, s.drums}, 12000), 0,
                   "keys as recorded; drums loop their window from their origin");
      {
        const ClipFacts k = clipFacts(is, s.keys);
        const ClipFacts d = clipFacts(is, s.drums);
        expectEquals(k.origin, s.k0, "keys untouched");
        expect(d.ls == 700 && d.le == 3100 && d.origin == d0, "drums window at origin");
      }
      // The guard still judges everyone else.
      is.engine.setLoopPoints(s.keys, 0, 700);
      expectEquals(is.iprop(s.keys, "loopEnd"), (int64_t)0,
                   "a 700 window on the keys is refused (incoherent with 2400)");
      // A cell map on the definer keeps the origin too: Q := its period,
      // zero := origin + a0.
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {700, 1900};
      cells.segs[1] = {2500, 3700};
      is.engine.setSegments(s.drums, cells);
      expectEquals(is.Q(), (int64_t)2400, "cells: Q := the map period");
      expectEquals(is.zero(), d0 + 700, "cells: zero := origin + a0");
      expectEquals(is.origin(s.drums), d0, "cells: the origin stays");
      // Clearing the window restores the whole take as the grid.
      is.engine.setLoopPoints(s.drums, 0, 0);
      expectEquals(is.Q(), (int64_t)5000, "clear: Q := D");
      expectEquals(is.zero(), d0, "clear: zero := origin");
      is.engine.undo();  // the clear
      is.engine.undo();  // the cells
      expectEquals(is.Q(), (int64_t)2400, "undo walks back to the trim");
      is.engine.undo();  // the trim
      expectEquals(is.Q(), (int64_t)5000, "undo: the hand-off's grid");
      expectEquals(is.zero(), d0, "...and zero");
      is.engine.undo();  // the hand-off
      expectEquals(is.Q(), (int64_t)1000, "undo: the keys' grid");
      expectEquals(is.zero(), s.k0, "...and zero");
      expectEquals(definerId(is), juce::String(), "no definer");
    }

    // ------------------------------------------------------------------
    beginTest("refusals: no Q, root, unknown, empty clip, one-shot, not one "
              "take, under a window / song / one-shot, live take, identity - "
              "nothing is recorded");
    {
      {
        Island is;
        const juce::String c = is.createClip();
        is.engine.setDefiner(c);
        expectEquals(rootOf(is)->definerDesignation(), juce::String(), "no Q: refused");
        is.engine.undo();  // the create: nothing else was logged
        expect(is.nodePtr(c) == nullptr, "no Q: nothing recorded");
      }
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      // Each refusal below leaves the grid, the designation and the log
      // as they were: the last logged edit is the drums' take, so one
      // undo at the end still removes exactly it.
      auto unchanged = [&](const juce::String& what) {
        expectEquals(is.Q(), (int64_t)1000, what + ": Q unchanged");
        expectEquals(is.zero(), s.k0, what + ": zero unchanged");
        expectEquals(rootOf(is)->definerDesignation(), juce::String(),
                     what + ": no designation");
      };
      is.engine.setDefiner(is.rootId());
      unchanged("the root");
      is.engine.setDefiner("no-such-node");
      unchanged("an unknown uuid");
      const juce::String empty = is.createClip();
      is.engine.setDefiner(empty);
      unchanged("an empty clip");
      is.engine.undo();  // the empty clip

      // A one-shot reads its period from context (Q5).
      is.engine.setPeriodSource(s.drums, PeriodSource::CONTEXT_CYCLE);
      is.engine.setDefiner(s.drums);
      unchanged("a one-shot");
      is.engine.undo();

      // A stack that is not one take: two takes of different lengths.
      is.driveToPhase(0);
      const juce::String g = is.createStack();
      is.record(1000, g);
      is.driveToPhase(0);
      is.record(2000, g);
      is.engine.setDefiner(g);
      unchanged("a stack of two takes");

      // A clip under a windowed group, a sequenced group, a one-shot group.
      const juce::StringArray members = is.childIds(g);
      const juce::String inner = members[1];  // the 2000 take
      is.engine.setLoopPoints(g, 0, 1000);
      is.engine.setDefiner(inner);
      unchanged("a clip under a windowed group");
      is.engine.undo();
      {
        juce::DynamicObject::Ptr step = new juce::DynamicObject();
        step->setProperty("name", "A");
        step->setProperty("len", 2000.0);
        juce::Array<juce::var> steps;
        steps.add(juce::var(step.get()));
        juce::DynamicObject::Ptr payload = new juce::DynamicObject();
        payload->setProperty("steps", steps);
        is.engine.setSequence(g, juce::var(payload.get()));
      }
      is.engine.setDefiner(inner);
      unchanged("a clip under a sequenced group");
      is.engine.undo();
      is.engine.setPeriodSource(g, PeriodSource::CONTEXT_CYCLE);
      is.engine.setDefiner(inner);
      unchanged("a clip under a one-shot group");
      is.engine.undo();
      // With the warp gone the same clip is a valid target.
      is.engine.setDefiner(inner);
      expectEquals(definerId(is), inner, "the unwarped clip takes Q");
      expectEquals(is.Q(), (int64_t)2000, "...its period");
      is.engine.undo();
      unchanged("the undone hand-off");

      // Under a live take.
      const juce::String hot = is.createClip();
      is.engine.startRecordingInNode(hot);
      expect(is.engine.hasActiveTake(), "a take is armed");
      is.engine.setDefiner(s.drums);
      is.engine.stopRecordingInNode(hot);  // cancelled before capture
      is.settle();
      unchanged("a live take");

      // Identity: the node that already is the definer.
      is.engine.setDefiner(s.drums);
      expectEquals(definerId(is), s.drums, "handed to the drums");
      is.engine.setDefiner(s.drums);  // identity: records nothing
      is.engine.undo();               // so this undoes the first hand-off
      unchanged("identity");
      // The derived Q13 definer is the definer too: a sole clip.
      Island solo;
      const juce::String only = solo.record(1000);
      expectEquals(definerId(solo), only, "the sole take is the Q13 definer");
      solo.engine.setDefiner(only);
      expectEquals(rootOf(solo)->definerDesignation(), juce::String(),
                   "identity with the derived definer: refused");
    }

    // ------------------------------------------------------------------
    beginTest("lock at the next arm: the drums collapse to the window and the "
              "designation clears - undo restores both; a new take of the "
              "drums keeps it, a new take of another slot ends it");
    {
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      is.engine.setDefiner(s.drums);
      is.engine.setLoopPoints(s.drums, 700, 3100);
      const int64_t d0 = is.origin(s.drums);
      const int64_t zero = is.zero();
      const juce::String bass = is.record(2400);
      auto* drums = dynamic_cast<ClipNode*>(is.nodePtr(s.drums));
      expectEquals(is.dur(s.drums), (int64_t)2400, "the drums collapsed: the window IS the take");
      expectEquals(is.origin(s.drums), d0 + 700, "origin = the window top = zero");
      expectEquals(is.iprop(s.drums, "loopEnd"), (int64_t)0, "the window is consumed");
      expect(drums != nullptr && drums->isCollapsed(), "the collapse marker");
      expectEquals(rootOf(is)->definerDesignation(), juce::String(), "the designation cleared");
      expectEquals(definerId(is), juce::String(), "three takes: no definer");
      expectEquals(is.Q(), (int64_t)2400, "Q stands");
      expectEquals(is.zero(), zero, "zero stands");
      expectEquals(posmod(is.origin(bass) - zero, 2400), (int64_t)0,
                   "the bass armed on the 2400 grid from the drums' zero");
      expectEquals(is.dur(bass), (int64_t)2400, "one Q of bass");
      expectEquals(lawMismatches(is, {s.keys, s.drums, bass}, 10000), 0,
                   "keys drift as recorded, drums loop the collapsed window, bass on the grid");

      is.engine.undo();  // the bass take
      is.engine.undo();  // the designation's clear
      expectEquals(rootOf(is)->definerDesignation(), s.drums, "undo: the designation returns");
      expectEquals(definerId(is), s.drums, "undo: the drums define Q again");
      is.engine.undo();  // the collapse
      expectEquals(is.dur(s.drums), (int64_t)5000, "undo: the full buffer");
      expectEquals(is.iprop(s.drums, "loopStart"), (int64_t)700, "undo: the trim is the window");
      expectEquals(is.iprop(s.drums, "loopEnd"), (int64_t)3100, "...");
      expectEquals(is.origin(s.drums), d0, "undo: the origin");
      is.engine.undo();  // the bass clip's create
      is.engine.undo();  // the trim
      is.engine.undo();  // the hand-off
      expectEquals(is.Q(), (int64_t)1000, "walked back: Q 1000");
      expectEquals(is.zero(), s.k0, "walked back: zero k0");
      expectEquals(rootOf(is)->definerDesignation(), juce::String(), "walked back: no designation");

      // A NEW TAKE of the designated drums keeps the hand-off.
      is.engine.setDefiner(s.drums);
      is.engine.setLoopPoints(s.drums, 700, 3100);
      is.engine.newTake(s.drums);
      is.settle();
      expectEquals(drums->takeCount(), 2, "the drums hold a second take");
      expectEquals(is.dur(s.drums), (int64_t)2400, "collapsed at the arm, as any arm");
      expectEquals(rootOf(is)->definerDesignation(), s.drums, "the designation stands");
      expectEquals(definerId(is), s.drums, "the drums still define Q");
      is.engine.setLoopPoints(s.drums, 0, 1200);
      expectEquals(is.Q(), (int64_t)1200, "and still re-grid it");
      is.engine.undo();
      // A new take of another slot ends it.
      is.engine.newTake(s.keys);
      is.settle();
      expectEquals(rootOf(is)->definerDesignation(), juce::String(),
                   "a new take of the keys clears the designation");
      expectEquals(definerId(is), juce::String(), "no definer");
    }

    // ------------------------------------------------------------------
    beginTest("handing Q BACK to the lock-collapsed keys re-opens them (full "
              "buffer, old trim as window), Q = the keys loop, zero = its "
              "top, the stored top clears - sound-neutral; undo re-collapses");
    {
      Island is;
      const juce::String keys = is.record(1300);
      is.engine.setLoopPoints(keys, 300, 1300);  // Q13: Q := 1000
      expectEquals(is.Q(), (int64_t)1000, "the sole keys trimmed: Q 1000");
      const int64_t keys_origin = is.origin(keys);  // after the phase re-anchor
      const int64_t keys_top = keys_origin + 300;
      expectEquals(is.zero(), keys_top, "zero = the trimmed loop's top");
      is.driveToPhase(0);
      const juce::String drums = is.record(5000);  // the arm lock-collapses the keys
      auto* k = dynamic_cast<ClipNode*>(is.nodePtr(keys));
      expect(k != nullptr && k->isCollapsed(), "the keys collapsed at the drums' arm");
      expectEquals(is.dur(keys), (int64_t)1000, "...to their window");
      expectEquals(is.origin(keys), keys_top, "...at their loop top");
      is.engine.setDefiner(drums);
      expectEquals(is.Q(), (int64_t)5000, "Q handed to the drums");
      // A ↺ top on the collapsed keys (a re-time's top, loop_selection.md §9).
      is.engine.setTiming(keys, 0, (int64_t)500);
      expectEquals(k->storedTop(), (int64_t)500, "a stored top on the keys");
      expectEquals(lawMismatches(is, {keys, drums}, 5000), 0, "before: as recorded");

      is.engine.setDefiner(keys);
      expect(!k->isCollapsed(), "re-opened");
      expectEquals(is.dur(keys), (int64_t)1300, "the full buffer is back");
      expectEquals(is.iprop(keys, "loopStart"), (int64_t)300, "the old trim is the window");
      expectEquals(is.iprop(keys, "loopEnd"), (int64_t)1300, "...");
      expectEquals(is.origin(keys), keys_origin, "the origin before the collapse");
      expectEquals(is.Q(), (int64_t)1000, "Q = the keys loop");
      expectEquals(is.zero(), keys_top, "zero = the keys loop top");
      expectEquals(definerId(is), keys, "the keys define Q again");
      expectEquals(k->storedTop(), timing::kNoTop,
                   "the stored top cleared: the definer's 1 is its region start");
      expectEquals(is.iprop(keys, "loopTop"), (int64_t)300, "the published top is the region start");
      expectEquals(lawMismatches(is, {keys, drums}, 5000), 0, "after: sound-neutral");
      // The re-opened definer trims LONGER again.
      is.engine.setLoopPoints(keys, 100, 1300);
      expectEquals(is.Q(), (int64_t)1200, "the keys trim longer: Q 1200");
      expectEquals(is.origin(keys), keys_origin, "with company: the origin stays");
      is.engine.undo();

      is.engine.undo();  // the hand-back
      expect(k->isCollapsed(), "undo re-collapses");
      expectEquals(is.dur(keys), (int64_t)1000, "...to the loop");
      expectEquals(is.origin(keys), keys_top, "...at its top");
      expectEquals(k->storedTop(), (int64_t)500, "...with its top");
      expectEquals(is.Q(), (int64_t)5000, "undo: the drums' Q");
      expectEquals(definerId(is), drums, "undo: the drums define Q");
      expectEquals(lawMismatches(is, {keys, drums}, 5000), 0, "undo: sound-neutral");
      is.engine.redo();
      expect(!k->isCollapsed(), "redo re-opens");
      expectEquals(k->storedTop(), timing::kNoTop, "redo clears the top");
      expectEquals(is.Q(), (int64_t)1000, "redo: Q = the keys loop");
    }

    // ------------------------------------------------------------------
    beginTest("a designated GROUP (two mics, one take) works like a clip");
    {
      Island is;
      const juce::String keys = is.record(1000);
      const int64_t k0 = is.origin(keys);
      is.driveToPhase(0);
      const juce::String kit = is.recordGroup(2, 5000);
      const juce::StringArray mics = is.childIds(kit);
      expectEquals(mics.size(), 2, "two mics");
      const int64_t O = is.origin(kit);
      expectEquals(O - k0, (int64_t)2000, "the kit: origin k0 + 2000");
      is.engine.setDefiner(kit);
      expectEquals(is.Q(), (int64_t)5000, "Q := the kit's period");
      expectEquals(is.zero(), O, "zero := the kit's origin");
      expectEquals(definerId(is), kit, "the kit defines Q");
      is.engine.setLoopPoints(kit, 700, 3100);
      expectEquals(is.Q(), (int64_t)2400, "the kit's window re-grids");
      expectEquals(is.zero(), O + 700, "zero := origin + start");
      expectEquals(is.origin(kit), O, "the kit's origin stays");
      for (const auto& mic : mics) {
        expectEquals(is.origin(mic), O, "the mics' origins stay");
        expectEquals(is.iprop(mic, "loopEnd"), (int64_t)0, "the mics stay whole");
      }
      expectEquals(is.cycle(), (int64_t)2400, "the keys drift");
      {
        const ClipFacts kf = clipFacts(is, keys);
        std::vector<ClipFacts> mf;
        for (const auto& mic : mics) mf.push_back(clipFacts(is, mic));
        expectEquals(is.mismatches(10000,
                                   [&](int64_t t) {
                                     float v = clipLaw(is, keys, kf, t);
                                     // The kit's window maps the mics' clock.
                                     const int64_t inner = 700 + posmod(t - O - 700, 2400);
                                     for (int i = 0; i < mics.size(); ++i) {
                                       v += rampAt(is.captured.at(mics[i]) + mf[(size_t)i].base +
                                                   posmod(O + inner - mf[(size_t)i].origin,
                                                          mf[(size_t)i].dur));
                                     }
                                     return v;
                                   }),
                     0, "the kit loops its window from its origin; the keys as recorded");
      }
      const juce::String bass = is.record(2400);
      expectEquals(is.dur(mics[0]), (int64_t)2400, "the kit collapsed at the arm");
      expectEquals(is.origin(kit), O + 700, "...its origin at the window top");
      expectEquals(rootOf(is)->definerDesignation(), juce::String(), "the designation cleared");
      is.engine.undo();  // the bass take
      is.engine.undo();  // the clear
      expectEquals(definerId(is), kit, "undo: the kit defines Q again");
      is.engine.undo();  // the collapse
      expectEquals(is.dur(mics[0]), (int64_t)5000, "undo: the full takes");
      expectEquals(is.iprop(kit, "loopStart"), (int64_t)700, "undo: the kit's window");
      expectEquals(is.origin(kit), O, "undo: the kit's origin");
      juce::ignoreUnused(bass);

      // Recording NEW content inside the designated kit — a third, empty
      // mic armed through the kit — ends the hand-off too.
      const juce::String mic3 = is.createClip(kit);
      is.engine.startRecordingInNode(kit);
      expectEquals(rootOf(is)->definerDesignation(), juce::String(),
                   "arming a new member of the designated kit clears it");
      is.engine.stopRecordingInNode(kit);  // cancelled before capture
      is.settle();
      expectEquals(is.dur(mic3), (int64_t)0, "the cancelled take left nothing");
      is.engine.undo();  // the clear
      expectEquals(rootOf(is)->definerDesignation(), kit, "undo restores it");
      expectEquals(definerId(is), kit, "the kit defines Q again");
    }

    // ------------------------------------------------------------------
    beginTest("a stale designation falls through and revives with the undo "
              "that un-stales it");
    {
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      is.engine.setDefiner(s.drums);
      is.engine.deleteNode(s.drums);
      expectEquals(rootOf(is)->definerDesignation(), s.drums, "the designation stays stored");
      expectEquals(definerId(is), s.keys, "the derived rule answers: the sole keys");
      is.engine.undo();
      expectEquals(definerId(is), s.drums, "undo of the delete revives the hand-off");
      is.engine.setPeriodSource(s.drums, PeriodSource::CONTEXT_CYCLE);
      expectEquals(definerId(is), juce::String(), "a one-shot is no definer; two takes: none");
      is.engine.undo();
      expectEquals(definerId(is), s.drums, "undo revives it again");
    }

    // ------------------------------------------------------------------
    beginTest("session round trip keeps the designation (bundle key `definer`, "
              "written only when set)");
    {
      Story s;
      s.build();
      auto& is = s.is;
      if (!storyHolds(s)) return;
      const juce::File plain = test_utils::freshTempDir("definer_plain");
      expect(is.engine.saveSession(plain.getFullPathName()), "saved");
      {
        const juce::var json =
            juce::JSON::parse(plain.getChildFile("session.json").loadFileAsString());
        expect(!json.hasProperty("definer"), "no designation: no key");
      }
      is.engine.setDefiner(s.drums);
      is.engine.setLoopPoints(s.drums, 700, 3100);
      const juce::File dir = test_utils::freshTempDir("definer_roundtrip");
      expect(is.engine.saveSession(dir.getFullPathName()), "saved");
      {
        const juce::var json =
            juce::JSON::parse(dir.getChildFile("session.json").loadFileAsString());
        expectEquals(json.getProperty("definer", "").toString(), s.drums,
                     "the bundle names the designated definer");
      }
      AudioEngine fresh;
      expect(fresh.loadSession(dir.getFullPathName()), "loaded");
      const juce::var st = fresh.getGraphState();
      expectEquals(st.getProperty("definerId", "").toString(), s.drums,
                   "the drums define Q after the load");
      expectEquals((int64_t)(double)st.getProperty("quantum", 0), (int64_t)2400, "Q");
      expectEquals((int64_t)(double)st.getProperty("islandZero", 0), is.zero(), "zero");
      // The loaded hand-off still re-grids with the drums' origin kept.
      auto* d = fresh.findNodeByUuidForTest(s.drums);
      const int64_t d0 = d != nullptr ? d->origin_samples.load() : 0;
      fresh.setLoopPoints(s.drums, 700, 1900);
      expectEquals((int64_t)(double)fresh.getGraphState().getProperty("quantum", 0),
                   (int64_t)1200, "a trim after the load re-grids");
      expectEquals(d != nullptr ? d->origin_samples.load() : -1, d0, "...keeping the origin");
      // A load replaces any designation: the plain bundle has none.
      expect(fresh.loadSession(plain.getFullPathName()), "loaded the plain bundle");
      expectEquals(fresh.getGraphState().getProperty("definerId", "").toString(),
                   juce::String(), "no designation after loading a bundle without one");
      plain.deleteRecursively();
      dir.deleteRecursively();
    }
  }
};

static DefinerHandoffTests definerHandoffTests;

}  // namespace celestrian
