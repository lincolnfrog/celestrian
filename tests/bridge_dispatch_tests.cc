/**
 * The bridge table (src/bridge_dispatch.h) as a page meets it: every
 * case calls a protocol method BY NAME through the handler both hosts
 * register — the WebView and the headless server — and reads what the
 * page's promise would resolve with.
 *
 * THE ANSWER LAW (ui/js/protocol.js): a verb the engine can refuse
 * answers whether it applied. Refused is `false` with the published
 * graph and the undo / redo flags exactly as they were; applied is
 * `true`. An edit that would change nothing is not applied: it records
 * no step and keeps the redo branch. Verbs that make a node answer its
 * uuid ("" refused), and the project listings answer values, never JSON
 * text.
 */

#include <juce_core/juce_core.h>

#include <map>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/bridge_dispatch.h"
#include "../src/plugin_host_service.h"
#include "../src/project_manager.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::driveEngine;
using test_utils::firstDifference;
using test_utils::freshTempDir;
using test_utils::graphFacts;

namespace {

using Args = juce::Array<juce::var>;

constexpr int kBlock = 512;
constexpr int64_t kTake = 16 * kBlock;  // one take's length, in samples

/** One app without a window: the engine, its two services, and the
 * bridge table over them. */
struct Host {
  explicit Host(const juce::String& name)
      : plugins(freshTempDir("bridge_" + name + "_plugins")) {
    projects.setRootForTest(freshTempDir("bridge_" + name + "_projects"));
    for (auto& method : bridge::engineMethods({engine, projects, plugins})) {
      table[method.name] = std::move(method.handler);
    }
  }

  /** What the table completes a page's `name(args)` with; void when the
   * name is unknown or the handler did not complete at once. */
  juce::var call(const juce::String& name, const Args& args = {}) {
    juce::var answer;
    const auto entry = table.find(name);
    if (entry != table.end()) {
      entry->second(args, [&answer](juce::var result) { answer = result; });
    }
    return answer;
  }

  juce::var state() { return engine.getGraphState(); }
  juce::var node(const juce::String& uuid) {
    return bridge::findNodeVar(state(), uuid);
  }
  juce::String rootId() { return state().getProperty("id", "").toString(); }

  /** Blocks until no take is live, then the poll that settles it. */
  void settle() {
    for (int i = 0; i < 4000 && engine.hasActiveTake(); ++i) {
      driveEngine(engine, kBlock, kBlock);
    }
    state();
  }

  /** A new top-level clip, empty; its uuid. */
  juce::String emptyClip() { return call("createNode", {"clip"}).toString(); }

  /** A new top-level clip holding one committed take; its uuid. */
  juce::String recordedClip() {
    const juce::String id = emptyClip();
    call("startRecordingInNode", {id});
    driveEngine(engine, kTake, kBlock);
    call("stopRecordingInNode", {id});
    settle();
    return id;
  }

  /** One more take of committed clip `id`, run to its end. */
  void addTake(const juce::String& id) {
    call("newTake", {id});
    settle();
  }

  const std::unique_ptr<AudioEngine> engine_owner =
      std::make_unique<AudioEngine>();
  AudioEngine& engine = *engine_owner;
  ProjectManager projects{engine};
  PluginHostService plugins;
  std::map<juce::String, bridge::Handler> table;
};

/** The bridge shape of a song: one step per length. */
juce::var songOf(const std::vector<int64_t>& step_lengths) {
  juce::Array<juce::var> steps;
  for (const int64_t length : step_lengths) {
    auto* step = new juce::DynamicObject();
    step->setProperty("name", "S" + juce::String(steps.size() + 1));
    step->setProperty("len", (double)length);
    steps.add(juce::var(step));
  }
  auto* song = new juce::DynamicObject();
  song->setProperty("steps", steps);
  song->setProperty("gates", juce::var(new juce::DynamicObject()));
  return juce::var(song);
}

/** The slot uuid of node `uuid`'s first `type` slot. */
juce::String slotOf(Host& host, const juce::String& uuid, const char* type) {
  const juce::var chain = host.node(uuid)
                              .getProperty("effects", juce::var())
                              .getProperty("chain", juce::var());
  if (auto* slots = chain.getArray()) {
    for (const auto& slot : *slots) {
      if (slot.getProperty("type", "").toString() == type) {
        return slot.getProperty("slot", "").toString();
      }
    }
  }
  return {};
}

bool hasKeys(const juce::var& record, const juce::StringArray& keys) {
  auto* object = record.getDynamicObject();
  if (object == nullptr) return false;
  for (const auto& key : keys) {
    if (!object->hasProperty(juce::Identifier(key))) return false;
  }
  return true;
}

}  // namespace

