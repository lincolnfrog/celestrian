/**
 * Input monitoring tests (Q20, design_language.md §5): hear a clip's
 * input through the engine — OFF by default, a per-clip toggle,
 * rendered at the clip's own output stage with NO latency beyond the
 * device round trip, never in a bounce.
 *
 * The ramp-input method (tests/content_frame_tests.cc): every input
 * sample encodes its own arrival index, so "the output equals the
 * input through the output stage, sample for sample, no offset" is one
 * comparison against rampAt(clock + i) times the pan-law gain.
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "../src/track_template.h"
#include "test_utils.h"

using celestrian::test_utils::freshTempDir;
using celestrian::test_utils::nodesOf;

namespace {

const int BLOCK = 512;
const int64_t RAMP_P = int64_t{1} << 22;  // longer than any take here

float rampAt(int64_t clock) {
  return 0.1f + 0.8f * (float)((double)(clock % RAMP_P) / (double)RAMP_P);
}

/** Drives `total` samples through the live callback — ramp input, or
 * silence — appending both output channels when `left`/`right` are
 * given. `clock` is the INPUT clock: total samples driven so far (the
 * engine's arrival index of the next block's sample 0). */
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
juce::String lastTopLevelId(AudioEngine& e) {
  const juce::var state = e.getGraphState();
  auto* nodes = nodesOf(state);
  if (nodes == nullptr || nodes->isEmpty()) return {};
  return nodes->getLast().getProperty("id", "").toString();
}
int64_t rootProp(AudioEngine& e, const char* prop) {
  return (int64_t)(double)e.getGraphState().getProperty(prop, 0);
}
/** The published `monitor` flag of clip `id`. */
bool monitorFlag(AudioEngine& e, const juce::String& id) {
  return (bool)findVar(e.getGraphState(), id).getProperty("monitor", false);
}
int64_t mod(int64_t a, int64_t m) { return ((a % m) + m) % m; }

float peakOf(const std::vector<float>& v) {
  float peak = 0.0f;
  for (float x : v) peak = std::max(peak, std::abs(x));
  return peak;
}
/** Worst |out[i] - rampAt(clock0 + i) * g| over the run. */
float maxError(const std::vector<float>& out, int64_t clock0, float g) {
  float worst = 0.0f;
  for (size_t i = 0; i < out.size(); ++i) {
    worst = std::max(
        worst, std::abs(out[i] - rampAt(clock0 + (int64_t)i) * g));
  }
  return worst;
}

/** Reads a WAV whole; an empty buffer when the file cannot be read. */
juce::AudioBuffer<float> readWav(const juce::File& file) {
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::AudioFormatReader> reader(
      fmt.createReaderFor(file.createInputStream().release(), true));
  if (reader == nullptr) return {};
  juce::AudioBuffer<float> audio((int)reader->numChannels,
                                 (int)reader->lengthInSamples);
  reader->read(&audio, 0, (int)reader->lengthInSamples, 0, true, true);
  return audio;
}

/** Records one ramp take of `D` samples on a fresh island's clip
 * `id`; returns with the take committed and one block settled. */
void recordTake(AudioEngine& engine, const juce::String& id, int64_t D,
                int64_t& clock) {
  engine.startRecordingInNode(id);
  driveLive(engine, D, clock, /*ramp_input=*/true);
  engine.stopRecordingInNode(id);  // first take: immediate commit
  driveLive(engine, BLOCK, clock, /*ramp_input=*/true);
}

}  // namespace

class MonitorTests : public juce::UnitTest {
 public:
  MonitorTests() : juce::UnitTest("Input monitoring (Q20)") {}

