/**
 * Provisional-Q mutability (design_language.md Q13, non-sticky) + its
 * undo integration.
 *
 * One derived rule: Q is re-establishable while the island has exactly
 * ONE committed clip; locked while ≥2; reverts at 0. All three
 * transitions ride the edit log so undo restores the GRID, not just the
 * clip/window.
 *
 * The sole-clip trim as sound (Q := the window, zero := origin + start,
 * the audio-neutral collapse and re-open) is scenario S9; the undo /
 * redo symmetry of every transition is undo_symmetry_tests.cc. These
 * cases pin the facts around them, off the Q grid and for groups.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::seqPayload;

namespace {

constexpr int64_t Q = 44100;

/** A take of about `len` samples in a fresh top-level clip: the arm,
 * 100 + `len` samples, the stop, then blocks until it commits. */
juce::String recordTake(Island& is, int64_t len) {
  return test_utils::recordClip(
      is.engine, [&is](int n) { is.drive(n); }, len);
}

/** The root's stored zero (0 while the island has no Q). */
int64_t storedZero(Island& is) { return is.rootProp("zero"); }

/** Whether node `id` publishes a multi-segment map. */
bool hasSegments(Island& is, const juce::String& id) {
  return is.node(id).getProperty("segments", juce::var()).isArray();
}

}  // namespace

class QTimeLockTests : public juce::UnitTest {
 public:
  QTimeLockTests()
      : juce::UnitTest("Provisional Q mutability (Q13)", "QTimeLock") {}

