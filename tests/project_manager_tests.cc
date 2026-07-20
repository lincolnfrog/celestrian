/**
 * The project model (docs/projects.md): dated-folder birth at the first
 * committed take, serial naming, rename-without-move, the mirror, and
 * templates as performance-stripped projects.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <set>

#include "../src/audio_engine.h"
#include "../src/project_manager.h"
#include "../src/session_io.h"

namespace celestrian {

namespace {
juce::Array<juce::var>* nodesOf(const juce::var& s) {
  return s.getProperty("nodes", juce::var()).getArray();
}
bool clipCommitted(AudioEngine& e, const juce::String& uuid) {
  const juce::var s = e.getGraphState();
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid)
        return !(bool)x.getProperty("isRecording", false) &&
               (double)x.getProperty("duration", 0) > 0;
  return false;
}
juce::String recordClip(AudioEngine& e, std::function<void(int)> process,
                        int lengthSamples) {
  std::set<juce::String> before;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) before.insert(x.getProperty("id", "").toString());
  }
  e.createNode("clip");
  juce::String id;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) {
        auto i = x.getProperty("id", "").toString();
        if (!before.count(i)) id = i;
      }
  }
  e.startRecordingInNode(id);
  process(100);
  process(lengthSamples);
  e.stopRecordingInNode(id);
  for (int i = 0; i < 400 && !clipCommitted(e, id); ++i) process(512);
  return id;
}
}  // namespace

class ProjectManagerTests : public juce::UnitTest {
 public:
  ProjectManagerTests() : juce::UnitTest("Project model (docs/projects.md)") {}

  void runTest() override {
    const int Q = 44100;
    const int BLOCK = 512;
    std::vector<float> buf(BLOCK, 0.1f);
    auto makeProcess = [&](AudioEngine& e) {
      return [&e, &buf, BLOCK](int total) {
        float* ins[] = {buf.data()};
        float* outs[] = {buf.data(), buf.data()};
        int remaining = total;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK);
          e.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
    };
    auto tempBase = juce::File::getSpecialLocation(juce::File::tempDirectory)
                        .getChildFile("celestrian_pm_tests_" +
                                      juce::String(juce::Random::getSystemRandom()
                                                       .nextInt(1 << 30)));
    tempBase.createDirectory();
    const auto date = juce::Time::getCurrentTime().formatted("%Y%m%d");

    beginTest("birth at first committed take; dated serial id; mirror on disk");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);

      pm.tick();
      expect(!pm.born(), "no takes yet: unborn (nothing on disk)");

      auto process = makeProcess(engine);
      recordClip(engine, process, Q);
      pm.tick();
      expect(pm.born(), "first committed take births the project");
      expectEquals(pm.id(), date + "-01", "dated serial, starting -01");
      expect(pm.folder().getChildFile("session.json").existsAsFile(),
             "session.json mirrored");
      expect(pm.folder().getChildFile("audio").getNumberOfChildFiles(
                 juce::File::findFiles, "*.wav") == 1,
             "the take's wav is on disk");
      expectEquals(pm.displayName(), pm.id(), "display name defaults to id");
    }

    beginTest("second project the same day takes -02");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);
      auto process = makeProcess(engine);
      recordClip(engine, process, Q);
      pm.tick();
      expectEquals(pm.id(), date + "-02", "next free serial");
    }

    beginTest("rename edits the name, never the folder; reload recovers it");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);
      auto process = makeProcess(engine);
      recordClip(engine, process, Q);
      pm.tick();
      const auto folder = pm.folder();
      pm.rename("sick jam");
      expectEquals(pm.displayName(), juce::String("sick jam"));
      expect(pm.folder() == folder, "folder untouched by rename");

      AudioEngine engine2;
      ProjectManager pm2(engine2);
      pm2.setRootForTest(tempBase);
      expect(pm2.openProject(folder), "opens by folder");
      expectEquals(pm2.displayName(), juce::String("sick jam"),
                   "name recovered from session.json, not the folder");
    }

    beginTest("template = project with no performances (pre-Q by construction)");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);
      auto process = makeProcess(engine);
      recordClip(engine, process, Q);
      engine.renameNode(
          engine.getGraphState().getProperty("nodes", juce::var())
              .getArray()->getFirst().getProperty("id", "").toString(),
          "Kick");
      pm.tick();
      expect(pm.saveAsTemplate("My Rig"), "template saved");

      const auto tdir = pm.templatesRoot().getChildFile("My Rig");
      auto loaded = session_io::load(tdir, 44100.0);
      expect(loaded.ok, "template loads as a bundle");
      expectEquals(loaded.q_samples, (int64_t)0, "pre-Q by construction");
      expectEquals((int)loaded.children.size(), 1, "structure kept");
      expectEquals(loaded.children[0]->getName(), juce::String("Kick"),
                   "names kept");
      expectEquals(loaded.children[0]->getIntrinsicDuration(), (int64_t)0,
                   "performances stripped");
      expect(!tdir.getChildFile("audio")
                  .getNumberOfChildFiles(juce::File::findFiles, "*.wav"),
             "no audio in a template");

      // Fresh session from the template: unborn until its own seed take.
      AudioEngine engine2;
      ProjectManager pm2(engine2);
      pm2.setRootForTest(tempBase);
      expect(pm2.newFromTemplate("My Rig"), "loads");
      expect(!pm2.born(), "unborn — the seed take will date it");
      expectEquals(engine2.islandCommittedClipCount(), 0, "no takes");
    }

    beginTest("launch ritual: the last template auto-loads (Ableton default)");
    {
      // saveAsTemplate above remembered "My Rig" in state.json — a
      // fresh app boot with an empty session loads it automatically.
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);
      expectEquals(pm.lastTemplateName(), juce::String("My Rig"),
                   "the newest rig is the default");
      expect(pm.autoLoadLastTemplate(), "boots instrument-ready");
      expect(!pm.born(), "still unborn — the seed take dates the project");
      const juce::var s = engine.getGraphState();
      auto* n = nodesOf(s);
      expect(n && n->size() == 1 &&
                 (*n)[0].getProperty("name", "").toString() == "Kick",
             "the rig's named tracks are on stage");
    }

    beginTest("recents list, newest first, by display name");
    {
      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);
      auto recents = pm.listRecents(10);
      expect((int)recents.size() >= 4, "the projects made above are listed");
      expect(recents[0].id > recents[1].id, "newest (highest serial) first");
      bool foundNamed = false;
      for (auto& r : recents) foundNamed |= (r.name == "sick jam");
      expect(foundNamed, "display names surface in the listing");
    }

    tempBase.deleteRecursively();
  }
};

static ProjectManagerTests projectManagerTests;

}  // namespace celestrian
