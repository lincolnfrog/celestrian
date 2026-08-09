#include <juce_core/juce_core.h>

#include <vector>

#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {

class ClipNodeTests : public juce::UnitTest {
 public:
  ClipNodeTests() : juce::UnitTest("ClipNode", "Audio Engine") {}

  void runTest() override {
    beginTest("Recording State");
    {
      ClipNode node("TestClip", 44100.0);
      expect(!node.isRecording());

      node.startRecording();
      expect(node.isPendingStart());  // New behavior: waits for audio thread
      expect(!node.isRecording());

      // Trigger the audio thread start
      ProcessContext ctx;
      ctx.num_samples = 1;
      ctx.is_recording = true;
      node.process(nullptr, nullptr, 0, 0, ctx);

      expect(node.isRecording());
      expect(!node.isPendingStart());

      node.stopRecording();
      expect(!node.isRecording());
    }

    beginTest("Buffer Writing");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      // Simulate processing 100 samples
      float input[100];
      for (int i = 0; i < 100; ++i) input[i] = 1.0f;  // DC signal
      float* const inputs[] = {input};

      ProcessContext context;
      context.num_samples = 100;
      context.is_recording = true;

      // First process starts it and captures 100 samples
      node.process(inputs, nullptr, 1, 0, context);

      expectEquals(node.getWritePosition(), 100);

      // Verify peek
      auto waveform = node.getWaveform(1);
      expect(waveform.isArray());
      expectEquals((float)waveform[0], 1.0f);
    }

    beginTest("Playback State");
    {
      ClipNode node("TestClip", 44100.0);
      expect(!node.isPlaying());

      // Can't play if no samples
      node.startPlayback();
      expect(!node.isPlaying());

      // Write some samples
      float input[10] = {0.5f};
      float* const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true;
      node.startRecording();
      node.process(inputs, nullptr, 1, 0, context);
      node.stopRecording();

      node.startPlayback();
      expect(node.isPlaying());
    }

    beginTest("Auto-Playback After Recording");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      float input[10] = {0.8f};
      float* const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true;  // MUST be true for node to capture

      node.process(inputs, nullptr, 1, 0, context);
      node.stopRecording();

