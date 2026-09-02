#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/midi_input_queue.h"
#include "../src/midi_sequence.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** Installs an enabled, prepared stub-synth instrument slot on `node`
 * (the phase-4 fixture, duplicated here so the two files stay
 * independent). Returns the raw stub for assertions. */
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

juce::MidiMessage noteOn(int note, int velocity = 100) {
  return juce::MidiMessage::noteOn(1, note, (juce::uint8)velocity);
}
juce::MidiMessage noteOff(int note) { return juce::MidiMessage::noteOff(1, note); }

void pushHistory(MidiHistory& hist, int64_t arrival,
                 const juce::MidiMessage& m) {
  hist.push(arrival, m.getRawData(), m.getRawDataSize());
}

}  // namespace

/**
 * MIDI takes (docs/vst3.md §8, phase 5): timestamped drain, arrival
 * history, the ClipNode note take (capture → commit → sample-accurate
 * render with seam releases), latency-compensated history capture,
 * the engine's record path, and persistence.
 */
class MidiRecordTests : public juce::UnitTest {
 public:
  MidiRecordTests() : juce::UnitTest("MIDI recording (phase 5)") {}

  void runTest() override {
    const double sr = 44100.0;

    beginTest("MidiInputQueue: timestamped drain spreads events over the block");
    {
      MidiInputQueue queue;
      juce::MidiBuffer out;
      out.ensureSize(1024);
      queue.drainTo(out, 400, 100.0);  // establishes the interval clock
      expectEquals(out.getNumEvents(), 0);

      auto a = noteOn(60);
      a.setTimeStamp(100.025);
      auto b = noteOff(60);
      b.setTimeStamp(100.075);
      auto c = juce::MidiMessage::controllerEvent(1, 1, 10);  // unstamped
      auto d = noteOn(62);
      d.setTimeStamp(100.5);  // "future" relative to the interval → clamps
      queue.push(a);
      queue.push(b);
      queue.push(c);
      queue.push(d);
      out.clear();
      queue.drainTo(out, 400, 100.1);  // interval [100.0, 100.1) → 400 samples
      std::vector<int> offsets;
      for (const auto metadata : out) offsets.push_back(metadata.samplePosition);
      expectEquals((int)offsets.size(), 4);
      // MidiBuffer keeps position order: unstamped 0, then 100, 300, 399.
      expectEquals(offsets[0], 0, juce::String("unstamped lands at 0"));
      expectEquals(offsets[1], 100, juce::String("25% of the interval"));
      expectEquals(offsets[2], 300, juce::String("75% of the interval"));
      expectEquals(offsets[3], 399, juce::String("future clamps to the end"));
    }

    beginTest("MidiHistory: arrival-indexed ring with monotone sequence");
    {
      MidiHistory hist;
      juce::MidiBuffer block;
      block.addEvent(noteOn(60), 5);
      block.addEvent(noteOff(60), 40);
      hist.pushBlock(block, /*input_clock=*/1000);
      expectEquals((int)hist.total(), 2);
      expectEquals((int)hist.entry(0).arrival, 1005);
      expectEquals((int)hist.entry(1).arrival, 1040);
      expectEquals((int)hist.entry(0).size, 3);
      expect(hist.entry(0).bytes[0] == 0x90, "note-on status kept");
      // Overflow: the oldest sequence advances, total keeps counting.
      for (int i = 0; i < MidiHistory::kCapacity + 10; ++i)
        pushHistory(hist, 2000 + i, noteOn(61));
      expectEquals((int)hist.total(), MidiHistory::kCapacity + 12);
      expectEquals((int)hist.oldestSeq(), 12);
      expectEquals((int)hist.entry(hist.total() - 1).arrival,
                   2000 + MidiHistory::kCapacity + 9);
    }

    beginTest("ClipNode MIDI take: an instrument slot makes the take notes");
    {
      ClipNode clip("Keys", sr);
      auto* synth = installStubSynth(clip, sr);
      expect(clip.isMidiClip(), "empty clip + instrument slot = MIDI track");
      expect(clip.contentKind() == ClipNode::ContentKind::Audio,
             "kind is decided at arm");

      clip.startRecording();
      expect(clip.contentKind() == ClipNode::ContentKind::Midi,
             "armed as a MIDI take");
      expect(clip.recState() == ClipNode::RecState::Armed);
      clip.midi_armed.store(true);  // hear the take while recording

      test_utils::NodeContext nc = test_utils::contextFor(clip, 256, 0);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      ctx.is_recording = true;
      std::vector<float> left(1024, 0.0f), right(1024, 0.0f);
      float* outs[] = {left.data(), right.data()};

      // Block 0: first-clip arm starts capture NOW; a note-on at offset
      // 10 lands at content 10 — and sounds through the instrument at
      // sample 10 of the block (play-through, sample-accurate).
      juce::MidiBuffer b0;
      b0.addEvent(noteOn(60, 100), 10);
      ctx.live_midi = &b0;
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(clip.recState() == ClipNode::RecState::Capturing);
      expectEquals(clip.midiSequence().count(), 1);
      expectEquals((int)clip.midiSequence()[0].pos, 10);
      expectWithinAbsoluteError(left[9], 0.0f, 1e-9f, "silent before onset");
      expectWithinAbsoluteError(left[10], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "play-through sounds at the offset");
      expectGreaterThan(clip.getCurrentPeak(), 0.7f);  // velocity meter

      // Block 1: note-off at offset 20 → content 276.
      juce::MidiBuffer b1;
      b1.addEvent(noteOff(60), 20);
      ctx.live_midi = &b1;
      ctx.master_pos = 256;
      clip.process(nullptr, outs, 0, 2, ctx);
      expectEquals((int)clip.midiSequence()[1].pos, 276);

      // Block 2: a second note (64) at offset 100 → 612, never released
      // (held across the loop seam on playback).
      juce::MidiBuffer b2;
      b2.addEvent(noteOn(64, 90), 100);
      ctx.live_midi = &b2;
      ctx.master_pos = 512;
      clip.process(nullptr, outs, 0, 2, ctx);
      // Block 3: nothing.
      juce::MidiBuffer empty;
      ctx.live_midi = &empty;
      ctx.master_pos = 768;
      clip.process(nullptr, outs, 0, 2, ctx);
      expectEquals(clip.getWritePosition(), 1024, juce::String("heard length"));

      // Stop: first clip → immediate commit, duration = heard length.
      clip.stopRecording();
      expect(clip.recState() == ClipNode::RecState::Idle);
      expectEquals((int)clip.duration_samples.load(), 1024);
      expect(clip.isPlaying(), "committed take sounds");
      expect(clip.contentKind() == ClipNode::ContentKind::Midi);
      expectEquals(clip.midiSequence().count(), 3);
      expectEquals((int)clip.midiSequence()[2].pos, 612);
      expectEquals(clip.midiSequence().dropped(), 0);
      expectEquals(clip.getAudioBuffer().getNumSamples(), (int)sr,
                   juce::String("no audio reservation for a MIDI take"));

      // The lane picture: a velocity envelope over 8 windows of 128.
      const juce::var wf = clip.getWaveform(8);
      const auto* peaks = wf.getArray();
      expect(peaks != nullptr && peaks->size() == 8, "8 peaks");
      if (peaks && peaks->size() == 8) {
        expectWithinAbsoluteError((float)(*peaks)[0], 100.0f / 127.0f, 1e-5f,
                                  "w0 holds note 60");
        expectWithinAbsoluteError((float)(*peaks)[2], 100.0f / 127.0f, 1e-5f,
                                  "w2 still holds it (released at 276)");
        expectWithinAbsoluteError((float)(*peaks)[3], 0.0f, 1e-9f, "w3 rest");
        expectWithinAbsoluteError((float)(*peaks)[4], 90.0f / 127.0f, 1e-5f,
                                  "w4 note 64");
        expectWithinAbsoluteError((float)(*peaks)[7], 90.0f / 127.0f, 1e-5f,
                                  "w7 still held");
      }

      // === Playback: one whole cycle in one block, sample-accurate.
      // (process(), as the engine does: control() clears the commit-
      // block silence gate before render.) The performer left note 64
      // down during the take — lift it before listening back.
      synth->note_held = false;
      clip.midi_armed.store(false);
      ctx.is_recording = false;
      ctx.live_midi = nullptr;
      ctx.num_samples = 1024;
      ctx.master_pos = 0;  // origin (first-clip arm at compensated 0)
      std::fill(left.begin(), left.end(), 0.0f);
      const int ons_before = synth->note_ons;
      clip.process(nullptr, outs, 0, 2, ctx);
      expectWithinAbsoluteError(left[9], 0.0f, 1e-9f, "silent before 10");
      expectWithinAbsoluteError(left[10], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "note 60 from 10");
      expectWithinAbsoluteError(left[275], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "held to 275");
      expectWithinAbsoluteError(left[276], 0.0f, 1e-9f, "off at 276");
      expectWithinAbsoluteError(left[611], 0.0f, 1e-9f, "rest before 612");
      expectWithinAbsoluteError(left[612], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "note 64 from 612");
      expectWithinAbsoluteError(left[1023],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "held to the seam");
      expectWithinAbsoluteError(right[612],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "stereo out");
      expectEquals(synth->note_ons - ons_before, 2);

      // Next cycle: the loop seam RELEASES the hanging note 64 at
      // offset 0 (hanging notes close at the seam), then note 60
      // re-sounds from 10.
      const int offs_before = synth->note_offs;
      ctx.master_pos = 1024;
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expectEquals(synth->note_offs - offs_before, 2,
                   juce::String("seam release + the recorded note-off"));
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "released at the seam");
      expectWithinAbsoluteError(left[10], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "second pass sounds from 10");

      // Transport stop mid-note: content goes inactive → release now.
      ctx.master_pos = 2048;  // third pass: note 60 sounds from 10
      ctx.num_samples = 64;
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(synth->note_held, "note 60 sounding");
      ctx.is_playing = false;
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(!synth->note_held, "stop released the held note");
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "silent after stop");