  void runTest() override {
    const int64_t D = 40000;  // one take, under 1 s at 44.1k
    float gl = 1.0f, gr = 1.0f, fader = 1.0f;
    celestrian::outputStageGains(0.0f, 1.0f, gl, gr, fader);  // center, unity

    beginTest("OFF by default: idle and armed clips carry no input");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String id = lastTopLevelId(engine);
      expect(!monitorFlag(engine, id), "state publishes monitor = false");
      std::vector<float> l, r;
      driveLive(engine, 4 * BLOCK, clock, true, &l, &r);
      expectEquals(peakOf(l), 0.0f, "idle: silent left");
      expectEquals(peakOf(r), 0.0f, "idle: silent right");
      engine.startRecordingInNode(id);
      l.clear();
      r.clear();
      driveLive(engine, 4 * BLOCK, clock, true, &l, &r);
      expectEquals(peakOf(l), 0.0f, "armed/capturing: silent left");
      expectEquals(peakOf(r), 0.0f, "armed/capturing: silent right");
      engine.stopRecordingInNode(id);
      driveLive(engine, BLOCK, clock, true);
    }

    beginTest("ON: the input reaches the output through the output stage, "
              "sample for sample, no offset");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String id = lastTopLevelId(engine);
      engine.setMonitor(id, true);
      expect(monitorFlag(engine, id), "state publishes monitor = true");

      // Idle: no take, nothing playing.
      std::vector<float> l, r;
      const int64_t c0 = clock;
      driveLive(engine, 4 * BLOCK, clock, true, &l, &r);
      expect(maxError(l, c0, gl) < 1e-6f, "idle: left = ramp * gl, no offset");
      expect(maxError(r, c0, gr) < 1e-6f, "idle: right = ramp * gr, no offset");
      expect(peakOf(l) > 0.05f, "...and it is not silence");

      // Capturing: the clip renders no content, so nothing doubles.
      engine.startRecordingInNode(id);
      l.clear();
      r.clear();
      const int64_t c1 = clock;
      driveLive(engine, D, clock, true, &l, &r);
      expect(maxError(l, c1, gl) < 1e-6f, "capturing: left = ramp * gl");
      expect(maxError(r, c1, gr) < 1e-6f, "capturing: right = ramp * gr");
      engine.stopRecordingInNode(id);
      driveLive(engine, BLOCK, clock, true);
      expectEquals(rootProp(engine, "quantum"), D, "the take committed (Q := D)");

