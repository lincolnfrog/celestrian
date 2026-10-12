#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

/**
 * Pan + stereo coverage:
 *  - the balance-law gain function itself,
 *  - two-input stereo capture → per-channel content → stereo render.
 * Pan in the render mix of a mono clip and of a group is
 * output_stage_tests.cc's; the persistence of pan, the stereo wiring
 * and the stereo audio is session_io_tests.cc's.
 */
class StereoPanTests : public juce::UnitTest {
 public:
  StereoPanTests() : juce::UnitTest("Stereo & Pan", "Audio Engine") {}

  void runTest() override {
    constexpr double sr = 44100.0;

    beginTest("panGains: balance law (center unity, far side attenuates)");
    {
      float gl = 0, gr = 0;
      panGains(0.0f, gl, gr);
      expectEquals(gl, 1.0f);
      expectEquals(gr, 1.0f);
      panGains(-1.0f, gl, gr);  // hard left
      expectEquals(gl, 1.0f);
      expectEquals(gr, 0.0f);
      panGains(1.0f, gl, gr);  // hard right
      expectEquals(gl, 0.0f);
      expectEquals(gr, 1.0f);
      panGains(0.5f, gl, gr);  // half right: L attenuates, R untouched
      expectEquals(gl, 0.5f);
      expectEquals(gr, 1.0f);
      panGains(-7.0f, gl, gr);  // out-of-range input clamps
      expectEquals(gl, 1.0f);
      expectEquals(gr, 0.0f);
    }

    beginTest("Stereo capture: two inputs land on two content channels; "
              "with no right input the take is mono");
    {
      auto mono_clip = test_utils::committedClip("MonoClip", sr, 1000, 1.0f);
      expect(!mono_clip->isStereoInput(), "a fresh clip has no right input");
      expectEquals(mono_clip->contentChannels(), 1, "mono capture stays mono");

      ClipNode clip("StereoClip", sr);
      clip.setInputChannel(0);
      clip.setInputChannelRight(1);
      expect(clip.isStereoInput());

      std::vector<float> left(4410, 0.25f), right(4410, 0.75f);
      float* const ins[] = {left.data(), right.data()};
      NodeContext rec = contextFor(clip, (int)left.size());
      clip.startRecording();
      clip.process(ins, nullptr, 2, 0, rec.ctx);
      test_utils::stopAtBlockTop(clip, rec.ctx);

      expectEquals(clip.contentChannels(), 2, "content is stereo");
      const auto& buf = clip.getAudioBuffer();
      expectWithinAbsoluteError(buf.getSample(0, 100), 0.25f, 1.0e-6f,
                                "channel 0 holds the LEFT input");
      expectWithinAbsoluteError(buf.getSample(1, 100), 0.75f, 1.0e-6f,
                                "channel 1 holds the RIGHT input");

      // Stereo render: L content → out 0, R content → out 1.
      test_utils::StereoBlock out = test_utils::renderBlock(clip, 4410);
      expectWithinAbsoluteError(out.left[100], 0.25f, 1.0e-6f, "L renders L");
      expectWithinAbsoluteError(out.right[100], 0.75f, 1.0e-6f,
                                "R renders R");

      // Balance toward the left attenuates only the right channel.
      clip.pan.store(-0.5f);
      out = test_utils::renderBlock(clip, 4410);
      expectWithinAbsoluteError(out.left[100], 0.25f, 1.0e-6f,
                                "balance left keeps L");
      expectWithinAbsoluteError(out.right[100], 0.75f * 0.5f, 1.0e-6f,
                                "balance left halves R");

      // Mono device: stereo content folds to equal halves.
      clip.pan.store(0.0f);
      std::vector<float> fold(4410, 0.0f);
      float* mono[] = {fold.data()};
      NodeContext play = contextFor(clip, (int)fold.size());
      play.ctx.is_playing = true;
      clip.process(nullptr, mono, 0, 1, play.ctx);
      expectWithinAbsoluteError(fold[100], 0.5f * (0.25f + 0.75f), 1.0e-6f,
                                "mono fold is the channel mean");
    }
  }
};

static StereoPanTests stereoPanTests;

}  // namespace celestrian