      // Muted: the instrument keeps being fed (an unmute resumes
      // mid-phrase) but nothing sums. The mute edge FADES now (~10 ms,
      // S7 — sequencer.md §9), so settle one fade-length block first.
      ctx.is_playing = true;
      clip.is_muted.store(true);
      {
        std::vector<float> settleL(441, 0.0f), settleR(441, 0.0f);
        float* const settleOuts[] = {settleL.data(), settleR.data()};
        ProcessContext settle = ctx;
        settle.master_pos = 3072 - 441;
        settle.num_samples = 441;
        clip.process(nullptr, settleOuts, 0, 2, settle);
      }
      ctx.master_pos = 3072;  // fourth pass top: note 60 at 10 again
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(synth->note_held, "muted clip still feeds its instrument");
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "muted sums nothing");
      expectWithinAbsoluteError(left[20], 0.0f, 1e-9f, "muted sums nothing");
      clip.is_muted.store(false);
    }

    beginTest("MIDI take: arrival-history capture is latency-compensated");
    {
      ClipNode clip("Keys", sr);
      installStubSynth(clip, sr);
      MidiHistory hist;
      clip.startRecording();

      test_utils::NodeContext nc = test_utils::contextFor(clip, 256);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      ctx.is_recording = true;
      ctx.midi_history = &hist;
      ctx.midi_latency = 100;  // output latency: keys arrive 100 late
      ctx.input_latency = 0;

      // Already in the history before the arm block: one event that
      // precedes the take's window (dropped) and one inside it (the
      // reach-back — content 0 ↔ arrival 1100).
      pushHistory(hist, 1050, noteOn(59));
      pushHistory(hist, 1120, noteOn(62, 80));

      // Block 0 (master 1000, input clock 1000): first-clip arm at
      // compensated 1000 → window starts at arrival 1100; this block
      // covers arrivals [1100, 1256) = 156 heard samples.
      pushHistory(hist, 1150, noteOn(60));
      ctx.master_pos = 1000;
      ctx.input_clock = 1000;
      clip.process(nullptr, nullptr, 0, 0, ctx);
      expectEquals(clip.getWritePosition(), 156, juce::String("lead honored"));
      expectEquals(clip.midiSequence().count(), 2);
      expectEquals((int)clip.midiSequence()[0].pos, 20,
                   juce::String("reach-back event at 1120 -> 20"));
      expectEquals((int)clip.midiSequence()[1].pos, 50,
                   juce::String("1150 -> 50 (100 samples compensated)"));

      // Block 1: arrival 1300 → 156 + (1300 − 1256) = 200.
      pushHistory(hist, 1300, noteOff(60));
      ctx.master_pos = 1256;
      ctx.input_clock = 1256;
      clip.process(nullptr, nullptr, 0, 0, ctx);
      expectEquals(clip.getWritePosition(), 412);
      expectEquals(clip.midiSequence().count(), 3);
      expectEquals((int)clip.midiSequence()[2].pos, 200);

      clip.stopRecording();
      expectEquals((int)clip.duration_samples.load(), 412);
    }

    beginTest("MIDI take: through-map fold lands notes at inner positions");
    {
      // The fold is a per-event point map through timing::throughMapDest
      // (the audio path's captureWrite fold): a take armed through a
      // two-segment map [100,200)+[500,600) (period 200) into C = 800.
      // The island root carries Q; the clip is driven directly with
      // the map facts a mapping parent would deliver.
      StackNode root("Root");
      const int64_t Q = 200;
      root.setQuantum(Q, 0);
      auto owned = std::make_unique<ClipNode>("Keys", sr);
      auto* c2 = owned.get();
      installStubSynth(*c2, sr);
      root.addChild(std::move(owned));
      c2->startRecording(/*through_map_commit_cycle=*/800);
      expect(c2->contentKind() == ClipNode::ContentKind::Midi);

      test_utils::NodeContext nc = test_utils::contextFor(root, 100, 0);
      nc.driveFrom(*c2);
      ProcessContext& ctx = nc.ctx;
      ctx.sample_rate = sr;
      ctx.is_playing = true;
      ctx.is_recording = true;
      timing::TimeMap map;
      map.n = 2;
      map.segs[0] = {100, 200};
      map.segs[1] = {500, 600};
      ctx.map = map;
      ctx.map_heard_epoch = 0;
      ctx.map_count = 1;
      // Heard clock at a boundary: rel 0 → target 0, anchor 0, origin =
      // mapOffset(0) = 100 (inner). Capture begins this block.
      ctx.master_pos = 0;
      ctx.island_pos = 0;
      juce::MidiBuffer b0;
      b0.addEvent(noteOn(60), 30);
      ctx.live_midi = &b0;
      c2->process(nullptr, nullptr, 0, 0, ctx);
      expect(c2->recState() == ClipNode::RecState::Capturing,
             "through-map capture began");
      expectEquals((int)c2->origin_samples.load(), 100);
      expectEquals(c2->midiSequence().count(), 1);
      // heard 30 → inner 130 → content 30 (content 0 IS the origin).
      expectEquals((int)c2->midiSequence()[0].pos, 30);

      // Block 1: heard 150 is past the seam (segment 2): inner 550 →
      // content 550 − 100 = 450 — the fold, not the heard index.
      juce::MidiBuffer b1;
      b1.addEvent(noteOff(60), 50);
      ctx.live_midi = &b1;
      ctx.master_pos = 100;
      ctx.island_pos = 100;
      c2->process(nullptr, nullptr, 0, 0, ctx);
      expectEquals(c2->midiSequence().count(), 2);
      expectEquals((int)c2->midiSequence()[1].pos, 450);
      // The one-period cap: the take commits at heard 200 as C = 800.
      ctx.live_midi = nullptr;
      c2->process(nullptr, nullptr, 0, 0, ctx);
      expect(c2->recState() == ClipNode::RecState::Idle, "cap committed");
      expectEquals((int)c2->duration_samples.load(), 800);
    }

    beginTest("engine: recording an instrument track takes MIDI, arms it");
    {
      AudioEngine engine;
      engine.createNode("clip");
      juce::String id;
      {
        const juce::var state = engine.getGraphState();
        const auto* nodes = test_utils::nodesOf(state);
        id = (*nodes)[0].getProperty("id", "").toString();
      }
      engine.addVst3SlotToChain(
          id,
          std::make_shared<dsp::Vst3Slot>(
              std::make_unique<test_utils::StubSynthInstance>(),
              "Stub-synth-uid", "Stub Synth", "/stub/StubSynth.vst3",
              /*is_instrument=*/true),
          -1);
      auto nodeState = [&]() {
        const juce::var state = engine.getGraphState();
        const auto* nodes = test_utils::nodesOf(state);
        return juce::var((*nodes)[0]);
      };
      expect(nodeState().getProperty("contentKind", "").toString() == "midi",
             "empty clip with an instrument publishes as a MIDI track");

      // Record: the take is MIDI and the track becomes the MIDI target.
      engine.startRecordingInNode(id);
      expect((bool)nodeState().getProperty("midiArmed", false),
             "record MIDI-arms the track");
      test_utils::driveEngine(engine, 512);
      engine.handleIncomingMidiMessage(nullptr, noteOn(60));
      test_utils::driveEngine(engine, 512);
      engine.handleIncomingMidiMessage(nullptr, noteOff(60));
      test_utils::driveEngine(engine, 512 * 4);
      engine.stopRecordingInNode(id);
      for (int i = 0; i < 400 && !test_utils::isClipCommitted(engine, id); ++i)
        test_utils::driveEngine(engine, 512);
      expect(test_utils::isClipCommitted(engine, id), "committed");
      const juce::var n = nodeState();
      expect(n.getProperty("contentKind", "").toString() == "midi",
             "committed as MIDI");
      expectEquals((int)n.getProperty("midiEvents", 0), 2,
                   juce::String("both events captured"));
      const double duration = (double)n.getProperty("duration", 0);
      expectGreaterThan(duration, 0.0);

      // Persistence: save → load keeps the notes and the kind.
      auto dir = test_utils::freshTempDir("midi_take");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      AudioEngine engine2;
      expect(engine2.loadSession(dir.getFullPathName()), "load");
      const juce::var s2 = engine2.getGraphState();
      const auto* nodes2 = test_utils::nodesOf(s2);
      expect(nodes2 != nullptr && nodes2->size() == 1, "one node");
      if (nodes2 && nodes2->size() == 1) {
        expect((*nodes2)[0].getProperty("contentKind", "").toString() ==
                   "midi",
               "kind survives the round-trip");
        expectEquals((int)(*nodes2)[0].getProperty("midiEvents", 0), 2);
        expectEquals((double)(*nodes2)[0].getProperty("duration", 0),
                     duration, "duration survives");
      }
    }

    beginTest("session_io: MIDI positions round-trip exactly (QTime)");
    {
      const int64_t Q = 48000;
      const int64_t epoch = 777;
      StackNode root("SessionRoot");
      root.setQuantum(Q, epoch);
      auto clip = std::make_unique<ClipNode>("Keys", (double)Q);
      clip->origin_samples.store(epoch + Q);
      clip->duration_samples.store(2 * Q);
      clip->setLoopPoints(0, 2 * Q);
      std::vector<MidiEvent> events;
      auto ev = [&](int64_t pos, const juce::MidiMessage& m) {
        MidiEvent e;
        e.pos = pos;
        e.size = (juce::uint8)m.getRawDataSize();
        memcpy(e.bytes, m.getRawData(), (size_t)m.getRawDataSize());
        events.push_back(e);
      };
      ev(7, noteOn(60, 101));
      ev(12345, juce::MidiMessage::controllerEvent(1, 74, 5));
      ev(2 * Q - 1, noteOff(60));
      ev(2 * Q + 5, noteOn(61));  // beyond duration: not saved
      clip->loadCommittedMidi(events, 0);
      root.addChild(std::move(clip));

      auto dir = test_utils::freshTempDir("midi_io");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok && loaded.children.size() == 1, "load");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr && c->contentKind() == ClipNode::ContentKind::Midi,
             "MIDI clip restored");
      if (c) {
        expectEquals(c->midiSequence().count(), 3, juce::String("3 saved"));
        expectEquals((int)c->midiSequence()[0].pos, 7);
        expectEquals((int)c->midiSequence()[1].pos, 12345);
        expectEquals((int)c->midiSequence()[2].pos, (int)(2 * Q - 1));
        expect(c->midiSequence()[0].bytes[2] == 101, "velocity kept");
        expect(c->midiSequence()[1].bytes[0] == 0xB0, "CC status kept");
        expect(c->isPlaying(), "loaded take sounds");
        expectEquals((int)c->duration_samples.load(), (int)(2 * Q));
        expect(!dir.getChildFile("audio").getChildFile(
                                             c->getUuid() + ".wav")
                    .existsAsFile(),
               "no WAV written for a MIDI take");
      }
    }
  }
};

static MidiRecordTests midi_record_tests;

}  // namespace celestrian
