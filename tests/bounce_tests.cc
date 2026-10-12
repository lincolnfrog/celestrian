/**
 * BOUNCE tests (Q19, docs/bounce.md): the bounce IS the live render,
 * offline.
 *
 * The golden drives a ramp-input take through the real device callback
 * (every recorded sample encodes its own index: test_utils.h
 * EngineRig), bounces the root, then drives the LIVE callback from the
 * same frame top over the same cycle and asserts the WAV equals the
 * speakers sample for sample. Around it: a windowed group spans exactly
 * its effective period, a live take refuses the bounce, an echo tail
 * rings past the span and ends under the −90 dBFS floor, and a loop
 * bounced from its top - or from any named start - is its own pass,
 * rotated.
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <optional>

#include "../src/audio_engine.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace {

using celestrian::test_utils::addNode;
using celestrian::test_utils::clipOf;
using celestrian::test_utils::deepProp;
using celestrian::test_utils::EngineRig;
using celestrian::test_utils::findVar;
using celestrian::test_utils::mod;
using celestrian::test_utils::readWav;
using celestrian::test_utils::RigInput;
using celestrian::test_utils::rootId;
using celestrian::test_utils::rootProp;

const int BLOCK = EngineRig::BLOCK;
/** The tail floor the engine closes a bounce on (docs/bounce.md). */
const float TAIL_FLOOR = 3.1623e-5f;

/** The slot uuid of the first `type` slot on a node's published chain. */
juce::String slotIdOf(AudioEngine& e, const juce::String& uuid,
                      const juce::String& type) {
  const juce::var chain = findVar(e.getGraphState(), uuid)
                              .getProperty("effects", juce::var())
                              .getProperty("chain", juce::var());
  if (auto* entries = chain.getArray())
    for (const auto& entry : *entries)
      if (entry.getProperty("type", "").toString() == type)
        return entry.getProperty("slot", "").toString();
  return {};
}

float peakOf(const juce::AudioBuffer<float>& audio, int start, int n) {
  float peak = 0.0f;
  for (int ch = 0; ch < audio.getNumChannels(); ++ch)
    peak = std::max(peak, audio.getMagnitude(ch, start, n));
  return peak;
}

/** Samples, on either side, where one pass of `file` is not `pass`
 * rotated by `shift`: file[i] against pass[(i + shift) mod span]. The
 * ramp steps 1.9e-7 a sample and the tolerance sits under one step, so
 * a render one sample out of place counts; a buffer shorter than the
 * pass fails whole. */
int passErrors(const juce::AudioBuffer<float>& file,
               const juce::AudioBuffer<float>& pass, int64_t span,
               int64_t shift = 0) {
  if (file.getNumSamples() < span || pass.getNumSamples() < span) {
    return (int)(2 * span);
  }
  int bad = 0;
  for (int64_t i = 0; i < span; ++i) {
    for (int ch = 0; ch < 2; ++ch) {
      if (std::abs(file.getSample(ch, (int)i) -
                   pass.getSample(ch, (int)mod(i + shift, span))) > 1e-7f) {
        ++bad;
      }
    }
  }
  return bad;
}

}  // namespace

class BounceTests : public juce::UnitTest {
 public:
  BounceTests() : juce::UnitTest("Bounce (Q19)") {}

  /** Bounces `id` to `name` in the test's folder - from `start` when
   * given - and answers the file's audio; the bounce must succeed. */
  juce::AudioBuffer<float> bounced(AudioEngine& engine, const juce::String& id,
                                   const juce::String& name,
                                   const juce::String& what,
                                   std::optional<int64_t> start = std::nullopt,
                                   double* rate = nullptr) {
    const juce::File wav = dir.getChildFile(name);
    expect(engine.bounce(id, wav.getFullPathName(), start), what);
    return readWav(wav, rate);
  }

