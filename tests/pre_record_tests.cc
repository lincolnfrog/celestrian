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
 *   5. After commit, the impulse must sit at clip position 0.
 *      (Pre-fix behavior put it at position D + block remainder.)
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <vector>

#include "../src/audio_engine.h"

class PreRecordTests : public juce::UnitTest {
 public:
  PreRecordTests() : juce::UnitTest("Pre-Record Capture", "Audio Engine") {}

  void runTest() override {
    beginTest("Note played on the heard beat lands at clip position 0");
    {
      const int D = 137;      // calibrated round-trip latency
      const int BLOCK = 500;  // even divisor of the 1000-sample loop

      AudioEngine engine;

      // --- 1. Calibrate a synthetic loopback of exactly D samples ---
      // Loopback block must be < D: the harness can only feed back output
      // from *previous* callbacks (real hardware has no such limit).
      engine.startLatencyCalibration();
      runLoopback(engine, D, 128, 800);
      auto cal = engine.getLatencyCalibration();
      expectEquals(
          (int64_t)(double)cal.getDynamicObject()->getProperty(
              "roundTripSamples"),
          (int64_t)D, "calibration must measure the loopback exactly");

      // --- 2. Record clip A: 1000 samples -> Q = 1000 ---
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);  // resets transport to 0
      processSilence(engine, BLOCK);
      processSilence(engine, BLOCK);
      engine.stopRecordingInNode(clipA);  // no Q yet -> immediate commit
      expectEquals(nodeDuration(engine, 0), (int64_t)1000,
                   "clip A defines a 1000-sample grid");

      // --- 3. Walk the transport to master == 500 (mid-loop) ---
      bool at_mid = false;
      for (int i = 0; i < 8; ++i) {
        if (masterPos(engine) == 500) {
          at_mid = true;
          break;
        }
        processSilence(engine, BLOCK);
      }
      expect(at_mid, "transport reaches master == 500");

      // --- 4. Arm clip B and cross the boundary ---
      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);

      // Block master 500 -> 1000: B arms for the 1000 boundary and starts
      // recording as the block crosses it. Its capture window begins at
      // the arrival time of performance-time 1000, i.e. D samples after
      // the boundary — which is D-BLOCK+... into the NEXT block's input.
      processSilence(engine, BLOCK);

      // --- 5. The "note on the heard beat": arrival = boundary + D ---
      // Relative to this next block (arrivals cover boundary..boundary+500),
      // the note's arrival offset is exactly D.
      std::vector<float> in((size_t)BLOCK, 0.0f);
      in[(size_t)D] = 0.8f;
      processBlock(engine, in.data(), BLOCK);

      // --- 6. Stop; capture runs until the 1000-sample window closes ---
      processSilence(engine, BLOCK);
      engine.stopRecordingInNode(clipB);  // L < 1000 -> awaits boundary 1000
      for (int i = 0; i < 4 && nodeIsRecording(engine, 1); ++i) {
        processSilence(engine, BLOCK);
      }

      expectEquals(nodeDuration(engine, 1), (int64_t)1000,
                   "clip B snaps to 1Q");

      // --- 7. The impulse must be at clip position 0 ---
      auto wf = engine.getWaveform(clipB, 1000);
      expect(wf.isArray());
      auto *peaks = wf.getArray();
      expectWithinAbsoluteError((float)peaks->getReference(0), 0.8f, 0.0001f,
                                "note played on the heard beat lands at "
                                "clip position 0");

