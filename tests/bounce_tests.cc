/**
 * BOUNCE tests (Q19, docs/bounce.md): the bounce IS the live render,
 * offline.
 *
 * The golden drives a ramp-input take through the real device callback
 * (every recorded sample encodes its own index — the content-frame
 * method, tests/content_frame_tests.cc), bounces the root, then drives
 * the LIVE callback from the same frame top over the same cycle and
 * asserts the WAV equals the speakers sample for sample. Around it: a
 * windowed group spans exactly its effective period, a live take
 * refuses the bounce, and an echo tail rings past the span and ends
 * under the −90 dBFS floor.
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/stack_node.h"
#include "test_utils.h"

using celestrian::test_utils::freshTempDir;
using celestrian::test_utils::nodesOf;

namespace {

const int BLOCK = 512;
const int64_t RAMP_P = int64_t{1} << 22;  // longer than any take here
/** The tail floor the engine closes a bounce on (docs/bounce.md). */
const float TAIL_FLOOR = 3.1623e-5f;

float rampAt(int64_t clock) {
  return 0.1f + 0.8f * (float)((double)(clock % RAMP_P) / (double)RAMP_P);
}

/** Drives `total` samples through the live callback — ramp input, or
 * silence — appending both output channels when `left`/`right` are
 * given. `clock` mirrors the engine's monotonic transport. */
void driveLive(AudioEngine& engine, int64_t total, int64_t& clock,
               bool ramp_input, std::vector<float>* left = nullptr,
               std::vector<float>* right = nullptr) {
  std::vector<float> in((size_t)BLOCK), l((size_t)BLOCK), r((size_t)BLOCK);
  float* ins[] = {in.data()};
  float* outs[] = {l.data(), r.data()};
  int64_t remaining = total;
  while (remaining > 0) {
    const int n = (int)std::min<int64_t>(remaining, BLOCK);
    for (int i = 0; i < n; ++i)
      in[(size_t)i] = ramp_input ? rampAt(clock + i) : 0.0f;
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
    if (left != nullptr) left->insert(left->end(), l.begin(), l.begin() + n);
    if (right != nullptr)
      right->insert(right->end(), r.begin(), r.begin() + n);
    clock += n;
    remaining -= n;
  }
}

juce::var findVar(const juce::var& node, const juce::String& id) {
  if (node.getProperty("id", "").toString() == id) return node;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) {
      juce::var hit = findVar(k, id);
      if (!hit.isVoid()) return hit;
    }
  return {};
}
void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
  if (node.getProperty("type", "").toString() == "clip") {
    out.add(node.getProperty("id", "").toString());
    return;
  }
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) clipIdsUnder(k, out);
}
juce::String lastTopLevelId(AudioEngine& e) {
  const juce::var state = e.getGraphState();
  auto* nodes = nodesOf(state);
  if (nodes == nullptr || nodes->isEmpty()) return {};
  return nodes->getLast().getProperty("id", "").toString();
}
juce::String rootId(AudioEngine& e) {
  return e.getGraphState().getProperty("id", "").toString();
}
int64_t rootProp(AudioEngine& e, const char* prop) {
  return (int64_t)(double)e.getGraphState().getProperty(prop, 0);
}
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
int64_t mod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

/** Reads a WAV whole; an empty buffer when the file cannot be read. */
juce::AudioBuffer<float> readWav(const juce::File& file, double* rate_out) {
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(file.createInputStream().release(), true));
  if (reader == nullptr) return {};
  if (rate_out != nullptr) *rate_out = reader->sampleRate;
  juce::AudioBuffer<float> audio((int)reader->numChannels,
                                 (int)reader->lengthInSamples);
  reader->read(&audio, 0, (int)reader->lengthInSamples, 0, true, true);
  return audio;
}

float peakOf(const juce::AudioBuffer<float>& audio, int start, int n) {
  float peak = 0.0f;
  for (int ch = 0; ch < audio.getNumChannels(); ++ch)
    peak = std::max(peak, audio.getMagnitude(ch, start, n));
  return peak;
}

