/**
 * Monotonic clock tests — kernel.md §2 finally holds in full:
 * the transport is NEVER reset or rebased (unification_audit.md §1.1).
 *
 * Pins the two behaviors that replaced the deleted clock mutations:
 *  1. First clip recorded at t > 0: the arm moment becomes the island
 *     EPOCH (data), the clock is untouched, and the view/alignment are
 *     epoch-relative from that moment on.
 *  2. Stop/play is pause/resume: stopping freezes the cycle view where
 *     it is; playing resumes from the same phase.
 */

#include <juce_core/juce_core.h>

#include <vector>

#include "../src/audio_engine.h"

class MonotonicClockTests : public juce::UnitTest {
 public:
  MonotonicClockTests() : juce::UnitTest("Monotonic Clock (never reset)") {}

  void runTest() override {
    const int BLOCK_SIZE = 512;
    const int64_t Q = 44100;

    auto makeDriver = [&](AudioEngine &engine) {
      return [&engine, BLOCK_SIZE](int64_t total_samples) {
        static std::vector<float> buffer((size_t)512, 0.0f);
        buffer.assign((size_t)BLOCK_SIZE, 0.0f);
        float *ins[] = {buffer.data()};
        float *outs[] = {buffer.data(), buffer.data()};
        int64_t remaining = total_samples;
        while (remaining > 0) {
          int n = (int)std::min<int64_t>(remaining, BLOCK_SIZE);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
    };

    auto firstClipId = [](AudioEngine &engine) -> juce::String {
      auto state = engine.getGraphState();
      return (*state.getDynamicObject()->getProperty("nodes").getArray())[0]
          .getDynamicObject()
          ->getProperty("id");
    };

    auto masterPos = [](AudioEngine &engine) -> int64_t {
      return (int64_t)(double)engine.getGraphState()
          .getDynamicObject()
          ->getProperty("masterPos");
    };

    beginTest("First clip at t > 0: epoch captured as data, clock untouched");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      engine.createNode("clip");
      const juce::String id = firstClipId(engine);

      // Let the transport run well past zero before the first take —
      // under the old code startRecordingInNode reset the clock here.
      engine.togglePlayback();
      const int64_t t0 = 3 * Q + 1234;
      process(t0);

      engine.startRecordingInNode(id);
      process(Q);  // arm happens at block start (t0), then 1Q captured
      engine.stopRecordingInNode(id);  // no island Q yet -> immediate commit

      auto state = engine.getGraphState();
      auto *root = state.getDynamicObject();
      const int64_t epoch = (int64_t)(double)root->getProperty("islandEpoch");
      expectEquals((juce::int64)epoch, (juce::int64)t0,
                   "island epoch is the arm moment, not 0");

      auto clip = (*root->getProperty("nodes").getArray())[0];
      expectEquals(
          (juce::int64)(double)clip.getDynamicObject()->getProperty("origin"),
          (juce::int64)t0, "first clip origin equals the epoch");

      // The cycle view is epoch-relative: one block after commit the
      // cursor is at 512, not at t0 + Q + 512.
      process(BLOCK_SIZE);
      expectEquals((juce::int64)masterPos(engine), (juce::int64)BLOCK_SIZE,
                   "masterPos view derives from (t - epoch) mod cycle");
    }

    beginTest("Stop/play is pause/resume (view freezes, phase continues)");
    {
      AudioEngine engine;
      auto process = makeDriver(engine);
      engine.createNode("clip");
      const juce::String id = firstClipId(engine);

      engine.startRecordingInNode(id);  // auto-plays; epoch = 0
      process(Q);
      engine.stopRecordingInNode(id);  // immediate commit: 1Q clip

      process(Q / 4);
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 4),
                   "quarter of the way into the cycle");

      engine.togglePlayback();  // stop
      expect(!engine.isPlaying());
      process(2 * BLOCK_SIZE);  // callbacks keep running while stopped
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 4),
                   "stopping freezes the view (old code snapped it to 0)");

      engine.togglePlayback();  // play
      process(Q / 4);
      expectEquals((juce::int64)masterPos(engine), (juce::int64)(Q / 2),
                   "playing resumes from the stopped phase");
    }
  }
};

static MonotonicClockTests monotonicClockTests;