      // Playing content: output = content + input. One cycle with the
      // chip off, the next with it on — the content is periodic in D,
      // so the difference is the ramp alone, through the output stage.
      engine.setMonitor(id, false);
      const int64_t zero = rootProp(engine, "islandZero");
      const int64_t master = rootProp(engine, "islandPos") + zero;
      driveLive(engine, mod(zero - master, D), clock, true);
      std::vector<float> off_l, off_r;
      driveLive(engine, D, clock, true, &off_l, &off_r);
      engine.setMonitor(id, true);
      const int64_t c2 = clock;
      std::vector<float> on_l, on_r;
      driveLive(engine, D, clock, true, &on_l, &on_r);
      expect(peakOf(off_l) > 0.05f, "content plays with the chip off");
      float worst = 0.0f;
      for (size_t i = 0; i < (size_t)D; ++i) {
        const float ramp = rampAt(c2 + (int64_t)i);
        worst = std::max(worst, std::abs(on_l[i] - off_l[i] - ramp * gl));
        worst = std::max(worst, std::abs(on_r[i] - off_r[i] - ramp * gr));
      }
      expect(worst < 1e-5f,
             "playing: output = content + input, sample for sample");
    }

    beginTest("Pan applies: hard left silences the right channel");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String id = lastTopLevelId(engine);
      engine.setMonitor(id, true);
      engine.setNodePan(id, -1.0);
      float hl = 1.0f, hr = 1.0f, hf = 1.0f;
      celestrian::outputStageGains(-1.0f, 1.0f, hl, hr, hf);
      expectEquals(hr, 0.0f, "the balance law: hard left => right gain 0");
      std::vector<float> l, r;
      const int64_t c0 = clock;
      driveLive(engine, 4 * BLOCK, clock, true, &l, &r);
      expect(maxError(l, c0, hl) < 1e-6f, "left = ramp * gl");
      expectEquals(peakOf(r), 0.0f, "right is silent");

      engine.setNodePan(id, 1.0);
      l.clear();
      r.clear();
      const int64_t c1 = clock;
      driveLive(engine, 4 * BLOCK, clock, true, &l, &r);
      expectEquals(peakOf(l), 0.0f, "hard right: left is silent");
      expect(maxError(r, c1, 1.0f) < 1e-6f, "right = ramp");
    }

    beginTest("Session round trip keeps monitor (absent key = off); "
              "templates carry it");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String on_id = lastTopLevelId(engine);
      engine.createNode("clip");
      const juce::String off_id = lastTopLevelId(engine);
      engine.setMonitor(on_id, true);

      const juce::File dir = freshTempDir("monitor");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      // The bundle's tree hangs off the root record (audit D7-3).
      const juce::var json =
          juce::JSON::parse(dir.getChildFile("session.json"))
              .getProperty("root", juce::var());
      expect((bool)findVar(json, on_id).getProperty("monitor", false),
             "the on clip saves monitor: true");
      expect(!findVar(json, off_id).hasProperty("monitor"),
             "the off clip saves no key (additive: absent = off)");

      AudioEngine loaded;
      expect(loaded.loadSession(dir.getFullPathName()), "load");
      expect(monitorFlag(loaded, on_id), "monitor survives the round trip");
      expect(!monitorFlag(loaded, off_id), "off stays off");

      // Track templates (Q17): input setup, like the channels.
      auto* on_clip = dynamic_cast<celestrian::ClipNode*>(
          loaded.findNodeByUuidForTest(on_id));
      auto* off_clip = dynamic_cast<celestrian::ClipNode*>(
          loaded.findNodeByUuidForTest(off_id));
      expect(on_clip != nullptr && off_clip != nullptr, "clips loaded");
      const juce::var tpl = celestrian::track_templates::capture(*on_clip);
      expect((bool)tpl.getProperty("monitor", false), "capture keeps it");
      expect(!celestrian::track_templates::capture(*off_clip)
                  .hasProperty("monitor"),
             "capture of an off clip carries no key");
      auto built = celestrian::track_templates::build(tpl, 44100.0);
      auto* built_clip = dynamic_cast<celestrian::ClipNode*>(built.get());
      expect(built_clip != nullptr && built_clip->isMonitoring(),
             "build stamps a monitoring clip");
      dir.deleteRecursively();
    }

    beginTest("A bounce of a monitored clip contains no input");
    {
      AudioEngine engine;
      int64_t clock = 0;
      engine.createNode("clip");
      const juce::String id = lastTopLevelId(engine);
      recordTake(engine, id, D, clock);
      const juce::File dir = freshTempDir("monitor_bounce");
      const juce::File off = dir.getChildFile("off.wav");
      const juce::File on = dir.getChildFile("on.wav");
      expect(engine.bounce(id, off.getFullPathName()), "bounce, chip off");
      engine.setMonitor(id, true);
      expect(engine.bounce(id, on.getFullPathName()), "bounce, chip on");
      const juce::AudioBuffer<float> a = readWav(off);
      const juce::AudioBuffer<float> b = readWav(on);
      expectEquals(a.getNumSamples(), b.getNumSamples(), "same length");
      expect(a.getNumSamples() >= (int)D, "the bounce covers the take");
      int bad = 0;
      float loud = 0.0f;
      for (int ch = 0; ch < 2; ++ch) {
        for (int i = 0; i < a.getNumSamples(); ++i) {
          if (a.getSample(ch, i) != b.getSample(ch, i)) ++bad;
          loud = std::max(loud, std::abs(a.getSample(ch, i)));
        }
      }
      expectEquals(bad, 0, "monitoring changes nothing in a bounce");
      expect(loud > 0.05f, "the bounce carries the take (not silence)");
      dir.deleteRecursively();
    }
  }
};

static MonitorTests monitorTests;
