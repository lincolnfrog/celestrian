#include "../src/box_node.h"
#include "../src/clip_node.h"
#include <juce_core/juce_core.h>

namespace celestrian {

class BoxNodeTests : public juce::UnitTest {
public:
  BoxNodeTests() : juce::UnitTest("BoxNode", "Audio Engine") {}

  void runTest() override {
    beginTest("Hierarchy Management");
    {
      BoxNode root("Root");
      expectEquals(root.getNumChildren(), 0);

      root.addChild(std::make_unique<ClipNode>("Clip1", 44100.0));
      expectEquals(root.getNumChildren(), 1);

      root.addChild(std::make_unique<BoxNode>("SubBox"));
      expectEquals(root.getNumChildren(), 2);

      root.clearChildren();
      expectEquals(root.getNumChildren(), 0);
    }

    beginTest("Audio Summing (Stereo)");
    {
      BoxNode root("Root");

      // Add two children that will produce specific DC signals
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);

      // Simulate recording 0.2 into clip1 and 0.3 into clip2
      float in1[10], in2[10];
      for (int i = 0; i < 10; ++i) {
        in1[i] = 0.2f;
        in2[i] = 0.3f;
      }
      float *const inputs1[] = {in1};
      float *const inputs2[] = {in2};

      ProcessContext recCtx;
      recCtx.num_samples = 10;
      recCtx.is_recording = true;

      clip1->startRecording();
      clip1->process(inputs1, nullptr, 1, 0, recCtx);
      clip1->stopRecording();

      clip2->startRecording();
      clip2->process(inputs2, nullptr, 1, 0, recCtx);
      clip2->stopRecording();

      root.addChild(std::move(clip1));
      root.addChild(std::move(clip2));

      // Now play them back through the root box
      float outL[10], outR[10];
      for (int i = 0; i < 10; ++i) {
        outL[i] = 0.0f;
        outR[i] = 0.0f;
      }
      float *const outputs[] = {outL, outR};

      ProcessContext playCtx;
      playCtx.num_samples = 10;
      playCtx.is_playing = true;

      // Start playback on both children
      static_cast<ClipNode *>(root.getChild(0))->startPlayback();
      static_cast<ClipNode *>(root.getChild(1))->startPlayback();

      root.process(nullptr, outputs, 0, 2, playCtx);

      // Sum should be 0.2 + 0.3 = 0.5 in both channels
      for (int i = 0; i < 10; ++i) {
        expect(std::abs(outL[i] - 0.5f) < 0.0001f);
        expect(std::abs(outR[i] - 0.5f) < 0.0001f);
      }
    }

    beginTest("Aggregate Waveform");
    {
      BoxNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("Clip1", 44100.0);
      auto clip2 = std::make_unique<ClipNode>("Clip2", 44100.0);

      // Clip 1 peak = 1.0, Clip 2 peak = 0.5
      float in1[1] = {1.0f};
      float in2[1] = {0.5f};
      float *const ins1[] = {in1};
      float *const ins2[] = {in2};
      ProcessContext ctx;
      ctx.num_samples = 1;
      ctx.is_recording = true;

      clip1->startRecording();
      clip1->process(ins1, nullptr, 1, 0, ctx);
      clip1->stopRecording();
      clip2->startRecording();
      clip2->process(ins2, nullptr, 1, 0, ctx);
      clip2->stopRecording();

      root.addChild(std::move(clip1));
      root.addChild(std::move(clip2));

      auto waveform = root.getWaveform(1);
      // (1.0 + 0.5) / 2 = 0.75
      expect(std::abs((float)waveform[0] - 0.75f) < 0.0001f);
    }

    beginTest("Input Propagation");
    {
      BoxNode root("Root");
      auto clip = std::make_unique<ClipNode>("Clip", 44100.0);
      auto clipPtr = clip.get();
      root.addChild(std::move(clip));

      float in[1] = {0.9f};
      float *const ins[] = {in};
      ProcessContext ctx;
      ctx.num_samples = 1;
      ctx.is_recording = true;

      clipPtr->startRecording();
      root.process(ins, nullptr, 1, 0, ctx);

      expectEquals(clipPtr->getWritePos(), 1);
      expectWithinAbsoluteError(clipPtr->get_current_peak(), 0.9f, 0.0001f);
    }
  }
};

static BoxNodeTests boxNodeTests;

} // namespace celestrian
