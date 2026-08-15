/**
 * Track templates (design_language.md Q17 — the Q7 companion).
 *
 * Pins:
 *  - capture = structure + names + inputs, NOTHING else (a template is
 *    pre-Q by construction, like its whole-session cousin);
 *  - build stamps fresh EMPTY armable copies (new uuids, no audio);
 *  - insertTrackTemplate is ONE undoable edit — a 5-track group
 *    arrives and departs the undo log whole;
 *  - the ProjectManager library round-trips through disk (save → list
 *    → create), overwrites by name, and survives junk files.
 *
 * Twin: ui/js/tests/track_templates.test.mjs (mock store parity).
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "../src/project_manager.h"
#include "../src/track_template.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::nodesOf;

namespace {

/** Top-level node count of the engine's published graph. (Hold the
 * state var alive across the array access — getArray() points INTO the
 * var; a temporary would dangle.) */
int topCount(const AudioEngine& engine) {
  const juce::var state = engine.getGraphState();
  auto* n = nodesOf(state);
  return n ? n->size() : 0;
}

/** The i-th top-level node var (void when out of range). */
juce::var topNode(const AudioEngine& engine, int i) {
  const juce::var state = engine.getGraphState();
  auto* n = nodesOf(state);
  return (n != nullptr && i < n->size()) ? (*n)[i] : juce::var();
}

}  // namespace

class TrackTemplateTests : public juce::UnitTest {
 public:
  TrackTemplateTests()
      : juce::UnitTest("Track Templates (Q17)", "Audio Engine") {}

