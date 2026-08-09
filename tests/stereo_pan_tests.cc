#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/clip_node.h"
#include "../src/qtime.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

/**
 * Pan + stereo coverage (2026-07 mixing work):
 *  - the balance-law gain function itself,
 *  - a mono clip panned in the render mix,
 *  - two-input stereo capture → per-channel content → stereo render,
 *  - lcm saturation (the composite-fold "reset to 0" overflow hazard).
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

    beginTest("Mono clip panned hard left: right output silent");
    {
      ClipNode clip("PanClip", sr);
      std::vector<float> in(4410, 0.5f);
      float* const ins[] = {in.data()};
      ProcessContext rec;
      rec.num_samples = (int)in.size();
      rec.is_recording = true;
      clip.startRecording();
      clip.process(ins, nullptr, 1, 0, rec);
      clip.stopRecording();

      clip.pan.store(-1.0f);
      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = (int)outL.size();
      play.is_playing = true;
      clip.process(nullptr, outs, 0, 2, play);

      expectWithinAbsoluteError(outL[100], 0.5f, 1.0e-6f, "left carries");
      expectEquals(outR[100], 0.0f, "right silent at hard left");

      // Center pan: both channels at unity (the historical behavior —
      // existing sessions must not change loudness).
      clip.pan.store(0.0f);
      std::fill(outL.begin(), outL.end(), 0.0f);
      std::fill(outR.begin(), outR.end(), 0.0f);
      play.master_pos = 0;
      clip.process(nullptr, outs, 0, 2, play);
      expectWithinAbsoluteError(outL[100], 0.5f, 1.0e-6f, "center L unity");
      expectWithinAbsoluteError(outR[100], 0.5f, 1.0e-6f, "center R unity");
    }

    beginTest("Stereo capture: two inputs land on two content channels");
    {
      ClipNode clip("StereoClip", sr);
      clip.setInputChannel(0);
      clip.setInputChannelRight(1);
      expect(clip.isStereoInput());

      std::vector<float> left(4410, 0.25f), right(4410, 0.75f);
      float* const ins[] = {left.data(), right.data()};
      ProcessContext rec;
      rec.num_samples = (int)left.size();
      rec.is_recording = true;
      clip.startRecording();
      clip.process(ins, nullptr, 2, 0, rec);
      clip.stopRecording();

      expectEquals(clip.contentChannels(), 2, "content is stereo");
      const auto& buf = clip.getAudioBuffer();
      expectWithinAbsoluteError(buf.getSample(0, 100), 0.25f, 1.0e-6f,
                                "channel 0 holds the LEFT input");
      expectWithinAbsoluteError(buf.getSample(1, 100), 0.75f, 1.0e-6f,
                                "channel 1 holds the RIGHT input");

      // Stereo render: L content → out 0, R content → out 1.
      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = (int)outL.size();
      play.is_playing = true;
      clip.process(nullptr, outs, 0, 2, play);
      expectWithinAbsoluteError(outL[100], 0.25f, 1.0e-6f, "L renders L");
      expectWithinAbsoluteError(outR[100], 0.75f, 1.0e-6f, "R renders R");

      // Balance toward the left attenuates only the right channel.
      clip.pan.store(-0.5f);
      std::fill(outL.begin(), outL.end(), 0.0f);
      std::fill(outR.begin(), outR.end(), 0.0f);
      play.master_pos = 0;
      clip.process(nullptr, outs, 0, 2, play);
      expectWithinAbsoluteError(outL[100], 0.25f, 1.0e-6f,
                                "balance left keeps L");
      expectWithinAbsoluteError(outR[100], 0.75f * 0.5f, 1.0e-6f,
                                "balance left halves R");

      // Mono device: stereo content folds to equal halves.
      clip.pan.store(0.0f);
      std::fill(outL.begin(), outL.end(), 0.0f);
      float* mono[] = {outL.data()};
      play.master_pos = 0;
      clip.process(nullptr, mono, 0, 1, play);
      expectWithinAbsoluteError(outL[100], 0.5f * (0.25f + 0.75f), 1.0e-6f,
                                "mono fold is the channel mean");
    }

    beginTest("Mono clip is unaffected by a stale right-input value of 0");
    {
      // A pre-stereo session with inputChannelR defaulted wrongly would
      // arm stereo takes; the loader defaults to −1 — pin the mono path.
      ClipNode clip("MonoClip", sr);
      expect(!clip.isStereoInput());
      clip.startRecording();
      std::vector<float> in(1000, 1.0f);
      float* const ins[] = {in.data()};
      ProcessContext rec;
      rec.num_samples = (int)in.size();
      rec.is_recording = true;
      clip.process(ins, nullptr, 1, 0, rec);
      expectEquals(clip.contentChannels(), 1, "mono capture stays mono");
      clip.stopRecording();
    }

    beginTest("Stack group pan scales the summed children");
    {
      StackNode stack("PanStack");
      auto clip = std::make_unique<ClipNode>("Child", sr);
      std::vector<float> in(4410, 0.5f);
      float* const ins[] = {in.data()};
      ProcessContext rec;
      rec.num_samples = (int)in.size();
      rec.is_recording = true;
      clip->startRecording();
      clip->process(ins, nullptr, 1, 0, rec);
      clip->stopRecording();
      ClipNode* raw = clip.get();
      stack.addChild(std::move(clip));
      raw->startPlayback();

      stack.pan.store(1.0f);  // hard right
      std::vector<float> outL(4410, 0.0f), outR(4410, 0.0f);
      float* outs[] = {outL.data(), outR.data()};
      ProcessContext play;
      play.num_samples = (int)outL.size();
      play.is_playing = true;
      stack.process(nullptr, outs, 0, 2, play);
      expectEquals(outL[100], 0.0f, "group hard right silences L");
      expectWithinAbsoluteError(outR[100], 0.5f, 1.0e-6f,
                                "group hard right keeps R");
    }

    beginTest("Session round-trip: pan, stereo wiring, stereo audio");
    {
      const int64_t Q = 48000;
      StackNode root("SessionRoot");
      root.setQuantum(Q, 0);

      auto clip = std::make_unique<ClipNode>("Overheads", (double)Q);
      clip->duration_samples.store(Q);
      clip->setInputChannel(2);
      clip->setInputChannelRight(3);
      clip->pan.store(-0.25f);
      // Distinct L/R ramps pin per-channel WAV fidelity.
      juce::AudioBuffer<float> audio(2, (int)Q);
      for (int i = 0; i < (int)Q; ++i) {
        audio.setSample(0, i, std::sin((float)i * 0.001f));
        audio.setSample(1, i, std::cos((float)i * 0.002f));
      }
      clip->loadCommitted(audio, 0);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto group = std::make_unique<StackNode>("Kit");
      group->pan.store(0.5f);
      const juce::String groupUuid = group->getUuid();
      root.addChild(std::move(group));

      auto dir = test_utils::freshTempDir("stereo_pan");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");

      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr, "clip restored");
      expectEquals(c->getInputChannel(), 2, "left input restored");
      expectEquals(c->getInputChannelRight(), 3, "right input restored");
      expectWithinAbsoluteError(c->pan.load(), -0.25f, 1.0e-6f,
                                "clip pan restored");
      expectEquals(c->contentChannels(), 2, "stereo content restored");
      const auto& rb = c->getAudioBuffer();
      float maxErr = 0.0f;
      for (int i = 0; i < 200; ++i) {
        maxErr = std::max(maxErr,
                          std::abs(rb.getSample(0, i) - audio.getSample(0, i)));
        maxErr = std::max(maxErr,
                          std::abs(rb.getSample(1, i) - audio.getSample(1, i)));
      }
      expect(maxErr < 1.0e-6f, "stereo audio lossless (32-bit float wav)");

      auto* g = dynamic_cast<StackNode*>(loaded.children[1].get());
      expect(g != nullptr && g->getUuid() == groupUuid, "group restored");
      expectWithinAbsoluteError(g->pan.load(), 0.5f, 1.0e-6f,
                                "group pan restored");

      // A pre-stereo session (no inputChannelR key) loads as MONO.
      auto jf = dir.getChildFile("session.json");
      auto parsed = juce::JSON::parse(jf.loadFileAsString());
      auto* clipObj = parsed.getProperty("nodes", {})[0].getDynamicObject();
      expect(clipObj != nullptr && clipObj->hasProperty("inputChannelR"),
             "key was present to strip");
      clipObj->removeProperty("inputChannelR");
      jf.replaceWithText(juce::JSON::toString(parsed, true));
      auto legacy = session_io::load(dir, (double)Q);
      auto* lc = dynamic_cast<ClipNode*>(legacy.children[0].get());
      expect(lc != nullptr, "legacy clip loads");
      expectEquals(lc->getInputChannelRight(), -1,
                   "absent inputChannelR defaults to mono");
      dir.deleteRecursively();
    }

    beginTest("lcm saturates instead of overflowing to 0/negative");
    {
      const int64_t big = (int64_t{1} << 62) + 12345;
      const int64_t coprime = 3;
      const int64_t l = timing::lcm(big, coprime);
      expect(l > 0, "no wrap to negative");
      expectEquals(l, std::numeric_limits<int64_t>::max(), "saturated");
      // The composite fold treats 0 as "empty": saturation must never
      // return 0 for positive inputs.
      expect(timing::lcm(big, big - 1) != 0, "never 0 for positive inputs");
      // Sanity on the normal path.
      expectEquals(timing::lcm(6, 4), (int64_t)12);
      expectEquals(timing::lcm(0, 7), (int64_t)7);
    }
  }
};

static StereoPanTests stereoPanTests;

}  // namespace celestrian
