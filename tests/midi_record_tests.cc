#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/midi_input_queue.h"
#include "../src/midi_sequence.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::installStubSynth;

namespace {

juce::MidiMessage noteOn(int note, int velocity = 100) {
  return juce::MidiMessage::noteOn(1, note, (juce::uint8)velocity);
}
juce::MidiMessage noteOff(int note) { return juce::MidiMessage::noteOff(1, note); }

void pushHistory(MidiHistory& hist, int64_t arrival,
                 const juce::MidiMessage& m) {
  hist.push(arrival, m.getRawData(), m.getRawDataSize());
}

/** `m` as a take's event at content position `pos`. */
MidiEvent eventAt(int64_t pos, const juce::MidiMessage& m) {
  MidiEvent e;
  e.pos = pos;
  e.size = (juce::uint8)m.getRawDataSize();
  memcpy(e.bytes, m.getRawData(), (size_t)m.getRawDataSize());
  return e;
}

/** A lone instrument clip armed for a take that captures from the
 * ARRIVAL HISTORY (the engine's path): keys arrive 100 samples late, so
 * a first take armed at clock 1000 opens its window at arrival 1100. */
struct HistoryTake {
  explicit HistoryTake(double sample_rate) : clip("Keys", sample_rate) {
    installStubSynth(clip, sample_rate);
    clip.startRecording();
    nc = test_utils::contextFor(clip, 256);
    nc.ctx.sample_rate = sample_rate;
    nc.ctx.is_playing = true;
    nc.ctx.midi_history = &hist;
    nc.ctx.midi_latency = 100;
    nc.ctx.input_latency = 0;
  }

  /** `m` arrives at input clock `arrival`. */
  void arrive(int64_t arrival, const juce::MidiMessage& m) {
    pushHistory(hist, arrival, m);
  }

  /** One 256-sample block at clock `pos`, the input clock alongside. */
  void block(int64_t pos) {
    nc.ctx.master_pos = pos;
    nc.ctx.input_clock = pos;
    clip.process(nullptr, nullptr, 0, 0, nc.ctx);
  }

  /** The take is asked to stop, and the next block top commits it. */
  void stop() { test_utils::stopAtBlockTop(clip, nc.ctx); }

  ClipNode clip;
  MidiHistory hist;
  test_utils::NodeContext nc;
};

}  // namespace

/**
 * MIDI takes (docs/vst3.md §8): timestamped drain, arrival history, the
 * ClipNode note take (capture → commit → sample-accurate render with
 * seam releases), latency-compensated history capture, the engine's
 * record path, and persistence.
 */
class MidiRecordTests : public juce::UnitTest {
 public:
  MidiRecordTests() : juce::UnitTest("MIDI recording") {}

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

    beginTest("MidiSequence: sorted insertion; a full sequence refuses the "
              "event and keeps what it holds");
    {
      MidiSequence seq(2);
      const juce::MidiMessage on = noteOn(60), off = noteOff(60);
      expect(seq.append(40, off.getRawData(), 3), "stored");
      expect(seq.append(10, on.getRawData(), 3), "stored, ahead of it");
      expect(!seq.append(20, on.getRawData(), 3), "full: refused");
      expectEquals(seq.count(), 2);
      expectEquals((int)seq[0].pos, 10, juce::String("sorted by position"));
      expectEquals((int)seq[1].pos, 40);
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
      expectGreaterThan(clip.last_block_peak.load(), 0.7f);  // velocity meter

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
      expectEquals(clip.recordedLength(), (int64_t)1024,
                   juce::String("heard length"));

      // Stop: a first take commits at the next block top, duration =
      // heard length.
      test_utils::stopAtBlockTop(clip, ctx);
      expect(clip.recState() == ClipNode::RecState::Idle);
      expectEquals((int)clip.duration_samples.load(), 1024);
      expect(clip.isPlaying(), "committed take sounds");
      expect(clip.contentKind() == ClipNode::ContentKind::Midi);
      // THE END SEAM: note 64 was still down when the take ended, so the
      // commit closed it at the last sample (docs/vst3.md §8.4).
      expectEquals(clip.midiSequence().count(), 4);
      expectEquals((int)clip.midiSequence()[2].pos, 612);
      expectEquals((int)clip.midiSequence()[3].pos, 1023,
                   juce::String("held note closed at the last sample"));
      expect(clip.midiSequence()[3].isNoteOff() &&
                 clip.midiSequence()[3].note() == 64 &&
                 clip.midiSequence()[3].channel0() == 0,
             "...with a note-off for that note on its channel");
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
      expectWithinAbsoluteError(left[1022],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "held to the last sample");
      expectWithinAbsoluteError(left[1023], 0.0f, 1e-9f,
                                "closed at the last sample (end seam)");
      expectWithinAbsoluteError(right[612],
                                test_utils::StubSynthInstance::kLevel, 1e-6f,
                                "stereo out");
      expectEquals(synth->note_ons - ons_before, 2);

      // Next cycle: the content owns its releases (276 and the end
      // seam at 1023), so the loop seam has nothing hanging to close;
      // note 60 re-sounds from 10.
      const int offs_before = synth->note_offs;
      ctx.master_pos = 1024;
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expectEquals(synth->note_offs - offs_before, 2,
                   juce::String("the two recorded note-offs, no seam extra"));
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "silent at the seam");
      expectWithinAbsoluteError(left[10], test_utils::StubSynthInstance::kLevel,
                                1e-6f, "second pass sounds from 10");

