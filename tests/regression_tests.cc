#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {
namespace {

// Regression-specific scaffolding. These helpers only move the repeated
// CONSTRUCTION boilerplate out of the tests below: the engine/node call
// sequences, their arguments, and their order are exactly the inline
// code they replaced.

// Build a ClipNode owned by `parent` and return the raw pointer the
// tests drive directly.
ClipNode* addClip(StackNode& parent, const char* name, double sample_rate) {
  auto clip = std::make_unique<ClipNode>(name, sample_rate);
  auto* clip_ptr = clip.get();
  parent.addChild(std::move(clip));
  return clip_ptr;
}

// The repeated context triple. All other fields (latency, solo, ...)
// stay at their defaults, exactly as the inline copies left them.
ProcessContext makeRecordingContext(int sample_count, int64_t master_position) {
  ProcessContext ctx;
  ctx.num_samples = sample_count;
  ctx.is_recording = true;
  ctx.master_pos = master_position;
  return ctx;
}

// The repeated "record a ClipNode with known content at a known
// position" scaffold: create the node under `parent`, point the shared
// context at (sample_count, master_position) with is_recording = true,
// then startRecording -> one process() over `inputs` -> stopRecording.
// The caller's ctx is updated in place so follow-up steps (commit
// loops, playback checks) continue from exactly the state the inline
// code left behind.
ClipNode* recordClipInto(StackNode& parent, const char* name,
                         double sample_rate, float* const* inputs,
                         int sample_count, int64_t master_position,
                         ProcessContext& ctx) {
  ClipNode* clip_ptr = addClip(parent, name, sample_rate);
  ctx.num_samples = sample_count;
  ctx.is_recording = true;
  ctx.master_pos = master_position;
  clip_ptr->startRecording();
  clip_ptr->process(inputs, nullptr, 1, 0, ctx);
  clip_ptr->stopRecording();
  return clip_ptr;
}

}  // namespace

class AudioEngineWorkflowTests : public juce::UnitTest {
 public:
  AudioEngineWorkflowTests()
      : juce::UnitTest("AudioEngine Workflow", "Audio Engine") {}

  void runTest() override {
    beginTest("Auto-Transport Start on Record");
    {
      AudioEngine engine;
      expect(!engine.isPlaying(), "Transport should be stopped initially.");

      // Create a clip node
      engine.createNode("clip");
      auto state = engine.getGraphState();
      auto nodes = state.getDynamicObject()->getProperty("nodes").getArray();
      expect(nodes->size() > 0);
      juce::String uuid = (*nodes)[0].getDynamicObject()->getProperty("id");

      // Starting recording should start transport
      engine.startRecordingInNode(uuid);
      expect(engine.isPlaying(),
             "Transport should auto-start when recording begins.");

      engine.togglePlayback();  // Stop
      expect(!engine.isPlaying());

      // Starting recording again should restart transport
      engine.startRecordingInNode(uuid);
      expect(engine.isPlaying(),
             "Transport should auto-restart when recording begins again.");
    }

    // BUG: "clip 2 loops to 1Q instead of 0Q"
    // Scenario: Clip 1 = 1Q, Clip 2 = 4Q recorded mid-loop
    // Expected: Clip 2 launch_point = 0 (loops to 0Q)
    beginTest("Clip 2 Should Loop to 0Q With 1Q Context");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // === Clip 1: 1Q (1000 samples) ===
      float clip1Input[1000];
      for (int i = 0; i < 1000; ++i) clip1Input[i] = 0.5f;
      float* const clip1Inputs[] = {clip1Input};

      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, clip1Inputs, 1000, 0, ctx);

      // Verify Clip 1 established Q
      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Clip 1 should establish Q = 1000");

      // === Clip 2: 4Q (4000 samples), starting at master_pos = 1000 (1Q) ===
      // This matches the user's scenario: StartTime=143872, Q=143872 (1Q =
      // 143872)
      float clip2Input[4000];
      for (int i = 0; i < 4000; ++i) clip2Input[i] = 0.3f;
      float* const clip2Inputs[] = {clip2Input};

