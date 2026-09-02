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
#include "../src/dsp/fx_chain.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "../src/timing.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::freshTempDir;

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
      clip->setLoopPoints(Q, 3 * Q);  // window [1Q, 3Q)
      clip->setLoopWindowBypassed(false);
      clip->is_muted.store(true);
      clip->setInputChannel(2);
      // Chain surface (docs/vst3.md phase 2): reorder echo to the head
      // so the round-trip pins ORDER as well as params, then enable it.
      {
        auto slots = clip->fxChain()->slots();
        std::rotate(slots.begin(), slots.begin() + 2, slots.begin() + 3);
        delete clip->exchangeFxChain(
            dsp::FxChain::makeFromSlots(std::move(slots)).release());
        auto* echo_slot = clip->fxChain()->slots()[0].get();
        echo_slot->prepare((double)Q);
        echo_slot->setParam("mix", 0.42);
        echo_slot->enabled.store(true);
      }
      // A MISSING vst3 slot (docs/vst3.md §6): the save must round-trip
      // its identity + state blob verbatim even with no plugin
      // installed anywhere near this test.
      {
        juce::MemoryBlock vst3_state;
        const float fake = 0.33f;
        vst3_state.replaceAll(&fake, sizeof(fake));
        auto slots = clip->fxChain()->slots();
        auto ghost = std::make_shared<dsp::Vst3Slot>(
            "VST3-ghost-uid", "Ghost Plugin", "/gone/Ghost.vst3", vst3_state,
            /*is_instrument=*/true);
        ghost->enabled.store(true);
        slots.push_back(std::move(ghost));
        delete clip->exchangeFxChain(
            dsp::FxChain::makeFromSlots(std::move(slots)).release());
      }

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

      auto dir = freshTempDir("roundtrip");
      expect(session_io::save(root, (double)Q, dir), "save succeeded");
      expect(dir.getChildFile("session.json").existsAsFile(), "json written");
      expect(dir.getChildFile("audio")
                 .getChildFile(clipUuid + ".wav")
                 .existsAsFile(),
             "clip wav written");

      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");
      expectEquals((juce::int64)loaded.q_samples, (juce::int64)Q, "qSamples");
      expectEquals((juce::int64)loaded.epoch, (juce::int64)epoch, "epoch");
      expectEquals(loaded.children.size(), (size_t)2, "two top-level nodes");

      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
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
      const auto& rb = c->getAudioBuffer();
      float maxErr = 0.0f;
      for (int i = 0; i < (int)(4 * Q); ++i)
        maxErr = std::max(
            maxErr, std::abs(rb.getSample(0, i) - std::sin((float)i * 0.001f)));
      expect(maxErr < 1.0e-4f,
             "buffer samples round-trip (err=" + juce::String(maxErr) + ")");

      // fx chain restored: order, enable, params, and slot identity.
      const auto& loaded_slots = c->fxChain()->slots();
      expectEquals((int)loaded_slots.size(), 5,
                   juce::String("4 built-ins + the ghost vst3 slot"));
      expectEquals(juce::String(loaded_slots[0]->typeId()),
                   juce::String("echo"), juce::String("saved order restored"));
      expect(loaded_slots[0]->enabled.load(), "echo enabled restored");
      auto fxMeta = c->fxChain()->getMetadata();
      expect(std::abs((double)fxMeta[0].getProperty("mix", 0.0) - 0.42) < 1e-6,
             "echo mix restored");
      expect(fxMeta[0].getProperty("slot", "").toString().isNotEmpty(),
             "slot uuid persisted");

      // The ghost vst3 slot: placeholder with identity + state intact.
      expectEquals((int)c->fxChain()->slots().size(), 5,
                   juce::String("vst3 slot survived the round trip"));
      auto* ghost = dynamic_cast<dsp::Vst3Slot*>(c->fxChain()->slots()[4].get());
      expect(ghost != nullptr && ghost->isMissing(), "loaded as placeholder");
      expectEquals(ghost->pluginUid(), juce::String("VST3-ghost-uid"));
      expect(ghost->enabled.load(), "enable flag persisted");
      expect(ghost->isInstrument(), "instrument flag persisted (phase 4)");
      float restored = 0.0f;
      ghost->stateBlob().copyTo(&restored, 0, sizeof(restored));
      expectWithinAbsoluteError(restored, 0.33f, 1e-6f,
                                "state blob verbatim through save+load");

      // Nested stack survived with its uuid and holds no island quantum
      // (only the root does).
      auto* ns = dynamic_cast<StackNode*>(loaded.children[1].get());
      expect(ns != nullptr && ns->getUuid() == nestedUuid, "nested stack");
      expectEquals((juce::int64)ns->getQuantum(), (juce::int64)0,
                   "nested stack owns no island quantum");
    }

    beginTest(
        "multi-segment maps round-trip (segmentsQ) and templates "
        "strip them");
    {
      StackNode root("SegRoot");
      root.setQuantum(Q, epoch);

      // A committed clip carrying a cell map, and a mapped nested stack.
      auto clip = std::make_unique<ClipNode>("Cells", (double)Q);
      clip->origin_samples.store(epoch);
      clip->duration_samples.store(4 * Q);
      juce::AudioBuffer<float> audio(1, (int)(4 * Q));
      audio.clear();
      clip->loadCommitted(audio, 4 * Q);
      timing::TimeMap cm;
      cm.n = 2;
      cm.segs[0] = {0, Q};
      cm.segs[1] = {2 * Q, 3 * Q};
      delete clip->exchangeMapOverride(new timing::TimeMap(cm));
      const juce::String clipUuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto nested = std::make_unique<StackNode>("MappedDrums");
      timing::TimeMap sm;
      sm.n = 2;
      sm.segs[0] = {Q / 2, Q};  // sub-Q punch shapes survive too
      sm.segs[1] = {2 * Q, 4 * Q};
      delete nested->exchangeMapOverride(new timing::TimeMap(sm));
      const juce::String nestedUuid = nested->getUuid();
      root.addChild(std::move(nested));

      auto dir = freshTempDir("segments");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");

      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr && c->getUuid() == clipUuid, "clip restored");
      {
        const auto* m = c->mapOverride();
        expect(m != nullptr && m->n == 2, "clip map override restored");
        expectEquals((juce::int64)m->segs[0].end, (juce::int64)Q,
                     "clip segment 0");
        expectEquals((juce::int64)m->segs[1].start, (juce::int64)(2 * Q),
                     "clip segment 1");
        expectEquals((juce::int64)c->getEffectivePeriod(), (juce::int64)(2 * Q),
                     "clip effective period from the map");
      }
      auto* ns = dynamic_cast<StackNode*>(loaded.children[1].get());
      expect(ns != nullptr && ns->getUuid() == nestedUuid, "stack restored");
      {
        const auto* m = ns->mapOverride();
        expect(m != nullptr && m->n == 2, "stack map override restored");
        expectEquals((juce::int64)m->segs[0].start, (juce::int64)(Q / 2),
                     "sub-Q punch boundary exact (QTime)");
      }

      // Save→load→save stability: the re-saved bundle loads identically.
      auto dir2 = freshTempDir("segments2");
      StackNode root2("SegRoot2");
      root2.setQuantum(Q, epoch);
      for (auto& ch : loaded.children) root2.addChild(std::move(ch));
      expect(session_io::save(root2, (double)Q, dir2), "re-save");
      auto loaded2 = session_io::load(dir2, (double)Q);
      expect(loaded2.ok && loaded2.children[0]->mapOverride() != nullptr &&
                 loaded2.children[0]->mapOverride()->n == 2,
             "stable across a second round trip");

      // Templates strip the map with the window.
      auto dir3 = freshTempDir("segments-template");
      session_io::SaveOptions strip;
      strip.strip_performances = true;
      expect(session_io::save(root2, (double)Q, dir3, strip), "template save");
      auto loaded3 = session_io::load(dir3, (double)Q);
      expect(loaded3.ok && loaded3.children[0]->mapOverride() == nullptr,
             "template strips the map");
    }

    beginTest(
        "format is device-independent: musical position survives a "
        "different-rate load");
    {
      StackNode root("SessionRoot");
      root.setQuantum(Q, epoch);
      auto clip = std::make_unique<ClipNode>("Clip", (double)Q);
      clip->origin_samples.store(epoch + 2 * Q);
      clip->duration_samples.store(Q);
      root.addChild(std::move(clip));

      auto dir = freshTempDir("deviceindep");
      expect(session_io::save(root, (double)Q, dir), "save");

      // Load with a DIFFERENT device rate — the stored qSamples drives
      // reconstruction, so the musical position (2Q) is preserved.
      auto loaded = session_io::load(dir, 44100.0);
      expect(loaded.ok, "load ok");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      const auto oq = timing::originQ(c->origin_samples.load(), loaded.epoch,
                                      loaded.q_samples);
      expectEquals((juce::int64)oq.num, (juce::int64)2, "origin still 2Q");
      expectEquals((juce::int64)oq.den, (juce::int64)1,
                   "origin still 2Q (den)");
    }

    beginTest("AudioEngine save -> load populates the graph and is stable");
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

      auto dir = freshTempDir("engine");
      expect(session_io::save(src, (double)Q, dir), "save source");

      AudioEngine engine;
      expect(engine.loadSession(dir.getFullPathName()), "engine loadSession");
      auto state = engine.getGraphState();
      auto* nodes = state.getProperty("nodes", juce::var()).getArray();
      expect(nodes != nullptr && nodes->size() == 1, "one node loaded");
      expect((*nodes)[0].getProperty("name", "").toString() == "Bass",
             "clip name loaded");
      expectEquals((juce::int64)(double)state.getProperty("quantum", 0),
                   (juce::int64)Q, "island quantum loaded");
      expectEquals((juce::int64)(double)state.getProperty("epoch", 0),
                   (juce::int64)epoch, "island epoch loaded");

      // Re-save from the engine and reload into a second engine: stable.
      auto dir2 = freshTempDir("engine2");
      expect(engine.saveSession(dir2.getFullPathName()), "engine saveSession");
      AudioEngine engine2;
      expect(engine2.loadSession(dir2.getFullPathName()), "reload");
      auto s2 = engine2.getGraphState();
      auto* n2 = s2.getProperty("nodes", juce::var()).getArray();
      expect(n2 != nullptr && n2->size() == 1, "stable node count");
      expect((*n2)[0].getProperty("id", "").toString() ==
                 (*nodes)[0].getProperty("id", "").toString(),
             "uuid stable across save->load->save->load");
    }
  }
};

static SessionIoTests sessionIoTests;

}  // namespace celestrian