class BridgeDispatchTests : public juce::UnitTest {
 public:
  BridgeDispatchTests() : juce::UnitTest("Bridge dispatch", "Bridge") {}

  /** `name(args)` is REFUSED: it answers false, and the published graph
   * and the log's flags stand as they were. */
  void expectRefused(Host& host, const char* name, const Args& args,
                     const juce::String& why) {
    const juce::var before = graphFacts(host.engine);
    const bool could_undo = host.engine.canUndo();
    const bool could_redo = host.engine.canRedo();
    const bool was_playing = host.engine.isPlaying();
    const juce::var answer = host.call(name, args);
    const juce::String label = juce::String(name) + " (" + why + ")";
    expect(answer.isBool() && !(bool)answer, label + " answers false");
    expectEquals(firstDifference(before, graphFacts(host.engine)),
                 juce::String(), label + " leaves the graph as it was");
    expect(host.engine.canUndo() == could_undo, label + " logs no step");
    expect(host.engine.canRedo() == could_redo,
           label + " keeps the redo branch");
    expect(host.engine.isPlaying() == was_playing,
           label + " leaves the transport");
  }

  /** `name(args)` APPLIED: it answers true. */
  void expectApplied(Host& host, const char* name, const Args& args = {},
                     const juce::String& what = {}) {
    const juce::var answer = host.call(name, args);
    expect(answer.isBool() && (bool)answer,
           juce::String(name) + (what.isEmpty() ? "" : " (" + what + ")") +
               " answers true");
  }

