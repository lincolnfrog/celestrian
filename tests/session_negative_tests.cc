/**
 * Session negative-path tests (src/session_io.h).
 *
 * Pins how the bundle format degrades: missing directories, missing or
 * corrupt session.json, a wav that vanished out from under its clip,
 * readBundleInfo on broken bundles, the incremental-save wav skip, and
 * AudioEngine::loadSession's mid-take refusal + history clear.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <set>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/session_io.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::freshTempDir;
using test_utils::isClipCommitted;
using test_utils::nodesOf;

class SessionNegativeTests : public juce::UnitTest {
 public:
  SessionNegativeTests() : juce::UnitTest("Session Negative Paths") {}

  void runTest() override {
    const int64_t Q = 48000;

    beginTest("load: nonexistent directory → ok == false");
    {
      const juce::File missing =
          juce::File::getSpecialLocation(juce::File::tempDirectory)
              .getChildFile("celestrian_test_does_not_exist_ever");
      missing.deleteRecursively();
      auto loaded = session_io::load(missing, (double)Q);
      expect(!loaded.ok, "missing directory refuses to load");
      expectEquals(loaded.children.size(), (size_t)0, "no children invented");
    }

    beginTest("load: directory without session.json → ok == false");
    {
      auto dir = freshTempDir("neg_no_json");
      auto loaded = session_io::load(dir, (double)Q);
      expect(!loaded.ok, "empty directory is not a bundle");
      expectEquals(loaded.children.size(), (size_t)0, "no children invented");
    }

    beginTest("load: malformed session.json → ok == false, no crash");
    {
      auto dir = freshTempDir("neg_bad_json");
      dir.getChildFile("session.json").replaceWithText("{ not json !!");
      auto loaded = session_io::load(dir, (double)Q);
      expect(!loaded.ok, "garbage json refuses to load");
      expectEquals(loaded.children.size(), (size_t)0, "no children invented");
    }

    beginTest(
        "load: session.json referencing a missing wav → clip loads EMPTY, "
        "session still ok");
    {
      StackNode root("MissingWavRoot");
      root.setQuantum(Q, 0);
      auto clip = std::make_unique<ClipNode>("Ghost", (double)Q);
      clip->origin_samples.store(0);
      clip->duration_samples.store(2 * Q);
      juce::AudioBuffer<float> audio(1, (int)(2 * Q));
      for (int i = 0; i < audio.getNumSamples(); ++i)
        audio.setSample(0, i, std::sin((float)i * 0.001f));
      clip->loadCommitted(audio, 2 * Q);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_missing_wav");
      expect(session_io::save(root, (double)Q, dir), "save");
      auto wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      expect(wav.existsAsFile(), "wav was written");
      expect(wav.deleteFile(), "wav deleted out from under the bundle");

      auto loaded = session_io::load(dir, (double)Q);
      // Pinned behavior: a missing wav does NOT fail the load — the
      // session comes back ok with the clip present but audio-less.
      expect(loaded.ok, "session still loads ok");
      expectEquals(loaded.children.size(), (size_t)1, "clip still present");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr, "child is the clip");
      // Duration is a JSON fact (periodQ) and survives without the wav.
      expectEquals((juce::int64)c->duration_samples.load(),
                   (juce::int64)(2 * Q), "duration preserved from json");
      // The buffer is degraded: loadCommitted never ran, so the content
      // is the constructor's one-second mono baseline of silence — NOT
      // the 2Q take that the json's duration promises.
      expectEquals(c->contentChannels(), 1, "baseline mono content");
      expectEquals(c->getAudioBuffer().getNumSamples(), (int)Q,
                   "buffer stays at the 1 s constructor baseline");
      expectEquals(c->getAudioBuffer().getSample(0, 0), 0.0f,
                   "baseline content is silent");
    }

    beginTest("readBundleInfo: missing and corrupt bundles report !ok");
    {
      auto empty = freshTempDir("neg_info_empty");
      expect(!session_io::readBundleInfo(empty).ok, "empty dir: !ok");

      auto corrupt = freshTempDir("neg_info_corrupt");
      corrupt.getChildFile("session.json").replaceWithText("{ not json !!");
      expect(!session_io::readBundleInfo(corrupt).ok, "corrupt json: !ok");

      StackNode root("InfoRoot");
      root.setQuantum(Q, 0);
      auto valid = freshTempDir("neg_info_valid");
      session_io::SaveOptions opts;
      opts.display_name = "X";
      opts.created = "2026-01-01";
      expect(session_io::save(root, (double)Q, valid, opts), "save");
      const auto info = session_io::readBundleInfo(valid);
      expect(info.ok, "valid bundle: ok");
      expectEquals(info.name, juce::String("X"), "name read back");
      expectEquals(info.created, juce::String("2026-01-01"),
                   "created stamp echoed verbatim");
    }

    beginTest(
        "incremental save skips unchanged wavs and rewrites on "
        "duration change");
    {
      StackNode root("IncrementalRoot");
      root.setQuantum(Q, 0);
      auto clip = std::make_unique<ClipNode>("Take", (double)Q);
      clip->origin_samples.store(0);
      clip->duration_samples.store(2 * Q);
      juce::AudioBuffer<float> audio(1, (int)(2 * Q));
      for (int i = 0; i < audio.getNumSamples(); ++i)
        audio.setSample(0, i, std::sin((float)i * 0.001f));
      clip->loadCommitted(audio, 0);
      ClipNode* live = clip.get();
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_incremental");
      session_io::SaveOptions opts;
      opts.incremental = true;
      expect(session_io::save(root, (double)Q, dir, opts), "first save");
      auto wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      expect(wav.existsAsFile(), "wav written on the first save");
      const auto first_mtime = wav.getLastModificationTime();
      const auto first_size = wav.getSize();

      // Committed audio is immutable — an unchanged duration must skip
      // the rewrite. Sleep past the filesystem's mtime resolution so a
      // rewrite would definitely move the timestamp.
      juce::Thread::sleep(1100);
      expect(session_io::save(root, (double)Q, dir, opts), "second save");
      expect(wav.getLastModificationTime() == first_mtime,
             "unchanged wav NOT rewritten (mtime stable)");
      expectEquals(wav.getSize(), first_size, "unchanged wav same length");

      // A lock-collapse CHANGES the duration; on-disk length now
      // mismatches, which is exactly the incremental rewrite trigger
      // (content base stays 0 here — writeClipWav saves [base, base+n)).
      live->duration_samples.store(Q);
      expect(session_io::save(root, (double)Q, dir, opts), "third save");
      expect(wav.getLastModificationTime() != first_mtime ||
                 wav.getSize() != first_size,
             "duration change rewrites the wav");
      expect(wav.getSize() < first_size, "rewritten wav holds the halved take");
    }

    beginTest(
        "AudioEngine::loadSession refuses mid-take and clears history "
        "after load");
    {
      AudioEngine engine;
      auto process = [&engine](int total) {
        test_utils::driveEngine(engine, total);
      };
      const int64_t take = 44100;  // engine default rate: 1 s first take
      test_utils::recordClip(engine, process, take);

      auto dir = freshTempDir("neg_midtake");
      expect(engine.saveSession(dir.getFullPathName()), "session saved");

      // Arm a SECOND take and drive it into capture — in flight, not
      // committed. (The graph-state var must outlive nodesOf's pointer.)
      std::set<juce::String> before;
      {
        const juce::var state = engine.getGraphState();
        if (auto* nodes = nodesOf(state))
          for (auto& node : *nodes)
            before.insert(node.getProperty("id", "").toString());
      }
      engine.createNode("clip");
      juce::String second_id;
      {
        const juce::var state = engine.getGraphState();
        if (auto* nodes = nodesOf(state))
          for (auto& node : *nodes) {
            const auto node_id = node.getProperty("id", "").toString();
            if (!before.count(node_id)) second_id = node_id;
          }
      }
      expect(second_id.isNotEmpty(), "second clip created");
      engine.startRecordingInNode(second_id);
      process(100);
      process((int)take / 2);
      expect(engine.hasActiveTake(), "take is in flight");

      int node_count_before = 0;
      {
        const juce::var state = engine.getGraphState();
        node_count_before = nodesOf(state)->size();
      }
      expect(!engine.loadSession(dir.getFullPathName()),
             "mid-take load refused");
      {
        const juce::var state = engine.getGraphState();
        expectEquals(nodesOf(state)->size(), node_count_before,
                     "graph untouched by the refusal");
      }

      // Commit the take, make an undoable edit, then load for real.
      engine.stopRecordingInNode(second_id);
      for (int i = 0; i < 400 && !isClipCommitted(engine, second_id); ++i)
        process(512);
      expect(isClipCommitted(engine, second_id), "take committed");
      engine.renameNode(second_id, "Renamed");
      expect(engine.canUndo(), "undoable edit on the books");

      expect(engine.loadSession(dir.getFullPathName()),
             "load succeeds once idle");
      expect(!engine.canUndo(), "loaded session starts with no history");
      {
        const juce::var state = engine.getGraphState();
        expectEquals(nodesOf(state)->size(), 1,
                     "the saved single-clip session is on stage");
      }
    }
  }
};

static SessionNegativeTests sessionNegativeTests;

}  // namespace celestrian
