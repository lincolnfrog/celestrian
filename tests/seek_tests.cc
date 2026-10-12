/**
 * Transport seek tests (the ruler scrub).
 *
 * AudioEngine::seekTransport(advance) moves the playing PHASE by
 * `advance` samples — the island's zero and every origin move back by
 * it — so the monotonic clock reads as the wanted phase; the clock
 * itself is NEVER touched (kernel.md). The engine reads no frame
 * (docs/frame.md): the view computes the advance against the zero it
 * seated, and may name the clock reading it used (`at_clock`) so the
 * engine corrects for the time since the poll. Refused while any take
 * is live or armed: takes place audio by the clock.
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace {

const int BLOCK_SIZE = 512;
const int64_t Q = 44100;

/** A PLAYING island of one take of exactly 1Q (zero at 0, cycle 1Q),
 * one block past its commit so the recording view has handed back to
 * the cycle. (test_utils::recordClip drives 100 samples into a first
 * take before its length, so it would establish Q = 44200.) */
struct Rig {
  std::unique_ptr<AudioEngine> owned = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owned;
  juce::String first;

  Rig() {
    first = celestrian::test_utils::addNode(engine, "clip");
    engine.startRecordingInNode(first);
    process(Q);
    engine.stopRecordingInNode(first);  // no island Q yet: commits at once
    process(BLOCK_SIZE);
  }
  void process(int64_t total_samples) {
    celestrian::test_utils::driveEngine(engine, total_samples, BLOCK_SIZE);
  }
  int64_t masterPos() {
    return celestrian::test_utils::rootProp(engine, "masterPos");
  }
  int64_t zero() {
    return celestrian::test_utils::rootProp(engine, "islandZero");
  }
  int64_t islandPos() {
    return celestrian::test_utils::rootProp(engine, "islandPos");
  }
  /** The raw monotonic clock, from the published pair (islandPos = t -
   * zero). */
  int64_t clock() { return islandPos() + zero(); }
  /** A test names the PHASE it wants; the engine takes the advance (the
   * view's arithmetic, docs/frame.md). */
  bool seekTo(int64_t phase) {
    return engine.seekTransport((double)(phase - masterPos()));
  }
};

}  // namespace

class SeekTests : public juce::UnitTest {
 public:
  SeekTests() : juce::UnitTest("Transport Seek (ruler scrub)") {}

  void runTest() override {
    beginTest("Seek sets the published phase; the clock never moves");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      const int64_t clock_before = rig.clock();

      // Stopped seek: the frozen view teleports to the target.
      engine.togglePlayback();
      expect(rig.seekTo(Q / 2), "seek applied");
      expectEquals(rig.masterPos(), Q / 2, "stopped view reads the seek");
      expectEquals(rig.clock(), clock_before,
                   "the monotonic clock itself never moved (kernel.md)");

      // Resume: playback continues FROM the seek (phase, not a reset).
      engine.togglePlayback();
      rig.process(Q / 4);
      expectEquals(rig.masterPos(), Q / 2 + Q / 4,
                   "playback rides the new phase");
    }

    beginTest("Any advance folds on the audible cycle; at_clock corrects for the "
              "clock since the poll; a zero advance is a no-op");
    {
      Rig rig;  // cycle 1Q
      AudioEngine& engine = rig.engine;
      engine.togglePlayback();
      expect(rig.seekTo(0), "at phase 0");

      expect(engine.seekTransport((double)(2 * Q + Q / 4)), "seek applied");
      expectEquals(rig.masterPos(), Q / 4,
                   "an advance of 2.25Q lands at 0.25Q on a 1Q cycle");
      expect(engine.seekTransport((double)(-(Q / 2))), "seek applied");
      expectEquals(rig.masterPos(), 3 * Q / 4,
                   "a negative advance moves back, folded from the cycle end");

      // The view computed its advance against a clock reading that is
      // now stale (playback ran on): naming it lands the phase the view
      // meant, not the phase plus the elapsed time.
      engine.togglePlayback();
      const int64_t clock_at_poll = rig.clock();
      const int64_t advance = Q / 2 - rig.masterPos();  // to 0.5Q, as polled
      rig.process(Q / 3);                               // then the clock ran on
      expect(engine.seekTransport((double)advance, clock_at_poll),
             "seek applied");
      expectEquals(rig.masterPos(), Q / 2,
                   "at_clock: the phase lands where the view meant");

      const int64_t zero = rig.zero();
      expect(engine.seekTransport(0.0), "a zero advance is accepted");
      expectEquals(rig.zero(), zero, "...and moves nothing");
    }

