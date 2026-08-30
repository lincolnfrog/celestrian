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

// Q13 FOR GROUPS helpers (2026-08-21): walk the published tree.
juce::var findVar(const juce::var& node, const juce::String& id) {
  if (node.getProperty("id", "").toString() == id) return node;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
    for (auto& k : *kids) {
      juce::var hit = findVar(k, id);
      if (!hit.isVoid()) return hit;
    }
  }
  return {};
}
void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
  if (node.getProperty("type", "").toString() == "clip") {
    out.add(node.getProperty("id", "").toString());
    return;
  }
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
    for (auto& k : *kids) clipIdsUnder(k, out);
  }
}
juce::String lastTopLevelId(AudioEngine& e) {
  const juce::var state = e.getGraphState();
  auto* nodes = nodesOf(state);
  if (nodes == nullptr || nodes->isEmpty()) return {};
  return nodes->getLast().getProperty("id", "").toString();
}
double deepProp(AudioEngine& e, const juce::String& id, const char* prop) {
  const juce::var state = e.getGraphState();
  const juce::var node = findVar(state, id);
  return node.isVoid() ? 0.0 : (double)node.getProperty(prop, 0.0);
}
bool deepCommitted(AudioEngine& e, const juce::String& id) {
  const juce::var state = e.getGraphState();
  const juce::var node = findVar(state, id);
  return !node.isVoid() && !(bool)node.getProperty("isRecording", false) &&
         (double)node.getProperty("duration", 0.0) > 0.0;
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

    beginTest("RE-OPEN leaves an ORDINARY take alone (explicit collapse marker)");
    {
      // Audit 2026-08-30 §3.1: "was collapsed" used to be inferred from
      // write_position > duration — but every snapped take overshoots
      // its duration by up to a block, so deleting down to one ordinary
      // clip "uncollapsed" it to an off-grid recorded length.
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);
      const int64_t dur0 = clipProp(engine, c1, "duration");
      auto c2 = recordClip(engine, process, Q + 300);  // snaps; overshoots
      expectEquals(clipProp(engine, c1, "duration"), dur0, "untrimmed: no collapse");
      engine.deleteNode(c2);  // 2 -> 1 with a never-trimmed survivor
      expectEquals(clipProp(engine, c1, "duration"), dur0,
                   "the ordinary take keeps its snapped duration");
      expectEquals(clipProp(engine, c1, "loopStart"), (int64_t)0, "no phantom window");
      expectEquals(clipProp(engine, c1, "loopEnd"), dur0, "whole");
      expectEquals(islandQ(engine), dur0, "Q untouched");
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

      // TAKES ARE UNDOABLE (2026-08-20): the first undo removes take 2
      // itself (the log reads: CollapseTake, Take 2); the second
      // un-splices the definer.
      engine.undo();
      expectEquals(clipProp(engine, c1, "duration"), q0 / 2,
                   "first undo strips take 2; the splice stands");
      engine.undo();
      expectEquals(clipProp(engine, c1, "duration"), q0,
                   "un-splice: full material returns");
      expect(segsOf(c1).isArray(), "un-splice: the cell map returns");
    }

    // ---- Q13 FOR GROUPS (owner ruling 2026-08-21) ----
    // The fractal twin of the sole-clip definer: a first take recorded
    // as a GROUP (N mics, one origin, one duration) is the island's
    // definer; the STACK's window re-establishes (Q, epoch). The window
    // stays on the stack (it IS the part under the window law), the
    // children stay whole, and no lock-collapse follows.
    beginTest("GROUPS: a first group take is the Q-definer; its window re-defines Q");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      expectEquals(ids.size(), 2, "two mics");
      engine.startRecordingInNode(stack_id);
      process(4 * Q);
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 40; ++i) {
        if (deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1])) break;
        process(512);
      }
      expect(deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1]),
             "group take committed");
      const int64_t D = (int64_t)deepProp(engine, ids[0], "duration");
      const int64_t q0 = islandQ(engine), ep0 = islandEp(engine);
      expectEquals(q0, D, "the whole take is 1Q (first take)");
      process(12345);  // settle the recording view; phase somewhere nonzero

      // A fractional-Q window on the STACK: refused anywhere else, here
      // it re-establishes Q := len.
      const int64_t ws = D / 4, len = D / 2;
      // The inner position sounding NOW (masterPos is published wrapped
      // on the audible cycle = D before the trim).
      const int64_t p0 =
          (int64_t)(double)engine.getGraphState().getProperty("masterPos", 0);
      engine.setLoopPoints(stack_id, ws, ws + len);
      expectEquals(islandQ(engine), len, "Q := the group window length");
      expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), ws,
                   "window lives on the stack");
      expectEquals((int64_t)deepProp(engine, stack_id, "loopEnd"), ws + len,
                   "window end on the stack");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), D,
                     "children stay whole");
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), D,
                     "children windows untouched (full span)");
      }
      // PHASE CONTINUITY: the position sounding now folds into the new
      // window and does not move — heard = ws + masterPos' (wrapped on
      // len now) must equal ws + ((p0 - ws) mod len).
      {
        const int64_t mp1 =
            (int64_t)(double)engine.getGraphState().getProperty("masterPos", 0);
        const int64_t pT = ws + (((p0 - ws) % len) + len) % len;
        expectEquals(ws + mp1, pT,
                     "epoch solved for continuity (pos(t) = start + ((t - epoch) mod len))");
      }

      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores the old Q");
      expectEquals(islandEp(engine), ep0, "undo restores the old epoch");
      engine.redo();
      expectEquals(islandQ(engine), len, "redo re-applies");

      // Take 2 on a new top-level track: Q locks at len; the stack
      // window survives (no collapse); an incoherent trim is refused.
      engine.createNode("clip");
      const juce::String t2 = lastTopLevelId(engine);
      engine.startRecordingInNode(t2);
      process(2 * len);  // the arm pends to the next Q boundary, then 1Q
      engine.stopRecordingInNode(t2);
      for (int i = 0; i < 8 && !deepCommitted(engine, t2); ++i) process(len);
      expect(deepCommitted(engine, t2), "take 2 committed");
      expectEquals(islandQ(engine), len, "Q locked at the trimmed length");
      // GROUP LOCK-COLLAPSE (audit 2026-08-30 §3.5, the fractal twin of
      // the clip's): arming take 2 made the trimmed region THE take —
      // members are 1Q whole takes now, the stack window is consumed.
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), len,
                     "member collapsed to the window");
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), len, "member whole");
      }
      expect(!(deepProp(engine, stack_id, "loopEnd") > deepProp(engine, stack_id, "loopStart")),
             "stack window consumed by the collapse");
      engine.setLoopPoints(stack_id, 0, ws + len);  // past the inner cycle: refused
      expect(!(deepProp(engine, stack_id, "loopEnd") > 0),
             "locked: a window past the inner cycle is refused");
      engine.setLoopPoints(stack_id, 0, len / 2);  // Q/2: coherent, ordinary edit
      expectEquals((int64_t)deepProp(engine, stack_id, "loopEnd"), len / 2,
                   "locked: a coherent group trim lands");
      expectEquals(islandQ(engine), len, "and leaves Q alone");
      // RE-OPEN ⟹ UNCOLLAPSE, group twin: deleting take 2 restores the
      // full takes with the trim back on the stack.
      engine.setLoopPoints(stack_id, 0, 0);
      engine.deleteNode(t2);
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), D,
                     "re-open: full member takes restored");
      }
      expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), ws,
                   "re-open: the trim is the stack window again");
      expectEquals((int64_t)deepProp(engine, stack_id, "loopEnd"), ws + len, "…");
      engine.undo();  // re-insert take 2 AND re-collapse (uuid2 rider)
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), len,
                     "undo of the delete re-collapses the group");
      }
      engine.redo();
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), D,
                     "redo re-opens and uncollapses again");
      }
    }

    beginTest("GROUPS: two takes in one stack are not a definer");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      engine.startRecordingInNode(stack_id);
      process(2 * Q);
      engine.stopRecordingInNode(stack_id);
      process(4096);
      const int64_t D = islandQ(engine);
      expect(D > 0, "Q established");
      // A third mic later: a second take inside the same stack.
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      const juce::String c3 = ids[ids.size() - 1];
      engine.startRecordingInNode(c3);
      process(D);
      engine.stopRecordingInNode(c3);
      for (int i = 0; i < 80 && !deepCommitted(engine, c3); ++i) process(512);
      expect(deepCommitted(engine, c3), "third mic committed");
      engine.setLoopPoints(stack_id, 0, (3 * D) / 2);  // 1.5Q: incoherent
      expectEquals((int64_t)deepProp(engine, stack_id, "loopEnd"), (int64_t)0,
                   "not a definer: incoherent window refused");
      expectEquals(islandQ(engine), D, "Q untouched");
    }

    // ---- ONE ISLAND, ONE OWNER OF (Q, epoch) (field dump 2026-08-29) ----
    // Combine assembles the new stack DETACHED, so addChild stamped the
    // first committed child's duration/origin onto it as island facts.
    // Attached, the subtree then ran on that private grid: a delete-all
    // reverted the ROOT's Q, and the next group take inside the stack
    // committed against the stale one (immediate stop, Instant Stop
    // branch: loop region [0, Q_stale/2), origin on the stale grid).
    beginTest("NESTED FACTS: combine leaves no (Q, epoch) on the stack; a later first take establishes fresh");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      // Two committed clips at the top level (A defines Q).
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      process(3 * Q);
      engine.stopRecordingInNode(a);
      process(512);
      expectEquals(islandQ(engine), (int64_t)(3 * Q), "A establishes Q");
      engine.createNode("clip");
      const juce::String b = lastTopLevelId(engine);
      engine.startRecordingInNode(b);
      process(6 * Q);  // arm pends to the 3Q boundary, then a 3Q take
      engine.stopRecordingInNode(b);
      for (int i = 0; i < 400 && !deepCommitted(engine, b); ++i) process(512);
      expect(deepCommitted(engine, b), "B committed");
      const juce::String stack_id = engine.combineNodes(a, b);
      expect(stack_id.isNotEmpty(), "combined");
      expectEquals((int64_t)deepProp(engine, stack_id, "quantum"), (int64_t)0,
                   "the nested stack holds no island Q");
      expectEquals((int64_t)deepProp(engine, stack_id, "epoch"), (int64_t)0,
                   "nor an epoch");
      expectEquals(islandQ(engine), (int64_t)(3 * Q), "root Q untouched by the combine");
      // Delete both takes: the island empties, Q reverts.
      engine.deleteNode(a);
      engine.deleteNode(b);
      expectEquals(islandQ(engine), (int64_t)0, "delete-all reverts Q");
      // A new group take INSIDE the emptied stack is the island's first
      // take again: Q := its length, members whole.
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      expectEquals(ids.size(), 2, "two fresh mics");
      engine.startRecordingInNode(stack_id);
      process(2 * Q + 777);  // an off-grid length: nothing to snap to
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 40; ++i) {
        if (deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1])) break;
        process(512);
      }
      expect(deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1]),
             "group take committed");
      const int64_t L = (int64_t)deepProp(engine, ids[0], "duration");
      expect(L >= 2 * Q + 777, "committed at its own length (first take)");
      expectEquals(islandQ(engine), L, "Q := the take (no stale grid)");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "loopStart"), (int64_t)0,
                     "member window start");
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), L,
                     "member whole (no Q_stale/2 region)");
      }
    }

    // ---- MEMBERS WHOLE under the definer stack (2026-08-30) ----
    // A definer stack whose members carry their own windows (a group
    // take under a locked Q, then left as the only content): the
    // re-trim rides them whole, undoably.
    beginTest("GROUPS: a definer re-trim makes windowed members whole (undoable riders)");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      process(Q);
      engine.stopRecordingInNode(a);
      process(512);
      expectEquals(islandQ(engine), (int64_t)Q, "A establishes Q = 1Q");
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      engine.startRecordingInNode(stack_id);
      process(2 * Q + 4 * 512);
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 400; ++i) {
        if (deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1])) break;
        process(512);
      }
      expect(deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1]),
             "group take committed under the lock");
      const int64_t D = (int64_t)deepProp(engine, ids[0], "duration");
      expect(D >= 2 * Q, "a 2Q take");
      // Coherent 1Q windows on the members (allowed under the lock).
      for (const auto& id : ids) engine.setLoopPoints(id, 0, Q);
      for (const auto& id : ids)
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), (int64_t)Q,
                     "member window landed");
      // A goes: the stack is now the definer, its window on its members.
      engine.deleteNode(a);
      expectEquals(islandQ(engine), (int64_t)Q, "Q survives (2 clips remain)");
      const int64_t ws = D / 4, len = D / 2;
      engine.setLoopPoints(stack_id, ws, ws + len);
      expectEquals(islandQ(engine), len, "definer re-trim: Q := len");
      expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), ws,
                   "window on the stack");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "loopStart"), (int64_t)0,
                     "member start whole");
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), D,
                     "member made whole by the rider");
      }
      engine.undo();
      expectEquals(islandQ(engine), (int64_t)Q, "undo restores Q");
      expect(!(deepProp(engine, stack_id, "loopEnd") > deepProp(engine, stack_id, "loopStart")),
             "undo clears the stack window");
      for (const auto& id : ids)
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), (int64_t)Q,
                     "undo restores the member windows");
      engine.redo();
      expectEquals(islandQ(engine), len, "redo re-trims");
      for (const auto& id : ids)
        expectEquals((int64_t)deepProp(engine, id, "loopEnd"), D,
                     "redo makes members whole again");
    }

    // ---- FIVE MICS, REPEATED LEFT-EDGE TRIMS (field 2026-08-29/30) ----
    // The drum-kit case: five mics, one group take, then the left
    // bracket dragged right several times. Each release re-establishes
    // Q and re-anchors the members together; the END never moves, the
    // members stay one take (equal origins, so the stack stays the
    // definer and every fractional trim is accepted).
    beginTest("GROUPS: five mics, three left-edge trims: end holds, members stay one take");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      for (int i = 0; i < 5; ++i) engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      expectEquals(ids.size(), 5, "five mics");
      engine.startRecordingInNode(stack_id);
      process(3 * Q + 1234);  // an off-grid first take
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 40; ++i) {
        bool all = true;
        for (const auto& id : ids) all = all && deepCommitted(engine, id);
        if (all) break;
        process(512);
      }
      const int64_t D = (int64_t)deepProp(engine, ids[0], "duration");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), D, "one duration");
        expectEquals((int64_t)deepProp(engine, id, "origin"),
                     (int64_t)deepProp(engine, ids[0], "origin"), "one origin");
      }
      process(7777);
      // Three left-edge drags, the UI's arithmetic: start = frac * D,
      // end = the published loopEnd (D until a window exists).
      const double fracs[] = {0.2, 0.35, 0.5};
      int64_t end_sent = D;
      for (double f : fracs) {
        const int64_t start = (int64_t)std::llround(f * (double)D);
        engine.setLoopPoints(stack_id, start, end_sent);
        expectEquals((int64_t)deepProp(engine, stack_id, "loopStart"), start,
                     "start landed (fractional: accepted => still the definer)");
        expectEquals((int64_t)deepProp(engine, stack_id, "loopEnd"), end_sent,
                     "the END did not move");
        expectEquals(islandQ(engine), end_sent - start, "Q := len");
        for (const auto& id : ids) {
          expectEquals((int64_t)deepProp(engine, id, "origin"),
                       (int64_t)deepProp(engine, ids[0], "origin"),
                       "members re-anchored together");
          expectEquals((int64_t)deepProp(engine, id, "loopEnd"), D, "members whole");
        }
        expectEquals(islandEp(engine), (int64_t)deepProp(engine, ids[0], "origin"),
                     "epoch == members' origin (window names buffer samples)");
        end_sent = (int64_t)deepProp(engine, stack_id, "loopEnd");
        process(3333);
      }
    }

    // ---- GROUP STOP: one block top for every mic (audit 2026-08-30 §3.3) ----
    beginTest("GROUPS: a locked-Q group stop commits one duration for every mic");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      process(Q);
      engine.stopRecordingInNode(a);
      process(512);
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      for (int i = 0; i < 3; ++i) engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      engine.startRecordingInNode(stack_id);
      process(2 * Q + 300);
      engine.stopRecordingInNode(stack_id);  // parked generation, published once
      for (int i = 0; i < 400; ++i) {
        bool all = true;
        for (const auto& id : ids) all = all && deepCommitted(engine, id);
        if (all) break;
        process(512);
      }
      const int64_t D = (int64_t)deepProp(engine, ids[0], "duration");
      expect(D > 0 && D % Q == 0, "committed on the grid");
      for (const auto& id : ids) {
        expectEquals((int64_t)deepProp(engine, id, "duration"), D, "one duration");
        expectEquals((int64_t)deepProp(engine, id, "origin"),
                     (int64_t)deepProp(engine, ids[0], "origin"), "one origin");
      }
    }

    // ---- RIDERS CLEAR A MEMBER'S SEGMENT MAP (audit 2026-08-30 §3.6) ----
    beginTest("GROUPS: a definer re-trim wholes a member with a segment map (undoable)");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };
      engine.createNode("clip");
      const juce::String a = lastTopLevelId(engine);
      engine.startRecordingInNode(a);
      process(Q);
      engine.stopRecordingInNode(a);
      process(512);
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      {
        const juce::var state = engine.getGraphState();
        clipIdsUnder(findVar(state, stack_id), ids);
      }
      engine.startRecordingInNode(stack_id);
      process(4 * Q + 4 * 512);
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 400; ++i) {
        if (deepCommitted(engine, ids[0]) && deepCommitted(engine, ids[1])) break;
        process(512);
      }
      const int64_t D = (int64_t)deepProp(engine, ids[0], "duration");
      expect(D >= 4 * Q, "a 4Q take");
      // A coherent two-segment map on member 0 (period 2Q), authored
      // STOPPED: a map edit while playing re-anchors the member's
      // origin for continuity, which by itself ends the one-take
      // (equal origins) definer state — a separate, legitimate path.
      engine.togglePlayback();
      expect(!engine.isPlaying(), "stopped for the map edit");
      celestrian::timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, Q};
      m.segs[1] = {2 * Q, 3 * Q};
      engine.setSegments(ids[0], m);
      {
        const juce::var st = engine.getGraphState();
        const juce::var n0 = findVar(st, ids[0]);
        expect(n0.getProperty("segments", juce::var()).getArray() != nullptr,
               "segment map landed on the member");
      }
      engine.togglePlayback();
      engine.deleteNode(a);  // the stack is now the definer
      engine.setLoopPoints(stack_id, D / 4, (3 * D) / 4);
      expectEquals(islandQ(engine), D / 2, "definer branch ran (Q := len)");
      {
        const juce::var st = engine.getGraphState();
        const juce::var n0 = findVar(st, ids[0]);
        expect(n0.getProperty("segments", juce::var()).getArray() == nullptr,
               "rider cleared the member's segment map");
        expectEquals((int64_t)(double)n0.getProperty("loopEnd", 0.0), D, "member whole");
      }
      engine.undo();
      {
        const juce::var st = engine.getGraphState();
        const juce::var n0 = findVar(st, ids[0]);
        expect(n0.getProperty("segments", juce::var()).getArray() != nullptr,
               "undo restores the member's segment map");
      }
    }

    // ---- SEQUENCES TRACK Q (owner ruling 2026-08-21) ----
    // Step lengths are musical facts: a definer re-trim RESCALES them
    // (5Q stays 5Q); a revert to an empty island CLEARS them (field:
    // a surviving 5Q step read 6.52Q against the next take's Q).
    beginTest("SEQUENCES TRACK Q: re-trim rescales steps; empty island clears; undo restores");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, Q);  // 1Q take, Q := its length
      const int64_t q0 = islandQ(engine);
      expect(q0 > 0, "Q established");
      const juce::String rootId =
          engine.getGraphState().getProperty("id", "").toString();
      auto stepLens = [&]() {
        juce::Array<int64_t> out;
        const juce::var st = engine.getGraphState();
        const juce::var seq = st.getProperty("sequence", juce::var());
        if (auto* steps = seq.getProperty("steps", juce::var()).getArray())
          for (auto& x : *steps)
            out.add((int64_t)(double)x.getProperty("len", 0.0));
        return out;
      };
      {
        auto* payload = new juce::DynamicObject();
        juce::Array<juce::var> steps;
        auto* s1 = new juce::DynamicObject();
        s1->setProperty("name", "A");
        s1->setProperty("len", (double)(2 * q0));
        steps.add(juce::var(s1));
        auto* s2 = new juce::DynamicObject();
        s2->setProperty("name", "B");
        s2->setProperty("len", (double)(3 * q0));
        steps.add(juce::var(s2));
        payload->setProperty("steps", steps);
        payload->setProperty("gates", juce::var(new juce::DynamicObject()));
        engine.setSequence(rootId, juce::var(payload));
      }
      expectEquals(stepLens().size(), 2, "two steps (2Q + 3Q)");

      // Definer re-trim: Q := q0/2. The steps keep their Q values.
      engine.setLoopPoints(c1, 0, q0 / 2);
      expectEquals(islandQ(engine), q0 / 2, "Q re-established");
      {
        auto l = stepLens();
        expectEquals(l.size(), 2, "steps survive the re-trim");
        expectEquals(l[0], (int64_t)(2 * (q0 / 2)), "A is still 2Q");
        expectEquals(l[1], (int64_t)(3 * (q0 / 2)), "B is still 3Q");
      }
      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores Q");
      {
        auto l = stepLens();
        expectEquals(l[0], (int64_t)(2 * q0), "undo scales A back (2Q)");
        expectEquals(l[1], (int64_t)(3 * q0), "undo scales B back (3Q)");
      }

      // Empty the island: the sequence clears with Q; undo brings both.
      engine.deleteNode(c1);
      expectEquals(islandQ(engine), (int64_t)0, "island reverted");
      expectEquals(stepLens().size(), 0, "sequence cleared on an empty island");
      engine.undo();
      expectEquals(islandQ(engine), q0, "undo restores Q with the clip");
      expectEquals(stepLens().size(), 2, "undo restores the sequence");
      expectEquals(stepLens()[1], (int64_t)(3 * q0), "with its step lengths");
      engine.redo();
      expectEquals(stepLens().size(), 0, "redo clears again");
    }
  }
};

static QTimeLockTests qtimeLockTests;

}  // namespace celestrian
