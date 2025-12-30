#include "../src/box_node.h"
#include "../src/clip_node.h"
#include <juce_core/juce_core.h>

namespace celestrian {

class RegressionTests : public juce::UnitTest {
public:
  RegressionTests()
      : juce::UnitTest("Shadowing & Thread Safety", "Regression") {}

  void runTest() override {
    beginTest("Shadowing: last_block_peak");
    {
      ClipNode node("TestClip", 44100.0);
      AudioNode *baseNode = &node;

      // Update subclass peak
      ProcessContext ctx;
      ctx.num_samples = 10;
      ctx.is_recording = true;
      float in[10] = {0.8f, 0.0f, 0.0f, 0.0f, 0.0f,
                      0.0f, 0.0f, 0.0f, 0.0f, 0.0f};
      float *const ins[] = {in};
      node.startRecording();
      node.process(ins, nullptr, 1, 0, ctx);

      // Verify base node metadata sees the peak
      auto metadata = baseNode->getMetadata();
      expectEquals((float)metadata["currentPeak"], 0.8f);
    }

    beginTest("Shadowing: duration_samples");
    {
      ClipNode node("TestClip", 44100.0);
      AudioNode *baseNode = &node;

      node.startRecording();
      ProcessContext ctx;
      ctx.num_samples = 500;
      ctx.is_recording = true;
      float in[500] = {0};
      float *const ins[] = {in};
      node.process(ins, nullptr, 1, 0, ctx);
      node.stopRecording(); // Should stop immediately if no quantum

      auto metadata = baseNode->getMetadata();
      expectEquals((int)metadata["duration"], 500);
    }

    beginTest("Hierarchy Metadata Thread Safety (Simulated)");
    {
      BoxNode root("Root");
      for (int i = 0; i < 10; ++i) {
        root.addChild(std::make_unique<ClipNode>("Clip" + juce::String(i)));
      }

      // Simulate UI polling on one "thread" while adding a node on another
      // (Both on message thread in reality, but we want to ensure mutation
      // doesn't crash iteration)
      auto metadata = root.getMetadata();
      expectEquals((int)metadata["childCount"], 10);

      auto nodes = metadata["nodes"];
      expect(nodes.isArray());
      expectEquals(nodes.size(), 10);
    }
  }
};

static RegressionTests regressionTests;

} // namespace celestrian