/** Records one ramp take of `D` samples on `target` (a clip or a
 * group); returns with the take committed and one block settled. */
void recordTake(AudioEngine& engine, const juce::String& target, int64_t D,
                int64_t& clock) {
  engine.startRecordingInNode(target);
  driveLive(engine, D, clock, /*ramp_input=*/true);
  engine.stopRecordingInNode(target);  // first take: immediate commit
  driveLive(engine, BLOCK, clock, /*ramp_input=*/true);
  // Mirror the engine clock exactly from here on.
  clock = rootProp(engine, "islandPos") + rootProp(engine, "islandZero");
}

}  // namespace

class BounceTests : public juce::UnitTest {
 public:
  BounceTests() : juce::UnitTest("Bounce (Q19)") {}

  void runTest() override {
    const int64_t D = 40000;  // one take, under 1 s at 44.1k
    const juce::File dir = freshTempDir("bounce");

    beginTest("GOLDEN: the bounced root equals the live render of one cycle");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray ids;
      clipIdsUnder(findVar(engine.getGraphState(), stack_id), ids);
      recordTake(engine, stack_id, D, clock);
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      // A little stereo: one member left, one right, so both channels
      // carry distinct content.
      engine.setNodePan(ids[0], -0.6);
      engine.setNodePan(ids[1], 0.4);

      const juce::File wav = dir.getChildFile("song.wav");
      expect(engine.bounce(rootId(engine), wav.getFullPathName()),
             "bounce of the root succeeds");
      double rate = 0.0;
      const juce::AudioBuffer<float> file = readWav(wav, &rate);
      expectEquals(file.getNumChannels(), 2, "stereo");
      expectEquals(rate, 44100.0, "the device rate");
      const int64_t span = D;  // effective cycle = Q = D
      expect(file.getNumSamples() >= span, "the file covers the span");

      // The live twin: from a clock ≡ zero (the bounce's frame top),
      // one cycle through the device callback.
      const int64_t zero = rootProp(engine, "islandZero");
      driveLive(engine, mod(zero - clock, span), clock, false);
      expectEquals(mod(clock - zero, span), (int64_t)0, "at the cycle top");
      std::vector<float> live_l, live_r;
      driveLive(engine, span, clock, false, &live_l, &live_r);

      int bad = 0;
      float loud = 0.0f;
      for (int64_t i = 0; i < span; ++i) {
        const float l = file.getSample(0, (int)i);
        const float r = file.getSample(1, (int)i);
        if (std::abs(l - live_l[(size_t)i]) > 1e-6f) ++bad;
        if (std::abs(r - live_r[(size_t)i]) > 1e-6f) ++bad;
        loud = std::max(loud, std::max(std::abs(l), std::abs(r)));
      }
      expectEquals(bad, 0, "bounce == live render, sample for sample");
      expect(loud > 0.05f, "the render carries the take (not silence)");
      const int tail = file.getNumSamples() - (int)span;
      expect(tail == 0 || peakOf(file, (int)span, tail) < TAIL_FLOOR,
             "nothing rings past the span without effects");

      // (c) A live take refuses the bounce: no render, no file.
      engine.createNode("clip");
      const juce::String armed = lastTopLevelId(engine);
      engine.startRecordingInNode(armed);
      const juce::File refused = dir.getChildFile("refused.wav");
      expect(!engine.bounce(rootId(engine), refused.getFullPathName()),
             "refused while a take is armed");
      driveLive(engine, BLOCK, clock, false);  // capture rolls
      expect(!engine.bounce(rootId(engine), refused.getFullPathName()),
             "refused while a take is recording");
      expect(!refused.exists(), "a refused bounce writes no file");
      engine.stopRecordingInNode(armed);
    }

    beginTest("A windowed group spans exactly its effective period");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      recordTake(engine, stack_id, D, clock);
      const int64_t ws = D / 4, we = (3 * D) / 4;
      engine.setLoopPoints(stack_id, ws, we);
      const celestrian::AudioNode* node = engine.findNodeByUuidForTest(stack_id);
      expect(node != nullptr, "the group exists");
      const int64_t period = celestrian::period_law::ownPeriodOf(*node);
      expectEquals(period, we - ws, "effective period = the window");

