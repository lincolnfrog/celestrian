#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <vector>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::committedClip;
using test_utils::renderSettled;
using test_utils::StereoBlock;
using test_utils::contextFor;
using test_utils::NodeContext;

/**
 * The fractal output stage: every node's signal reaches its parent
 * through one resolution — render/sum → time-map → fx → gain·pan →
 * parent, with mute AS gain 0 at that stage. Pins:
 *  - muting a stack silences its subtree, and only its subtree,
 *  - the gain fader and the pan on clips and on stacks.
 * Mute against solo is solo_tests.cc's; the fader's persistence is
 * session_io_tests.cc's.
 */
class OutputStageTests : public juce::UnitTest {
 public:
  OutputStageTests() : juce::UnitTest("Output Stage", "Audio Engine") {}

  /** One (gain, pan) setting of a node and the level each side then
   * carries. */
  struct MixRow {
    float gain, pan, want_left, want_right;
    const char* what;
  };

  /** Sets each row on `node` and expects its settled block at those
   * levels: a silent side exactly silent, a sounding one within
   * rounding, and nothing louder anywhere in the block. */
  void expectMix(AudioNode& node, int len,
                 std::initializer_list<MixRow> rows) {
    const auto expectLevel = [&](float got, float want,
                                 const juce::String& what) {
      expectWithinAbsoluteError(got, want, want == 0.0f ? 0.0f : 1.0e-6f,
                                what);
    };
    for (const MixRow& row : rows) {
      node.gain.store(row.gain);
      node.pan.store(row.pan);
      const StereoBlock out = renderSettled(node, len);
      const juce::String what(row.what);
      expectLevel(out.left[100], row.want_left, what + " (L)");
      expectLevel(out.right[100], row.want_right, what + " (R)");
      expectLevel(out.peak(), std::max(row.want_left, row.want_right),
                  what + " (peak)");
    }
  }

