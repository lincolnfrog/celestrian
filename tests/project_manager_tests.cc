/**
 * The project model (docs/projects.md): dated-folder birth at the first
 * committed take (never mid-take), serial naming, rename-without-move,
 * the mirror, templates as performance-stripped projects that load on
 * request only, and the recents listing. Every case builds its own
 * folder.
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "../src/project_manager.h"
#include "../src/session_io.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::driveEngine;
using test_utils::freshTempDir;
using test_utils::isClipCommitted;
using test_utils::nodesOf;
using test_utils::recordSilentTake;

namespace {

/** One running app: an engine (on the heap: it is ~130 KB) and its
 * project manager, rooted at `base`. */
struct App {
  explicit App(const juce::File& base) { pm.setRootForTest(base); }

  const std::unique_ptr<AudioEngine> engine_owner =
      std::make_unique<AudioEngine>();
  AudioEngine& engine = *engine_owner;
  ProjectManager pm{engine};
};

/** The names of the top-level nodes on stage. */
juce::StringArray topLevelNames(AudioEngine& engine) {
  juce::StringArray names;
  const juce::var state = engine.getGraphState();
  if (auto* nodes = nodesOf(state))
    for (const auto& node : *nodes)
      names.add(node.getProperty("name", "").toString());
  return names;
}

}  // namespace

class ProjectManagerTests : public juce::UnitTest {
 public:
  ProjectManagerTests() : juce::UnitTest("Project model (docs/projects.md)") {}

