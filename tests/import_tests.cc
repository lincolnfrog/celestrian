/**
 * AUDIO FILE IMPORT (docs/import.md): a WAV/AIFF/FLAC becomes a
 * committed take through the record path's laws. Pins:
 *
 *   (a) a 44.1k WAV of exactly 2Q dropped at frame 1Q imports as a 2Q
 *       committed clip at origin = zero + 1Q, snapped (whole window);
 *   (b) a 1.3Q file keeps its raw length with the window at 1Q (the
 *       hysteresis law, timing::snapCommittedDuration);
 *   (c) a 48k file into a 44.1k island is resampled to the device
 *       rate's length;
 *   (d) an import into an empty island defines Q (a first take);
 *   (e) an import onto a committed slot becomes a NEW TAKE cut (or
 *       zero-padded) to the slot's period, active on arrival;
 *   (f) undo removes the take; a second undo empties the clip and
 *       reverts the grid; redo brings both back;
 *   (g) stereo is preserved; channels beyond two fold to stereo;
 *   (h) a stack target gains a clip named after the file; a MIDI
 *       track and a missing file are refused;
 *   (i) getMidiNotes pairs note-on/off into QTime rows and runs an
 *       unpaired note-on to the take end (docs/vst3.md §8.4).
 *
 * Twin: ui/js/tests/import_mock.test.mjs (the mock's contract).
 */

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>

#include <functional>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/midi_sequence.h"
#include "test_utils.h"

namespace {

using celestrian::test_utils::addNode;
using celestrian::test_utils::clipOf;
using celestrian::test_utils::EngineRig;
using celestrian::test_utils::findVar;
using celestrian::test_utils::peakOf;
using celestrian::test_utils::presentProp;
using celestrian::test_utils::RigInput;
using celestrian::test_utils::rootId;
using celestrian::test_utils::rootProp;
using celestrian::test_utils::firstDifference;
using celestrian::test_utils::graphFacts;
using celestrian::test_utils::writeWav;

const int Q = 1000;

int64_t islandQ(AudioEngine& engine) { return rootProp(engine, "quantum"); }
int64_t islandZero(AudioEngine& engine) {
  return rootProp(engine, "islandZero");
}

/** Records a first take of silence that establishes Q exactly
 * (recordClip drives 100 samples before the length it is given). */
void establishQ(AudioEngine& engine) {
  celestrian::test_utils::recordSilentTake(engine, Q - 100);
}

/** An absolute origin `q` (possibly fractional) Qs past the island
 * zero — what the view hands importAudio (docs/frame.md); the engine
 * snaps it to the nearest Q boundary. */
int64_t at(AudioEngine& engine, double q) {
  return islandZero(engine) + (int64_t)std::llround(q * (double)Q);
}

}  // namespace

class ImportTests : public juce::UnitTest {
 public:
  ImportTests() : juce::UnitTest("Audio file import", "Audio Engine") {}

  /** Expect the engine's published graph to be `want` (a graphFacts
   * capture); a failure names the first fact that differs. */
  void expectGraph(AudioEngine& engine, const juce::var& want,
                   const juce::String& label) {
    const juce::String diff = firstDifference(want, graphFacts(engine));
    expect(diff.isEmpty(), label + (diff.isEmpty() ? "" : " - " + diff));
  }

