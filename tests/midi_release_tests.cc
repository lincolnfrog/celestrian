#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/midi_sequence.h"
#include "../src/stack_node.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** Installs an enabled, prepared stub-synth instrument slot on `node`
 * (the phase-4 fixture, duplicated here so the files stay independent).
 * Returns the raw stub for assertions. */
test_utils::StubSynthInstance* installStubSynth(AudioNode& node,
                                                double sample_rate) {
  auto instance = std::make_unique<test_utils::StubSynthInstance>();
  auto* raw = instance.get();
  auto slots = node.fxChain()->slots();
  auto synth = std::make_shared<dsp::Vst3Slot>(
      std::move(instance), "Stub-synth-uid", "Stub Synth",
      "/stub/StubSynth.vst3", /*is_instrument=*/true);
  auto* slot = synth.get();
  slots.push_back(std::move(synth));
  delete node.exchangeFxChain(
      dsp::FxChain::makeFromSlots(std::move(slots)).release());
  node.fxChain()->prepare(sample_rate);
  slot->enabled.store(true);
  return raw;
}

MidiEvent event(int64_t pos, const juce::MidiMessage& m) {
  MidiEvent e;
  e.pos = pos;
  e.size = (juce::uint8)m.getRawDataSize();
  memcpy(e.bytes, m.getRawData(), (size_t)m.getRawDataSize());
  return e;
}

/** A committed one-cycle MIDI clip (period 1024): notes on channel 1
 * at 10..500 and 600..1000, so every 441-sample block carries at least
 * one event (the fixture for "channels in use" between edges), and a
 * 256-sample first block ends with note 60 still down. */
void loadCycle(ClipNode& clip) {
  clip.origin_samples.store(0);
  clip.duration_samples.store(1024);
  clip.setLoopPoints(0, 1024);
  std::vector<MidiEvent> events;
  events.push_back(event(10, juce::MidiMessage::noteOn(1, 60, (juce::uint8)100)));
  events.push_back(event(500, juce::MidiMessage::noteOff(1, 60)));
  events.push_back(event(600, juce::MidiMessage::noteOn(1, 64, (juce::uint8)90)));
  events.push_back(event(1000, juce::MidiMessage::noteOff(1, 64)));
  clip.loadCommittedMidi(events, 0);
}

/** Drives `clip` for one block of `n` at `master_pos` through the
 * given context (output discarded). */
void run(ClipNode& clip, ProcessContext& ctx, int64_t master_pos, int n) {
  std::vector<float> l((size_t)n, 0.0f), r((size_t)n, 0.0f);
  float* outs[] = {l.data(), r.data()};
  ctx.master_pos = master_pos;
  ctx.island_pos = master_pos;
  ctx.num_samples = n;
  clip.process(nullptr, outs, 0, 2, ctx);
}

}  // namespace

/**
 * THE SOUND-OFF EDGES (docs/vst3.md 11): when a MIDI clip's content
 * stops sounding, its instrument gets All Notes Off + All Sound Off on
 * the channels in use EXACTLY ONCE per closing edge — transport stop,
 * the S7 gate landing closed (mute, solo-silence), the new-take
 * silence, a bounce tail, a device stop — and never per block, so held
 * notes release through the instrument's envelope and the chain's tail
 * rings. The stub synth records the pair per channel.
 */
class MidiReleaseTests : public juce::UnitTest {
 public:
  MidiReleaseTests() : juce::UnitTest("MIDI sound-off edges (phase 6)") {}