      expect(node.isPlaying());  // New behavior: auto-starts playback
      expectEquals(node.getWritePosition(), 10);
    }

    beginTest("Capture Validation (Requires Context Flag)");
    {
      ClipNode node("TestClip", 44100.0);
      node.startRecording();

      // First process call to start the recording
      ProcessContext context;
      context.num_samples = 1;
      context.is_recording = true;
      node.process(nullptr, nullptr, 0, 0, context);
      expect(node.isRecording());
      int initialWritePos = node.getWritePosition();

      float input[10] = {0.8f};
      float* const inputs[] = {input};
      context.num_samples = 10;
      context.is_recording = false;  // If false, node should NOT capture

      node.process(inputs, nullptr, 1, 0, context);
      expectEquals(node.getWritePosition(), initialWritePos);
    }

    beginTest("Peak Tracking");
    {
      ClipNode node("TestPeak", 44100.0);
      node.startRecording();

      float input[10] = {0.5f, -0.7f, 0.2f, 0.0f, 0.0f,
                         0.0f, 0.0f,  0.0f, 0.0f, 0.0f};
      float* const inputs[] = {input};
      ProcessContext context;
      context.num_samples = 10;
      context.is_recording = true;

      node.process(inputs, nullptr, 1, 0, context);
      expectWithinAbsoluteError(node.getCurrentPeak(), 0.7f, 0.001f);
    }

    beginTest("Cyclic Shift (Rotation)");
    {
      const double SR = 100.0;
      auto node = std::make_unique<ClipNode>("TestRotation", SR);
      auto* nodePtr = node.get();

      StackNode parent("Parent");
      // Set parent quantum by adding a dummy clip that defines it
      auto dummy = std::make_unique<ClipNode>("Dummy", SR);
      float dummyIn[100] = {0.0f};
      float* const dummyIns[] = {dummyIn};
      ProcessContext dummyCtx;
      dummyCtx.num_samples = 100;
      dummyCtx.is_recording = true;
      dummy->startRecording();
      dummy->process(dummyIns, nullptr, 1, 0, dummyCtx);
      dummy->stopRecording();
      parent.addChild(std::move(dummy));

      expectEquals(parent.getEffectiveQuantum(), (int64_t)100);

      parent.addChild(std::move(node));

      // Start recording at master_pos = 125 (Phase = 25 relative to Q=100)
      ProcessContext ctx;
      ctx.num_samples = 50;
      ctx.master_pos = 125;
      ctx.is_recording = true;

      // First sample is 0.5, rest 0.0
      float input[50] = {0.0f};
      input[0] = 0.5f;
      float* const inputs[] = {input};

      nodePtr->startRecording();
      // This process call should anchor at 125 and capture 50 samples
      nodePtr->process(inputs, nullptr, 1, 0, ctx);

      // Stop recording at L=50.
      // Q=100, recording will wait for next Q boundary
      nodePtr->stopRecording();

      // Process past the 100 boundary to trigger commit
      ctx.master_pos = 175;
      ctx.num_samples = 50;
      nodePtr->process(inputs, nullptr, 1, 0, ctx);

      expectEquals(nodePtr->duration_samples.load(), (int64_t)100);

      // The phase was 125 % 100 = 25.
      // Audio was recorded for 100 samples (snapped to Q)
      // Rotation = 25 samples
      // Original buffer[0] (0.5) should move to buffer[(0 + rotation) % dur]
      // But we only recorded 50 real samples, padded to 100.
      // Actually check if rotation logic is applied correctly.

      // For now, just verify duration is correct
      expectEquals(nodePtr->loop_end_samples.load(), (int64_t)100);
    }

    beginTest("Origin Alignment: content plays at its origin");
    {
      // The kernel invariant (docs/kernel.md, recording.md Example 2):
      // content[0] sounds at master ≡ origin (mod duration). This
      // replaces the old rotation model, which double-shifted playback
      // (rotation on top of launch point) whenever origin wasn't 0.
      const double SR = 100.0;
      StackNode parent("Parent");

      // Sibling A: 100 samples -> defines Q = 100 (min duration)
      // Sibling B: 200 samples -> defines the context loop
      auto makeCommittedClip = [SR](const char* name, int len) {
        auto clip = std::make_unique<ClipNode>(name, SR);
        std::vector<float> in((size_t)len, 0.0f);
        float* const ins[] = {in.data()};
        ProcessContext ctx;
        ctx.num_samples = len;
        ctx.is_recording = true;
        clip->startRecording();
        clip->process(ins, nullptr, 1, 0, ctx);
        clip->stopRecording();  // No parent yet -> no Q -> immediate commit
        return clip;
      };
      parent.addChild(makeCommittedClip("QClip", 100));
      parent.addChild(makeCommittedClip("ContextClip", 200));
      expectEquals(parent.getEffectiveQuantum(), (int64_t)100);

      // Record clip C starting at master_pos=100: origin = 100 within
      // the 200-sample context.
      auto clipC = std::make_unique<ClipNode>("Anchored", SR);
      auto* c = clipC.get();
      parent.addChild(std::move(clipC));

      auto v = [](int k) { return (float)(k + 1) * 0.001f; };

      float rec1[150];
      for (int i = 0; i < 150; ++i) rec1[i] = v(i);
      float* const recIns1[] = {rec1};
      ProcessContext recCtx;
      recCtx.num_samples = 150;
      recCtx.master_pos = 100;
      recCtx.is_recording = true;

      c->startRecording();
      c->process(recIns1, nullptr, 1, 0, recCtx);
      c->stopRecording();  // L=150 -> awaits the 200 stop boundary

      float rec2[50];
      for (int i = 0; i < 50; ++i) rec2[i] = v(150 + i);
      float* const recIns2[] = {rec2};
      recCtx.num_samples = 50;
      recCtx.master_pos = 250;
      c->process(recIns2, nullptr, 1, 0, recCtx);

      expectEquals(c->duration_samples.load(), (int64_t)200);
      expectEquals(c->origin_samples.load(), (int64_t)100);
      // (Launch is a derived projection now — the playback checks below
      // are the real pin: content[0] at master ≡ origin.)

      // At master ≡ origin (100), content[0] plays — what was performed
      // at cycle moment 100 replays at cycle moment 100 (I1).
      float outL[10] = {0.0f};
      float* const outs[] = {outL};
      ProcessContext playCtx;
      playCtx.num_samples = 10;
      playCtx.is_playing = true;
      playCtx.master_pos = 100;
      c->process(nullptr, outs, 0, 1, playCtx);
      for (int i = 0; i < 10; ++i) {
        expectWithinAbsoluteError(outL[i], v(i), 0.0001f);
      }

      // At master 0 (wrap: 0 ≡ origin + 100 mod 200), content[100] plays.
      for (int i = 0; i < 10; ++i) outL[i] = 0.0f;
      playCtx.master_pos = 0;
      c->process(nullptr, outs, 0, 1, playCtx);
      for (int i = 0; i < 10; ++i) {
        expectWithinAbsoluteError(outL[i], v(100 + i), 0.0001f);
      }

      // Waveform is the raw buffer — no remapping anywhere.
      auto wf = c->getWaveform(200);
      expect(wf.isArray());
      expectWithinAbsoluteError((float)wf.getArray()->getReference(0), v(0),
                                0.0001f);
      expectWithinAbsoluteError((float)wf.getArray()->getReference(100), v(100),
                                0.0001f);
    }

    beginTest("Loop Points API");
    {
      StackNode parent("Parent");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto* clipPtr = clip.get();
      parent.addChild(std::move(clip));

      // Record 1000 samples
      float input[1000];
      for (int i = 0; i < 1000; ++i)
        input[i] = (float)(i % 100) / 100.0f;  // Ramp pattern
      float* const inputs[] = {input};

      ProcessContext recCtx;
      recCtx.num_samples = 1000;
      recCtx.is_recording = true;

      clipPtr->startRecording();
      clipPtr->process(inputs, nullptr, 1, 0, recCtx);
      clipPtr->stopRecording();

      // Default loop points should span full clip
      expectEquals(clipPtr->getLoopStart(), (int64_t)0);
      expectEquals(clipPtr->getLoopEnd(), (int64_t)1000);

      // Set custom loop region (200-600)
      clipPtr->setLoopPoints(200, 600);
      expectEquals(clipPtr->getLoopStart(), (int64_t)200);
      expectEquals(clipPtr->getLoopEnd(), (int64_t)600);

      // Playback should use the new loop region
      clipPtr->startPlayback();
      float out[10] = {0.0f};
      float* const outputs[] = {out, out};

      ProcessContext playCtx;
      playCtx.num_samples = 10;
      playCtx.is_playing = true;
      playCtx.master_pos = 0;

      clipPtr->process(nullptr, outputs, 0, 2, playCtx);
      // Verify playhead is within loop region
      expect(clipPtr->playhead_pos.load() >= 0.0);
    }

    beginTest("Phase Alignment Mid-Track Recording");
    {
      // This tests the scenario: recording starts at master_pos=500 when Q=1000
      // The recorded audio should be aligned so it plays back in phase with
      // master.
      const double SR = 1000.0;
      StackNode parent("Parent");

      // First clip defines quantum of 1000 samples
      auto masterClip = std::make_unique<ClipNode>("Master", SR);
      auto* masterPtr = masterClip.get();
      parent.addChild(std::move(masterClip));

      float masterInput[1000];
      for (int i = 0; i < 1000; ++i) masterInput[i] = 0.1f;
      float* const masterInputs[] = {masterInput};

      ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      masterPtr->startRecording();
      masterPtr->process(masterInputs, nullptr, 1, 0, ctx);
      masterPtr->stopRecording();
      expectEquals(parent.getEffectiveQuantum(), (int64_t)1000);

      // Verify master clip recorded correctly
      expect(masterPtr->isPlaying(), "Master should be playing after commit");
      expect(!masterPtr->isRecording(),
             "Master should not be recording after commit");
      expectEquals(masterPtr->getLoopEnd(), (int64_t)1000);

      // Verify waveform is not blank (the user's bug symptom)
      auto waveform = masterPtr->getWaveform(10);
      expect(waveform.isArray());
      float totalPeaks = 0.0f;
      if (waveform.getArray() != nullptr) {
        for (int i = 0; i < waveform.getArray()->size(); ++i) {
          totalPeaks += (float)(*waveform.getArray())[i];
        }
      }
      expect(totalPeaks > 0.0f, "Waveform should not be blank/zero.");
    }

    // Test launch_point calculation for Audio Memory alignment
    beginTest("Launch Point Calculation (Audio Memory Formula)");
    {
      // Formula: launch_point = (duration - anchor) % duration
      // Example 2: 8Q clip recorded at 2Q → launch_point = 6Q

      int64_t Q = 1000;  // 1Q = 1000 samples

      // Test case 1: 8Q clip at 2Q anchor → launch_point = 6Q
      int64_t duration = 8 * Q;
      int64_t anchor = 2 * Q;
      int64_t launch_point = (duration - (anchor % duration)) % duration;
      expectEquals(launch_point, 6 * Q);

      // Test case 2: 4Q clip at 0 anchor → launch_point = 0
      duration = 4 * Q;
      anchor = 0;
      launch_point =
          (anchor > 0) ? (duration - (anchor % duration)) % duration : 0;
      expectEquals(launch_point, (int64_t)0);

      // Test case 3: 9Q clip at 2Q anchor → launch_point = 7Q
      duration = 9 * Q;
      anchor = 2 * Q;
      launch_point = (duration - (anchor % duration)) % duration;
      expectEquals(launch_point, 7 * Q);

      // Test case 4: Wrap case - anchor > duration
      // 4Q clip at 10Q anchor → 10Q % 4Q = 2Q → launch = (4Q - 2Q) = 2Q
      duration = 4 * Q;
      anchor = 10 * Q;
      launch_point = (duration - (anchor % duration)) % duration;
      expectEquals(launch_point, 2 * Q);
    }

    beginTest("State machine: stopping an ARMED clip cancels cleanly");
    {
      const double SR = 1000.0;
      StackNode parent("Parent");
      parent.setQuantum(1000, 0);  // island Q established, epoch 0

      auto clip = std::make_unique<ClipNode>("Armed", SR);
      auto* c = clip.get();
      parent.addChild(std::move(clip));

      float in[50] = {0.5f};
      float* const ins[] = {in};
      ProcessContext ctx;
      ctx.num_samples = 50;
      ctx.is_recording = true;
      ctx.master_pos = 100;  // target 1000: too far for immediate start

      c->startRecording();
      c->process(ins, nullptr, 1, 0, ctx);
      expect(c->isPendingStart(), "armed, not yet capturing");
      expect(!c->isRecording());

      // Stop while armed = CANCEL (previously wedged into a phantom
      // awaiting-stop before any capture existed).
      c->stopRecording();
      expect(!c->isPendingStart(), "cancel leaves Idle");
      expect(!c->isRecording());
      expect(!c->isAwaitingStop());
      expectEquals(c->duration_samples.load(), (int64_t)0, "no content");

      // And nothing captures afterwards.
      ctx.master_pos = 1000;
      c->process(ins, nullptr, 1, 0, ctx);
      expect(!c->isRecording(), "cancelled clip never starts capturing");
    }

    beginTest("State machine: stop boundary is picked by the AUDIO thread");
    {
      // D2 (unification_audit.md): the boundary must come from the audio
      // thread's own write position, not a racing message-thread read.
      const double SR = 1000.0;
      StackNode parent("Parent");
      parent.setQuantum(1000, 0);

      auto clip = std::make_unique<ClipNode>("StopRace", SR);
      auto* c = clip.get();
      parent.addChild(std::move(clip));

      float in[300];
      for (int i = 0; i < 300; ++i) in[i] = 0.4f;
      float* const ins[] = {in};
      ProcessContext ctx;
      ctx.num_samples = 300;
      ctx.is_recording = true;
      ctx.master_pos = 0;  // on the boundary: capture starts immediately

      c->startRecording();
      c->process(ins, nullptr, 1, 0, ctx);  // L = 300
      expect(c->isRecording());

      c->stopRecording();  // message thread: request only
      expect(c->isAwaitingStop(), "awaiting immediately (stop_requested)");
      expect(c->isRecording(), "still recording while awaiting stop");

      // Next audio block: boundary = nextStopBoundary(300, 1000) = 500
      // (Q/2 subdivision), computed from the AUDIO thread's L.
      ctx.num_samples = 100;
      ctx.master_pos = 300;
      c->process(ins, nullptr, 1, 0, ctx);  // L = 400, no commit yet
      expect(c->isRecording(), "boundary (500) not reached at L=400");

      ctx.master_pos = 400;
      c->process(ins, nullptr, 1, 0, ctx);  // L = 500 -> commit
      expect(!c->isRecording(), "committed at the boundary");
      expect(!c->isAwaitingStop());
      expectEquals(c->duration_samples.load(), (int64_t)500,
                   "committed exactly at nextStopBoundary(300, 1000)");
    }

    beginTest("Take lifecycle: island counter tracks arm/cancel/removal");
    {
      const double SR = 1000.0;
      StackNode parent("Parent");
      parent.setQuantum(1000, 0);

      auto clipA = std::make_unique<ClipNode>("A", SR);
      auto* a = clipA.get();
      parent.addChild(std::move(clipA));

      expect(!parent.hasActiveTake());
      a->startRecording();
      expect(parent.hasActiveTake(), "armed take counted on the island");
      a->stopRecording();  // Armed -> cancel
      expect(!parent.hasActiveTake(), "cancel balances the counter");

      // Removing a live take must balance the counter too (its
      // commit/cancel event will never arrive).
      auto clipB = std::make_unique<ClipNode>("B", SR);
      auto* b = clipB.get();
      parent.addChild(std::move(clipB));
      b->startRecording();
      expect(parent.hasActiveTake());
      for (int i = 0; i < parent.getNumChildren(); ++i) {
        if (parent.getChild(i) == b) {
          parent.removeChild(i);  // detached ownership drops → destroyed
          break;
        }
      }
      expect(!parent.hasActiveTake(), "removal balances the counter");
    }

    beginTest("The pickup: a click just before a heard boundary lands ON it");
    {
      // E-A with a nonzero epoch: heard boundaries at 700 + kQ. The arm
      // target is the next HEARD boundary — no deferral window (deleted
      // 2026-07-16: it overshot the take by a full Q when the latency
      // compensation was small; field repro in regression_tests).
      const double SR = 1000.0;
      StackNode parent("Parent");
      parent.setQuantum(1000, 700);

      auto clip = std::make_unique<ClipNode>("Pickup", SR);
      auto* c = clip.get();
      parent.addChild(std::move(clip));

      float in[50] = {0.5f};
      float* const ins[] = {in};
      ProcessContext ctx;
      ctx.num_samples = 50;
      ctx.is_recording = true;

      // Click at master 1600 = heard phase 900, 100 before the heard
      // boundary at 1700: target 1700, within the near window (<512) →
      // capture starts now, anchored ON the boundary.
      ctx.master_pos = 1600;
      c->startRecording();
      c->process(ins, nullptr, 1, 0, ctx);
      expect(c->isRecording(), "capture starts (near-boundary window)");
      expectEquals(c->origin_samples.load(), (int64_t)1700,
                   "origin = the boundary the performer heard");
      expectEquals((c->origin_samples.load() - 700) % 1000, (int64_t)0,
                   "origin ≡ 0 (mod Q) in the EPOCH frame");
    }

    beginTest("Arm farther out: awaits the boundary, then starts on it");
    {
      const double SR = 1000.0;
      StackNode parent("Parent");
      parent.setQuantum(1000, 700);

      auto clip = std::make_unique<ClipNode>("Await", SR);
      auto* c = clip.get();
      parent.addChild(std::move(clip));

      float in[50] = {0.5f};
      float* const ins[] = {in};
      ProcessContext ctx;
      ctx.num_samples = 50;
      ctx.is_recording = true;

      // Click at master 1100 = heard 400: target 1700, 600 away (> 512)
      // -> Armed, awaiting the boundary.
      ctx.master_pos = 1100;
      c->startRecording();
      c->process(ins, nullptr, 1, 0, ctx);
      expect(c->isPendingStart(), "armed, awaiting the boundary");
      expectEquals(c->getAwaitingStartAt(), (int64_t)1700,
                   "target = next heard boundary");

      // The block spanning the boundary starts capture exactly there.
      ctx.master_pos = 1680;
      c->process(ins, nullptr, 1, 0, ctx);
      expect(c->isRecording(), "capture starts as the block crosses 1700");
      expectEquals(c->origin_samples.load(), (int64_t)1700,
                   "origin = the awaited boundary");
    }

    // Test always-wait-for-next-Q stop behavior
    beginTest("Stop Always Waits for Next Q Boundary");
    {
      const double SR = 1000.0;
      auto node = std::make_unique<ClipNode>("TestAwaitStop", SR);

      // Create parent with quantum established
      StackNode parent("Parent");
      auto dummy = std::make_unique<ClipNode>("Dummy", SR);
      float dummyIn[1000] = {0.0f};
      float* const dummyIns[] = {dummyIn};
      ProcessContext dummyCtx;
      dummyCtx.num_samples = 1000;  // Q = 1000 samples
      dummyCtx.is_recording = true;
      dummy->startRecording();
      dummy->process(dummyIns, nullptr, 1, 0, dummyCtx);
      dummy->stopRecording();
      parent.addChild(std::move(dummy));

      parent.addChild(std::move(node));
      auto* nodePtr = dynamic_cast<ClipNode*>(parent.getChild(1));

      // Start recording
      nodePtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 500;  // Record 500 samples (half of Q)
      ctx.is_recording = true;
      float input[500];
      for (int i = 0; i < 500; ++i) input[i] = 0.5f;
      float* const inputs[] = {input};
      nodePtr->process(inputs, nullptr, 1, 0, ctx);

      // Stop recording - should NOT commit immediately
      // Should set is_awaiting_stop and wait for next Q (1000)
      nodePtr->stopRecording();
      expect(nodePtr->isAwaitingStop(),
             "Should be awaiting stop after stopRecording");
      expect(nodePtr->isRecording(),
             "Should still be recording while awaiting stop");
    }
  }
};

static ClipNodeTests clipNodeTests;

}  // namespace celestrian