  void runTest() override {
    beginTest("the transport toggle answers whether it toggled: a pause "
              "under a live take is refused");
    {
      Host host("transport");
      expectApplied(host, "togglePlayback", {}, "play");
      expect(host.engine.isPlaying());
      expectApplied(host, "togglePlayback", {}, "pause");
      expect(!host.engine.isPlaying());

      const juce::String clip = host.emptyClip();
      expectApplied(host, "startRecordingInNode", {clip});
      expect(host.engine.isPlaying(), "the arm started the transport");
      expectRefused(host, "togglePlayback", {}, "a pause under a live take");
      expectApplied(host, "stopRecordingInNode", {clip});
      host.settle();
      expectApplied(host, "togglePlayback", {}, "pause, the take landed");
      expect(!host.engine.isPlaying());
    }

    beginTest("arm, stop and new take answer whether a take was armed or "
              "asked to stop");
    {
      Host host("recording");
      expectRefused(host, "startRecordingInNode", {"no-such-node"},
                    "an unknown node");
      expectRefused(host, "stopRecordingInNode", {"no-such-node"},
                    "an unknown node");
      const juce::String a = host.emptyClip();
      expectRefused(host, "stopRecordingInNode", {a}, "no live take there");
      expectRefused(host, "newTake", {a}, "an empty clip has no slot");

      expectApplied(host, "startRecordingInNode", {a});
      expect(host.engine.hasActiveTake());
      const juce::String b = host.emptyClip();  // wiring stays live
      expect(b.isNotEmpty(), "a track can be made under a take");
      expectRefused(host, "startRecordingInNode", {b}, "a second arm");
      expectRefused(host, "newTake", {a}, "a second arm");
      expectRefused(host, "stopRecordingInNode", {b}, "no live take there");
      driveEngine(host.engine, kTake, kBlock);
      expectApplied(host, "stopRecordingInNode", {a});
      host.settle();
      expect((double)host.node(a).getProperty("duration", 0) > 0,
             "the take committed");

      expectRefused(host, "startRecordingInNode", {a},
                    "no empty clip beneath");
      expectRefused(host, "newTake", {b}, "no committed clip beneath");
      expectApplied(host, "newTake", {a});
      expect(host.engine.hasActiveTake());
      expectApplied(host, "stopRecordingInNode", {a}, "cancels the new take");
      host.settle();
      expectEquals((int)host.node(a).getProperty("takes", 0), 1,
                   "the cancelled take left the slot as it stood");
    }

    beginTest("select, delete and comp answer whether the take list or the "
              "comp changed");
    {
      Host host("takes");
      const juce::String clip = host.recordedClip();
      host.addTake(clip);
      expectEquals((int)host.node(clip).getProperty("takes", 0), 2);
      expectEquals((int)host.node(clip).getProperty("activeTake", -1), 1);

      expectRefused(host, "selectTake", {clip, 5}, "no such take");
      expectRefused(host, "selectTake", {"no-such-node", 0}, "no such clip");
      expectRefused(host, "selectTake", {clip, 1}, "the take that sounds");
      expectApplied(host, "selectTake", {clip, 0});
      expectEquals((int)host.node(clip).getProperty("activeTake", -1), 0);

      const Args one_cell{clip, juce::var(Args{1})};
      expectRefused(host, "setComp", {clip, juce::var(Args{0, 1})},
                    "two cells for a one-cell period");
      expectRefused(host, "setComp", {clip, juce::var(Args{9})},
                    "a take that does not exist");
      expectRefused(host, "setComp", {clip, juce::var(Args{})},
                    "no comp to clear");
      expectApplied(host, "setComp", one_cell);
      expectRefused(host, "setComp", one_cell, "the comp it has");
      expectApplied(host, "setComp", {clip, juce::var(Args{})}, "clear");

      const juce::String other = host.emptyClip();
      host.call("startRecordingInNode", {other});
      expectRefused(host, "selectTake", {clip, 1}, "a take is live");
      expectRefused(host, "deleteTake", {clip, 1}, "a take is live");
      expectRefused(host, "setComp", one_cell, "a take is live");
      host.call("stopRecordingInNode", {other});
      host.settle();

      expectRefused(host, "deleteTake", {clip, 7}, "no such take");
      expectApplied(host, "deleteTake", {clip, 1});
      expectEquals((int)host.node(clip).getProperty("takes", 0), 1);
      expectRefused(host, "deleteTake", {clip, 0}, "a slot's last take");
    }

    beginTest("the Q hand-off answers whether Q was handed");
    {
      Host host("definer");
      const juce::String empty = host.emptyClip();
      expectRefused(host, "setDefiner", {empty}, "no Q yet");
      const juce::String first = host.recordedClip();
      const juce::String second = host.recordedClip();
      expectRefused(host, "setDefiner", {"no-such-node"}, "an unknown node");
      expectRefused(host, "setDefiner", {host.rootId()}, "the root");
      expectRefused(host, "setDefiner", {empty}, "nothing committed there");
      expectApplied(host, "setDefiner", {second});
      expectEquals(host.state().getProperty("definerId", "").toString(),
                   second);
      expectRefused(host, "setDefiner", {second}, "it defines Q already");

      host.call("startRecordingInNode", {empty});
      expectRefused(host, "setDefiner", {first}, "a take is live");
      host.call("stopRecordingInNode", {empty});
    }

    beginTest("create and combine answer the new node's uuid; delete, "
              "rename and move answer whether they applied");
    {
      Host host("structure");
      const juce::var made = host.call("createNode", {"clip"});
      expect(made.isString() && made.toString().isNotEmpty(),
             "createNode answers the uuid");
      const juce::String a = made.toString();
      expect(!host.node(a).isVoid(), "and the node is in the graph");
      const juce::var before = graphFacts(host.engine);
      const juce::var refused =
          host.call("createNode", Args{juce::var("clip"), juce::var(a)});
      expect(refused.isString() && refused.toString().isEmpty(),
             "createNode under a clip answers \"\"");
      expectEquals(firstDifference(before, graphFacts(host.engine)),
                   juce::String(), "and makes nothing");

      const juce::String b = host.emptyClip();
      const juce::String c = host.emptyClip();
      expectApplied(host, "renameNode", {a, "bass"});
      expectRefused(host, "renameNode", {"no-such-node", "x"}, "unknown");
      expectApplied(host, "reorderNode", {a, host.rootId(), 2});
      expectRefused(host, "reorderNode", {a, "no-such-node", 0},
                    "an unknown parent");
      expectRefused(host, "reorderNode", {a, b, 0}, "a clip holds nothing");
      expectRefused(host, "reorderNode", {host.rootId(), host.rootId(), 0},
                    "the root");
      expectRefused(host, "deleteNode", {"no-such-node"}, "unknown");
      expectRefused(host, "deleteNode", {host.rootId()}, "the root");

      host.call("startRecordingInNode", {c});
      expectRefused(host, "deleteNode", {a}, "a take is live");
      expectRefused(host, "reorderNode", {a, host.rootId(), 0},
                    "a take is live");
      const juce::var held = graphFacts(host.engine);
      const juce::var no_group = host.call("combineNodes", {a, b});
      expect(no_group.isString() && no_group.toString().isEmpty(),
             "combineNodes under a live take answers \"\"");
      expectEquals(firstDifference(held, graphFacts(host.engine)),
                   juce::String(), "and groups nothing");
      expectApplied(host, "renameNode", {a, "kick"}, "wiring stays live");
      expectApplied(host, "toggleMute", {a}, "wiring stays live");
      host.call("stopRecordingInNode", {c});
      host.settle();

      const juce::var group = host.call("combineNodes", {a, b});
      expect(group.isString() && group.toString().isNotEmpty(),
             "combineNodes answers the group's uuid");
      expectEquals(host.node(group.toString()).getProperty("type", "").toString(),
                   juce::String("stack"));
      expectApplied(host, "deleteNode", {group.toString()});
      expect(host.node(a).isVoid(), "the group went with its tracks");
      expectRefused(host, "toggleMute", {"no-such-node"}, "unknown");
    }

    beginTest("an edit that changes nothing records no step and keeps the "
              "redo branch");
    {
      Host host("identity");
      const juce::String a = host.emptyClip();
      const juce::String b = host.emptyClip();
      const juce::String group =
          host.call("createNode", {"stack"}).toString();
      host.call("renameNode", {a, "bass"});
      host.call("undo");
      expect(host.engine.canRedo(), "a redo branch stands");
      expectEquals(host.node(a).getProperty("name", "").toString(),
                   juce::String("New Clip"));

      expectRefused(host, "renameNode", {a, "New Clip"}, "the name it has");
      expectRefused(host, "setNodeInput", {a, 0}, "the channel it has");
      expectRefused(host, "setNodeInputRight", {a, -1}, "mono already");
      expectRefused(host, "reorderNode", {a, host.rootId(), 0},
                    "the slot it is in");
      expectRefused(host, "reorderNode", {a, host.rootId(), -4},
                    "an index that clamps to its slot");
      expectRefused(host, "reorderNode", {group, host.rootId(), 9},
                    "an index that clamps to its slot");
      expectRefused(host, "setSequence", {host.rootId(), juce::var()},
                    "no song to clear");
      expectRefused(host, "setSequence", {group, songOf({})},
                    "no song to clear");
      expectRefused(host, "toggleSequence", {group}, "no song to bypass");
      expectRefused(host, "setLoopPoints", {b, 0, 0}, "no window to clear");
      expectRefused(host, "setPeriodSource", {a, "own"}, "a loop already");

      // The branch that survived them all is still the rename.
      expectApplied(host, "redo");
      expectEquals(host.node(a).getProperty("name", "").toString(),
                   juce::String("bass"));
    }

    beginTest("undo and redo answer whether a step was applied; a cancelled "
              "drag answers whether it left no trace");
    {
      Host host("log");
      expectRefused(host, "undo", {}, "nothing to undo");
      expectRefused(host, "redo", {}, "nothing to redo");
      const juce::String clip = host.recordedClip();
      const juce::String other = host.emptyClip();
      expectApplied(host, "undo", {}, "the empty track");
      expect(host.node(other).isVoid());
      expectApplied(host, "redo");
      expectRefused(host, "redo", {}, "nothing more to redo");

      host.call("startRecordingInNode", {other});
      expectRefused(host, "undo", {}, "a take is live");
      host.call("stopRecordingInNode", {other});
      host.settle();

      const int64_t length =
          (int64_t)(double)host.node(clip).getProperty("duration", 0);
      expectRefused(host, "cancelGesture", {clip}, "no drag is open");
      const juce::var before = graphFacts(host.engine);
      expectApplied(host, "setLoopPoints",
                    {clip, 0, (double)(length / 2)}, "a drag's first commit");
      expectApplied(host, "setLoopPoints",
                    {clip, 0, (double)(length / 4), true}, "a live commit");
      expectApplied(host, "cancelGesture", {clip});
      expectEquals(firstDifference(before, graphFacts(host.engine)),
                   juce::String(), "the clip is as the drag found it");
      expectRefused(host, "cancelGesture", {clip}, "the drag is over");

      // A drag whose commits all changed nothing has no step to take
      // back: the clip is as the drag found it.
      host.call("setLoopPoints", {clip, 0, 0});
      expectApplied(host, "cancelGesture", {clip}, "nothing was logged");
    }

    beginTest("map, re-time, song and audition verbs answer whether they "
              "applied");
    {
      Host host("geometry");
      const juce::String first = host.recordedClip();
      const juce::String second = host.recordedClip();
      const juce::String root = host.rootId();
      const int64_t q =
          (int64_t)(double)host.state().getProperty("quantum", 0);
      expect(q > 0, "Q is established");
      const int64_t length =
          (int64_t)(double)host.node(second).getProperty("duration", 0);

      expectApplied(host, "setLoopPoints", {second, 0, (double)(length / 2)});
      expectRefused(host, "setLoopPoints", {second, 0, (double)(length / 2)},
                    "the window it has");
      expectRefused(host, "setLoopPoints", {"no-such-node", 0, 100},
                    "unknown");
      expectRefused(host, "setLoopPoints", {second, 0, (double)(length / 3)},
                    "a period Q cannot carry");
      expectApplied(host, "toggleLoopWindow", {second});
      expectRefused(host, "toggleLoopWindow", {"no-such-node"}, "unknown");
      const Args backwards{second,
                           juce::var(Args{(double)(length / 2), 0.0,
                                          (double)length, (double)(length / 2)})};
      expectRefused(host, "setSegments", backwards, "malformed cells");

      expectApplied(host, "setTiming", {second, 64});
      expectRefused(host, "setTiming", {second, 0}, "a zero shift");
      expectRefused(host, "setTiming", {root, 64}, "the root");
      expectRefused(host, "setTiming", {second, juce::var("soon")},
                    "a shift that is not a number");

      expectRefused(host, "setPeriodSource", {second, "own"},
                    "a loop already");
      expectApplied(host, "setPeriodSource", {second, "context"});
      expectApplied(host, "setPeriodSource", {second, "own"});

      expectRefused(host, "setSequence", {second, songOf({q})}, "a clip");
      expectRefused(host, "setSequence", {root, songOf({q, 0})},
                    "a step with no length");
      expectRefused(host, "auditionStep", {root, 0}, "no song");
      expectApplied(host, "setSequence", {root, songOf({q, q})});
      expectRefused(host, "toggleSequence", {second}, "a clip");
      expectApplied(host, "toggleSequence", {root}, "bypass");
      expectRefused(host, "auditionStep", {root, 0}, "a bypassed song");
      expectApplied(host, "toggleSequence", {root}, "back on");
      expectApplied(host, "auditionStep", {root, 1});
      expectRefused(host, "auditionStep", {root, 7}, "no such step");
      expectRefused(host, "auditionStep", {second, 0}, "a clip");
      expectApplied(host, "auditionStep", {root, -1}, "release");

      const juce::String empty = host.emptyClip();
      host.call("startRecordingInNode", {empty});
      expectRefused(host, "setLoopPoints", {second, 0, 0}, "a take is live");
      expectRefused(host, "toggleLoopWindow", {second}, "a take is live");
      expectRefused(host, "setTiming", {second, 64}, "a take is live");
      expectRefused(host, "setPeriodSource", {second, "context"},
                    "a take is live");
      expectRefused(host, "setSequence", {root, juce::var()},
                    "a take is live");
      expectRefused(host, "toggleSequence", {root}, "a take is live");
      expectRefused(host, "auditionStep", {root, 0}, "a take is live");
      host.call("stopRecordingInNode", {empty});
    }

    beginTest("input, monitor and the chain verbs answer whether they "
              "applied");
    {
      Host host("wiring");
      const juce::String clip = host.emptyClip();
      const juce::String group =
          host.call("createNode", {"stack"}).toString();
      expectApplied(host, "setNodeInput", {clip, 1});
      expectApplied(host, "setNodeInputRight", {clip, 2});
      expectRefused(host, "setNodeInput", {group, 1}, "a group records nothing");
      expectRefused(host, "setNodeInputRight", {group, 1},
                    "a group records nothing");

      expectApplied(host, "setMonitor", {clip, true});
      expect((bool)host.node(clip).getProperty("monitor", false));
      expectRefused(host, "setMonitor", {group, true},
                    "a group has no input to monitor");

      const juce::String eq = slotOf(host, clip, "eq");
      expect(eq.isNotEmpty(), "the rack has an eq");
      expectApplied(host, "setSlotEnabled", {clip, eq, true});
      expectRefused(host, "setSlotEnabled", {clip, "no-such-slot", true},
                    "an unknown slot");
      expectRefused(host, "setSlotEnabled", {"no-such-node", eq, true},
                    "an unknown node");
      expectApplied(host, "moveChainSlot", {clip, eq, 3});
      expectRefused(host, "moveChainSlot", {clip, eq, 3}, "the slot it is in");
      expectRefused(host, "removeChainSlot", {clip, eq}, "a built-in stays");
      expectRefused(host, "addPluginToChain", {clip, "no-such-plugin"},
                    "a plugin the registry does not hold");
    }

    beginTest("a plugin add answers once the instance has arrived: true "
              "with the slot in the chain, false when it could not be "
              "loaded or its track is gone");
    {
      Host host("plugin_add");
      const juce::String clip = host.emptyClip();
      juce::PluginDescription fake;
      fake.name = "Fake Verb";
      fake.pluginFormatName = "VST3";
      fake.fileOrIdentifier = "/fake/FakeVerb.vst3";
      fake.uniqueId = 7;
      host.plugins.knownPlugins().addType(fake);
      const juce::String uid = fake.createIdentifierString();
      // The instantiation in flight, held until the test lets it land.
      juce::AudioPluginFormat::PluginCreationCallback landing;
      host.plugins.setCreatorForTest(
          [&landing](const juce::PluginDescription&, double, int,
                     juce::AudioPluginFormat::PluginCreationCallback created) {
            landing = std::move(created);
          });
      // The page's promise for one add: void until the bridge completes it.
      const auto add = [&host, &uid](const juce::String& node) {
        auto promise = std::make_shared<juce::var>();
        host.table["addPluginToChain"](
            Args{juce::var(node), juce::var(uid)},
            [promise](juce::var result) { *promise = result; });
        return promise;
      };
      const auto stub = [] {
        return std::make_unique<test_utils::StubPluginInstance>();
      };

      const auto added = add(clip);
      expect(added->isVoid(), "no answer while the plugin loads");
      expect(slotOf(host, clip, "vst3").isEmpty(), "and no slot yet");
      landing(stub(), {});
      expect(added->isBool() && (bool)*added, "the slot landed: true");
      expect(slotOf(host, clip, "vst3").isNotEmpty(), "it is in the chain");
      expectApplied(host, "undo", {}, "the add is one step");
      expect(slotOf(host, clip, "vst3").isEmpty(), "undo takes it out");

      const juce::var before = graphFacts(host.engine);
      const auto failed = add(clip);
      landing(nullptr, "the module would not open");
      expect(failed->isBool() && !(bool)*failed,
             "a plugin that could not be loaded: false");
      expectEquals(firstDifference(before, graphFacts(host.engine)),
                   juce::String(), "and the graph stands");
      expect(host.engine.canRedo(), "with the redo branch");

      const auto orphaned = add(clip);
      expectApplied(host, "deleteNode", {clip});
      landing(stub(), {});
      expect(orphaned->isBool() && !(bool)*orphaned,
             "a track deleted while the plugin loaded: false");
    }

    beginTest("a calibration run in flight refuses a second");
    {
      Host host("calibration");
      expectApplied(host, "startLatencyCalibration");
      const juce::var again = host.call("startLatencyCalibration");
      expect(again.isBool() && !(bool)again, "the second answers false");
      expectEquals(host.call("getLatencyCalibration")
                       .getProperty("phase", "")
                       .toString(),
                   juce::String("capturing"));
    }

    beginTest("a verb that answers whether it applied answers false when "
              "its arguments are missing");
    {
      Host host("missing");
      for (const char* name :
           {"startRecordingInNode", "stopRecordingInNode", "newTake",
            "selectTake", "deleteTake", "setComp", "deleteNode", "renameNode",
            "reorderNode", "cancelGesture", "setNodeInput",
            "setNodeInputRight", "setMonitor", "toggleMute",
            "setPeriodSource", "setDefiner", "setSlotEnabled", "moveChainSlot",
            "addPluginToChain", "removeChainSlot", "setLoopPoints",
            "setSegments", "setTiming", "toggleLoopWindow", "setSequence",
            "toggleSequence", "auditionStep"}) {
        const juce::var answer = host.call(name);
        expect(answer.isBool() && !(bool)answer,
               juce::String(name) + " with no arguments answers false");
      }
      expect(host.call("createNode").toString().isEmpty() &&
                 host.call("createNode").isString(),
             "createNode with no arguments answers \"\"");
    }

    beginTest("the project and template listings answer values, never "
              "JSON text");
    {
      Host host("listings");
      const juce::var info = host.call("getProjectInfo");
      expect(hasKeys(info, {"id", "name", "born", "projectsRoot",
                            "trackTemplatesRoot"}),
             "getProjectInfo answers its record");
      expect(info.getProperty("born", true).isBool() &&
                 !(bool)info.getProperty("born", true),
             "unborn before the first take");
      expect(info.getProperty("projectsRoot", "").toString().isNotEmpty());

      for (const char* listing :
           {"listTemplates", "listRecentProjects", "listTrackTemplates"}) {
        const juce::var empty = host.call(listing);
        expect(empty.isArray() && empty.size() == 0,
               juce::String(listing) + " answers an empty list");
      }

      const juce::String clip = host.recordedClip();
      expectApplied(host, "saveProjectNow");
      expectApplied(host, "saveAsTemplate", {"My Rig"});
      expectApplied(host, "saveTrackTemplate", {clip, "Mic"});

      const juce::var born = host.call("getProjectInfo");
      expect((bool)born.getProperty("born", false), "the save births it");
      expect(born.getProperty("id", "").toString().isNotEmpty());

      const juce::var templates = host.call("listTemplates");
      expect(templates.isArray() && templates.size() == 1,
             "one template listed");
      expect(hasKeys(templates[0], {"id", "name", "path"}));
      expectEquals(templates[0].getProperty("name", "").toString(),
                   juce::String("My Rig"));

      const juce::var recents = host.call("listRecentProjects");
      expect(recents.isArray() && recents.size() == 1, "one project listed");
      expect(hasKeys(recents[0], {"id", "name", "path"}));
      expectEquals(recents[0].getProperty("id", "").toString(),
                   born.getProperty("id", "").toString());

      const juce::var tracks = host.call("listTrackTemplates");
      expect(tracks.isArray() && tracks.size() == 1,
             "one track template listed");
      expect(hasKeys(tracks[0], {"name", "kind", "tracks"}));
      expectEquals(tracks[0].getProperty("kind", "").toString(),
                   juce::String("clip"));
      expectEquals((int)tracks[0].getProperty("tracks", 0), 1);
    }
  }
};

static BridgeDispatchTests bridgeDispatchTests;

}  // namespace celestrian
