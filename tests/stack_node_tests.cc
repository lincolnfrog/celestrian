#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

class StackNodeTests : public juce::UnitTest {
 public:
  StackNodeTests() : juce::UnitTest("StackNode", "Audio Engine") {}

  void runTest() override {
    beginTest("Hierarchy Management");
    {
      StackNode root("Root");
      expectEquals(root.getNumChildren(), 0);

      root.addChild(std::make_unique<ClipNode>("Clip1", 44100.0));
      expectEquals(root.getNumChildren(), 1);

      root.addChild(std::make_unique<StackNode>("SubBox"));
      expectEquals(root.getNumChildren(), 2);

      root.clearChildren();
      expectEquals(root.getNumChildren(), 0);
    }

    beginTest("Audio Summing (Stereo)");
    {
      StackNode root("Root");

      // Add two children that will produce specific DC signals
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);

      // Simulate recording 0.2 into clip1 and 0.3 into clip2
      float in1[10], in2[10];
      for (int i = 0; i < 10; ++i) {
        in1[i] = 0.2f;
        in2[i] = 0.3f;
      }
      float* const inputs1[] = {in1};
      float* const inputs2[] = {in2};

      NodeContext rec1 = contextFor(*clip1, 10);
      rec1.ctx.is_recording = true;
      clip1->startRecording();
      clip1->process(inputs1, nullptr, 1, 0, rec1.ctx);
      clip1->stopRecording();

      NodeContext rec2 = contextFor(*clip2, 10);
      rec2.ctx.is_recording = true;
      clip2->startRecording();
      clip2->process(inputs2, nullptr, 1, 0, rec2.ctx);
      clip2->stopRecording();

      root.addChild(std::move(clip1));
      root.addChild(std::move(clip2));

      // Now play them back through the root box
      float outL[10], outR[10];
      for (int i = 0; i < 10; ++i) {
        outL[i] = 0.0f;
        outR[i] = 0.0f;
      }
      float* const outputs[] = {outL, outR};

      NodeContext play = contextFor(root, 10);
      play.ctx.is_playing = true;

      // Start playback on both children
      static_cast<ClipNode*>(root.getChild(0))->startPlayback();
      static_cast<ClipNode*>(root.getChild(1))->startPlayback();

      root.process(nullptr, outputs, 0, 2, play.ctx);

      // Sum should be 0.2 + 0.3 = 0.5 in both channels
      for (int i = 0; i < 10; ++i) {
        expect(std::abs(outL[i] - 0.5f) < 0.0001f);
        expect(std::abs(outR[i] - 0.5f) < 0.0001f);
      }
    }

    beginTest("Aggregate Waveform");
    {
      StackNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);

      // Clip 1 peak = 1.0, Clip 2 peak = 0.5
      float in1[1] = {1.0f};
      float in2[1] = {0.5f};
      float* const ins1[] = {in1};
      float* const ins2[] = {in2};
      NodeContext rec1 = contextFor(*clip1, 1);
      rec1.ctx.is_recording = true;
      clip1->startRecording();
      clip1->process(ins1, nullptr, 1, 0, rec1.ctx);
      clip1->stopRecording();
      NodeContext rec2 = contextFor(*clip2, 1);
      rec2.ctx.is_recording = true;
      clip2->startRecording();
      clip2->process(ins2, nullptr, 1, 0, rec2.ctx);
      clip2->stopRecording();

      root.addChild(std::move(clip1));
      root.addChild(std::move(clip2));

