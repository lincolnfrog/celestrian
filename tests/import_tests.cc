/**
 * AUDIO FILE IMPORT (B6, docs/import.md): a WAV/AIFF/FLAC becomes a
 * committed take through the record path's laws. Pins:
 *
 *   (a) a 44.1k WAV of exactly 2Q dropped at frame 1Q imports as a 2Q
 *       committed clip at origin = epoch + 1Q, snapped (whole window);
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
 *       unpaired note-on to the take end (docs/vst3.md §11).
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

using celestrian::test_utils::nodesOf;

const int Q = 1000;

/** Writes a float WAV of `frames` frames at `rate`: every channel holds
 * the constant `level` (channel c at level + c/100, so a stereo file's
 * sides differ). */
juce::File writeWav(const juce::File& dir, const juce::String& name,
                    double rate, int channels, int frames,
                    float level = 0.5f) {
  const juce::File file = dir.getChildFile(name);
  file.deleteFile();
  juce::AudioBuffer<float> audio(channels, frames);
  for (int c = 0; c < channels; ++c) {
    for (int i = 0; i < frames; ++i) {
      audio.setSample(c, i, level + (float)c / 100.0f);
    }
  }
  juce::WavAudioFormat fmt;
  std::unique_ptr<juce::FileOutputStream> stream(file.createOutputStream());
  std::unique_ptr<juce::AudioFormatWriter> writer(
      fmt.createWriterFor(stream.get(), rate, (unsigned)channels, 32, {}, 0));
  stream.release();
  writer->writeFromAudioSampleBuffer(audio, 0, frames);
  writer.reset();
  return file;
}

juce::var findVar(const juce::var& node, const juce::String& id) {
  if (node.getProperty("id", "").toString() == id) return node;
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray())
    for (auto& k : *kids) {
      juce::var hit = findVar(k, id);
      if (!hit.isVoid()) return hit;
    }
  return {};
}

juce::var nodeVar(AudioEngine& engine, const juce::String& id) {
  return findVar(engine.getGraphState(), id);
}

double prop(AudioEngine& engine, const juce::String& id,
            const char* key) {
  return (double)nodeVar(engine, id).getProperty(key, -1.0);
}

int64_t islandQ(AudioEngine& engine) {
  return (int64_t)(double)engine.getGraphState().getProperty("quantum", 0.0);
}
int64_t islandEpoch(AudioEngine& engine) {
  return (int64_t)(double)engine.getGraphState().getProperty("islandEpoch",
                                                             0.0);
}

/** The id of the newest top-level node. */
juce::String lastTopId(AudioEngine& engine) {
  const juce::var s = engine.getGraphState();
  auto* n = nodesOf(s);
  return (*n)[n->size() - 1].getProperty("id", "").toString();
}

/** A fresh empty clip at the top level; returns its id. */
juce::String emptyClip(AudioEngine& engine) {
  engine.createNode("clip");
  return lastTopId(engine);
}

/** Records a first take that establishes Q exactly (recordClip drives
 * 100 samples before the length it is given, so the take is 100
 * longer than the length asked for). */
void establishQ(AudioEngine& engine) {
  auto process = [&engine](int n) {
    celestrian::test_utils::driveEngine(engine, n, 512);
  };
  celestrian::test_utils::recordClip(engine, process, Q - 100);
}

}  // namespace

class ImportTests : public juce::UnitTest {
 public:
  ImportTests() : juce::UnitTest("Audio file import", "Audio Engine") {}

