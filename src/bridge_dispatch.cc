#include "bridge_dispatch.h"

#include <cmath>
#include <vector>

#include "dsp/vst3_slot.h"
#include "timing.h"

namespace celestrian::bridge {

namespace {
juce::String projectInfosToJson(const std::vector<ProjectManager::Info>& infos) {
  juce::Array<juce::var> arr;
  for (const auto& i : infos) {
    auto* o = new juce::DynamicObject();
    o->setProperty("id", i.id);
    o->setProperty("name", i.name);
    o->setProperty("path", i.path);
    arr.add(juce::var(o));
  }
  return juce::JSON::toString(juce::var(arr), true);
}

juce::String trackTemplatesToJson(
    const std::vector<ProjectManager::TrackTemplateInfo>& infos) {
  juce::Array<juce::var> arr;
  for (const auto& i : infos) {
    auto* o = new juce::DynamicObject();
    o->setProperty("name", i.name);
    o->setProperty("kind", i.kind);      // 'clip' | 'group'
    o->setProperty("tracks", i.tracks);  // "Drums · 5 tracks"
    arr.add(juce::var(o));
  }
  return juce::JSON::toString(juce::var(arr), true);
}

/** Async VST3 instantiation → engine AddSlot edit (docs/vst3.md §4).
 * index < 0 appends. The completion runs on the MESSAGE thread; the
 * engine preps + publishes + records the undoable AddSlot. A node
 * deleted mid-flight no-ops in the engine. Identity comes from the
 * REGISTRY description (captured by value) — a description refilled
 * from a hosted instance drops the format tag, and the uid must match
 * what the known list reports at revival time. */
void addPluginToChain(Services s, const juce::String& node_uuid,
                      const juce::String& plugin_uid, int index) {
  const auto types = s.plugins.knownPlugins().getTypes();
  const juce::PluginDescription* found = nullptr;
  for (const auto& type : types) {
    if (type.createIdentifierString() == plugin_uid) {
      found = &type;
      break;
    }
  }
  if (found == nullptr) {
    juce::Logger::writeToLog("addPluginToChain: unknown plugin uid " +
                             plugin_uid);
    return;
  }
  const juce::PluginDescription description = *found;
  AudioEngine* engine = &s.engine;
  s.plugins.formats().createPluginInstanceAsync(
      description, s.engine.currentSampleRateOrFallback(),
      dsp::Vst3Slot::kMaxBlockSize,
      [engine, node_uuid, index, description](
          std::unique_ptr<juce::AudioPluginInstance> instance,
          const juce::String& error) {
        if (instance == nullptr) {
          juce::Logger::writeToLog("addPluginToChain: instantiation failed: " +
                                   error);
          return;
        }
        auto slot = std::make_shared<dsp::Vst3Slot>(
            std::move(instance), description.createIdentifierString(),
            description.name, description.fileOrIdentifier,
            description.isInstrument, description.pluginFormatName);
        engine->addPluginSlotToChain(node_uuid, std::move(slot), index);
      });
}
}  // namespace

void logCall(const char* name) {
#if JUCE_DEBUG
  const juce::String n(name);
  if (n == "getGraphState" || n == "getProjectInfo") return;
  juce::Logger::writeToLog("bridge: " + n);
#else
  juce::ignoreUnused(name);
#endif
}

std::vector<Method> engineMethods(Services s) {
  AudioEngine& engine = s.engine;
  ProjectManager& projects = s.projects;
  PluginHostService& plugins = s.plugins;
  auto* e = &engine;
  auto* p = &projects;
  auto* h = &plugins;
  return {
      valueMethod("ping", 0, [](const auto&) { return "pong"; }),
      // Transport
      voidMethod("togglePlayback", 0, [e](const auto&) { e->togglePlayback(); }),
      // Ruler scrub: a phase ADVANCE in samples (the view computes it
      // against the frame zero it seated, docs/frame.md), optionally
      // with the transport reading it was computed against. Answers
      // {advance, clock} — what was applied, and when — so the view
      // keeps its frame facts exact between polls; false when refused
      // (a take is live or armed).
      valueMethod(
          "seekTransport", 1,
          [e](const auto& args) -> juce::var {
            std::optional<int64_t> at_clock;
            if (args.size() > 1 && !args[1].isVoid()) {
              at_clock = (int64_t)(double)args[1];
            }
            AudioEngine::SeekResult applied;
            if (!e->seekTransport((double)args[0], at_clock, &applied)) {
              return juce::var(false);
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("advance", (double)applied.advance);
            o->setProperty("clock", (double)applied.clock);
            return juce::var(o);
          },
          juce::var(false)),
      // Recording
      voidMethod("startRecordingInNode", 1,
                 [e](const auto& args) { e->startRecordingInNode(args[0].toString()); }),
      voidMethod("stopRecordingInNode", 1,
                 [e](const auto& args) { e->stopRecordingInNode(args[0].toString()); }),
      // State
      valueMethod("getGraphState", 0, [e](const auto&) { return e->getGraphState(); }),
      valueMethod(
          "getWaveform", 2,
          [e](const auto& args) {
            return e->getWaveform(args[0].toString(), (int)args[1]);
          },
          juce::var(juce::Array<juce::var>())),
      // Takes and comping (docs/takes.md).
      voidMethod("newTake", 1, [e](const auto& args) { e->newTake(args[0].toString()); }),
      voidMethod("selectTake", 2,
                 [e](const auto& args) { e->selectTake(args[0].toString(), (int)args[1]); }),
      voidMethod("deleteTake", 2,
                 [e](const auto& args) { e->deleteTake(args[0].toString(), (int)args[1]); }),
      voidMethod("setComp", 2,
                 [e](const auto& args) {
                   // args[1] = [take index per Q cell]
                   std::vector<int> cells;
                   if (auto* arr = args[1].getArray()) {
                     for (const auto& c : *arr) cells.push_back((int)c);
                   }
                   e->setComp(args[0].toString(), cells);
                 }),
      valueMethod(
          "getTakeWaveform", 3,
          [e](const auto& args) {
            return e->getTakeWaveform(args[0].toString(), (int)args[1], (int)args[2]);
          },
          juce::var(juce::Array<juce::var>())),
      voidMethod("dumpStateToFile", 1,
                 [](const auto& args) {
                   auto stateFile =
                       juce::File::getCurrentWorkingDirectory().getChildFile(
                           "celestrian_state.json");
                   stateFile.replaceWithText(args[0].toString());
                   // Functional logging (kept in release): records where
                   // the state landed.
                   juce::Logger::writeToLog("State dumped to: " +
                                            stateFile.getFullPathName());
                 }),
      // Graph structure
      voidMethod("createNode", 1,
                 [e](const auto& args) {
                   if (args.size() > 1)
                     e->createNode(args[0].toString(), args[1].toString());
                   else
                     e->createNode(args[0].toString());
                 }),
      voidMethod("deleteNode", 1, [e](const auto& args) { e->deleteNode(args[0].toString()); }),
      voidMethod("renameNode", 2,
                 [e](const auto& args) {
                   e->renameNode(args[0].toString(), args[1].toString());
                 }),
      voidMethod("reorderNode", 3,
                 [e](const auto& args) {
                   e->reorderNode(args[0].toString(), args[1].toString(), (int)args[2]);
                 }),
      valueMethod(
          "combineNodes", 2,
          [e](const auto& args) {
            return e->combineNodes(args[0].toString(), args[1].toString());
          },
          juce::var(juce::String())),
      // Undo / redo
      voidMethod("undo", 0, [e](const auto&) { e->undo(); }),
      voidMethod("redo", 0, [e](const auto&) { e->redo(); }),
      // Sessions: the PATH forms. An empty path is the app shell's
      // native chooser (main_component.cc overrides both names); here
      // it is simply refused.
      valueMethod(
          "saveSession", 0,
          [e](const auto& args) {
            const juce::String path = args.size() > 0 ? args[0].toString() : "";
            return path.isNotEmpty() ? e->saveSession(path) : false;
          },
          juce::var(false)),
      valueMethod(
          "loadSession", 0,
          [p](const auto& args) {
            const juce::String path = args.size() > 0 ? args[0].toString() : "";
            // Loads route through the ProjectManager so the opened
            // bundle becomes the CURRENT project (identity, name, mirror
            // target) — a raw engine load would leave the mirror
            // pointed elsewhere.
            return path.isNotEmpty() ? p->openProject(juce::File(path)) : false;
          },
          juce::var(false)),
      // Bounce (Q19, docs/bounce.md): the direct verb takes a path and,
      // optionally, the render's start in absolute samples (the frame
      // zero the view seated, docs/frame.md); absent, the node's top.
      valueMethod(
          "bounce", 2,
          [e](const auto& args) {
            std::optional<int64_t> start;
            if (args.size() > 2 && !args[2].isVoid()) {
              start = (int64_t)(double)args[2];
            }
            return e->bounce(args[0].toString(), args[1].toString(), start);
          },
          false),
      // Import (docs/import.md): a path + the origin in absolute
      // samples (the view computes it from the frame zero it seated;
      // the engine snaps it to the Q grid, Q11).
      valueMethod(
          "importAudio", 3,
          [e](const auto& args) {
            return e->importAudio(args[0].toString(), args[1].toString(),
                                  (int64_t)(double)args[2]);
          },
          false),
      // MIDI lane rendering (docs/vst3.md §11): notes on demand.
      valueMethod(
          "getMidiNotes", 1,
          [e](const auto& args) { return e->getMidiNotes(args[0].toString()); },
          juce::var(juce::Array<juce::var>())),
      // Projects (docs/projects.md)
      valueMethod("getProjectInfo", 0,
                  [p](const auto&) {
                    auto* o = new juce::DynamicObject();
                    o->setProperty("id", p->id());
                    o->setProperty("name", p->displayName());
                    o->setProperty("born", p->born());
                    // The library folders (the preferences panel): the
                    // projects root and the track-template library.
                    o->setProperty("projectsRoot",
                                   p->projectsRoot().getFullPathName());
                    o->setProperty("trackTemplatesRoot",
                                   p->trackTemplatesRoot().getFullPathName());
                    return juce::JSON::toString(juce::var(o), true);
                  }),
      valueMethod(
          "setProjectsRoot", 1,
          [p](const auto& args) { return p->setBase(juce::File(args[0].toString())); },
          false),
      voidMethod("renameProject", 0,
                 [p](const auto& args) {
                   p->rename(args.size() > 0 ? args[0].toString() : "");
                 }),
      valueMethod("saveProjectNow", 0, [p](const auto&) { return p->saveNow(); }),
      valueMethod("listTemplates", 0,
                  [p](const auto&) { return projectInfosToJson(p->listTemplates()); }),
      valueMethod("listRecentProjects", 0,
                  [p](const auto&) { return projectInfosToJson(p->listRecents(10)); }),
      valueMethod("newProjectFromTemplate", 0,
                  [p](const auto& args) {
                    return p->newFromTemplate(args.size() > 0 ? args[0].toString() : "");
                  }),
      valueMethod("openProjectPath", 0,
                  [p](const auto& args) {
                    return p->openProject(
                        juce::File(args.size() > 0 ? args[0].toString() : ""));
                  }),
      valueMethod("saveAsTemplate", 0,
                  [p](const auto& args) {
                    return p->saveAsTemplate(args.size() > 0 ? args[0].toString() : "");
                  }),
      valueMethod("duplicateProject", 0,
                  [p](const auto&) {
                    const auto dest = p->duplicateProject();
                    return dest == juce::File() ? juce::String("") : dest.getFileName();
                  }),
      valueMethod("listTrackTemplates", 0,
                  [p](const auto&) {
                    return trackTemplatesToJson(p->listTrackTemplates());
                  }),
      valueMethod("saveTrackTemplate", 2,
                  [p](const auto& args) {
                    // (uuid, name) — Q17 save-from-selection
                    return juce::var(
                        p->saveTrackTemplate(args[1].toString(), args[0].toString()));
                  }),
      valueMethod("createFromTrackTemplate", 1,
                  [p](const auto& args) {
                    return juce::var(p->createFromTrackTemplate(
                        args[0].toString(),
                        args.size() > 1 ? args[1].toString() : juce::String()));
                  }),
      // Inputs and devices
      valueMethod("getInputList", 0, [e](const auto&) { return e->getInputList(); }),
      valueMethod("getAudioDeviceState", 0,
                  [e](const auto&) { return e->getAudioDeviceState(); }),
      valueMethod("setAudioDevice", 0,
                  [e](const auto& args) {
                    // (type, device, sampleRate, bufferSize); trailing
                    // args are optional — 0 means "keep the device's
                    // preference".
                    const auto type =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    const auto device =
                        args.size() > 1 ? args[1].toString() : juce::String();
                    const double sr = args.size() > 2 ? (double)args[2] : 0.0;
                    const int block = args.size() > 3 ? (int)args[3] : 0;
                    return e->setAudioDevice(type, device, sr, block);
                  }),
      voidMethod("setNodeInput", 2,
                 [e](const auto& args) {
                   e->setNodeInput(args[0].toString(), (int)args[1]);
                 }),
      voidMethod("setNodeInputRight", 2,
                 [e](const auto& args) {
                   e->setNodeInputRight(args[0].toString(), (int)args[1]);
                 }),
      voidMethod("setMidiArmed", 2,
                 [e](const auto& args) {
                   e->setMidiArmed(args[0].toString(), (bool)args[1]);
                 }),
      voidMethod("setMonitor", 2,
                 [e](const auto& args) {
                   e->setMonitor(args[0].toString(), (bool)args[1]);
                 }),
      valueMethod("getMidiInputs", 0, [e](const auto&) { return e->getMidiInputs(); }),
      // Mixer
      voidMethod("setNodePan", 2,
                 [e](const auto& args) {
                   e->setNodePan(args[0].toString(), (double)args[1]);
                 }),
      voidMethod("setNodeGain", 2,
                 [e](const auto& args) {
                   e->setNodeGain(args[0].toString(), (double)args[1]);
                 }),
      voidMethod("toggleSolo", 1, [e](const auto& args) { e->toggleSolo(args[0].toString()); }),
      voidMethod("toggleMute", 1,
                 [e](const auto& args) {
                   if (args[0].isString())
                     e->toggleMute(args[0].toString());
                   else if (auto* obj = args[0].getDynamicObject())
                     e->toggleMute(obj->getProperty("uuid").toString());
                 }),
      voidMethod("setPeriodSource", 2,
                 [e](const auto& args) {
                   e->setPeriodSource(args[0].toString(),
                                      args[1].toString() == "context"
                                          ? PeriodSource::CONTEXT_CYCLE
                                          : PeriodSource::OWN_LENGTH);
                 }),
      // Effects and plugins
      voidMethod("setSlotEnabled", 3,
                 [e](const auto& args) {
                   e->setSlotEnabled(args[0].toString(), args[1].toString(),
                                     (bool)args[2]);
                 }),
      voidMethod("setSlotParam", 4,
                 [e](const auto& args) {
                   e->setSlotParam(args[0].toString(), args[1].toString(),
                                   args[2].toString(), (double)args[3]);
                 }),
      voidMethod("moveChainSlot", 3,
                 [e](const auto& args) {
                   e->moveChainSlot(args[0].toString(), args[1].toString(),
                                    (int)args[2]);
                 }),
      voidMethod("addPluginToChain", 2,
                 [s](const auto& args) {
                   addPluginToChain(s, args[0].toString(), args[1].toString(),
                                    args.size() > 2 ? (int)args[2] : -1);
                 }),
      // The app shell overrides this one to close the slot's editor
      // window first.
      voidMethod("removeChainSlot", 2,
                 [e](const auto& args) {
                   e->removeChainSlot(args[0].toString(), args[1].toString());
                 }),
      voidMethod("setEffectScope", 2,
                 [e](const auto& args) {
                   e->setEffectScope(args[0].toString(), (bool)args[1]);
                 }),
      valueMethod("getKnownPlugins", 0, [h](const auto&) { return h->getKnownPluginsVar(); }),
      voidMethod("scanPlugins", 0,
                 [h](const auto& args) {
                   h->startScan(args.size() > 0 ? args[0].toString() : juce::String());
                 }),
      valueMethod("getPluginScanStatus", 0,
                  [h](const auto&) { return h->getScanStatusVar(); }),
      // Time maps and the sequencer
      // Both map verbs take an optional trailing `live` (a mid-gesture
      // update that coalesces into the gesture's undo entry).
      voidMethod("setLoopPoints", 3,
                 [e](const auto& args) {
                   e->setLoopPoints(args[0].toString(), (juce::int64)args[1],
                                    (juce::int64)args[2],
                                    args.size() > 3 && (bool)args[3]);
                 }),
      voidMethod("setSegments", 2,
                 [e](const auto& args) {
                   // args[1] = flat [s0, e0, s1, e1, ...] in samples
                   // (time_maps.md phase 3).
                   timing::TimeMap m;
                   if (auto* flat = args[1].getArray()) {
                     for (int i = 0; i + 1 < flat->size() &&
                                     m.n < timing::TimeMap::kMaxSegments;
                          i += 2) {
                       m.segs[m.n++] = {(int64_t)(double)(*flat)[i],
                                        (int64_t)(double)(*flat)[i + 1]};
                     }
                   }
                   e->setSegments(args[0].toString(), m,
                                  args.size() > 2 && (bool)args[2]);
                 }),
      // The re-time (loop_selection.md §9): (uuid, shiftSamples,
      // topSamples?, live?). A top that is not a finite number ≥ 0
      // (null, absent) means "no new top"; a non-finite shift is
      // refused. Samples round to the nearest.
      voidMethod("setTiming", 2,
                 [e](const auto& args) {
                   const double shift = (double)args[1];
                   if (!std::isfinite(shift)) {
                     juce::Logger::writeToLog(
                         "setTiming refused - the shift is not a number");
                     return;
                   }
                   std::optional<int64_t> top;
                   if (args.size() > 2 &&
                       (args[2].isDouble() || args[2].isInt() ||
                        args[2].isInt64())) {
                     const double t = (double)args[2];
                     if (std::isfinite(t) && t >= 0) top = std::llround(t);
                   }
                   e->setTiming(args[0].toString(), std::llround(shift), top,
                                args.size() > 3 && (bool)args[3]);
                 }),
      // The Q hand-off (Q22): (uuid) — that node becomes the island's
      // Q-definer.
      voidMethod("setDefiner", 1,
                 [e](const auto& args) { e->setDefiner(args[0].toString()); }),
      voidMethod("toggleLoopWindow", 1,
                 [e](const auto& args) { e->toggleLoopWindow(args[0].toString()); }),
      voidMethod("setSequence", 2,
                 [e](const auto& args) {
                   // args[1] = {steps: [{name, len}], gates: {uuid:
                   // [0/1...]}} (docs/sequencer.md); void/empty clears.
                   // args[2] (optional) = the frame zero the view has
                   // seated, absolute samples — the root anchors its
                   // song there (docs/frame.md §4).
                   std::optional<int64_t> zero;
                   if (args.size() > 2 && !args[2].isVoid()) {
                     zero = (int64_t)(double)args[2];
                   }
                   e->setSequence(args[0].toString(), args[1], zero);
                 }),
      voidMethod("toggleSequence", 1,
                 [e](const auto& args) { e->toggleSequence(args[0].toString()); }),
      voidMethod("auditionStep", 2,
                 [e](const auto& args) {
                   // args[1] = step index, −1 = stop looping.
                   e->auditionStep(args[0].toString(), (int)args[1]);
                 }),
      // Latency
      voidMethod("startLatencyCalibration", 0,
                 [e](const auto&) { e->startLatencyCalibration(); }),
      valueMethod("getLatencyCalibration", 0,
                  [e](const auto&) { return e->getLatencyCalibration(); }),
      // Logging — relaying the JS payload IS this function's job, so it
      // stays in release builds.
      voidMethod("nativeLog", 1,
                 [](const auto& args) {
                   juce::Logger::writeToLog("[JS] " + args[0].toString());
                 }),
  };
}

}  // namespace celestrian::bridge
