/**
 * Save / Load round-trip tests (edits-as-events, §2.2 Step 2).
 *
 * Doubles as the canonical-state audit: anything needed to reload that is
 * NOT serialized was wrongly treated as derived. Pins the QTime-based,
 * device-independent format (a clip's musical position survives a load at
 * a different device rate) and the buffer/contextCycle fidelity.
 */

#include <juce_core/juce_core.h>

#include <cmath>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "../src/timing.h"

namespace celestrian {

namespace {
juce::File freshBundle(const juce::String &name) {
  auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                 .getChildFile("celestrian_test_" + name);
  dir.deleteRecursively();
  dir.createDirectory();
  return dir;
}
}  // namespace

class SessionIoTests : public juce::UnitTest {
 public:
  SessionIoTests() : juce::UnitTest("Save / Load (session_io)") {}

  void runTest() override {
    const int64_t Q = 48000;      // 48 kHz island
    const int64_t epoch = 12345;  // physical epoch timestamp

    beginTest("round-trip preserves the canonical clip facts + audio");
    {
      // Build a graph by hand: a committed clip + a nested stack.
      StackNode root("SessionRoot");
      root.setQuantum(Q, epoch);
      root.is_muted.store(false);

      auto clip = std::make_unique<ClipNode>("Guitar", (double)Q);
      clip->origin_samples.store(epoch + 2 * Q);  // performed at heard 2Q
      clip->duration_samples.store(4 * Q);
      clip->setLoopPoints(Q, 3 * Q);              // window [1Q, 3Q)
      clip->setLoopWindowBypassed(false);
      clip->is_muted.store(true);
      clip->setInputChannel(2);
      clip->effects().setEnabled("echo", true);
      clip->effects().setParam("echo", "mix", 0.42);

      // A deterministic ramp fills the committed buffer.
      juce::AudioBuffer<float> audio(1, (int)(4 * Q));
      for (int i = 0; i < audio.getNumSamples(); ++i)
        audio.setSample(0, i, std::sin((float)i * 0.001f));
      clip->loadCommitted(audio, /*context_cycle=*/6 * Q);
      const juce::String clipUuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto nested = std::make_unique<StackNode>("Drums");
      const juce::String nestedUuid = nested->getUuid();
      root.addChild(std::move(nested));

      auto dir = freshBundle("roundtrip");
      expect(session_io::save(root, (double)Q, dir), "save succeeded");
      expect(dir.getChildFile("session.json").existsAsFile(), "json written");
      expect(dir.getChildFile("audio").getChildFile(clipUuid + ".wav")
                 .existsAsFile(),
             "clip wav written");

      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");
      expectEquals((juce::int64)loaded.q_samples, (juce::int64)Q, "qSamples");
      expectEquals((juce::int64)loaded.epoch, (juce::int64)epoch, "epoch");
      expectEquals(loaded.children.size(), (size_t)2, "two top-level nodes");

      auto *c = dynamic_cast<ClipNode *>(loaded.children[0].get());
      expect(c != nullptr, "first child is the clip");
      expect(c->getUuid() == clipUuid, "clip uuid preserved");
      expectEquals((juce::int64)c->origin_samples.load(),
                   (juce::int64)(epoch + 2 * Q), "origin restored");
      expectEquals((juce::int64)c->getIntrinsicDuration(), (juce::int64)(4 * Q),
                   "duration restored");
      expectEquals((juce::int64)c->getLoopStart(), (juce::int64)Q,
                   "window start restored");
      expectEquals((juce::int64)c->getLoopEnd(), (juce::int64)(3 * Q),
                   "window end restored");
      expect(c->is_muted.load(), "mute restored");
      expectEquals(c->getInputChannel(), 2, "input channel restored");
      expectEquals((juce::int64)c->contextCycle(), (juce::int64)(6 * Q),
                   "contextCycle restored (a recorded fact)");

      // Audio buffer fidelity (32-bit float wav).
      const auto &rb = c->getAudioBuffer();
      float maxErr = 0.0f;
      for (int i = 0; i < (int)(4 * Q); ++i)
        maxErr = std::max(maxErr,
                          std::abs(rb.getSample(0, i) - std::sin((float)i * 0.001f)));
      expect(maxErr < 1.0e-4f, "buffer samples round-trip (err=" +
                                   juce::String(maxErr) + ")");

      // fx params restored.
      auto fxMeta = c->effects().getMetadata();
      auto echo = fxMeta.getProperty("echo", juce::var());
      expect((bool)echo.getProperty("enabled", false), "echo enabled restored");
      expect(std::abs((double)echo.getProperty("mix", 0.0) - 0.42) < 1e-6,
             "echo mix restored");

      // Nested stack survived with its uuid and holds no island quantum
      // (only the root does).
      auto *ns = dynamic_cast<StackNode *>(loaded.children[1].get());
      expect(ns != nullptr && ns->getUuid() == nestedUuid, "nested stack");
      expectEquals((juce::int64)ns->getQuantum(), (juce::int64)0,
                   "nested stack owns no island quantum");
    }

    beginTest("format is device-independent: musical position survives a "
              "different-rate load");
    {
      StackNode root("SessionRoot");
      root.setQuantum(Q, epoch);
      auto clip = std::make_unique<ClipNode>("Clip", (double)Q);
      clip->origin_samples.store(epoch + 2 * Q);
      clip->duration_samples.store(Q);
      root.addChild(std::move(clip));

      auto dir = freshBundle("deviceindep");
      expect(session_io::save(root, (double)Q, dir), "save");

      // Load with a DIFFERENT device rate — the stored qSamples drives
      // reconstruction, so the musical position (2Q) is preserved.
      auto loaded = session_io::load(dir, 44100.0);
      expect(loaded.ok, "load ok");
      auto *c = dynamic_cast<ClipNode *>(loaded.children[0].get());
      const auto oq =
          timing::originQ(c->origin_samples.load(), loaded.epoch, loaded.q_samples);
      expectEquals((juce::int64)oq.num, (juce::int64)2, "origin still 2Q");
      expectEquals((juce::int64)oq.den, (juce::int64)1, "origin still 2Q (den)");
    }

    beginTest("AudioEngine save → load populates the graph and is stable");
    {
      // Build a source bundle from a hand graph, load it into an engine.
      StackNode src("SessionRoot");
      src.setQuantum(Q, epoch);
      auto clip = std::make_unique<ClipNode>("Bass", (double)Q);
      clip->origin_samples.store(epoch);
      clip->duration_samples.store(2 * Q);
      juce::AudioBuffer<float> audio(1, (int)(2 * Q));
      for (int i = 0; i < audio.getNumSamples(); ++i)
        audio.setSample(0, i, 0.25f);
      clip->loadCommitted(audio, 0);
      src.addChild(std::move(clip));

      auto dir = freshBundle("engine");
      expect(session_io::save(src, (double)Q, dir), "save source");

      AudioEngine engine;
      expect(engine.loadSession(dir.getFullPathName()), "engine loadSession");
      auto state = engine.getGraphState();
      auto *nodes = state.getProperty("nodes", juce::var()).getArray();
      expect(nodes != nullptr && nodes->size() == 1, "one node loaded");
      expect((*nodes)[0].getProperty("name", "").toString() == "Bass",
             "clip name loaded");
      expectEquals((juce::int64)(double)state.getProperty("quantum", 0),
                   (juce::int64)Q, "island quantum loaded");
      expectEquals((juce::int64)(double)state.getProperty("epoch", 0),
                   (juce::int64)epoch, "island epoch loaded");

      // Re-save from the engine and reload into a second engine: stable.
      auto dir2 = freshBundle("engine2");
      expect(engine.saveSession(dir2.getFullPathName()), "engine saveSession");
      AudioEngine engine2;
      expect(engine2.loadSession(dir2.getFullPathName()), "reload");
      auto s2 = engine2.getGraphState();
      auto *n2 = s2.getProperty("nodes", juce::var()).getArray();
      expect(n2 != nullptr && n2->size() == 1, "stable node count");
      expect((*n2)[0].getProperty("id", "").toString() ==
                 (*nodes)[0].getProperty("id", "").toString(),
             "uuid stable across save→load→save→load");
    }
  }
};

static SessionIoTests sessionIoTests;

}  // namespace celestrian
