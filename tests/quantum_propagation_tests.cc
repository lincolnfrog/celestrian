#include <juce_core/juce_core.h>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

class QuantumPropagationTests : public juce::UnitTest {
 public:
  QuantumPropagationTests()
      : juce::UnitTest("Quantum Propagation", "Audio Engine") {}

  void runTest() override {
    float dummy[10000] = {0.0f};
    float* const inputs[] = {dummy};

    beginTest("Stored Quantum: survives shorter clips and its creator");
    {
      // Q is stored island state (design_language.md Q1): a shorter
      // committed clip does not change it, and deleting the clip that
      // established it does not orphan it.
      StackNode root("Root");
      auto clip1 = std::make_unique<ClipNode>("QClip", 44100.0);
      auto* c1 = clip1.get();
      root.addChild(std::move(clip1));

      NodeContext nc = contextFor(root, 0, 0);
      nc.driveFrom(*c1);
      ProcessContext& ctx = nc.ctx;

      c1->startRecording();
      ctx.num_samples = 1000;
      c1->process(inputs, nullptr, 1, 0, ctx);
      // The first take: its stop commits at the next block top, Q = 1000.
      test_utils::stopAtBlockTop(*c1, ctx);
      expectEquals(root.getQuantum(), (int64_t)1000);
      expectEquals(root.getZero(), (int64_t)0);

      // A short overdub snapping to the Q/2 subdivision (480 -> 500)
      // must NOT halve Q.
      auto clip2 = std::make_unique<ClipNode>("Short", 44100.0);
      auto* c2 = clip2.get();
      root.addChild(std::move(clip2));
      nc.rebuild();  // structure changed; Q now 1000
      nc.driveFrom(*c2);

      c2->startRecording();
      ctx.num_samples = 480;
      c2->process(inputs, nullptr, 1, 0, ctx);
      c2->stopRecording();  // L=480 < Q/2 -> awaits the 500 subdivision
      ctx.master_pos = 480;
      ctx.num_samples = 100;
      c2->process(inputs, nullptr, 1, 0, ctx);  // crosses 500 -> commit

      expectEquals(c2->getIntrinsicDuration(), (int64_t)500);
      expectEquals(root.getEffectiveQuantum(), (int64_t)1000,
                   "Q must not change when a shorter clip commits");

      // Q survives its creator: delete the establishing clip.
      // (removeChild(index) detaches and returns ownership; letting it
      // drop destroys the node — fine single-threaded.)
      for (int i = 0; i < root.getNumChildren(); ++i) {
        if (root.getChild(i) == c1) {
          root.removeChild(i);
          break;
        }
      }
      expectEquals(root.getEffectiveQuantum(), (int64_t)1000,
                   "Q survives deletion of the clip that established it");
    }

    beginTest("Composite duration is the LCM of children, not the min");
    {
      StackNode root("Root");
      auto q = std::make_unique<ClipNode>("QClip", 44100.0);
      auto* qPtr = q.get();
      root.addChild(std::move(q));

      NodeContext nc = contextFor(root, 1000, 0);
      nc.driveFrom(*qPtr);
      qPtr->startRecording();
      qPtr->process(inputs, nullptr, 1, 0, nc.ctx);
      test_utils::stopAtBlockTop(*qPtr, nc.ctx);  // Q = 1000

      // Nested stack with 1000- and 1500-sample clips: composite = 3000.
      auto sub = std::make_unique<StackNode>("Sub");
      auto* subPtr = sub.get();
      root.addChild(std::move(sub));  // attach BEFORE filling: shares island
      subPtr->addChild(test_utils::committedClip("C", 44100.0, 1000, 0.0f));
      subPtr->addChild(test_utils::committedClip("C", 44100.0, 1500, 0.0f));

      expectEquals(subPtr->getIntrinsicDuration(), (int64_t)3000,
                   "composite duration = LCM(1000, 1500)");
      expectEquals(subPtr->getEffectiveQuantum(), (int64_t)1000,
                   "nested stack inherits the island quantum");
    }

    beginTest("A stopped take runs on to its boundary and commits whole; an "
              "unpadded commit keeps its raw length under the one window a "
              "commit writes");
    {
      // Q = 1000 from a first take; the take under test stops (or commits)
      // `raw` samples in. `run_on` is the block driven after the stop,
      // long enough to cross the boundary; 0 commits at once, unpadded.
      struct Row {
        const char* what;
        int raw, run_on;
        int64_t want_duration, want_loop_end;
      };
      const Row rows[] = {
          {"stop at 1.1Q: on to 2Q", 1100, 1000, 2000, 0},
          {"stop at 0.95Q: on to 1Q", 950, 100, 1000, 0},
          {"stop at 2.5Q: on to 3Q", 2500, 600, 3000, 0},
          {"stop at 0.7Q, past the Q/2 subdivision: on to 1Q", 700, 400, 1000,
           0},
          // 400 past 3Q is outside the snap tolerance: the raw length
          // stands and the region that sounds is the previous clean
          // multiple.
          {"commit at 3.4Q: raw, windowed to [0, 3Q)", 3400, 0, 3400, 3000},
      };
      for (const Row& row : rows) {
        const juce::String what(row.what);
        StackNode root("Root");
        auto definer = std::make_unique<ClipNode>("Definer", 44100.0);
        auto* definer_ptr = definer.get();
        root.addChild(std::move(definer));
        NodeContext nc = contextFor(root, 1000, 0);
        nc.driveFrom(*definer_ptr);
        ProcessContext& ctx = nc.ctx;
        definer_ptr->startRecording();
        definer_ptr->process(inputs, nullptr, 1, 0, ctx);
        test_utils::stopAtBlockTop(*definer_ptr, ctx);  // Q = 1000

        auto take = std::make_unique<ClipNode>("Take", 44100.0);
        auto* take_ptr = take.get();
        root.addChild(std::move(take));
        nc.rebuild();
        nc.driveFrom(*take_ptr);
        take_ptr->startRecording();
        ctx.num_samples = row.raw;
        take_ptr->process(inputs, nullptr, 1, 0, ctx);
        if (row.run_on > 0) {
          take_ptr->stopRecording();
          expect(take_ptr->isRecording(),
                 what + ": the stop waits for the boundary");
          ctx.master_pos = row.raw;
          ctx.num_samples = row.run_on;
          take_ptr->process(inputs, nullptr, 1, 0, ctx);
        } else {
          take_ptr->commitRecording(ctx);
        }
        expect(!take_ptr->isRecording(), what + ": committed");
        expectEquals(take_ptr->getIntrinsicDuration(), row.want_duration,
                     what + ": duration");
        expectEquals(take_ptr->getLoopStart(), (int64_t)0,
                     what + ": loop start");
        expectEquals(take_ptr->getLoopEnd(), row.want_loop_end,
                     what + ": loop end (0 = a whole take, no window)");
        expect(take_ptr->isLoopWindowActive() == (row.want_loop_end > 0),
               what + ": the window is active exactly when one was written");
      }
    }
  }
};

static QuantumPropagationTests quantumPropagationTests;

}  // namespace celestrian