      // Regression guard: the pre-fix live-block capture would have placed
      // the impulse D samples late (plus block remainder). Ensure the rest
      // of the clip is silent.
      float residual = 0.0f;
      for (int i = 1; i < 1000; ++i) {
        residual = std::max(residual, (float)peaks->getReference(i));
      }
      expectWithinAbsoluteError(residual, 0.0f, 0.0001f,
                                "no misplaced copy of the note elsewhere");
    }

    beginTest("Recording after sustained playback (monotonic transport)");
    {
      // Field regression (2026-07-07): under the monotonic transport the
      // master position grows without bound while the groove loops. The
      // arm-time slot math used the ABSOLUTE position in one branch,
      // placing the recording clip's lane thousands of pixels
      // off-screen ("no waveform while recording clip 2"). Every other
      // test records immediately after a commit at tiny master values —
      // this one records after ~300k samples of playback, the shape the
      // field actually exercises.
      AudioEngine engine;
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      processSilence(engine, 500);
      processSilence(engine, 500);
      engine.stopRecordingInNode(clipA);  // Q = 1000
      expectEquals(nodeDuration(engine, 0), (int64_t)1000);

      // Let the groove run: master sails far past the committed LCM.
      for (int i = 0; i < 601; ++i) processSilence(engine, 500);

      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);

      // Capture must begin within a couple of cycles...
      bool capturing = false;
      for (int i = 0; i < 10 && !capturing; ++i) {
        processSilence(engine, 500);
        capturing = nodeIsRecording(engine, 1) && nodeDuration(engine, 1) > 0;
      }
      expect(capturing, "clip B captures after long playback");

      // ...and the recording clip must sit at a CYCLE-RELATIVE x —
      // context is 1Q here, so slot 0 — never an absolute-master slot.
      double x = (double)childVar(engine, 1).getDynamicObject()->getProperty(
          "x");
      expectEquals(x, 0.0,
                   "recording clip stays on screen (cycle-relative slot)");

      // Commit still snaps cleanly to the grid.
      engine.stopRecordingInNode(clipB);
      for (int i = 0; i < 8 && nodeIsRecording(engine, 1); ++i) {
        processSilence(engine, 500);
      }
      expect(!nodeIsRecording(engine, 1), "clip B commits");
      const int64_t durB = nodeDuration(engine, 1);
      expect(durB > 0 && durB % 1000 == 0,
             "committed duration snaps to a Q multiple");
      expectEquals(
          (double)childVar(engine, 1).getDynamicObject()->getProperty("x"),
          0.0, "committed x is cycle-relative");
    }

    beginTest("Long clip over short groove loops at 0Q (field regression)");
    {
      // Field bug (2026-07-07): 1Q groove, then a 4Q take recorded after
      // sustained playback, stopped mid-4th-Q (anticipatory snap to 4Q).
      // With the origin stored mod the CONTEXT (1Q), the which-cycle
      // information was lost and the committed clip looped at 3Q. The
      // origin must be absolute; the view epoch re-bases at commit so
      // the visual cycle top is the new phrase's top.
      AudioEngine engine;
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      processSilence(engine, 500);
      processSilence(engine, 500);
      engine.stopRecordingInNode(clipA);  // Q = 1000
      expectEquals(nodeDuration(engine, 0), (int64_t)1000);

      // Sustained playback: master far beyond the 1Q cycle, at a
      // position that is NOT a multiple of the eventual 4Q duration
      // (trigger lands at 302Q; 302 ≡ 2 mod 4 — the truncation case).
      for (int i = 0; i < 601; ++i) processSilence(engine, 500);

      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);

      // Record ~3.5Q, then stop mid-4th-Q -> anticipatory snap to 4Q.
      for (int i = 0; i < 8; ++i) processSilence(engine, 500);
      engine.stopRecordingInNode(clipB);
      for (int i = 0; i < 8 && nodeIsRecording(engine, 1); ++i) {
        processSilence(engine, 500);
      }
      expect(!nodeIsRecording(engine, 1), "clip B commits");
      expectEquals(nodeDuration(engine, 1), (int64_t)4000,
                   "anticipatory snap to 4Q");

      // One block after commit: clip B must be playing near ITS TOP
      // (0Q), not 2Q/3Q into itself, and the view cycle must have
      // re-based so masterPos is near 0 too.
      processSilence(engine, 500);
      const double playheadB =
          (double)childVar(engine, 1).getDynamicObject()->getProperty(
              "playhead");
      expect(playheadB < 0.3,
             "clip B loops from its own top after commit, not mid-clip "
             "(playhead=" +
                 juce::String(playheadB) + ")");
      const double masterView = (double)engine.getGraphState()
                                    .getDynamicObject()
                                    ->getProperty("masterPos");
      expect(masterView < 1500.0,
             "view re-based to the new phrase's top (masterPos=" +
                 juce::String(masterView) + ")");
    }

    beginTest("Anchor stays in the epoch frame after cycle re-base");
    {
      // Field bug (2026-07-07): 1Q groove, 4Q take whose commit re-based
      // the cycle epoch to its origin (7000; 7000 mod 4000 = 3000 — the
      // shifted case). Clicking record late in the VIEW cycle must then
      // anchor clip 3 at view 0Q — the arm math previously mixed the
      // absolute frame with the epoch-rebased view and anchored at 3Q.
      AudioEngine engine;
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      processSilence(engine, 500);
      processSilence(engine, 500);
      engine.stopRecordingInNode(clipA);  // Q = 1000, epoch = 0
      expectEquals(nodeDuration(engine, 0), (int64_t)1000);

      // Idle to master 6500, then record clip B: trigger = 7000.
      for (int i = 0; i < 11; ++i) processSilence(engine, 500);
      engine.createNode("clip", stackId);
      juce::String clipB = childId(engine, 1);
      engine.startRecordingInNode(clipB);
      for (int i = 0; i < 8; ++i) processSilence(engine, 500);
      engine.stopRecordingInNode(clipB);
      for (int i = 0; i < 4 && nodeIsRecording(engine, 1); ++i) {
        processSilence(engine, 500);
      }
      expectEquals(nodeDuration(engine, 1), (int64_t)4000,
                   "clip B is 4Q; its commit re-bases the epoch to 7000");

      // Idle to master 14500 = view 3.5Q, then click record: the PLL
      // targets the top of the NEXT cycle (view 0Q, absolute 15000).
      for (int i = 0; i < 7; ++i) processSilence(engine, 500);
      engine.createNode("clip", stackId);
      juce::String clipC = childId(engine, 2);
      engine.startRecordingInNode(clipC);
      processSilence(engine, 500);  // arms + starts (boundary within 512)

      // Keep the var alive while reading (getDynamicObject() points into
      // the refcounted var — a dangling pointer here read freed memory).
      auto cVar = childVar(engine, 2);
      auto *c = cVar.getDynamicObject();
      expectEquals((double)c->getProperty("x"), 0.0,
                   "clip C anchors at view 0Q, not 3Q (epoch frame)");
      expectEquals((int64_t)(double)c->getProperty("origin"), (int64_t)15000,
                   "origin is the absolute boundary moment");

      // Record 1.5Q, stop -> snaps to 2Q; committed x stays at 0Q and
      // playback wraps at the clip's own top.
      for (int i = 0; i < 3; ++i) processSilence(engine, 500);
      engine.stopRecordingInNode(clipC);
      for (int i = 0; i < 4 && nodeIsRecording(engine, 2); ++i) {
        processSilence(engine, 500);
      }
      expectEquals(nodeDuration(engine, 2), (int64_t)2000);
      expectEquals(
          (double)childVar(engine, 2).getDynamicObject()->getProperty("x"),
          0.0, "committed x remains at view 0Q");
      processSilence(engine, 500);
      const double playheadC =
          (double)childVar(engine, 2).getDynamicObject()->getProperty(
              "playhead");
      expect(playheadC < 0.3,
             "clip C plays from its top (playhead=" +
                 juce::String(playheadC) + ")");
    }

    beginTest("Uncalibrated engines still capture from the block start");
    {
      // With zero latency the window collapses to the boundary itself:
      // first-clip capture must be byte-identical to the old behavior.
      AudioEngine engine;
      engine.createNode("stack");
      juce::String stackId = firstNodeId(engine);
      engine.createNode("clip", stackId);
      juce::String clipA = childId(engine, 0);

      engine.startRecordingInNode(clipA);
      std::vector<float> in(500, 0.0f);
      in[0] = 0.5f;  // first captured sample
      processBlock(engine, in.data(), 500);
      processSilence(engine, 500);
      engine.stopRecordingInNode(clipA);

      expectEquals(nodeDuration(engine, 0), (int64_t)1000);
      auto wf = engine.getWaveform(clipA, 1000);
      expectWithinAbsoluteError((float)wf.getArray()->getReference(0), 0.5f,
                                0.0001f,
                                "first arrival lands at position 0");
    }
  }

 private:
  void processBlock(AudioEngine &engine, const float *in, int n) {
    std::vector<float> outL((size_t)n, 0.0f), outR((size_t)n, 0.0f);
    const float *ins[] = {in};
    float *outs[] = {outL.data(), outR.data()};
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
  }

  void processSilence(AudioEngine &engine, int n) {
    std::vector<float> in((size_t)n, 0.0f);
    processBlock(engine, in.data(), n);
  }

  int64_t masterPos(AudioEngine &engine) {
    return (int64_t)(double)engine.getGraphState()
        .getDynamicObject()
        ->getProperty("masterPos");
  }

  juce::String firstNodeId(AudioEngine &engine) {
    return engine.getGraphState()
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(0)
        .getDynamicObject()
        ->getProperty("id");
  }

  juce::var childVar(AudioEngine &engine, int index) {
    return engine.getGraphState()
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(0)
        .getDynamicObject()
        ->getProperty("nodes")
        .getArray()
        ->getReference(index);
  }

  juce::String childId(AudioEngine &engine, int index) {
    return childVar(engine, index).getDynamicObject()->getProperty("id");
  }

  int64_t nodeDuration(AudioEngine &engine, int index) {
    return (int64_t)(double)childVar(engine, index)
        .getDynamicObject()
        ->getProperty("duration");
  }

  bool nodeIsRecording(AudioEngine &engine, int index) {
    return (bool)childVar(engine, index).getDynamicObject()->getProperty(
        "isRecording");
  }

  /** Output→input feedback through a delay of D samples (see
      latency_calibration_tests.cc). */
  void runLoopback(AudioEngine &engine, int D, int block, int max_blocks) {
    std::vector<float> history;
    history.reserve((size_t)(max_blocks * block));

    std::vector<float> in((size_t)block, 0.0f);
    std::vector<float> outL((size_t)block, 0.0f), outR((size_t)block, 0.0f);
    const float *ins[] = {in.data()};
    float *outs[] = {outL.data(), outR.data()};

    for (int b = 0; b < max_blocks; ++b) {
      const int64_t block_start = (int64_t)b * block;
      for (int i = 0; i < block; ++i) {
        const int64_t src = block_start + i - D;
        in[(size_t)i] = (src >= 0 && src < (int64_t)history.size())
                            ? history[(size_t)src]
                            : 0.0f;
      }
      std::fill(outL.begin(), outL.end(), 0.0f);
      std::fill(outR.begin(), outR.end(), 0.0f);
      engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, block, {});
      history.insert(history.end(), outL.begin(), outL.end());

      auto status = engine.getLatencyCalibration();
      if (status.getDynamicObject()->getProperty("phase").toString() !=
          "capturing")
        return;
    }
  }
};

static PreRecordTests preRecordTests;
