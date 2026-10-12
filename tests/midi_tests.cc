#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <cstring>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/midi_input_queue.h"
#include "../src/sequence.h"
#include "../src/stack_node.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** A one-event note-on buffer at offset 0. */
juce::MidiBuffer noteOnBuffer() {
  juce::MidiBuffer midi;
  midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100), 0);
  return midi;
}

/** A song of whole steps with the given lengths (no gate rows). */
const Sequence* songOf(std::initializer_list<int64_t> step_lengths) {
  auto* song = new Sequence();
  for (int64_t len : step_lengths) song->steps.push_back({len, "step"});
  song->finalize();
  return song;
}

}  // namespace

/**
 * Live MIDI (docs/vst3.md §8): the lock-free input queue, the
 * instrument slot's MIDI pass, and the armed-node play-through.
 */
class MidiTests : public juce::UnitTest {
 public:
  MidiTests() : juce::UnitTest("Live MIDI") {}

  void runTest() override {
    const double sr = 44100.0;

    beginTest("MidiInputQueue: push/drain round-trip; SysEx ignored");
    {
      MidiInputQueue queue;
      queue.push(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100));
      queue.push(juce::MidiMessage::controllerEvent(1, 1, 64));
      // SysEx (arbitrary length) is out of scope: ignored at push.
      const juce::uint8 sysex_payload[] = {1, 2, 3, 4, 5, 6, 7, 8};
      queue.push(juce::MidiMessage::createSysExMessage(sysex_payload, 8));

      juce::MidiBuffer out;
      out.ensureSize(1024);
      queue.drainTo(out, 512, 0.0);
      expectEquals(out.getNumEvents(), 2, juce::String("two channel events"));
      int note_ons = 0, controllers = 0;
      for (const auto metadata : out) {
        const auto message = metadata.getMessage();
        expectEquals(metadata.samplePosition, 0, juce::String("offset 0"));
        if (message.isNoteOn()) ++note_ons;
        if (message.isController()) ++controllers;
      }
      expectEquals(note_ons, 1);
      expectEquals(controllers, 1);

      // Drained: a second drain is empty.
      juce::MidiBuffer again;
      again.ensureSize(64);
      queue.drainTo(again, 512, 0.0);
      expectEquals(again.getNumEvents(), 0, juce::String("queue drained"));
    }

    beginTest("MidiInputQueue: wrap-around and overflow accounting");
    {
      MidiInputQueue queue;
      // Several fill/drain cycles push the ring's indices past the end.
      for (int cycle = 0; cycle < 5; ++cycle) {
        const int batch = MidiInputQueue::kCapacity / 2 + 7;
        for (int i = 0; i < batch; ++i)
          queue.push(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100));
        juce::MidiBuffer out;
        out.ensureSize(MidiInputQueue::kCapacity * 4);
        queue.drainTo(out, 512, 0.0);
        expectEquals(out.getNumEvents(), batch,
                     juce::String("cycle drains its batch"));
      }
      expectEquals(queue.droppedCount(), 0, juce::String("no drops yet"));

