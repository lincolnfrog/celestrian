#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <functional>
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

/** The cycle above on a lone clip with the stub synth, its context
 * playing. */
struct Keys {
  explicit Keys(double sample_rate) : clip("Keys", sample_rate) {
    synth = test_utils::installStubSynth(clip, sample_rate);
    loadCycle(clip);
    nc = test_utils::contextFor(clip);
    nc.ctx.sample_rate = sample_rate;
    nc.ctx.is_playing = true;
  }
  void run(int64_t master_pos, int n) {
    celestrian::run(clip, nc.ctx, master_pos, n);
  }

  ClipNode clip;
  test_utils::StubSynthInstance* synth = nullptr;
  test_utils::NodeContext nc;
};

}  // namespace

/**
 * THE SOUND-OFF EDGES (docs/vst3.md §8.3): when a MIDI clip's content
 * stops sounding, its instrument gets All Notes Off + All Sound Off on
 * the channels in use EXACTLY ONCE per closing edge — transport stop,
 * the S7 gate landing closed (mute, solo-silence), the new-take
 * silence, a bounce tail, a device stop — and never per block, so held
 * notes release through the instrument's envelope and the chain's tail
 * rings. A REST (a one-shot group's, handed down) is no closing edge:
 * the recorded notes release and the instrument is left be. The stub
 * synth records the pair per channel.
 */
class MidiReleaseTests : public juce::UnitTest {
 public:
  MidiReleaseTests() : juce::UnitTest("MIDI sound-off edges") {}