    beginTest("Refused while a take is live or armed");
    {
      Rig rig;  // Q locked
      AudioEngine& engine = rig.engine;
      const int64_t zero = rig.zero();

      const juce::String second =
          celestrian::test_utils::addNode(engine, "clip");
      engine.startRecordingInNode(second);  // armed (pending Q boundary)
      expect(!engine.seekTransport((double)(Q / 2)),
             "armed take: seek refused");
      rig.process(BLOCK_SIZE);  // arm engages / recording runs
      expect(!engine.seekTransport((double)(Q / 2)),
             "live take: seek refused");
      expectEquals(rig.zero(), zero, "refused seeks leave the zero alone");

      engine.stopRecordingInNode(second);
      for (int i = 0;
           i < 400 && !celestrian::test_utils::isClipCommitted(engine, second);
           ++i) {
        rig.process(BLOCK_SIZE);
      }
      rig.process(BLOCK_SIZE);  // the view hands back to the cycle
      expect(engine.seekTransport(0.0), "take settled: seek allowed again");
    }

    beginTest("A take armed after a backward seek: the cursor goes on from "
              "its place in the cycle, never from behind the zero");
    {
      Rig rig;  // cycle 1Q
      AudioEngine& engine = rig.engine;

      // Back by several cycles and a bit: the zero now lies AHEAD of the
      // clock, so every zero-relative position is negative.
      expect(engine.seekTransport((double)(-(5 * Q + Q / 3))), "seek applied");
      expect(rig.islandPos() < -4 * Q,
             "the clock stands cycles before the zero");
      const int64_t phase = rig.masterPos();
      expect(phase >= 0 && phase < Q, "the idle cursor is folded into the cycle");

      // A new take of the slot: the recording view freezes its base at
      // the arm and grows from there.
      engine.newTake(rig.first);
      rig.process(BLOCK_SIZE);
      expectEquals(rig.masterPos(), phase + BLOCK_SIZE,
                   "one block on from the phase the cursor showed");
      rig.process(2 * Q);  // through the slot's top and its whole period
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) {
        rig.process(BLOCK_SIZE);
      }
      expect(!engine.hasActiveTake(), "the new take ran its period");
      rig.process(BLOCK_SIZE);  // the view hands back to the cycle
      const int64_t after = rig.masterPos();
      expect(after >= 0 && after < Q, "and the cursor is back in the cycle");
    }

    beginTest("Seek folds on the WINDOW-shortened cycle (E-C)");
    {
      Rig rig;  // Q = 1s, zero at 0
      AudioEngine& engine = rig.engine;

      // A second, longer clip grows the committed cycle to a whole
      // multiple of Q (recordClip pads to the boundary).
      const juce::String big = celestrian::test_utils::recordClip(
          engine, [&](int n) { rig.process(n); }, 4 * Q);
      rig.process(BLOCK_SIZE);  // the view hands back to the cycle

      // An active 1Q window on it shortens the audible cycle back to
      // 1Q (E-C): the playhead loops with what is heard, and so must
      // the seek's fold.
      engine.setLoopPoints(big, Q, 2 * Q);
      expect(rig.seekTo(2 * Q + Q / 2), "seek applied");
      expectEquals(rig.masterPos(), Q / 2,
                   "target folds on the 1Q audible cycle, not the grown LCM");
    }

    beginTest("a seek re-frames what the undo log holds detached: a deleted "
              "clip and a deleted group come back where they sat on the grid");
    {
      celestrian::scenario::Island is;
      AudioEngine& engine = is.engine;
      const int64_t q = 20000;
      is.record(q);
      const juce::String clip = is.record(4 * q);
      const juce::String kit = is.recordGroup(2, 2 * q);
      const juce::StringArray mics = is.childIds(kit);
      // Where a node sits on the grid: its origin from the island zero.
      const auto placement = [&](const juce::String& id) {
        return is.origin(id) - is.zero();
      };
      const int64_t clip_at = placement(clip);
      const int64_t kit_at = placement(kit);
      const int64_t mic_at = placement(mics[1]);
      engine.deleteNode(clip);
      engine.deleteNode(kit);
      const int64_t zero_before = is.zero();
      expect(engine.seekTransport((double)(q / 3)), "seek accepted");
      expect(is.zero() != zero_before, "the seek moved the zero");
      engine.undo();  // the group
      engine.undo();  // the clip
      expectEquals(placement(clip), clip_at, "the clip, where it sat");
      expectEquals(placement(kit), kit_at, "the group, where it sat");
      expectEquals(placement(mics[1]), mic_at, "its member, where it sat");
      juce::StringArray all;
      is.clipIds(all);
      expectEquals(is.mismatches(8 * q, is.sumOfLoops(all)), 0,
                   "and everything plays there");
    }
  }
};

static SeekTests seekTests;