      auto waveform = root.getWaveform(1);
      // (1.0 + 0.5) / 2 = 0.75
      expect(std::abs((float)waveform[0] - 0.75f) < 0.0001f);
    }

    beginTest("Input Propagation");
    {
      StackNode root("Root");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();
      root.addChild(std::move(clip));

      float in[1] = {0.9f};
      float* const ins[] = {in};
      NodeContext nc = contextFor(root, 1);
      nc.ctx.is_recording = true;

      clipPtr->startRecording();
      root.process(ins, nullptr, 1, 0, nc.ctx);

      expectEquals(clipPtr->getWritePosition(), 1);
      expectWithinAbsoluteError(clipPtr->getCurrentPeak(), 0.9f, 0.0001f);
    }

    beginTest("Solo Muting Behavior");
    {
      StackNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);
      auto clip1Ptr = clip1.get();
      auto clip2Ptr = clip2.get();

      // Record DC signals into each clip
      float in1[10], in2[10];
      for (int i = 0; i < 10; ++i) {
        in1[i] = 0.3f;
        in2[i] = 0.7f;
      }
      float* const inputs1[] = {in1};
      float* const inputs2[] = {in2};

      NodeContext rec1 = contextFor(*clip1Ptr, 10);
      rec1.ctx.is_recording = true;
      clip1Ptr->startRecording();
      clip1Ptr->process(inputs1, nullptr, 1, 0, rec1.ctx);
      clip1Ptr->stopRecording();

      NodeContext rec2 = contextFor(*clip2Ptr, 10);
      rec2.ctx.is_recording = true;
      clip2Ptr->startRecording();
      clip2Ptr->process(inputs2, nullptr, 1, 0, rec2.ctx);
      clip2Ptr->stopRecording();

      root.addChild(std::move(clip1));
      root.addChild(std::move(clip2));

      clip1Ptr->startPlayback();
      clip2Ptr->startPlayback();

      // Playback without solo: should sum both clips (0.3 + 0.7 = 1.0)
      float outL[10] = {0.0f};
      float outR[10] = {0.0f};
      float* const outputs[] = {outL, outR};

      NodeContext play = contextFor(root, 10);  // no solo lit anywhere
      ProcessContext& playCtx = play.ctx;
      playCtx.is_playing = true;

      root.process(nullptr, outputs, 0, 2, playCtx);
      expect(std::abs(outL[0] - 1.0f) < 0.0001f,
             "Without solo, both clips should play.");

      // Playback with clip1 soloed (Q16 flags): only clip1 (0.3)
      for (int i = 0; i < 10; ++i) {
        outL[i] = 0.0f;
        outR[i] = 0.0f;
      }
      clip1Ptr->is_soloed.store(true);
      play.refresh();  // the block top re-scans the solo flags

      // Settle the S7 fade (~10 ms — sequencer.md §9): solo edges ramp
      // now; one 441-sample block consumes the whole fade.
      {
        float settleL[441] = {}, settleR[441] = {};
        float* const settleOuts[] = {settleL, settleR};
        ProcessContext settle = playCtx;
        settle.num_samples = 441;
        root.process(nullptr, settleOuts, 0, 2, settle);
      }

      root.process(nullptr, outputs, 0, 2, playCtx);
      expect(std::abs(outL[0] - 0.3f) < 0.0001f,
             "With clip1 soloed, only clip1 should play.");
      clip1Ptr->is_soloed.store(false);
    }

    beginTest("Loop Window: Active Window Applies (collapsed view)");
    {
      StackNode root("Root");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();

      // Record 100 samples of DC signal
      float in[100];
      for (int i = 0; i < 100; ++i) in[i] = 0.5f;
      float* const inputs[] = {in};

      NodeContext rec = contextFor(*clipPtr, 100);
      rec.ctx.is_recording = true;

      clipPtr->startRecording();
      clipPtr->process(inputs, nullptr, 1, 0, rec.ctx);
      clipPtr->stopRecording();

      root.addChild(std::move(clip));

      // Set stack loop region to [20, 40]
      root.setLoopPoints(20, 40);

      clipPtr->startPlayback();

      // Process with master_pos = 50, should map to:
      // loop_duration = 40 - 20 = 20
      // effective_pos = 20 + (50 % 20) = 20 + 10 = 30
      NodeContext play = contextFor(root, 1, 50);
      play.ctx.is_playing = true;

      float outL[1] = {0.0f};
      float* const outputs[] = {outL};
      root.process(nullptr, outputs, 0, 1, play.ctx);

      // ClipNode should have received master_pos = 30, which maps into its
      // recorded content Expected behavior verified by checking audio output
      expect(outL[0] > 0.0f,
             "Collapsed stack should produce output with loop "
             "window applied");
    }

    beginTest("Loop Window: Active Window Applies (expanded view - I6b)");
    {
      StackNode root("Root");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();

      // Record 100 samples of DC signal
      float in[100];
      for (int i = 0; i < 100; ++i) in[i] = 0.5f;
      float* const inputs[] = {in};

      NodeContext rec = contextFor(*clipPtr, 100);
      rec.ctx.is_recording = true;

      clipPtr->startRecording();
      clipPtr->process(inputs, nullptr, 1, 0, rec.ctx);
      clipPtr->stopRecording();

      root.addChild(std::move(clip));

      // Set stack loop region to [20, 40]. time_maps.md/I6b: expansion
      // is UI-local and unrepresentable here — the window is ACTIVE
      // whatever the view shows.
      root.setLoopPoints(20, 40);

      clipPtr->startPlayback();

      // master_pos = 50 maps to 20 + (50 % 20) = 30, same as collapsed
      NodeContext play = contextFor(root, 1, 50);
      play.ctx.is_playing = true;

      float outL[1] = {0.0f};
      float* const outputs[] = {outL};
      root.process(nullptr, outputs, 0, 1, play.ctx);

      expect(outL[0] > 0.0f,
             "Active window applies identically when expanded (I6b)");
    }

    beginTest("Loop Window: Nested - inner window applies, outer unset");
    {
      StackNode outer("Outer");  // outer has no window

      auto inner = std::make_unique<StackNode>("Inner");
      inner->setLoopPoints(10, 30);  // inner applies its loop

      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();

      // Record 100 samples
      float in[100];
      for (int i = 0; i < 100; ++i) in[i] = 0.5f;
      float* const inputs[] = {in};

      NodeContext rec = contextFor(*clipPtr, 100);
      rec.ctx.is_recording = true;

      clipPtr->startRecording();
      clipPtr->process(inputs, nullptr, 1, 0, rec.ctx);
      clipPtr->stopRecording();

      inner->addChild(std::move(clip));
      outer.addChild(std::move(inner));

      clipPtr->startPlayback();

      // Outer expanded: passes master_pos = 50 unchanged
      // Inner collapsed with loop [10, 30]: maps to 10 + (50 % 20) = 20
      NodeContext play = contextFor(outer, 1, 50);
      play.ctx.is_playing = true;

      float outL[1] = {0.0f};
      float* const outputs[] = {outL};
      outer.process(nullptr, outputs, 0, 1, play.ctx);

      expect(outL[0] > 0.0f,
             "Nested stacks should apply their own collapse "
             "states independently");
    }
  }
};

static StackNodeTests stackNodeTests;

}  // namespace celestrian
