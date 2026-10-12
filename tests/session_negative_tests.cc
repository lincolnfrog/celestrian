/**
 * Session negative-path tests (src/session_io.h).
 *
 * Pins how the bundle format degrades: a song block spelled wrong (the
 * one reader, Sequence::fromVar, and what a load keeps of it), missing
 * directories, missing or
 * corrupt session.json, a wav that vanished out from under its clip (or
 * one of its later takes) or cannot be opened, a wav that cannot be
 * written, readBundleInfo on broken bundles, the incremental-save wav
 * skip, and AudioEngine::loadSession's mid-take refusal + history clear.
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <functional>
#include <memory>

#if !JUCE_WINDOWS
#include <sys/stat.h>
#endif

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
    // The clip these cases save: one 2Q take at the island zero.
    const auto twoQClip = [&](const char* name,
                              const std::function<float(int64_t)>& fill,
                              int64_t context_cycle) {
      return test_utils::loadedClip(name, (double)Q, 0, 2 * Q, fill,
                                      context_cycle);
    };
    const auto sine = [](int64_t i) { return std::sin((float)i * 0.001f); };
    // Bar 1 = +0.25, bar 2 = -0.5: a one-sample read tells them apart.
    const auto two_bars = [&](int64_t i) { return i < Q ? 0.25f : -0.5f; };

    beginTest("Sequence::fromVar, the one reader of a song, counts what it "
              "leaves out: a strict reader refuses on any of it, a lenient "
              "one keeps the rest");
    {
      const auto samples = [](const juce::var& v) {
        return (int64_t)(double)v;
      };
      const auto read = [&](const juce::String& json,
                            Sequence::Dropped& dropped) {
        return Sequence::fromVar(juce::JSON::parse(json),
                                 Sequence::kSampleKeys, samples, dropped);
      };

      {
        Sequence::Dropped dropped;
        const auto seq = read(
            R"({"steps": [
                  {"name": "a", "len": 100, "cue": true, "fadeIn": 7,
                   "fadeOut": -3, "next": [{"to": 1, "w": 2}, {"to": 0}]},
                  {"name": "b", "len": 50}],
                "seed": 9, "gates": {"kid": [1, 0]}})",
            dropped);
        expect(!dropped.any() && dropped.what().isEmpty(),
               "a well-formed payload loses nothing");
        expect(seq != nullptr, "and is a song");
        if (seq != nullptr) {
          expectEquals(seq->numSteps(), 2);
          expectEquals(seq->steps[0].len, (int64_t)100);
          expectEquals(seq->steps[0].name, juce::String("a"));
          expect(seq->steps[0].cue && !seq->steps[1].cue, "the cue flag");
          expectEquals(seq->steps[0].fade_in, (int64_t)7);
          expectEquals(seq->steps[0].fade_out, (int64_t)0,
                       "a fade is never negative");
          expectEquals((int)seq->steps[0].next.size(), 2);
          expectEquals(seq->steps[0].next[0].weight, 2);
          expectEquals(seq->steps[0].next[1].weight, 1,
                       "an absent weight is 1");
          expectEquals((int)seq->seed, 9);
          expectEquals((int)seq->maskFor("kid"), 0b01, "gate bits as a mask");
          expect(seq->visit_count > 0, "finalized");
        }
      }

      struct Malformed {
        const char* what;
        const char* json;
        const char* reason;
        int kept_steps;
        int kept_successors;  // of step 0
      };
      const Malformed cases[] = {
          {"a step with no length",
           R"({"steps": [{"len": 100}, {"len": 0}, {"len": 50}]})",
           "non-positive step length", 2, 0},
          {"a successor naming a step the list does not hold",
           R"({"steps": [{"len": 100, "next": [{"to": 2}, {"to": 1}]},
                          {"len": 50}]})",
           "successor out of range", 2, 1},
          {"a successor with no weight",
           R"({"steps": [{"len": 100, "next": [{"to": 1, "w": 0}]},
                          {"len": 50}]})",
           "successor out of range", 2, 0},
          {"a successor before the list",
           R"({"steps": [{"len": 100, "next": [{"to": -1}, {"to": 0}]}]})",
           "successor out of range", 1, 1},
      };
      for (const Malformed& bad : cases) {
        Sequence::Dropped dropped;
        const auto seq = read(bad.json, dropped);
        const juce::String what(bad.what);
        expect(dropped.any(), what + ": reported (a strict reader refuses)");
        expectEquals(dropped.what(), juce::String(bad.reason), what);
        expect(seq != nullptr, what + ": the rest still loads");
        if (seq == nullptr) continue;
        expectEquals(seq->numSteps(), bad.kept_steps, what + ": steps kept");
        expectEquals((int)seq->steps[0].next.size(), bad.kept_successors,
                     what + ": successors kept");
      }

      {
        juce::Array<juce::var> steps;
        for (int i = 0; i < Sequence::kMaxSteps + 3; ++i) {
          auto* step = new juce::DynamicObject();
          step->setProperty("len", 10);
          steps.add(juce::var(step));
        }
        auto* payload = new juce::DynamicObject();
        payload->setProperty("steps", steps);
        Sequence::Dropped dropped;
        const auto seq = Sequence::fromVar(juce::var(payload),
                                           Sequence::kSampleKeys, samples,
                                           dropped);
        expectEquals(dropped.steps_past_limit, 3, "every step past the limit");
        expectEquals(dropped.what(),
                     "more than " + juce::String(Sequence::kMaxSteps) + " steps");
        expect(seq != nullptr && seq->numSteps() == Sequence::kMaxSteps,
               "the first kMaxSteps load");
      }

      {
        Sequence::Dropped dropped;
        expect(read(R"({"steps": [{"len": 0}]})", dropped) == nullptr,
               "no step left: no song");
        expect(dropped.any(), "and the reader knows why");
        Sequence::Dropped none;
        expect(Sequence::fromVar(juce::var(), Sequence::kSampleKeys, samples,
                                 none) == nullptr &&
                   read(R"({"steps": []})", none) == nullptr,
               "no payload, or no steps: no song");
        expect(!none.any(), "which is a clear, not a refusal");
      }
    }

    beginTest("a session's song loads in part: what its block spells wrong is "
              "left out, the rest plays, and the bypass flag is the block's");
    {
      const int64_t q = 1000;
      StackNode stack("Song");
      const juce::var record = juce::JSON::parse(
          R"({"type": "stack", "sequence": {"bypassed": true, "steps": [
                {"name": "a", "lenQ": {"num": 2, "den": 1},
                 "next": [{"to": 2}, {"to": 7}]},
                {"name": "nothing", "lenQ": {"num": 0, "den": 1}},
                {"name": "b", "lenQ": {"num": 1, "den": 2},
                 "fadeInQ": {"num": 1, "den": 4}}],
              "gates": {"kid": [1, 1, 0]}}})");
      session_io::applyNodeFacts(stack, record, q, 44100.0,
                                 session_io::SequenceScope::ROOT, nullptr,
                                 nullptr);
      const Sequence* seq = stack.sequencePtr();
      expect(seq != nullptr, "the song loaded");
      if (seq != nullptr) {
        expectEquals(seq->numSteps(), 2, "the step with no length is left out");
        expectEquals(seq->steps[0].len, 2 * q);
        expectEquals(seq->steps[1].len, q / 2);
        expectEquals(seq->steps[1].fade_in, q / 4);
        expectEquals(seq->steps[0].fade_in, (int64_t)0, "an absent fade is none");
        expectEquals((int)seq->steps[0].next.size(), 1,
                     "the successor naming no listed step is left out");
        expectEquals((int)seq->maskFor("kid"), 0b011);
      }
      expect(stack.isSequenceBypassed(), "bypassed, as the block says");

      const juce::var empty = juce::JSON::parse(
          R"({"type": "stack", "sequence": {"steps": [
                {"name": "nothing", "lenQ": {"num": 0, "den": 1}}]}})");
      session_io::applyNodeFacts(stack, empty, q, 44100.0,
                                 session_io::SequenceScope::ROOT, nullptr,
                                 nullptr);
      expect(stack.sequencePtr() == nullptr,
             "a block that keeps no step is no song");
      expect(!stack.isSequenceBypassed(), "and not bypassed");
    }

    beginTest(
        "a bad bundle -> not ok, from load and from readBundleInfo: no "
        "directory, no session.json, a session.json that is not JSON");
    {
      const juce::File missing = freshTempDir("neg_missing");
      missing.deleteRecursively();
      const juce::File empty = freshTempDir("neg_no_json");
      const juce::File corrupt = freshTempDir("neg_bad_json");
      corrupt.getChildFile("session.json").replaceWithText("{ not json !!");

      struct BadBundle {
        juce::File dir;
        const char* load_refused;
        const char* info_refused;
      };
      const BadBundle bad_bundles[] = {
          {missing, "missing directory refuses to load", "missing dir: !ok"},
          {empty, "empty directory is not a bundle", "empty dir: !ok"},
          {corrupt, "garbage json refuses to load", "corrupt json: !ok"},
      };
      for (const auto& bad : bad_bundles) {
        auto loaded = session_io::load(bad.dir, (double)Q);
        expect(!loaded.ok, bad.load_refused);
        expectEquals(loaded.children.size(), (size_t)0,
                     juce::String(bad.load_refused) + ": no children invented");
        expect(!session_io::readBundleInfo(bad.dir).ok, bad.info_refused);
      }

      // The control: a bundle that is there reads back what was saved.
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
        "load: session.json referencing a missing wav ->clip loads EMPTY, "
        "session still ok");
    {
      StackNode root("MissingWavRoot");
      root.setQuantum(Q, 0);
      auto clip = twoQClip("Ghost", sine, 2 * Q);
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

    beginTest(
        "load: a wav that exists but cannot be opened ->clip loads EMPTY, "
        "session still ok");
    {
#if JUCE_WINDOWS
      logMessage("SKIPPED: no portable way to make a file unreadable here");
#else
      StackNode root("LockedWavRoot");
      root.setQuantum(Q, 0);
      auto clip = twoQClip("Locked", [](int64_t) { return 0.0f; }, 2 * Q);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_locked_wav");
      expect(session_io::save(root, (double)Q, dir), "save");
      const auto wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      expect(chmod(wav.getFullPathName().toRawUTF8(), 0) == 0,
             "read permission removed");
      if (wav.createInputStream() != nullptr) {
        logMessage("SKIPPED: this user reads files whatever their mode");
      } else {
        auto loaded = session_io::load(dir, (double)Q);
        expect(loaded.ok, "session still loads ok");
        expectEquals(loaded.children.size(), (size_t)1, "clip still present");
        auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
        expect(c != nullptr, "child is the clip");
        expectEquals(c->getAudioBuffer().getNumSamples(), (int)Q,
                     "no audio was read: the constructor baseline stands");
      }
      chmod(wav.getFullPathName().toRawUTF8(), 0644);
#endif
    }

    beginTest(
        "load: a LATER take's wav is missing ->that take loads silent in "
        "its slot; the active take and the comp name the takes saved");
    {
      StackNode root("MissingTakeRoot");
      root.setQuantum(Q, 0);
      // Take k is a constant (k + 1) / 10: one sample names the take.
      const auto takeAudio = [&](int k) {
        juce::AudioBuffer<float> audio(1, (int)(2 * Q));
        for (int i = 0; i < audio.getNumSamples(); ++i)
          audio.setSample(0, i, 0.1f * (float)(k + 1));
        return audio;
      };
      auto clip = twoQClip("Takes", [](int64_t) { return 0.1f; }, 2 * Q);
      clip->appendLoadedTake(takeAudio(1));
      clip->appendLoadedTake(takeAudio(2));
      expect(clip->selectTake(2), "take 2 made the active one");
      const std::vector<int> comp = {0, 2};
      clip->setCompCells(comp, Q);
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_missing_take");
      expect(session_io::save(root, (double)Q, dir), "save");
      const auto audio_dir = dir.getChildFile("audio");
      expect(audio_dir.getChildFile(uuid + ".take2.wav").existsAsFile(),
             "three take files written");
      expect(audio_dir.getChildFile(uuid + ".take1.wav").deleteFile(),
             "take 1's wav deleted out from under the bundle");

      auto loaded = session_io::load(dir, (double)Q);
      expect(loaded.ok && loaded.children.size() == 1, "session still loads");
      auto* c = dynamic_cast<ClipNode*>(loaded.children[0].get());
      expect(c != nullptr, "child is the clip");
      expectEquals(c->takeCount(), 3, "the list keeps its three slots");
      expectEquals(c->activeTake(), 2, "the active take is the one saved");
      const auto firstSample = [&](int k) {
        const auto* buffer = c->takeBuffer(k);
        return buffer != nullptr && buffer->getNumSamples() > 0
                   ? buffer->getSample(0, 0)
                   : -1.0f;
      };
      expectWithinAbsoluteError(firstSample(0), 0.1f, 1e-6f, "take 0's audio");
      expectWithinAbsoluteError(firstSample(1), 0.0f, 1e-6f,
                                "the take with no file is silent");
      expectWithinAbsoluteError(firstSample(2), 0.3f, 1e-6f,
                                "take 2's audio is still take 2");
      expect(c->compCells() == comp, "the comp names the same takes");
    }

    beginTest(
        "a take wav that cannot be written fails the save and stays dirty; "
        "a save to another folder leaves the mirror's flag alone");
    {
      StackNode root("FailedWavRoot");
      root.setQuantum(Q, 0);
      auto clip = twoQClip("Take", two_bars, 2 * Q);
      ClipNode* live = clip.get();
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_failed_wav");
      const auto audio_dir = dir.getChildFile("audio");
      const auto wav = audio_dir.getChildFile(uuid + ".wav");
      session_io::SaveOptions mirror;
      mirror.incremental = true;
      expect(session_io::save(root, (double)Q, dir, mirror), "first mirror");
      expect(wav.existsAsFile(), "the full take is on disk");

      // Collapse to bar 2: the mirrored wav is stale until rewritten.
      live->collapseContent(Q, Q);
      expect(live->takeFilesDirty(), "the collapse marks the mirror dirty");

      // A save somewhere else writes its own files, not the mirror's.
      auto elsewhere = freshTempDir("neg_failed_wav_elsewhere");
      expect(session_io::save(root, (double)Q, elsewhere), "save elsewhere");
      expect(live->takeFilesDirty(),
             "the mirror's wav is still stale: the flag stays");

      // The audio folder becomes a plain file: no wav can land in it.
      expect(audio_dir.deleteRecursively(), "audio folder removed");
      expect(audio_dir.create().wasOk(), "a file stands where it was");
      expect(!session_io::save(root, (double)Q, dir, mirror),
             "the save reports the wav it could not write");
      expect(live->takeFilesDirty(), "the unwritten take stays dirty");

      // The folder is writable again: the next mirror writes bar 2.
      expect(audio_dir.deleteFile(), "the obstacle is gone");
      expect(session_io::save(root, (double)Q, dir, mirror), "mirror again");
      expect(!live->takeFilesDirty(), "written: the flag clears");
      auto reloaded = session_io::load(dir, (double)Q);
      auto* c = reloaded.ok && reloaded.children.size() == 1
                    ? dynamic_cast<ClipNode*>(reloaded.children[0].get())
                    : nullptr;
      expect(c != nullptr, "the bundle reloads");
      if (c != nullptr) {
        expectEquals(c->getAudioBuffer().getNumSamples(), (int)Q,
                     "the wav holds the collapsed take");
        expectWithinAbsoluteError(c->getAudioBuffer().getSample(0, 0), -0.5f,
                                  1e-6f, "and it is bar 2");
      }
    }

    beginTest(
        "incremental save skips unchanged wavs and rewrites on "
        "duration change");
    {
      StackNode root("IncrementalRoot");
      root.setQuantum(Q, 0);
      auto clip = twoQClip("Take", sine, 0);
      ClipNode* live = clip.get();
      const juce::String uuid = clip->getUuid();
      root.addChild(std::move(clip));

      auto dir = freshTempDir("neg_incremental");
      session_io::SaveOptions opts;
      opts.incremental = true;
      expect(session_io::save(root, (double)Q, dir, opts), "first save");
      auto wav = dir.getChildFile("audio").getChildFile(uuid + ".wav");
      expect(wav.existsAsFile(), "wav written on the first save");
      // Committed audio is immutable: an unchanged take skips the
      // rewrite. A rewrite lands a new file stamped now, so the file is
      // aged an hour and must still read that age after the save.
      expect(wav.setLastModificationTime(juce::Time::getCurrentTime() -
                                         juce::RelativeTime::hours(1)),
             "the wav is aged an hour");
      const auto first_mtime = wav.getLastModificationTime();
      expect(first_mtime <
                 juce::Time::getCurrentTime() - juce::RelativeTime::minutes(30),
             "and reads as old");
      const auto first_size = wav.getSize();

      expect(session_io::save(root, (double)Q, dir, opts), "second save");
      expect(wav.getLastModificationTime() == first_mtime,
             "unchanged wav NOT rewritten (mtime stable)");
      expectEquals(wav.getSize(), first_size, "unchanged wav same length");

      // A lock-collapse changes the committed window; the clip's dirty
      // flag (ClipNode::takeFilesDirty, set by every content-frame
      // mutator) is the ONE rewrite trigger — never an on-disk probe.
      // The real mutator, not a raw duration store: a raw store is not
      // a content-frame mutation and must NOT rewrite.
      live->duration_samples.store(Q);
      live->duration_samples.store(2 * Q);
      expect(!live->takeFilesDirty(), "a raw field store is not dirty");
      live->collapseContent(0, Q);
      expect(live->takeFilesDirty(), "the collapse marks the mirror dirty");
      expect(session_io::save(root, (double)Q, dir, opts), "third save");
      expect(!live->takeFilesDirty(), "the mirror cleared the flag");
      expect(wav.getLastModificationTime() != first_mtime ||
                 wav.getSize() != first_size,
             "duration change rewrites the wav");
      expect(wav.getSize() < first_size, "rewritten wav holds the halved take");
    }

    beginTest(
        "AudioEngine::loadSession refuses mid-take and clears history "
        "after load");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      auto process = [&engine](int total) {
        test_utils::driveEngine(engine, total);
      };
      const int64_t take = 44100;  // engine default rate: 1 s first take
      test_utils::recordClip(engine, process, take);

      auto dir = freshTempDir("neg_midtake");
      expect(engine.saveSession(dir.getFullPathName()), "session saved");

      // Arm a SECOND take and drive it into capture: in flight, not
      // committed.
      const juce::String first_id = test_utils::lastTopLevelId(engine);
      engine.createNode("clip");
      const juce::String second_id = test_utils::lastTopLevelId(engine);
      expect(second_id.isNotEmpty() && second_id != first_id,
             "second clip created");
      engine.startRecordingInNode(second_id);
      process(100);
      process((int)take / 2);
      expect(engine.hasActiveTake(), "take is in flight");

      // (The graph-state var must outlive nodesOf's pointer.)
      const auto topLevelCount = [&engine] {
        const juce::var state = engine.getGraphState();
        return nodesOf(state)->size();
      };
      const int node_count_before = topLevelCount();
      expect(!engine.loadSession(dir.getFullPathName()),
             "mid-take load refused");
      expectEquals(topLevelCount(), node_count_before,
                   "graph untouched by the refusal");

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
      expectEquals(topLevelCount(), 1,
                   "the saved single-clip session is on stage");
    }
  }
};

static SessionNegativeTests sessionNegativeTests;

}  // namespace celestrian
