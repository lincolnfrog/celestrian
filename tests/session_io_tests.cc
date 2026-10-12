/**
 * Save / Load round-trip tests (src/session_io.h).
 *
 * The canonical-state check: anything needed to reload that is NOT
 * serialized is wrongly treated as derived. Pins the QTime-based format,
 * the buffer/contextCycle fidelity, the mixer and routing keys and their
 * defaults when absent, a MIDI clip's take list, and what a load leaves
 * on a LIVE root (its song, its rack) when one project replaces another
 * on the same engine.
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/dsp/fx_chain.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "../src/timing.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::loadedClip;
using test_utils::freshTempDir;

class SessionIoTests : public juce::UnitTest {
 public:
  SessionIoTests() : juce::UnitTest("Save / Load (session_io)") {}

  void runTest() override {
    const int64_t Q = 48000;      // 48 kHz island
    const int64_t zero = 12345;  // island zero, absolute samples

    // `root` saved into a fresh bundle `label` and loaded back, both at
    // the island's rate and both expected to succeed.
    const auto roundTrip = [&](const StackNode& root, const juce::String& label,
                               const session_io::SaveOptions& opts = {}) {
      bool saved = false;
      auto trip = test_utils::roundTrip(root, (double)Q, label, opts, &saved);
      expect(saved, label + ": save");
      expect(trip.loaded.ok, label + ": load ok");
      return trip;
    };
    // A record's {num, den} value as a QTime.
    const auto qOf = [](const juce::var& v) {
      return timing::qtime((int64_t)(double)v.getProperty("num", 0),
                           (int64_t)(double)v.getProperty("den", 1));
    };
    const auto sine = [](int64_t i) { return std::sin((float)i * 0.001f); };

    beginTest("round-trip preserves the canonical clip facts + audio");
    {
      // Build a graph by hand: a committed clip + a nested stack.
      StackNode root("SessionRoot");
      root.setQuantum(Q, zero);
      root.is_muted.store(false);

      // Performed at heard 2Q; a deterministic sine fills the buffer.
      auto clip = loadedClip("Guitar", (double)Q, zero + 2 * Q, 4 * Q, sine,
                             /*context_cycle=*/6 * Q);
      clip->setLoopPoints(Q, 3 * Q);  // window [1Q, 3Q)
      clip->setLoopWindowBypassed(false);
      clip->is_muted.store(true);
      clip->setInputChannel(2);
      // The rack (docs/vst3.md): reorder echo to the head so the
      // round-trip pins ORDER as well as params, then enable it.
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

      const juce::String clipUuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto nested = std::make_unique<StackNode>("Drums");
      const juce::String nestedUuid = nested->getUuid();
      root.addChild(std::move(nested));

      auto [dir, loaded] = roundTrip(root, "roundtrip");
      expect(dir.getChildFile("session.json").existsAsFile(), "json written");
      expect(dir.getChildFile("audio")
                 .getChildFile(clipUuid + ".wav")
                 .existsAsFile(),
             "clip wav written");
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
        maxErr = std::max(maxErr, std::abs(rb.getSample(0, i) - sine(i)));
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
      auto* ghost = dynamic_cast<dsp::Vst3Slot*>(loaded_slots[0].get());
      expect(ghost != nullptr && ghost->isMissing(), "loaded as placeholder");
      expectEquals(ghost->pluginUid(), juce::String("VST3-ghost-uid"));
      expect(ghost->enabled.load(), "enable flag persisted");
      expect(ghost->isInstrument(), "instrument flag persisted");
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

    beginTest("the mixer and routing keys round-trip (gain, pan, the right "
              "input, a stereo take's WAV, the period source); a bundle "
              "without one of them loads its default");
    {
      StackNode root("KnobRoot");
      root.setQuantum(Q, 0);

      // A stereo one-shot clip with every knob off its default.
      auto clip = std::make_unique<ClipNode>("Overheads", (double)Q);
      clip->duration_samples.store(Q);
      clip->setInputChannel(2);
      clip->setInputChannelRight(3);
      clip->gain.store(0.6f);
      clip->pan.store(-0.25f);
      clip->period_from_context_.store(true);
      // Distinct L/R ramps pin per-channel WAV fidelity.
      juce::AudioBuffer<float> audio(2, (int)Q);
      for (int i = 0; i < (int)Q; ++i) {
        audio.setSample(0, i, std::sin((float)i * 0.001f));
        audio.setSample(1, i, std::cos((float)i * 0.002f));
      }
      clip->loadCommitted(audio, 0);
      root.addChild(std::move(clip));

      // A group with its own fader and pan, and a plain mono loop.
      auto group = std::make_unique<StackNode>("Kit");
      group->gain.store(0.3f);
      group->pan.store(0.5f);
      const juce::String group_uuid = group->getUuid();
      root.addChild(std::move(group));
      root.addChild(loadedClip("Loop", (double)Q, 0, Q, 0.0f));

      auto [dir, loaded] = roundTrip(root, "knobs");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr, "clip restored");
      expectEquals(c->getInputChannel(), 2, "left input restored");
      expectEquals(c->getInputChannelRight(), 3, "right input restored");
      expectWithinAbsoluteError(c->gain.load(), 0.6f, 1.0e-6f,
                                "clip gain restored");
      expectWithinAbsoluteError(c->pan.load(), -0.25f, 1.0e-6f,
                                "clip pan restored");
      expect(c->period_from_context_.load(), "one-shot restored");
      expectEquals(c->contentChannels(), 2, "stereo content restored");
      const auto& restored = c->getAudioBuffer();
      int differing = restored.getNumChannels() == 2 &&
                              restored.getNumSamples() >= (int)Q
                          ? 0
                          : -1;
      for (int ch = 0; ch < 2 && differing >= 0; ++ch)
        for (int i = 0; i < (int)Q; ++i)
          if (restored.getSample(ch, i) != audio.getSample(ch, i)) ++differing;
      expectEquals(differing, 0,
                   "stereo audio lossless on both channels, every sample "
                   "(32-bit float wav)");

      auto* g = dynamic_cast<StackNode*>(loaded.children[1].get());
      expect(g != nullptr && g->getUuid() == group_uuid, "group restored");
      expectWithinAbsoluteError(g->gain.load(), 0.3f, 1.0e-6f,
                                "group gain restored");
      expectWithinAbsoluteError(g->pan.load(), 0.5f, 1.0e-6f,
                                "group pan restored");
      expect(!loaded.children[2]->period_from_context_.load(),
             "loop stays a loop");

      // Each key alone taken out of the clip's record: it loads the
      // knob's default, which for the fader and the right input is not
      // the 0 an absent var reads as.
      struct AbsentKey {
        const char* key;
        std::function<double(const ClipNode&)> read;
        double fallback;
        const char* law;
      };
      const AbsentKey absent_keys[] = {
          {"gain", [](const ClipNode& n) { return (double)n.gain.load(); },
           1.0, "absent gain defaults to unity"},
          {"pan", [](const ClipNode& n) { return (double)n.pan.load(); }, 0.0,
           "absent pan defaults to center"},
          {"inputChannelR",
           [](const ClipNode& n) { return (double)n.getInputChannelRight(); },
           -1.0, "absent inputChannelR defaults to mono"},
          {"periodSource",
           [](const ClipNode& n) {
             return n.period_from_context_.load() ? 1.0 : 0.0;
           },
           0.0, "absent periodSource = loop"},
      };
      for (const auto& absent : absent_keys) {
        const juce::String key = absent.key;
        bool had_key = false;
        auto legacy = test_utils::reloadWithoutKeys(dir, 0, {absent.key},
                                                      (double)Q, &had_key);
        expect(had_key, key + ": key was present to strip");
        expect(legacy.ok, key + ": legacy load ok");
        auto* lc = legacy.children.empty()
                       ? nullptr
                       : dynamic_cast<ClipNode*>(legacy.children[0].get());
        expect(lc != nullptr, key + ": legacy clip loads");
        if (lc == nullptr) continue;
        expectWithinAbsoluteError(absent.read(*lc), absent.fallback, 1.0e-6,
                                  absent.law);
      }
    }

    beginTest(
        "multi-segment maps round-trip (segmentsQ) and templates "
        "strip them");
    {
      StackNode root("SegRoot");
      root.setQuantum(Q, zero);

      // A committed clip carrying a cell map, and a mapped nested stack.
      auto clip = loadedClip("Cells", (double)Q, zero, 4 * Q, 0.0f, 4 * Q);
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

      auto loaded = roundTrip(root, "segments").loaded;

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
      StackNode root2("SegRoot2");
      root2.setQuantum(Q, zero);
      for (auto& ch : loaded.children) root2.addChild(std::move(ch));
      auto loaded2 = roundTrip(root2, "segments2").loaded;
      expect(loaded2.ok && loaded2.children[0]->storedMap().n == 2,
             "stable across a second round trip");

      // Templates strip the map with the window.
      session_io::SaveOptions strip;
      strip.strip_performances = true;
      auto loaded3 = roundTrip(root2, "segments-template", strip).loaded;
      expect(loaded3.ok && !loaded3.children[0]->hasSegmentMap(),
             "template strips the map");
    }

    beginTest(
        "a MIDI clip's takes round-trip: every take's notes and positions, "
        "the active take, the comp");
    {
      const auto note = [](int64_t pos, int status, int key, int velocity) {
        MidiEvent e;
        e.pos = pos;
        e.size = 3;
        e.bytes[0] = (juce::uint8)status;
        e.bytes[1] = (juce::uint8)key;
        e.bytes[2] = (juce::uint8)velocity;
        return e;
      };
      // Three takes of one 2Q slot: positions on and off the Q grid, two
      // channels, the last event one sample inside the take's end.
      const std::vector<std::vector<MidiEvent>> takes = {
          {note(0, 0x90, 60, 100), note(Q / 2, 0x80, 60, 0)},
          {note(Q / 4, 0x91, 64, 90), note(Q, 0x81, 64, 0),
           note(Q + 123, 0x91, 67, 70), note(2 * Q - 1, 0x81, 67, 0)},
          {note(Q / 3, 0x90, 72, 127), note(Q / 3 + 7, 0x90, 76, 1),
           note(Q, 0x80, 72, 0), note(Q + 1, 0x80, 76, 0)},
      };
      const std::vector<int> comp = {0, 2};  // cell 0: take 0, cell 1: take 2

      StackNode root("MidiRoot");
      root.setQuantum(Q, zero);
      auto clip = std::make_unique<ClipNode>("Keys", (double)Q);
      clip->origin_samples.store(zero);
      clip->duration_samples.store(2 * Q);
      clip->loadCommittedMidi(takes[0], 2 * Q);
      clip->appendLoadedMidiTake(takes[1]);
      clip->appendLoadedMidiTake(takes[2]);
      expect(clip->selectTake(1), "take 1 made the active one");
      clip->setCompCells(comp, Q);
      root.addChild(std::move(clip));

      const auto expectTakes = [&](const ClipNode* c,
                                   const juce::String& pass) {
        expect(c != nullptr, pass + ": the clip");
        if (c == nullptr) return;
        expect(c->contentKind() == ClipNode::ContentKind::Midi,
               pass + ": a MIDI clip");
        expectEquals(c->takeCount(), 3, pass + ": three takes");
        expectEquals(c->activeTake(), 1, pass + ": take 1 is the active one");
        for (int k = 0; k < 3; ++k) {
          const juce::String at = pass + ": take " + juce::String(k);
          const MidiSequence* seq = c->takeMidi(k);
          expect(seq != nullptr, at + " holds a sequence");
          if (seq == nullptr) continue;
          const auto got = seq->snapshot();
          const auto& want = takes[(size_t)k];
          expectEquals(got.size(), want.size(), at + ": event count");
          for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
            expectEquals((juce::int64)got[i].pos, (juce::int64)want[i].pos,
                         at + ": position exact");
            expect(got[i].size == want[i].size &&
                       got[i].bytes[0] == want[i].bytes[0] &&
                       got[i].bytes[1] == want[i].bytes[1] &&
                       got[i].bytes[2] == want[i].bytes[2],
                   at + ": bytes verbatim");
          }
        }
        expect(c->compCells() == comp, pass + ": the comp's cells");
        expectEquals((juce::int64)c->compCellLength(), (juce::int64)Q,
                     pass + ": the comp's cell length");
      };

      auto loaded = roundTrip(root, "midi_takes").loaded;
      expect(loaded.ok && loaded.children.size() == 1, "load ok");
      expectTakes(dynamic_cast<ClipNode*>(loaded.children[0].get()), "load");

      // The mirror re-saves a loaded session at once: what it writes must
      // load the same again (the active take is not take 0 here).
      StackNode root2("MidiRoot2");
      root2.setQuantum(Q, zero);
      for (auto& child : loaded.children) root2.addChild(std::move(child));
      auto again = roundTrip(root2, "midi_takes2").loaded;
      expect(again.ok && again.children.size() == 1, "reload ok");
      expectTakes(dynamic_cast<ClipNode*>(again.children[0].get()), "reload");
    }

    // One bundle per call: a root whose song is `step_names` (2Q each),
    // none when the list is empty, with a master echo at `echo_mix` when
    // that is positive.
    const auto bundleOf = [&](const juce::String& label,
                              const juce::StringArray& step_names,
                              double echo_mix) {
      StackNode root("SongRoot");
      root.setQuantum(Q, 0);
      if (!step_names.isEmpty()) {
        auto* seq = new Sequence();
        for (const auto& name : step_names) {
          Sequence::Step step;
          step.len = 2 * Q;
          step.name = name;
          seq->steps.push_back(step);
        }
        seq->finalize();
        delete root.exchangeSequence(seq);
      }
      if (echo_mix > 0.0) {
        for (const auto& slot : root.fxChain()->slots()) {
          if (juce::String(slot->typeId()) != "echo") continue;
          slot->prepare((double)Q);
          slot->setParam("mix", echo_mix);
          slot->enabled.store(true);
        }
      }
      auto dir = freshTempDir(label);
      expect(session_io::save(root, (double)Q, dir), "save " + label);
      return dir;
    };
    const auto songOf = [](AudioEngine& engine) {
      juce::StringArray names;
      const juce::var seq =
          engine.getGraphState().getProperty("sequence", juce::var());
      if (auto* steps = seq.getProperty("steps", juce::var()).getArray())
        for (const auto& step : *steps)
          names.add(step.getProperty("name", "").toString());
      return names;
    };
    const auto masterEcho = [](AudioEngine& engine) {
      const juce::var chain = engine.getGraphState()
                                  .getProperty("effects", juce::var())
                                  .getProperty("chain", juce::var());
      if (auto* entries = chain.getArray())
        for (const auto& entry : *entries)
          if (entry.getProperty("type", "").toString() == "echo") return entry;
      return juce::var();
    };

    beginTest("one engine, three projects: the live root's song is the "
              "loaded project's each time");
    {
      const auto with_song = bundleOf("reload_song", {"verse", "chorus"}, 0.0);
      const auto without = bundleOf("reload_no_song", {}, 0.0);
      const auto other = bundleOf("reload_other", {"intro", "a", "b"}, 0.0);

      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      expect(engine.loadSession(with_song.getFullPathName()), "load a song");
      expect(songOf(engine) == juce::StringArray({"verse", "chorus"}),
             "the first project's song");
      expect(engine.loadSession(without.getFullPathName()), "load no song");
      expect(songOf(engine).isEmpty(),
             "a project without a song leaves none on the root");
      expect(engine.loadSession(other.getFullPathName()), "load another song");
      expect(songOf(engine) == juce::StringArray({"intro", "a", "b"}),
             "the third project's song, not the first's");
      expect(engine.loadSession(with_song.getFullPathName()), "and back");
      expect(songOf(engine) == juce::StringArray({"verse", "chorus"}),
             "a song replaces a song");
      // The displaced songs went to the reclaimer; blocks after the loads
      // run the live one.
      test_utils::driveEngine(engine, 4096);
    }

    beginTest("a bundle whose root has no rack, or a song with no step of "
              "positive length, leaves nothing of the previous project");
    {
      const auto loud = bundleOf("reload_loud", {"verse", "chorus"}, 0.42);
      const double default_mix =
          (double)dsp::FxChain::makeDefault()
              ->getMetadata()[2]
              .getProperty("mix", -1.0);

      // A version-1 bundle with no root keys at all.
      const auto bare = freshTempDir("reload_bare");
      expect(bare.getChildFile("session.json")
                 .replaceWithText("{\"version\":1,\"qSamples\":0,"
                                  "\"epoch\":0,\"nodes\":[]}"),
             "write the bare bundle");
      // A root record with no `effects` and a song whose only step has no
      // length.
      const auto hollow = freshTempDir("reload_hollow");
      expect(hollow.getChildFile("session.json")
                 .replaceWithText(
                     "{\"version\":3,\"qSamples\":48000,\"zero\":0,"
                     "\"root\":{\"type\":\"stack\",\"sequence\":{\"steps\":"
                     "[{\"name\":\"x\",\"lenQ\":{\"num\":0,\"den\":1}}],"
                     "\"gates\":{}},\"nodes\":[]}}"),
             "write the hollow bundle");

      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      for (const auto& empty : {bare, hollow}) {
        const juce::String which = empty.getFileName();
        expect(engine.loadSession(loud.getFullPathName()), "load the rack");
        expect((bool)masterEcho(engine).getProperty("enabled", false) &&
                   !songOf(engine).isEmpty(),
               "the first project's echo and song are live");
        // The root is the engine's own node across every load.
        auto* live_root = dynamic_cast<StackNode*>(engine.findNodeByUuidForTest(
            engine.getGraphState().getProperty("id", "").toString()));
        expect(live_root != nullptr, "the live root");
        if (live_root == nullptr) continue;
        live_root->setSequenceBypassed(true);
        expect(engine.loadSession(empty.getFullPathName()), "load " + which);
        expect(!live_root->isSequenceBypassed(),
               which + ": the previous project's song bypass is not on the root");
        expect(!(bool)masterEcho(engine).getProperty("enabled", true),
               which + ": the previous project's echo is not on the root");
        expectWithinAbsoluteError(
            (double)masterEcho(engine).getProperty("mix", -1.0), default_mix,
            1e-6, which + ": the root's rack is the default one");
        expect(songOf(engine).isEmpty(),
               which + ": the previous project's song is not on the root");
      }
    }

    beginTest("a loaded track's rack is prepared at the DEVICE's rate, "
              "whatever rate the bundle was saved at");
    {
      StackNode root("RateRoot");
      root.setQuantum(Q, 0);
      auto clip = std::make_unique<ClipNode>("Echoed", (double)Q);
      // Half a second, fully wet, no feedback: an impulse returns once,
      // `rate / 2` samples later.
      for (const auto& slot : clip->fxChain()->slots()) {
        if (juce::String(slot->typeId()) != "echo") continue;
        slot->prepare((double)Q);
        slot->setParam("time", 0.5);
        slot->setParam("feedback", 0.0);
        slot->setParam("mix", 1.0);
        slot->enabled.store(true);
      }
      root.addChild(std::move(clip));
      auto dir = freshTempDir("rack_rate");
      expect(session_io::save(root, (double)Q, dir), "saved at 48 kHz");

      const double device_rate = 44100.0;
      auto loaded = session_io::load(dir, device_rate);
      expect(loaded.ok && loaded.children.size() == 1, "load ok");
      std::vector<float> block(30000, 0.0f);
      block[0] = 1.0f;
      loaded.children[0]->fxChain()->process(block.data(), (int)block.size());
      int echo_at = -1;
      for (int i = 1; i < (int)block.size() && echo_at < 0; ++i)
        if (block[(size_t)i] != 0.0f) echo_at = i;
      expectEquals(echo_at, (int)(device_rate / 2),
                   "the echo is timed on the device's rate");
    }

    beginTest("AudioEngine save -> load populates the graph and is stable");
    {
      // Build a source bundle from a hand graph, load it into an engine.
      StackNode src("SessionRoot");
      src.setQuantum(Q, zero);
      src.addChild(loadedClip("Bass", (double)Q, zero, 2 * Q, 0.25f));

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
      // The bundle carries the zero; a fresh engine's clock (0) is
      // behind it, so the engine seats it there (session_io::load).
      expectEquals((juce::int64)session_io::load(dir, (double)Q).zero,
                   (juce::int64)zero, "island zero loaded");
      expectEquals((juce::int64)(double)state.getProperty("zero", -1), (juce::int64)0,
                   "...seated at the fresh engine's clock");

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
        "the root is ONE node record: window, map, bypass, "
        "period source, window domain, stage, rack and song round-trip");
    {
      // Every fact a nested stack persists, set on a hand root: the
      // root's record carries them all, and no second bundle-level path.
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

      auto [dir, loaded] = roundTrip(root, "root_record");
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
               "no second root path at bundle level");
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
      expectEquals(
          (juce::int64)timing::toSamples(
              qOf(again.root.getProperty("windowStartQ", juce::var())), Q),
          (juce::int64)Q, "the root window survives a re-save");
    }

    beginTest("a version-1 bundle's bundle-level root keys load as the root's "
              "record; absent keys read unity / center");
    {
      // Version 1's shape: rootMuted / rootGain / rootPan / rootSequence
      // beside `nodes`.
      auto legacy = freshTempDir("root_v1");
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
      // A bundle older than version 3 names the island zero `epoch`
      // (frame.md §7): that key loads as the zero, not as 0.
      expectEquals((juce::int64)session_io::load(legacy, (double)Q).zero,
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

      // A bundle with no root keys at all loads unity / center, never
      // silent.
      auto bare = freshTempDir("root_v1_bare");
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
      // Bar 1 = +0.25, bar 2 = -0.5: a one-sample read tells them apart.
      auto clip = loadedClip(
          "Take", (double)Q, 0, 2 * Q,
          [&](int64_t i) { return i < Q ? 0.25f : -0.5f; },
          /*context_cycle=*/2 * Q);
      ClipNode* c = clip.get();
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("mirror_dirty");
      const juce::File wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      session_io::SaveOptions inc;
      inc.incremental = true;
      auto wavFacts = [&](int64_t& length, float& first) {
        const juce::AudioBuffer<float> audio = test_utils::readWav(wav);
        length = audio.getNumSamples();
        first = length > 0 ? audio.getSample(0, 0) : 0.0f;
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
      // Re-timed, off the grid.
      auto clip =
          loadedClip("Keys", (double)Q, zero + 2 * Q - 777, 4 * Q, 0.0f);
      clip->setLoopPoints(Q, 3 * Q);
      clip->setStoredTop(2 * Q + 123);
      clip->setRetime(-777);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));
      root.addChild(loadedClip("Bass", (double)Q, zero, 2 * Q, 0.0f));

      auto [dir, loaded] = roundTrip(root, "top_retime");
      const juce::var json = juce::JSON::parse(
          dir.getChildFile("session.json").loadFileAsString());
      const juce::var rec = (*json.getProperty("root", {})
                                  .getProperty("nodes", {})
                                  .getArray())[0];
      // QTime in lowest terms: (2Q + 123)/Q = 32041/16000 at Q = 48000.
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

      // A bundle with neither key loads with the top unset and the take
      // as played.
      {
        bool had_keys = false;
        auto legacy = test_utils::reloadWithoutKeys(
            dir, 0, {"loopTopQ", "retimeQ"}, (double)Q, &had_keys);
        expect(had_keys, "both keys were there to strip");
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

    beginTest("the top and the re-time are every node's facts: a group's "
              "and the root's round-trip like a clip's, and a load leaves "
              "none of the previous session's on the live root");
    {
      const int64_t root_top = 2 * Q + 5, root_retime = -48;
      const int64_t group_top = Q / 2, group_retime = -321;
      StackNode root("TopsRoot");
      root.setQuantum(Q, 0);
      root.setLoopPoints(Q, 5 * Q);
      root.setStoredTop(root_top);
      root.setRetime(root_retime);
      // An empty group: no content has anchored it.
      auto group = std::make_unique<StackNode>("Kit");
      group->setStoredTop(group_top);
      group->setRetime(group_retime);
      root.addChild(std::move(group));
      auto [with_tops, loaded] = roundTrip(root, "node_tops");

      const auto samplesOf = [&](const juce::var& record, const char* key) {
        return timing::toSamples(qOf(record.getProperty(key, {})), Q);
      };
      const juce::var root_record =
          juce::JSON::parse(
              with_tops.getChildFile("session.json").loadFileAsString())
              .getProperty("root", {});
      expect(root_record.hasProperty("loopTopQ") &&
                 root_record.hasProperty("retimeQ"),
             "the root's record carries both keys");
      expectEquals((juce::int64)samplesOf(root_record, "loopTopQ"),
                   (juce::int64)root_top, "the root's top, as a QTime of Q");
      expectEquals((juce::int64)samplesOf(root_record, "retimeQ"),
                   (juce::int64)root_retime, "the root's re-time");

      expectEquals(loaded.children.size(), (size_t)1, "the group is back");
      if (loaded.children.size() == 1) {
        const AudioNode& g = *loaded.children[0];
        expectEquals((juce::int64)g.storedTop(), (juce::int64)group_top,
                     "a group's top round-trips, anchored or not");
        expectEquals((juce::int64)g.retime(), (juce::int64)group_retime,
                     "a group's re-time round-trips");
      }

      // The LIVE root takes its record's values, then a project that
      // has neither key: nothing of the first one stays.
      const auto plain = bundleOf("node_tops_plain", {}, 0.0);
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      expect(engine.loadSession(with_tops.getFullPathName()), "load the tops");
      // The root is the engine's own node across every load.
      const AudioNode* live_root = engine.findNodeByUuidForTest(
          engine.getGraphState().getProperty("id", "").toString());
      expect(live_root != nullptr, "the live root");
      if (live_root != nullptr) {
        expectEquals((juce::int64)live_root->storedTop(),
                     (juce::int64)root_top,
                     "the live root reads its record's top");
        expectEquals((juce::int64)live_root->retime(),
                     (juce::int64)root_retime,
                     "the live root reads its record's re-time");
        expect(engine.loadSession(plain.getFullPathName()), "load the plain");
        expectEquals((juce::int64)live_root->storedTop(),
                     (juce::int64)timing::kNoTop,
                     "absent key: the previous project's top is gone");
        expectEquals((juce::int64)live_root->retime(), (juce::int64)0,
                     "absent key: the previous project's re-time is gone");
      }
    }

    beginTest("Sequence::sameSong compares the authored song: steps, "
              "successors, gate rows over the song's steps, the seed");
    {
      const auto song = [] {
        Sequence s;
        Sequence::Step verse;
        verse.len = 2 * Q;
        verse.name = "verse";
        verse.next = {{1, 3}, {0, 1}};
        Sequence::Step chorus;
        chorus.len = Q;
        chorus.name = "chorus";
        chorus.cue = true;
        chorus.fade_in = 100;
        chorus.fade_out = 200;
        s.steps = {verse, chorus};
        s.gates = {{"bass", 0b01}, {"keys", 0b11}};
        s.seed = 7;
        s.finalize();
        return s;
      };
      const Sequence base = song();
      // `edit` changes one authored fact of a fresh copy of the song.
      const auto differs = [&](const std::function<void(Sequence&)>& edit) {
        Sequence other = song();
        edit(other);
        other.finalize();
        return !Sequence::sameSong(&base, &other) &&
               !Sequence::sameSong(&other, &base);
      };

      expect(Sequence::sameSong(nullptr, nullptr), "no song is no song");
      expect(!Sequence::sameSong(&base, nullptr) &&
                 !Sequence::sameSong(nullptr, &base),
             "a song is not no song");
      const Sequence twin = song();
      expect(Sequence::sameSong(&base, &twin), "the same facts, another object");

      expect(differs([](Sequence& s) { s.seed = 8; }), "the seed");
      expect(differs([](Sequence& s) { s.steps.pop_back(); }), "a step fewer");
      expect(differs([](Sequence& s) { s.steps[0].len += 1; }), "a length");
      expect(differs([](Sequence& s) { s.steps[0].name = "intro"; }), "a name");
      expect(differs([](Sequence& s) { s.steps[0].cue = true; }), "a cue");
      expect(differs([](Sequence& s) { s.steps[1].fade_in = 0; }), "a fade in");
      expect(differs([](Sequence& s) { s.steps[1].fade_out = 0; }),
             "a fade out");
      expect(differs([](Sequence& s) { s.steps[0].next[0].weight = 4; }),
             "a successor's weight");
      expect(differs([](Sequence& s) { s.steps[0].next[0].to = 0; }),
             "a successor's target");
      expect(differs([](Sequence& s) { s.steps[0].next.pop_back(); }),
             "a successor fewer");
      expect(differs([](Sequence& s) {
               std::swap(s.steps[0].next[0], s.steps[0].next[1]);
             }),
             "the successors' order");
      expect(differs([](Sequence& s) { s.gates[0].mask = 0b11; }),
             "a gate bit of a step");
      expect(differs([](Sequence& s) { s.gates[0].uuid = "drums"; }),
             "a gate row's child");
      expect(differs([](Sequence& s) { s.gates.pop_back(); }),
             "a gate row fewer");
      expect(differs([](Sequence& s) { std::swap(s.gates[0], s.gates[1]); }),
             "the gate rows' order");

      // A gate row speaks for the song's steps alone.
      Sequence past_the_song = song();
      past_the_song.gates[0].mask |= 0b100;
      expect(Sequence::sameSong(&base, &past_the_song),
             "a gate bit past the last step does not count");
    }
  }
};

static SessionIoTests sessionIoTests;

}  // namespace celestrian
