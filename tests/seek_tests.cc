/**
 * Transport seek tests (owner ruling 2026-08-27, the ruler scrub).
 *
 * AudioEngine::seekTransport(advance) moves the playing PHASE by
 * `advance` samples — the island's zero and every origin move back by
 * it — so the monotonic clock reads as the wanted phase; the clock
 * itself is NEVER touched (kernel.md). The engine reads no frame
 * (docs/frame.md): the view computes the advance against the zero it
 * seated, and may name the clock reading it used (`at_clock`) so the
 * engine corrects for the time since the poll. Refused while any take
 * is live or armed: takes place audio by the clock.
 *
 * Fixture note: the first take is recorded MANUALLY at exactly 1Q
 * (the monotonic_clock_tests pattern) — test_utils::recordClip pads
 * 100 samples before the take, which would establish Q = 44200 and
 * poison every position below. One block is processed after each
 * stop so the engine's recording-view flag settles before reads.
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "test_utils.h"

class SeekTests : public juce::UnitTest {
 public:
  SeekTests() : juce::UnitTest("Transport Seek (ruler scrub)") {}

  void runTest() override {
    const int BLOCK_SIZE = 512;
    const int64_t Q = 44100;

    auto makeDriver = [&](AudioEngine& engine) {
      return [&engine, BLOCK_SIZE](int64_t total_samples) {
        celestrian::test_utils::driveEngine(engine, total_samples, BLOCK_SIZE);
      };
    };

    auto firstClipId = [](AudioEngine& engine) -> juce::String {
      auto state = engine.getGraphState();
      return (*state.getDynamicObject()->getProperty("nodes").getArray())[0]
          .getDynamicObject()
          ->getProperty("id");
    };

    auto masterPos = [](AudioEngine& engine) -> int64_t {
      return (int64_t)(double)engine.getGraphState()
          .getDynamicObject()
          ->getProperty("masterPos");
    };
    auto islandFacts = [](AudioEngine& engine, int64_t& pos, int64_t& zero) {
      auto state = engine.getGraphState();
      auto* root = state.getDynamicObject();
      pos = (int64_t)(double)root->getProperty("islandPos");
      zero = (int64_t)(double)root->getProperty("islandZero");
    };

    // Record the FIRST take at exactly 1Q (zero at 0, cycle 1Q), then
    // settle one block so the recording-view flag clears. Leaves the
    // transport PLAYING at t = Q + BLOCK_SIZE.
    auto establish1Q = [&](AudioEngine& engine,
                           const std::function<void(int64_t)>& process) {
      engine.createNode("clip");
      const juce::String id = firstClipId(engine);
      engine.startRecordingInNode(id);  // auto-plays; zero = 0
      process(Q);
      engine.stopRecordingInNode(id);  // no island Q yet -> immediate commit
      process(BLOCK_SIZE);             // settle the view flags
      return id;
    };

    // A test names the PHASE it wants; the engine takes the advance
    // (the view's arithmetic, docs/frame.md).
    auto seekTo = [&](AudioEngine& engine, int64_t phase) {
      return engine.seekTransport((double)(phase - masterPos(engine)));
    };

    beginTest("Seek sets the published phase; the clock never moves");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);

      // The raw monotonic clock, reconstructed from the published pair
      // (islandPos = t - zero, so t = islandPos + zero).
      int64_t pos_before = 0, zero_before = 0;
      islandFacts(engine, pos_before, zero_before);
      const int64_t raw_before = pos_before + zero_before;

      // Stopped seek: the frozen view teleports to the target.
      if (engine.isPlaying()) engine.togglePlayback();
      expect(seekTo(engine, Q / 2), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "stopped view reads the seek");

      int64_t pos_after = 0, zero_after = 0;
      islandFacts(engine, pos_after, zero_after);
      expectEquals((juce::int64)(pos_after + zero_after),
                   (juce::int64)raw_before,
                   "the monotonic clock itself never moved (kernel.md)");

      // Resume: playback continues FROM the seek (phase, not a reset).
      engine.togglePlayback();
      process(Q / 4);
      expectEquals((juce::int64)masterPos(engine),
                   (juce::int64)(Q / 2 + Q / 4),
                   "playback rides the new phase");
    }

    beginTest("Any advance folds on the audible cycle; at_clock corrects for the "
              "clock since the poll; a zero advance is a no-op");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);  // cycle 1Q
      if (engine.isPlaying()) engine.togglePlayback();
      expect(seekTo(engine, 0), "at phase 0");

      expect(engine.seekTransport((double)(2 * Q + Q / 4)), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 4),
                   "an advance of 2.25Q lands at 0.25Q on a 1Q cycle");
      expect(engine.seekTransport((double)(-(Q / 2))), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(3 * Q / 4),
                   "a negative advance moves back, folded from the cycle end");

      // The view computed its advance against a clock reading that is
      // now stale (playback ran on): naming it lands the phase the view
      // meant, not the phase plus the elapsed time.
      engine.togglePlayback();
      int64_t pos_poll = 0, zero_poll = 0;
      islandFacts(engine, pos_poll, zero_poll);
      const int64_t raw_poll = pos_poll + zero_poll;
      const int64_t advance = Q / 2 - masterPos(engine);  // to phase 0.5Q, as polled
      process(Q / 3);                                     // …then the clock ran on
      expect(engine.seekTransport((double)advance, raw_poll), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "at_clock: the phase lands where the view meant");

      int64_t pos_z = 0, zero_z = 0;
      islandFacts(engine, pos_z, zero_z);
      expect(engine.seekTransport(0.0), "a zero advance is accepted");
      int64_t pos_z2 = 0, zero_z2 = 0;
      islandFacts(engine, pos_z2, zero_z2);
      expectEquals((juce::int64)zero_z2, (juce::int64)zero_z,
                   "…and moves nothing");
    }

    beginTest("Refused while a take is live or armed");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);  // Q locked

      int64_t pos0 = 0, zero0 = 0;
      islandFacts(engine, pos0, zero0);

      engine.createNode("clip");
      juce::String second;
      {
        auto state = engine.getGraphState();
        if (auto* nodes = celestrian::test_utils::nodesOf(state))
          for (auto& node : *nodes)
            if (!(double)node.getProperty("duration", 0) &&
                !(bool)node.getProperty("isRecording", false))
              second = node.getProperty("id", "").toString();
      }
      engine.startRecordingInNode(second);  // armed (pending Q boundary)
      expect(!engine.seekTransport((double)(Q / 2)),
             "armed take: seek refused");
      process(BLOCK_SIZE);  // arm engages / recording runs
      expect(!engine.seekTransport((double)(Q / 2)),
             "live take: seek refused");

      int64_t pos1 = 0, zero1 = 0;
      islandFacts(engine, pos1, zero1);
      expectEquals((juce::int64)zero1, (juce::int64)zero0,
                   "refused seeks leave the zero alone");

      engine.stopRecordingInNode(second);
      for (int i = 0;
           i < 400 && !celestrian::test_utils::isClipCommitted(engine, second);
           ++i)
        process(512);
      process(BLOCK_SIZE);  // settle the view flags
      expect(engine.seekTransport(0.0), "take settled: seek allowed again");
    }

    beginTest("Seek folds on the WINDOW-shortened cycle (E-C)");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);  // Q = 1s, zero at 0

      // A second, longer clip grows the committed cycle to a whole
      // multiple of Q (recordClip pads to the boundary).
      const juce::String big =
          celestrian::test_utils::recordClip(engine, process, 4 * Q);
      process(BLOCK_SIZE);  // settle the view flags

      // An active 1Q window on it shortens the audible cycle back to
      // 1Q (E-C): the playhead loops with what is heard, and so must
      // the seek's fold.
      engine.setLoopPoints(big, Q, 2 * Q);
      expect(seekTo(engine, 2 * Q + Q / 2), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "target folds on the 1Q audible cycle, not the grown LCM");
    }
  }
};

static SeekTests seekTests;