  void runTest() override {
    beginTest("a 2nd committed clip LOCKS Q; deleting back down to one clip "
              "RE-OPENS it (non-sticky)");
    {
      Island is;
      auto c1 = recordTake(is, Q);  // Q := ~1Q
      const int64_t q_locked = is.Q();
      auto c2 = recordTake(is, 2 * Q);  // 2nd take → count 2 → locked
      expectEquals(is.Q(), q_locked, "Q unchanged by the 2nd commit");

      is.window(c1, 0, 10000);  // would re-trim if provisional
      expectEquals(is.Q(), q_locked, "locked: a loop drag does not move Q");

      is.engine.deleteNode(c2);  // 2 → 1: Q untouched but re-opens
      expectEquals(is.Q(), q_locked, "delete 2->1 leaves Q as-is");

      is.window(c1, 0, 12345);  // now provisional again
      expectEquals(is.Q(), (int64_t)12345, "Q re-opened: re-trim moves it");
    }

    beginTest("LOCK-COLLAPSE: arming take 2 makes the trimmed region THE take");
    {
      // The trim is a PRE-LOCK affordance: once a take is built on it,
      // clip 1 reads as if it was performed exactly (duration = Q,
      // origin = zero, window consumed), so no incommensurate buffer
      // survives to skew arm boundaries, context loops or LCMs.
      Island is;
      auto c1 = recordTake(is, Q);
      const int64_t dur0 = is.dur(c1);

      // An off-grid trim [ws, ws + len): Q := len, zero := origin + ws.
      // (The trim RE-ANCHORS the origin for phase continuity, so read it
      // back after the edit.)
      const int64_t ws = 5000, len = 30000;
      is.window(c1, ws, ws + len);
      const int64_t origin_t = is.origin(c1);
      expectEquals(is.Q(), len, "Q re-established to the window length");
      expectEquals(storedZero(is), origin_t + ws,
                   "zero := origin + window start");

      // Take 2 through the real flow — the arm inside triggers collapse.
      auto c2 = recordTake(is, 2 * len);

      expectEquals(is.dur(c1), len, "clip 1 collapsed: the window IS the take");
      expectEquals(is.origin(c1), origin_t + ws,
                   "clip 1 origin = the trimmed loop's top");
      expectEquals(scenario::posmod(storedZero(is) - (origin_t + ws), len),
                   (int64_t)0, "zero stays on the trimmed grid");
      expectEquals(is.Q(), len, "Q unmoved");
      expectEquals(is.iprop(c1, "loopStart"), (int64_t)0,
                   "window consumed (none)");
      expectEquals(is.iprop(c1, "loopEnd"), (int64_t)0, "...");

      // Take 2 lands ON the grid.
      expectEquals(scenario::posmod(is.origin(c2) - storedZero(is), len),
                   (int64_t)0,
                   "take 2 anchors on a Q boundary of the zero grid");

      // The arm logged the collapse, then the take: two undos bring the
      // full buffer back.
      is.engine.undo();  // the take
      is.engine.undo();  // the collapse
      expectEquals(is.dur(c1), dur0, "undo restores the full buffer");
      expectEquals(is.origin(c1), origin_t, "...and the origin");
      expectEquals(is.iprop(c1, "loopStart"), ws, "...and the trim window");
      expectEquals(is.iprop(c1, "loopEnd"), ws + len, "...");
      is.engine.redo();
      is.engine.redo();
      expectEquals(is.dur(c1), len, "redo re-collapses");
    }

    beginTest(
        "RE-OPEN uncollapses: deleting take 2 restores the trimmed-away "
        "material");
    {
      // Deleting back down to one clip uncollapses the survivor
      // (audio-neutral: the restored window plays the identical loop),
      // riding the same Remove edit — so the trim can be made LONGER
      // again.
      Island is;
      auto c1 = recordTake(is, Q);
      const int64_t dur0 = is.dur(c1);
      const int64_t ws = 5000, len = 30000;
      is.window(c1, ws, ws + len);
      auto c2 = recordTake(is, 2 * len);  // arm collapses c1
      expectEquals(is.dur(c1), len, "locked: collapsed");

      is.engine.deleteNode(c2);  // 2 → 1: re-open ⟹ uncollapse
      expectEquals(is.dur(c1), dur0,
                   "full buffer restored - trimming longer is possible again");
      expectEquals(is.iprop(c1, "loopStart"), ws,
                   "the trim survives as the window");
      expectEquals(is.iprop(c1, "loopEnd"), ws + len, "...");
      expectEquals(is.Q(), len, "Q untouched (still the trimmed loop)");

      is.engine.undo();  // re-insert c2 AND re-collapse c1
      expectEquals(is.dur(c1), len,
                   "undo of the delete re-collapses the definer");
      is.engine.redo();  // delete again → uncollapse re-derives
      expectEquals(is.dur(c1), dur0, "redo re-opens and uncollapses");
    }

    beginTest("RE-OPEN leaves an ORDINARY take alone (explicit collapse marker)");
    {
      // "Was collapsed" is an explicit marker, never inferred from
      // write_position > duration: every snapped take overshoots its
      // duration by up to a block, and deleting down to one ordinary
      // clip must not "uncollapse" it to an off-grid recorded length.
      Island is;
      auto c1 = recordTake(is, Q);
      const int64_t dur0 = is.dur(c1);
      auto c2 = recordTake(is, Q + 300);  // snaps; overshoots
      expectEquals(is.dur(c1), dur0, "untrimmed: no collapse");
      is.engine.deleteNode(c2);  // 2 -> 1 with a never-trimmed survivor
      expectEquals(is.dur(c1), dur0,
                   "the ordinary take keeps its snapped duration");
      expectEquals(is.iprop(c1, "loopStart"), (int64_t)0, "no phantom window");
      expectEquals(is.iprop(c1, "loopEnd"), (int64_t)0, "whole (no window)");
      expectEquals(is.Q(), dur0, "Q untouched");
    }

    beginTest("RE-OPEN keeps geometry authored after the lock; the delete "
              "and its undo are symmetric");
    {
      // A re-open replaces the survivor's geometry with the old trim. A
      // window drawn on the locked take since is the user's: it stays,
      // and so does the collapse.
      Island is;
      auto c1 = recordTake(is, Q);
      const int64_t ws = 5000, len = 30000;
      is.window(c1, ws, ws + len);        // provisional trim
      auto c2 = recordTake(is, 2 * len);  // arm collapses c1
      expectEquals(is.dur(c1), len, "locked: collapsed");
      is.window(c1, 0, len / 2);  // authored on the locked take
      expectEquals(is.iprop(c1, "loopEnd"), len / 2,
                   "a half-Q window on the locked take");
      const juce::var locked = test_utils::graphFacts(is.engine);

      is.engine.deleteNode(c2);  // 2 -> 1 with geometry on the survivor
      expectEquals(is.dur(c1), len, "the collapse stays");
      expectEquals(is.iprop(c1, "loopStart"), (int64_t)0,
                   "the authored window stays");
      expectEquals(is.iprop(c1, "loopEnd"), len / 2, "...");
      const juce::var deleted = test_utils::graphFacts(is.engine);

      is.engine.undo();
      juce::String diff = test_utils::firstDifference(
          locked, test_utils::graphFacts(is.engine));
      expect(diff.isEmpty(), "undo restores the island the delete found " + diff);
      is.engine.redo();
      diff = test_utils::firstDifference(deleted,
                                         test_utils::graphFacts(is.engine));
      expect(diff.isEmpty(), "redo deletes again, the window untouched " + diff);
    }

    beginTest("phase-preserving trim: the sounding position never jumps");
    {
      // The provisional grid is free, so a trim re-anchors the clip's
      // origin such that the buffer position sounding at the edit moment
      // is unchanged (folded into the new window if it fell outside).
      // masterPos maps back to buffer position as loopStart + view —
      // continuity is exact, no processing between the measurement and
      // the edit.
      Island is;
      auto c1 = recordTake(is, Q);
      is.drive(12345);  // put the phase somewhere nonzero
      auto sounding = [&] { return is.iprop(c1, "loopStart") + is.masterPos(); };
      const int64_t p0 = sounding();

      const int64_t ws = 5000, len = 30000;
      is.window(c1, ws, ws + len);
      const int64_t p1 = sounding();
      expectEquals(p1, ws + scenario::posmod(p0 - ws, len),
                   "position continuous (folded into the window)");

      // A small nudge that keeps the current position inside the window
      // must not move it at all.
      is.window(c1, ws - 2000, ws - 2000 + len);
      expectEquals(sounding(), p1, "nudge: the sounding position does not move");
    }

    beginTest(
        "windowed playback anchors at origin + loopStart (zero contract)");
    {
      // Q13's zero := origin + loopStart names the trimmed loop's top
      // as island phase 0 — so at t = origin + loopStart the clip must
      // sound buffer[loopStart]. (An origin-anchored launch would play
      // buffer[loopStart + (loopStart mod len)] there, putting a sub-Q
      // trim's loop top at an arbitrary island phase.)
      ClipNode clip("phase-clip");
      const int N = 1000;
      std::vector<float> ramp(N);
      for (int i = 0; i < N; ++i) ramp[i] = (float)i / N;  // content[j] = j/N
      float* ins[] = {ramp.data()};
      test_utils::NodeContext rec = test_utils::contextFor(clip, N);
      clip.startRecording();
      clip.process(ins, nullptr, 1, 0, rec.ctx);
      clip.stopRecording();
      clip.control(ins, 1, rec.ctx);  // the block top commits the first take
      clip.origin_samples.store(100);

      const int64_t ws = 250, len = 400;  // ws mod len ≠ 0: discriminates
      clip.setLoopPoints(ws, ws + len);
      clip.startPlayback();

      auto sampleAt = [&](int64_t t) {
        // Distinct channel buffers: the clip SUMS into every output
        // channel, so aliased arrays double the sample.
        float outL[4] = {0.0f}, outR[4] = {0.0f};
        float* outs[] = {outL, outR};
        test_utils::NodeContext play = test_utils::contextFor(clip, 1, t);
        play.ctx.is_playing = true;
        clip.process(nullptr, outs, 0, 2, play.ctx);
        return outL[0];
      };
      // Loop top at its performance moment, and one period later.
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "island phase 0 sounds buffer[loopStart]");
      expectWithinAbsoluteError(sampleAt(100 + ws + len), ramp[ws], 1e-6f,
                                "...and every period after");
      // Mid-window content sounds at ITS performed moment (Audio Memory
      // applied to the surviving material).
      expectWithinAbsoluteError(sampleAt(100 + ws + 123), ramp[ws + 123], 1e-6f,
                                "buffer[ws+x] sounds at origin+ws+x");

      // LOCK-COLLAPSE (content base): the window becomes the take —
      // playback through content_base_ is sample-identical to the
      // windowed playback above, at the same island moments.
      // The leaf half (content view) plus the applier's half (the origin
      // moves by the window start — AudioEngine::collapseNode shifts
      // the node's subtree; here the clip IS the subtree).
      clip.collapseContent(ws, len);
      clip.origin_samples.store(clip.origin_samples.load() + ws);
      expectEquals(clip.getIntrinsicDuration(), len, "duration = window len");
      expectEquals(clip.origin_samples.load(), (int64_t)100 + ws,
                   "origin = the old window top");
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "collapsed take: phase 0 = old loop top");
      expectWithinAbsoluteError(sampleAt(100 + ws + 123), ramp[ws + 123], 1e-6f,
                                "...content unchanged mid-take");
      clip.uncollapseContent(ws, N);
      clip.origin_samples.store(clip.origin_samples.load() - ws);
      expectEquals(clip.getIntrinsicDuration(), (int64_t)N,
                   "uncollapse restores");
      expectEquals(clip.getLoopStart(), ws, "...including the trim");
      expectWithinAbsoluteError(sampleAt(100 + ws), ramp[ws], 1e-6f,
                                "...and playback is unchanged");
    }

    beginTest(
        "multi-segment re-trim of the sole definer re-establishes "
        "(Q := period, zero := origin' + mapOffset(0)); undo restores");
    {
      // Punching a cell out of the scratch loop before locking is the
      // multi-segment twin of the Q13 window trim — the island grid
      // follows the map's PERIOD.
      Island is;
      auto c1 = recordTake(is, Q);  // ~1Q take, Q established
      const int64_t q0 = is.Q(), zero0 = storedZero(is);
      expect(q0 > 0, "Q established by the sole take");

      // Cells {[0, q0/4), [q0/2, 3q0/4)} → period q0/2.
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {0, q0 / 4};
      cells.segs[1] = {q0 / 2, (3 * q0) / 4};
      is.engine.setSegments(c1, cells);

      expectEquals(is.Q(), q0 / 2, "Q := the map period (sum of cells)");
      expectEquals(storedZero(is), is.origin(c1),
                   "zero = origin' + mapOffset(0) (first cell at 0)");

      is.engine.undo();
      expectEquals(is.Q(), q0, "undo restores the grid");
      expectEquals(storedZero(is), zero0, "...and the zero");
      is.engine.redo();
      expectEquals(is.Q(), q0 / 2, "redo re-establishes");

      // LOCK-COLLAPSE, multi-segment: arming take 2 SPLICES the kept
      // cells into THE take (duration = period, origin = the zero, map
      // consumed); undo un-splices (full material + map return).
      expect(hasSegments(is, c1), "definer carries the cell map");
      const int64_t zero_before = storedZero(is);
      const int64_t origin_pre_splice = is.origin(c1);
      recordTake(is, q0 / 2);  // take 2 arms + commits
      expectEquals(is.dur(c1), q0 / 2,
                   "splice: definer duration = the map period");
      expectEquals(is.origin(c1), zero_before,
                   "splice: origin = the zero (anchoring law)");
      expect(!hasSegments(is, c1), "splice: map consumed");

      // A SEEK re-frames every absolute in the session, the log's
      // stored origins included (shiftHistoryAbsolutes). The splice
      // inverse's pre-splice origin must ride that shift too — it lives
      // in `iorg` under `setsOrigin`, never in `iq`.
      const int64_t zero_at_seek = storedZero(is);
      expect(is.engine.seekTransport((double)(q0 / 8)), "seek applied");
      int64_t delta = storedZero(is) - zero_at_seek;
      if (delta == 0) {
        expect(is.engine.seekTransport((double)(q0 / 8 + q0 / 4)), "seek 2");
        delta = storedZero(is) - zero_at_seek;
      }
      expect(delta != 0, "the seek moved the zero");

      // The log reads: Collapse, Take 2 — the first undo removes take 2
      // itself, the second un-splices the definer.
      is.engine.undo();
      expectEquals(is.dur(c1), q0 / 2,
                   "first undo strips take 2; the splice stands");
      is.engine.undo();
      expectEquals(is.dur(c1), q0, "un-splice: full material returns");
      expect(hasSegments(is, c1), "un-splice: the cell map returns");
      expectEquals(is.origin(c1), origin_pre_splice + delta,
                   "un-splice restores the pre-splice origin IN THE "
                   "POST-SEEK FRAME (placement, not a stale absolute)");
    }

    // ---- Q13 FOR GROUPS ----
    // The fractal twin of the sole-clip definer: a first take recorded
    // as a GROUP (N mics, one origin, one duration) is the island's
    // definer; the STACK's window re-establishes (Q, zero). The window
    // stays on the stack (it IS the part under the window law) and the
    // children stay whole until the next arm collapses them.
    beginTest("GROUPS: a first group take is the Q-definer; its window re-defines Q");
    {
      Island is;
      const juce::String stack_id = is.recordGroup(2, 4 * Q);
      const juce::StringArray ids = is.childIds(stack_id);
      expectEquals(ids.size(), 2, "two mics");
      const int64_t D = is.dur(ids[0]);
      expect(D > 0 && is.dur(ids[1]) == D, "group take committed");
      const int64_t q0 = is.Q(), zero0 = storedZero(is);
      expectEquals(q0, D, "the whole take is 1Q (first take)");
      is.drive(12345);  // phase somewhere nonzero

      // A fractional-Q window on the STACK: refused anywhere else, here
      // it re-establishes Q := len.
      const int64_t ws = D / 4, len = D / 2;
      // The inner position sounding NOW (masterPos is published wrapped
      // on the audible cycle = D before the trim).
      const int64_t p0 = is.masterPos();
      is.window(stack_id, ws, ws + len);
      expectEquals(is.Q(), len, "Q := the group window length");
      expectEquals(is.iprop(stack_id, "loopStart"), ws,
                   "window lives on the stack");
      expectEquals(is.iprop(stack_id, "loopEnd"), ws + len,
                   "window end on the stack");
      for (const auto& id : ids) {
        expectEquals(is.dur(id), D, "children stay whole");
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "children windows untouched (whole: no window)");
      }
      // PHASE CONTINUITY: the position sounding now folds into the new
      // window and does not move — heard = ws + masterPos' (wrapped on
      // len now) must equal ws + ((p0 - ws) mod len).
      expectEquals(ws + is.masterPos(), ws + scenario::posmod(p0 - ws, len),
                   "zero solved for continuity (pos(t) = start + ((t - zero) mod len))");

      is.engine.undo();
      expectEquals(is.Q(), q0, "undo restores the old Q");
      expectEquals(storedZero(is), zero0, "undo restores the old zero");
      is.engine.redo();
      expectEquals(is.Q(), len, "redo re-applies");

      // Take 2 on a new top-level track: Q locks at len.
      const juce::String t2 = is.record(len);
      expect(is.dur(t2) > 0, "take 2 committed");
      expectEquals(is.Q(), len, "Q locked at the trimmed length");
      // GROUP LOCK-COLLAPSE (the fractal twin of the clip's): arming
      // take 2 made the trimmed region THE take — members are 1Q whole
      // takes now, the stack window is consumed.
      for (const auto& id : ids) {
        expectEquals(is.dur(id), len, "member collapsed to the window");
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "member whole (no window)");
      }
      expect(!(is.iprop(stack_id, "loopEnd") > is.iprop(stack_id, "loopStart")),
             "stack window consumed by the collapse");
      is.window(stack_id, 0, ws + len);  // past the inner cycle: refused
      expect(!(is.iprop(stack_id, "loopEnd") > 0),
             "locked: a window past the inner cycle is refused");
      is.window(stack_id, 0, len / 2);  // Q/2: coherent, ordinary edit
      expectEquals(is.iprop(stack_id, "loopEnd"), len / 2,
                   "locked: a coherent group trim lands");
      expectEquals(is.Q(), len, "and leaves Q alone");
      // RE-OPEN ⟹ UNCOLLAPSE, group twin: deleting take 2 restores the
      // full takes with the trim back on the stack.
      is.window(stack_id, 0, 0);
      is.engine.deleteNode(t2);
      for (const auto& id : ids) {
        expectEquals(is.dur(id), D, "re-open: full member takes restored");
      }
      expectEquals(is.iprop(stack_id, "loopStart"), ws,
                   "re-open: the trim is the stack window again");
      expectEquals(is.iprop(stack_id, "loopEnd"), ws + len, "...");
      is.engine.undo();  // re-insert take 2 AND re-collapse
      for (const auto& id : ids) {
        expectEquals(is.dur(id), len,
                     "undo of the delete re-collapses the group");
      }
      is.engine.redo();
      for (const auto& id : ids) {
        expectEquals(is.dur(id), D, "redo re-opens and uncollapses again");
      }
    }

    beginTest("GROUPS: two takes in one stack are not a definer");
    {
      Island is;
      const juce::String stack_id = is.recordGroup(2, 2 * Q);
      const int64_t D = is.Q();
      expect(D > 0, "Q established");
      // A third mic later: a second take inside the same stack.
      const juce::String c3 = is.record(D, stack_id);
      expect(is.dur(c3) > 0, "third mic committed");
      is.window(stack_id, 0, (3 * D) / 2);  // 1.5Q: incoherent
      expectEquals(is.iprop(stack_id, "loopEnd"), (int64_t)0,
                   "not a definer: incoherent window refused");
      expectEquals(is.Q(), D, "Q untouched");
    }

    // ---- ONE ISLAND, ONE OWNER OF (Q, zero) ----
    // A stack assembled detached (Combine) holds no island facts of its
    // own. Were it to carry a private grid, a delete-all would revert
    // only the ROOT's Q and the next group take inside the stack would
    // commit against the stale one.
    beginTest("NESTED FACTS: combine leaves no (Q, zero) on the stack; a later first take establishes fresh");
    {
      Island is;
      // Two committed clips at the top level (A defines Q).
      const juce::String a = is.record(3 * Q);
      expectEquals(is.Q(), 3 * Q, "A establishes Q");
      const juce::String b = is.record(3 * Q);
      expect(is.dur(b) > 0, "B committed");
      const juce::String stack_id = is.engine.combineNodes(a, b);
      expect(stack_id.isNotEmpty(), "combined");
      expectEquals(is.iprop(stack_id, "quantum"), (int64_t)0,
                   "the nested stack holds no island Q");
      expectEquals(is.iprop(stack_id, "zero"), (int64_t)0, "nor a zero");
      expectEquals(is.Q(), 3 * Q, "root Q untouched by the combine");
      // Delete both takes: the island empties, Q reverts.
      is.engine.deleteNode(a);
      is.engine.deleteNode(b);
      expectEquals(is.Q(), (int64_t)0, "delete-all reverts Q");
      // A new group take INSIDE the emptied stack is the island's first
      // take again: Q := its length, members whole.
      const juce::StringArray ids{is.createClip(stack_id),
                                  is.createClip(stack_id)};
      is.engine.startRecordingInNode(stack_id);
      is.drive(2 * Q + 777);  // an off-grid length: nothing to snap to
      is.engine.stopRecordingInNode(stack_id);
      is.settle();
      const int64_t L = is.dur(ids[0]);
      expect(L >= 2 * Q + 777 && is.dur(ids[1]) == L,
             "group take committed at its own length (first take)");
      expectEquals(is.Q(), L, "Q := the take (no stale grid)");
      for (const auto& id : ids) {
        expectEquals(is.iprop(id, "loopStart"), (int64_t)0,
                     "member window start");
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "member whole (no window, no stale region)");
      }
    }

    // ---- MEMBERS WHOLE under the definer stack ----
    // A definer stack whose members carry their own windows (a group
    // take under a locked Q, then left as the only content): the
    // re-trim rides them whole, undoably.
    beginTest("GROUPS: a definer re-trim makes windowed members whole (undoable riders)");
    {
      Island is;
      const juce::String a = is.record(Q);
      expectEquals(is.Q(), Q, "A establishes Q = 1Q");
      const juce::String stack_id = is.recordGroup(2, 2 * Q);
      const juce::StringArray ids = is.childIds(stack_id);
      const int64_t D = is.dur(ids[0]);
      expect(D >= 2 * Q && is.dur(ids[1]) == D,
             "a 2Q group take committed under the lock");
      // Coherent 1Q windows on the members (allowed under the lock).
      for (const auto& id : ids) is.window(id, 0, Q);
      for (const auto& id : ids)
        expectEquals(is.iprop(id, "loopEnd"), Q, "member window landed");
      // A goes: the stack is now the definer, its window on its members.
      is.engine.deleteNode(a);
      expectEquals(is.Q(), Q, "Q survives (2 clips remain)");
      const int64_t ws = D / 4, len = D / 2;
      is.window(stack_id, ws, ws + len);
      expectEquals(is.Q(), len, "definer re-trim: Q := len");
      expectEquals(is.iprop(stack_id, "loopStart"), ws, "window on the stack");
      for (const auto& id : ids) {
        expectEquals(is.iprop(id, "loopStart"), (int64_t)0,
                     "member start whole");
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "member made whole (no window) by the rider");
      }
      is.engine.undo();
      expectEquals(is.Q(), Q, "undo restores Q");
      expect(!(is.iprop(stack_id, "loopEnd") > is.iprop(stack_id, "loopStart")),
             "undo clears the stack window");
      for (const auto& id : ids)
        expectEquals(is.iprop(id, "loopEnd"), Q,
                     "undo restores the member windows");
      is.engine.redo();
      expectEquals(is.Q(), len, "redo re-trims");
      for (const auto& id : ids)
        expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                     "redo makes members whole (no window) again");
    }

    // ---- FIVE MICS, REPEATED LEFT-EDGE TRIMS ----
    // The drum-kit case: five mics, one group take, then the left
    // bracket dragged right several times. Each release re-establishes
    // Q and re-anchors the members together; the END never moves, the
    // members stay one take (equal origins, so the stack stays the
    // definer and every fractional trim is accepted).
    beginTest("GROUPS: five mics, three left-edge trims: end holds, members stay one take");
    {
      Island is;
      const juce::String stack_id =
          is.recordGroup(5, 3 * Q + 1234);  // an off-grid first take
      const juce::StringArray ids = is.childIds(stack_id);
      expectEquals(ids.size(), 5, "five mics");
      const int64_t D = is.dur(ids[0]);
      for (const auto& id : ids) {
        expectEquals(is.dur(id), D, "one duration");
        expectEquals(is.origin(id), is.origin(ids[0]), "one origin");
      }
      is.drive(7777);
      // Three left-edge drags, the UI's arithmetic: start = frac * D,
      // end = the published loopEnd (D until a window exists).
      const double fracs[] = {0.2, 0.35, 0.5};
      int64_t end_sent = D;
      for (double f : fracs) {
        const int64_t start = (int64_t)std::llround(f * (double)D);
        is.window(stack_id, start, end_sent);
        expectEquals(is.iprop(stack_id, "loopStart"), start,
                     "start landed (fractional: accepted => still the definer)");
        expectEquals(is.iprop(stack_id, "loopEnd"), end_sent,
                     "the END did not move");
        expectEquals(is.Q(), end_sent - start, "Q := len");
        const int64_t member_origin = is.origin(ids[0]);
        for (const auto& id : ids) {
          expectEquals(is.origin(id), member_origin,
                       "members re-anchored together");
          expectEquals(is.iprop(id, "loopEnd"), (int64_t)0,
                       "members whole (no window)");
        }
        // Q18: the window anchors at the STACK's origin (== the members',
        // one take) and the cycle top is the window top: zero == origin
        // + start. The subtree moved as one (no per-member riders).
        expectEquals(is.origin(stack_id), member_origin,
                     "the stack's origin == its members' (one take)");
        expectEquals(storedZero(is), member_origin + start,
                     "zero == origin + start (the window top is the cycle top)");
        end_sent = is.iprop(stack_id, "loopEnd");
        is.drive(3333);
      }
    }

    // ---- GROUP STOP: one block top for every mic ----
    beginTest("GROUPS: a locked-Q group stop commits one duration for every mic");
    {
      Island is;
      is.record(Q);
      const juce::String stack_id = is.createStack();
      juce::StringArray ids;
      for (int i = 0; i < 3; ++i) ids.add(is.createClip(stack_id));
      is.engine.startRecordingInNode(stack_id);
      is.drive(2 * Q + 300);
      is.engine.stopRecordingInNode(stack_id);  // one stop, every mic
      is.settle();
      const int64_t D = is.dur(ids[0]);
      expect(D > 0 && D % Q == 0, "committed on the grid");
      for (const auto& id : ids) {
        expectEquals(is.dur(id), D, "one duration");
        expectEquals(is.origin(id), is.origin(ids[0]), "one origin");
      }
    }

    // ---- RIDERS CLEAR A MEMBER'S SEGMENT MAP ----
    beginTest("GROUPS: a definer re-trim wholes a member with a segment map (undoable)");
    {
      Island is;
      const juce::String a = is.record(Q);
      const juce::String stack_id = is.recordGroup(2, 4 * Q);
      const juce::StringArray ids = is.childIds(stack_id);
      const int64_t D = is.dur(ids[0]);
      expect(D >= 4 * Q, "a 4Q take");
      // A coherent two-segment map on member 0 (period 2Q), authored
      // STOPPED: a map edit while playing re-anchors the member's
      // origin for continuity, which by itself ends the one-take
      // (equal origins) definer state — a separate, legitimate path.
      is.engine.togglePlayback();
      expect(!is.engine.isPlaying(), "stopped for the map edit");
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, Q};
      m.segs[1] = {2 * Q, 3 * Q};
      is.engine.setSegments(ids[0], m);
      expect(hasSegments(is, ids[0]), "segment map landed on the member");
      is.engine.togglePlayback();
      is.engine.deleteNode(a);  // the stack is now the definer
      is.window(stack_id, D / 4, (3 * D) / 4);
      expectEquals(is.Q(), D / 2, "definer branch ran (Q := len)");
      expect(!hasSegments(is, ids[0]),
             "rider cleared the member's segment map");
      expectEquals(is.iprop(ids[0], "loopEnd"), (int64_t)0,
                   "member whole (no window)");
      is.engine.undo();
      expect(hasSegments(is, ids[0]),
             "undo restores the member's segment map");
    }

    // ---- SEQUENCES TRACK Q ----
    // Step lengths are musical facts: a definer re-trim RESCALES them
    // (5Q stays 5Q); a revert to an empty island CLEARS them, with Q
    // and the zero.
    beginTest("SEQUENCES TRACK Q: re-trim rescales steps; empty island clears; undo restores");
    {
      Island is;
      // The transport is already running, so the first take — and the
      // zero — land off 0.
      is.engine.togglePlayback();
      is.drive(3000);
      auto c1 = recordTake(is, Q);  // 1Q take, Q := its length
      const int64_t q0 = is.Q(), zero0 = storedZero(is);
      expect(q0 > 0 && zero0 > 0, "Q established, the zero off 0");
      auto stepLens = [&]() {
        juce::Array<int64_t> out;
        const juce::var steps = is.state()
                                    .getProperty("sequence", juce::var())
                                    .getProperty("steps", juce::var());
        if (auto* list = steps.getArray())
          for (const auto& step : *list)
            out.add((int64_t)(double)step.getProperty("len", 0.0));
        return out;
      };
      is.engine.setSequence(is.rootId(), seqPayload({{2 * q0}, {3 * q0}}));
      expectEquals(stepLens().size(), 2, "two steps (2Q + 3Q)");

      // Definer re-trim: Q := q0/2. The steps keep their Q values.
      is.window(c1, 0, q0 / 2);
      expectEquals(is.Q(), q0 / 2, "Q re-established");
      {
        auto l = stepLens();
        expectEquals(l.size(), 2, "steps survive the re-trim");
        expectEquals(l[0], (int64_t)(2 * (q0 / 2)), "A is still 2Q");
        expectEquals(l[1], (int64_t)(3 * (q0 / 2)), "B is still 3Q");
      }
      is.engine.undo();
      expectEquals(is.Q(), q0, "undo restores Q");
      {
        auto l = stepLens();
        expectEquals(l[0], (int64_t)(2 * q0), "undo scales A back (2Q)");
        expectEquals(l[1], (int64_t)(3 * q0), "undo scales B back (3Q)");
      }

      // Empty the island: Q, the zero and the sequence all go; undo
      // brings them back.
      is.engine.deleteNode(c1);
      expectEquals(is.Q(), (int64_t)0, "island reverted");
      expectEquals(storedZero(is), (int64_t)0, "the zero reverts with Q");
      expectEquals(stepLens().size(), 0, "sequence cleared on an empty island");
      is.engine.undo();
      expectEquals(is.Q(), q0, "undo restores Q with the clip");
      expectEquals(storedZero(is), zero0, "...and the zero");
      expectEquals(stepLens().size(), 2, "undo restores the sequence");
      expectEquals(stepLens()[1], (int64_t)(3 * q0), "with its step lengths");
      is.engine.redo();
      expectEquals(is.Q(), (int64_t)0, "redo re-reverts Q");
      expectEquals(stepLens().size(), 0, "redo clears again");
    }
  }
};

static QTimeLockTests qtimeLockTests;

}  // namespace celestrian