  void runTest() override {
    const juce::File dir = celestrian::test_utils::freshTempDir("import");

    beginTest("(a) a 2Q WAV at frame 1Q lands snapped at zero + 1Q");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      expectEquals(islandQ(engine), (int64_t)Q, "Q established by the take");
      const int64_t zero = islandZero(engine);
      const juce::String id = addNode(engine, "clip");
      const juce::File wav = writeWav(dir, "two_q.wav", 44100.0, 1, 2 * Q);
      expect(engine.importAudio(id, wav.getFullPathName(), at(engine, 1)), "imported");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)(2 * Q),
                   "2Q committed");
      expectEquals((int64_t)presentProp(engine, id, "origin"), zero + Q,
                   "origin = zero + 1Q");
      expectEquals((int64_t)presentProp(engine, id, "loopEnd"), (int64_t)0,
                   "whole: no window");
      expectEquals((int)presentProp(engine, id, "takes"), 1, "one take");
      expectEquals((int)presentProp(engine, id, "channels"), 1, "mono stays mono");
      expect(!(bool)findVar(engine.getGraphState(), id)
                  .getProperty("isRecording", true),
             "idle after the import");
      // The cycle grew 1Q -> 2Q, and no commit moves the island zero
      // (docs/frame.md) — as for a recorded take.
      expectEquals(islandZero(engine), zero,
                   "the zero stays through growth, as for a recorded take");
      // A fractional drop snaps to the nearest boundary (Q11).
      const juce::String id2 = addNode(engine, "clip");
      const int64_t zero2 = islandZero(engine);
      expect(engine.importAudio(id2, wav.getFullPathName(), at(engine, 2.5)), "5/2 Q");
      expectEquals((int64_t)presentProp(engine, id2, "origin"), zero2 + 3 * Q,
                   "5/2 rounds to the 3Q boundary");
      // The buffer holds the file's samples.
      auto* clip = clipOf(engine, id);
      expect(clip != nullptr);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2 * Q - 1),
                                0.5f, 1e-4f, "content copied");
      // Playback: the imported clip sounds (the render path reads it).
      expect(peakOf(rig.hear(8 * 512, RigInput::Silence).left) > 0.1f,
             "the imported material renders");
    }

    beginTest("(b) a 1.3Q file keeps its raw length, window at 1Q");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String id = addNode(engine, "clip");
      const juce::File wav = writeWav(dir, "one_three_q.wav", 44100.0, 1,
                                      (int)(1.3 * Q));
      expect(engine.importAudio(id, wav.getFullPathName(), at(engine, 0)), "imported");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)(1.3 * Q),
                   "raw length kept (outside the hysteresis tolerance)");
      expectEquals((int64_t)presentProp(engine, id, "loopEnd"), (int64_t)Q,
                   "window at the previous clean multiple");
      // Inside the tolerance: 1.1Q snaps to 1Q.
      const juce::String id2 = addNode(engine, "clip");
      const juce::File wav2 = writeWav(dir, "one_one_q.wav", 44100.0, 1,
                                       (int)(1.1 * Q));
      expect(engine.importAudio(id2, wav2.getFullPathName(), at(engine, 0)));
      expectEquals((int64_t)presentProp(engine, id2, "duration"), (int64_t)Q,
                   "1.1Q snaps down to 1Q");
    }

    beginTest("(c) a 48k file into a 44.1k island resamples to length");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String id = addNode(engine, "clip");
      // 4800 frames at 48k = 0.1 s = 4410 frames at 44.1k: outside the
      // snap tolerance from 4000 and 5000, so the raw length shows.
      const juce::File wav = writeWav(dir, "forty_eight.wav", 48000.0, 1, 4800);
      expect(engine.importAudio(id, wav.getFullPathName(), at(engine, 0)), "imported");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)4410,
                   "resampled to the device rate");
      expectEquals((int64_t)presentProp(engine, id, "loopEnd"), (int64_t)4000,
                   "window at 4Q");
      auto* clip = clipOf(engine, id);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2000),
                                0.5f, 1e-2f, "level survives the resample");
    }

    beginTest("(d) an import into an empty island defines Q");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      const juce::File wav = writeWav(dir, "seed.wav", 44100.0, 1, 1500);
      expect(engine.importAudio(id, wav.getFullPathName(), at(engine, 0)), "imported");
      expectEquals(islandQ(engine), (int64_t)1500, "Q = the file's length");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)1500);
      expectEquals(islandZero(engine), (int64_t)presentProp(engine, id, "origin"),
                   "zero = the first take's origin");
      expect(engine.canUndo(), "logged");
      engine.undo();
      expectEquals(islandQ(engine), (int64_t)0, "undo reverts the grid");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)0,
                   "undo empties the clip");
      engine.redo();
      expectEquals(islandQ(engine), (int64_t)1500, "redo re-establishes Q");
    }

    beginTest("(e) an import onto a committed slot is a new take, cut to the period");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String id = addNode(engine, "clip");
      const juce::File two = writeWav(dir, "slot.wav", 44100.0, 1, 2 * Q);
      expect(engine.importAudio(id, two.getFullPathName(), at(engine, 0)));
      const int64_t origin = (int64_t)presentProp(engine, id, "origin");
      // Longer than the slot: cut.
      const juce::File three = writeWav(dir, "long.wav", 44100.0, 1, 3 * Q, 0.7f);
      expect(engine.importAudio(id, three.getFullPathName(), at(engine, 1)),
             "second import lands as a take");
      expectEquals((int)presentProp(engine, id, "takes"), 2, "two takes");
      expectEquals((int)presentProp(engine, id, "activeTake"), 1, "the new one active");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)(2 * Q),
                   "period unchanged");
      expectEquals((int64_t)presentProp(engine, id, "origin"), origin,
                   "origin unchanged (the drop position is ignored)");
      auto* clip = clipOf(engine, id);
      expectEquals(clip->getAudioBuffer().getNumSamples(), 2 * Q,
                   "cut to the period");
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2 * Q - 1),
                                0.7f, 1e-4f, "the file's material");
      // Shorter than the slot: zero-padded.
      const juce::File half = writeWav(dir, "short.wav", 44100.0, 1, Q / 2, 0.3f);
      expect(engine.importAudio(id, half.getFullPathName(), at(engine, 0)));
      expectEquals((int)presentProp(engine, id, "takes"), 3);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, Q / 2 - 1),
                                0.3f, 1e-4f, "material where the file had it");
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, Q / 2),
                                0.0f, 1e-6f, "silence past the file");

      beginTest("(f) undo removes the take; a second undo empties the clip");
      engine.undo();
      expectEquals((int)presentProp(engine, id, "takes"), 2, "third take gone");
      expectEquals((int)presentProp(engine, id, "activeTake"), 1, "previous active back");
      engine.undo();
      expectEquals((int)presentProp(engine, id, "takes"), 1, "second take gone");
      expectEquals((int)presentProp(engine, id, "activeTake"), 0);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 10), 0.5f,
                                1e-4f, "take 0 sounds again");
      engine.undo();
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)0,
                   "the first import undone: the clip is empty");
      expectEquals(islandQ(engine), (int64_t)Q, "Q survives (the recorded take)");
      engine.redo();
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)(2 * Q),
                   "redo reinstalls the import");
      engine.redo();
      expectEquals((int)presentProp(engine, id, "takes"), 2, "redo re-appends the take");
    }

    beginTest("(g) stereo is preserved; more channels fold to stereo");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String id = addNode(engine, "clip");
      const juce::File stereo = writeWav(dir, "stereo.wav", 44100.0, 2, Q);
      expect(engine.importAudio(id, stereo.getFullPathName(), at(engine, 0)));
      expectEquals((int)presentProp(engine, id, "channels"), 2, "stereo published");
      auto* clip = clipOf(engine, id);
      expectEquals(clip->getAudioBuffer().getNumChannels(), 2);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(1, 5), 0.51f,
                                1e-4f, "the right side is the file's right");
      const juce::String id2 = addNode(engine, "clip");
      const juce::File quad = writeWav(dir, "quad.wav", 44100.0, 4, Q);
      expect(engine.importAudio(id2, quad.getFullPathName(), at(engine, 0)));
      expectEquals((int)presentProp(engine, id2, "channels"), 2, "four fold to two");
      auto* clip2 = clipOf(engine, id2);
      // Left = mean(ch0, ch2) = 0.51, right = mean(ch1, ch3) = 0.52.
      expectWithinAbsoluteError(clip2->getAudioBuffer().getSample(0, 5), 0.51f,
                                1e-4f, "odd channels fold left");
      expectWithinAbsoluteError(clip2->getAudioBuffer().getSample(1, 5), 0.52f,
                                1e-4f, "even channels fold right");
    }

    beginTest("(h) a stack target gains a clip named after the file; refusals");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String stack = addNode(engine, "stack");
      const juce::File wav = writeWav(dir, "Kick Loop.wav", 44100.0, 1, Q);
      expect(engine.importAudio(stack, wav.getFullPathName(), at(engine, 2)));
      const juce::var sv = findVar(engine.getGraphState(), stack);
      auto* kids = sv.getProperty("nodes", juce::var()).getArray();
      expect(kids != nullptr && kids->size() == 1, "one clip child");
      const juce::var kid = (*kids)[0];
      expectEquals(kid.getProperty("name", "").toString(),
                   juce::String("Kick Loop"), "named after the file");
      expectEquals((int64_t)(double)kid.getProperty("duration", 0.0), (int64_t)Q);
      expectEquals((int64_t)(double)kid.getProperty("origin", 0.0),
                   islandZero(engine) + 2 * Q, "placed at 2Q");
      expect((bool)sv.getProperty("anchored", false),
             "the stack anchors on its first content (Q18)");
      // Refusals: a missing file, a live take.
      const juce::String id = addNode(engine, "clip");
      expect(!engine.importAudio(id, dir.getChildFile("nope.wav").getFullPathName(), at(engine, 0)),
             "a missing file is refused");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)0,
                   "nothing landed");
      engine.startRecordingInNode(id);
      expect(!engine.importAudio(id, wav.getFullPathName(), at(engine, 0)),
             "refused while a take is live");
      engine.stopRecordingInNode(id);
    }

    beginTest("(h) an import onto a stack, or the root, is one undo step: "
              "the clip it made goes with the take");
    for (const bool onto_root : {false, true}) {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String target =
          onto_root ? rootId(engine) : addNode(engine, "stack");
      const juce::String label = onto_root ? "the root: " : "a stack: ";
      const juce::File wav = writeWav(dir, "one_step.wav", 44100.0, 1, Q);
      const juce::var found = graphFacts(engine);
      expect(engine.importAudio(target, wav.getFullPathName(), at(engine, 1)),
             label + "imported");
      const juce::var made = graphFacts(engine);
      expect(firstDifference(found, made).isNotEmpty(),
             label + "the import changed the graph");
      engine.undo();
      expectGraph(engine, found, label + "one undo removes take and clip");
      engine.redo();
      expectGraph(engine, made, label + "one redo brings both back");
      engine.undo();
      expectGraph(engine, found, label + "undone again");
    }

    beginTest("(d) an import that establishes Q scrubs pre-Q geometry, and "
              "its undo brings it back");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String box = addNode(engine, "stack");
      engine.setLoopPoints(box, 0, 777);  // a free length: no Q to judge it
      const juce::String id = addNode(engine, "clip");
      const juce::File wav = writeWav(dir, "establish.wav", 44100.0, 1, 1500);
      const juce::var found = graphFacts(engine);
      expect(engine.importAudio(id, wav.getFullPathName(), 0), "imported");
      expectEquals(islandQ(engine), (int64_t)1500, "Q = the file's length");
      expectEquals((int64_t)presentProp(engine, box, "loopEnd"), (int64_t)0,
                   "777 cannot live on Q = 1500: scrubbed");
      const juce::var made = graphFacts(engine);
      engine.undo();
      expectGraph(engine, found, "undo restores the window with the grid");
      engine.redo();
      expectGraph(engine, made, "redo scrubs it again");
    }

    beginTest("(c) a file whose RESAMPLED length passes the take ceiling is "
              "refused before it is decoded");
    {
      // 3M frames of 8-bit mono at 100 Hz: under the ceiling as stored,
      // 441 times longer at the island's rate. Only the header is
      // written — a refusal never reads the samples.
      const juce::File file = dir.getChildFile("slow_rate.wav");
      file.deleteFile();
      {
        const int frames = 3000000, rate = 100;
        juce::FileOutputStream out(file);
        out.write("RIFF", 4);
        out.writeInt(36 + frames);
        out.write("WAVEfmt ", 8);
        out.writeInt(16);         // fmt chunk size
        out.writeShort(1);        // PCM
        out.writeShort(1);        // mono
        out.writeInt(rate);
        out.writeInt(rate);       // bytes per second
        out.writeShort(1);        // block align
        out.writeShort(8);        // bits per sample
        out.write("data", 4);
        out.writeInt(frames);
      }
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      expect(!engine.importAudio(id, file.getFullPathName(), 0),
             "refused: longer than a take may be at the island's rate");
      expectEquals((int64_t)presentProp(engine, id, "duration"), (int64_t)0,
                   "nothing landed");
      expect(!engine.hasActiveTake(), "no take left counted");
    }

    beginTest("(i) getMidiNotes pairs note-on/off into QTime rows");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      establishQ(engine);
      const juce::String id = addNode(engine, "clip");
      expect(engine.getMidiNotes(id).getArray()->isEmpty(),
             "an empty clip has no notes");
      auto* clip = clipOf(engine, id);
      auto ev = [](int64_t pos, juce::uint8 status, int note, int vel) {
        celestrian::MidiEvent e;
        e.pos = pos;
        e.bytes[0] = status;
        e.bytes[1] = (juce::uint8)note;
        e.bytes[2] = (juce::uint8)vel;
        e.size = 3;
        return e;
      };
      std::vector<celestrian::MidiEvent> events = {
          ev(0, 0x90, 60, 100),   ev(500, 0x80, 60, 0),  // 60: [0, 1/2)
          ev(250, 0x90, 64, 80),  ev(1250, 0x90, 64, 0),  // 64: [1/4, 5/4) (on with vel 0 = off)
          ev(1500, 0x90, 67, 90),                          // 67: unpaired -> to the end
      };
      clip->origin_samples.store(islandZero(engine));
      clip->duration_samples.store(2 * Q);
      clip->setLoopPoints(0, 2 * Q);
      clip->loadCommittedMidi(events, 0);
      const juce::var rows = engine.getMidiNotes(id);
      auto* arr = rows.getArray();
      expect(arr != nullptr && arr->size() == 3, "three notes");
      auto row = [&](int i, int k) { return (double)(*(*arr)[i].getArray())[k]; };
      // Sorted by position: 60 @ 0, 64 @ 1/4, 67 @ 3/2.
      expectEquals(row(0, 2), 60.0);
      expectEquals(row(0, 0), 0.0);
      expectEquals(row(0, 3), 100.0);
      expectEquals(row(0, 4) / row(0, 5), 0.5, "length 1/2 Q");
      expectEquals(row(1, 2), 64.0);
      expectEquals(row(1, 0) / row(1, 1), 0.25, "position 1/4 Q");
      expectEquals(row(1, 4) / row(1, 5), 1.0, "length 1Q");
      expectEquals(row(2, 2), 67.0);
      expectEquals(row(2, 0) / row(2, 1), 1.5);
      expectEquals(row(2, 4) / row(2, 5), 0.5, "unpaired: runs to the end");
      // Importing audio onto a MIDI track is refused.
      const juce::File wav = writeWav(dir, "onto_midi.wav", 44100.0, 1, Q);
      expect(!engine.importAudio(id, wav.getFullPathName(), at(engine, 0)),
             "a MIDI track takes notes, not audio");
    }
  }
};

static ImportTests importTests;
