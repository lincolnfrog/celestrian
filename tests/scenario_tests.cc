/**
 * SCENARIO TESTS — the canonical examples, fleshed out (docs/scenarios.md).
 *
 * Each scenario is a short performance driven through the real engine
 * (device callback, ramp input) with an ANALYTIC expectation of what
 * sounds when: the plain loop law, the window law, the one-shot rest,
 * the sequencer's gates and cues, composed exactly as the docs state
 * them. The expectations are the design; a failure here is either a
 * kernel bug or a scenario whose expectation needs the owner's ruling —
 * never a number to be "fixed" to match the code.
 *
 * Q = 20000 samples throughout (≈0.45 s at 44.1 kHz). "NQ" in a name
 * means N × Q samples of committed content.
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <cmath>
#include <map>

#include "../src/audio_engine.h"
#include "../src/period_law.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::BLOCK;
using scenario::Island;
using scenario::posmod;
using scenario::rampAt;

namespace {
constexpr int64_t Q = 20000;

/** A sequence payload for the engine's setSequence verb. */
struct StepSpec {
  int64_t len = 0;
  bool cue = false;
  std::vector<int> next;  // successor step indices (weight 1)
};
juce::var seqPayload(const std::vector<StepSpec>& steps,
                     const std::map<juce::String, std::vector<bool>>& gates = {},
                     int seed = 0) {
  auto* payload = new juce::DynamicObject();
  juce::Array<juce::var> arr;
  for (size_t i = 0; i < steps.size(); ++i) {
    auto* s = new juce::DynamicObject();
    s->setProperty("name", "s" + juce::String((int)i));
    s->setProperty("len", (double)steps[i].len);
    if (steps[i].cue) s->setProperty("cue", true);
    if (!steps[i].next.empty()) {
      juce::Array<juce::var> next;
      for (int to : steps[i].next) {
        auto* n = new juce::DynamicObject();
        n->setProperty("to", to);
        n->setProperty("w", 1);
        next.add(juce::var(n));
      }
      s->setProperty("next", next);
    }
    arr.add(juce::var(s));
  }
  payload->setProperty("steps", arr);
  if (!gates.empty()) {
    auto* g = new juce::DynamicObject();
    for (const auto& [uuid, bits] : gates) {
      juce::Array<juce::var> b;
      for (bool x : bits) b.add(x);
      g->setProperty(uuid, b);
    }
    payload->setProperty("gates", juce::var(g));
  }
  if (seed != 0) payload->setProperty("seed", seed);
  return juce::var(payload);
}
}  // namespace

class ScenarioTests : public juce::UnitTest {
 public:
  ScenarioTests()
      : juce::UnitTest("Scenarios (the canonical examples)", "Scenarios") {}

  /** Drive `span` and expect every output sample to match `fn(t)`. */
  void expectOutput(Island& is, int64_t span,
                    const std::function<float(int64_t)>& fn,
                    const juce::String& label, int64_t skip = 0) {
    expectEquals(is.mismatches(span, fn, 2.0e-7f, skip), 0, label);
  }

  /** The facts a scenario's end state consists of — for equality across
   * undo/redo and save/load. */
  struct Facts {
    int64_t q = 0, epoch = 0, cycle = 0;
    std::vector<std::tuple<int64_t, int64_t, int64_t, int64_t>> clips;  // dur, origin-epoch, ls, le
  };
  Facts facts(Island& is) {
    Facts f;
    f.q = is.Q();
    f.epoch = is.epoch();
    f.cycle = is.cycle();
    juce::StringArray ids;
    is.clipIds(ids);
    for (const auto& id : ids)
      f.clips.push_back({is.dur(id), is.origin(id) - f.epoch,
                         is.iprop(id, "loopStart"), is.iprop(id, "loopEnd")});
    return f;
  }
  bool same(const Facts& a, const Facts& b) {
    return a.q == b.q && a.cycle == b.cycle && a.clips == b.clips;
  }

  /** The user's scenario (S3): 1Q, 5Q, 3Q trimmed to 1Q, 12Q trimmed to 6Q. */
  struct S3State {
    juce::String c1, c2, c3, c4;
  };
  S3State buildS3(Island& is) {
    S3State s;
    s.c1 = is.record(Q);
    s.c2 = is.record(5 * Q);
    s.c3 = is.record(3 * Q);
    is.window(s.c3, Q, 2 * Q);
    s.c4 = is.record(12 * Q);
    is.window(s.c4, 0, 6 * Q);
    return s;
  }
  std::function<float(int64_t)> s3Expected(Island& is, const S3State& s) {
    return [&is, s](int64_t t) {
      return is.loopVal(s.c1, t) + is.loopVal(s.c2, t) +
             is.windowVal(s.c3, t, Q, Q) + is.windowVal(s.c4, t, 0, 6 * Q);
    };
  }

  void runTest() override {
    // ------------------------------------------------------------------
    beginTest("S1: the first take defines Q; content == captured input; "
              "the render == the sum of the loops");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      expectEquals(is.Q(), Q, "Q := the first take's length");
      expectEquals(is.dur(c1), Q, "1Q committed");
      expectEquals(is.origin(c1), is.epoch(), "the first take's origin IS the epoch");
      expectEquals(is.cycle(), Q, "cycle = 1Q");
      // THE HARNESS LAW: content[k] == rampAt(captured + k), and a lone
      // loop renders content[(t − origin) mod D] at unity.
      expectOutput(is, 2 * Q, [&](int64_t t) { return is.loopVal(c1, t); },
                   "a lone 1Q loop renders its captured samples");

      // A second take armed mid-cycle lands on the NEXT Q boundary and
      // pads forward to the boundary after the stop.
      is.drive(Q / 3);
      const juce::String c2 = is.record(3 * Q);
      expectEquals(posmod(is.origin(c2) - is.epoch(), Q), (int64_t)0,
                   "origin on the Q grid");
      expectEquals(is.dur(c2), 3 * Q, "3Q committed (padded to the boundary)");
      expectEquals(is.cycle(), 3 * Q, "cycle = lcm(1Q, 3Q) = 3Q");
      expectOutput(is, 3 * Q, is.sumOfLoops({c1, c2}), "two loops sum");
    }