  void runTest() override {
    const juce::File dir = celestrian::test_utils::freshTempDir("import");

    beginTest("(a) a 2Q WAV at frame 1Q lands snapped at epoch + 1Q");
    {
      AudioEngine engine;
      establishQ(engine);
      expectEquals(islandQ(engine), (int64_t)Q, "Q established by the take");
      const int64_t epoch = islandEpoch(engine);
      const juce::String id = emptyClip(engine);
      const juce::File wav = writeWav(dir, "two_q.wav", 44100.0, 1, 2 * Q);
      expect(engine.importAudio(id, wav.getFullPathName(), 1, 1), "imported");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)(2 * Q),
                   "2Q committed");
      expectEquals((int64_t)prop(engine, id, "origin"), epoch + Q,
                   "origin = epoch + 1Q");
      expectEquals((int64_t)prop(engine, id, "loopEnd"), (int64_t)0,
                   "whole: no window (D4-7)");
      expectEquals((int)prop(engine, id, "takes"), 1, "one take");
      expectEquals((int)prop(engine, id, "channels"), 1, "mono stays mono");
      expect(!(bool)nodeVar(engine, id).getProperty("isRecording", true),
             "idle after the import");
      // The cycle grew 1Q -> 2Q, and no commit moves the island zero
      // (docs/frame.md) — as for a recorded take.
      expectEquals(islandEpoch(engine), epoch,
                   "the zero stays through growth, as for a recorded take");
      // A fractional drop snaps to the nearest boundary (Q11).
      const juce::String id2 = emptyClip(engine);
      const int64_t epoch2 = islandEpoch(engine);
      expect(engine.importAudio(id2, wav.getFullPathName(), 5, 2), "5/2 Q");
      expectEquals((int64_t)prop(engine, id2, "origin"), epoch2 + 3 * Q,
                   "5/2 rounds to the 3Q boundary");
      // The buffer holds the file's samples.
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
      expect(clip != nullptr);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2 * Q - 1),
                                0.5f, 1e-4f, "content copied");
      // Playback: the imported clip sounds (the render path reads it).
      std::vector<float> in((size_t)512, 0.0f), l((size_t)512), r((size_t)512);
      float* ins[] = {in.data()};
      float* outs[] = {l.data(), r.data()};
      float peak = 0.0f;
      for (int b = 0; b < 8; ++b) {
        engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, 512, {});
        for (float v : l) peak = std::max(peak, std::abs(v));
      }
      expect(peak > 0.1f, "the imported material renders");
    }

    beginTest("(b) a 1.3Q file keeps its raw length, window at 1Q");
    {
      AudioEngine engine;
      establishQ(engine);
      const juce::String id = emptyClip(engine);
      const juce::File wav = writeWav(dir, "one_three_q.wav", 44100.0, 1,
                                      (int)(1.3 * Q));
      expect(engine.importAudio(id, wav.getFullPathName(), 0, 1), "imported");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)(1.3 * Q),
                   "raw length kept (outside the hysteresis tolerance)");
      expectEquals((int64_t)prop(engine, id, "loopEnd"), (int64_t)Q,
                   "window at the previous clean multiple");
      // Inside the tolerance: 1.1Q snaps to 1Q.
      const juce::String id2 = emptyClip(engine);
      const juce::File wav2 = writeWav(dir, "one_one_q.wav", 44100.0, 1,
                                       (int)(1.1 * Q));
      expect(engine.importAudio(id2, wav2.getFullPathName(), 0, 1));
      expectEquals((int64_t)prop(engine, id2, "duration"), (int64_t)Q,
                   "1.1Q snaps down to 1Q");
    }

    beginTest("(c) a 48k file into a 44.1k island resamples to length");
    {
      AudioEngine engine;
      establishQ(engine);
      const juce::String id = emptyClip(engine);
      // 4800 frames at 48k = 0.1 s = 4410 frames at 44.1k: outside the
      // snap tolerance from 4000 and 5000, so the raw length shows.
      const juce::File wav = writeWav(dir, "forty_eight.wav", 48000.0, 1, 4800);
      expect(engine.importAudio(id, wav.getFullPathName(), 0, 1), "imported");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)4410,
                   "resampled to the device rate");
      expectEquals((int64_t)prop(engine, id, "loopEnd"), (int64_t)4000,
                   "window at 4Q");
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2000),
                                0.5f, 1e-2f, "level survives the resample");
    }

    beginTest("(d) an import into an empty island defines Q");
    {
      AudioEngine engine;
      const juce::String id = emptyClip(engine);
      const juce::File wav = writeWav(dir, "seed.wav", 44100.0, 1, 1500);
      expect(engine.importAudio(id, wav.getFullPathName(), 0, 1), "imported");
      expectEquals(islandQ(engine), (int64_t)1500, "Q = the file's length");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)1500);
      expectEquals(islandEpoch(engine), (int64_t)prop(engine, id, "origin"),
                   "epoch = the first take's origin");
      expect(engine.canUndo(), "logged");
      engine.undo();
      expectEquals(islandQ(engine), (int64_t)0, "undo reverts the grid");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)0,
                   "undo empties the clip");
      engine.redo();
      expectEquals(islandQ(engine), (int64_t)1500, "redo re-establishes Q");
    }

    beginTest("(e) an import onto a committed slot is a new take, cut to the period");
    {
      AudioEngine engine;
      establishQ(engine);
      const juce::String id = emptyClip(engine);
      const juce::File two = writeWav(dir, "slot.wav", 44100.0, 1, 2 * Q);
      expect(engine.importAudio(id, two.getFullPathName(), 0, 1));
      const int64_t origin = (int64_t)prop(engine, id, "origin");
      // Longer than the slot: cut.
      const juce::File three = writeWav(dir, "long.wav", 44100.0, 1, 3 * Q, 0.7f);
      expect(engine.importAudio(id, three.getFullPathName(), 1, 1),
             "second import lands as a take");
      expectEquals((int)prop(engine, id, "takes"), 2, "two takes");
      expectEquals((int)prop(engine, id, "activeTake"), 1, "the new one active");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)(2 * Q),
                   "period unchanged");
      expectEquals((int64_t)prop(engine, id, "origin"), origin,
                   "origin unchanged (the drop position is ignored)");
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
      expectEquals(clip->getAudioBuffer().getNumSamples(), 2 * Q,
                   "cut to the period");
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 2 * Q - 1),
                                0.7f, 1e-4f, "the file's material");
      // Shorter than the slot: zero-padded.
      const juce::File half = writeWav(dir, "short.wav", 44100.0, 1, Q / 2, 0.3f);
      expect(engine.importAudio(id, half.getFullPathName(), 0, 1));
      expectEquals((int)prop(engine, id, "takes"), 3);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, Q / 2 - 1),
                                0.3f, 1e-4f, "material where the file had it");
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, Q / 2),
                                0.0f, 1e-6f, "silence past the file");

      beginTest("(f) undo removes the take; a second undo empties the clip");
      engine.undo();
      expectEquals((int)prop(engine, id, "takes"), 2, "third take gone");
      expectEquals((int)prop(engine, id, "activeTake"), 1, "previous active back");
      engine.undo();
      expectEquals((int)prop(engine, id, "takes"), 1, "second take gone");
      expectEquals((int)prop(engine, id, "activeTake"), 0);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(0, 10), 0.5f,
                                1e-4f, "take 0 sounds again");
      engine.undo();
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)0,
                   "the first import undone: the clip is empty");
      expectEquals(islandQ(engine), (int64_t)Q, "Q survives (the recorded take)");
      engine.redo();
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)(2 * Q),
                   "redo reinstalls the import");
      engine.redo();
      expectEquals((int)prop(engine, id, "takes"), 2, "redo re-appends the take");
    }

    beginTest("(g) stereo is preserved; more channels fold to stereo");
    {
      AudioEngine engine;
      establishQ(engine);
      const juce::String id = emptyClip(engine);
      const juce::File stereo = writeWav(dir, "stereo.wav", 44100.0, 2, Q);
      expect(engine.importAudio(id, stereo.getFullPathName(), 0, 1));
      expectEquals((int)prop(engine, id, "channels"), 2, "stereo published");
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
      expectEquals(clip->getAudioBuffer().getNumChannels(), 2);
      expectWithinAbsoluteError(clip->getAudioBuffer().getSample(1, 5), 0.51f,
                                1e-4f, "the right side is the file's right");
      const juce::String id2 = emptyClip(engine);
      const juce::File quad = writeWav(dir, "quad.wav", 44100.0, 4, Q);
      expect(engine.importAudio(id2, quad.getFullPathName(), 0, 1));
      expectEquals((int)prop(engine, id2, "channels"), 2, "four fold to two");
      auto* clip2 = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id2));
      // Left = mean(ch0, ch2) = 0.51, right = mean(ch1, ch3) = 0.52.
      expectWithinAbsoluteError(clip2->getAudioBuffer().getSample(0, 5), 0.51f,
                                1e-4f, "odd channels fold left");
      expectWithinAbsoluteError(clip2->getAudioBuffer().getSample(1, 5), 0.52f,
                                1e-4f, "even channels fold right");
    }

    beginTest("(h) a stack target gains a clip named after the file; refusals");
    {
      AudioEngine engine;
      establishQ(engine);
      engine.createNode("stack");
      const juce::String stack = lastTopId(engine);
      const juce::File wav = writeWav(dir, "Kick Loop.wav", 44100.0, 1, Q);
      expect(engine.importAudio(stack, wav.getFullPathName(), 2, 1));
      const juce::var sv = nodeVar(engine, stack);
      auto* kids = sv.getProperty("nodes", juce::var()).getArray();
      expect(kids != nullptr && kids->size() == 1, "one clip child");
      const juce::var kid = (*kids)[0];
      expectEquals(kid.getProperty("name", "").toString(),
                   juce::String("Kick Loop"), "named after the file");
      expectEquals((int64_t)(double)kid.getProperty("duration", 0.0), (int64_t)Q);
      expectEquals((int64_t)(double)kid.getProperty("origin", 0.0),
                   islandEpoch(engine) + 2 * Q, "placed at 2Q");
      expect((bool)sv.getProperty("anchored", false),
             "the stack anchors on its first content (Q18)");
      // Refusals: a missing file, a live take.
      const juce::String id = emptyClip(engine);
      expect(!engine.importAudio(id, dir.getChildFile("nope.wav").getFullPathName(), 0, 1),
             "a missing file is refused");
      expectEquals((int64_t)prop(engine, id, "duration"), (int64_t)0,
                   "nothing landed");
      engine.startRecordingInNode(id);
      expect(!engine.importAudio(id, wav.getFullPathName(), 0, 1),
             "refused while a take is live");
      engine.stopRecordingInNode(id);
    }

    beginTest("(i) getMidiNotes pairs note-on/off into QTime rows");
    {
      AudioEngine engine;
      establishQ(engine);
      const juce::String id = emptyClip(engine);
      expect(engine.getMidiNotes(id).getArray()->isEmpty(),
             "an empty clip has no notes");
      auto* clip = dynamic_cast<celestrian::ClipNode*>(
          engine.findNodeByUuidForTest(id));
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
      clip->origin_samples.store(islandEpoch(engine));
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
      expect(!engine.importAudio(id, wav.getFullPathName(), 0, 1),
             "a MIDI track takes notes, not audio");
    }
  }
};

static ImportTests importTests;
