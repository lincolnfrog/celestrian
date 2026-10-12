/**
 * The monotonic clock (kernel.md §2): the transport is never reset or
 * rebased.
 *  1. First clip recorded at t > 0: the arm moment becomes the island
 *     ZERO (data), the clock is untouched, and the view/alignment are
 *     zero-relative from that moment on. No later commit moves the
 *     clock either.
 *  2. Stop/play is pause/resume: stopping freezes the cycle view where
 *     it is; playing resumes from the same phase.
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "test_utils.h"

class MonotonicClockTests : public juce::UnitTest {
 public:
  MonotonicClockTests() : juce::UnitTest("Monotonic Clock (never reset)") {}

  void runTest() override {
    using celestrian::test_utils::deepProp;
    using celestrian::test_utils::rootProp;
    using celestrian::test_utils::driveEngine;
    using celestrian::test_utils::firstNodeId;
    const int BLOCK_SIZE = 512;
    const int64_t Q = 44100;

    beginTest("First clip at t > 0: zero captured as data, clock untouched");
    {
      auto engine = std::make_unique<AudioEngine>();
      int64_t driven = 0;  // every sample since the transport started
      const auto process = [&](int64_t total_samples) {
        driveEngine(*engine, total_samples, BLOCK_SIZE);
        driven += total_samples;
      };
      engine->createNode("clip");
      const juce::String id = firstNodeId(*engine);

      // Let the transport run well past zero before the first take.
      engine->togglePlayback();
      const int64_t t0 = 3 * Q + 1234;
      process(t0);

      engine->startRecordingInNode(id);
      process(Q);  // arm happens at block start (t0), then 1Q captured
      engine->stopRecordingInNode(id);  // no island Q yet -> immediate commit

      expectEquals(rootProp(*engine, "islandZero"), t0,
                   "island zero is the arm moment, not 0");
      expectEquals((int64_t)deepProp(*engine, id, "origin"), t0,
                   "first clip origin equals the zero");

      // The cycle view is zero-relative: one block after commit the
      // cursor is at 512, not at t0 + Q + 512.
      process(BLOCK_SIZE);
      expectEquals(rootProp(*engine, "masterPos"), (int64_t)BLOCK_SIZE,
                   "masterPos view derives from (t - zero) mod cycle");

      // Two more takes grow the cycle (1Q -> 4Q -> 12Q). The published
      // clock is the raw transport in two parts, the zero and the
      // zero-relative position: their sum counts every sample driven.
      celestrian::test_utils::recordClip(*engine, process, 4 * Q);
      celestrian::test_utils::recordClip(*engine, process, 3 * Q);
      expectEquals(rootProp(*engine, "islandZero"), t0,
                   "no commit moves the zero");
      expectEquals(t0 + rootProp(*engine, "islandPos"), driven,
                   "transport = samples driven since t = 0 (no snap, no wrap)");
    }

    beginTest("The first take's cursor is the take's own position, whatever "
              "the clock read when it was armed");
    {
      auto engine = std::make_unique<AudioEngine>();
      const auto process = [&](int64_t total_samples) {
        driveEngine(*engine, total_samples, BLOCK_SIZE);
      };
      engine->createNode("clip");
      const juce::String id = firstNodeId(*engine);

      // The transport has run for no whole number of seconds when the
      // first take is armed: the cursor it folded on one second until
      // now stands mid-second.
      engine->togglePlayback();
      process(3 * Q + 1234);
      expectEquals(rootProp(*engine, "masterPos"), (int64_t)1234,
                   "before Q the cursor folds on one second");

      engine->startRecordingInNode(id);
      process(BLOCK_SIZE);  // the arm block: the take starts at its top
      expectEquals((int64_t)deepProp(*engine, id, "duration"),
                   (int64_t)BLOCK_SIZE, "one block captured");
      expectEquals(rootProp(*engine, "masterPos"), (int64_t)BLOCK_SIZE,
                   "the cursor starts where the take starts");

      // No cycle exists to fold on: it runs on past one second with the
      // take, and is the clock read from the zero the take established.
      process(Q + Q / 2);
      const int64_t taken = BLOCK_SIZE + Q + Q / 2;
      expectEquals((int64_t)deepProp(*engine, id, "duration"), taken,
                   "the take grew with every block");
      expectEquals(rootProp(*engine, "masterPos"), taken,
                   "the cursor is the take's length");
      expectEquals(rootProp(*engine, "islandPos"), taken,
                   "which is the clock since the island zero");

      // The stop commits at once; the callback hands the view back to
      // the cycle at its next block, and the cycle is the take.
      engine->stopRecordingInNode(id);
      expectEquals(rootProp(*engine, "quantum"), taken, "the take is Q");
      expectEquals(rootProp(*engine, "masterPos"), taken,
                   "the commit moves no cursor");
      process(BLOCK_SIZE);
      expectEquals(rootProp(*engine, "masterPos"), (int64_t)BLOCK_SIZE,
                   "the next block wraps it on the new cycle");
    }

    beginTest("With a round-trip latency the first take starts that much "
              "earlier on the heard clock, and the cursor is still its "
              "own position");
    {
      auto engine = std::make_unique<AudioEngine>();
      const auto process = [&](int64_t total_samples) {
        driveEngine(*engine, total_samples, BLOCK_SIZE);
      };
      // A calibrated loopback of `latency` samples (the loopback block
      // must be shorter than the delay it feeds back).
      const int latency = 137;
      engine->startLatencyCalibration();
      celestrian::test_utils::runLoopback(*engine, latency, 128, 800);
      engine->createNode("clip");
      const juce::String id = firstNodeId(*engine);

      engine->togglePlayback();
      const int64_t t0 = 2 * Q + 4321;
      process(t0);
      engine->startRecordingInNode(id);
      process(3 * BLOCK_SIZE);

      // What arrives at the arm was played against what sounded one
      // round trip earlier: the take's top is there, and the cursor
      // leads the captured length by the round trip.
      expectEquals((int64_t)deepProp(*engine, id, "origin"), t0 - latency,
                   "the take starts one round trip before the arm");
      expectEquals((int64_t)deepProp(*engine, id, "duration"),
                   (int64_t)(3 * BLOCK_SIZE), "three blocks captured");
      expectEquals(rootProp(*engine, "masterPos"),
                   (int64_t)(3 * BLOCK_SIZE + latency),
                   "the cursor is the clock since the take's top");
      expectEquals(rootProp(*engine, "islandPos"),
                   rootProp(*engine, "masterPos"),
                   "the island zero is that top");
      engine->stopRecordingInNode(id);
    }

    beginTest("Stop/play is pause/resume (view freezes, phase continues); "
              "an arm starts a stopped transport");
    {
      auto engine = std::make_unique<AudioEngine>();
      const auto process = [&](int64_t total_samples) {
        driveEngine(*engine, total_samples, BLOCK_SIZE);
      };
      engine->createNode("clip");
      const juce::String id = firstNodeId(*engine);
      expect(!engine->isPlaying(), "a new engine is stopped");

      engine->startRecordingInNode(id);  // zero = 0
      expect(engine->isPlaying(), "an arm starts the transport");
      process(Q);
      engine->stopRecordingInNode(id);  // immediate commit: 1Q clip

      process(Q / 4);
      expectEquals(rootProp(*engine, "masterPos"), Q / 4,
                   "quarter of the way into the cycle");

      engine->togglePlayback();  // stop
      expect(!engine->isPlaying());
      process(2 * BLOCK_SIZE);  // callbacks keep running while stopped
      expectEquals(rootProp(*engine, "masterPos"), Q / 4,
                   "stopping freezes the view");

      engine->togglePlayback();  // play
      process(Q / 4);
      expectEquals(rootProp(*engine, "masterPos"), Q / 2,
                   "playing resumes from the stopped phase");

      // Stopped again, an arm on a fresh clip restarts it.
      engine->togglePlayback();
      const juce::String second =
          celestrian::test_utils::addNode(*engine, "clip");
      engine->startRecordingInNode(second);
      expect(engine->isPlaying(), "the next arm restarts the transport");
      engine->stopRecordingInNode(second);
    }
  }
};

static MonotonicClockTests monotonicClockTests;