  void runTest() override {
    const double sr = 44100.0;
    constexpr int kFade = 441;  // one S7 fade at 44.1 kHz

    beginTest("transport stop: the pair once, then never while stopped");
    {
      Keys keys(sr);
      auto* synth = keys.synth;
      keys.run(0, 256);
      expect(synth->note_held, "note 60 sounding");
      expectEquals(synth->all_notes_off, 0, juce::String("no pair while playing"));
      keys.nc.ctx.is_playing = false;
      keys.run(256, 512);
      expect(!synth->note_held, "the stop released the note");
      expectEquals(synth->all_notes_off, 1, juce::String("CC 123 once"));
      expectEquals(synth->all_sound_off, 1, juce::String("CC 120 once"));
      expectEquals((int)synth->sound_off_channels, 1,
                   juce::String("on the channel in use (1)"));
      for (int i = 0; i < 4; ++i) keys.run(1024 + 512 * i, 512);
      expectEquals(synth->all_notes_off, 1, juce::String("never per block"));
      // Resume, then stop again: a second edge, a second pair.
      keys.nc.ctx.is_playing = true;
      keys.run(0, 256);
      keys.nc.ctx.is_playing = false;
      keys.run(256, 512);
      expectEquals(synth->all_notes_off, 2, juce::String("one per edge"));
    }

    // Three more ways the content stops sounding under a held note. Each
    // is one closing edge: the pair at the edge's block, none after it.
    struct Edge {
      const char* name;
      std::function<void(Keys&)> close;
    };
    const Edge edges[] = {
        {"new take: the slot's silence is a closing edge",
         [this](Keys& keys) {
           expect(keys.clip.mayRetake(),
                  "a new take may arm on the committed slot");
           keys.clip.prepareRetake();
           keys.clip.publishArm();
         }},
        {"bounce tail (content_silent): the pair once at the tail's top",
         [](Keys& keys) { keys.nc.ctx.content_silent = true; }},
        {"device stop request: the pair at the next block",
         [](Keys& keys) { keys.clip.requestMidiSoundOff(); }},
    };
    for (const Edge& edge : edges) {
      beginTest(edge.name);
      Keys keys(sr);
      keys.run(0, 256);
      expect(keys.synth->note_held, "content sounding");
      edge.close(keys);
      keys.run(256, 128);  // no note of the cycle falls in this block
      expect(!keys.synth->note_held, "the edge released the note");
      expectEquals(keys.synth->all_sound_off, 1,
                   juce::String("the pair once, at the edge"));
      keys.run(384, 256);
      keys.run(640, 256);
      expectEquals(keys.synth->all_sound_off, 1,
                   juce::String("and none in the blocks after it"));
    }

    beginTest("device stop request: the pair lands ahead of the block's own "
              "notes - a note struck on the block's first sample still sounds");
    {
      Keys keys(sr);
      keys.run(0, 256);    // note 60 strikes: channel 1 is in use
      keys.run(256, 344);  // and releases at 500; the next block tops at 600
      expect(!keys.synth->note_held, "between the two notes");
      keys.clip.requestMidiSoundOff();
      keys.run(600, 128);  // note 64 strikes at this block's sample 0
      expectEquals(keys.synth->all_sound_off, 1,
                   juce::String("the pair, at the block's top"));
      expect(keys.synth->note_held,
             "the note the block itself struck is not swallowed by it");
      keys.run(728, 128);
      expect(keys.synth->note_held, "and holds on to its own release");
    }

    beginTest("device stop request: control takes it up, a render pass alone "
              "never does");
    {
      Keys keys(sr);
      keys.run(0, 256);
      keys.clip.requestMidiSoundOff();
      std::vector<float> l(128, 0.0f), r(128, 0.0f);
      float* outs[] = {l.data(), r.data()};
      keys.nc.ctx.master_pos = 256;
      keys.nc.ctx.island_pos = 256;
      keys.nc.ctx.num_samples = 128;
      keys.clip.render(outs, 2, keys.nc.ctx);
      expectEquals(keys.synth->all_sound_off, 0,
                   juce::String("render decides nothing: the request waits"));
      expect(keys.synth->note_held, "note 60 still sounding");
      keys.run(384, 128);
      expectEquals(keys.synth->all_sound_off, 1,
                   juce::String("the next control pass hands render the edge"));
    }

    beginTest("mute: the pair once when the S7 gate lands closed; re-mute repeats");
    {
      Keys keys(sr);
      auto* synth = keys.synth;
      int64_t t = 0;
      auto step = [&]() {
        keys.run(t, kFade);
        t += kFade;
      };
      step();
      keys.clip.is_muted.store(true);
      step();  // the ramp lands on zero inside this block
      expectEquals(synth->all_sound_off, 1,
                   juce::String("the gate closing is one edge"));
      expectEquals(synth->all_notes_off, 1);
      for (int i = 0; i < 6; ++i) step();
      expectEquals(synth->all_sound_off, 1,
                   juce::String("a closed gate sends no more"));
      expect(synth->note_ons > 1, "the muted clip keeps feeding its instrument");
      keys.clip.is_muted.store(false);
      for (int i = 0; i < 3; ++i) step();
      expectEquals(synth->all_sound_off, 1, juce::String("an unmute is no edge"));
      keys.clip.is_muted.store(true);
      step();
      expectEquals(synth->all_sound_off, 2, juce::String("a re-mute is one more"));
    }

    beginTest("solo-silence: soloing a sibling closes this gate once");
    {
      StackNode root("Root");
      auto keys_owned = std::make_unique<ClipNode>("Keys", sr);
      auto* keys = keys_owned.get();
      auto* synth = test_utils::installStubSynth(*keys, sr);
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

    beginTest("a one-shot group's rest is a rest, not a stop: its MIDI "
              "member's recorded note releases at the rest's top, a live note "
              "held across it is left to the player, and a bounce tail inside "
              "the rest is still a stop");
    {
      // The kit fires its 1Q shot once per 4Q cycle. Its member strikes a
      // recorded note (channel 1) and never releases it; the player
      // strikes a live note (channel 2) in the shot and holds it.
      const int q = 4410, n = 441;
      StackNode root("Island");
      root.addChild(test_utils::committedClip("Bass", sr, 4 * q, 0.0f));
      auto kit = std::make_unique<StackNode>("Kit");
      kit->period_from_context_.store(true);
      auto keys = std::make_unique<ClipNode>("Keys", sr);
      auto* synth = test_utils::installStubSynth(*keys, sr);
      keys->origin_samples.store(0);
      keys->duration_samples.store(q);
      keys->loadCommittedMidi(
          {event(10, juce::MidiMessage::noteOn(1, 60, (juce::uint8)100))}, 0);
      keys->midi_armed.store(true);
      kit->addChild(std::move(keys));
      root.addChild(std::move(kit));

      juce::MidiBuffer live;
      const auto runAt = [&](int64_t pos, bool bounce_tail = false) {
        test_utils::NodeContext nc = test_utils::contextFor(root, n, pos);
        nc.ctx.sample_rate = sr;
        nc.ctx.is_playing = true;
        nc.ctx.live_midi = &live;
        nc.ctx.content_silent = bounce_tail;
        std::vector<float> l((size_t)n, 0.0f), r((size_t)n, 0.0f);
        float* outs[] = {l.data(), r.data()};
        root.process(nullptr, outs, 0, 2, nc.ctx);
        live.clear();
      };
      runAt(0);
      live.addEvent(juce::MidiMessage::noteOn(2, 40, (juce::uint8)100), 5);
      for (int64_t t = n; t < q; t += n) runAt(t);
      expectEquals(synth->note_ons, 2,
                   juce::String("the shot: the recorded note and the live one"));
      expectEquals(synth->note_offs, 0, juce::String("both still down"));

      runAt(q);  // the rest's first block
      expectEquals(synth->note_offs, 1,
                   juce::String("the rest's top releases the recorded note alone"));
      expectEquals(synth->all_notes_off, 0,
                   juce::String("no CC 123: the live note is the player's"));
      expectEquals(synth->all_sound_off, 0, juce::String("no CC 120"));
      for (int64_t t = q + n; t < 4 * q; t += n) runAt(t);
      expectEquals(synth->note_offs, 1, juce::String("once, not per block"));
      expectEquals(synth->all_sound_off, 0,
                   juce::String("nothing more through the rest"));

      // The next firing, its rest, and then a bounce tail inside it: the
      // content has STOPPED, so the pair goes to both channels in use.
      for (int64_t t = 4 * q; t <= 5 * q; t += n) runAt(t);
      expectEquals(synth->note_ons, 3, juce::String("the next firing strikes"));
      expectEquals(synth->note_offs, 2, juce::String("and its rest releases"));
      expectEquals(synth->all_sound_off, 0, juce::String("still no pair"));
      runAt(5 * q + n, /*bounce_tail=*/true);
      expectEquals(synth->all_sound_off, 2,
                   juce::String("a tail in the rest: CC 120 once per channel"));
      expectEquals((int)synth->sound_off_channels, 3,
                   juce::String("channels 1 (recorded) and 2 (live)"));
      runAt(5 * q + 2 * n, /*bounce_tail=*/true);
      expectEquals(synth->all_sound_off, 2, juce::String("once per edge"));
    }

    beginTest("channels in use: live play-through widens the pair");
    {
      Keys keys(sr);
      keys.clip.midi_armed.store(true);
      juce::MidiBuffer live;
      live.addEvent(juce::MidiMessage::noteOn(2, 40, (juce::uint8)100), 5);
      keys.nc.ctx.live_midi = &live;
      keys.run(0, 512);
      juce::MidiBuffer empty;
      keys.nc.ctx.live_midi = &empty;
      keys.nc.ctx.is_playing = false;
      keys.run(512, 512);
      expectEquals((int)keys.synth->sound_off_channels, 3,
                   juce::String("channels 1 (content) and 2 (live)"));
      expectEquals(keys.synth->all_sound_off, 2,
                   juce::String("one CC 120 per channel"));
    }

    beginTest("engine: audioDeviceStopped requests the pair on every clip");
    {
      // An EMPTY instrument clip played live (the audio-kind live tail
      // path) — the request reaches it too.
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      engine.createNode("clip");
      const juce::String id = test_utils::lastTopLevelId(engine);
      auto slot = test_utils::makeStubSynthSlot();
      auto* synth =
          static_cast<test_utils::StubSynthInstance*>(slot->instance());
      engine.addPluginSlotToChain(id, slot, -1);
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
