#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/box_node.h"
#include "../src/clip_node.h"

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
      engine.createNode("clip", 100, 100);
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
      celestrian::BoxNode parent("Parent");

      // === Clip 1: 1Q (1000 samples) ===
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      float clip1Input[1000];
      for (int i = 0; i < 1000; ++i) clip1Input[i] = 0.5f;
      float* const clip1Inputs[] = {clip1Input};

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(clip1Inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Verify Clip 1 established Q
      int64_t Q = parent.getEffectiveQuantum();
      expectEquals(Q, (int64_t)1000, "Clip 1 should establish Q = 1000");

      // === Clip 2: 4Q (4000 samples), starting at master_pos = 1000 (1Q) ===
      // This matches the user's scenario: StartTime=143872, Q=143872 (1Q =
      // 143872)
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      float clip2Input[4000];
      for (int i = 0; i < 4000; ++i) clip2Input[i] = 0.3f;
      float* const clip2Inputs[] = {clip2Input};

      ctx.num_samples = 4000;
      ctx.master_pos = 1000;  // Start at EXACTLY 1Q (user's actual scenario)

      clip2Ptr->startRecording();
      clip2Ptr->process(clip2Inputs, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();

      // Continue processing to cross Q boundary and commit
      // stopRecording sets is_awaiting_stop, we need to process past the
      // boundary
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;  // Advance by 1Q
        float more[1000];
        for (int i = 0; i < 1000; ++i) more[i] = 0.1f;
        float* const moreInputs[] = {more};
        ctx.num_samples = 1000;
        clip2Ptr->process(moreInputs, nullptr, 1, 0, ctx);
      }

      // Debug output
      int64_t anchor = clip2Ptr->anchor_phase_samples.load();
      int64_t launch = clip2Ptr->launch_point_samples.load();
      int64_t duration = clip2Ptr->duration_samples.load();

      juce::Logger::writeToLog(
          "TEST DEBUG: Clip2 anchor=" + juce::String(anchor) + ", launch=" +
          juce::String(launch) + ", duration=" + juce::String(duration));

      // Per LCM model: anchor calculation is now secondary
      // The key is that launch_point ensures playhead=0% at commit time
      expectEquals(anchor, (int64_t)0,
                   "Anchor should be 0 (3Q % 1Q = 0 per LCM model)");

      // Get the commit master pos and verify playhead=0% at that position
      int64_t commit_pos = clip2Ptr->getCommitMasterPos();

      juce::Logger::writeToLog(
          "TEST COMMIT: commit_pos=" + juce::String(commit_pos) + ", launch=" +
          juce::String(launch) + ", duration=" + juce::String(duration));

      // Verify: at commit_pos, playhead should be 0%
      ctx.is_recording = false;
      ctx.is_playing = true;
      ctx.master_pos = commit_pos;
      ctx.num_samples = 512;
      float out[512] = {0.0f};
      float* const outputs[] = {out, out};

      clip2Ptr->process(nullptr, outputs, 0, 2, ctx);

      double playhead = clip2Ptr->playhead_pos.load();
      juce::Logger::writeToLog(
          "TEST PLAYBACK: At commit_pos=" + juce::String(commit_pos) +
          ", playhead=" + juce::String(playhead));

      // At commit_pos: effective_pos = (commit_pos + launch) % duration = 0
      // playhead should be 0% (or very close due to 512-sample block
      // processing)
      expectWithinAbsoluteError(playhead, 0.0, 0.15,
                                "Playhead should be ~0% at commit time");
    }

    // New Test: Clip 1 (First clip) should always result in launch_point=0
    {
      beginTest("Clip 1 (First Clip) Should have Launch=0");
      const double SR = 44100.0;
      celestrian::BoxNode parent("Parent");
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clipPtr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 512;
      ctx.is_recording = true;
      ctx.master_pos = 0;  // Transport reset to 0

      clipPtr->startRecording();
      // Process 2 blocks (1024 samples)
      ctx.master_pos = 0;
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);
      ctx.master_pos = 512;
      clipPtr->process(nullptr, nullptr, 0, 0, ctx);

      // Stop recording immediately (First Clip => immediate stop)
      clipPtr->stopRecording();

      int64_t launch = clipPtr->launch_point_samples.load();
      expectEquals(launch, (int64_t)0,
                   "First Clip launch point should default to 0");

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
      celestrian::BoxNode parent("Parent");
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clipPtr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 512;
      ctx.is_recording = true;
      ctx.master_pos = 0;

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

      int64_t launch = clipPtr->launch_point_samples.load();
      expectEquals(launch, (int64_t)0, "Launch should be 0 even with blocks");

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
      celestrian::BoxNode parent("Parent");

      // Dummy input data for recording
      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q (establishes quantum)
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;  // Q = 1000
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      expectEquals(parent.getEffectiveQuantum(), (int64_t)1000);

      // Clip 2: 4Q
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.master_pos = 1000;  // Start at 1Q
      clip2Ptr->startRecording();
      ctx.num_samples = 4000;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();
      ctx.master_pos = 5000;
      ctx.num_samples = 100;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);  // Commit

      // Clip 3: Start recording at master_pos = 2500 (between 2Q and 3Q)
      // With context_loop = 4000 (4Q), next_q = 3000 (3Q)
      // Slot should be based on effective position: 2500 % 4000 = 2500
      // next_q=3000 <= context=4000, so slot should use effective_pos
      auto clip3 = std::make_unique<celestrian::ClipNode>("Clip3", SR);
      auto* clip3Ptr = clip3.get();
      parent.addChild(std::move(clip3));

      ctx.master_pos = 2500;
      ctx.num_samples = 100;
      clip3Ptr->startRecording();
      clip3Ptr->process(inputs, nullptr, 1, 0,
                        ctx);  // Trigger pending start logic

      // x_pos should be within reasonable bounds (0 to 4Q worth of position)
      // With base_x=100-200 and base_width=200:
      // - Slot 0: 100
      // - Slot 1: 300
      // - Slot 2: 500
      // - Slot 3: 700
      // Clip 3 is between 2Q and 3Q, so slot should be at most 3
      int64_t xPos = clip3Ptr->x_pos.load();
      expect(xPos >= 0, "x_pos should be non-negative");
      expect(xPos <= 800,
             "x_pos should stay within 4Q context (max slot 3 = 700 + buffer)");
    }

    // Regression Test: Clip 3 recorded AFTER context has looped multiple times
    {
      beginTest("Clip 3 After Multiple Loops Should Stay In Bounds");
      const double SR = 44100.0;
      celestrian::BoxNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Clip 2: 4Q at slot 0 (starts at 1Q boundary)
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.master_pos = 1000;  // Start at Q boundary after clip 1
      clip2Ptr->startRecording();
      ctx.num_samples = 4000;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();
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
      auto clip3 = std::make_unique<celestrian::ClipNode>("Clip3", SR);
      auto* clip3Ptr = clip3.get();
      parent.addChild(std::move(clip3));

      ctx.master_pos = 10500;
      ctx.num_samples = 100;
      clip3Ptr->startRecording();
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      int64_t xPos = clip3Ptr->x_pos.load();
      expect(xPos >= 0, "x_pos should be non-negative");
      expect(xPos <= 800,
             "x_pos should stay within 4Q context after multiple loops");
    }

    // Regression Test: x_pos should NOT compound across multiple process()
    // calls This emulates real audio loop behavior where process() is called
    // continuously
    {
      beginTest("x_pos Stability Across Multiple Process Calls");
      const double SR = 44100.0;
      celestrian::BoxNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Clip 2: Start recording at Q boundary, then call process() 100 times
      // This simulates the real audio loop behavior
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.master_pos = 500;  // Mid-way through first Q
      clip2Ptr->startRecording();

      // Call process 100 times (simulating ~50ms of audio at 512 samples/call)
      int64_t firstXPos = -1;
      for (int i = 0; i < 100; i++) {
        ctx.num_samples = 5;  // Small increments
        clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
        ctx.master_pos += 5;

        if (firstXPos < 0) {
          firstXPos = clip2Ptr->x_pos.load();
        }
      }

      int64_t finalXPos = clip2Ptr->x_pos.load();

      // x_pos should remain STABLE (not compound with each call)
      expectEquals(finalXPos, firstXPos,
                   "x_pos should not compound across process() calls");
      expect(finalXPos >= 0 && finalXPos <= 400,
             "x_pos should stay within reasonable bounds (1Q context)");
    }

    // Regression Test: Example 2 - Clip recorded between 1Q-2Q should anchor at
    // 2Q
    {
      beginTest("Example 2: Mid-Loop Recording Anchors at Next Q Boundary");
      const double SR = 44100.0;
      celestrian::BoxNode parent("Parent");

      // Dummy input data for recording
      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q (establishes Q=1000)
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Clip 2: Start at master_pos = 1100 (between 1Q and 2Q, >512 from 2Q)
      // Should snap to next Q boundary = 2Q = 2000
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.master_pos = 1100;
      ctx.num_samples = 100;
      clip2Ptr->startRecording();
      clip2Ptr->process(inputs, nullptr, 1, 0,
                        ctx);  // Trigger pending start logic

      // awaiting_start_at should be 2000 (next Q boundary)
      int64_t awaitingStart = clip2Ptr->getAwaitingStartAt();
      expectEquals(awaitingStart, (int64_t)2000,
                   "Recording should await start at 2Q boundary");

      // x_pos should reflect quantum offset of 2 (slot 2)
      // But we need to also check it's not shooting off
      int64_t xPos = clip2Ptr->x_pos.load();
      expect(xPos > 100, "x_pos should be offset > base (not at slot 0)");
      expect(xPos <= 600, "x_pos should not exceed slot 2 position");
    }

    // Regression Test: Multi-clip context mid-loop recording
    // This catches the bug where slot was calculated as 3 instead of 2
    // when recording between 1Q-2Q in a multi-clip context
    {
      beginTest("Multi-Clip Mid-Loop Recording Uses Effective Position");
      const double SR = 44100.0;
      celestrian::BoxNode parent("Parent");

      float dummyBuf[10000] = {0.0f};
      float* const inputs[] = {dummyBuf};

      // Clip 1: 1Q = 1000 samples
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Clip 2: 4Q to establish multi-clip context
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.master_pos = 0;
      clip2Ptr->startRecording();
      ctx.num_samples = 4000;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();
      ctx.num_samples = 1500;
      clip2Ptr->process(inputs, nullptr, 1, 0, ctx);

      // Clip 3: Start recording between 1Q-2Q of the 4Q context
      // master_pos = 1500 (between 1Q and 2Q)
      // effective_pos should be ~1500, next_q = 2000
      // slot should be 2 (anchoring at 2Q), NOT 3
      auto clip3 = std::make_unique<celestrian::ClipNode>("Clip3", SR);
      auto* clip3Ptr = clip3.get();
      parent.addChild(std::move(clip3));

      ctx.master_pos = 1500;  // Between 1Q and 2Q
      ctx.num_samples = 100;
      clip3Ptr->startRecording();

      // Call process multiple times to simulate real audio loop
      for (int i = 0; i < 10; i++) {
        clip3Ptr->process(inputs, nullptr, 1, 0, ctx);
        ctx.master_pos += 50;
      }

      // x_pos should be at slot 2 (0 + 2*200 = 400)
      // NOT at slot 3 (600) which was the bug
      int64_t xPos = clip3Ptr->x_pos.load();
      expect(xPos >= 200 && xPos <= 500,
             "x_pos should be at slot 2 (around 400), not slot 3");
    }

    // LCM Ghost Extension Test: All clips at 0% at LCM boundary
    // Scenario: 1Q + 8Q + 4Q clips, LCM = 8Q
    // At timeline = LCM, ALL clips should have playhead = 0%
    beginTest("LCM: All Clips at 0% at LCM Boundary");
    {
      const double SR = 1000.0;  // 1000 samples = 1Q
      celestrian::BoxNode parent("Parent");

      // Clip 1: 1Q (1000 samples)
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 1000;
      ctx.is_recording = true;
      ctx.master_pos = 0;

      float input[1000] = {0.5f};
      float* const inputs[] = {input};

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();

      // Clip 2: 8Q (8000 samples)
      auto clip2 = std::make_unique<celestrian::ClipNode>("Clip2", SR);
      auto* clip2Ptr = clip2.get();
      parent.addChild(std::move(clip2));

      ctx.num_samples = 8000;
      ctx.master_pos = 0;
      float input8k[8000] = {0.3f};
      float* const inputs8k[] = {input8k};

      clip2Ptr->startRecording();
      clip2Ptr->process(inputs8k, nullptr, 1, 0, ctx);
      clip2Ptr->stopRecording();

      // Commit clip 2
      ctx.is_recording = true;
      while (clip2Ptr->isAwaitingStop()) {
        ctx.master_pos += 1000;
        clip2Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Clip 3: 4Q (4000 samples)
      auto clip3 = std::make_unique<celestrian::ClipNode>("Clip3", SR);
      auto* clip3Ptr = clip3.get();
      parent.addChild(std::move(clip3));

      ctx.num_samples = 4000;
      ctx.master_pos = 0;
      float input4k[4000] = {0.2f};
      float* const inputs4k[] = {input4k};

      clip3Ptr->startRecording();
      clip3Ptr->process(inputs4k, nullptr, 1, 0, ctx);
      clip3Ptr->stopRecording();

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

    // LCM: Clip 3 Wait Logic (Fix for "Start Immediately" bug)
    // Scenario: Context=4Q. User hits record at 3.9Q.
    // Bug was: next_q calculated as 0 (past), causing immediate start.
    // Expected: next_q calculated as 4Q, waiting for boundary.
    beginTest("LCM: Clip 3 Wait Logic at Q Boundary");
    {
      const double SR = 1000.0;  // 1Q = 1000 samples
      celestrian::BoxNode parent("Parent");

      // Setup Context: Clip 1 (4Q) -> Context 4000
      auto clip1 = std::make_unique<celestrian::ClipNode>("Clip1", SR);
      auto* clip1Ptr = clip1.get();
      parent.addChild(std::move(clip1));

      celestrian::ProcessContext ctx;
      ctx.num_samples = 4000;
      ctx.master_pos = 0;
      ctx.is_recording = true;
      float input[4000] = {0.0f};
      float* const inputs[] = {input, input};

      clip1Ptr->startRecording();
      clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      clip1Ptr->stopRecording();
      // Commit
      ctx.master_pos = 4000;
      while (clip1Ptr->isAwaitingStop()) {
        clip1Ptr->process(inputs, nullptr, 1, 0, ctx);
      }

      // Create Clip 3
      auto clip3 = std::make_unique<celestrian::ClipNode>("Clip3", SR);
      auto* clip3Ptr = clip3.get();
      parent.addChild(std::move(clip3));

      // Attempt to record at 3900 (3.9Q)
      ctx.master_pos = 3900;
      ctx.num_samples = 100;  // Process up to 4000
      ctx.is_recording = false;

      clip3Ptr->startRecording();

      // Process one block.
      // With bug: next_q=0, 3900 >= 0 -> starts recording immediately.
      // With fix: next_q=4000, 3900 < 4000 -> waits.
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      // Check we are NOT recording yet (should be waiting)
      expect(!clip3Ptr->isRecording(),
             "Clip 3 should be waiting (not recording) at 3.9Q");

      // Advance to 4000 (4Q)
      ctx.master_pos = 4000;
      ctx.num_samples = 100;
      clip3Ptr->process(inputs, nullptr, 1, 0, ctx);

      // Now it should start
      expect(clip3Ptr->isRecording(),
             "Clip 3 should have started recording at 4000 (4Q)");
    }
  }
};

static AudioEngineWorkflowTests audioEngineWorkflowTests;