  /** One `span` of the live callback, the input silent, from the next
   * moment the transport stands at `top` (mod span). */
  juce::AudioBuffer<float> liveFrom(EngineRig& rig, int64_t top, int64_t span,
                                    const juce::String& what) {
    rig.drive(mod(top - rig.clock, span), nullptr, RigInput::Silence);
    expectEquals(mod(rig.engine.transportClock() - top, span), (int64_t)0,
                 what);
    const EngineRig::Heard heard = rig.hear(span, RigInput::Silence);
    juce::AudioBuffer<float> live(2, (int)span);
    live.copyFrom(0, 0, heard.left.data(), (int)span);
    live.copyFrom(1, 0, heard.right.data(), (int)span);
    return live;
  }

  void runTest() override {
    const int64_t D = 40000;  // one take, under 1 s at 44.1k
    dir = celestrian::test_utils::freshTempDir("bounce");

    beginTest("GOLDEN: the bounced root equals the live render of one cycle");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String stack_id = addNode(engine, "stack");
      const juce::String left_id = addNode(engine, "clip", stack_id);
      const juce::String right_id = addNode(engine, "clip", stack_id);
      rig.record(stack_id, D);
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      // A little stereo: one member left, one right, so both channels
      // carry distinct content.
      engine.setNodePan(left_id, -0.6);
      engine.setNodePan(right_id, 0.4);

      double rate = 0.0;
      const juce::AudioBuffer<float> file =
          bounced(engine, rootId(engine), "song.wav",
                  "bounce of the root succeeds", std::nullopt, &rate);
      expectEquals(file.getNumChannels(), 2, "stereo");
      expectEquals(rate, 44100.0, "the device rate");
      const int64_t span = D;  // effective cycle = Q = D
      expect(file.getNumSamples() >= span, "the file covers the span");

      // The live twin: one cycle through the device callback from the
      // bounce's frame top, the zero.
      const juce::AudioBuffer<float> live = liveFrom(
          rig, rootProp(engine, "islandZero"), span, "at the cycle top");
      expectEquals(passErrors(file, live, span), 0,
                   "bounce == live render, sample for sample");
      expect(peakOf(file, 0, (int)span) > 0.05f,
             "the render carries the take (not silence)");
      const int tail = file.getNumSamples() - (int)span;
      expect(tail == 0 || peakOf(file, (int)span, tail) < TAIL_FLOOR,
             "nothing rings past the span without effects");

      // A live take refuses the bounce: no render, no file.
      const juce::String armed = addNode(engine, "clip");
      engine.startRecordingInNode(armed);
      const juce::File refused = dir.getChildFile("refused.wav");
      expect(!engine.bounce(rootId(engine), refused.getFullPathName()),
             "refused while a take is armed");
      rig.drive(BLOCK, nullptr, RigInput::Silence);  // capture rolls
      expect(!engine.bounce(rootId(engine), refused.getFullPathName()),
             "refused while a take is recording");
      expect(!refused.exists(), "a refused bounce writes no file");
      engine.stopRecordingInNode(armed);
    }

    beginTest("A windowed group spans exactly its effective period");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String stack_id = addNode(engine, "stack");
      addNode(engine, "clip", stack_id);
      addNode(engine, "clip", stack_id);
      rig.record(stack_id, D);
      const int64_t ws = D / 4, we = (3 * D) / 4;
      engine.setLoopPoints(stack_id, ws, we);
      const celestrian::AudioNode* node = engine.findNodeByUuidForTest(stack_id);
      expect(node != nullptr, "the group exists");
      const int64_t period = celestrian::period_law::ownPeriodOf(*node);
      expectEquals(period, we - ws, "effective period = the window");

