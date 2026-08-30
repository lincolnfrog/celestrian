/**
 * Transport seek tests (owner ruling 2026-08-27, the ruler scrub).
 *
 * AudioEngine::seekTransport(pos) re-bases the island epoch so the
 * monotonic clock reads as the requested phase — the clock itself is
 * NEVER touched (kernel.md). The target arrives in the published
 * masterPos domain (epoch-relative, folded on the audible cycle E-C),
 * and the engine folds out-of-range targets defensively. Refused while
 * any take is live or armed: takes place audio by the clock.
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
    auto islandFacts = [](AudioEngine& engine, int64_t& pos, int64_t& epoch) {
      auto state = engine.getGraphState();
      auto* root = state.getDynamicObject();
      pos = (int64_t)(double)root->getProperty("islandPos");
      epoch = (int64_t)(double)root->getProperty("islandEpoch");
    };

    // Record the FIRST take at exactly 1Q (epoch 0, cycle 1Q), then
    // settle one block so the recording-view flag clears. Leaves the
    // transport PLAYING at t = Q + BLOCK_SIZE.
    auto establish1Q = [&](AudioEngine& engine,
                           const std::function<void(int64_t)>& process) {
      engine.createNode("clip");
      const juce::String id = firstClipId(engine);
      engine.startRecordingInNode(id);  // auto-plays; epoch = 0
      process(Q);
      engine.stopRecordingInNode(id);  // no island Q yet -> immediate commit
      process(BLOCK_SIZE);             // settle the view flags
      return id;
    };

    beginTest("Seek sets the published phase; the clock never moves");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);

      // The raw monotonic clock, reconstructed from the published pair
      // (islandPos = t - epoch, so t = islandPos + epoch).
      int64_t pos_before = 0, epoch_before = 0;
      islandFacts(engine, pos_before, epoch_before);
      const int64_t raw_before = pos_before + epoch_before;

      // Stopped seek: the frozen view teleports to the target.
      if (engine.isPlaying()) engine.togglePlayback();
      expect(engine.seekTransport((double)(Q / 2)), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "stopped view reads the seek");

      int64_t pos_after = 0, epoch_after = 0;
      islandFacts(engine, pos_after, epoch_after);
      expectEquals((juce::int64)(pos_after + epoch_after),
                   (juce::int64)raw_before,
                   "the monotonic clock itself never moved (kernel.md)");

      // Resume: playback continues FROM the seek (phase, not a reset).
      engine.togglePlayback();
      process(Q / 4);
      expectEquals((juce::int64)masterPos(engine),
                   (juce::int64)(Q / 2 + Q / 4),
                   "playback rides the new phase");
    }

    beginTest("Out-of-range targets fold on the audible cycle");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);  // cycle 1Q

      expect(engine.seekTransport((double)(2 * Q + Q / 4)), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 4),
                   "2.25Q folds to 0.25Q on a 1Q cycle");
      expect(engine.seekTransport((double)(-(Q / 4))), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(3 * Q / 4),
                   "negative targets fold from the cycle end");
    }

    beginTest("Refused while a take is live or armed");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      establish1Q(engine, process);  // Q locked

      int64_t pos0 = 0, epoch0 = 0;
      islandFacts(engine, pos0, epoch0);

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

      int64_t pos1 = 0, epoch1 = 0;
      islandFacts(engine, pos1, epoch1);
      expectEquals((juce::int64)epoch1, (juce::int64)epoch0,
                   "refused seeks leave the epoch alone");

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
      establish1Q(engine, process);  // Q = 1s, epoch 0

      // A second, longer clip grows the committed cycle to a whole
      // multiple of Q (recordClip pads to the boundary).
      const juce::String big =
          celestrian::test_utils::recordClip(engine, process, 4 * Q);
      process(BLOCK_SIZE);  // settle the view flags

      // An active 1Q window on it shortens the audible cycle back to
      // 1Q (E-C): the playhead loops with what is heard, and so must
      // the seek's fold.
      engine.setLoopPoints(big, Q, 2 * Q);
      expect(engine.seekTransport((double)(2 * Q + Q / 2)), "seek applied");
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "target folds on the 1Q audible cycle, not the grown LCM");
    }
  }
};

static SeekTests seekTests;
