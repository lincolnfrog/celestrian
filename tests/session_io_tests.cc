/**
 * Save / Load round-trip tests (edits-as-events, §2.2 Step 2).
 *
 * Doubles as the canonical-state audit: anything needed to reload that is
 * NOT serialized was wrongly treated as derived. Pins the QTime-based,
 * device-independent format (a clip's musical position survives a load at
 * a different device rate) and the buffer/contextCycle fidelity.
 */

#include <juce_audio_formats/juce_audio_formats.h>
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
    const int64_t zero = 12345;  // island zero, absolute samples

    beginTest("round-trip preserves the canonical clip facts + audio");
    {
      // Build a graph by hand: a committed clip + a nested stack.
      StackNode root("SessionRoot");
      root.setQuantum(Q, zero);
      root.is_muted.store(false);

      auto clip = std::make_unique<ClipNode>("Guitar", (double)Q);
      clip->origin_samples.store(zero + 2 * Q);  // performed at heard 2Q
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
      expectEquals((juce::int64)loaded.zero, (juce::int64)zero, "zero");
      expectEquals(loaded.children.size(), (size_t)2, "two top-level nodes");

      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr, "first child is the clip");
      expect(c->getUuid() == clipUuid, "clip uuid preserved");
      expectEquals((juce::int64)c->origin_samples.load(),
                   (juce::int64)(zero + 2 * Q), "origin restored");
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

      // fx chain restored: order, enable, params, and slot identity. The
      // ghost is an INSTRUMENT, so it heads the chain (makeFromSlots);
      // the effects follow in their saved order, echo first.
      const auto& loaded_slots = c->fxChain()->slots();
      expectEquals((int)loaded_slots.size(), 5,
                   juce::String("4 built-ins + the ghost vst3 slot"));
      expectEquals(juce::String(loaded_slots[1]->typeId()),
                   juce::String("echo"), juce::String("saved order restored"));
      expect(loaded_slots[1]->enabled.load(), "echo enabled restored");
      auto fxMeta = c->fxChain()->getMetadata();
      expect(std::abs((double)fxMeta[1].getProperty("mix", 0.0) - 0.42) < 1e-6,
             "echo mix restored");
      expect(fxMeta[1].getProperty("slot", "").toString().isNotEmpty(),
             "slot uuid persisted");

      // The ghost vst3 slot: placeholder with identity + state intact.
      expectEquals((int)c->fxChain()->slots().size(), 5,
                   juce::String("vst3 slot survived the round trip"));
      auto* ghost = dynamic_cast<dsp::Vst3Slot*>(c->fxChain()->slots()[0].get());
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
      root.setQuantum(Q, zero);

      // A committed clip carrying a cell map, and a mapped nested stack.
      auto clip = std::make_unique<ClipNode>("Cells", (double)Q);
      clip->origin_samples.store(zero);
      clip->duration_samples.store(4 * Q);
      juce::AudioBuffer<float> audio(1, (int)(4 * Q));
      audio.clear();
      clip->loadCommitted(audio, 4 * Q);
      timing::TimeMap cm;
      cm.n = 2;
      cm.segs[0] = {0, Q};
      cm.segs[1] = {2 * Q, 3 * Q};
      clip->setMap(cm);
      const juce::String clipUuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto nested = std::make_unique<StackNode>("MappedDrums");
      timing::TimeMap sm;
      sm.n = 2;
      sm.segs[0] = {Q / 2, Q};  // sub-Q punch shapes survive too
      sm.segs[1] = {2 * Q, 4 * Q};
      nested->setMap(sm);
      const juce::String nestedUuid = nested->getUuid();
      root.addChild(std::move(nested));

      auto dir = freshTempDir("segments");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");

      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr && c->getUuid() == clipUuid, "clip restored");
      {
        const timing::TimeMap m = c->storedMap();
        expect(m.n == 2, "clip map restored");
        expectEquals((juce::int64)m.segs[0].end, (juce::int64)Q,
                     "clip segment 0");
        expectEquals((juce::int64)m.segs[1].start, (juce::int64)(2 * Q),
                     "clip segment 1");
        expectEquals((juce::int64)c->getEffectivePeriod(), (juce::int64)(2 * Q),
                     "clip effective period from the map");
      }
      auto* ns = dynamic_cast<StackNode*>(loaded.children[1].get());
      expect(ns != nullptr && ns->getUuid() == nestedUuid, "stack restored");
      {
        const timing::TimeMap m = ns->storedMap();
        expect(m.n == 2, "stack map restored");
        expectEquals((juce::int64)m.segs[0].start, (juce::int64)(Q / 2),
                     "sub-Q punch boundary exact (QTime)");
      }

      // Save→load→save stability: the re-saved bundle loads identically.
      auto dir2 = freshTempDir("segments2");
      StackNode root2("SegRoot2");
      root2.setQuantum(Q, zero);
      for (auto& ch : loaded.children) root2.addChild(std::move(ch));
      expect(session_io::save(root2, (double)Q, dir2), "re-save");
      auto loaded2 = session_io::load(dir2, (double)Q);
      expect(loaded2.ok && loaded2.children[0]->storedMap().n == 2,
             "stable across a second round trip");

      // Templates strip the map with the window.
      auto dir3 = freshTempDir("segments-template");
      session_io::SaveOptions strip;
      strip.strip_performances = true;
      expect(session_io::save(root2, (double)Q, dir3, strip), "template save");
      auto loaded3 = session_io::load(dir3, (double)Q);
      expect(loaded3.ok && !loaded3.children[0]->hasSegmentMap(),
             "template strips the map");
    }

    beginTest(
        "format is device-independent: musical position survives a "
        "different-rate load");
    {
      StackNode root("SessionRoot");
      root.setQuantum(Q, zero);
      auto clip = std::make_unique<ClipNode>("Clip", (double)Q);
      clip->origin_samples.store(zero + 2 * Q);
      clip->duration_samples.store(Q);
      root.addChild(std::move(clip));

      auto dir = freshTempDir("deviceindep");
      expect(session_io::save(root, (double)Q, dir), "save");

      // Load with a DIFFERENT device rate — the stored qSamples drives
      // reconstruction, so the musical position (2Q) is preserved.
      auto loaded = session_io::load(dir, 44100.0);
      expect(loaded.ok, "load ok");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      const auto oq = timing::originQ(c->origin_samples.load(), loaded.zero,
                                      loaded.q_samples);
      expectEquals((juce::int64)oq.num, (juce::int64)2, "origin still 2Q");
      expectEquals((juce::int64)oq.den, (juce::int64)1,
                   "origin still 2Q (den)");
    }

    beginTest("AudioEngine save -> load populates the graph and is stable");
    {
      // Build a source bundle from a hand graph, load it into an engine.
      StackNode src("SessionRoot");
      src.setQuantum(Q, zero);
      auto clip = std::make_unique<ClipNode>("Bass", (double)Q);
      clip->origin_samples.store(zero);
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
      expectEquals((juce::int64)(double)state.getProperty("zero", 0),
                   (juce::int64)zero, "island zero loaded");

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

    beginTest(
        "the root is ONE node record (audit D7-3): window, map, bypass, "
        "period source, window domain, stage, rack and song round-trip");
    {
      // Every fact a nested stack has always persisted, set on a hand
      // root — the root used to write only its stage, rack and song
      // through a second, bundle-level path, and lost the rest.
      StackNode root("MasterRoot");
      root.setQuantum(Q, zero);
      root.gain.store(0.5f);
      root.pan.store(-0.25f);
      root.is_muted.store(true);
      root.period_from_context_.store(true);
      root.setLoopPoints(Q, 3 * Q);
      root.setLoopWindowBypassed(true);
      root.setWindowDomain(StackNode::WindowDomain::Sequence);
      for (const auto& slot : root.fxChain()->slots()) {
        if (juce::String(slot->typeId()) == "echo") {
          slot->prepare((double)Q);
          slot->setParam("mix", 0.42);
          slot->enabled.store(true);
        }
      }
      {
        auto* seq = new Sequence();
        Sequence::Step verse;
        verse.len = 2 * Q;
        verse.name = "verse";
        seq->steps.push_back(verse);
        Sequence::Step chorus;
        chorus.len = 2 * Q;
        chorus.name = "chorus";
        chorus.cue = true;
        seq->steps.push_back(chorus);
        seq->finalize();
        delete root.exchangeSequence(seq);
      }
      const juce::String root_uuid = root.getUuid();

      auto dir = freshTempDir("root_record");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load ok");
      expect(loaded.root.isObject(), "the root's record is in the bundle");
      expectEquals(loaded.root.getProperty("id", "").toString(), root_uuid,
                   "the record carries the root's uuid");
      // The island facts stay bundle-level (I14); nothing else does.
      {
        const juce::var top = juce::JSON::parse(
            dir.getChildFile("session.json").loadFileAsString());
        expect(top.hasProperty("qSamples") && top.hasProperty("zero"),
               "island facts at bundle level");
        expect(!top.hasProperty("nodes") && !top.hasProperty("rootGain") &&
                   !top.hasProperty("rootSequence"),
               "no second root path in a version-2 bundle");
        expectEquals((int)top.getProperty("version", 0),
                     session_io::kSessionVersion, "current version");
      }

      // Through the engine: the LIVE root takes the record's facts.
      AudioEngine engine;
      expect(engine.loadSession(dir.getFullPathName()), "engine loadSession");
      auto state = engine.getGraphState();
      expectEquals(state.getProperty("id", "").toString(), root_uuid,
                   "the root's uuid is the session's");
      expectWithinAbsoluteError((double)state.getProperty("gain", 1.0), 0.5,
                                1e-6, "root gain");
      expectWithinAbsoluteError((double)state.getProperty("pan", 0.0), -0.25,
                                1e-6, "root pan");
      expect((bool)state.getProperty("isMuted", false), "root mute");
      expectEquals(state.getProperty("periodSource", "").toString(),
                   juce::String("context"), "root period source");
      expectEquals((juce::int64)(double)state.getProperty("loopStart", 0),
                   (juce::int64)Q, "root window start");
      expectEquals((juce::int64)(double)state.getProperty("loopEnd", 0),
                   (juce::int64)(3 * Q), "root window end");
      expect((bool)state.getProperty("loopBypassed", false),
             "root window bypass");
      expectEquals(state.getProperty("windowDomain", "").toString(),
                   juce::String("sequence"), "root window domain (S16)");
      {
        const juce::var seq = state.getProperty("sequence", juce::var());
        auto* steps = seq.getProperty("steps", juce::var()).getArray();
        expect(steps != nullptr && steps->size() == 2, "root song: two steps");
        if (steps != nullptr && steps->size() == 2)
          expect((bool)(*steps)[1].getProperty("cue", false),
                 "root song: the chorus is cued");
      }
      {
        const juce::var chain = state.getProperty("effects", juce::var())
                                    .getProperty("chain", juce::var());
        bool echo_ok = false;
        if (auto* entries = chain.getArray())
          for (const auto& e : *entries)
            if (e.getProperty("type", "").toString() == "echo")
              echo_ok = (bool)e.getProperty("enabled", false) &&
                        std::abs((double)e.getProperty("mix", 0.0) - 0.42) <
                            1e-6;
        expect(echo_ok, "root rack: echo enabled at mix 0.42");
      }
      // And the engine re-saves the same record: stable.
      auto dir2 = freshTempDir("root_record2");
      expect(engine.saveSession(dir2.getFullPathName()), "engine saveSession");
      auto again = session_io::load(dir2, (double)Q);
      expect(again.ok && again.root.isObject(), "reload ok");
      expectEquals((juce::int64)timing::toSamples(
                       timing::qtime((int64_t)(double)again.root
                                         .getProperty("windowStartQ", juce::var())
                                         .getProperty("num", 0.0),
                                     (int64_t)(double)again.root
                                         .getProperty("windowStartQ", juce::var())
                                         .getProperty("den", 1.0)),
                       Q),
                   (juce::int64)Q, "the root window survives a re-save");
    }

    beginTest("a version-1 bundle's bundle-level root keys load as the root's "
              "record; absent keys read unity / center");
    {
      // The shape every build before 2026-09-10 wrote: rootMuted /
      // rootGain / rootPan / rootSequence beside `nodes`.
      auto legacy = freshTempDir("root_v1");
      legacy.createDirectory();
      const juce::String v1 =
          "{\"version\":1,\"qSamples\":" + juce::String(Q) +
          ",\"epoch\":12345,\"rootMuted\":true,\"rootGain\":0.5,\"rootPan\":-0.25,"
          "\"rootSequence\":{\"steps\":[{\"name\":\"a\",\"lenQ\":{\"num\":2,"
          "\"den\":1}},{\"name\":\"b\",\"lenQ\":{\"num\":2,\"den\":1},"
          "\"cue\":true}],\"gates\":{}},\"nodes\":[]}";
      expect(legacy.getChildFile("session.json").replaceWithText(v1),
             "write v1 bundle");
      AudioEngine engine;
      expect(engine.loadSession(legacy.getFullPathName()), "v1 loads");
      auto state = engine.getGraphState();
      // The island zero's key was `epoch` before version 3 (frame.md
      // §7): the legacy key loads as the zero, not as 0.
      expectEquals((juce::int64)(double)state.getProperty("zero", 0),
                   (juce::int64)12345, "a legacy `epoch` key loads as the zero");
      expectWithinAbsoluteError((double)state.getProperty("gain", 1.0), 0.5,
                                1e-6, "v1 rootGain");
      expectWithinAbsoluteError((double)state.getProperty("pan", 0.0), -0.25,
                                1e-6, "v1 rootPan");
      expect((bool)state.getProperty("isMuted", false), "v1 rootMuted");
      {
        const juce::var seq = state.getProperty("sequence", juce::var());
        auto* steps = seq.getProperty("steps", juce::var()).getArray();
        expect(steps != nullptr && steps->size() == 2, "v1 rootSequence");
        if (steps != nullptr && steps->size() == 2)
          expect((bool)(*steps)[1].getProperty("cue", false), "v1 cue kept");
      }

      // A bundle written before the master strip carries no root keys
      // at all: unity / center, never silent.
      auto bare = freshTempDir("root_v1_bare");
      bare.createDirectory();
      expect(bare.getChildFile("session.json")
                 .replaceWithText("{\"version\":1,\"qSamples\":0,"
                                  "\"epoch\":0,\"nodes\":[]}"),
             "write bare bundle");
      AudioEngine engine2;
      expect(engine2.loadSession(bare.getFullPathName()), "bare loads");
      auto s2 = engine2.getGraphState();
      expectWithinAbsoluteError((double)s2.getProperty("gain", 0.0), 1.0, 1e-6,
                                "absent rootGain reads unity");
      expectWithinAbsoluteError((double)s2.getProperty("pan", 1.0), 0.0, 1e-6,
                                "absent rootPan reads center");
      expect(!(bool)s2.getProperty("isMuted", true), "absent rootMuted = off");
    }

    beginTest("mirror: the dirty flag is the ONE truth (an equal-length "
              "collapse rewrites the WAV); a newer bundle is refused");
    {
      StackNode root("SessionRoot");
      root.setQuantum(Q, 0);
      auto clip = std::make_unique<ClipNode>("Take", (double)Q);
      clip->origin_samples.store(0);
      clip->duration_samples.store(2 * Q);
      // Bar 1 = +0.25, bar 2 = -0.5: a one-sample read tells them apart.
      juce::AudioBuffer<float> audio(1, (int)(2 * Q));
      for (int i = 0; i < audio.getNumSamples(); ++i)
        audio.setSample(0, i, i < Q ? 0.25f : -0.5f);
      clip->loadCommitted(audio, /*context_cycle=*/2 * Q);
      ClipNode* c = clip.get();
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("mirror_dirty");
      const juce::File wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      session_io::SaveOptions inc;
      inc.incremental = true;
      auto wavFacts = [&](int64_t& length, float& first) {
        juce::WavAudioFormat fmt;
        std::unique_ptr<juce::AudioFormatReader> r(
            fmt.createReaderFor(wav.createInputStream().release(), true));
        if (r == nullptr) {
          length = -1;
          first = 0.0f;
          return;
        }
        length = r->lengthInSamples;
        juce::AudioBuffer<float> b(1, 1);
        r->read(&b, 0, 1, 0, true, false);
        first = b.getSample(0, 0);
      };
      int64_t len = 0;
      float first = 0.0f;

      expect(session_io::save(root, (double)Q, dir, inc), "first save");
      wavFacts(len, first);
      expectEquals(len, (int64_t)(2 * Q), "full take mirrored");
      expectWithinAbsoluteError(first, 0.25f, 1e-6f, "bar 1 first");

      // Collapse to [0, Q): a length change — any probe would catch it.
      c->collapseContent(0, Q);
      expect(c->takeFilesDirty(), "collapse marks the mirror dirty");
      expect(session_io::save(root, (double)Q, dir, inc), "save 2");
      wavFacts(len, first);
      expectEquals(len, (int64_t)Q, "collapsed length");
      expectWithinAbsoluteError(first, 0.25f, 1e-6f, "bar 1 still");
      expect(!c->takeFilesDirty(), "the mirror cleared the flag");

      // Now the SAME length, a different bar: [Q, 2Q). A length probe
      // would skip this rewrite and the reload would play bar 1.
      c->uncollapseContent(0, 2 * Q);
      c->collapseContent(Q, Q);
      expect(c->takeFilesDirty(), "dirty again");
      expect(session_io::save(root, (double)Q, dir, inc), "save 3");
      wavFacts(len, first);
      expectEquals(len, (int64_t)Q, "same length");
      expectWithinAbsoluteError(first, -0.5f, 1e-6f,
                                "bar 2 mirrored: the flag, not the length, "
                                "decided");

      // Not dirty and the file present: an incremental save is a no-op
      // on the WAV (mtime-free check: the content stays bar 2).
      expect(session_io::save(root, (double)Q, dir, inc), "save 4");
      wavFacts(len, first);
      expectWithinAbsoluteError(first, -0.5f, 1e-6f, "unchanged");

      // VERSION GUARD: a bundle newer than this build is refused; the
      // current and an unversioned (legacy) bundle load.
      const juce::File jf = dir.getChildFile("session.json");
      auto stampVersion = [&](juce::var version) {
        juce::var v = juce::JSON::parse(jf.loadFileAsString());
        if (version.isVoid())
          v.getDynamicObject()->removeProperty("version");
        else
          v.getDynamicObject()->setProperty("version", version);
        expect(jf.replaceWithText(juce::JSON::toString(v)), "rewrite json");
      };
      stampVersion(session_io::kSessionVersion + 1);
      expect(!session_io::load(dir, (double)Q).ok, "newer bundle refused");
      stampVersion(session_io::kSessionVersion);
      expect(session_io::load(dir, (double)Q).ok, "current version loads");
      stampVersion(juce::var());
      expect(session_io::load(dir, (double)Q).ok, "unversioned bundle loads");
    }

    beginTest(
        "the top and the re-time round-trip as QTime facts (loopTopQ, "
        "retimeQ); a bundle without them loads unset / as played; a "
        "template strips them");
    {
      // loop_selection.md §9: the top is a raw content position, the
      // re-time a signed origin offset — both musical, stored like
      // originQ. A free (sub-Q) value must survive exactly.
      StackNode root("TopRoot");
      root.setQuantum(Q, zero);
      auto clip = std::make_unique<ClipNode>("Keys", (double)Q);
      clip->origin_samples.store(zero + 2 * Q - 777);  // re-timed, off the grid
      clip->duration_samples.store(4 * Q);
      clip->setLoopPoints(Q, 3 * Q);
      clip->setStoredTop(2 * Q + 123);
      clip->setRetime(-777);
      juce::AudioBuffer<float> audio(1, (int)(4 * Q));
      audio.clear();
      clip->loadCommitted(audio, 0);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));
      auto plain = std::make_unique<ClipNode>("Bass", (double)Q);
      plain->origin_samples.store(zero);
      plain->duration_samples.store(2 * Q);
      juce::AudioBuffer<float> bass(1, (int)(2 * Q));
      bass.clear();
      plain->loadCommitted(bass, 0);
      root.addChild(std::move(plain));

      auto dir = freshTempDir("top_retime");
      expect(session_io::save(root, (double)Q, dir), "save");
      const juce::File jf = dir.getChildFile("session.json");
      const juce::var json = juce::JSON::parse(jf.loadFileAsString());
      const juce::var rec = (*json.getProperty("root", {})
                                  .getProperty("nodes", {})
                                  .getArray())[0];
      // QTime in lowest terms: (2Q + 123)/Q = 32041/16000 at Q = 48000.
      const auto qOf = [](const juce::var& v) {
        return timing::qtime((int64_t)(double)v.getProperty("num", 0),
                             (int64_t)(double)v.getProperty("den", 1));
      };
      const timing::QTime topQ = qOf(rec.getProperty("loopTopQ", {}));
      expect(timing::qeq(topQ, timing::fromSamples(2 * Q + 123, Q)),
             "loopTopQ is the top as a QTime of Q");
      const timing::QTime retimeQ = qOf(rec.getProperty("retimeQ", {}));
      expect(timing::qeq(retimeQ, timing::fromSamples(-777, Q)),
             "retimeQ is the re-time as a (signed) QTime of Q");
      const juce::var rec2 = (*json.getProperty("root", {})
                                   .getProperty("nodes", {})
                                   .getArray())[1];
      expect(!rec2.hasProperty("loopTopQ") && !rec2.hasProperty("retimeQ"),
             "additive: an unset top and an as-played take write nothing");

      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok, "load");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      auto* p = dynamic_cast<ClipNode*>(loaded.children[1].get());
      expect(c != nullptr && c->getUuid() == uuid, "the clip");
      expectEquals((juce::int64)c->storedTop(), (juce::int64)(2 * Q + 123),
                   "the top round-trips exactly");
      expectEquals((juce::int64)c->retime(), (juce::int64)-777,
                   "the re-time round-trips exactly");
      expectEquals((juce::int64)c->origin_samples.load(),
                   (juce::int64)(zero + 2 * Q - 777), "the re-timed origin too");
      expectEquals((juce::int64)p->storedTop(), (juce::int64)timing::kNoTop,
                   "an absent key: the top unset");
      expectEquals((juce::int64)p->retime(), (juce::int64)0,
                   "an absent key: as played");

      // A bundle from before 2026-09-24 has neither key: it loads with
      // the top unset and the take as played.
      {
        juce::var v = juce::JSON::parse(jf.loadFileAsString());
        auto* first = (*v.getProperty("root", {}).getProperty("nodes", {})
                            .getArray())[0].getDynamicObject();
        first->removeProperty("loopTopQ");
        first->removeProperty("retimeQ");
        expect(jf.replaceWithText(juce::JSON::toString(v)), "rewrite json");
        auto legacy = session_io::load(dir, (double)Q);
        auto* lc = dynamic_cast<ClipNode*>(legacy.children[0].get());
        expectEquals((juce::int64)lc->storedTop(), (juce::int64)timing::kNoTop,
                     "legacy: top unset");
        expectEquals((juce::int64)lc->retime(), (juce::int64)0,
                     "legacy: as played");
        expectEquals((juce::int64)lc->effectiveTop(), (juce::int64)Q,
                     "legacy: the published top is the region start");
      }

      // A template keeps structure, never performances.
      session_io::SaveOptions tpl;
      tpl.strip_performances = true;
      auto tdir = freshTempDir("top_retime_tpl");
      expect(session_io::save(root, (double)Q, tdir, tpl), "template save");
      const juce::var tjson =
          juce::JSON::parse(tdir.getChildFile("session.json").loadFileAsString());
      const juce::var trec = (*tjson.getProperty("root", {})
                                   .getProperty("nodes", {})
                                   .getArray())[0];
      expect(!trec.hasProperty("loopTopQ") && !trec.hasProperty("retimeQ"),
             "a template strips the top and the re-time");
    }
  }
};

static SessionIoTests sessionIoTests;

}  // namespace celestrian