      // master_pos = 1000: start at EXACTLY 1Q (user's actual scenario)
      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, clip2Inputs, 4000, 1000, ctx);

      // Continue processing to cross Q boundary and commit.
      // Keep the wall clock consistent with the samples processed: the
      // 4000-sample block began at master 1000, so it ended at 5000.
      ctx.master_pos = 4000;  // += 1000 below → next block starts at 5000
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;  // Advance by 1Q
        float more[1000];
        for (int i = 0; i < 1000; ++i) more[i] = 0.1f;
        float* const moreInputs[] = {more};
        ctx.num_samples = 1000;
        clip2Ptr->process(moreInputs, nullptr, 1, 0, ctx);
      }

      // The stored anchor/launch fields are gone — they are projections
      // of origin (kernel.md §2 table). The musical fact the old anchor
      // assertion pinned: the take began ≡ 0 (mod the 1Q context).
      const int64_t origin = clip2Ptr->origin_samples.load();
      const int64_t duration = clip2Ptr->duration_samples.load();

      juce::Logger::writeToLog(
          "TEST DEBUG: Clip2 origin=" + juce::String(origin) +
          ", duration=" + juce::String(duration));

      expectEquals(origin % 1000, (int64_t)0, "origin == 0 (mod 1Q context)");

      // The user-facing invariant ("loops to 0Q"): recording began at
      // t=1000 and ran 5000 samples, so the content wraps at t=6000 —
      // playback there must be at the clip's very top.
      ctx.master_pos = 6000;
      ctx.num_samples = 100;
      ctx.is_playing = true;
      ctx.is_recording = false;
      float out[100] = {0.0f};
      float* const outs[] = {out};
      clip2Ptr->process(nullptr, outs, 0, 1, ctx);
      expectWithinAbsoluteError(
          clip2Ptr->playhead_pos.load(), 0.0, 0.05,
          "playback continuous through commit: top of loop at t=6000");
    }

    // New Test: Clip 1 (First clip) should always result in launch_point=0
    {
      beginTest("Clip 1 (First Clip) Should have Launch=0");
      const double SR = 44100.0;
      StackNode parent("Parent");
      auto* clipPtr = addClip(parent, "Clip1", SR);

      // master_pos = 0: transport reset to 0
      ProcessContext ctx = makeRecordingContext(512, 0);

      clipPtr->startRecording();
      // Process 2 blocks (1024 samples)
      ctx.master_pos = 0;
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);
      ctx.master_pos = 512;
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);

      // Stop recording immediately (First Clip => immediate stop)
      clipPtr->stopRecording();

      expectEquals(clipPtr->origin_samples.load(), (int64_t)0,
                   "First clip origin is 0 (launch derives to 0)");

      // Verify commit master pos correctness
      // It should be equal to duration (1024)
      int64_t duration = clipPtr->duration_samples.load();
      int64_t commitPos = clipPtr->getCommitMasterPos();
      expectEquals(commitPos, duration,
                   "Commit pos should match duration for first clip");
    }

    // New Test: Clip 1 Stopped Mid-Block (Partial process check)
    {
      beginTest("Clip 1 Stopped Mid-Block (Immediate Commit)");
      const double SR = 44100.0;
      StackNode parent("Parent");
      auto* clipPtr = addClip(parent, "Clip1", SR);

      ProcessContext ctx = makeRecordingContext(512, 0);

      clipPtr->startRecording();
      // Process block 0
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);  // master 0, dur->512

      // Simulate stopping mid-way through next block?
      // Actually stopRecording() wraps up current state.
      // If we call stopRecording, it uses write_position.
      // Let's process block 1 fully.
      ctx.master_pos = 512;
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);  // master 512, dur->1024

      // So current durability is 1024.
      // And global master pos would be 1024 for next block.

      clipPtr->stopRecording();

      expectEquals(timing::launchPointFor(clipPtr->origin_samples.load(),
                                          clipPtr->duration_samples.load()),
                   (int64_t)0, "Derived launch is 0 even with blocks");

      // Wait, let's verify Playhead at Commit Time.
      // commitPos = 1024. duration = 1024.
      // launch = (1024 - 1024 % 1024) % 1024 = 0.

      // Playback at master=1024 should be 0%.
      // effective = (1024 + 0) % 1024 = 0.

      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos = 1024;
      clipPtr->process(nullptr, nullptr, 0, 2, ctx);

      double playhead = clipPtr->playhead_pos.load();
      expectWithinAbsoluteError(
          playhead, 0.0, 0.001,
          "Playhead at commit time (end of loop) should be 0");
    }

    // Regression Test: Clip 3 x_pos should stay within timeline bounds
    // Bug: Clip 3 was shooting off to the right because quantum_offset was 3+
    {
      beginTest("Clip 3 x_pos Should Stay In Bounds");
      const double SR = 44100.0;
      StackNode parent("Parent");

      // Dummy input data for recording
      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q (establishes quantum), Q = 1000
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      expectEquals(parent.getEffectiveQuantum(), (int64_t)1000);

      // Clip 2: 4Q, start at 1Q
      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs, 4000, 1000, ctx);
      ctx.master_pos = 5000;
      ctx.num_samples = 100;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);  // Commit

      // Clip 3: Start recording at master_pos = 2500 (between 2Q and 3Q)
      // With context_loop = 4000 (4Q), next_q = 3000 (3Q)
      // Slot should be based on effective position: 2500 % 4000 = 2500
      // next_q=3000 <= context=4000, so slot should use effective_pos
      auto* clip3Ptr = addClip(parent, "Clip3", SR);

      ctx.master_pos = 2500;
      ctx.num_samples = 100;
      clip3Ptr->startRecording();
      clip3Ptr->process(inputs, nullptr, 1, 0,
                        ctx);  // Trigger pending start logic

      // Pixels are gone from the engine (I6): the lane position is a UI
      // projection of origin. The musical fact the old x-bounds check
      // pinned: arming at 2500 targets the NEXT Q boundary, 3000.
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)3000,
                   "arm at 2500 targets the 3Q boundary");
    }

    // Regression Test: Clip 3 recorded AFTER context has looped multiple times
    {
      beginTest("Clip 3 After Multiple Loops Should Stay In Bounds");
      const double SR = 44100.0;
      StackNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      // Clip 2: 4Q at slot 0 (starts at 1Q boundary — master_pos 1000,
      // the Q boundary after clip 1)
      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs, 4000, 1000, ctx);
      // Keep is_recording=true so samples continue writing until commit
      // boundary
      ctx.master_pos = 5000;
      ctx.num_samples =
          1500;  // write_position 4000 + 1500 = 5500, crosses 5000
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);  // Should trigger commit

      // Verify clip 2 committed (duration gets snapped to Q at 5000)
      expectEquals(clip2Ptr->duration_samples.load(), (int64_t)5000);

      // Clip 3: Start recording at 10500 (after 2+ full context loops)
      // master_pos = 10500, context_loop = 4000
      // compensated_pos = 10500 % 4000 = 2500 (between 2Q and 3Q)
      // next_q = ceil(10500/1000) * 1000 = 11000
      // Since next_q > context_loop, slot should use next_q / Q
      // BUT we don't want it to shoot off the screen
      auto* clip3Ptr = addClip(parent, "Clip3", SR);

      ctx.master_pos = 10500;
      ctx.num_samples = 100;
      clip3Ptr->startRecording();
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      // Old bug: absolute slots flew off-screen after loops. Kernel
      // form: origin is absolute (11000 = the boundary after 10500);
      // its CYCLE projection (origin mod context 5000 = 1000) is what
      // the UI draws, in bounds by construction.
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)11000,
                   "arm at 10500 targets the next Q boundary, 11000");
      expectEquals(clip3Ptr->origin_samples.load() % 5000, (int64_t)1000,
                   "cycle projection lands at 1Q of the 5Q context");
    }

    // Regression Test: x_pos should NOT compound across multiple process()
    // calls This emulates real audio loop behavior where process() is called
    // continuously
    {
      beginTest("x_pos Stability Across Multiple Process Calls");
      const double SR = 44100.0;
      StackNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      // Clip 2: Start recording at Q boundary, then call process() 100 times
      // This simulates the real audio loop behavior
      auto* clip2Ptr = addClip(parent, "Clip2", SR);

      ctx.master_pos = 500;  // Mid-way through first Q
      clip2Ptr->startRecording();

      // Call process 100 times (simulating ~50ms of audio at 512 samples/call)
      int64_t firstOrigin = -1;
      for (int i = 0; i < 100; i++) {
        ctx.num_samples = 5;  // Small increments
        clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
        ctx.master_pos += 5;

        if (firstOrigin < 0) {
          firstOrigin = clip2Ptr->origin_samples.load();
        }
      }

      // The canonical timing fact must be set ONCE at arm and never
      // recomputed per block (the old bug compounded the projected x
      // across process() calls).
      expectEquals(clip2Ptr->origin_samples.load(), firstOrigin,
                   "origin must not change across process() calls");
      expectEquals(firstOrigin, (int64_t)1000,
                   "arm at 500 targets the 1Q boundary");
    }

    // Regression Test: Example 2 - Clip recorded between 1Q-2Q should anchor at
    // 2Q
    {
      beginTest("Example 2: Mid-Loop Recording Anchors at Next Q Boundary");
      const double SR = 44100.0;
      StackNode parent("Parent");

      // Dummy input data for recording
      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q (establishes Q=1000)
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      // Clip 2: Start at master_pos = 1100 (between 1Q and 2Q, >512 from 2Q)
      // Should snap to next Q boundary = 2Q = 2000
      auto* clip2Ptr = addClip(parent, "Clip2", SR);

      ctx.master_pos = 1100;
      ctx.num_samples = 100;
      clip2Ptr->startRecording();
      clip2Ptr->process(inputs, nullptr, 1, 0,
                        ctx);  // Trigger pending start logic

      // awaiting_start_at should be 2000 (next Q boundary)
      int64_t awaitingStart = clip2Ptr->getAwaitingStartAt();
      expectEquals(awaitingStart, (int64_t)2000,
                   "Recording should await start at 2Q boundary");

      // The lane position is a UI projection of origin (I2: the cycle
      // projection origin mod context = 2000 mod 1000 = 0 draws at the
      // cycle top). The engine's fact: origin = the awaited boundary.
      expectEquals(clip2Ptr->origin_samples.load(), (int64_t)2000,
                   "origin is the 2Q arm boundary (cycle projection 0)");
    }

    // Regression Test: Multi-clip context mid-loop recording
    // This catches the bug where slot was calculated as 3 instead of 2
    // when recording between 1Q-2Q in a multi-clip context
    {
      beginTest("Multi-Clip Mid-Loop Recording Uses Effective Position");
      const double SR = 44100.0;
      StackNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      // Clip 2: 4Q to establish multi-clip context
      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs, 4000, 0, ctx);
      ctx.num_samples = 1500;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);

      // Clip 3: Start recording between 1Q-2Q of the 4Q context
      // master_pos = 1500 (between 1Q and 2Q)
      // effective_pos should be ~1500, next_q = 2000
      // slot should be 2 (anchoring at 2Q), NOT 3
      auto* clip3Ptr = addClip(parent, "Clip3", SR);

      ctx.master_pos = 1500;  // Between 1Q and 2Q
      ctx.num_samples = 100;
      clip3Ptr->startRecording();

      // Call process multiple times to simulate real audio loop
      for (int i = 0; i < 10; i++) {
        clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
        ctx.master_pos += 50;
      }

      // Slot 2, not slot 3 (the old bug): the arm at 1500 targets the
      // 2Q boundary. The UI derives the slot from origin.
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)2000,
                   "arm at 1500 targets the 2Q boundary (slot 2, not 3)");
    }

    // LCM Ghost Extension Test: All clips at 0% at LCM boundary
    // Scenario: 1Q + 8Q + 4Q clips, LCM = 8Q
    // At timeline = LCM, ALL clips should have playhead = 0%
    beginTest("LCM: All Clips at 0% at LCM Boundary");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // Clip 1: 1Q (1000 samples)
      float input[1000] = {0.5f};
      float* const inputs[] = {input};

      ProcessContext ctx;
      auto* clip1Ptr =
          recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      // Clip 2: 8Q (8000 samples)
      float input8k[8000] = {0.3f};
      float* const inputs8k[] = {input8k};

      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs8k, 8000, 0, ctx);

      // Commit clip 2
      ctx.is_recording = true;
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Clip 3: 4Q (4000 samples)
      float input4k[4000] = {0.2f};
      float* const inputs4k[] = {input4k};

      auto* clip3Ptr =
          recordClipInto(parent, "Clip3", SR, inputs4k, 4000, 0, ctx);

      // Commit clip 3
      while (clip3Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Now test: at LCM = 8Q = 8000 samples, all clips should be at 0%
      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos = 0;  // Start of LCM cycle = all at 0%
      ctx.num_samples = 512;

      float out[512] = {0.0f};
      float* const outputs[] = {out, out};

      clip1Ptr->process(nullptr, outputs, 0, 2, ctx);
      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);
      clip3Ptr->process(nullptr, outputs, 0, 2, ctx);

      // At master_pos=0, all clips with launch_point=0 should have playhead~0%
      double ph1 = clip1Ptr->playhead_pos.load();
      double ph2 = clip2Ptr->playhead_pos.load();
      double ph3 = clip3Ptr->playhead_pos.load();

      expectWithinAbsoluteError(ph1, 0.0, 0.1,
                                "Clip 1 playhead should be ~0% at LCM start");
      expectWithinAbsoluteError(ph2, 0.0, 0.1,
                                "Clip 2 playhead should be ~0% at LCM start");
      expectWithinAbsoluteError(ph3, 0.0, 0.1,
                                "Clip 3 playhead should be ~0% at LCM start");

      juce::Logger::writeToLog(
          "LCM TEST: At master=0, ph1=" + juce::String(ph1) +
          ", ph2=" + juce::String(ph2) + ", ph3=" + juce::String(ph3));
    }

    // LCM: arm near the cycle top anchors AT the top.
    // Scenario: Context=4Q. User hits record at 3.9Q. The original bug
    // computed next_q = 0 (past) and anchored the take at the WRONG
    // position; the musical observable is the ANCHOR (origin = 4Q).
    // Capture is allowed to begin inside the <512 near-window — the
    // arrival-time capture window still points at exactly 4Q, so
    // content[0] is the audio of the boundary either way. (An
    // anticipatory-deferral mechanism that also kept isRecording false
    // here was deleted 2026-07-16 — it overshot anchors by a full Q.)
    beginTest("LCM: Clip 3 Wait Logic at Q Boundary");
    {
      const double SR = 1000.0;  // 1Q = 1000 samples
      StackNode parent("Parent");

      // Setup Context: Clip 1 (4Q) -> Context 4000
      float input[4000] = {0.0f};
      float* const inputs[] = {input, input};

      ProcessContext ctx;
      auto* clip1Ptr =
          recordClipInto(parent, "Clip1", SR, inputs, 4000, 0, ctx);
      // Commit
      ctx.master_pos = 4000;
      while (clip1Ptr->isAwaitingStop()) {
        clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Create Clip 3
      auto* clip3Ptr = addClip(parent, "Clip3", SR);

      // Attempt to record at 3900 (3.9Q)
      ctx.master_pos = 3900;
      ctx.num_samples = 100;  // Process up to 4000
      ctx.is_recording = false;

      clip3Ptr->startRecording();

      // Process one block.
      // With the original bug: next_q=0 (in the past) -> take anchored
      // at the wrong position. Fixed: the target is 4Q.
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      // THE invariant: the take is anchored at the 4Q boundary
      // (capture may already be counting inside the <512 near-window).
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)4000,
                   "Clip 3 anchors at 4Q, never at a past boundary");

      // Advance past 4000 (4Q): definitely capturing now.
      ctx.master_pos = 4000;
      ctx.num_samples = 100;
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
      expect(clip3Ptr->isRecording(),
             "Clip 3 should be recording past 4000 (4Q)");
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)4000,
                   "anchor unchanged through capture start");
    }

    // BUG FIX TEST: Clip 2 (4Q) should loop at its own duration, not at 1Q
    beginTest("Clip 2 (4Q) Should Loop At 4Q, Not 1Q");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // Clip 1: 1Q (establishes quantum)
      float input1[1000] = {0.5f};
      float* const inputs1[] = {input1};
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs1, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Clip 1 should establish Q = 1000");

      // Clip 2: 4Q (4000 samples)
      float input2[4000] = {0.3f};
      float* const inputs2[] = {input2};

      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs2, 4000, 0, ctx);

      // Process to commit
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        ctx.num_samples = 1000;
        clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      }

      // CRITICAL: loop_end_samples must equal duration, NOT effectiveQuantum
      int64_t loopEnd = clip2Ptr->getLoopEnd();
      int64_t duration = clip2Ptr->duration_samples.load();

      juce::Logger::writeToLog(
          "LOOP BUG TEST: duration=" + juce::String(duration) +
          ", loopEnd=" + juce::String(loopEnd) + ", Q=" + juce::String(Q));

      expectEquals(loopEnd, duration,
                   "loop_end_samples MUST equal duration, not Q!");
      expect(loopEnd != Q,
             "loop_end_samples should NOT equal Q (that was the bug!)");
    }

    // CRITICAL TEST: Verify actual audio output loops at correct position
    // This tests the actual playback behavior, not just the settings
    beginTest("Audio Playback Loops At Clip Duration, Not Q");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // Clip 1: 1Q (establishes quantum)
      float input1[1000];
      for (int i = 0; i < 1000; ++i) input1[i] = 0.1f;  // Uniform signal
      float* const inputs1[] = {input1};

      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs1, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Q should be 1000");

      // Clip 2: 4Q with DISTINCT samples at each Q boundary
      // Sample pattern: Q0=0.1, Q1=0.2, Q2=0.3, Q3=0.4
      // If looping at 1Q wrongly, master_pos=1500 would read 0.1 (pos 500)
      // If looping correctly at 4Q, master_pos=1500 reads 0.2 (pos 1500)
      float input2[4000];
      for (int i = 0; i < 1000; ++i) input2[i] = 0.1f;     // Q0
      for (int i = 1000; i < 2000; ++i) input2[i] = 0.2f;  // Q1
      for (int i = 2000; i < 3000; ++i) input2[i] = 0.3f;  // Q2
      for (int i = 3000; i < 4000; ++i) input2[i] = 0.4f;  // Q3
      float* const inputs2[] = {input2};

      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs2, 4000, 0, ctx);

      // Process to commit
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        ctx.num_samples = 1000;
        clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      }

      // Verify setup
      int64_t duration = clip2Ptr->duration_samples.load();
      int64_t loopEnd = clip2Ptr->getLoopEnd();
      expect(duration >= 4000, "Duration should be at least 4Q");
      expectEquals(loopEnd, duration, "loopEnd must equal duration");

      // === CRITICAL PLAYBACK TEST ===
      // Play at master_pos = 1500 (1.5Q)
      // If wrongly looping at 1Q: effective_pos = 1500 % 1000 = 500 → reads
      // ~0.1 If correctly looping at 4Q+: effective_pos = 1500 % 4000+ = 1500 →
      // reads ~0.2
      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos = 1500;
      ctx.num_samples = 1;

      float out[2] = {0.0f, 0.0f};
      float* const outputs[] = {out, out + 1};

      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      juce::Logger::writeToLog(
          "AUDIO LOOP TEST: master=1500, output=" + juce::String(out[0]) +
          " (expected ~0.2, wrong if ~0.1)");

      // Should be reading from Q1 region (0.2), not Q0 region (0.1)
      expectWithinAbsoluteError(
          out[0], 0.2f, 0.05f,
          "At master=1.5Q, should read Q1 audio (0.2), not Q0 (0.1)!");

      // Double-check: at master=500 (0.5Q), should read Q0 audio (0.1)
      ctx.master_pos = 500;
      out[0] = 0.0f;
      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      expectWithinAbsoluteError(out[0], 0.1f, 0.05f,
                                "At master=0.5Q, should read Q0 audio (0.1)");

      // Triple-check: at master=2500 (2.5Q), should read Q2 audio (0.3)
      ctx.master_pos = 2500;
      out[0] = 0.0f;
      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      expectWithinAbsoluteError(out[0], 0.3f, 0.05f,
                                "At master=2.5Q, should read Q2 audio (0.3)");
    }

    // USER BUG REPORT: Record 1Q clip, then 2Q clip - 2Q clip loops at 1Q
    // This is the EXACT scenario reported by the user
    beginTest("User Bug: 2Q Clip Should Play Second Half, Not Loop At 1Q");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // Clip 1: 1Q (establishes quantum)
      float input1[1000];
      for (int i = 0; i < 1000; ++i) input1[i] = 0.1f;
      float* const inputs1[] = {input1};

      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs1, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Q should be 1000");

      // Clip 2: EXACTLY 2Q (2000 samples) - user's scenario
      // First half = 0.1, Second half = 0.5
      float input2[2000];
      for (int i = 0; i < 1000; ++i) input2[i] = 0.1f;     // First half
      for (int i = 1000; i < 2000; ++i) input2[i] = 0.5f;  // Second half
      float* const inputs2[] = {input2};

      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs2, 2000, 0, ctx);

      // Process to commit - should snap to 2Q
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        ctx.num_samples = 1000;
        clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      }

      // Debug: Check duration and loopEnd
      int64_t duration = clip2Ptr->duration_samples.load();
      int64_t loopEnd = clip2Ptr->getLoopEnd();

      juce::Logger::writeToLog(
          "USER BUG TEST: duration=" + juce::String(duration) +
          ", loopEnd=" + juce::String(loopEnd) + ", Q=" + juce::String(Q));

      // Duration MUST be 2Q (2000), not 1Q (1000)
      expect(duration >= 2000, "Duration should be at least 2Q (2000)");
      expectEquals(loopEnd, duration, "loopEnd must equal duration");

      // === THE CRITICAL TEST ===
      // Play at master=1500 (1.5Q)
      // If looping at 1Q: effective_pos = 1500 % 1000 = 500 → reads ~0.1 (FIRST
      // half) If looping at 2Q: effective_pos = 1500 % 2000 = 1500 → reads ~0.5
      // (SECOND half)
      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos = 1500;
      ctx.num_samples = 1;

      float out[2] = {0.0f, 0.0f};
      float* const outputs[] = {out, out + 1};

      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      juce::Logger::writeToLog(
          "USER BUG TEST: master=1500, output=" + juce::String(out[0]) +
          " (expected 0.5 second half, bug if 0.1 first half)");

      // This is THE bug test - should be 0.5 (second half), not 0.1 (first
      // half)
      expectWithinAbsoluteError(
          out[0], 0.5f, 0.05f,
          "At master=1.5Q, MUST read SECOND half (0.5), not first half (0.1)!");
    }

    // Test: Recording starts MID-LOOP and should still loop at correct duration
    beginTest("Mid-Loop Start: 2Q Recording Should Loop At 2Q, Not 1Q");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      // Clip 1: 1Q (establishes quantum)
      float input1[1000];
      for (int i = 0; i < 1000; ++i) input1[i] = 0.1f;
      float* const inputs1[] = {input1};

      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs1, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Q should be 1000");

      // Clip 2: Start recording at master_pos=500 (mid-loop)
      // First half = 0.1, Second half = 0.5
      auto* clip2Ptr = addClip(parent, "Clip2", SR);

      float input2[2000];
      for (int i = 0; i < 1000; ++i) input2[i] = 0.1f;     // First half
      for (int i = 1000; i < 2000; ++i) input2[i] = 0.5f;  // Second half
      float* const inputs2[] = {input2};

      // Start recording at mid-loop
      ctx.master_pos = 500;  // Mid-loop (0.5Q)
      clip2Ptr->startRecording();

      // Process to start recording at Q boundary (waits until 1Q)
      ctx.num_samples = 500;
      clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      ctx.master_pos = 1000;
      ctx.num_samples = 2000;
      clip2Ptr->process(inputs2, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();

      // Process to commit
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        ctx.num_samples = 1000;
        clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      }

      int64_t duration = clip2Ptr->duration_samples.load();
      int64_t loopEnd = clip2Ptr->getLoopEnd();

      juce::Logger::writeToLog(
          "MID-LOOP TEST: duration=" + juce::String(duration) +
          ", loopEnd=" + juce::String(loopEnd) + ", Q=" + juce::String(Q));

      expect(duration >= 2000, "Duration should be at least 2Q");
      expectEquals(loopEnd, duration, "loopEnd must equal duration");
      expect(loopEnd != Q, "loopEnd should NOT equal Q (1Q)!");

      // Key test: Play at 1.5Q - should read SECOND half (0.5), not first (0.1)
      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos =
          1500 + 1000;  // Offset by launch point (1Q since started at 1Q)
      ctx.num_samples = 1;

      float out[2] = {0.0f, 0.0f};
      float* const outputs[] = {out, out + 1};

      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      juce::Logger::writeToLog("MID-LOOP TEST: master=2500, output=" +
                               juce::String(out[0]));

      // At effective position 1500 (1.5Q within clip), should read 0.5
      // NOT 0.1 (if wrongly looping at 1Q)
    }

    // BUG REPRO TEST: User's exact scenario
    // Clip 1: 1Q. User clicks record mid-loop (0.5Q), snaps to start at 1Q
    // (next 0Q boundary). Records for ~4Q, stops between 3Q-4Q, snaps to 4Q.
    // Expected: playhead=0% after commit.
    // Bug: playhead=25% (1Q position)
    beginTest("BUG REPRO: Mid-Loop Record Start, 4Q Clip, Playhead at Commit");
    {
      const double SR = 1000.0;  // 1Q = 1000 samples
      StackNode parent("Parent");

      // === Clip 1: 1Q (1000 samples) ===
      float input1[1000] = {0.5f};
      float* const inputs1[] = {input1};

      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs1, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Clip 1 should establish Q=1000");

      // === Clip 2: User clicks record at 500 (0.5Q) ===
      // Recording should snap to start at 1000 (1Q = next 0Q boundary)
      auto* clip2Ptr = addClip(parent, "Clip2", SR);

      // Simulate user clicking record at master_pos = 500 (mid-loop)
      ctx.master_pos = 500;
      ctx.num_samples = 100;
      clip2Ptr->startRecording();
      clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);

      juce::Logger::writeToLog(
          "BUG REPRO: awaiting_start_at=" +
          juce::String(clip2Ptr->getAwaitingStartAt()) +
          ", is_pending=" + juce::String(clip2Ptr->isPendingStart() ? 1 : 0));

      // Advance to 1Q boundary where recording should actually start
      ctx.master_pos = 1000;
      ctx.num_samples = 100;
      clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);

      juce::Logger::writeToLog(
          "BUG REPRO: After crossing 1Q, is_recording=" +
          juce::String(clip2Ptr->isRecording() ? 1 : 0) +
          ", origin_samples=" + juce::String(clip2Ptr->origin_samples.load()));

      // Record for 4Q total (from 1Q to 5Q = 4000 samples with snap)
      // User stops between 3Q-4Q, snaps to 4Q
      float input4k[4000] = {0.3f};
      float* const inputs4k[] = {input4k};
      ctx.master_pos = 1100;  // Just past 1Q
      ctx.num_samples =
          3500;  // Record to 4600, which snaps to 5000 (4Q from start)
      clip2Ptr->process(inputs4k, nullptr, 1, 0, ctx);

      clip2Ptr->stopRecording();

      // Process until commit
      ctx.num_samples = 1000;
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        clip2Ptr->process(inputs1, nullptr, 1, 0, ctx);
      }

      // Debug values
      int64_t duration = clip2Ptr->duration_samples.load();
      int64_t startPhase = clip2Ptr->origin_samples.load();
      int64_t commitPos = clip2Ptr->getCommitMasterPos();

      juce::Logger::writeToLog(
          "BUG REPRO COMMIT: duration=" + juce::String(duration) + ", origin=" +
          juce::String(startPhase) + ", commitPos=" + juce::String(commitPos));

      // The origin is stored ABSOLUTE: the clip started at boundary
      // T=1000, so content[0] plays at t ≡ 1000 — seamless with the
      // recording. (A mod-context origin here is what caused the field
      // bug "4Q clip loops at 3Q"; launch is now derived from origin at
      // read time, so there is no stored value left to disagree.)
      expectEquals(startPhase, (int64_t)1000, "origin = absolute trigger");
      juce::ignoreUnused(duration);
    }

    // BUG: Clip 3 recorded at 2Q should anchor at 2Q, not 0Q
    // Scenario: Clip 1 = 1Q, Clip 2 = 4Q, Clip 3 starts at 2Q for 1Q
    // Expected: Clip 3 x_pos = 400 (slot 2), ghosts should wrap at 0Q→2Q
    beginTest("Clip 3 Recording At 2Q Should Anchor At 2Q");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      StackNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // === Clip 1: 1Q (establishes quantum) ===
      ProcessContext ctx;
      recordClipInto(parent, "Clip1", SR, inputs, 1000, 0, ctx);

      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Clip 1 should establish Q = 1000");

      // === Clip 2: 4Q (establishes 4Q context loop) ===
      auto* clip2Ptr =
          recordClipInto(parent, "Clip2", SR, inputs, 4000, 0, ctx);

      // Process to commit clip 2
      ctx.num_samples = 1000;
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Clip 2 duration should be snapped to next Q after recording
      // Recording 4Q worth snaps to 5Q with anticipatory snap
      expect(clip2Ptr->duration_samples.load() >= 4000,
             "Clip 2 should be at least 4Q duration");

      // === Clip 3: Start recording at 2Q, record for 1Q ===
      // This is the bug case: should anchor at x=400 (2Q slot), not x=0
      auto* clip3Ptr = addClip(parent, "Clip3", SR);

      // Start recording at master_pos = 2000 (exactly 2Q)
      ctx.master_pos = 2000;
      ctx.num_samples = 100;
      clip3Ptr->startRecording();
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      // The anchor fact lives ONLY in origin now; the 2Q slot the old
      // x=400 assertion pinned is the UI's projection of it.
      juce::Logger::writeToLog(
          "ANCHOR BUG TEST: Recording started at 2Q, origin_samples=" +
          juce::String(clip3Ptr->origin_samples.load()));

      // origin_samples should be 2Q (2000 samples), NOT 0
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)2000,
                   "origin_samples should be 2000 (2Q)");

      // Continue recording for 1Q worth
      ctx.master_pos = 2100;
      ctx.num_samples = 1000;
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip3Ptr->stopRecording();

      // Process to commit clip 3
      ctx.num_samples = 100;
      while (clip3Ptr->isAwaitingStop()) {
        ctx.master_pos += 100;
        clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      int64_t duration3 = clip3Ptr->duration_samples.load();

      juce::Logger::writeToLog(
          "ANCHOR BUG TEST COMMIT: duration=" + juce::String(duration3) +
          ", origin=" + juce::String(clip3Ptr->origin_samples.load()));

      // Commit must not move the anchor: origin unchanged.
      expectEquals(clip3Ptr->origin_samples.load(), (int64_t)2000,
                   "Clip 3 origin should remain 2000 after commit");

      // Verify duration - Clip starts at 2Q, records ~1Q, snaps to next Q (4Q)
      // So duration = 4Q - 2Q = 2Q (2000 samples)
      expectEquals(duration3, (int64_t)2000,
                   "Clip 3 duration should be 2Q (2000) due to Q-snapping");

      // NOTE: Ghost wrapping verification:
      // With clip at x=400 (2Q) and duration 1Q in a 4Q context,
      // ghosts should fill 0Q→2Q (left wrap) to complete the LCM cycle.
      // This is verified in the UI layer tests (Playwright).
    }

    // FIELD REPRO 2026-07-16: "record clip 3 starting right before 2Q,
    // record 2Q, stop before the end — expected anchored 2Q→4Q, actual
    // jumps to 0Q–2Q." Full engine flow, zero device latency (the
    // uncalibrated case). Two engine facts must hold: the origin lands
    // on the HEARD 2Q boundary (the anticipatory-window deferral used
    // to overshoot to 3Q when latency ≈ 0), and clip 3's commit must
    // not re-base the island epoch (the cycle did not grow). The
    // display half of the bug (take tile folded to 0 by the clip's own
    // period) is pinned in ui/js/tests/view_model.test.mjs.
    beginTest("FIELD: mid-cycle 2Q take anchors at its heard 2Q boundary");
    {
      AudioEngine engine;
      const int64_t Q = 44100;
      const int BLOCK = 512;
      std::vector<float> buf((size_t)BLOCK, 0.1f);
      float* ins[] = {buf.data()};
      float* outs[] = {buf.data(), buf.data()};
      auto process = [&](int64_t total) {
        while (total > 0) {
          int n = (int)std::min<int64_t>(total, BLOCK);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          total -= n;
        }
      };
      auto nthClipId = [&](int n) -> juce::String {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (*nodes)[n].getDynamicObject()->getProperty("id");
      };
      auto clipProp = [&](int n, const char* prop) -> int64_t {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (int64_t)(double)(*nodes)[n].getDynamicObject()->getProperty(
            prop);
      };

      // 1) Clip 1 establishes Q (recorded from t = 0, exactly 1Q).
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(0));
      process(Q);
      engine.stopRecordingInNode(nthClipId(0));  // immediate commit
      expectEquals(clipProp(0, "duration"), Q, "clip 1 establishes Q");

      // 2) Clip 2: 4Q, armed exactly on the 1Q boundary (t = Q). Stop
      // slightly early so the stop boundary is 4Q, not 5Q.
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(1));
      process(4 * Q - 200);
      engine.stopRecordingInNode(nthClipId(1));
      process(400);  // audio thread picks boundary 4Q and commits there
      expectEquals(clipProp(1, "duration"), 4 * Q, "clip 2 is 4Q");

      // Simple extension: the epoch re-based to clip 2's origin (1Q).
      const int64_t epoch = (int64_t)(double)engine.getGraphState()
                                .getDynamicObject()
                                ->getProperty("islandEpoch");
      expectEquals(epoch, Q, "epoch re-based to clip 2's origin");

      // 3) Clip 3: arm just before the HEARD 2Q of the 4Q cycle.
      // t is now 5Q + 200; heard rel = (t − epoch) mod 4Q = 200.
      process(2 * Q - 300);  // heard rel = 2Q − 100: inside the old
                             // anticipatory window, 100 before 2Q
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(2));
      process(2 * Q);  // capture ~2Q (arm resolves in the first block)
      engine.stopRecordingInNode(nthClipId(2));
      process(2 * Q);  // finish to the boundary and commit

      const int64_t origin3 = clipProp(2, "origin");
      const int64_t duration3 = clipProp(2, "duration");
      expectEquals(duration3, 2 * Q, "clip 3 committed at 2Q");

      // THE anchor fact: the take belongs at the heard 2Q boundary.
      expectEquals(((origin3 - epoch) % (4 * Q) + 4 * Q) % (4 * Q), 2 * Q,
                   "clip 3 anchors at heard 2Q (deferral used to give 3Q)");

      // And its commit must not move the frame (cycle didn't grow).
      expectEquals((int64_t)(double)engine.getGraphState()
                       .getDynamicObject()
                       ->getProperty("islandEpoch"),
                   epoch, "clip 3's commit must not re-base the epoch");

      // Clip 3's heard frame was the 4Q cycle — published for display
      // take-marking (Q14).
      expectEquals(clipProp(2, "contextCycle"), 4 * Q,
                   "clip 3's heard frame is the 4Q cycle");

      // 4) FIELD REPRO part 2 (2026-07-16b): clip 4, 5Q, armed at a
      // HEARD cycle top some cycles later. The cycle explodes to
      // LCM(4Q, 5Q) = 20Q. The user watched the take grow from the top
      // of the frame; at commit the epoch must move to the heard top
      // the take was performed against (origin floored to whole old
      // cycles) so the watched frame persists — the old
      // "polyrhythmic expansions keep the epoch" rule teleported the
      // take to 12Q–17Q of the exploded frame.
      // t is 11Q − 100 (heard rel 10Q − 100). Advance so heard rel is
      // 12Q − 500: 500 before the heard cycle top at rel 12Q — inside
      // the <512 near window, so the arm resolves immediately, anchored
      // ON the top.
      process(2 * Q - 400);
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(3));
      process(5 * Q);  // arm resolves at the top; capture ~5Q
      engine.stopRecordingInNode(nthClipId(3));
      process(2 * Q);  // finish to the 5Q boundary and commit

      expectEquals(clipProp(3, "duration"), 5 * Q, "clip 4 committed at 5Q");
      expectEquals(clipProp(3, "contextCycle"), 4 * Q,
                   "clip 4's heard frame was still the 4Q cycle");

      const int64_t origin4 = clipProp(3, "origin");
      expectEquals(((origin4 - epoch) % (4 * Q) + 4 * Q) % (4 * Q), (int64_t)0,
                   "clip 4 armed at a heard cycle top");

      // THE fix: the epoch moved to clip 4's heard top (a whole number
      // of old 4Q cycles past the previous epoch) — phase-neutral for
      // clips 1–3, and clip 4 reads from the top of the new 20Q frame.
      const int64_t epoch2 = (int64_t)(double)engine.getGraphState()
                                 .getDynamicObject()
                                 ->getProperty("islandEpoch");
      expectEquals(epoch2, origin4,
                   "epoch re-based to the heard top the take started at");
      expectEquals(((epoch2 - epoch) % (4 * Q) + 4 * Q) % (4 * Q), (int64_t)0,
                   "re-base moved by WHOLE old cycles (phase-neutral)");

      // Clip 3's heard phase survives the re-base via its contextCycle:
      // (origin3 − epoch2) mod 4Q is still 2Q.
      expectEquals(
          ((clipProp(2, "origin") - epoch2) % (4 * Q) + 4 * Q) % (4 * Q), 2 * Q,
          "clip 3's heard 2Q anchor survives the re-base");
    }

    // FIELD REPRO 2026-07-16e (Q15): recording while a WINDOW shortens
    // the audible cycle. 1Q clip + 4Q clip windowed to [2Q,3Q): the
    // heard cycle collapses to 1Q (E-C) and the cursor loops 1Q. Arming
    // then hits "the next Q boundary" — whose intrinsic-frame slot
    // (0/1/2/3Q) is neither hearable nor visible: the take anchored at
    // a die-roll slot ("started recording at 1Q instead of 0Q"). The
    // heard-frame ORIGIN FOLD stores the audibly-identical
    // representative in the FIRST heard window: the take anchors where
    // the cursor sweeps. Capture still starts at the real boundary;
    // nothing else moves.
    beginTest("FIELD: take under a shortened heard cycle anchors at the top");
    {
      AudioEngine engine;
      const int64_t Q = 44100;
      const int BLOCK = 512;
      std::vector<float> buf((size_t)BLOCK, 0.1f);
      float* ins[] = {buf.data()};
      float* outs[] = {buf.data(), buf.data()};
      auto process = [&](int64_t total) {
        while (total > 0) {
          int n = (int)std::min<int64_t>(total, BLOCK);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          total -= n;
        }
      };
      auto nthClipId = [&](int n) -> juce::String {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (*nodes)[n].getDynamicObject()->getProperty("id");
      };
      auto clipProp = [&](int n, const char* prop) -> int64_t {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (int64_t)(double)(*nodes)[n].getDynamicObject()->getProperty(
            prop);
      };

      // Clip 1 (1Q) and clip 2 (4Q, epoch re-bases to its origin at Q).
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(0));
      process(Q);
      engine.stopRecordingInNode(nthClipId(0));
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(1));
      process(4 * Q - 200);
      engine.stopRecordingInNode(nthClipId(1));
      process(400);
      const int64_t epoch = (int64_t)(double)engine.getGraphState()
                                .getDynamicObject()
                                ->getProperty("islandEpoch");
      expectEquals(epoch, Q, "epoch at clip 2's origin");

      // Window clip 2 to [2Q,3Q): the heard cycle is now 1Q.
      engine.setLoopPoints(nthClipId(1), 2 * Q, 3 * Q);

      // Arm mid-Q: the next boundary is rel 5Q ≡ 1Q (mod 4Q) — the
      // die-roll slot the user could neither hear nor see.
      process(300);  // t = 5Q + 500, rel = 4Q + 500
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(2));
      process(4 * Q + 100);  // capture starts at the 5Q-rel boundary
      engine.stopRecordingInNode(nthClipId(2));
      process(Q);  // finish to the 4Q boundary and commit

      expectEquals(clipProp(2, "duration"), 4 * Q, "take committed at 4Q");
      expectEquals(clipProp(2, "contextCycle"), Q,
                   "the take's heard frame is the SHORTENED 1Q cycle");

      // THE FOLD: origin stored ≡ 0 (mod 4Q) — the audibly-identical
      // representative at the frame top (unfolded it was ≡ 1Q).
      const int64_t origin3 = clipProp(2, "origin");
      expectEquals(((origin3 - epoch) % (4 * Q) + 4 * Q) % (4 * Q), (int64_t)0,
                   "take anchors at the heard/frame top, not a die-roll slot");

      // Nothing else moved: the window edit above REMOVED the sounding
      // region (cursor at rel ~200, window [2Q,3Q)), so under
      // two-anchor continuity (owner ruling 2026-08-09) BOTH anchors
      // stay put — origin fixed (2026-07-25i) and the epoch with it.
      // Grid phase preserved — the anchoring law's invariant (I4).
      expectEquals((int64_t)(double)engine.getGraphState()
                       .getDynamicObject()
                       ->getProperty("islandEpoch"),
                   epoch, "no epoch move (cycle did not grow)");
      expectEquals(((clipProp(1, "origin") - epoch) % Q + Q) % Q, (int64_t)0,
                   "clip 2's anchor keeps its grid phase");
    }

    beginTest("CYCLE-TOP RULE: the cycle-defining loop's top IS the frame top");
    {
      // Owner question 2026-08-18: "if my first track is 1Q, why the
      // mid-lane split?" — a 10Q take from 1Q windowed to [6Q, 10Q)
      // loops 4Q; the 1Q definer is indifferent to where the 4Q cycle
      // tops, so the loop you just shaped fills the frame from its own
      // top: epoch := origin + 6Q. Whole-Q (grid untouched), audio
      // untouched (origins are absolute), and a NON-definer edit
      // (someone else owns the cycle) leaves the epoch alone.
      AudioEngine engine;
      const int64_t Q = 44100;
      const int BLOCK = 512;
      std::vector<float> buf((size_t)BLOCK, 0.1f);
      float* ins[] = {buf.data()};
      float* outs[] = {buf.data(), buf.data()};
      auto process = [&](int64_t total) {
        while (total > 0) {
          int n = (int)std::min<int64_t>(total, BLOCK);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          total -= n;
        }
      };
      auto nthClipId = [&](int n) -> juce::String {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (*nodes)[n].getDynamicObject()->getProperty("id");
      };
      auto clipProp = [&](int n, const char* prop) -> int64_t {
        auto state = engine.getGraphState();
        auto* nodes = state.getDynamicObject()->getProperty("nodes").getArray();
        return (int64_t)(double)(*nodes)[n].getDynamicObject()->getProperty(
            prop);
      };
      auto epochNow = [&]() {
        return (int64_t)(double)engine.getGraphState()
            .getDynamicObject()
            ->getProperty("islandEpoch");
      };

      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(0));
      process(Q);
      engine.stopRecordingInNode(nthClipId(0));
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(1));
      process(10 * Q - 200);
      engine.stopRecordingInNode(nthClipId(1));
      process(400);
      expectEquals(clipProp(1, "duration"), 10 * Q, "a 10Q take");
      const int64_t origin2 = clipProp(1, "origin");
      expectEquals(epochNow(), origin2, "epoch at clip 2's origin (1Q)");
      // Stopped, like the field: no continuity re-anchor is in play.
      engine.togglePlayback();

      // Left handle to 6Q: [6Q, 10Q) — a 4Q loop, the cycle (Q is 1Q).
      engine.setLoopPoints(nthClipId(1), 6 * Q, 10 * Q);
      expectEquals(clipProp(1, "origin"), origin2, "audio: origin untouched");
      expectEquals(epochNow(), origin2 + 6 * Q,
                   "epoch := the loop's heard top (origin + 6Q)");
      expectEquals(((epochNow() - origin2) % Q + Q) % Q, (int64_t)0,
                   "whole-Q move: the grid is untouched");
      // The clip's frame position: its window top at phase 0 of the 4Q
      // cycle — the loop fills the frame from its top, no mid-lane pair.
      expectEquals((clipProp(1, "origin") + 6 * Q - epochNow()) % (4 * Q),
                   (int64_t)0, "loop top at the frame top");

      // Right handle to 9Q: [6Q, 9Q) — still the definer, top unchanged
      // → epoch stays (no churn).
      engine.setLoopPoints(nthClipId(1), 6 * Q, 9 * Q);
      expectEquals(epochNow(), origin2 + 6 * Q, "same top, epoch stays");

      // Undo both: the riders restore the epoch atomically.
      engine.undo();
      engine.undo();
      expectEquals(epochNow(), origin2, "undo restores the epoch");
      expectEquals(clipProp(1, "loopEnd") - clipProp(1, "loopStart"), 10 * Q,
                   "undo restores the full span");

      // A NON-definer: clip 3 (8Q) now owns the cycle (lcm(1, 10, 8) →
      // its commit re-bases the epoch to ITS origin); trimming clip 2
      // to [6Q, 8Q) (2Q ∤ 8Q's cycle... 8 % 2 == 0 but 2 % 8 != 0) is
      // a sub-loop under clip 3's cycle → the epoch stays where clip 3
      // put it.
      engine.togglePlayback();
      engine.createNode("clip");
      engine.startRecordingInNode(nthClipId(2));
      process(8 * Q + 100);
      engine.stopRecordingInNode(nthClipId(2));
      process(2 * Q);
      expectEquals(clipProp(2, "duration"), 8 * Q, "an 8Q take");
      engine.togglePlayback();
      const int64_t epochBefore = epochNow();
      engine.setLoopPoints(nthClipId(1), 6 * Q, 8 * Q);
      expectEquals(epochNow(), epochBefore,
                   "non-definer trim: the frame belongs to the definer");
    }
  }
};

static AudioEngineWorkflowTests audioEngineWorkflowTests;

}  // namespace celestrian
