/**
 * Project lifecycle tests (src/project_manager.h — docs/projects.md).
 *
 * Pins the contracts the header documents beyond the model itself
 * (project_manager_tests.cc: birth, rename, templates, recents): the
 * flush before a session is replaced, legal template folder names,
 * saveNow's births-the-project branch, the empty boot,
 * duplicateProject's fork-forward, rename's empty-name fallback, and
 * template listing.
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "../src/project_manager.h"
#include "../src/session_io.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::recordSilentTake;
using test_utils::freshTempDir;
using test_utils::nodesOf;

class ProjectLifecycleTests : public juce::UnitTest {
 public:
  ProjectLifecycleTests() : juce::UnitTest("Project Lifecycle") {}

  void runTest() override {
    const int Q = 44100;  // engine default rate: 1 s seed take

    // A bundle that is nobody's project yet: something to open.
    const auto otherBundle = [&](const juce::String& label) {
      StackNode root("Other");
      auto dir = freshTempDir(label);
      expect(session_io::save(root, 44100.0, dir), "the other bundle saved");
      return dir;
    };
    // The project folders under a manager's Projects root.
    const auto projectFolders = [](const ProjectManager& pm) {
      return pm.projectsRoot().findChildFiles(juce::File::findDirectories,
                                              false);
    };

    beginTest("opening another project first puts the current one on disk "
              "(no tick in between)");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_flush_open"));
      recordSilentTake(engine, Q);
      expect(!pm.born(), "no tick has run: the take is in memory only");

      const juce::File other = otherBundle("pl_flush_open_other");
      expect(pm.openProject(other), "the other project opens");
      expect(pm.folder() == other, "and is the current one");

      const auto folders = projectFolders(pm);
      expectEquals(folders.size(), 1, "the take's project was born on the way");
      if (folders.size() == 1) {
        expect(folders[0].getChildFile("session.json").existsAsFile(),
               "its session.json is on disk");
        expectEquals(folders[0].getChildFile("audio").getNumberOfChildFiles(
                         juce::File::findFiles, "*.wav"),
                     1, "and so is the take's wav");
      }
    }

    beginTest("a new-from-template and a second open put the current "
              "project's last edits on disk");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_flush_edits"));
      const juce::String clip_id = recordSilentTake(engine, Q);
      pm.tick();
      expect(pm.born(), "project born");
      const juce::File first = pm.folder();
      expect(pm.saveAsTemplate("Rig"), "a template to start from");

      const auto savedNames = [](const juce::File& folder) {
        juce::StringArray names;
        auto loaded = session_io::load(folder, 44100.0);
        for (const auto& child : loaded.children) names.add(child->getName());
        return names;
      };

      // An edit after the last tick, then a new project from the template.
      engine.renameNode(clip_id, "Late edit");
      expect(pm.newFromTemplate("Rig"), "new from the template");
      expect(!pm.born(), "the new session is unborn");
      expect(savedNames(first) == juce::StringArray({"Late edit"}),
             "the edit reached the first project before it was replaced");

      // The unborn session takes a take; opening the first project again
      // must not lose it.
      recordSilentTake(engine, Q);
      expect(pm.openProject(first), "the first project reopens");
      expectEquals(projectFolders(pm).size(), 2,
                   "the template session's take was born as its own project");
    }

    beginTest("a template's folder is a legal name; the display name is "
              "the one typed");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      ProjectManager pm(engine);
      pm.setRootForTest(freshTempDir("pl_template_names"));
      engine.createNode("clip");

      expect(pm.saveAsTemplate("Rock/Metal rig"), "a name with a separator");
      const auto templates = pm.listTemplates();
      expectEquals((int)templates.size(), 1, "the template is listed");
      if (templates.size() == 1) {
        expectEquals(templates[0].name, juce::String("Rock/Metal rig"),
                     "under the name the user typed");
        expect(pm.templatesRoot().getChildFile(templates[0].id).isDirectory(),
               "its folder sits directly in the templates root");
        // The listing's id is what the picker hands back.
        expect(pm.newFromTemplate(templates[0].id), "and it loads by its id");
      }

      // A name that is only a path step names no folder of its own.
      expect(!pm.saveAsTemplate(".."), "'..' is refused");
      expect(!pm.saveAsTemplate("."), "'.' is refused");
      expect(!pm.saveAsTemplate("/"), "a bare separator is refused");
      expect(!pm.templatesRoot()
                  .getParentDirectory()
                  .getChildFile("session.json")
                  .existsAsFile(),
             "nothing was written into the base folder");
      expectEquals((int)pm.listTemplates().size(), 1,
                   "the refused names made no template");
    }

    beginTest("saveNow() births an unborn project");
    {
      // An explicit save before the first take is intent enough to
      // birth: even a fresh empty session gets a folder.
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
      // A fresh ProjectManager does nothing at boot (Q17): no seeded
      // track, no auto-persisted Default template. The creation menu
      // (+ = template picker) and R-on-empty own the first gesture.
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
      recordSilentTake(engine, Q);
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
      recordSilentTake(engine, Q);
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