      // Overflow: pushes beyond capacity drop (and count).
      for (int i = 0; i < MidiInputQueue::kCapacity + 50; ++i)
        queue.push(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100));
      expectGreaterThan(queue.droppedCount(), 0);
      juce::MidiBuffer out;
      out.ensureSize(MidiInputQueue::kCapacity * 4);
      queue.drainTo(out, 512, 0.0);
      expectEquals(out.getNumEvents(), (int)MidiInputQueue::kCapacity - 1,
                   juce::String("capacity bounds the drain"));
    }

    beginTest("instrument slot: heads the chain wherever it was added, and "
              "the effects on either side of the add shape what it generates");
    {
      // The UI's add path appends (index -1) behind the four built-ins;
      // were the synth left there, every built-in would process the
      // silence ahead of it and the synth would overwrite the result —
      // a MIDI track's rack inert. makeFromSlots holds it at the head.
      ClipNode clip("SynthTrack", sr);
      test_utils::installStubSynth(clip, sr);  // appended, as the UI's add
      dsp::FxSlot* comp = nullptr;
      {
        const auto& slots = clip.fxChain()->slots();
        expect(slots.front()->isInstrument(), "instrument heads the chain");
        expectEquals(juce::String(slots[1]->typeId()), juce::String("eq"),
                     "built-ins follow in canonical order");
        for (const auto& s : slots)
          if (juce::String(s->typeId()) == "compressor") comp = s.get();
      }
      expect(comp != nullptr);
      const juce::MidiBuffer midi = noteOnBuffer();
      const float half = test_utils::StubSynthInstance::kLevel * 0.5f;

      // A gain EFFECT added AFTER the synth: the signal the note-on
      // starts flows on through it, from the first sample (0.25 * 0.5).
      auto effect = test_utils::makeStubGainSlot(0.5f);
      effect->enabled.store(true);
      {
        auto slots = clip.fxChain()->slots();
        slots.push_back(effect);
        delete clip.exchangeFxChain(
            dsp::FxChain::makeFromSlots(std::move(slots)).release());
        clip.fxChain()->prepare(sr);
      }
      {
        std::vector<float> l(256, 0.0f), r(256, 0.0f);
        const bool out_stereo =
            clip.fxChain()->run(l.data(), r.data(), 256, false, &midi);
        expect(out_stereo, "instrument promoted the pass");
        expectWithinAbsoluteError(
            l[0], half, 1e-6f, "synth level through the downstream effect, L");
        expectWithinAbsoluteError(r[128], half, 1e-6f, "R");
      }
      effect->enabled.store(false);

      // A built-in that was in the chain BEFORE the synth shapes it too:
      // compressor at unity ratio with -6.02 dB makeup halves the level.
      comp->setParam("threshold", 0.0);
      comp->setParam("ratio", 1.0);
      comp->setParam("makeup", 20.0 * std::log10(0.5));
      comp->enabled.store(true);
      {
        std::vector<float> l(256, 0.0f), r(256, 0.0f);
        clip.fxChain()->run(l.data(), r.data(), 256, false, &midi);
        expectWithinAbsoluteError(
            l[128], half, 1e-5f, "built-in compressor applied to the synth, L");
        expectWithinAbsoluteError(r[128], half, 1e-5f, "R");
      }
    }

    beginTest("clip play-through: armed sounds, disarmed/muted silent");
    {
      ClipNode clip("SynthTrack", sr);
      test_utils::installStubSynth(clip, sr);
      const juce::MidiBuffer midi = noteOnBuffer();

      // Transport stopped, no content.
      test_utils::NodeContext nc = test_utils::contextFor(clip, 256);
      ProcessContext& idle = nc.ctx;
      idle.live_midi = &midi;

      std::vector<float> left(256, 0.0f), right(256, 0.0f);
      float* outs[] = {left.data(), right.data()};

      // Not armed: the context's MIDI is not for this node.
      clip.render(outs, 2, idle);
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "disarmed is silent");

      // Armed: the instrument speaks with no transport and no content.
      clip.midi_armed.store(true);
      clip.render(outs, 2, idle);
      expectWithinAbsoluteError(left[0], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "armed clip sounds, L");
      expectWithinAbsoluteError(right[0],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "armed clip sounds, R");

      // The pan law applies at the output stage, after the chain
      // (docs/vst3.md Q-V1): hard left attenuates R only.
      clip.pan.store(-1.0f);
      std::fill(left.begin(), left.end(), 0.0f);
      std::fill(right.begin(), right.end(), 0.0f);
      clip.render(outs, 2, idle);
      expectWithinAbsoluteError(left[0], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "hard-left keeps L at unity");
      expectWithinAbsoluteError(right[0], 0.0f, 1e-6f, "hard-left silences R");
      clip.pan.store(0.0f);

      // Muted: the same audibility rule content follows.
      clip.is_muted.store(true);
      std::fill(left.begin(), left.end(), 0.0f);
      clip.render(outs, 2, idle);
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "muted stays silent");
      clip.is_muted.store(false);

      // Note-off ends the tone (block-granular stub semantics).
      juce::MidiBuffer off;
      off.addEvent(juce::MidiMessage::noteOff(1, 60), 0);
      ProcessContext idle_off = idle;
      idle_off.live_midi = &off;
      std::fill(left.begin(), left.end(), 0.0f);
      clip.render(outs, 2, idle_off);
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "note-off silences");
    }

    beginTest("a stack that splits its block hands each run its own slice of "
              "the live MIDI: every event once, where it fell");
    {
      // A song on the root cuts the 512-sample block at its step
      // boundary (300). The armed track below is rendered once per run.
      StackNode root("Island");
      auto track = std::make_unique<ClipNode>("SynthTrack", sr);
      auto* synth = test_utils::installStubSynth(*track, sr);
      track->midi_armed.store(true);
      root.addChild(std::move(track));
      delete root.exchangeSequence(songOf({300, 700}));

      juce::MidiBuffer midi;
      midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100), 100);
      midi.addEvent(juce::MidiMessage::noteOff(1, 60), 400);
      const int n = 512;
      test_utils::NodeContext nc = test_utils::contextFor(root, n);
      nc.ctx.live_midi = &midi;
      std::vector<float> left((size_t)n, 0.0f), right((size_t)n, 0.0f);
      float* outs[] = {left.data(), right.data()};
      root.process(nullptr, outs, 0, 2, nc.ctx);

      const float level = test_utils::StubSynthInstance::kLevel;
      expectEquals(synth->note_ons, 1, juce::String("the note-on arrives once"));
      expectEquals(synth->note_offs, 1,
                   juce::String("the note-off past the first run arrives"));
      expect(!synth->note_held, "no note left hanging");
      expectWithinAbsoluteError(left[99], 0.0f, 1e-6f, "silent before the on");
      expectWithinAbsoluteError(left[100], level, 1e-6f, "on at offset 100");
      expectWithinAbsoluteError(left[399], level, 1e-6f,
                                "held across the run boundary");
      expectWithinAbsoluteError(left[400], 0.0f, 1e-6f, "off at offset 400");
      expectWithinAbsoluteError(left[511], 0.0f, 1e-6f, "silent to the end");
    }

    beginTest("a MIDI track under a splitting stack plays each live event "
              "once (the note path)");
    {
      // The same cut at 300, over a track that holds MIDI content: its
      // render merges the live events with its notes on every call.
      StackNode root("Island");
      auto track = std::make_unique<ClipNode>("Keys", sr);
      auto* synth = test_utils::installStubSynth(*track, sr);
      track->origin_samples.store(0);
      track->duration_samples.store(1024);
      track->setLoopPoints(0, 1024);
      track->loadCommittedMidi({}, 0);  // a MIDI take with no notes
      track->midi_armed.store(true);
      root.addChild(std::move(track));
      delete root.exchangeSequence(songOf({300, 700}));

      juce::MidiBuffer midi;
      midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100), 100);
      midi.addEvent(juce::MidiMessage::noteOff(1, 60), 400);
      const int n = 512;
      test_utils::NodeContext nc = test_utils::contextFor(root, n);
      nc.ctx.live_midi = &midi;
      std::vector<float> left((size_t)n, 0.0f), right((size_t)n, 0.0f);
      float* outs[] = {left.data(), right.data()};
      root.process(nullptr, outs, 0, 2, nc.ctx);

      const float level = test_utils::StubSynthInstance::kLevel;
      expectEquals(synth->note_ons, 1, juce::String("one note-on"));
      expectEquals(synth->note_offs, 1, juce::String("one note-off"));
      expectWithinAbsoluteError(left[100], level, 1e-6f, "on at offset 100");
      expectWithinAbsoluteError(left[399], level, 1e-6f, "held to 400");
      expectWithinAbsoluteError(left[400], 0.0f, 1e-6f, "off at offset 400");
    }

    beginTest("nested splitting stacks: an armed group's own instrument "
              "hears each event once, at its block offset");
    {
      // The root's song cuts the block at 200; the group's own song cuts
      // it again at 300. The group's rack runs once per run of the group.
      StackNode root("Island");
      auto group = std::make_unique<StackNode>("Keys");
      auto* synth = test_utils::installStubSynth(*group, sr);
      group->midi_armed.store(true);
      delete group->exchangeSequence(songOf({300, 700}));
      root.addChild(std::move(group));
      delete root.exchangeSequence(songOf({200, 800}));

      juce::MidiBuffer midi;
      midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100), 100);
      midi.addEvent(juce::MidiMessage::noteOff(1, 60), 250);
      midi.addEvent(juce::MidiMessage::noteOn(1, 64, (juce::uint8)100), 400);
      const int n = 512;
      test_utils::NodeContext nc = test_utils::contextFor(root, n);
      nc.ctx.live_midi = &midi;
      std::vector<float> left((size_t)n, 0.0f), right((size_t)n, 0.0f);
      float* outs[] = {left.data(), right.data()};
      root.process(nullptr, outs, 0, 2, nc.ctx);

      const float level = test_utils::StubSynthInstance::kLevel;
      expectEquals(synth->note_ons, 2, juce::String("two note-ons, once each"));
      expectEquals(synth->note_offs, 1, juce::String("one note-off"));
      expectWithinAbsoluteError(left[99], 0.0f, 1e-6f, "silent before 100");
      expectWithinAbsoluteError(left[100], level, 1e-6f, "first on at 100");
      expectWithinAbsoluteError(left[249], level, 1e-6f, "held to 250");
      expectWithinAbsoluteError(left[250], 0.0f, 1e-6f, "off at 250");
      expectWithinAbsoluteError(left[399], 0.0f, 1e-6f, "silent to 400");
      expectWithinAbsoluteError(left[400], level, 1e-6f, "second on at 400");
      expectWithinAbsoluteError(left[511], level, 1e-6f, "held to the end");
    }

    beginTest("a one-shot group's rest keeps a member's live play-through");
    {
      // The kit fires its 1Q shot once per 4Q cycle and rests for 3Q;
      // an armed member's instrument still speaks through the rest.
      // (Silent takes: they set the periods without adding signal.)
      const int q = 4410;
      StackNode root("Island");
      root.addChild(test_utils::committedClip("Bass", sr, 4 * q, 0.0f));
      auto kit = std::make_unique<StackNode>("Kit");
      kit->period_from_context_.store(true);
      kit->addChild(test_utils::committedClip("Hit", sr, q, 0.0f));
      auto keys = std::make_unique<ClipNode>("Keys", sr);
      auto* synth = test_utils::installStubSynth(*keys, sr);
      keys->midi_armed.store(true);
      kit->addChild(std::move(keys));
      root.addChild(std::move(kit));

      juce::MidiBuffer midi;
      midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8)100), 10);
      const int n = 256;
      test_utils::NodeContext nc = test_utils::contextFor(root, n, 2 * q);
      nc.ctx.is_playing = true;
      nc.ctx.live_midi = &midi;
      std::vector<float> left((size_t)n, 0.0f), right((size_t)n, 0.0f);
      float* outs[] = {left.data(), right.data()};
      root.process(nullptr, outs, 0, 2, nc.ctx);
      expectEquals(synth->note_ons, 1,
                   juce::String("the note reaches the member in the rest"));
      expectWithinAbsoluteError(left[100],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "the member's instrument sounds in the rest");
    }

    beginTest("a new take never reallocates notes a render may still hold: "
              "the sounding sequence parks whole in the take list, the take "
              "reserves one of its own, and a cancel puts the same one back");
    {
      ClipNode clip("Keys", sr);
      test_utils::installStubSynth(clip, sr);
      clip.origin_samples.store(0);
      clip.duration_samples.store(1024);
      MidiEvent strike, release;
      strike.pos = 10;
      strike.size = 3;
      memcpy(strike.bytes, juce::MidiMessage::noteOn(1, 60, (juce::uint8)100)
                               .getRawData(), 3);
      release.pos = 500;
      release.size = 3;
      memcpy(release.bytes, juce::MidiMessage::noteOff(1, 60).getRawData(), 3);
      clip.loadCommittedMidi({strike, release}, 0);

      const MidiSequence* sounding = &clip.midiSequence();
      const MidiEvent* storage = &(*sounding)[0];
      expect(clip.mayRetake(), "a new take of the committed slot may arm");
      const ClipNode::TakeState displaced = clip.prepareRetake();
      expect(displaced.midi != nullptr && displaced.midi.get() != sounding,
             "the arm hands back the stand-in it displaced, for the caller "
             "to retire - never the sounding notes");
      expect(&clip.midiSequence() != sounding,
             "the take records into a sequence of its own");
      expectEquals(clip.midiSequence().capacity(),
                   (int)MidiSequence::kMaxEvents,
                   "reserved whole at the arm, on this thread");
      expectEquals(clip.midiSequence().count(), 0);
      expectEquals(sounding->count(), 2, "the parked notes are untouched");
      expect(&(*sounding)[0] == storage, "and where they were");

      clip.publishArm();
      clip.stopRecording();  // still armed: a cancel
      ClipNode::TakeState abandoned;
      expect(!clip.settleRetake(abandoned), "the cancel settles");
      expect(&clip.midiSequence() == sounding,
             "the same sequence sounds again");
      expect(&clip.midiSequence()[0] == storage && sounding->count() == 2,
             "never moved, never emptied");
    }

    beginTest("engine setMidiArmed: single-armed, metadata publishes");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      engine.createNode("clip");
      const juce::String first = test_utils::lastTopLevelId(engine);
      engine.createNode("clip");
      const juce::String second = test_utils::lastTopLevelId(engine);
      const auto armed = [&](const juce::String& uuid) {
        return test_utils::deepBool(engine, uuid, "midiArmed");
      };

      engine.setMidiArmed(first, true);
      expect(armed(first), "first armed");
      engine.setMidiArmed(second, true);
      expect(armed(second), "second armed");
      expect(!armed(first), "arming the second cleared the first");
      engine.setMidiArmed(second, false);
      expect(!armed(second), "disarm clears");

      const auto midi_inputs = engine.getMidiInputs();
      expect(midi_inputs.hasProperty("devices") &&
                 midi_inputs.hasProperty("dropped"),
             "diagnostics shape");
    }
  }
};

static MidiTests midi_tests;

}  // namespace celestrian
