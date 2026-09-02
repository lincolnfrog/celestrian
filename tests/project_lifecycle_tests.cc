/**
 * Project lifecycle tests (src/project_manager.h — docs/projects.md).
 *
 * Pins the contracts the header documents: tick's mid-take guard,
 * saveNow's ⌘S-births-the-project branch, the boot-empty rule's
 * never-boot-empty ritual, duplicateProject's fork-forward, rename's
 * empty-name fallback, and template listing.
 */

#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "../src/project_manager.h"
#include "../src/session_io.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::freshTempDir;
using test_utils::isClipCommitted;
using test_utils::nodesOf;
using test_utils::recordClip;

class ProjectLifecycleTests : public juce::UnitTest {
 public:
  ProjectLifecycleTests() : juce::UnitTest("Project Lifecycle") {}

  void runTest() override {
    const int Q = 44100;  // engine default rate: 1 s seed take

    beginTest("tick() skips while a take is in flight (crash-safety guard)");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_tick_guard"));
      auto process = [&engine](int total) {
        test_utils::driveEngine(engine, total);
      };

      engine.createNode("clip");
      const juce::String clip_id = test_utils::firstNodeId(engine);
      engine.startRecordingInNode(clip_id);
      process(100);
      process(Q / 2);
      expect(engine.hasActiveTake(), "take is in flight");

      // Transient capture state is never saved: every tick mid-take is
      // a no-op, even though content is being captured.
      pm.tick();
      pm.tick();
      pm.tick();
      expect(!pm.born(), "mid-take ticks never birth the project");

      engine.stopRecordingInNode(clip_id);
      for (int i = 0; i < 400 && !isClipCommitted(engine, clip_id); ++i)
        process(512);
      expect(isClipCommitted(engine, clip_id), "take committed");
      pm.tick();
      expect(pm.born(), "first post-commit tick births the project");
      expect(pm.folder().getChildFile("session.json").existsAsFile(),
             "mirror on disk");
    }

    beginTest("saveNow() births an unborn project");
    {
      // Header contract: an explicit ⌘S before the first take is intent
      // enough to birth — even a fresh empty session gets a folder.
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_save_now"));
      expect(!pm.born(), "fresh session is unborn");
      expect(pm.saveNow(), "saveNow succeeds");
      expect(pm.born(), "explicit save births the project");
      expect(pm.folder().exists(), "folder created");
      expect(pm.folder().getChildFile("session.json").existsAsFile(),
             "session.json written");
      expectEquals(pm.displayName(), pm.id(),
                   "display name defaults to the serial id");
    }

    beginTest("boot is EMPTY (Q17): no seeded track, no Default template");
    {
      // The launch ritual is RETIRED (Q17, 2026-08-13): no seeded
      // "Track 1", no auto-persisted Default template — the creation
      // menu (+ = template picker) and R-on-empty own the first
      // gesture now. A fresh ProjectManager does nothing at boot.
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_launch"));

      const juce::var state = engine.getGraphState();
      auto* nodes = nodesOf(state);
      expect(nodes == nullptr || nodes->size() == 0,
             "nothing on stage at boot");
      expect(!pm.templatesRoot()
                  .getChildFile("Default")
                  .getChildFile("session.json")
                  .existsAsFile(),
             "no auto-created Default template");
      expect(!pm.born(), "unborn - the seed take dates the project");
    }

    beginTest("duplicateProject() forks forward");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_duplicate"));
      auto process = [&engine](int total) {
        test_utils::driveEngine(engine, total);
      };
      recordClip(engine, process, Q);
      pm.tick();
      expect(pm.born(), "project born");
      const juce::File original = pm.folder();
      const juce::String original_id = pm.id();
      const auto date = juce::Time::getCurrentTime().formatted("%Y%m%d");
      expectEquals(original_id, date + "-01", "first serial of the day");

      const juce::File fork = pm.duplicateProject();
      expect(fork != juce::File(), "duplicate returns the new folder");
      expect(fork.getChildFile("session.json").existsAsFile(),
             "fork holds its own mirror");
      expectEquals(fork.getFileName(), date + "-02",
                   "next free serial per nextSerialFolder");
      expect(pm.folder() == fork, "fork FORWARD: work continues in the copy");
      expectEquals(pm.id(), date + "-02", "id follows the fork");
      expect(original.getChildFile("session.json").existsAsFile(),
             "the original stays behind as the checkpoint");
      // Pinned behavior: the display NAME travels with the fork
      // unchanged (only the folder id forks).
      expectEquals(pm.displayName(), original_id,
                   "display name unchanged by the fork");
    }

    beginTest("rename: empty/whitespace name falls back to id()");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_rename"));
      auto process = [&engine](int total) {
        test_utils::driveEngine(engine, total);
      };
      recordClip(engine, process, Q);
      pm.tick();
      expect(pm.born(), "project born");

      pm.rename("sick jam");
      expectEquals(pm.displayName(), juce::String("sick jam"), "renamed");
      pm.rename("   ");
      expectEquals(pm.displayName(), pm.id(),
                   "whitespace name falls back to the serial id");
      // The fallback is mirrored too: a reload recovers the id-name.
      const auto info = session_io::readBundleInfo(pm.folder());
      expect(info.ok, "mirror readable");
      expectEquals(info.name, pm.id(), "fallback name persisted");
    }

    beginTest("listTemplates lists saved templates");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_templates"));
      engine.createNode("clip");
      expect(pm.saveAsTemplate("Rig A"), "first template saved");
      expect(pm.saveAsTemplate("Rig B"), "second template saved");

      const auto templates = pm.listTemplates();
      expectEquals((int)templates.size(), 2, "both templates listed");
      bool found_a = false;
      bool found_b = false;
      for (const auto& info : templates) {
        found_a |= info.name == "Rig A";
        found_b |= info.name == "Rig B";
      }
      expect(found_a && found_b, "both names surface in the listing");
    }
  }
};

static ProjectLifecycleTests projectLifecycleTests;

}  // namespace celestrian
