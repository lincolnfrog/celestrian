#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** A committed clip carrying a constant-amplitude take, already playing. */
std::unique_ptr<ClipNode> makePlayingClip(const char* name, double sr,
                                          float amp, int len = 4410) {
  auto clip = std::make_unique<ClipNode>(name, sr);
  std::vector<float> in((size_t)len, amp);
  float* const ins[] = {in.data()};
  ProcessContext rec;
  rec.num_samples = len;
  rec.is_recording = true;
  clip->startRecording();
  clip->process(ins, nullptr, 1, 0, rec);
  clip->stopRecording();
  clip->startPlayback();
  return clip;
}

/** Peak absolute sample over both channels after one rendered block. */
float renderPeak(AudioNode& node, int n = 4410, int64_t master_pos = 0) {
  std::vector<float> outL((size_t)n, 0.0f), outR((size_t)n, 0.0f);
  float* outs[] = {outL.data(), outR.data()};
  ProcessContext play;
  play.num_samples = n;
  play.is_playing = true;
  play.master_pos = master_pos;
  node.process(nullptr, outs, 0, 2, play);
  float peak = 0.0f;
  for (int i = 0; i < n; ++i) {
    peak = std::max(
        peak, std::max(std::abs(outL[(size_t)i]), std::abs(outR[(size_t)i])));
  }
  return peak;
}

}  // namespace

/**
 * The fractal output stage (unification_audit.md §2.4): every node's
 * signal reaches its parent through one resolution — render/sum →
 * time-map → fx → gain·pan → parent, with mute AS gain 0 at that
 * stage. Pins:
 *  - D1 (audit §3, High): muting a STACK now silences the group,
 *  - the gain fader on clips and stacks (and its combination with pan),
 *  - mute-beats-solo at the container,
 *  - persistence: gain round-trips; absent key loads as unity.
 */
class OutputStageTests : public juce::UnitTest {
 public:
  OutputStageTests() : juce::UnitTest("Output Stage", "Audio Engine") {}

