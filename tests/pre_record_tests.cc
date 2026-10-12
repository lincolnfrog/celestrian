/**
 * Pre-Record Ring / Arrival-Time Capture Tests (docs/performance.md §3)
 *
 * The alignment invariant under test: a note played on the HEARD beat must
 * land ON the beat in the committed clip. The note's audio arrives at the
 * input `round-trip latency` samples after the beat, so capture must map
 * clip position 0 to the input that arrived at (boundary + latency) — not
 * to whatever arrived when the recording state flipped.
 *
 * Scenario:
 *   1. Calibrate a synthetic loopback of exactly D samples.
 *   2. Record clip A (1Q = 1000 samples) to establish the grid.
 *   3. Arm clip B mid-loop; it waits for the 1000 boundary.
 *   4. Inject an impulse whose ARRIVAL is exactly D samples after the
 *      boundary — the arrival time of a note played on the heard beat.
 *   5. After commit, the impulse must sit at clip position 0, and
 *      nowhere else.
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "test_utils.h"

using celestrian::test_utils::rootProp;
using celestrian::test_utils::childDuration;
using celestrian::test_utils::childId;
using celestrian::test_utils::childIsRecording;
using celestrian::test_utils::driveEngine;
using celestrian::test_utils::firstNodeId;
using celestrian::test_utils::runLoopback;

class PreRecordTests : public juce::UnitTest {
 public:
  PreRecordTests() : juce::UnitTest("Pre-Record Capture", "Audio Engine") {}

  void runTest() override {
    beginTest("Note played on the heard beat lands at clip position 0");
    {
      const int D = 137;      // calibrated round-trip latency
      const int BLOCK = 500;  // even divisor of the 1000-sample loop

      auto owned = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owned;
      const auto silence = [&] { driveEngine(engine, BLOCK, BLOCK); };

      // --- 1. Calibrate a synthetic loopback of exactly D samples ---
      // Loopback block must be < D: the harness can only feed back output
      // from *previous* callbacks (real hardware has no such limit).
      engine.startLatencyCalibration();
      runLoopback(engine, D, 128, 800);
      auto cal = engine.getLatencyCalibration();
      expectEquals((int64_t)(double)cal.getDynamicObject()->getProperty(
                       "roundTripSamples"),
                   (int64_t)D, "calibration must measure the loopback exactly");

      // --- 2. Record clip A: 1000 samples -> Q = 1000 ---
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      silence();
      silence();
      engine.stopRecordingInNode(clipA);  // no Q yet -> immediate commit
      expectEquals(childDuration(engine, 0), (int64_t)1000,
                   "clip A defines a 1000-sample grid");

      // --- 3. Walk the transport to master == 500 (mid-loop) ---
      for (int i = 0; i < 8 && rootProp(engine, "masterPos") != 500; ++i) {
        silence();
      }
      expectEquals(rootProp(engine, "masterPos"), (int64_t)500,
                   "transport reaches master == 500");

      // --- 4. Arm clip B and cross the boundary ---
      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);

      // Block master 500 -> 1000: B arms for the 1000 boundary and starts
      // recording as the block crosses it. Its capture window begins at
      // the arrival time of performance-time 1000, i.e. D samples after
      // the boundary — D into the NEXT block's input.
      silence();

      // --- 5. The "note on the heard beat": arrival = boundary + D ---
      // Relative to this next block (arrivals cover boundary..boundary+500),
      // the note's arrival offset is exactly D.
      std::vector<float> in((size_t)BLOCK, 0.0f), out_l((size_t)BLOCK),
          out_r((size_t)BLOCK);
      in[(size_t)D] = 0.8f;
      const float* ins[] = {in.data()};
      float* outs[] = {out_l.data(), out_r.data()};
      engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, BLOCK, {});

      // --- 6. Stop; capture runs until the 1000-sample window closes ---
      silence();
      engine.stopRecordingInNode(clipB);  // L < 1000 -> awaits boundary 1000
      for (int i = 0; i < 4 && childIsRecording(engine, 1); ++i) silence();

      expectEquals(childDuration(engine, 1), (int64_t)1000,
                   "clip B snaps to 1Q");

      // --- 7. The impulse must be at clip position 0 ---
      auto wf = engine.getWaveform(clipB, 1000);
      expect(wf.isArray());
      auto* peaks = wf.getArray();
      expectWithinAbsoluteError((float)peaks->getReference(0), 0.8f, 0.0001f,
                                "note played on the heard beat lands at "
                                "clip position 0");

      // A capture from the live block would place the impulse D samples
      // late (plus the block remainder): the rest of the clip is silent.
      float residual = 0.0f;
      for (int i = 1; i < 1000; ++i) {
        residual = std::max(residual, (float)peaks->getReference(i));
      }
      expectWithinAbsoluteError(residual, 0.0f, 0.0001f,
                                "no misplaced copy of the note elsewhere");
    }
  }
};

static PreRecordTests preRecordTests;
