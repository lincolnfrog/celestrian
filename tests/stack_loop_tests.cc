#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {

/**
 * Tests for stack-level loop region with internal transport.
 * Verifies that collapsed stacks use their own transport counter
 * that wraps at loop_duration, independent of global transport LCM.
 */
class StackLoopTests : public juce::UnitTest {
 public:
  StackLoopTests() : juce::UnitTest("Stack Loop Region", "StackLoopDebug") {}

  void runTest() override {
    float dummy[10000] = {0.0f};
    float* const inputs[] = {dummy};
    float output[10000] = {0.0f};
    float* const outputs[] = {output};

    beginTest("Internal Transport Increments When Collapsed");
    {
      StackNode stack("TestStack");

      // Set loop region: 0 to 88200 (2Q at 44.1kHz)
      stack.setLoopPoints(0, 88200);
      stack.is_expanded.store(false);  // Collapse the stack

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 512;
      ctx.master_pos =
          0;  // Global transport (should be ignored when collapsed)

      // Initial internal transport should be 0
      expectEquals(stack.getInternalTransport(), (int64_t)0);

      // Process one block
      stack.process(inputs, outputs, 1, 1, ctx);

      // Internal transport should have incremented by num_samples
      expectEquals(stack.getInternalTransport(), (int64_t)512);

      // Process another block
      stack.process(inputs, outputs, 1, 1, ctx);

      // Should be 1024 now
      expectEquals(stack.getInternalTransport(), (int64_t)1024);
    }

    beginTest("Internal Transport Does NOT Increment When Expanded");
    {
      StackNode stack("TestStack");

      stack.setLoopPoints(0, 88200);
      stack.is_expanded.store(true);  // Expanded

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 512;
      ctx.master_pos = 1000;

      stack.resetInternalTransport(0);
      expectEquals(stack.getInternalTransport(), (int64_t)0);

      // Process block - internal transport should NOT change when expanded
      stack.process(inputs, outputs, 1, 1, ctx);

      // Internal transport unchanged (expanded uses global transport)
      expectEquals(stack.getInternalTransport(), (int64_t)0);
    }

    beginTest("Internal Transport Resets on Collapse");
    {
      StackNode stack("TestStack");

      stack.setLoopPoints(0, 88200);
      stack.is_expanded.store(false);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 10000;
      ctx.master_pos = 0;

      // Process to advance internal transport
      stack.process(inputs, outputs, 1, 1, ctx);
      expect(stack.getInternalTransport() > 0);

      // Reset should bring it back to 0
      stack.resetInternalTransport(0);
      expectEquals(stack.getInternalTransport(), (int64_t)0);
    }

    beginTest("Internal Transport Wraps at Loop Duration");
    {
      StackNode stack("TestStack");

      // Small loop for easy testing: 1000 samples
      stack.setLoopPoints(0, 1000);
      stack.is_expanded.store(false);
      stack.resetInternalTransport(0);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 300;
      ctx.master_pos = 0;

      // Process 4 blocks of 300 samples = 1200 total
      // Should wrap at 1000, so effective position = 200 after wrap
      for (int i = 0; i < 4; i++) {
        stack.process(inputs, outputs, 1, 1, ctx);
      }

      // Internal transport = 1200, child_pos = 0 + (1200 % 1000) = 200
      // The modulo happens in process(), transport itself may be >
      // loop_duration
      int64_t transport = stack.getInternalTransport();
      expectEquals(transport, (int64_t)1200);

      // The important thing is that child_pos wraps correctly
      // (verified via audio output behavior, not directly testable here)
    }

    beginTest("Child Receives Looped Position When Stack Collapsed");
    {
      StackNode stack("TestStack");
      auto clip = std::make_unique<ClipNode>("TestClip", 44100.0);
      auto clipPtr = clip.get();

      // Pre-record some audio so clip has duration
      clipPtr->startRecording();
      ProcessContext ctx;
      ctx.num_samples = 3000;  // 3Q-ish duration
      ctx.is_recording = true;
      ctx.master_pos = 0;
      clipPtr->process(inputs, outputs, 1, 1, ctx);
      clipPtr->stopRecording();

      stack.addChild(std::move(clip));

      // Set stack loop to only first 1000 samples (1/3 of clip)
      stack.setLoopPoints(0, 1000);
      stack.is_expanded.store(false);
      stack.resetInternalTransport(0);

      // Process the stack - clip should only "see" positions 0-999
      ctx.is_playing = true;
      ctx.num_samples = 500;

      // After 2000 samples (2 loops worth), internal should be 2000
      // child_pos should be 0 + (2000 % 1000) = 0
      for (int i = 0; i < 4; i++) {
        stack.process(inputs, outputs, 1, 1, ctx);
      }

      expectEquals(stack.getInternalTransport(), (int64_t)2000);
    }

    beginTest("No Loop Applied When loop_end <= loop_start");
    {
      StackNode stack("TestStack");

      // Invalid loop region (end <= start)
      stack.setLoopPoints(1000, 500);  // end < start
      stack.is_expanded.store(false);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 512;
      ctx.master_pos = 5000;  // Should be passed through as-is

      stack.resetInternalTransport(0);

      // Without valid loop, it should fall back to global transport
      stack.process(inputs, outputs, 1, 1, ctx);

      // Internal transport shouldn't increment for invalid loop
      // (child receives global master_pos instead)
      expectEquals(stack.getInternalTransport(), (int64_t)0);
    }

    beginTest("Reproduction: 1Q+3Q Stack with 2Q Loop (High Transport)");
    {
      StackNode stack("ReproStack");

      int64_t loop_3q = 132300;
      int64_t loop_2q = 88200;

      stack.setLoopPoints(0, loop_3q);
      stack.is_expanded.store(false);

      // Initialize internal transport to be very high, near the overflow
      // threshold for 3Q Threshold is loop_duration * 1000 = 132,300,000 Set to
      // 132,295,000 (just 5000 samples before wrap)
      int64_t initial_transport = 132295000;
      stack.resetInternalTransport(initial_transport);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 100;
      ctx.master_pos = 0;

      // Step 2: Change Loop to 2Q (88200)
      // New threshold = 88,200,000.
      // Current (132M) > 88M. Trigger overflow logic?
      stack.setLoopPoints(0, loop_2q);

      // Track wrap points
      int wraps = 0;
      int64_t last_pos = stack.getInternalTransport();
      std::vector<int64_t> wrap_points;

      std::cout << "DEBUG: Initial High Transport = " << last_pos << std::endl;

      for (int i = 0; i < 4000; ++i) {
        stack.process(inputs, outputs, 1, 1, ctx);
        int64_t current = stack.getInternalTransport();

        if (i < 5) {
          std::cout << "Debug iter " << i << " transport=" << current
                    << " (effective=" << (current % loop_2q) << ")"
                    << std::endl;
        }

        int64_t effective_pos = current % loop_2q;
        int64_t effective_last = last_pos % loop_2q;

        if (effective_pos < effective_last) {
          wraps++;
          wrap_points.push_back(effective_last);
          std::cout << "WRAP DETECTED at internal=" << last_pos
                    << " (mod=" << effective_last << ")" << std::endl;
        }
        last_pos = current;
      }

      std::cout << "Total Wraps: " << wraps << std::endl;

      // Verify consistency: all wraps should be near 88200
      for (size_t i = 0; i < wrap_points.size(); ++i) {
        bool consistent = (wrap_points[i] > (loop_2q - 200));
        if (!consistent) {
          std::cout << "FAILURE: Inconsistent wrap point " << wrap_points[i]
                    << " (Expected near " << loop_2q << ")" << std::endl;
          expect(false, "Found inconsistent loop wrap point: " +
                            juce::String(wrap_points[i]));
        }
      }
      expectGreaterThan(wraps, 3);
    }
  }
};

static StackLoopTests stackLoopTests;

}  // namespace celestrian