  void runTest() override {
    const double sr = 44100.0;
    constexpr int kFade = 441;  // one S7 fade at 44.1 kHz

    beginTest("transport stop: the pair once, then never while stopped");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      test_utils::NodeContext nc = test_utils::contextFor(clip, 512, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      run(clip, ctx, 0, 256);
      expect(synth->note_held, "note 60 sounding");
      expectEquals(synth->all_notes_off, 0, juce::String("no pair while playing"));
      ctx.is_playing = false;
      run(clip, ctx, 256, 512);
      expect(!synth->note_held, "the stop released the note");
      expectEquals(synth->all_notes_off, 1, juce::String("CC 123 once"));
      expectEquals(synth->all_sound_off, 1, juce::String("CC 120 once"));
      expectEquals((int)synth->sound_off_channels, 1,
                   juce::String("on the channel in use (1)"));
      for (int i = 0; i < 4; ++i) run(clip, ctx, 1024 + 512 * i, 512);
      expectEquals(synth->all_notes_off, 1, juce::String("never per block"));
      // Resume, then stop again: a second edge, a second pair.
      ctx.is_playing = true;
      run(clip, ctx, 0, 256);
      ctx.is_playing = false;
      run(clip, ctx, 256, 512);
      expectEquals(synth->all_notes_off, 2, juce::String("one per edge"));
    }

    beginTest("mute: the pair once when the S7 gate lands closed; re-mute repeats");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      test_utils::NodeContext nc = test_utils::contextFor(clip, kFade, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      int64_t t = 0;
      auto step = [&]() {
        run(clip, ctx, t, kFade);
        t += kFade;
      };
      step();
      clip.is_muted.store(true);
      step();  // the ramp lands on zero inside this block
      expectEquals(synth->all_sound_off, 1,
                   juce::String("the gate closing is one edge"));
      expectEquals(synth->all_notes_off, 1);
      for (int i = 0; i < 6; ++i) step();
      expectEquals(synth->all_sound_off, 1,
                   juce::String("a closed gate sends no more"));
      expect(synth->note_ons > 1, "the muted clip keeps feeding its instrument");
      clip.is_muted.store(false);
      for (int i = 0; i < 3; ++i) step();
      expectEquals(synth->all_sound_off, 1, juce::String("an unmute is no edge"));
      clip.is_muted.store(true);
      step();
      expectEquals(synth->all_sound_off, 2, juce::String("a re-mute is one more"));
    }

    beginTest("solo-silence: soloing a sibling closes this gate once");
    {
      StackNode root("Root");
      auto keys_owned = std::make_unique<ClipNode>("Keys", sr);
      auto* keys = keys_owned.get();
      auto* synth = installStubSynth(*keys, sr);
      loadCycle(*keys);
      root.addChild(std::move(keys_owned));
      auto other_owned = std::make_unique<ClipNode>("Other", sr);
      auto* other = other_owned.get();
      root.addChild(std::move(other_owned));
      test_utils::NodeContext nc = test_utils::contextFor(root, kFade, 0);
      nc.driveFrom(*keys);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      int64_t t = 0;
      auto step = [&]() {
        nc.refresh();  // any_solo re-scanned at the block top
        nc.driveFrom(*keys);
        run(*keys, ctx, t, kFade);
        t += kFade;
      };
      step();
      other->is_soloed.store(true);
      step();
      expectEquals(synth->all_sound_off, 1,
                   juce::String("solo-silence is one closing edge"));
      for (int i = 0; i < 4; ++i) step();
      expectEquals(synth->all_sound_off, 1, juce::String("and only one"));
      other->is_soloed.store(false);
      for (int i = 0; i < 3; ++i) step();
      expectEquals(synth->all_sound_off, 1, juce::String("unsolo is no edge"));
    }

    beginTest("new take: the slot's silence is a closing edge");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      test_utils::NodeContext nc = test_utils::contextFor(clip, 512, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      run(clip, ctx, 0, 256);
      expect(synth->note_held, "content sounding");
      expect(clip.prepareRetake(), "new take armed on the committed slot");
      clip.publishArm();
      run(clip, ctx, 256, 512);
      expect(!synth->note_held, "the retake silence released the note");
      expectEquals(synth->all_sound_off, 1,
                   juce::String("the pair once at the new take's arm"));
    }

    beginTest("bounce tail (content_silent): the pair once at the tail's top");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      test_utils::NodeContext nc = test_utils::contextFor(clip, 512, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      run(clip, ctx, 0, 256);
      expect(synth->note_held, "content sounding");
      ctx.content_silent = true;
      run(clip, ctx, 256, 512);
      expect(!synth->note_held, "the tail's top released the note");
      expectEquals(synth->all_sound_off, 1, juce::String("tail top: once"));
      run(clip, ctx, 1024, 512);
      run(clip, ctx, 1536, 512);
      expectEquals(synth->all_sound_off, 1, juce::String("tail blocks: no more"));
    }

    beginTest("device stop request: the pair at the next block");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      test_utils::NodeContext nc = test_utils::contextFor(clip, 512, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      run(clip, ctx, 0, 256);
      clip.requestMidiSoundOff();
      run(clip, ctx, 256, 512);
      expectEquals(synth->all_sound_off, 1, juce::String("consumed once"));
      run(clip, ctx, 768, 512);
      expectEquals(synth->all_sound_off, 1, juce::String("and not again"));
    }

    beginTest("channels in use: live play-through widens the pair");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      loadCycle(clip);
      clip.midi_armed.store(true);
      test_utils::NodeContext nc = test_utils::contextFor(clip, 512, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      juce::MidiBuffer live;
      live.addEvent(juce::MidiMessage::noteOn(2, 40, (juce::uint8)100), 5);
      ctx.live_midi = &live;
      run(clip, ctx, 0, 512);
      juce::MidiBuffer empty;
      ctx.live_midi = &empty;
      ctx.is_playing = false;
      run(clip, ctx, 512, 512);
      expectEquals((int)synth->sound_off_channels, 3,
                   juce::String("channels 1 (content) and 2 (live)"));
      expectEquals(synth->all_sound_off, 2, juce::String("one CC 120 per channel"));
    }

    beginTest("engine: audioDeviceStopped requests the pair on every clip");
    {
      // An EMPTY instrument clip played live (the audio-kind live tail
      // path) — the request reaches it too.
      AudioEngine engine;
      engine.createNode("clip");
      juce::String id;
      {
        const juce::var state = engine.getGraphState();
        const auto* nodes = test_utils::nodesOf(state);
        id = (*nodes)[0].getProperty("id", "").toString();
      }
      auto instance = std::make_unique<test_utils::StubSynthInstance>();
      auto* synth = instance.get();
      engine.addPluginSlotToChain(
          id,
          std::make_shared<dsp::Vst3Slot>(std::move(instance), "Stub-synth-uid",
                                          "Stub Synth", "/stub/StubSynth.vst3",
                                          /*is_instrument=*/true),
          -1);
      engine.setMidiArmed(id, true);
      test_utils::driveEngine(engine, 512);
      engine.handleIncomingMidiMessage(
          nullptr, juce::MidiMessage::noteOn(1, 60, (juce::uint8)100));
      test_utils::driveEngine(engine, 512);
      expect(synth->note_held, "live note sounding");
      engine.audioDeviceStopped();
      test_utils::driveEngine(engine, 512);
      expect(!synth->note_held, "the first block after the stop releases it");
      expectEquals(synth->all_sound_off, 1, juce::String("the pair once"));
      test_utils::driveEngine(engine, 512 * 3);
      expectEquals(synth->all_sound_off, 1, juce::String("and not again"));
    }
  }
};

static MidiReleaseTests midi_release_tests;

}  // namespace celestrian