  void runTest() override {
    const int Q = 44100;  // engine default rate: a 1 s seed take
    const auto date = juce::Time::getCurrentTime().formatted("%Y%m%d");

    beginTest("birth at the first committed take, never mid-take; dated "
              "serial id; mirror on disk");
    {
      App app(freshTempDir("pm_birth"));
      app.pm.tick();
      expect(!app.pm.born(), "no takes yet: unborn (nothing on disk)");

      app.engine.createNode("clip");
      const juce::String clip_id = test_utils::firstNodeId(app.engine);
      app.engine.startRecordingInNode(clip_id);
      driveEngine(app.engine, 100);
      driveEngine(app.engine, Q / 2);
      expect(app.engine.hasActiveTake(), "take is in flight");

      // Transient capture state is never saved: every tick mid-take is
      // a no-op, even though content is being captured.
      app.pm.tick();
      app.pm.tick();
      app.pm.tick();
      expect(!app.pm.born(), "mid-take ticks never birth the project");

      app.engine.stopRecordingInNode(clip_id);
      for (int i = 0; i < 400 && !isClipCommitted(app.engine, clip_id); ++i)
        driveEngine(app.engine, 512);
      expect(isClipCommitted(app.engine, clip_id), "take committed");
      app.pm.tick();
      expect(app.pm.born(), "first committed take births the project");
      expectEquals(app.pm.id(), date + "-01", "dated serial, starting -01");
      expect(app.pm.folder().getChildFile("session.json").existsAsFile(),
             "session.json mirrored");
      expect(app.pm.folder().getChildFile("audio").getNumberOfChildFiles(
                 juce::File::findFiles, "*.wav") == 1,
             "the take's wav is on disk");
      expectEquals(app.pm.displayName(), app.pm.id(),
                   "display name defaults to id");
    }

    beginTest("rename edits the name, never the folder; reload recovers it");
    {
      const auto base = freshTempDir("pm_rename");
      App app(base);
      recordSilentTake(app.engine, Q);
      app.pm.tick();
      const auto folder = app.pm.folder();
      app.pm.rename("sick jam");
      expectEquals(app.pm.displayName(), juce::String("sick jam"));
      expect(app.pm.folder() == folder, "folder untouched by rename");

      App reopened(base);
      expect(reopened.pm.openProject(folder), "opens by folder");
      expectEquals(reopened.pm.displayName(), juce::String("sick jam"),
                   "name recovered from session.json, not the folder");
    }

    beginTest("template = project with no performances (pre-Q by "
              "construction); it loads on explicit request only");
    {
      const auto base = freshTempDir("pm_template");
      App app(base);
      app.engine.renameNode(recordSilentTake(app.engine, Q), "Kick");
      app.pm.tick();
      expect(app.pm.saveAsTemplate("My Rig"), "template saved");

      const auto tdir = app.pm.templatesRoot().getChildFile("My Rig");
      auto loaded = session_io::load(tdir, 44100.0);
      expect(loaded.ok, "template loads as a bundle");
      expectEquals(loaded.q_samples, (int64_t)0, "pre-Q by construction");
      expectEquals((int)loaded.children.size(), 1, "structure kept");
      expectEquals(loaded.children[0]->getName(), juce::String("Kick"),
                   "names kept");
      expectEquals(loaded.children[0]->getIntrinsicDuration(), (int64_t)0,
                   "performances stripped");
      expect(!tdir.getChildFile("audio").getNumberOfChildFiles(
                 juce::File::findFiles, "*.wav"),
             "no audio in a template");

      // A fresh boot has nothing on stage, whatever templates exist
      // (Q17). Asked, the template arrives: unborn until its own seed
      // take.
      App fresh(base);
      expect(topLevelNames(fresh.engine).isEmpty(), "boot stage is empty");
      expect(fresh.pm.newFromTemplate("My Rig"), "loads on request");
      expect(!fresh.pm.born(), "unborn - the seed take will date it");
      expectEquals(fresh.engine.islandCommittedClipCount(), 0, "no takes");
      expect(topLevelNames(fresh.engine) == juce::StringArray({"Kick"}),
             "the rig's named tracks arrive on request");
    }

    beginTest("recents list, newest first, by display name");
    {
      // Two projects born in one folder, the older one renamed.
      const auto base = freshTempDir("pm_recents");
      App older(base);
      expect(older.pm.saveNow(), "the first project is born");
      older.pm.rename("sick jam");
      App newer(base);
      expect(newer.pm.saveNow(), "the second project is born");
      expectEquals(newer.pm.id(), date + "-02",
                   "a second project the same day takes the next serial");

      const auto recents = newer.pm.listRecents(10);
      expectEquals((int)recents.size(), 2, "both projects are listed");
      expect(recents.size() == 2 && recents[0].id > recents[1].id,
             "newest (highest serial) first");
      bool found_named = false;
      for (const auto& recent : recents)
        found_named |= recent.name == "sick jam";
      expect(found_named, "display names surface in the listing");
    }

    beginTest("closing a project puts its session on disk and leaves the "
              "manager unborn; what is saved next is a project of its own");
    {
      const auto base = freshTempDir("pm_close");
      App app(base);
      const juce::String clip = recordSilentTake(app.engine, Q);
      app.pm.tick();
      const auto folder = app.pm.folder();
      app.pm.rename("sick jam");
      // An edit the heartbeat has not mirrored yet.
      app.engine.renameNode(clip, "Kick");

      app.pm.closeProject();
      expect(!app.pm.born(), "unborn");
      expectEquals(app.pm.id(), juce::String(), "no id");
      expectEquals(app.pm.displayName(), juce::String(), "no name");
      expect(topLevelNames(app.engine) == juce::StringArray({"Kick"}),
             "the session on stage is untouched");

      // The folder holds the session as it stood at the close...
      App reopened(base);
      expect(reopened.pm.openProject(folder), "the closed project opens");
      expectEquals(reopened.pm.displayName(), juce::String("sick jam"),
                   "under its name");
      expect(topLevelNames(reopened.engine) == juce::StringArray({"Kick"}),
             "with the edit made just before the close");

      // ...and nothing written afterwards reaches it: the session still
      // on stage is born again, as a project of its own.
      app.engine.renameNode(clip, "Snare");
      app.pm.tick();
      expect(app.pm.born() && app.pm.folder() != folder,
             "the next mirror births another project");
      expectEquals(app.pm.id(), date + "-02", "under the next serial");
      App again(base);
      expect(again.pm.openProject(folder), "the closed project opens again");
      expect(topLevelNames(again.engine) == juce::StringArray({"Kick"}),
             "as it was closed");

      // An unborn session with nothing recorded closes to nothing.
      App empty(freshTempDir("pm_close_empty"));
      empty.pm.closeProject();
      expect(!empty.pm.born(), "still unborn");
      expectEquals((int)empty.pm.listRecents(10).size(), 0,
                   "and nothing was written");
    }
  }
};

static ProjectManagerTests projectManagerTests;

}  // namespace celestrian