  void runTest() override {
    beginTest("capture: structure + names + inputs, nothing else");
    {
      StackNode drums("Drums");
      auto kick = std::make_unique<ClipNode>("Kick", 44100.0);
      kick->setInputChannel(0);
      auto over = std::make_unique<ClipNode>("Overheads", 44100.0);
      over->setInputChannel(2);
      over->setInputChannelRight(3);  // stereo pair survives capture
      drums.addChild(std::move(kick));
      drums.addChild(std::move(over));

      const juce::var v = track_templates::capture(drums);
      expectEquals(v.getProperty("type", "").toString(),
                   juce::String("stack"), "group captures as stack");
      expectEquals(v.getProperty("name", "").toString(),
                   juce::String("Drums"), "name kept");
      auto* kids = v.getProperty("children", juce::var()).getArray();
      expect(kids != nullptr && kids->size() == 2, "both children captured");
      const auto k0 = (*kids)[0];
      const auto k1 = (*kids)[1];
      expectEquals(k0.getProperty("name", "").toString(),
                   juce::String("Kick"), "child name kept");
      expectEquals((int)k1.getProperty("inputChannel", -9), 2,
                   "input assignment kept");
      expectEquals((int)k1.getProperty("inputChannelR", -9), 3,
                   "stereo pair kept");
      expect(!k0.hasProperty("duration") && !k0.hasProperty("origin"),
             "no performance facts in a template");
      expectEquals(track_templates::countClips(v), 2, "leaf count metadata");
    }

    beginTest("build: fresh, empty, armable copies - new uuids");
    {
      StackNode src("Pair");
      auto c = std::make_unique<ClipNode>("Gtr", 44100.0);
      c->setInputChannel(3);
      const juce::String src_uuid = c->getUuid();
      src.addChild(std::move(c));

      const juce::var v = track_templates::capture(src);
      auto built = track_templates::build(v, 48000.0);
      auto* stack = dynamic_cast<StackNode*>(built.get());
      expect(stack != nullptr, "stack rebuilt");
      expectEquals(stack->getNumChildren(), 1, "child rebuilt");
      auto* clip = dynamic_cast<ClipNode*>(stack->getChild(0));
      expect(clip != nullptr, "clip rebuilt");
      expectEquals(clip->getName(), juce::String("Gtr"), "name stamped");
      expectEquals(clip->getInputChannel(), 3, "input stamped");
      expect(clip->getUuid() != src_uuid,
             "a template stamps COPIES - never aliases");
      expectEquals(clip->getIntrinsicDuration(), (int64_t)0,
                   "empty => armable (Q7: arm targets emptiness)");
    }

    beginTest("insertTrackTemplate: ONE undoable edit for a whole group");
    {
      AudioEngine engine;
      engine.createNode("clip");  // pre-existing track
      expectEquals(topCount(engine), 1, "one track before");

      // A 3-mic group template, inserted at top level.
      auto* g = new juce::DynamicObject();
      g->setProperty("type", "stack");
      g->setProperty("name", "Kit");
      juce::Array<juce::var> kids;
      for (int i = 0; i < 3; ++i) {
        auto* k = new juce::DynamicObject();
        k->setProperty("type", "clip");
        k->setProperty("name", "Mic " + juce::String(i + 1));
        k->setProperty("inputChannel", i);
        kids.add(juce::var(k));
      }
      g->setProperty("children", kids);

      expect(engine.insertTrackTemplate(juce::var(g), ""), "insert ok");
      expectEquals(topCount(engine), 2, "group landed");
      const auto kit = topNode(engine, 1);
      expectEquals(kit.getProperty("name", "").toString(),
                   juce::String("Kit"), "group named");
      auto* kitKids = kit.getProperty("nodes", juce::var()).getArray();
      expect(kitKids != nullptr && kitKids->size() == 3, "3 mics inside");
      expectEquals((int)(*kitKids)[2].getProperty("inputChannel", -9), 2,
                   "inputs routed");

      engine.undo();
      expectEquals(topCount(engine), 1, "ONE undo removes the whole group");
      engine.redo();
      expectEquals(topCount(engine), 2, "ONE redo restores it whole");
      const juce::var redoneKit = topNode(engine, 1);  // keep the var alive
      auto* redone = redoneKit.getProperty("nodes", juce::var()).getArray();
      expect(redone != nullptr && redone->size() == 3,
             "children survive the round-trip");
    }

    beginTest("library round-trip: save from selection -> list -> create");
    {
      auto tempBase =
          juce::File::getSpecialLocation(juce::File::tempDirectory)
              .getChildFile("celestrian_ttpl_test");
      tempBase.deleteRecursively();

      AudioEngine engine;
      ProjectManager pm(engine);
      pm.setRootForTest(tempBase);

      // Build "the rig" live: a clip with an input, saved by uuid.
      engine.createNode("clip");
      const auto first = topNode(engine, 0);
      const juce::String uuid = first.getProperty("id", "").toString();
      engine.renameNode(uuid, "Guitar");
      engine.setNodeInput(uuid, 2);

      expect(pm.saveTrackTemplate("Guitar", uuid), "save from selection");
      expect(!pm.saveTrackTemplate("   ", uuid), "blank name refused");
      expect(!pm.saveTrackTemplate("Nope", "no-such-uuid"),
             "unknown node refused");

      auto list = pm.listTrackTemplates();
      expectEquals((int)list.size(), 1, "one template listed");
      expectEquals(list[0].name, juce::String("Guitar"), "by name");
      expectEquals(list[0].kind, juce::String("clip"), "kind metadata");
      expectEquals(list[0].tracks, 1, "leaf count metadata");

      // Junk in the library dir must never break the listing.
      pm.trackTemplatesRoot()
          .getChildFile("garbage.json")
          .replaceWithText("not json {");
      expectEquals((int)pm.listTrackTemplates().size(), 1,
                   "junk file skipped, never fatal");

      expect(pm.createFromTrackTemplate("Guitar", ""), "create from library");
      expect(!pm.createFromTrackTemplate("Missing", ""),
             "unknown template refused");
      expectEquals(topCount(engine), 2, "the stamped track landed");
      const auto stamped = topNode(engine, 1);
      expectEquals(stamped.getProperty("name", "").toString(),
                   juce::String("Guitar"), "named on arrival");
      expectEquals((int)stamped.getProperty("inputChannel", -9), 2,
                   "routed on arrival");
      expect(stamped.getProperty("id", "").toString() != uuid,
             "fresh uuid - the original is untouched");

      // Re-save over the same name: the expected rig-update gesture.
      engine.setNodeInput(uuid, 5);
      expect(pm.saveTrackTemplate("Guitar", uuid), "overwrite by name");
      expectEquals((int)pm.listTrackTemplates().size(), 1, "still one entry");
      expect(pm.createFromTrackTemplate("Guitar", ""), "create updated");
      expectEquals((int)topNode(engine, 2).getProperty("inputChannel", -9), 5,
                   "the updated input stamps");

      tempBase.deleteRecursively();
    }
  }
};

static TrackTemplateTests trackTemplateTests;

}  // namespace celestrian