  void runTest() override {
    constexpr double sr = 44100.0;

    beginTest("D1: muting a stack silences the group (and unmute restores)");
    {
      StackNode stack("MuteStack");
      stack.addChild(makePlayingClip("Child", sr, 0.5f));

      expectWithinAbsoluteError(renderPeak(stack), 0.5f, 1.0e-6f,
                                "unmuted group audible");
      stack.is_muted.store(true);
      expectEquals(renderPeak(stack), 0.0f, "muted group SILENT (was D1)");
      stack.is_muted.store(false);
      expectWithinAbsoluteError(renderPeak(stack), 0.5f, 1.0e-6f,
                                "unmute restores the group");
    }

    beginTest("Muting an inner group silences only its subtree");
    {
      StackNode root("Root");
      root.addChild(makePlayingClip("Direct", sr, 0.25f));
      auto group = std::make_unique<StackNode>("Inner");
      group->addChild(makePlayingClip("Grouped", sr, 0.5f));
      StackNode* inner = group.get();
      root.addChild(std::move(group));

      expectWithinAbsoluteError(renderPeak(root), 0.75f, 1.0e-6f,
                                "both subtrees sum");
      inner->is_muted.store(true);
      expectWithinAbsoluteError(renderPeak(root), 0.25f, 1.0e-6f,
                                "only the direct clip remains");
    }

    beginTest("Mute keeps child telemetry flowing (children still render)");
    {
      StackNode stack("TelemetryStack");
      auto clip = makePlayingClip("Child", sr, 0.5f);
      ClipNode* raw = clip.get();
      stack.addChild(std::move(clip));
      stack.is_muted.store(true);
      // Render mid-take: the playhead phase is a render output — a muted
      // group must not freeze its children's cursors (the output stage
      // gates the SUM, not the render).
      renderPeak(stack, 441, /*master_pos=*/2205);
      expectWithinAbsoluteError(raw->playhead_pos.load(), 2205.0 / 4410.0,
                                1.0e-6, "child playhead advanced under mute");
    }

    beginTest("Gain scales a clip; combines with pan");
    {
      auto clip = makePlayingClip("Faded", sr, 0.5f);
      clip->gain.store(0.5f);
      expectWithinAbsoluteError(renderPeak(*clip), 0.25f, 1.0e-6f,
                                "half fader halves the output");

      // Hard left at half fader: L = amp·gain, R = 0.
      clip->pan.store(-1.0f);
      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = 4410;
      play.is_playing = true;
      clip->process(nullptr, outs, 0, 2, play);
      expectWithinAbsoluteError(outL[100], 0.25f, 1.0e-6f, "L = amp*gain");
      expectEquals(outR[100], 0.0f, "R silent at hard left");

      clip->gain.store(0.0f);
      expectEquals(renderPeak(*clip), 0.0f, "zero fader is silent");
    }

    beginTest("Gain scales a stack's summed children");
    {
      StackNode stack("FadedStack");
      stack.addChild(makePlayingClip("Child", sr, 0.5f));
      stack.gain.store(0.5f);
      expectWithinAbsoluteError(renderPeak(stack), 0.25f, 1.0e-6f,
                                "group fader scales the sum");
      // Fader combines with group pan: hard right keeps R at gain·amp,
      // silences L entirely.
      stack.pan.store(1.0f);
      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = 4410;
      play.is_playing = true;
      stack.process(nullptr, outs, 0, 2, play);
      expectEquals(outL[100], 0.0f, "group hard right silences L");
      expectWithinAbsoluteError(outR[100], 0.25f, 1.0e-6f,
                                "R carries gain*amp");
    }

    beginTest("Container mute beats a soloed child");
    {
      StackNode stack("MutedSoloHost");
      auto clip = makePlayingClip("Soloed", sr, 0.5f);
      ClipNode* raw = clip.get();
      stack.addChild(std::move(clip));
      stack.is_muted.store(true);

      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = 4410;
      play.is_playing = true;
      // Q16 flags: the child itself is soloed, and the context knows a
      // solo is lit somewhere.
      raw->is_soloed.store(true);
      play.any_solo = true;
      stack.process(nullptr, outs, 0, 2, play);
      expectEquals(std::abs(outL[100]) + std::abs(outR[100]), 0.0f,
                   "muted ancestor silences even a soloed child");
    }

    beginTest("Session round-trip: gain persists; absent key loads unity");
    {
      const int64_t Q = 48000;
      StackNode root("GainSession");
      root.setQuantum(Q, 0);

      auto clip = std::make_unique<ClipNode>("Faded", (double)Q);
      clip->duration_samples.store(Q);
      juce::AudioBuffer<float> audio(1, (int)Q);
      for (int i = 0; i < (int)Q; ++i)
        audio.setSample(0, i, std::sin((float)i * 0.001f));
      clip->loadCommitted(audio, 0);
      clip->gain.store(0.6f);
      root.addChild(std::move(clip));

      auto group = std::make_unique<StackNode>("FadedKit");
      group->gain.store(0.3f);
      root.addChild(std::move(group));

      auto dir = test_utils::freshTempDir("output_stage");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");
      expectWithinAbsoluteError(loaded.children[0]->gain.load(), 0.6f, 1.0e-6f,
                                "clip gain restored");
      expectWithinAbsoluteError(loaded.children[1]->gain.load(), 0.3f, 1.0e-6f,
                                "group gain restored");

      // A pre-gain session (no `gain` key) must load at UNITY — the
      // absent-property var reads as 0.0, which would load it silent.
      auto jf = dir.getChildFile("session.json");
      auto parsed = juce::JSON::parse(jf.loadFileAsString());
      auto* clipObj = parsed.getProperty("nodes", {})[0].getDynamicObject();
      expect(clipObj != nullptr && clipObj->hasProperty("gain"),
             "key was present to strip");
      clipObj->removeProperty("gain");
      jf.replaceWithText(juce::JSON::toString(parsed, true));
      auto legacy = session_io::load(dir, (double)Q);
      expect(legacy.ok, "legacy load ok");
      expectWithinAbsoluteError(legacy.children[0]->gain.load(), 1.0f, 1.0e-6f,
                                "absent gain defaults to unity");
      dir.deleteRecursively();
    }
  }
};

static OutputStageTests outputStageTests;

}  // namespace celestrian