    // ------------------------------------------------------------------
    beginTest("S2: recording.md Example 2 — an 8Q take armed at island "
              "phase 2Q of a 4Q cycle plays content[0] at t ≡ its origin");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      expectEquals(is.cycle(), 4 * Q, "cycle 4Q");
      const int64_t epoch0 = is.epoch();
      is.driveToPhase(2 * Q);
      const juce::String c3 = is.record(8 * Q);
      const int64_t rel = is.origin(c3) - epoch0;
      expectEquals(posmod(rel, 4 * Q), 2 * Q, "armed at heard phase 2Q");
      expectEquals(is.cycle(), 8 * Q, "cycle grows to 8Q");
      // EPOCH RE-BASE ON GROWTH (Q14b): the top moves to the take's
      // heard top — its origin floored to whole pre-take cycles.
      expectEquals(is.epoch(), epoch0 + (rel / (4 * Q)) * (4 * Q),
                   "epoch := the take's heard top (whole old cycles)");
      expectEquals(is.origin(c3) - is.epoch(), 2 * Q,
                   "the take sits at 2Q of the new frame");
      expectOutput(is, 8 * Q, is.sumOfLoops({c1, c2, c3}),
                   "every clip aligns by its own origin");
      // c3 presents content[0] exactly at its origin (mod 8Q): the
      // formula above says so; pin it directly too.
      const int64_t o3 = is.origin(c3);
      expectEquals(heard::nodeInner(*is.nodePtr(c3), o3 + 16 * Q, is.engine.rootScope()),
                   (int64_t)0, "content[0] at t ≡ origin (mod 8Q)");
      expectEquals(heard::nodeInner(*is.nodePtr(c3), is.epoch() + 8 * Q, is.engine.rootScope()),
                   6 * Q, "content[6Q] at the frame top (Example 2's launch point)");
    }

    // ------------------------------------------------------------------
    beginTest("S3: 1Q, 5Q, 3Q windowed to 1Q, 12Q windowed to 6Q — the "
              "cycle follows the WINDOWS (5Q → 60Q → 30Q)");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(5 * Q);
      const juce::String c3 = is.record(3 * Q);
      expectEquals(is.cycle(), 15 * Q, "lcm(1, 5, 3) = 15Q");
      expectOutput(is, 15 * Q, is.sumOfLoops({c1, c2, c3}), "three loops");
      is.window(c3, Q, 2 * Q);  // "only 1Q": a loop window, non-destructive
      expectEquals(is.iprop(c3, "loopStart"), Q, "window [1Q, 2Q)");
      expectEquals(is.dur(c3), 3 * Q, "the take keeps its 3Q of content");
      expectEquals(is.cycle(), 5 * Q, "lcm(1, 5, 1) = 5Q");
      expectOutput(is, 10 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + is.loopVal(c2, t) + is.windowVal(c3, t, Q, Q);
      }, "the windowed clip loops its 1Q at its own performed moment");
      const juce::String c4 = is.record(12 * Q);
      expectEquals(is.cycle(), 60 * Q, "lcm(5, 12) = 60Q");
      // NO ORIGIN FOLD (owner ruling 2026-09-09, reversing Q15): recorded
      // under c3's window (heard 5Q < intrinsic 15Q), the take anchors
      // at its capture boundary — the phrase continues from content[0]
      // the moment the take ends (S32 pins the audible consequence).
      expectEquals(is.origin(c4), is.captured.at(c4),
                   "origin = the capture boundary, never folded");
      is.window(c4, 0, 6 * Q);
      expectEquals(is.cycle(), 30 * Q, "lcm(5, 6) = 30Q");
      expectOutput(is, 12 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + is.loopVal(c2, t) +
               is.windowVal(c3, t, Q, Q) + is.windowVal(c4, t, 0, 6 * Q);
      }, "both windows loop their material in place");
      expectEquals(is.Q(), Q, "Q untouched by non-definer windows");
    }

    // ------------------------------------------------------------------
    beginTest("S4: LCM growth and non-growth — 1Q,4Q,3Q → 12Q; +8Q → 24Q; "
              "a 2Q take does not shrink it");
    {
      Island is;
      is.record(Q);
      is.record(4 * Q);
      expectEquals(is.cycle(), 4 * Q, "4Q");
      is.record(3 * Q);
      expectEquals(is.cycle(), 12 * Q, "12Q");
      is.record(8 * Q);
      expectEquals(is.cycle(), 24 * Q, "24Q");
      is.record(2 * Q);
      expectEquals(is.cycle(), 24 * Q, "2Q divides 24Q: unchanged");
      expectEquals(is.Q(), Q, "Q unchanged throughout");
    }

    // ------------------------------------------------------------------
    beginTest("S5: the pickup (E-A) — a click just before the cycle top "
              "lands ON the top; a simple extension re-bases the epoch to it");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      const int64_t epoch0 = is.epoch();
      is.driveToPhase(0);  // within a block of the next 4Q top
      const juce::String c3 = is.record(8 * Q);
      const int64_t rel = is.origin(c3) - epoch0;
      expectEquals(posmod(rel, 4 * Q), (int64_t)0, "landed on the top");
      expect(rel >= 4 * Q, "the NEXT top, not a past one");
      expectEquals(is.epoch(), is.origin(c3),
                   "simple extension armed at a top: epoch := origin");
      expectOutput(is, 8 * Q, is.sumOfLoops({c1, c2, c3}), "aligned");
    }

    // ------------------------------------------------------------------
    beginTest("S6: one-shot (Q5, Example 3) — a 1Q take at phase 3Q fires "
              "once per 4Q cycle at its origin and contributes no period");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.driveToPhase(3 * Q);
      const juce::String c3 = is.record(Q);
      const int64_t o3 = is.origin(c3);
      expectEquals(posmod(o3 - is.epoch(), 4 * Q), 3 * Q, "at 3Q");
      is.engine.setPeriodSource(c3, PeriodSource::CONTEXT_CYCLE);
      expectEquals(is.cycle(), 4 * Q, "a one-shot is excluded from the fold");
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t h = posmod(t - o3, 4 * Q);
        const float shot = h < Q ? is.val(c3, h) : 0.0f;
        return is.loopVal(c1, t) + is.loopVal(c2, t) + shot;
      }, "fires at [3Q, 4Q) of every cycle, silent elsewhere");
      is.engine.setPeriodSource(c3, PeriodSource::OWN_LENGTH);
      expectEquals(is.cycle(), 4 * Q, "back to a loop: lcm unchanged (1Q divides)");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2, c3}), "loops every Q again");
    }

    // ------------------------------------------------------------------
    beginTest("S7: a window changes the period (E-C) — [1Q, 3Q) on a 4Q "
              "clip makes the cycle 2Q; bypass restores 4Q");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.window(c2, Q, 3 * Q);
      expectEquals(is.cycle(), 2 * Q, "lcm(1Q, 2Q)");
      expectOutput(is, 6 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + is.windowVal(c2, t, Q, 2 * Q);
      }, "window content at its own performed moment");
      is.engine.toggleLoopWindow(c2);  // bypass
      expect(is.bprop(c2, "loopBypassed"), "bypassed");
      expectEquals(is.cycle(), 4 * Q, "bypassed: the whole take again");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2}), "honest full take");
      is.engine.toggleLoopWindow(c2);
      expectEquals(is.cycle(), 2 * Q, "re-activated");
    }

    // ------------------------------------------------------------------
    beginTest("S8: nested composite (E-B/E-C) — a 2Q+3Q inner stack is a 6Q "
              "clip to its parent; a 2Q window on it makes the cycle 4Q");
    {
      Island is;
      const juce::String q1 = is.record(Q);  // Q := 1Q (so 3Q is on the grid)
      const juce::String a = is.record(4 * Q);
      const juce::String g = is.createStack();
      const juce::String b = is.record(2 * Q, g);
      const juce::String c = is.record(3 * Q, g);
      expectEquals(is.dur(b), 2 * Q, "b 2Q");
      expectEquals(is.dur(c), 3 * Q, "c 3Q");
      expectEquals(is.nodePtr(g)->getIntrinsicDuration(), 6 * Q,
                   "inner cycle = lcm(2Q, 3Q) = 6Q");
      expectEquals(is.cycle(), 12 * Q, "island = lcm(1Q, 4Q, 6Q) = 12Q");
      expectOutput(is, 12 * Q, is.sumOfLoops({q1, a, b, c}), "a group sums its members");
      // Window the composite to [2Q, 4Q): the stack maps its children's
      // clock — t' = O + 2Q + ((t − O − 2Q) mod 2Q) — and presents 2Q.
      is.window(g, 2 * Q, 4 * Q);
      expectEquals(is.cycle(), 4 * Q, "lcm(4Q, 2Q) = 4Q");
      const int64_t O = is.origin(g);
      expect(is.bprop(g, "anchored"), "the group is anchored at its content");
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t tc = O + 2 * Q + posmod(t - O - 2 * Q, 2 * Q);
        return is.loopVal(q1, t) + is.loopVal(a, t) +
               is.val(b, posmod(tc - is.o(b), 2 * Q)) +
               is.val(c, posmod(tc - is.o(c), 3 * Q));
      }, "members read the mapped clock (frame preserved)");
    }

    // ------------------------------------------------------------------
    beginTest("S9: Q13 sole definer — trim re-establishes Q, the second arm "
              "lock-collapses, deleting the second take re-opens");
    {
      Island is;
      const juce::String c1 = is.record(4 * Q);
      expectEquals(is.Q(), 4 * Q, "provisional Q = 4Q");
      const int64_t o0 = is.origin(c1);
      is.drive(Q / 2);
      is.window(c1, Q, 2 * Q);  // the definer's trim
      expectEquals(is.Q(), Q, "Q := the window length");
      expectEquals(is.iprop(c1, "loopStart"), Q, "window kept on the clip");
      expectEquals(is.epoch(), is.origin(c1) + Q, "epoch := origin' + start");
      expectEquals(is.dur(c1), 4 * Q, "the take is still 4Q of content");
      // Phase preservation: the window plays its material at its
      // performed moment, i.e. content[1Q + ((t − origin) mod 1Q)].
      expectOutput(is, 4 * Q, [&](int64_t t) { return is.windowVal(c1, t, Q, Q); },
                   "the trimmed loop, phase-preserving");
      const int64_t o1 = is.origin(c1);
      // Second arm: the trim becomes the take (Q13 lock-collapse).
      const juce::String c2 = is.record(Q);
      expectEquals(is.dur(c1), Q, "collapsed: duration = the window");
      expectEquals(is.origin(c1), o1 + Q, "window top → origin");
      expect(!is.bprop(c1, "windowActive"), "window consumed");
      expectEquals(is.Q(), Q, "Q unchanged by the collapse");
      expectOutput(is, 4 * Q, [&](int64_t t) {
        return is.val(c1, Q + posmod(t - is.o(c1), Q)) + is.loopVal(c2, t);
      }, "audio-neutral: the same samples sound");
      // Re-open: deleting take 2 uncollapses the definer.
      is.engine.deleteNode(c2);
      expectEquals(is.dur(c1), 4 * Q, "re-opened: 4Q again");
      expectEquals(is.origin(c1), o1, "origin unwound");
      expectEquals(is.iprop(c1, "loopStart"), Q, "the trim is back");
      expectEquals(is.iprop(c1, "loopEnd"), 2 * Q, "...as a window");
      expectEquals(is.Q(), Q, "2 → 1 delete leaves Q");
      expectOutput(is, 2 * Q, [&](int64_t t) { return is.windowVal(c1, t, Q, Q); },
                   "still the trimmed loop");
      is.engine.undo();  // the delete
      expectEquals(is.dur(c1), Q, "undo re-collapses");
      juce::ignoreUnused(o0);
    }

    // ------------------------------------------------------------------
    beginTest("S10: Q13 for groups — a group take is the definer; its stack "
              "window re-defines Q; the second arm collapses the members");
    {
      Island is;
      const juce::String g = is.recordGroup(2, 4 * Q);
      const juce::StringArray mics = is.childIds(g);
      expectEquals(is.Q(), 4 * Q, "group take: Q = 4Q");
      expectEquals(is.origin(g), is.origin(mics[0]), "anchored at the take");
      is.window(g, Q, 2 * Q);
      expectEquals(is.Q(), Q, "the stack window re-defines Q");
      expectEquals(is.epoch(), is.origin(g) + Q, "epoch := origin' + start");
      for (const auto& m : mics) {
        expectEquals(is.dur(m), 4 * Q, "members whole");
        expect(!is.bprop(m, "windowActive"), "no member window");
        expectEquals(is.origin(m), is.origin(g), "members moved with the group");
      }
      const int64_t og = is.origin(g);
      expectOutput(is, 4 * Q, [&](int64_t t) {
        float s = 0.0f;
        for (const auto& m : mics) s += is.windowVal(m, t, Q, Q);
        return s;
      }, "the group window selects the members' material");
      const juce::String c = is.record(Q);
      expectEquals(is.origin(g), og + Q, "group collapse: window top → origin");
      for (const auto& m : mics) {
        expectEquals(is.dur(m), Q, "member collapsed to the window");
        expectEquals(is.origin(m), is.origin(g), "subtree moved together");
      }
      expect(!(is.iprop(g, "loopEnd") > is.iprop(g, "loopStart")),
             "stack window consumed");
      expectOutput(is, 4 * Q, [&](int64_t t) {
        float s = is.loopVal(c, t);
        for (const auto& m : mics) s += is.val(m, Q + posmod(t - is.o(m), Q));
        return s;
      }, "audio-neutral group collapse");
    }

    // ------------------------------------------------------------------
    beginTest("S11: Q survives its creator — deleting the first take keeps "
              "the grid; deleting everything reverts it; undo restores");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.engine.deleteNode(c1);
      expectEquals(is.Q(), Q, "Q survives its creator");
      expectEquals(is.cycle(), 4 * Q, "cycle 4Q");
      const juce::String c3 = is.record(3 * Q);
      expectEquals(posmod(is.origin(c3) - is.epoch(), Q), (int64_t)0, "still the 1Q grid");
      expectEquals(is.cycle(), 12 * Q, "12Q");
      expectOutput(is, 12 * Q, is.sumOfLoops({c2, c3}), "two loops");
      is.engine.deleteNode(c2);
      is.engine.deleteNode(c3);
      expectEquals(is.Q(), (int64_t)0, "an empty island has no Q");
      is.engine.undo();
      expectEquals(is.Q(), Q, "undo brings the grid back with the clip");
      expectEquals(is.dur(c3), 3 * Q, "...and the take");
    }

    // ------------------------------------------------------------------
    beginTest("S12: seek — the phase jumps, every origin rides the delta, "
              "content selection is invariant, undo still works");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.driveToPhase(2 * Q);
      const juce::String c3 = is.record(8 * Q);
      const int64_t e0 = is.epoch();
      const int64_t r1 = is.origin(c1) - e0, r3 = is.origin(c3) - e0;
      expect(is.engine.seekTransport((double)(5 * Q)), "seek to 5Q");
      expectEquals(is.masterPos(), 5 * Q, "published phase = 5Q");
      const int64_t delta = is.epoch() - e0;
      expect(delta != 0, "the epoch moved");
      expectEquals(is.origin(c1) - is.epoch(), r1, "c1 keeps its frame place");
      expectEquals(is.origin(c3) - is.epoch(), r3, "c3 keeps its frame place");
      expectOutput(is, 8 * Q, is.sumOfLoops({c1, c2, c3}),
                   "every clip still reads by its (moved) origin");
      is.engine.undo();  // the c3 take
      expectEquals(is.dur(c3), (int64_t)0, "undo after a seek strips the take");
      expectEquals(is.cycle(), 4 * Q, "cycle back to 4Q");
    }

    // ------------------------------------------------------------------
    beginTest("S13: undo the whole S3 chain to an empty island, redo it "
              "back — every fact returns");
    {
      Island is;
      const S3State s = buildS3(is);
      const Facts before = facts(is);
      int undos = 0;
      while (is.engine.canUndo() && undos < 100) {
        is.engine.undo();
        ++undos;
      }
      expectEquals(is.Q(), (int64_t)0, "undone to no Q");
      expect(is.childIds().isEmpty(), "undone to no nodes");
      int redos = 0;
      while (is.engine.canRedo() && redos < 100) {
        is.engine.redo();
        ++redos;
      }
      expectEquals(redos, undos, "every entry replayed");
      expect(same(before, facts(is)), "durations, frame places, windows, Q, cycle restored");
      expectOutput(is, 6 * Q, s3Expected(is, s), "and the render is the same");
    }

    // ------------------------------------------------------------------
    beginTest("S14: session round trip of S3 — a fresh engine loads the "
              "same facts and renders the same island");
    {
      Island a;
      const S3State s = buildS3(a);
      const Facts fa = facts(a);
      auto dir = test_utils::freshTempDir("scenario_s14");
      expect(a.engine.saveSession(dir.getFullPathName()), "saved");
      Island b;
      expect(b.engine.loadSession(dir.getFullPathName()), "loaded");
      b.captured = a.captured;  // the same content
      const Facts fb = facts(b);
      expect(same(fa, fb), "facts identical after load");
      expectEquals(fb.epoch, fa.epoch, "the epoch persists");
      if (!b.engine.isPlaying()) b.engine.togglePlayback();
      expectOutput(b, 6 * Q, s3Expected(b, s), "the loaded island renders the same",
                   /*skip=*/BLOCK);
    }

    // ------------------------------------------------------------------
    beginTest("S15: takes — a new take of a 4Q slot captures one period, "
              "selection swaps content, a comp reads one take per Q cell, "
              "deleting a take renumbers");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.drive(Q / 2);
      const int64_t t_arm = is.clock;
      is.engine.newTake(c2);
      is.waitFor([&] { return is.bprop(c2, "isRecording"); });
      // The take captures from the slot's next top (t ≡ origin mod 4Q):
      // the block that saw it start already holds `live` samples.
      const int64_t start2 = is.clock - is.iprop(c2, "duration");
      expectEquals(posmod(start2 - is.origin(c2), 4 * Q), (int64_t)0,
                   "a new take arms at the slot's own top");
      expect(start2 >= t_arm, "...the NEXT top after the arm");
      is.settle();  // capture runs exactly one period and auto-finishes
      expectEquals(is.iprop(c2, "takes"), (int64_t)2, "two takes");
      expectEquals(is.iprop(c2, "activeTake"), (int64_t)1, "the new one is active");
      expectEquals(is.dur(c2), 4 * Q, "the slot's period is unchanged");
      const int64_t cap0 = is.captured.at(c2);
      auto take = [&](int k, int64_t idx) { return rampAt((k == 0 ? cap0 : start2) + idx); };
      expectOutput(is, 4 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + take(1, posmod(t - is.o(c2), 4 * Q));
      }, "take 2 sounds in the slot");
      is.engine.selectTake(c2, 0);
      expectOutput(is, 4 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + take(0, posmod(t - is.o(c2), 4 * Q));
      }, "take 1 sounds again, sample-exact");
      is.engine.setComp(c2, {0, 1, 0, 1});
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t inner = posmod(t - is.o(c2), 4 * Q);
        const int cell = (int)(inner / Q);
        return is.loopVal(c1, t) + take(cell % 2, inner);
      }, "the comp alternates takes per Q cell, seam-exact");
      is.engine.deleteTake(c2, 1);
      expectEquals(is.iprop(c2, "takes"), (int64_t)1, "one take left");
      expectOutput(is, 4 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + take(0, posmod(t - is.o(c2), 4 * Q));
      }, "cells naming the deleted take fall back to the active one");
    }

    // ------------------------------------------------------------------
    beginTest("S16: a new take stopped short of its period CANCELS; the "
              "previous take stands");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.engine.newTake(c2);
      is.waitFor([&] { return is.bprop(c2, "isRecording"); });
      is.drive(Q);
      is.engine.stopRecordingInNode(c2);
      is.settle();
      expectEquals(is.iprop(c2, "takes"), (int64_t)1, "cancelled: one take");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2}), "the previous take sounds");
    }

    // ------------------------------------------------------------------
    beginTest("S17: sequencer period law — a 4Q+4Q root song over 1Q+4Q "
              "makes the cycle 8Q; a gate silences a child in step 2; "
              "bypass restores 4Q");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      const juce::String root = is.rootId();
      is.engine.setSequence(root, seqPayload({{4 * Q}, {4 * Q}}, {{c2, {true, false}}}));
      expectEquals(is.cycle(), 8 * Q, "steps concatenate: the song is the cycle");
      const int64_t O = is.epoch();  // the root song is anchored at the epoch (S30)
      const int64_t fade = (int64_t)(44100.0 * 0.010);
      // Away from the gate ramps (10 ms each side of a seam):
      {
        is.refresh();
        std::vector<std::pair<int64_t, float>> out;
        is.drive(16 * Q, &out);
        int bad = 0;
        for (const auto& [t, v] : out) {
          const int64_t srel = posmod(t - O, 8 * Q);
          const int64_t d = std::min(posmod(srel, 4 * Q), 4 * Q - posmod(srel, 4 * Q));
          if (d <= fade) continue;  // inside a ramp
          const bool on = srel < 4 * Q;
          const float want = is.loopVal(c1, t) + (on ? is.loopVal(c2, t) : 0.0f);
          if (std::abs(want - v) > 2.0e-7f) ++bad;
        }
        expectEquals(bad, 0, "c2 sounds in step 1 only; c1 throughout");
      }
      is.engine.toggleSequence(root);
      expectEquals(is.cycle(), 4 * Q, "bypassed: the plain 4Q island");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2}), "everything sounds");
    }

    // ------------------------------------------------------------------
    beginTest("S18: a CUED step re-bases the child clock to the song top — "
              "in step 2 the 4Q clip plays what it plays in step 1");
    {
      Island is;
      const juce::String c2 = is.record(4 * Q);
      const juce::String root = is.rootId();
      is.engine.setSequence(root, seqPayload({{4 * Q}, {4 * Q, true}}));
      expectEquals(is.cycle(), 8 * Q, "8Q song");
      const int64_t O = is.epoch();  // the root song is anchored at the epoch (S30)
      const int64_t fade = (int64_t)(44100.0 * 0.010);
      is.refresh();
      std::vector<std::pair<int64_t, float>> out;
      is.drive(16 * Q, &out);
      int bad = 0;
      for (const auto& [t, v] : out) {
        const int64_t srel = posmod(t - O, 8 * Q);
        const int64_t d = std::min(posmod(srel, 4 * Q), 4 * Q - posmod(srel, 4 * Q));
        if (d <= fade) continue;
        // Step 1: the plain clock. Step 2 (cued): t' = O + (srel − 4Q).
        const int64_t tc = srel < 4 * Q ? t : O + (srel - 4 * Q);
        const float want = is.val(c2, posmod(tc - is.o(c2), 4 * Q));
        if (std::abs(want - v) > 2.0e-7f) ++bad;
      }
      expectEquals(bad, 0, "the cued step replays the song top");
    }

    // ------------------------------------------------------------------
    beginTest("S19: record over the song — a 3Q+2Q root song is the arm "
              "grid's cycle; the new take's contextCycle is the song");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String root = is.rootId();
      is.engine.setSequence(root, seqPayload({{3 * Q}, {2 * Q}}));
      expectEquals(is.cycle(), 5 * Q, "the song is the cycle");
      const juce::String c2 = is.record(3 * Q);
      expectEquals(is.dur(c2), 3 * Q, "3Q take");
      expectEquals(is.iprop(c2, "contextCycle"), 5 * Q,
                   "the take heard the song as its frame");
      expectEquals(is.cycle(), 5 * Q, "the song still wins the frame");
      expectOutput(is, 10 * Q, is.sumOfLoops({c1, c2}), "no gates: everything loops");
    }

    // ------------------------------------------------------------------
    beginTest("S20: successors — a deterministic route that skips a step "
              "shortens the song; the children's clocks are untouched");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      const juce::String root = is.rootId();
      is.engine.setSequence(root, seqPayload({{2 * Q, false, {1}}, {2 * Q, false, {0}}}));
      expectEquals(is.cycle(), 4 * Q, "A → B → A: a 4Q loop");
      is.engine.setSequence(root, seqPayload({{2 * Q, false, {0}}, {2 * Q}}));
      expectEquals(is.cycle(), 2 * Q, "A → A: B is never visited, the song is 2Q");
      expectOutput(is, 8 * Q, is.sumOfLoops({c1, c2}),
                   "the song folds the FRAME, never a child's clock");
    }

    // ------------------------------------------------------------------
    beginTest("S21: combine two committed clips into a group — anchored at "
              "the earliest member; nothing moves; undo explodes it back");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.driveToPhase(2 * Q);
      const juce::String c3 = is.record(4 * Q);
      expectEquals(is.cycle(), 4 * Q, "4Q");
      const int64_t o2 = is.origin(c2), o3 = is.origin(c3);
      const juce::String g = is.engine.combineNodes(c3, c2);
      expect(g.isNotEmpty(), "combined");
      expectEquals(is.origin(g), std::min(o2, o3), "anchored at the earliest member");
      expectEquals(is.origin(c2), o2, "members keep their origins");
      expectEquals(is.origin(c3), o3, "...");
      expectEquals(is.cycle(), 4 * Q, "cycle unchanged");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2, c3}), "nothing moved");
      is.engine.undo();
      expect(is.childIds().size() == 3, "exploded back to three clips");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2, c3}), "still nothing moved");
    }

    // ------------------------------------------------------------------
    beginTest("S22: mute is a gain, not a clock — a muted-then-unmuted "
              "clip is exactly in phase");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.engine.toggleMute(c2);
      is.drive(2 * Q + Q / 3);
      is.engine.toggleMute(c2);
      is.drive(Q / 2);  // past the un-mute ramp
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2}), "phase continuous through a mute");
    }

    // ------------------------------------------------------------------
    beginTest("S23: bounce == the live render — one island cycle of S3 from "
              "the epoch, sample for sample");
    {
      Island is;
      const S3State s = buildS3(is);
      auto dir = test_utils::freshTempDir("scenario_s23");
      const juce::File wav = dir.getChildFile("island.wav");
      expect(is.engine.bounce(is.rootId(), wav.getFullPathName()), "bounced");
      juce::WavAudioFormat fmt;
      std::unique_ptr<juce::AudioFormatReader> r(
          fmt.createReaderFor(wav.createInputStream().release(), true));
      expect(r != nullptr, "wav readable");
      if (r != nullptr) {
        const int64_t C = is.cycle();
        expect(r->lengthInSamples >= C, "at least one cycle long");
        const int n = (int)std::min<int64_t>(C, 6 * Q);
        juce::AudioBuffer<float> b(2, n);
        r->read(&b, 0, n, 0, true, true);
        is.refresh();
        const auto fn = s3Expected(is, s);
        int bad = 0;
        for (int i = 0; i < n; ++i)
          if (std::abs(fn(is.epoch() + i) - b.getSample(0, i)) > 2.0e-7f) ++bad;
        expectEquals(bad, 0, "the bounce is the live equation from the epoch");
      }
    }

    // ------------------------------------------------------------------
    beginTest("S24: Q-coherence — a 1.5Q window is refused; 2Q and Q/2 are "
              "accepted");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.window(c2, 0, Q + Q / 2);
      expect(!is.bprop(c2, "windowActive"), "1.5Q refused (incoherent)");
      expectEquals(is.cycle(), 4 * Q, "cycle unchanged");
      is.window(c2, 0, 2 * Q);
      expectEquals(is.cycle(), 2 * Q, "2Q accepted");
      is.window(c2, 0, Q / 2);
      expectEquals(is.cycle(), Q, "Q/2 accepted: lcm(1Q, Q/2) = 1Q");
    }

    // ------------------------------------------------------------------
    beginTest("S25: a one-shot GROUP (G-2) — a 2Q kit recorded at 2Q of a 4Q "
              "island fires from its origin once per cycle");
    {
      Island is;
      const juce::String q1 = is.record(Q);        // Q = 1Q (G-2's grid)
      const juce::String bass = is.record(4 * Q);  // the 4Q cycle
      is.driveToPhase(2 * Q);
      const juce::String kit = is.recordGroup(2, 2 * Q);
      const juce::StringArray mics = is.childIds(kit);
      const int64_t og = is.origin(kit);
      expectEquals(posmod(og - is.epoch(), 4 * Q), 2 * Q, "the kit sits at 2Q");
      expectEquals(is.cycle(), 4 * Q, "2Q divides 4Q");
      is.engine.setPeriodSource(kit, PeriodSource::CONTEXT_CYCLE);
      expectEquals(is.cycle(), 4 * Q, "a one-shot group is excluded from the fold");
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t h = posmod(t - og, 4 * Q);
        float s = is.loopVal(q1, t) + is.loopVal(bass, t);
        if (h < 2 * Q)
          for (const auto& m : mics) s += is.val(m, h);
        return s;
      }, "fires at island phases [2Q, 4Q), silent at [0, 2Q)");
    }

    // ------------------------------------------------------------------
    beginTest("S26: NO EDITS UNDER A LIVE TAKE (owner ruling 2026-09-09) — "
              "windows, deletes, sequences, period source, undo and pause "
              "are refused while a take is armed or capturing; mute and "
              "rename stay live; everything works again after the commit");
    {
      Island is;
      const juce::String c1 = is.record(4 * Q);
      const juce::String c0 = is.record(Q);  // Q = 4Q; a 1Q (Q/4) sibling
      const juce::String c2 = is.createClip();
      is.engine.startRecordingInNode(c2);
      is.waitFor([&] { return is.bprop(c2, "isRecording"); });
      const int64_t live = is.iprop(c2, "duration");
      const bool couldUndo = is.engine.canUndo();

      is.window(c1, Q, 2 * Q);
      expectEquals(is.iprop(c1, "loopEnd"), (int64_t)0, "window refused");
      expectEquals(is.Q(), 4 * Q, "Q untouched");
      is.engine.deleteNode(c0);
      expectEquals(is.dur(c0), Q, "delete refused");
      is.engine.setSequence(is.rootId(), seqPayload({{4 * Q}, {4 * Q}}));
      expect(is.node(is.rootId()).getProperty("sequence", juce::var()).isVoid() ||
                 !is.node(is.rootId()).getProperty("sequence", juce::var())
                      .getProperty("steps", juce::var()).isArray(),
             "sequence edit refused");
      is.engine.setPeriodSource(c0, PeriodSource::CONTEXT_CYCLE);
      expect(is.sprop(c0, "periodSource") != "context", "period source refused");
      is.engine.undo();
      expect(is.engine.canUndo() == couldUndo, "undo refused, entry kept");
      is.engine.togglePlayback();
      expect(is.engine.isPlaying(), "pause refused: the take keeps its clock");
      is.engine.toggleMute(c0);
      expect(is.bprop(c0, "isMuted"), "mute stays live");
      is.engine.toggleMute(c0);
      is.engine.renameNode(c0, "keys");
      expect(is.sprop(c0, "name") == "keys", "rename stays live");

      is.drive(4 * Q - live - BLOCK);  // stop short: the pad lands on 4Q
      is.engine.stopRecordingInNode(c2);
      is.settle();
      expectEquals(is.dur(c2), 4 * Q, "the take committed on the 4Q grid");
      // Everything works again.
      is.window(c1, Q, 2 * Q);
      expectEquals(is.iprop(c1, "loopEnd"), 2 * Q, "window applies after the take");
      is.engine.deleteNode(c0);
      expectEquals(is.dur(c0), (int64_t)0, "delete applies after the take");
    }

    // ------------------------------------------------------------------
    beginTest("S27: ONE TAKE AT A TIME (owner ruling 2026-09-09) — a second "
              "arm and a new take are refused while a take is live");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      const juce::String c3 = is.createClip();
      const juce::String c4 = is.createClip();
      is.engine.startRecordingInNode(c3);
      is.waitFor([&] { return is.bprop(c3, "isRecording"); });
      const int64_t live = is.iprop(c3, "duration");
      is.captured[c3] = is.clock - live;
      is.engine.startRecordingInNode(c4);
      expect(!is.bprop(c4, "isRecording") && !is.bprop(c4, "isPendingStart"),
             "second arm refused");
      is.engine.newTake(c2);
      expect(!is.bprop(c2, "isRecording") && !is.bprop(c2, "isPendingStart"),
             "new take refused under the live take");
      expectEquals(is.iprop(c2, "takes"), (int64_t)1, "still one take");
      is.drive(4 * Q - live - BLOCK);
      is.engine.stopRecordingInNode(c3);
      is.settle();
      expectEquals(is.dur(c3), 4 * Q, "the one live take committed");
      // After it: the arm works.
      is.recordInto(c4, 4 * Q);
      expectEquals(is.dur(c4), 4 * Q,
                   "the next arm is accepted once the island is settled");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2, c3, c4}), "four loops");
    }

    // ------------------------------------------------------------------
    beginTest("S28: the island's content cannot be a one-shot (owner "
              "ruling 2026-09-09) — refused on the sole take, allowed once "
              "a loop exists");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      is.engine.setPeriodSource(c1, PeriodSource::CONTEXT_CYCLE);
      expect(is.sprop(c1, "periodSource") != "context",
             "the only committed content cannot be a one-shot");
      expectEquals(is.cycle(), Q, "cycle = 1Q");
      const juce::String c2 = is.record(4 * Q);
      is.engine.setPeriodSource(c1, PeriodSource::CONTEXT_CYCLE);
      expect(is.sprop(c1, "periodSource") == "context",
             "with a loop beside it, the first take may fire once per cycle");
      expectEquals(is.cycle(), 4 * Q, "the loop defines the cycle");
      // A group holding ALL the content is refused the same way.
      const juce::String g = is.engine.combineNodes(c2, c1);
      is.engine.setPeriodSource(g, PeriodSource::CONTEXT_CYCLE);
      expect(is.sprop(g, "periodSource") != "context",
             "a group holding every take cannot be a one-shot either");
    }

    // ------------------------------------------------------------------
    beginTest("S29: recording INTO a windowed group (through the map) — one "
              "map pass captures into the inner timeline; through the same "
              "map the take replays what was heard; bypassed, the take is "
              "content where you played and silence where you did not");
    {
      Island is;
      const juce::String c0 = is.record(Q);  // Q = 1Q
      const juce::String g = is.createStack();
      const juce::String a = is.record(4 * Q, g);
      is.window(g, Q, 3 * Q);  // period 2Q: cycle lcm(1Q, 2Q) = 2Q
      expectEquals(is.cycle(), 2 * Q, "window period folds the island");
      const int64_t O = is.origin(g);
      const int64_t a0 = Q;
      const juce::String b = is.createClip(g);
      is.engine.startRecordingInNode(b);
      expect(is.waitFor([&] { return is.bprop(b, "isRecording"); }),
             "arms through one active map");
      const int64_t cs = is.clock - is.iprop(b, "duration");  // capture start
      is.settle();  // the one-period cap auto-finishes the take
      expectEquals(is.dur(b), 4 * Q, "commit duration = the group's inner cycle C");
      expectEquals(is.iprop(b, "contextCycle"), 2 * Q, "heard frame = the map period");
      expectEquals(is.cycle(), 2 * Q, "island cycle unchanged");
      const int64_t h0 = posmod(cs - O - a0, 2 * Q);  // heard offset at capture start
      // THROUGH THE MAP: at heard offset h the take sounds what was
      // performed at the same heard phase — I1 by construction.
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t tc = O + a0 + posmod(t - O - a0, 2 * Q);
        const int64_t h = posmod(t - O - a0, 2 * Q);
        return is.loopVal(c0, t) + is.val(a, posmod(tc - is.o(a), 4 * Q)) +
               rampAt(cs + posmod(h - h0, 2 * Q));
      }, "through the same map the take replays what was heard");
      // BYPASSED (the Degradation Contract, I9): the inner timeline,
      // honestly — captured samples where the map visited, silence
      // where it did not.
      is.engine.toggleLoopWindow(g);
      expectEquals(is.cycle(), 4 * Q, "bypassed: the whole inner cycle");
      expectOutput(is, 8 * Q, [&](int64_t t) {
        const int64_t inner_b = posmod(t - is.o(b), 4 * Q);  // b's content index
        // The inner position this content index sits at in the group
        // frame is what the map did or did not visit.
        const int64_t inner_pos = posmod(is.o(b) + inner_b - O, 4 * Q);
        float bv = 0.0f;
        if (inner_pos >= a0 && inner_pos < a0 + 2 * Q) {
          const int64_t j = posmod(inner_pos - a0 - h0, 2 * Q);  // heard order
          bv = rampAt(cs + j);
        }
        return is.loopVal(c0, t) + is.loopVal(a, t) + bv;
      }, "bypassed: content where you played, silence where you did not");
    }

    // ==================================================================
    // FIELD REPROS (owner report 2026-09-09: a 4-section root song
    // sounded the full band over the guitar-only section, and a take
    // recorded under a window "restarted into the middle"). These pin
    // the invariant the report is about — THE GRID YOU SEE IS THE GRID
    // YOU HEAR — in the frame the display draws: the island epoch.
    // ==================================================================

    // ------------------------------------------------------------------
    beginTest("S30 (field repro): the ROOT song's step grid is anchored at "
              "the island EPOCH — the ruler zero the grid is drawn on — even "
              "after a growth re-base moved the epoch off the first take");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.drive(4 * Q);
      is.driveToPhase(2 * Q);
      const juce::String c3 = is.record(8 * Q);  // 4Q → 8Q: the epoch re-bases
      expectEquals(is.cycle(), 8 * Q, "8Q");
      const juce::String root = is.rootId();
      const int64_t E = is.epoch();
      // THE ROOT IS NEVER ANCHORED: its inner timeline is the island
      // timeline, whose zero is the epoch — the ruler the UI draws on.
      expect(!is.nodePtr(root)->isAnchored(), "the root is never anchored");
      expect(posmod(E - is.origin(c1), 8 * Q) != 0,
             "the epoch has moved off the first take (the case that used to split them)");
      is.engine.setSequence(root, seqPayload({{4 * Q}, {4 * Q}}, {{c1, {true, false}}}));
      expectEquals(is.cycle(), 8 * Q, "the song is the cycle");
      const int64_t fade = (int64_t)(44100.0 * 0.010);
      is.refresh();
      std::vector<std::pair<int64_t, float>> out;
      is.drive(16 * Q, &out);
      int bad = 0;
      for (const auto& [t, v] : out) {
        const int64_t srel = posmod(t - E, 8 * Q);  // the grid's frame: the epoch
        const int64_t dseam =
            std::min(posmod(srel, 4 * Q), 4 * Q - posmod(srel, 4 * Q));
        if (dseam <= fade) continue;
        const bool on = srel < 4 * Q;
        const float want = (on ? is.loopVal(c1, t) : 0.0f) + is.loopVal(c2, t) +
                           is.loopVal(c3, t);
        if (std::abs(want - v) > 2.0e-7f) ++bad;
      }
      expectEquals(bad, 0, "c1 is silent in step 2 of the grid you SEE (epoch frame)");
    }

    // ------------------------------------------------------------------
    beginTest("S31 (field repro, nested): a GROUP song's step grid is "
              "anchored at the GROUP's origin (Q18) — a group anchored at a "
              "mid-cycle member gates from there, and the lanes draw it there");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.drive(4 * Q);
      is.driveToPhase(2 * Q);
      const juce::String g = is.createStack();
      const juce::String c3 = is.record(4 * Q, g);  // anchors g at phase 2Q
      expect(is.bprop(g, "anchored"), "the group is anchored");
      const int64_t Og = is.origin(g);
      const int64_t E = is.epoch();
      expectEquals(posmod(Og - E, 4 * Q), 2 * Q, "the group's origin sits at 2Q");
      is.engine.setSequence(g, seqPayload({{4 * Q}, {4 * Q}}, {{c3, {true, false}}}));
      expectEquals(is.cycle(), 8 * Q, "the group's song is 8Q; island lcm(1,4,8) = 8Q");
      const int64_t fade = (int64_t)(44100.0 * 0.010);
      is.refresh();
      std::vector<std::pair<int64_t, float>> out;
      is.drive(16 * Q, &out);
      int bad_epoch = 0, bad_origin = 0;
      for (const auto& [t, v] : out) {
        auto check = [&](int64_t anchor, int& bad) {
          const int64_t srel = posmod(t - anchor, 8 * Q);
          const int64_t dseam =
              std::min(posmod(srel, 4 * Q), 4 * Q - posmod(srel, 4 * Q));
          if (dseam <= fade) return;
          const bool on = srel < 4 * Q;
          const float want = is.loopVal(c1, t) + is.loopVal(c2, t) +
                             (on ? is.loopVal(c3, t) : 0.0f);
          if (std::abs(want - v) > 2.0e-7f) ++bad;
        };
        check(E, bad_epoch);
        check(Og, bad_origin);
      }
      // RULED 2026-09-09: a group's song folds from the group's origin
      // (the frame its window brackets and take tile already draw
      // from); the display carries the phase (view_model attachSeqDims
      // `phaseQ`, pinned by ui/js/tests/sequence.test.mjs and the
      // display-contract capture). The epoch-anchored reading is the
      // one the lanes USED to draw — it must not be what sounds.
      expectEquals(bad_origin, 0, "c3 is silent in step 2 from the group's origin");
      expect(bad_epoch > 0, "...which is NOT the epoch frame here (2Q apart)");
    }

    // ------------------------------------------------------------------
    beginTest("S32 (field repro): a take recorded under a window anchors at "
              "its capture boundary — no origin fold — so the phrase "
              "continues from content[0] the moment the take ends");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.window(c2, Q, 3 * Q);  // heard 2Q, intrinsic 4Q
      expectEquals(is.cycle(), 2 * Q, "heard cycle 2Q");
      // Arm so the target lands at INTRINSIC phase 3Q (the heard cursor
      // cannot tell 1Q from 3Q; the fold would pick 1Q).
      const int64_t e = is.epoch();
      for (int i = 0; i < 100000; ++i) {
        const int64_t p = posmod(is.clock - e, 4 * Q);
        const int64_t to = posmod(3 * Q - p, 4 * Q);
        if (to > 0 && to <= BLOCK) break;
        is.drive(BLOCK);
      }
      const juce::String c3 = is.record(3 * Q);  // 3Q: no multiple of the 2Q heard cycle
      const int64_t T = is.captured.at(c3);
      expectEquals(posmod(T - e, 4 * Q), 3 * Q, "captured at intrinsic phase 3Q");
      logMessage("  stored origin - capture boundary = " +
                 juce::String((double)(is.origin(c3) - T) / (double)Q) + "Q");
      expectEquals(is.origin(c3), T, "the take anchors at its capture boundary");
      expectEquals(is.cycle(), 6 * Q, "lcm(2Q, 3Q) = 6Q");
      expectOutput(is, 12 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + is.windowVal(c2, t, Q, 2 * Q) +
               is.val(c3, posmod(t - T, 3 * Q));
      }, "after the take the phrase continues from content[0], never mid-phrase");
    }

    // ==================================================================
    // GAP-FILL (2026-09-10): the families the catalog lacked once the
    // engine e2e journeys existed — cut bands, edits while playing,
    // nested maps, seek and save/load over maps and groups, multi-mic
    // groups.
    // ==================================================================

    // ------------------------------------------------------------------
    beginTest("S33: cut bands — a 4Q take keeps [0,1Q)+[2Q,3Q): the map "
              "law through the seam; the cut slides; bypass; separate "
              "gestures are separate undo steps, live commits one");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.drive(Q + 333);  // mid-cycle, playing
      timing::TimeMap m1;
      m1.n = 2;
      m1.segs[0] = {0, Q};
      m1.segs[1] = {2 * Q, 3 * Q};
      is.engine.setSegments(c2, m1);
      expectEquals(is.cycle(), 2 * Q, "the kept 2Q is the part");
      auto lawB = [&](const timing::TimeMap& m) {
        return [&, m](int64_t t) {
          const auto at = timing::innerAt(t, is.o(c2), m, m.period());
          return is.loopVal(c1, t) + is.val(c2, at.inner);
        };
      };
      expectOutput(is, 6 * Q, lawB(m1), "the map law, seam-exact");
      is.drive(2 * Q + 100);
      timing::TimeMap m2;
      m2.n = 2;
      m2.segs[0] = {Q, 2 * Q};
      m2.segs[1] = {3 * Q, 4 * Q};
      is.engine.setSegments(c2, m2);  // a second GESTURE
      expectOutput(is, 6 * Q, lawB(m2), "the slid cut");
      is.engine.toggleLoopWindow(c2);
      expectEquals(is.cycle(), 4 * Q, "bypassed: the whole take");
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, c2}), "whole");
      is.engine.toggleLoopWindow(c2);
      expectOutput(is, 6 * Q, lawB(m2), "re-activated");
      // ONE GESTURE, ONE UNDO — AND NO MORE (owner ruling 2026-09-10):
      // undo the re-activate, the bypass, then the SLIDE alone.
      is.engine.undo();
      is.engine.undo();
      is.engine.undo();
      expectEquals(is.cycle(), 2 * Q, "the first cut stands after three undos");
      expectOutput(is, 6 * Q, lawB(m1), "back to the first cut, not the whole take");
      // A live stream (a drag): the first commit opens the entry, the
      // live ones fold into it — one undo restores the pre-drag map.
      is.engine.setSegments(c2, m2);
      timing::TimeMap m3 = m2;
      m3.segs[0] = {Q, 2 * Q};
      m3.segs[1] = {2 * Q + Q / 2, 3 * Q + Q / 2};
      is.engine.setSegments(c2, m3, /*live=*/true);
      timing::TimeMap m4 = m2;
      m4.segs[1] = {2 * Q, 3 * Q};
      is.engine.setSegments(c2, m4, /*live=*/true);
      expectOutput(is, 4 * Q, lawB(m4), "the drag's last commit sounds");
      is.engine.undo();
      expectOutput(is, 4 * Q, lawB(m1), "one undo takes back the whole drag");
    }

    // ------------------------------------------------------------------
    beginTest("S34: editing one lane's map while playing never moves the "
              "OTHER lanes' phase (owner ruling 2026-09-10) — the epoch "
              "follows by whole cycles of everyone else, the edited tile "
              "takes the residual; clearing a window re-bases nothing");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      is.driveToPhase(2 * Q);
      const juce::String a = is.record(4 * Q);
      is.driveToPhase(Q);
      const juce::String b = is.record(4 * Q);
      expectEquals(is.cycle(), 4 * Q, "4Q");
      // Before any edit: the plain island.
      expectOutput(is, 4 * Q, is.sumOfLoops({c1, a, b}), "the plain island before edits");
      const int64_t pa = posmod(is.origin(a) - is.epoch(), 4 * Q);
      auto invariant = [&](const char* after) {
        expectEquals(posmod(is.origin(a) - is.epoch(), 4 * Q), pa,
                     juce::String("A keeps its phase after ") + after);
        expectEquals(posmod(is.origin(c1) - is.epoch(), Q), (int64_t)0,
                     juce::String("c1 keeps its phase after ") + after);
        expectEquals(posmod(is.epoch(), Q), posmod(is.origin(c1), Q),
                     juce::String("the Q grid is untouched after ") + after);
      };
      // B's law under whatever map it has: the stored origin + its map.
      auto lawAll = [&](const timing::TimeMap* mb) {
        return [&, mb](int64_t t) {
          float s = is.loopVal(c1, t) + is.loopVal(a, t);
          if (mb == nullptr) return s + is.loopVal(b, t);
          return s + is.val(b, timing::innerAt(t, is.o(b), *mb, mb->period()).inner);
        };
      };
      for (int64_t phase : {Q / 2 + 333, 3 * Q + 777, 2 * Q + 51}) {
        is.driveToPhase(posmod(phase, 4 * Q));
        is.drive(100);
        is.window(b, Q, 3 * Q);
        invariant("window [1Q,3Q)");
        // The window drawn after an earlier clear-from-bypassed must be
        // ACTIVE (S34 found the stale bypass: "whole" drops it).
        expect(is.bprop(b, "windowActive"), "the new window is active");
        expect(!is.bprop(b, "loopBypassed"), "no stale bypass survives a clear");
        timing::TimeMap w = timing::TimeMap::single(Q, 3 * Q);
        // Each lane alone (solo is a gain, not a clock) — the sum's
        // verdict is hard to attribute otherwise. The solo lands at the
        // next block top: skip one.
        auto alone = [&](const juce::String& id, std::function<float(int64_t)> law,
                         const juce::String& label) {
          is.engine.toggleSolo(id);
          expectOutput(is, 4 * Q, law, label, /*skip=*/BLOCK);
          is.engine.toggleSolo(id);
          is.drive(BLOCK);
        };
        alone(c1, [&](int64_t t) { return is.loopVal(c1, t); }, "c1 alone after the window");
        alone(a, [&](int64_t t) { return is.loopVal(a, t); }, "A alone after the window");
        alone(b, [&](int64_t t) {
          return is.val(b, timing::innerAt(t, is.o(b), w, w.period()).inner);
        }, "B alone after the window");
        expectOutput(is, 4 * Q, lawAll(&w), "law after the window");
        is.driveToPhase(posmod(phase + Q, 4 * Q));
        is.drive(100);
        timing::TimeMap m;
        m.n = 2;
        m.segs[0] = {0, Q};
        m.segs[1] = {2 * Q, 3 * Q};
        is.engine.setSegments(b, m);
        invariant("cut bands");
        expectOutput(is, 4 * Q, lawAll(&m), "law after the cut");
        is.engine.toggleLoopWindow(b);
        invariant("bypass");
        is.engine.setLoopPoints(b, 0, 0);  // clear: shapes nothing, re-bases nothing
        invariant("clear");
        expectEquals(is.cycle(), 4 * Q, "whole again");
        expectOutput(is, 4 * Q, lawAll(nullptr), "law after the clear");
      }
      // Undo the whole chain: every step keeps the invariant.
      int n = 0;
      while (is.engine.canUndo() && n++ < 20) {
        is.engine.undo();
        invariant("undo");
      }
    }

    // ------------------------------------------------------------------
    beginTest("S35: nested maps — a member's own window inside a windowed "
              "group composes (the group folds the clock, the member folds "
              "it again on its own map); move the inner, bypass the outer");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String g = is.createStack();
      const juce::String a = is.record(4 * Q, g);
      is.driveToPhase(Q);
      const juce::String b = is.record(2 * Q, g);
      is.window(a, Q, 3 * Q);  // the member's own window (2Q)
      expectEquals(is.cycle(), 2 * Q, "lcm(1Q, 2Q, 2Q)");
      is.window(g, 0, Q);      // the group's window over its 2Q composite
      expectEquals(is.cycle(), Q, "the group presents 1Q");
      auto law = [&](int64_t ws_a, int64_t we_a, bool outer) {
        return [&, ws_a, we_a, outer](int64_t t) {
          const int64_t Og = is.origin(g);
          int64_t tc = t;
          if (outer) {
            const auto at = timing::innerAt(t, Og, timing::TimeMap::single(0, Q), Q);
            tc = Og + at.inner;
          }
          const timing::TimeMap ma = timing::TimeMap::single(ws_a, we_a);
          const int64_t ia = timing::innerAt(tc, is.o(a), ma, ma.period()).inner;
          return is.loopVal(c1, t) + is.val(a, ia) + is.val(b, posmod(tc - is.o(b), 2 * Q));
        };
      };
      expectOutput(is, 4 * Q, law(Q, 3 * Q, true), "composed: group map, then the member's");
      is.drive(Q + 321);
      is.window(a, 2 * Q, 4 * Q);  // move the INNER window under the outer
      expectOutput(is, 4 * Q, law(2 * Q, 4 * Q, true), "inner moved");
      is.engine.toggleLoopWindow(g);  // bypass the OUTER
      expectEquals(is.cycle(), 2 * Q, "the member's window alone");
      expectOutput(is, 4 * Q, law(2 * Q, 4 * Q, false), "outer bypassed: the inner alone");
    }

    // ------------------------------------------------------------------
    beginTest("S36: seek over maps and groups — cut bands, a windowed "
              "clip, a windowed group: the render is invariant, sample for "
              "sample at equal phase");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, Q};
      m.segs[1] = {2 * Q, 3 * Q};
      is.engine.setSegments(c2, m);
      const juce::String c3 = is.record(3 * Q);
      is.window(c3, Q, 2 * Q);
      const juce::String g = is.createStack();
      is.driveToPhase(3 * Q);
      const juce::String a = is.record(4 * Q, g);
      is.window(g, Q, 3 * Q);
      const int64_t C = is.cycle();
      expect(C > 0, "an island cycle");
      // Land EXACTLY on the cycle top (a block past it would leave the
      // two runs misaligned by whatever the block overshot).
      auto toTop = [](Island& i) {
        const int64_t Ci = i.cycle();
        i.drive(posmod(-(i.clock - i.epoch()), Ci));
      };
      toTop(is);
      std::vector<std::pair<int64_t, float>> before, after;
      is.drive(C, &before);
      expect(is.engine.seekTransport((double)(5 * Q % C)), "seek accepted");
      toTop(is);
      is.drive(C, &after);
      int bad = 0;
      for (size_t i = 0; i < before.size() && i < after.size(); ++i)
        if (std::abs(before[i].second - after[i].second) > 2.0e-7f) ++bad;
      expectEquals(bad, 0, "the same island phase renders the same samples after the seek");
      juce::ignoreUnused(c1, c2, c3, a);
    }

    // ------------------------------------------------------------------
    beginTest("S37: a rich session round trip — cut bands, a windowed clip, "
              "an anchored windowed group, a one-shot, a gated root song: "
              "every fact and the render survive a fresh engine's load");
    {
      Island a;
      const juce::String c1 = a.record(Q);
      const juce::String c2 = a.record(5 * Q);
      timing::TimeMap m;
      m.n = 3;
      m.segs[0] = {0, Q};
      m.segs[1] = {2 * Q, 3 * Q};
      m.segs[2] = {4 * Q, 5 * Q};
      a.engine.setSegments(c2, m);
      const juce::String c3 = a.record(3 * Q);
      a.window(c3, Q, 2 * Q);
      const juce::String g = a.createStack();
      a.driveToPhase(2 * Q);
      const juce::String ga = a.record(4 * Q, g);
      a.window(g, Q, 3 * Q);
      a.driveToPhase(2 * Q);
      const juce::String c5 = a.record(Q);
      a.engine.setPeriodSource(c5, PeriodSource::CONTEXT_CYCLE);
      const int64_t C = a.cycle();
      a.engine.setSequence(a.rootId(), seqPayload({{C}, {C}}, {{c1, {true, false}}}));
      expectEquals(a.cycle(), 2 * C, "the song is the cycle");
      auto dir = test_utils::freshTempDir("scenario_s37");
      expect(a.engine.saveSession(dir.getFullPathName()), "saved");
      Island b;
      expect(b.engine.loadSession(dir.getFullPathName()), "loaded");
      b.captured = a.captured;
      expectEquals(b.Q(), a.Q(), "Q");
      expectEquals(b.cycle(), a.cycle(), "cycle");
      for (const auto& id : {c1, c2, c3, ga, c5}) {
        expectEquals(b.dur(id), a.dur(id), "duration " + id);
        expectEquals(b.origin(id) - b.epoch(), a.origin(id) - a.epoch(), "frame place " + id);
        expectEquals(b.iprop(id, "loopStart"), a.iprop(id, "loopStart"), "loopStart " + id);
        expectEquals(b.iprop(id, "loopEnd"), a.iprop(id, "loopEnd"), "loopEnd " + id);
        expectEquals(b.sprop(id, "periodSource"), a.sprop(id, "periodSource"), "periodSource " + id);
      }
      auto segsOf = [](Island& is, const juce::String& id) {
        const juce::var s = is.state();
        std::function<juce::var(const juce::var&)> find = [&](const juce::var& n) -> juce::var {
          if (n.getProperty("id", "").toString() == id) return n.getProperty("segments", juce::var());
          if (auto* kids = n.getProperty("nodes", juce::var()).getArray())
            for (const auto& k : *kids) {
              const juce::var hit = find(k);
              if (!hit.isVoid()) return hit;
            }
          return {};
        };
        return juce::JSON::toString(find(s), true);
      };
      expectEquals(segsOf(b, c2), segsOf(a, c2), "the cut bands persist");
      expect(b.bprop(g, "anchored"), "the group is anchored after load");
      expectEquals(b.origin(g) - b.epoch(), a.origin(g) - a.epoch(), "the group's frame place");
      expectEquals(b.iprop(g, "loopStart"), Q, "the group's window persists");
      expect(b.state().getProperty("sequence", juce::var()).isObject(), "the root song persists");
      if (!b.engine.isPlaying()) b.engine.togglePlayback();
      // The render: both islands from EXACTLY their cycle top, sample
      // for sample.
      auto toTop = [](Island& i) {
        const int64_t Ci = i.cycle();
        i.drive(posmod(-(i.clock - i.epoch()), Ci));
      };
      std::vector<std::pair<int64_t, float>> ra, rb;
      toTop(a);
      a.drive(2 * C, &ra);
      toTop(b);
      b.drive(2 * C, &rb);
      int bad = 0;
      for (size_t i = 0; i < ra.size() && i < rb.size(); ++i)
        if (std::abs(ra[i].second - rb[i].second) > 2.0e-7f) ++bad;
      expectEquals(bad, 0, "the loaded island renders the same song");
    }

    // ------------------------------------------------------------------
    beginTest("S38: a multi-mic group take at a mid-cycle phase — one "
              "origin for every mic; the group's window maps them all; a "
              "mic deleted and restored leaves the rest in place");
    {
      Island is;
      const juce::String c1 = is.record(Q);
      const juce::String c2 = is.record(4 * Q);
      is.driveToPhase(2 * Q);
      const juce::String kit = is.recordGroup(3, 4 * Q);
      const juce::StringArray mics = is.childIds(kit);
      expectEquals(mics.size(), 3, "three mics");
      for (const auto& mic : mics) {
        expectEquals(is.origin(mic), is.origin(mics[0]), "one origin for the performance");
        expectEquals(is.dur(mic), 4 * Q, "4Q each");
      }
      expectEquals(posmod(is.origin(kit) - is.epoch(), 4 * Q), 2 * Q, "the kit sits at 2Q");
      is.window(kit, Q, 3 * Q);
      expectEquals(is.cycle(), 4 * Q, "lcm(1Q, 4Q, 2Q)");
      auto law = [&](const juce::StringArray& live) {
        return [&, live](int64_t t) {
          const int64_t Ok = is.origin(kit);
          const int64_t tc = Ok + timing::innerAt(t, Ok, timing::TimeMap::single(Q, 3 * Q), 2 * Q).inner;
          float s = is.loopVal(c1, t) + is.loopVal(c2, t);
          for (const auto& mic : live) s += is.val(mic, posmod(tc - is.o(mic), 4 * Q));
          return s;
        };
      };
      expectOutput(is, 8 * Q, law(mics), "every mic reads the group's mapped clock");
      const int64_t kitRel = is.origin(kit) - is.epoch();
      is.engine.deleteNode(mics[1]);
      juce::StringArray two;
      two.add(mics[0]);
      two.add(mics[2]);
      expectEquals(is.origin(kit) - is.epoch(), kitRel, "the kit stays anchored where it was");
      expectOutput(is, 8 * Q, law(two), "the remaining mics keep their phase");
      is.engine.undo();
      expectOutput(is, 8 * Q, law(mics), "the mic returns in phase");
    }
  }
};

static ScenarioTests scenarioTests;

}  // namespace celestrian
