/**
 * Provisional-Q mutability (design_language.md Q13, non-sticky) + its
 * undo integration.
 *
 * One derived rule: Q is re-establishable while the island has exactly
 * ONE committed clip; locked while ≥2; reverts at 0. All three
 * transitions ride the edit log so undo restores the GRID, not just the
 * clip/window.
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::nodesOf;
using test_utils::recordClip;

namespace {
int64_t islandQ(AudioEngine& e) {
  return (int64_t)(double)e.getGraphState().getProperty("quantum", 0);
}
int64_t islandEp(AudioEngine& e) {
  return (int64_t)(double)e.getGraphState().getProperty("epoch", 0);
}
int64_t clipProp(AudioEngine& e, const juce::String& uuid, const char* prop) {
  const juce::var s = e.getGraphState();  // hold: getArray() dangles past it
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid)
        return (int64_t)(double)x.getProperty(prop, 0);
  return 0;
}
int64_t clipOrigin(AudioEngine& e, const juce::String& uuid) {
  return clipProp(e, uuid, "origin");
}
}  // namespace

class QTimeLockTests : public juce::UnitTest {
 public:
  QTimeLockTests() : juce::UnitTest("Provisional Q mutability (Q13)") {}

  void runTest() override {
    const int Q = 44100;
    const int BLOCK = 512;
    std::vector<float> buf(BLOCK, 0.1f);  // nonzero so takes commit >0

    auto makeProcess = [&](AudioEngine& e) {
      return [&e, &buf, BLOCK](int total) {
        float* ins[] = {buf.data()};
        float* outs[] = {buf.data(), buf.data()};
        int remaining = total;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK);
          e.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
    };

    beginTest(
        "sole clip: loop re-trim re-establishes (Q, epoch); undo restores");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);  // ~1Q take
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expect(q0 > 0, "Q established by the sole take");

      // Trim to a sub-window [ws, ws+len): Q := len, epoch := origin+ws.
      // (The trim RE-ANCHORS origin for phase continuity, so read it
      // back after the edit.)
      const int64_t ws = 5000, len = 30000;
      engine.setLoopPoints(c1, ws, ws + len);
      expectEquals(islandQ(engine), len,
                   "Q re-established to the window length");
      expectEquals(islandEp(engine), clipOrigin(engine, c1) + ws,
                   "epoch := origin + window start");

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores the old Q");
      expectEquals(islandEp(engine), ep0, "undo restores the old epoch");

      engine.redo();
      expectEquals(islandQ(engine), len, "redo re-applies the re-trim");
    }

    beginTest("a 2nd committed clip LOCKS Q (re-trim is a no-op to Q)");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t qLocked = islandQ(engine);
      recordClip(engine, process, 2 * Q);  // 2nd take → count 2 → locked
      expectEquals(islandQ(engine), qLocked, "Q unchanged by the 2nd commit");

      engine.setLoopPoints(c1, 1000, 20000);  // would re-trim if provisional
      expectEquals(islandQ(engine), qLocked,
                   "locked: loop drag does not move Q");
    }

    beginTest("delete the sole Q-definer reverts Q; undo restores it");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expect(q0 > 0, "Q established");

      engine.deleteNode(c1);
      expectEquals(islandQ(engine), (int64_t)0, "Q reverts to unestablished");
      expectEquals(islandEp(engine), (int64_t)0, "epoch reverts");

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores Q with the clip");
      expectEquals(islandEp(engine), ep0, "undo restores epoch");

      engine.redo();
      expectEquals(islandQ(engine), (int64_t)0, "redo re-reverts");
    }

    beginTest("delete back down to one clip RE-OPENS Q (non-sticky)");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);      // Q := ~1Q
      auto c2 = recordClip(engine, process, 2 * Q);  // locks
      const int64_t qLocked = islandQ(engine);

      engine.setLoopPoints(c1, 0, 10000);  // locked: no effect on Q
      expectEquals(islandQ(engine), qLocked, "still locked with 2 clips");

      engine.deleteNode(c2);  // 2 → 1: Q untouched but re-opens
      expectEquals(islandQ(engine), qLocked, "delete 2→1 leaves Q as-is");

      engine.setLoopPoints(c1, 0, 12345);  // now provisional again
      expectEquals(islandQ(engine), (int64_t)12345,
                   "Q re-opened: re-trim moves it");
    }

    beginTest("LOCK-COLLAPSE: arming take 2 makes the trimmed region THE take");
    {
      // Owner ruling 2026-07-19: the trim is a PRE-LOCK affordance —
      // once you build on it, clip 1 reads as if it was performed
      // exactly (duration = Q, origin = epoch, window consumed). The
      // looper is normal again; no incommensurate buffer survives to
      // poison arm boundaries / context loops / LCMs (field: take 2
      // anchored at origin − epoch = 56298 ∉ Q·Z).
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t dur0 = clipProp(engine, c1, "duration");

      const int64_t ws = 5000, len = 30000;
      engine.setLoopPoints(c1, ws, ws + len);  // provisional trim: Q := len
      const int64_t originT = clipOrigin(engine, c1);  // post-re-anchor

      // Take 2 through the real flow — the arm inside triggers collapse.
      auto c2 = recordClip(engine, process, 2 * len);

      expectEquals(clipProp(engine, c1, "duration"), len,
                   "clip 1 collapsed: the window IS the take");
      expectEquals(clipOrigin(engine, c1), originT + ws,
                   "clip 1 origin = the trimmed loop's top");
      // Commit may RE-BASE the epoch (simple-extension rule) — but only
      // by whole cycles of the trimmed grid: phase is preserved.
      const int64_t ep1 = islandEp(engine);
      expectEquals((((ep1 - (originT + ws)) % len) + len) % len, (int64_t)0,
                   "epoch stays on the trimmed grid");
      expectEquals(islandQ(engine), len, "Q unmoved");
      expectEquals(clipProp(engine, c1, "loopStart"), (int64_t)0,
                   "window consumed (full span)");
      expectEquals(clipProp(engine, c1, "loopEnd"), len, "…");

      // THE regression: take 2 lands ON the grid.
      const int64_t rel = clipOrigin(engine, c2) - islandEp(engine);
      expectEquals(((rel % len) + len) % len, (int64_t)0,
                   "take 2 anchors on a Q boundary of the epoch grid");

      // Undo. Log order is [.., trim, Insert(c2), CollapseTake] — the
      // collapse rode the ARM, which happens after the take's create —
      // so the first undo uncollapses, the second removes c2.
      engine.undo();  // uncollapse
      engine.undo();  // remove c2
      expectEquals(clipProp(engine, c1, "duration"), dur0,
                   "undo restores the full buffer");
      expectEquals(clipOrigin(engine, c1), originT, "…and the origin");
      expectEquals(clipProp(engine, c1, "loopStart"), ws,
                   "…and the trim window");
      expectEquals(clipProp(engine, c1, "loopEnd"), ws + len, "…");
      engine.redo();  // re-insert c2
      engine.redo();  // re-collapse
      expectEquals(clipProp(engine, c1, "duration"), len, "redo re-collapses");
    }

    beginTest(
        "RE-OPEN uncollapses: deleting take 2 restores the trimmed-away "
        "material");
    {
      // Owner report 2026-07-19c: after building on a trim and deleting
      // back down to one clip, the trim view returned but the dead air
      // was gone — you couldn't trim LONGER. Re-open now uncollapses
      // the survivor (audio-neutral: the restored window plays the
      // identical loop), riding the same Remove edit.
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t dur0 = clipProp(engine, c1, "duration");
      const int64_t ws = 5000, len = 30000;
      engine.setLoopPoints(c1, ws, ws + len);
      auto c2 = recordClip(engine, process, 2 * len);  // arm collapses c1
      expectEquals(clipProp(engine, c1, "duration"), len, "locked: collapsed");

      engine.deleteNode(c2);  // 2 → 1: re-open ⟹ uncollapse
      expectEquals(clipProp(engine, c1, "duration"), dur0,
                   "full buffer restored — trimming longer is possible again");
      expectEquals(clipProp(engine, c1, "loopStart"), ws,
                   "the trim survives as the window");
      expectEquals(clipProp(engine, c1, "loopEnd"), ws + len, "…");
      expectEquals(islandQ(engine), len,
                   "Q untouched (still the trimmed loop)");

      engine.undo();  // re-insert c2 AND re-collapse c1 (uuid2 rider)
      expectEquals(clipProp(engine, c1, "duration"), len,
                   "undo of the delete re-collapses the definer");
      engine.redo();  // delete again → uncollapse re-derives
      expectEquals(clipProp(engine, c1, "duration"), dur0,
                   "redo re-opens and uncollapses");
    }

    beginTest("phase-preserving trim: the sounding position never jumps");
    {
      // Owner report 2026-07-19c: nudging the loop region reset
      // playback. The provisional grid is free, so a trim re-anchors
      // the clip's origin such that the buffer position sounding at the
      // edit moment is unchanged (folded into the new window if it fell
      // outside). masterPos maps back to buffer position as
      // loopStart + view — continuity is exact, no processing between
      // the measurement and the edit.
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      process(12345);  // put the phase somewhere nonzero
      auto viewPos = [&] {
        const juce::var s = engine.getGraphState();
        return (int64_t)(double)s.getProperty("masterPos", 0);
      };
      const int64_t p0 = clipProp(engine, c1, "loopStart") + viewPos();

      const int64_t ws = 5000, len = 30000;
      engine.setLoopPoints(c1, ws, ws + len);
      const int64_t p1 = clipProp(engine, c1, "loopStart") + viewPos();
      const int64_t expect1 = ws + (((p0 - ws) % len) + len) % len;
      expectEquals(p1, expect1, "position continuous (folded into the window)");

      // A small nudge that keeps the current position inside the window
      // must not move it at all.
      engine.setLoopPoints(c1, ws - 2000, ws - 2000 + len);
      const int64_t p2 = clipProp(engine, c1, "loopStart") + viewPos();
      expectEquals(p2, p1, "nudge: the sounding position does not move");
    }

    beginTest(
        "windowed playback anchors at origin + loopStart (epoch contract)");
    {
      // Q13's epoch := origin + loopStart names the trimmed loop's top
      // as island phase 0 — so at t = origin + loopStart the clip must
      // sound buffer[loopStart]. The old origin-anchored launch played
      // buffer[loopStart + (loopStart mod len)] there: a sub-Q trim put
      // the audible loop top at an arbitrary island phase, and the grid
      // every later take arms against pointed mid-loop.
      ClipNode clip("phase-clip");
      const int N = 1000;
      std::vector<float> ramp(N);
      for (int i = 0; i < N; ++i) ramp[i] = (float)i / N;  // content[j] = j/N
      float* ins[] = {ramp.data()};
      ProcessContext recCtx;
      recCtx.num_samples = N;
      recCtx.is_recording = true;
      clip.startRecording();
      clip.process(ins, nullptr, 1, 0, recCtx);
      clip.stopRecording();
      clip.origin_samples.store(100);

      const int64_t ws = 250, len = 400;  // ws mod len ≠ 0: discriminates
      clip.setLoopPoints(ws, ws + len);
      clip.startPlayback();

      auto sampleAt = [&](int64_t t) {
        // Distinct channel buffers: the clip SUMS into every output
        // channel, so aliased arrays double the sample.
        float outL[4] = {0.0f}, outR[4] = {0.0f};
        float* outs[] = {outL, outR};
        ProcessContext playCtx;
        playCtx.num_samples = 1;
        playCtx.is_playing = true;
        playCtx.master_pos = t;
        clip.process(nullptr, outs, 0, 2, playCtx);
        return outL[0];
      };
      // Loop top at its performance moment, and one period later.
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "island phase 0 sounds buffer[loopStart]");
      expectWithinAbsoluteError(sampleAt(100 + ws + len), ramp[ws], 1e-6f,
                                "…and every period after");
      // Mid-window content sounds at ITS performed moment (Audio Memory
      // applied to the surviving material).
      expectWithinAbsoluteError(sampleAt(100 + ws + 123), ramp[ws + 123], 1e-6f,
                                "buffer[ws+x] sounds at origin+ws+x");

      // LOCK-COLLAPSE (content base): the window becomes the take —
      // playback through content_base_ is sample-identical to the
      // windowed playback above, at the same island moments.
      clip.collapseToWindow(ws, len);
      expectEquals(clip.getIntrinsicDuration(), len, "duration = window len");
      expectEquals(clip.origin_samples.load(), (int64_t)100 + ws,
                   "origin = the old window top");
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "collapsed take: phase 0 = old loop top");
      expectWithinAbsoluteError(sampleAt(100 + ws + 123), ramp[ws + 123], 1e-6f,
                                "…content unchanged mid-take");
      clip.uncollapseFromWindow(ws, N);
      expectEquals(clip.getIntrinsicDuration(), (int64_t)N,
                   "uncollapse restores");
      expectEquals(clip.getLoopStart(), ws, "…including the trim");
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "…and playback is unchanged");
    }

    beginTest(
        "multi-segment re-trim of the sole definer re-establishes "
        "(Q := period, epoch := origin' + mapOffset(0)); undo restores");
    {
      // Phase 3 (owner-ruled fully fractal): punching a cell out of the
      // scratch loop before locking is the multi-segment twin of the
      // Q13 window trim — the island grid follows the map's PERIOD.
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);  // ~1Q take, Q established
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expect(q0 > 0, "Q established by the sole take");

      // Cells {[0, q0/4), [q0/2, 3q0/4)} → period q0/2.
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {0, q0 / 4};
      cells.segs[1] = {q0 / 2, (3 * q0) / 4};
      engine.setSegments(c1, cells);

      expectEquals(islandQ(engine), q0 / 2, "Q := the map period (Σ cells)");
      expectEquals(islandEp(engine), clipOrigin(engine, c1),
                   "epoch = origin' + mapOffset(0) (first cell at 0)");

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores the grid");
      expectEquals(islandEp(engine), ep0, "…and the epoch");
      engine.redo();
      expectEquals(islandQ(engine), q0 / 2, "redo re-establishes");

      // LOCK-COLLAPSE, multi-segment: arming take 2 SPLICES the kept
      // cells into THE take (duration = period, origin = the epoch, map
      // consumed); undo un-splices (full material + map return).
      auto segsOf = [&](const juce::String& id) {
        const juce::var s = engine.getGraphState();  // hold the var
        if (auto* n = nodesOf(s))
          for (auto& x : *n)
            if (x.getProperty("id", "").toString() == id)
              return x.getProperty("segments", juce::var());
        return juce::var();
      };
      expect(segsOf(c1).isArray(), "definer carries the cell map");
      const int64_t epBefore = islandEp(engine);
      recordClip(engine, process, (int)(q0 / 2));  // take 2 arms + commits
      expectEquals(clipProp(engine, c1, "duration"), q0 / 2,
                   "splice: definer duration = the map period");
      expectEquals(clipOrigin(engine, c1), epBefore,
                   "splice: origin = the epoch (anchoring law)");
      expect(!segsOf(c1).isArray(), "splice: map consumed");

      engine.undo();
      expectEquals(clipProp(engine, c1, "duration"), q0,
                   "un-splice: full material returns");
      expect(segsOf(c1).isArray(), "un-splice: the cell map returns");
    }
  }
};

static QTimeLockTests qtimeLockTests;

}  // namespace celestrian