      const juce::AudioBuffer<float> file = bounced(
          engine, stack_id, "group.wav", "bounce of the group succeeds");
      expectEquals((int64_t)file.getNumSamples(), period,
                   "the file is one effective period, no tail");
      expect(peakOf(file, 0, (int)period) > 0.05f, "the window's content");
    }

    // One frame-top law for every node: the root is never anchored, so
    // its frame top is the zero, plus a0 under a root window. The bounce
    // starts where the window starts, not where the island cycle wraps
    // (from the zero, a [D/4, 3D/4) window would open 3D/4 in: inside
    // the rest, silent).
    beginTest("GOLDEN: a windowed ROOT bounces from its window top (zero + a0)");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      rig.recordClip(D);
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      // A root window [D/4, 3D/4): period D/2 divides Q (coherent),
      // a0 = D/4; the island cycle stays lcm(Q, D/2) = D.
      engine.setLoopPoints(rootId(engine), D / 4, (3 * D) / 4);
      expectEquals(rootProp(engine, "loopStart"), D / 4, "the root window holds");

      const juce::AudioBuffer<float> file =
          bounced(engine, rootId(engine), "root_window.wav",
                  "bounce of the windowed root succeeds");
      const int64_t span = D;  // one effective island cycle
      expect(file.getNumSamples() >= span, "the file covers the cycle");
      const juce::AudioBuffer<float> live =
          liveFrom(rig, rootProp(engine, "islandZero") + D / 4, span,
                   "at the window top");
      expectEquals(passErrors(file, live, span), 0,
                   "bounce == live render from the window top");
      expect(file.getMagnitude(0, 0, (int)(D / 8)) > 0.05f,
             "the file OPENS with the window's content (not the rest)");
    }

    beginTest("Refused with no committed content");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      engine.createNode("clip");
      const juce::File wav = dir.getChildFile("empty.wav");
      expect(!engine.bounce(rootId(engine), wav.getFullPathName()),
             "an empty island has nothing to bounce");
      expect(!wav.exists(), "no file");
      expect(!engine.bounce("no-such-node", wav.getFullPathName()),
             "an unknown node is refused");
    }

    beginTest("Refused past the span cap (the take ceiling)");
    {
      // The render buffer is sized from the span: a saturated lcm or a
      // merely huge effective period must be refused before any
      // allocation, exactly where the arm path caps the same quantity.
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      auto* clip = clipOf(engine, id);
      expect(clip != nullptr, "clip found");
      if (clip != nullptr) {
        // The clip's effective period is its intrinsic duration: stamp
        // one past the ceiling (no buffer is allocated for it).
        clip->duration_samples.store(celestrian::ClipNode::kMaxTakeSamples + 1);
        const juce::File wav = dir.getChildFile("huge.wav");
        expect(!engine.bounce(id, wav.getFullPathName()),
               "a span past kMaxTakeSamples is refused");
        expect(!wav.exists(), "no file");
        clip->duration_samples.store(0);
      }
    }

    beginTest("TAIL: an echo rings past the span and ends under -90 dBFS");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String clip_id = rig.recordClip(D);
      const juce::String echo = slotIdOf(engine, clip_id, "echo");
      expect(echo.isNotEmpty(), "the clip's chain carries an echo slot");
      engine.setSlotEnabled(clip_id, echo, true);

      const juce::AudioBuffer<float> file = bounced(
          engine, clip_id, "echo.wav", "bounce of the clip succeeds");
      const int n = file.getNumSamples();
      expect(n > (int)D, "the file is longer than the span (the tail)");
      expect(n - (int)D < 44100 * 10, "the tail closes before the cap");
      expect(peakOf(file, (int)D, std::min(n - (int)D, BLOCK)) >= TAIL_FLOOR,
             "the tail rings right after the span");
      const int last = std::min(n, BLOCK);
      expect(peakOf(file, n - last, last) < TAIL_FLOOR,
             "the last block is under the floor");
    }

    // The loop top (loop_selection.md §9): "Bounce selected…" opens on
    // the loop's one — its top's moment — not on the splice, for a clip
    // and for a group alike (the top lives on AudioNode). The loop is
    // periodic, so the topped file is the plain one rotated by the top's
    // heard offset, sample for sample (the ramp take makes every sample
    // distinct).
    beginTest("A clip and a group each bounce from their (top), not from "
              "the splice");
    for (const bool group : {false, true}) {
      const juce::String tag = group ? "group" : "clip";
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      rig.recordClip(D);  // Q := D
      const juce::String id = addNode(engine, group ? "stack" : "clip");
      if (group) {
        addNode(engine, "clip", id);
        addNode(engine, "clip", id);
      }
      rig.record(id, 5 * D);
      engine.setLoopPoints(id, D, 3 * D);  // loop [1Q, 3Q): one pass is 2Q
      const int64_t span = 2 * D;
      const celestrian::AudioNode* node = engine.findNodeByUuidForTest(id);
      expect(node != nullptr && node->isAnchored(), tag + ": anchored");
      expectEquals(celestrian::period_law::ownPeriodOf(*node), span,
                   tag + ": one pass of its loop");

      const juce::AudioBuffer<float> plain = bounced(
          engine, id, tag + "_plain.wav", tag + ": bounce, top unset");
      const int64_t h = D / 2;  // the top half a Q into the loop
      engine.setTiming(id, 0, D + h);  // stores the top; moves no audio
      expectEquals(node->effectiveTop(), D + h, tag + ": stores its top");
      const juce::AudioBuffer<float> topped = bounced(
          engine, id, tag + "_topped.wav", tag + ": bounce, top set");
      expectEquals(passErrors(topped, plain, span, h), 0,
                   tag + ": the topped file is the plain one, rotated to "
                         "the (top)");
      expect(peakOf(topped, 0, (int)span) > 0.05f,
             tag + ": the render carries the take");
    }

    // A named start (docs/bounce.md): the app names the start of "Bounce
    // selected…" — the ↺ AS SHOWN, which on a loop that slots into the
    // frame is the FRAME's top: a moment that is not the node's own top,
    // and may lie before the node's origin (the frame is seated from
    // another loop). The render is the kernel equation at absolute time,
    // so one pass from ANY moment is the loop's own pass, rotated — for
    // a window, a cut map and a group.
    beginTest("A named start: one pass from any moment is the loop's pass, rotated");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      rig.recordClip(D);  // Q := D
      const juce::String win = rig.recordClip(5 * D);
      engine.setLoopPoints(win, D, 3 * D);  // a window: [1Q, 3Q)
      const juce::String cut = rig.recordClip(5 * D);
      {
        celestrian::timing::TimeMap m;  // a cut map: [1Q, 2Q) ∪ [3Q, 4Q)
        m.n = 2;
        m.segs[0] = {D, 2 * D};
        m.segs[1] = {3 * D, 4 * D};
        engine.setSegments(cut, m);
      }
      const juce::String grp = addNode(engine, "stack");
      addNode(engine, "clip", grp);
      addNode(engine, "clip", grp);
      rig.record(grp, 5 * D);
      engine.setLoopPoints(grp, D, 3 * D);  // a group's window: [1Q, 3Q)

      const int64_t span = 2 * D;  // each loop's one pass
      int n = 0;
      for (const juce::String& id : {win, cut, grp}) {
        const juce::String tag = "named" + juce::String(n++);
        const int64_t origin = (int64_t)deepProp(engine, id, "origin");
        const int64_t top0 = origin + D;  // origin + a0: the default start
        const juce::AudioBuffer<float> plain =
            bounced(engine, id, tag + "_plain.wav", tag + ": the default");
        expect(plain.getNumSamples() >= span, tag + ": covers one pass");
        expect(peakOf(plain, 0, (int)span) > 0.05f, tag + ": carries the take");
        // Named AT the default start (the same file); later in the
        // pass; whole passes later; before the take began; and before
        // the clock's own zero (a seek moves origins, never the clock,
        // so a frame's top can sit there).
        for (const int64_t k :
             {int64_t{0}, D / 3, 3 * span + D / 3, -(span + D / 4),
              -(origin + 7 * D)}) {
          const juce::AudioBuffer<float> named =
              bounced(engine, id, tag + "_at.wav",
                      tag + ": bounce from a named start", top0 + k);
          expectEquals((int64_t)named.getNumSamples(),
                       (int64_t)plain.getNumSamples(),
                       tag + ": one pass, the same length");
          expectEquals(passErrors(named, plain, span, k), 0,
                       tag + ": the default pass, rotated by " + juce::String(k));
        }
      }
    }

    dir.deleteRecursively();
  }

 private:
  juce::File dir;  // the test's folder of bounced files
};

static BounceTests bounceTests;
