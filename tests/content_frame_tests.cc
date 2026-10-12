/**
 * CONTENT-FRAME tests — "which buffer sample is heard".
 *
 * Every node owns its origin and a map selects BUFFER coordinates
 * (Q18, composition.md §0/§8; the anchoring law, time_maps.md §5): a
 * window or segment map on a clip or a stack picks material by buffer
 * position, anchored at the node's own origin, so nothing selects
 * content through the island zero and a zero move on its own never
 * changes what sounds. These tests pin that at the audio output:
 *   - a definer stack's re-trim selects buffer samples [start, end)
 *     (multi-segment: the buffer segments), moving the definer's
 *     origin — and its members' — together with the zero;
 *   - heard_index.h, the message-thread solver every phase-preserving
 *     edit reads, equals the render;
 *   - a seek keeps a windowed group's content selection.
 *
 * Method (scenario::Island): the input is a ramp keyed by the clock, so
 * every recorded sample names its own buffer index, and a render is
 * decoded against the index a law expects. No pan law, latency or gain
 * constant needs to be known.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/heard_index.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::BLOCK;
using scenario::Island;
using scenario::posmod;

class ContentFrameTests : public juce::UnitTest {
 public:
  ContentFrameTests() : juce::UnitTest("Content frame (which sample is heard)") {}

  using Render = std::vector<std::pair<int64_t, float>>;

  /** Samples of `out` that are not every take in `takes` sounding its
   * buffer index heard_index(t). */
  int mismatches(Island& is, const juce::StringArray& takes, const Render& out,
                 const std::function<int64_t(int64_t)>& heard_index) {
    int bad = 0;
    for (const auto& [t, v] : out) {
      const int64_t index = heard_index(t);
      float want = 0.0f;
      for (const auto& id : takes) want += is.val(id, index);
      if (std::abs(want - v) > 2.0e-7f) ++bad;
    }
    return bad;
  }

  void runTest() override {
    const int64_t D = 40000;  // one take, under 1 s at 44.1k

    /** A first group take of D samples by two mics — the island's
     * definer — then one more pass, so an edit lands mid-phase. */
    auto recordDefinerGroup = [&](Island& is) {
      const juce::String stack_id = is.recordGroup(2, D);
      is.drive(D + BLOCK);
      return stack_id;
    };

    beginTest("Definer stack re-trim: the window selects BUFFER samples [start, end)");
    {
      Island is;
      const juce::String stack_id = recordDefinerGroup(is);
      const juce::StringArray ids = is.childIds(stack_id);
      expectEquals(is.dur(ids[0]), D, "the whole take committed at its own length");
      expectEquals(is.Q(), D, "Q := D");
      const int64_t origin0 = is.origin(ids[0]);

      // Trim the group to [ws, we): Q := len. Phase-preserving: the
      // sample sounding at the moment of the edit keeps sounding
      // (folded into the window), and from there the heard index
      // advances through [ws, we) — buffer coordinates, exactly what
      // the brackets over the raw take say.
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      const int64_t t0 = is.clock;
      const int64_t p0 = posmod(t0 - origin0, D);
      const int64_t pT = ws + posmod(p0 - ws, len);
      is.window(stack_id, ws, we);
      expectEquals(is.Q(), len, "Q := window length");
      Render out;
      is.drive(2 * len, &out);
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     return ws + posmod(pT - ws + (t - t0), len);
                   }),
                   0, "heard = buffer[ws + phase] (continuous at the edit)");

      // The published cursor agrees with the audio: masterPos is the
      // window phase, and the UI maps it to ws + phase.
      expectEquals(ws + is.masterPos(),
                   ws + posmod(pT - ws + (is.clock - t0), len),
                   "cursor phase = heard phase");

      // A SECOND trim (left bracket moves right) does not compound: the
      // loop never drifts by `start` per release.
      const int64_t ws2 = D / 2, we2 = (7 * D) / 8, len2 = we2 - ws2;
      const int64_t t1 = is.clock;
      // Heard index right before the second edit, by the FIRST window's law.
      const int64_t q0 = ws + posmod(t1 - is.zero(), len);
      const int64_t qT = ws2 + posmod(q0 - ws2, len2);
      is.window(stack_id, ws2, we2);
      out.clear();
      is.drive(2 * len2, &out);
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     return ws2 + posmod(qT - ws2 + (t - t1), len2);
                   }),
                   0, "second trim: still buffer coordinates, continuous");

      // Members stay one take (definer detection needs equal origins).
      expectEquals(is.origin(ids[0]), is.origin(ids[1]),
                   "members share one origin after re-anchoring");
      // Undo restores the previous frame exactly: the first window's
      // content selection comes back.
      is.engine.undo();
      expectEquals(is.iprop(stack_id, "loopStart"), ws, "undo: first window back");
      const int64_t t2 = is.clock;
      const int64_t r0 = ws + posmod(t2 - is.zero(), len);
      out.clear();
      is.drive(len, &out);
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     return ws + posmod(r0 - ws + (t - t2), len);
                   }),
                   0, "after undo: window [ws, we) selects buffer [ws, we)");
    }

    beginTest("Definer stack MULTI-SEGMENT re-trim: the map selects buffer segments");
    {
      // The punch/cell twin of the window trim: a two-segment map on the
      // definer stack re-establishes Q := its period and — content-frame
      // law — the members' origins ride, so the segments name BUFFER
      // material and the walk is exact.
      Island is;
      const juce::String stack_id = recordDefinerGroup(is);
      const juce::StringArray ids = is.childIds(stack_id);

      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {5000, 15000};
      m.segs[1] = {20000, 30000};
      const int64_t P = 20000;
      is.engine.setSegments(stack_id, m);
      expectEquals(is.Q(), P, "Q := the map period");
      const int64_t zero1 = is.zero();
      for (const auto& id : ids) {
        // Q18: the map anchors at the stack's origin + mapOffset(0); the
        // members moved with their group (origin == the stack's).
        expectEquals(is.origin(id), zero1 - m.segs[0].start,
                     "members' origins == stack origin == zero - a0");
        expectEquals(is.origin(stack_id), is.origin(id),
                     "the stack carries the same origin");
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "members whole (no window)");
      }
      Render out;
      is.drive(2 * P, &out);
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     const int64_t h = posmod(t - zero1, P);
                     return h < 10000 ? 5000 + h : 20000 + (h - 10000);
                   }),
                   0, "heard walks the segments in buffer coordinates");
    }

    beginTest("heard_index.h equals the render (windowed clip, windowed group)");
    {
      // THE SOLVER IS THE RENDER: every phase-preserving edit computes
      // "which sample sounds now" through heard_index.h; this pins that
      // statement against the audio thread's actual output.
      Island is;
      // A windowed sole clip (Q13 clip trim re-anchors its origin).
      const juce::String c = is.record(D);
      is.drive(D + BLOCK);
      is.window(c, D / 5, (4 * D) / 5);
      auto* clip = dynamic_cast<ClipNode*>(is.nodePtr(c));
      expect(clip != nullptr, "clip node");
      Render out;
      is.drive(D, &out);
      const heard::Scope scope = is.engine.rootScope();
      expectEquals(mismatches(is, juce::StringArray(c), out, [&](int64_t t) {
                     return heard::nodeInner(*clip, t, scope);
                   }),
                   0, "nodeInner(clip, t) names the rendered sample");
    }
    {
      Island is;
      const juce::String stack_id = recordDefinerGroup(is);
      const juce::StringArray ids = is.childIds(stack_id);
      is.window(stack_id, D / 3, (2 * D) / 3);
      auto* member = dynamic_cast<ClipNode*>(is.nodePtr(ids[0]));
      expect(member != nullptr, "member node");
      Render out;
      is.drive(D, &out);
      // THE DESCENT: nodeInner composes the group's map through
      // receivedAt — no per-depth equation, the same call at any depth.
      const heard::Scope scope = is.engine.rootScope();
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     return heard::nodeInner(*member, t, scope);
                   }),
                   0, "nodeInner(member, t) names the rendered sample");
    }

    beginTest("heard_index.h equals the render (one-shot group, windowed member)");
    {
      // A one-shot group's SHOT is its own period by the period law -
      // here the member's 2Q window, not the 8Q take behind it - fired
      // once per 3Q scope cycle, resting for the last Q. The solver and
      // the audio thread must fold the member's clock the same way.
      const int64_t Q = 1000;
      const int64_t take = 8 * Q;
      const auto content = [&](int64_t i) {
        return 0.1f + 0.8f * (float)i / (float)take;
      };
      StackNode root("Island");
      root.setQuantum(Q, 0);
      // A silent bass: the 3Q cycle.
      root.addChild(test_utils::committedClip("Bass", 44100.0, 3 * Q, 0.0f));
      auto kit = std::make_unique<StackNode>("Kit");
      StackNode* kit_raw = kit.get();
      kit->period_from_context_.store(true);
      auto mic = test_utils::committedClip("Mic", 44100.0, take, content);
      ClipNode* mic_raw = mic.get();
      mic->setLoopPoints(Q, 3 * Q);
      kit->addChild(std::move(mic));
      root.addChild(std::move(kit));

      Render out;
      heard::Scope scope;
      const auto drive = [&](int64_t from, int64_t total, bool keep) {
        std::vector<float> l((size_t)BLOCK), r((size_t)BLOCK);
        float* outs[] = {l.data(), r.data()};
        for (int64_t t = from; t < from + total; t += BLOCK) {
          std::fill(l.begin(), l.end(), 0.0f);
          std::fill(r.begin(), r.end(), 0.0f);
          auto play = test_utils::contextFor(root, BLOCK, t);
          play.ctx.is_playing = true;
          scope = {play.ctx.frame_top, play.ctx.context_cycle, play.ctx.quantum};
          root.process(nullptr, outs, 0, 2, play.ctx);
          if (keep)
            for (int i = 0; i < BLOCK; ++i) out.push_back({t + i, l[(size_t)i]});
        }
      };
      drive(0, BLOCK, false);       // the commit block renders silent
      drive(BLOCK, 18 * BLOCK, true);  // three scope cycles and more
      int bad = 0, resting = 0, sounding = 0;
      for (const auto& [t, v] : out) {
        const bool rest = heard::nodeInnerAt(*kit_raw, t, scope).rest;
        const float want =
            rest ? 0.0f : content(heard::nodeInner(*mic_raw, t, scope));
        if (std::abs(want - v) > 1e-6f) ++bad;
        ++(rest ? resting : sounding);
      }
      expect(resting > 0 && sounding > 0, "the span covers shots and rests");
      expectEquals(bad, 0,
                   "the solver names the rendered sample, and the rest, at "
                   "every firing");
    }

    beginTest("Seek keeps a windowed group's content selection");
    {
      Island is;
      const juce::String stack_id = recordDefinerGroup(is);
      const juce::StringArray ids = is.childIds(stack_id);
      const int64_t ws = D / 4, we = (3 * D) / 4, len = we - ws;
      is.window(stack_id, ws, we);
      is.drive(len);
      // Seek to window phase len/3: heard = ws + len/3 from here.
      const int64_t target = len / 3;
      expect(is.seekToPhase(target), "seek accepted");
      const int64_t t0 = is.clock;
      Render out;
      is.drive(len, &out);
      expectEquals(mismatches(is, ids, out, [&](int64_t t) {
                     return ws + posmod(target + (t - t0), len);
                   }),
                   0, "the window still selects buffer [ws, we); phase = target");
    }
  }
};

static ContentFrameTests contentFrameTests;

}  // namespace celestrian