      const juce::File wav = dir.getChildFile("group.wav");
      expect(engine.bounce(stack_id, wav.getFullPathName()),
             "bounce of the group succeeds");
      const juce::AudioBuffer<float> file = readWav(wav, nullptr);
      expectEquals((int64_t)file.getNumSamples(), period,
                   "the file is one effective period, no tail");
      expect(peakOf(file, 0, (int)period) > 0.05f, "the window's content");
    }

    // Audit D15-1: ONE frame-top law for every node. The root is never
    // anchored, so its frame top is the zero — plus a0 under a root
    // window: the bounce starts where the window starts, not where the
    // island cycle wraps (from the zero a [D/4, 3D/4) window would have
    // started 3D/4 in — inside the rest, silent).
    beginTest("GOLDEN: a windowed ROOT bounces from its window top (zero + a0)");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String clip_id = lastTopLevelId(engine);
      recordTake(engine, clip_id, D, clock);
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");
      // A root window [D/4, 3D/4): period D/2 divides Q (coherent),
      // a0 = D/4; the island cycle stays lcm(Q, D/2) = D.
      engine.setLoopPoints(rootId(engine), D / 4, (3 * D) / 4);
      expectEquals(rootProp(engine, "loopStart"), D / 4, "the root window holds");

      const juce::File wav = dir.getChildFile("root_window.wav");
      expect(engine.bounce(rootId(engine), wav.getFullPathName()),
             "bounce of the windowed root succeeds");
      const juce::AudioBuffer<float> file = readWav(wav, nullptr);
      const int64_t span = D;  // one effective island cycle
      expect(file.getNumSamples() >= span, "the file covers the cycle");

      // The live twin from a clock ≡ zero + a0 (the window top).
      const int64_t top = rootProp(engine, "islandZero") + D / 4;
      driveLive(engine, mod(top - clock, span), clock, false);
      expectEquals(mod(clock - top, span), (int64_t)0, "at the window top");
      std::vector<float> live_l, live_r;
      driveLive(engine, span, clock, false, &live_l, &live_r);

      int bad = 0;
      float loud_head = 0.0f;
      for (int64_t i = 0; i < span; ++i) {
        const float l = file.getSample(0, (int)i);
        const float r = file.getSample(1, (int)i);
        if (std::abs(l - live_l[(size_t)i]) > 1e-6f) ++bad;
        if (std::abs(r - live_r[(size_t)i]) > 1e-6f) ++bad;
        if (i < D / 8) loud_head = std::max(loud_head, std::abs(l));
      }
      expectEquals(bad, 0, "bounce == live render from the window top");
      expect(loud_head > 0.05f,
             "the file OPENS with the window's content (not the rest)");
    }

    beginTest("Refused with no committed content");
    {
      AudioEngine engine;
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
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String id = celestrian::test_utils::firstNodeId(engine);
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
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
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String clip_id = lastTopLevelId(engine);
      recordTake(engine, clip_id, D, clock);
      const juce::String echo = slotIdOf(engine, clip_id, "echo");
      expect(echo.isNotEmpty(), "the clip's chain carries an echo slot");
      engine.setSlotEnabled(clip_id, echo, true);

      const juce::File wav = dir.getChildFile("echo.wav");
      expect(engine.bounce(clip_id, wav.getFullPathName()),
             "bounce of the clip succeeds");
      const juce::AudioBuffer<float> file = readWav(wav, nullptr);
      const int n = file.getNumSamples();
      expect(n > (int)D, "the file is longer than the span (the tail)");
      expect(n - (int)D < 44100 * 10, "the tail closes before the cap");
      expect(peakOf(file, (int)D, std::min(n - (int)D, BLOCK)) >= TAIL_FLOOR,
             "the tail rings right after the span");
      const int last = std::min(n, BLOCK);
      expect(peakOf(file, n - last, last) < TAIL_FLOOR,
             "the last block is under the floor");
    }

    dir.deleteRecursively();
  }
};

static BounceTests bounceTests;