      // What stops sounding sums nothing (the sound-off pair each of
      // these edges sends the instrument is midi_release_tests'). A
      // transport stop mid-note first:
      ctx.master_pos = 2048;  // third pass: note 60 sounds from 10
      ctx.num_samples = 64;
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(synth->note_held, "note 60 sounding");
      ctx.is_playing = false;
      ctx.master_pos = 2112;  // the next block: played on, the note holds
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expectWithinAbsoluteError(left[0], 0.0f, 1e-9f, "silent after stop");

      // Then a mute: the instrument keeps being fed (an unmute resumes
      // mid-phrase) but nothing sums. The mute edge fades (~10 ms,
      // sequencer.md §9), so one fade-length block settles it first.
      ctx.is_playing = true;
      clip.is_muted.store(true);
      ctx.master_pos = 3072 - 441;
      ctx.num_samples = 441;
      clip.process(nullptr, outs, 0, 2, ctx);
      ctx.master_pos = 3072;  // fourth pass top: note 60 at 10 again
      ctx.num_samples = 64;
      std::fill(left.begin(), left.end(), 0.0f);
      clip.process(nullptr, outs, 0, 2, ctx);
      expect(synth->note_held, "muted clip still feeds its instrument");
      expectWithinAbsoluteError(left[20], 0.0f, 1e-9f, "muted sums nothing");
    }

    beginTest("a cancelled MIDI arm leaves no kind behind: without its "
              "instrument the empty clip is an audio track again");
    {
      ClipNode clip("Keys", sr);
      installStubSynth(clip, sr);
      clip.startRecording();
      expect(clip.contentKind() == ClipNode::ContentKind::Midi,
             "armed as a MIDI take");
      clip.stopRecording();  // still armed: a cancel
      expect(clip.recState() == ClipNode::RecState::Idle, "cancelled");
      expect(clip.isMidiClip(), "a MIDI track while the instrument is there");
      delete clip.exchangeFxChain(dsp::FxChain::makeDefault().release());
      expect(!clip.isMidiClip(), "an audio track once it is gone");
      expect(clip.contentKind() == ClipNode::ContentKind::Audio,
             "and it renders as one (input monitoring reaches it)");
      expectEquals(clip.getMetadata().getProperty("contentKind", "").toString(),
                   juce::String("audio"), "published as audio");
    }

    beginTest("a one-shot group's rest releases a MIDI member's hanging note "
              "at its top - a note-off, no sound-off pair - nothing repeats "
              "per block, and the next firing plays again");
    {
      // The kit fires its 1Q shot once per 4Q cycle. Its MIDI member
      // strikes a note in the shot and never releases it.
      const int q = 4410, n = 441;
      StackNode root("Island");
      root.addChild(test_utils::committedClip("Bass", sr, 4 * q, 0.0f));
      auto kit = std::make_unique<StackNode>("Kit");
      kit->period_from_context_.store(true);
      auto keys = std::make_unique<ClipNode>("Keys", sr);
      auto* synth = installStubSynth(*keys, sr);
      keys->origin_samples.store(0);
      keys->duration_samples.store(q);
      keys->loadCommittedMidi({eventAt(10, noteOn(60))}, 0);
      kit->addChild(std::move(keys));
      root.addChild(std::move(kit));

      const auto runAt = [&](int64_t pos) {
        test_utils::NodeContext nc = test_utils::contextFor(root, n, pos);
        nc.ctx.sample_rate = sr;
        nc.ctx.is_playing = true;
        std::vector<float> l((size_t)n, 0.0f), r((size_t)n, 0.0f);
        float* outs[] = {l.data(), r.data()};
        root.process(nullptr, outs, 0, 2, nc.ctx);
      };
      for (int64_t t = 0; t < q; t += n) runAt(t);
      expect(synth->note_held, "the shot: the note sounds to its end");
      expectEquals(synth->note_ons, 1);
      runAt(q);  // the rest's first block
      expect(!synth->note_held, "the rest's top releases it");
      const int offs = synth->note_offs, pairs = synth->all_sound_off;
      expectGreaterThan(offs, 0, juce::String("with a note-off"));
      expectEquals(pairs, 0, juce::String("and no sound-off pair: a rest, not a stop"));
      for (int64_t t = q + n; t < 4 * q; t += n) runAt(t);
      expectEquals(synth->note_offs, offs, juce::String("once, not per block"));
      expectEquals(synth->all_sound_off, pairs,
                   juce::String("no sound-off repeats through the rest"));
      expectEquals(synth->note_ons, 1, juce::String("the rest plays nothing"));
      runAt(4 * q);
      expectEquals(synth->note_ons, 2, juce::String("the next firing strikes"));
      expect(synth->note_held, "and sounds");
    }

    beginTest("MIDI take: a note held across the START lands at content 0 (I1)");
    {
      // The history path (the engine's): notes struck before the
      // capture window and still down when it opens are sounding at
      // the take's top, so they enter as note-ons at content 0 with
      // their velocity; a note struck AND released before the window
      // leaves nothing.
      HistoryTake take(sr);
      ClipNode& clip = take.clip;
      take.arrive(1000, noteOn(57));  // struck and released before
      take.arrive(1040, noteOff(57));
      take.arrive(1050, noteOn(59, 77));  // held across the start
      take.arrive(1100, noteOff(59));     // released AT the top
      take.arrive(1120, noteOn(62, 80));  // inside the window
      take.block(1000);
      expectEquals(clip.midiSequence().count(), 3,
                   juce::String("prelude note-on + its release + note 62"));
      if (clip.midiSequence().count() == 3) {
        const MidiEvent& top = clip.midiSequence()[0];
        expectEquals((int)top.pos, 0, juce::String("held note at content 0"));
        expect(top.isNoteOn() && top.note() == 59 && top.velocity() == 77,
               "its own note and velocity");
        const MidiEvent& release = clip.midiSequence()[1];
        expectEquals((int)release.pos, 0);
        expect(release.isNoteOff() && release.note() == 59,
               "the release at the top follows its note-on");
        expectEquals((int)clip.midiSequence()[2].pos, 20);
      }
      // Later blocks fold nothing more (the prelude is a one-time act).
      take.arrive(1300, noteOff(62));
      take.block(1256);
      expectEquals(clip.midiSequence().count(), 4);
      take.stop();
      expect(clip.recState() == ClipNode::RecState::Idle, "committed");
      expectEquals(clip.midiSequence().count(), 4,
                   juce::String("nothing held at the end: no seam close"));
    }

    beginTest("MIDI take: arrival-history capture is latency-compensated");
    {
      HistoryTake take(sr);
      ClipNode& clip = take.clip;

      // Already in the history before the arm block: one note struck
      // before the take's window and still down when it opens (the
      // prelude: it lands at content 0) and one inside it (the
      // reach-back — content 0 ↔ arrival 1100).
      take.arrive(1050, noteOn(59));
      take.arrive(1120, noteOn(62, 80));

      // Block 0 (master 1000, input clock 1000): first-clip arm at
      // compensated 1000 → window starts at arrival 1100; this block
      // covers arrivals [1100, 1256) = 156 heard samples.
      take.arrive(1150, noteOn(60));
      take.block(1000);
      expectEquals(clip.recordedLength(), (int64_t)156,
                   juce::String("lead honored"));
      expectEquals(clip.midiSequence().count(), 3);
      expectEquals((int)clip.midiSequence()[0].pos, 0,
                   juce::String("prelude note 59 sounds at the top"));
      expectEquals((int)clip.midiSequence()[1].pos, 20,
                   juce::String("reach-back event at 1120 -> 20"));
      expectEquals((int)clip.midiSequence()[2].pos, 50,
                   juce::String("1150 -> 50 (100 samples compensated)"));

      // Block 1: arrival 1300 → 156 + (1300 − 1256) = 200.
      take.arrive(1300, noteOff(60));
      take.block(1256);
      expectEquals(clip.recordedLength(), (int64_t)412);
      expectEquals(clip.midiSequence().count(), 4);
      expectEquals((int)clip.midiSequence()[3].pos, 200);

      // Stop: notes 59 and 62 are still down — the end seam closes both
      // at the last sample.
      take.stop();
      expectEquals((int)clip.duration_samples.load(), 412);
      expectEquals(clip.midiSequence().count(), 6);
      expectEquals((int)clip.midiSequence()[5].pos, 411,
                   juce::String("closed at duration - 1"));
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
      timing::TimeMap map;
      map.n = 2;
      map.segs[0] = {100, 200};
      map.segs[1] = {500, 600};
      ctx.map = map;
      ctx.map_heard_top = 0;
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
      scenario::Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.createClip();
      engine.addPluginSlotToChain(id, test_utils::makeStubSynthSlot(), -1);
      expect(is.sprop(id, "contentKind") == "midi",
             "empty clip with an instrument publishes as a MIDI track");

      // Record: the take is MIDI and the track becomes the MIDI target.
      engine.startRecordingInNode(id);
      expect(is.bprop(id, "midiArmed"), "record MIDI-arms the track");
      is.drive(512);
      engine.handleIncomingMidiMessage(nullptr, noteOn(60));
      is.drive(512);
      engine.handleIncomingMidiMessage(nullptr, noteOff(60));
      is.drive(512 * 4);
      engine.stopRecordingInNode(id);
      is.settle();
      expect(test_utils::isClipCommitted(engine, id), "committed");
      expect(is.sprop(id, "contentKind") == "midi", "committed as MIDI");
      expectEquals((int)is.iprop(id, "midiEvents"), 2,
                   juce::String("both events captured"));
      const int64_t duration = is.dur(id);
      expectGreaterThan(duration, (int64_t)0);

      // Persistence: save → load keeps the notes and the kind.
      auto dir = test_utils::freshTempDir("midi_take");
      expect(engine.saveSession(dir.getFullPathName()), "save");
      scenario::Island loaded;
      expect(loaded.engine.loadSession(dir.getFullPathName()), "load");
      const juce::StringArray nodes = loaded.childIds();
      expectEquals(nodes.size(), 1, juce::String("one node"));
      expect(loaded.sprop(nodes[0], "contentKind") == "midi",
             "kind survives the round-trip");
      expectEquals((int)loaded.iprop(nodes[0], "midiEvents"), 2);
      expectEquals(loaded.dur(nodes[0]), duration, "duration survives");
    }

    beginTest("session_io: MIDI positions round-trip exactly (QTime)");
    {
      const int64_t Q = 48000;
      const int64_t zero = 777;
      StackNode root("SessionRoot");
      root.setQuantum(Q, zero);
      auto clip = std::make_unique<ClipNode>("Keys", (double)Q);
      clip->origin_samples.store(zero + Q);
      clip->duration_samples.store(2 * Q);
      clip->setLoopPoints(0, 2 * Q);
      clip->loadCommittedMidi(
          {eventAt(7, noteOn(60, 101)),
           eventAt(12345, juce::MidiMessage::controllerEvent(1, 74, 5)),
           eventAt(2 * Q - 1, noteOff(60)),
           eventAt(2 * Q + 5, noteOn(61))},  // beyond duration: not saved
          0);
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
