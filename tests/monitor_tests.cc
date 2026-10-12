/**
 * Input monitoring tests (Q20, design_language.md §5): hear a clip's
 * input through the engine — OFF by default, a per-clip toggle,
 * rendered at the clip's own output stage with NO latency beyond the
 * device round trip, never in a bounce.
 *
 * The ramp-input method (test_utils.h EngineRig): every input sample
 * encodes its own arrival index, so "the output equals the input
 * through the output stage, sample for sample, no offset" is one
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

namespace {

using celestrian::test_utils::addNode;
using celestrian::test_utils::clipOf;
using celestrian::test_utils::deepBool;
using celestrian::test_utils::EngineRig;
using celestrian::test_utils::findVar;
using celestrian::test_utils::mod;
using celestrian::test_utils::peakOf;
using celestrian::test_utils::readWav;
using celestrian::test_utils::rootProp;
using celestrian::test_utils::freshTempDir;

const int BLOCK = EngineRig::BLOCK;

float rampAt(int64_t clock) { return EngineRig::rampAt(clock); }

/** Worst |side[i] - rampAt(start + i) * g| over a run. The ramp steps
 * 1.9e-7 a sample: under 1e-7, the side is the input through gain g
 * with no offset, not even one sample. */
float maxError(const std::vector<float>& side, int64_t start, float g) {
  float worst = 0.0f;
  for (size_t i = 0; i < side.size(); ++i) {
    worst = std::max(
        worst, std::abs(side[i] - rampAt(start + (int64_t)i) * g));
  }
  return worst;
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
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      expect(!deepBool(engine, id, "monitor"), "state publishes monitor = false");
      const EngineRig::Heard idle = rig.hear(4 * BLOCK);
      expectEquals(peakOf(idle.left), 0.0f, "idle: silent left");
      expectEquals(peakOf(idle.right), 0.0f, "idle: silent right");
      engine.startRecordingInNode(id);
      const EngineRig::Heard armed = rig.hear(4 * BLOCK);
      expectEquals(peakOf(armed.left), 0.0f, "armed/capturing: silent left");
      expectEquals(peakOf(armed.right), 0.0f, "armed/capturing: silent right");
      engine.stopRecordingInNode(id);
      rig.drive(BLOCK);
    }

    beginTest("ON: the input reaches the output through the output stage, "
              "sample for sample, no offset");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      engine.setMonitor(id, true);
      expect(deepBool(engine, id, "monitor"), "state publishes monitor = true");

      // Idle: no take, nothing playing.
      const EngineRig::Heard idle = rig.hear(4 * BLOCK);
      expect(maxError(idle.left, idle.start, gl) < 1e-7f,
             "idle: left = ramp * gl, no offset");
      expect(maxError(idle.right, idle.start, gr) < 1e-7f,
             "idle: right = ramp * gr, no offset");
      expect(peakOf(idle.left) > 0.05f, "...and it is not silence");

      // Capturing: the clip renders no content, so nothing doubles.
      engine.startRecordingInNode(id);
      const EngineRig::Heard capturing = rig.hear(D);
      expect(maxError(capturing.left, capturing.start, gl) < 1e-7f,
             "capturing: left = ramp * gl");
      expect(maxError(capturing.right, capturing.start, gr) < 1e-7f,
             "capturing: right = ramp * gr");
      engine.stopRecordingInNode(id);
      rig.drive(BLOCK);
      expectEquals(rootProp(engine, "quantum"), D, "the take committed (Q := D)");

      // Playing content: output = content + input. One cycle with the
      // chip off, the next with it on — the content is periodic in D,
      // so the difference is the ramp alone, through the output stage.
      engine.setMonitor(id, false);
      const int64_t zero = rootProp(engine, "islandZero");
      rig.drive(mod(zero - engine.transportClock(), D));
      const EngineRig::Heard off = rig.hear(D);
      engine.setMonitor(id, true);
      const EngineRig::Heard on = rig.hear(D);
      expect(peakOf(off.left) > 0.05f, "content plays with the chip off");
      // In double, so only the engine's own float sum rounds (under
      // 1.2e-7 with the ramp's last bit): one sample's slip is the
      // ramp's 1.9e-7 step.
      double worst = 0.0;
      for (size_t i = 0; i < (size_t)D; ++i) {
        const double ramp = rampAt(on.start + (int64_t)i);
        worst = std::max(worst, std::abs((double)on.left[i] - off.left[i] - ramp * gl));
        worst = std::max(worst, std::abs((double)on.right[i] - off.right[i] - ramp * gr));
      }
      expect(worst < 1.5e-7,
             "playing: output = content + input, sample for sample");
    }

    beginTest("Pan applies: hard left silences the right channel");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      engine.setMonitor(id, true);
      engine.setNodePan(id, -1.0);
      float hl = 1.0f, hr = 1.0f, hf = 1.0f;
      celestrian::outputStageGains(-1.0f, 1.0f, hl, hr, hf);
      expectEquals(hr, 0.0f, "the balance law: hard left => right gain 0");
      const EngineRig::Heard left = rig.hear(4 * BLOCK);
      expect(maxError(left.left, left.start, hl) < 1e-7f, "left = ramp * gl");
      expectEquals(peakOf(left.right), 0.0f, "right is silent");

      engine.setNodePan(id, 1.0);
      const EngineRig::Heard right = rig.hear(4 * BLOCK);
      expectEquals(peakOf(right.left), 0.0f, "hard right: left is silent");
      expect(maxError(right.right, right.start, 1.0f) < 1e-7f, "right = ramp");
    }

    beginTest("monitoring hears the input the take records: an unassigned "
              "or out-of-range input falls back the way capture does");
    for (const int assigned : {-1, 7}) {
      // The device has ONE input: both assignments resolve to it.
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      engine.setNodeInput(id, assigned);
      engine.setMonitor(id, true);
      const juce::String label = "input " + juce::String(assigned) + ": ";
      const EngineRig::Heard idle = rig.hear(4 * BLOCK);
      expect(maxError(idle.left, idle.start, gl) < 1e-7f,
             label + "monitored = the device's input");
      const int64_t start = rig.clock;
      rig.record(id, D);
      expectWithinAbsoluteError(
          clipOf(engine, id)->getAudioBuffer().getSample(0, 100),
          rampAt(start + 100), 1e-6f, label + "recorded = the same input");
    }

    beginTest("a mute or a lost solo fades the monitored input: no hard cut, "
              "no hard return");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      const juce::String other = addNode(engine, "clip");
      engine.setMonitor(id, true);
      rig.drive(4 * BLOCK);  // the gate seeds open

      // Each edge is one block here (the ramp is ~10 ms, a block is
      // longer): it starts where the gate stood and lands on its target.
      const auto edge = [&](const juce::String& label, bool closing) {
        const int64_t c0 = rig.clock;
        std::vector<float> l = rig.hear(BLOCK).left;
        const float first = l.front() / (rampAt(c0) * gl);
        const float last = l.back() / (rampAt(c0 + BLOCK - 1) * gl);
        expect(std::abs(first - (closing ? 1.0f : 0.0f)) < 0.01f,
               label + ": the block starts where the gate stood (" +
                   juce::String(first) + ")");
        expect(std::abs(last - (closing ? 0.0f : 1.0f)) < 0.01f,
               label + ": and lands on its target (" + juce::String(last) + ")");
        bool monotone = true;
        for (size_t i = 1; i < l.size(); ++i) {
          const float a = l[i - 1] / rampAt(c0 + (int64_t)i - 1);
          const float b = l[i] / rampAt(c0 + (int64_t)i);
          if (closing ? b > a + 1e-6f : b < a - 1e-6f) monotone = false;
        }
        expect(monotone, label + ": a ramp, never a step back");
        l = rig.hear(BLOCK).left;
        expect(closing ? peakOf(l) == 0.0f : l.front() > 0.05f,
               label + ": settled the block after");
      };
      engine.toggleMute(id);
      edge("mute", /*closing=*/true);
      engine.toggleMute(id);
      edge("unmute", /*closing=*/false);
      engine.toggleSolo(other);
      edge("another track soloed", /*closing=*/true);
      engine.toggleSolo(other);
      edge("the solo released", /*closing=*/false);

      // The gate follows the mute while nothing sounds: a monitor
      // switched on under a mute is shut from its first sample.
      engine.setMonitor(id, false);
      engine.toggleMute(id);
      rig.drive(2 * BLOCK);
      engine.setMonitor(id, true);
      expectEquals(peakOf(rig.hear(2 * BLOCK).left), 0.0f,
                   "monitoring switched on under a mute: silent throughout");
    }

    beginTest("a one-shot group's rest silences a member's content, not its "
              "monitored input - rack idle or running");
    for (const bool rack_live : {false, true}) {
      // The kit fires its 1Q shot once per 4Q cycle and rests for 3Q. Its
      // member holds content AND monitors its input: the content rests
      // with the group, the live input is heard through.
      const double sr = 44100.0;
      const int q = 4410, n = 256;
      const float content = 0.25f, input = 0.5f;
      celestrian::StackNode root("Island");
      root.addChild(celestrian::test_utils::committedClip("Bass", sr, 4 * q, 0.0f));
      auto kit = std::make_unique<celestrian::StackNode>("Kit");
      kit->period_from_context_.store(true);
      auto hit = celestrian::test_utils::committedClip("Hit", sr, q, content);
      hit->setMonitoring(true);
      // A watched scope keeps the rack pass live without shaping the signal.
      hit->fxScope().setActive(rack_live);
      kit->addChild(std::move(hit));
      root.addChild(std::move(kit));

      const int ring_len = 8192;
      const std::vector<float> ring((size_t)ring_len, input);
      const float* const rings[] = {ring.data()};
      const auto heardAt = [&](int64_t pos) {
        celestrian::test_utils::NodeContext nc =
            celestrian::test_utils::contextFor(root, n, pos);
        nc.ctx.sample_rate = sr;
        nc.ctx.is_playing = true;
        nc.ctx.prerecord_ring = rings;
        nc.ctx.prerecord_ring_len = ring_len;
        nc.ctx.prerecord_ring_channels = 1;
        nc.ctx.input_clock = pos;
        std::vector<float> l((size_t)n, 0.0f), r((size_t)n, 0.0f);
        float* outs[] = {l.data(), r.data()};
        root.process(nullptr, outs, 0, 2, nc.ctx);
        return l[100];
      };
      const juce::String label = rack_live ? "rack running: " : "rack idle: ";
      expectWithinAbsoluteError(heardAt(q / 2), content + input, 1e-6f,
                                label + "the shot: content + input");
      expectWithinAbsoluteError(heardAt(2 * q), input, 1e-6f,
                                label + "the rest: the input alone");
      expectWithinAbsoluteError(heardAt(4 * q + q / 2), content + input, 1e-6f,
                                label + "the next firing: content + input");
    }

    beginTest("Session round trip keeps monitor (absent key = off); "
              "templates carry it");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String on_id = addNode(engine, "clip");
      const juce::String off_id = addNode(engine, "clip");
      engine.setMonitor(on_id, true);

      const juce::File dir = freshTempDir("monitor");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      // The bundle's tree hangs off the root record.
      const juce::var json =
          juce::JSON::parse(dir.getChildFile("session.json"))
              .getProperty("root", juce::var());
      expect((bool)findVar(json, on_id).getProperty("monitor", false),
             "the on clip saves monitor: true");
      expect(!findVar(json, off_id).hasProperty("monitor"),
             "the off clip saves no key (additive: absent = off)");

      EngineRig reloaded;
      AudioEngine& loaded = reloaded.engine;
      expect(loaded.loadSession(dir.getFullPathName()), "load");
      expect(deepBool(loaded, on_id, "monitor"), "monitor survives the round trip");
      expect(!deepBool(loaded, off_id, "monitor"), "off stays off");

      // Track templates (Q17): input setup, like the channels.
      auto* on_clip = clipOf(loaded, on_id);
      auto* off_clip = clipOf(loaded, off_id);
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
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordClip(D);
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
