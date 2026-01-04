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
  }
};

static AudioEngineWorkflowTests audioEngineWorkflowTests;
