#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/midi_input_queue.h"
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

/** Installs a stub-synth instrument slot on `node`'s chain (enabled,
 * prepared). Returns the raw slot for assertions. */
dsp::Vst3Slot* installStubSynth(AudioNode& node, double sample_rate) {
  auto slots = node.fxChain()->slots();
  auto synth = std::make_shared<dsp::Vst3Slot>(
      std::make_unique<test_utils::StubSynthInstance>(), "Stub-synth-uid",
      "Stub Synth", "/stub/StubSynth.vst3", /*is_instrument=*/true);
  auto* raw = synth.get();
  slots.push_back(std::move(synth));
  delete node.exchangeFxChain(
      dsp::FxChain::makeFromSlots(std::move(slots)).release());
  node.fxChain()->prepare(sample_rate);
  raw->enabled.store(true);
  return raw;
}

}  // namespace

/**
 * Live MIDI (docs/vst3.md §8, phase 4): the lock-free input queue, the
 * instrument slot's MIDI pass, and the armed-node play-through.
 */
class MidiTests : public juce::UnitTest {
 public:
  MidiTests() : juce::UnitTest("Live MIDI (phase 4)") {}

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

    beginTest("instrument slot: consumes MIDI, generates; effects follow");
    {
      ClipNode clip("SynthTrack", sr);
      auto* synth = installStubSynth(clip, sr);
      juce::ignoreUnused(synth);

      // A gain EFFECT after the instrument: generated signal flows on
      // through the rest of the chain (0.25 * 0.5 = 0.125).
      {
        auto slots = clip.fxChain()->slots();
        auto effect = std::make_shared<dsp::Vst3Slot>(
            std::make_unique<test_utils::StubPluginInstance>(0.5f),
            "Stub-uid", "Stub Gain", "/stub/StubGain.vst3");
        effect->enabled.store(true);
        slots.push_back(std::move(effect));
        delete clip.exchangeFxChain(
            dsp::FxChain::makeFromSlots(std::move(slots)).release());
        clip.fxChain()->prepare(sr);
      }

      const juce::MidiBuffer midi = noteOnBuffer();
      std::vector<float> l(256, 0.0f), r(256, 0.0f);
      const bool out_stereo =
          clip.fxChain()->run(l.data(), r.data(), 256, false, &midi);
      expect(out_stereo, "instrument promoted the pass");
      expectWithinAbsoluteError(
          l[0], test_utils::StubSynthInstance::kLevel * 0.5f, 1e-6f,
          "synth level through the downstream effect, L");
      expectWithinAbsoluteError(
          r[128], test_utils::StubSynthInstance::kLevel * 0.5f, 1e-6f, "R");
    }

    beginTest("clip play-through: armed sounds, disarmed/muted silent");
    {
      ClipNode clip("SynthTrack", sr);
      installStubSynth(clip, sr);
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

      // The pan law applies at the output stage (post-chain, Q-V1
      // discussion): hard left attenuates R only.
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

    beginTest("engine setMidiArmed: single-armed, metadata publishes");
    {
      AudioEngine engine;
      engine.createNode("clip");
      engine.createNode("clip");
      // The var must OUTLIVE getArray() pointers (the documented
      // dangling-var gotcha): name every state before walking it.
      const juce::var state = engine.getGraphState();
      const juce::var nodes_var = state.getProperty("nodes", juce::var());
      const auto* nodes = nodes_var.getArray();
      const juce::String first =
          (*nodes)[0].getProperty("id", "").toString();
      const juce::String second =
          (*nodes)[1].getProperty("id", "").toString();

      auto armed = [&](const juce::String& uuid) {
        const juce::var fresh = engine.getGraphState();
        const juce::var fresh_nodes = fresh.getProperty("nodes", juce::var());
        const auto* all = fresh_nodes.getArray();
        if (all == nullptr) return false;
        for (const auto& node : *all)
          if (node.getProperty("id", "").toString() == uuid)
            return (bool)node.getProperty("midiArmed", false);
        return false;
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