  void runTest() override {
    constexpr double sr = 44100.0;
    constexpr int len = 4410;  // every clip's take, and the block rendered

    beginTest("Muting a stack silences its subtree, and only its subtree "
              "(and unmute restores)");
    {
      StackNode root("Root");
      root.addChild(committedClip("Direct", sr, len, 0.25f));
      auto group = std::make_unique<StackNode>("Inner");
      group->addChild(committedClip("Grouped", sr, len, 0.5f));
      StackNode* inner = group.get();
      root.addChild(std::move(group));

      expectWithinAbsoluteError(renderSettled(root, len).peak(), 0.75f,
                                1.0e-6f, "both subtrees sum");
      inner->is_muted.store(true);
      expectWithinAbsoluteError(renderSettled(root, len).peak(), 0.25f,
                                1.0e-6f, "only the direct clip remains");
      root.is_muted.store(true);
      expectEquals(renderSettled(root, len).peak(), 0.0f,
                   "a muted group is silent");
      root.is_muted.store(false);
      inner->is_muted.store(false);
      expectWithinAbsoluteError(renderSettled(root, len).peak(), 0.75f,
                                1.0e-6f, "unmute restores the group");
    }

    beginTest("Mute keeps child telemetry flowing (children still render)");
    {
      StackNode stack("TelemetryStack");
      auto clip = committedClip("Child", sr, len, 0.5f);
      ClipNode* raw = clip.get();
      stack.addChild(std::move(clip));
      stack.is_muted.store(true);
      // Render mid-take: the playhead phase is a render output — a muted
      // group must not freeze its children's cursors (the output stage
      // gates the SUM, not the render).
      renderSettled(stack, 441, /*master_pos=*/2205);
      expectWithinAbsoluteError(raw->playhead_pos.load(), 2205.0 / 4410.0,
                                1.0e-6, "child playhead advanced under mute");
    }

    beginTest("Gain and pan on a clip: the fader scales, the pan balances");
    {
      auto clip = committedClip("Faded", sr, len, 0.5f);
      expectMix(*clip, len,
                {{1.0f, 0.0f, 0.5f, 0.5f, "unity, centre: both sides at unity"},
                 {1.0f, -1.0f, 0.5f, 0.0f, "hard left: left carries"},
                 {0.5f, 0.0f, 0.25f, 0.25f, "half fader halves the output"},
                 {0.5f, -1.0f, 0.25f, 0.0f, "hard left at half fader"},
                 {0.0f, -1.0f, 0.0f, 0.0f, "zero fader is silent"}});
    }

    beginTest("Gain and pan on a stack scale its summed children");
    {
      StackNode stack("FadedStack");
      stack.addChild(committedClip("A", sr, len, 0.2f));
      stack.addChild(committedClip("B", sr, len, 0.3f));
      expectMix(stack, len,
                {{1.0f, 0.0f, 0.5f, 0.5f, "children sum on both sides"},
                 {0.5f, 0.0f, 0.25f, 0.25f, "group fader scales the sum"},
                 {1.0f, 1.0f, 0.0f, 0.5f, "group hard right: right carries"},
                 {0.5f, 1.0f, 0.0f, 0.25f, "hard right at half fader"}});
    }

    beginTest("sumOutputStage, the one stage a clip and a group share: a mono "
              "signal pans, a stereo pair balances and folds to a mono device "
              "as halves, a channel past the pair carries the left at the "
              "fader, and it sums into what the parent already holds");
    {
      constexpr int n = 8;
      const std::vector<float> l((size_t)n, 0.5f), r((size_t)n, 0.25f);
      // What `channels` outputs hold after the stage, each starting at
      // `floor`; `null_channel` is handed to the stage as a null pointer.
      const auto stage = [&](int channels, const float* right, float pan,
                             float gain, float floor = 0.0f,
                             int null_channel = -1) {
        std::vector<std::vector<float>> out(
            (size_t)channels, std::vector<float>((size_t)n, floor));
        std::vector<float*> outs;
        for (int ch = 0; ch < channels; ++ch) {
          outs.push_back(ch == null_channel ? nullptr : out[(size_t)ch].data());
        }
        sumOutputStage(outs.data(), channels, l.data(), right, n, pan, gain);
        std::vector<float> levels;
        for (const auto& channel : out) levels.push_back(channel[n - 1]);
        return levels;
      };
      const auto expectLevels = [&](const std::vector<float>& got,
                                    std::initializer_list<float> want,
                                    const juce::String& what) {
        expectEquals((int)got.size(), (int)want.size(), what);
        int ch = 0;
        for (const float level : want) {
          expectWithinAbsoluteError(got[(size_t)ch], level, 1.0e-7f,
                                    what + " (channel " + juce::String(ch) + ")");
          ++ch;
        }
      };
      expectLevels(stage(2, nullptr, 0.0f, 1.0f), {0.5f, 0.5f},
                   "mono, centre: both sides");
      expectLevels(stage(2, nullptr, 0.5f, 1.0f), {0.25f, 0.5f},
                   "mono, half right: the left attenuates");
      expectLevels(stage(2, r.data(), 0.0f, 0.5f), {0.25f, 0.125f},
                   "a pair at half fader: each side its own");
      expectLevels(stage(2, r.data(), -1.0f, 1.0f), {0.5f, 0.0f},
                   "a pair hard left: the right is shut, not moved");
      expectLevels(stage(1, r.data(), 1.0f, 0.5f), {0.5f * 0.5f * 0.75f},
                   "a pair into a mono device: equal halves at the fader, "
                   "unpanned");
      expectLevels(stage(1, nullptr, -1.0f, 0.5f), {0.25f},
                   "mono into a mono device: the fader alone");
      expectLevels(stage(4, r.data(), 1.0f, 0.5f), {0.0f, 0.125f, 0.25f, 0.25f},
                   "past the pair: the left at the fader, unpanned");
      expectLevels(stage(2, nullptr, 0.0f, 1.0f, /*floor=*/1.0f), {1.5f, 1.5f},
                   "summed into the parent's signal, not written over it");
      expectLevels(stage(2, nullptr, 0.0f, 0.0f, /*floor=*/1.0f), {1.0f, 1.0f},
                   "a zero fader adds nothing");
      expectLevels(stage(2, r.data(), 0.0f, 1.0f, /*floor=*/0.0f,
                         /*null_channel=*/0),
                   {0.0f, 0.25f}, "a null channel is skipped");
    }

    beginTest("A group's channels past the stereo pair carry its channel-0 "
              "sum at the fader, like a clip's");
    {
      // The child is hard LEFT, so the group's right channel is silent;
      // outputs 3 and 4 still carry the left sum, scaled by the fader.
      StackNode stack("WideStack");
      auto clip = committedClip("Child", sr, len, 0.5f);
      clip->pan.store(-1.0f);
      stack.addChild(std::move(clip));
      stack.gain.store(0.5f);  // off unity: the group's own output stage
      constexpr int n = 441;
      constexpr int channels = 4;
      std::vector<float> out[channels];
      float* outs[channels];
      for (int ch = 0; ch < channels; ++ch) {
        out[ch].assign((size_t)n, 0.0f);
        outs[ch] = out[ch].data();
      }
      NodeContext play = contextFor(stack, n);
      play.ctx.is_playing = true;
      stack.process(nullptr, outs, 0, channels, play.ctx);
      expectWithinAbsoluteError(out[0][100], 0.25f, 1.0e-6f,
                                "L = amp * group gain");
      expectEquals(out[1][100], 0.0f, "R silent (the child is hard left)");
      expectWithinAbsoluteError(out[2][100], 0.25f, 1.0e-6f,
                                "output 3 = channel 0 at the fader");
      expectWithinAbsoluteError(out[3][100], 0.25f, 1.0e-6f,
                                "output 4 = channel 0 at the fader");
    }
  }
};

static OutputStageTests outputStageTests;

}  // namespace celestrian
