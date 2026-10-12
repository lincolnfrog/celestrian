#include "bridge_dispatch.h"

#include <cmath>
#include <vector>

#include "dsp/vst3_slot.h"
#include "timing.h"

namespace celestrian::bridge {

namespace {
/** [{id, name, path}] — a project or a template each. */
juce::var projectInfosVar(const std::vector<ProjectManager::Info>& infos) {
  juce::Array<juce::var> arr;
  for (const auto& i : infos) {
    auto* o = new juce::DynamicObject();
    o->setProperty("id", i.id);
    o->setProperty("name", i.name);
    o->setProperty("path", i.path);
    arr.add(juce::var(o));
  }
  return juce::var(arr);
}

/** [{name, kind, tracks}] — the track-template library. */
juce::var trackTemplatesVar(
    const std::vector<ProjectManager::TrackTemplateInfo>& infos) {
  juce::Array<juce::var> arr;
  for (const auto& i : infos) {
    auto* o = new juce::DynamicObject();
    o->setProperty("name", i.name);
    o->setProperty("kind", i.kind);      // 'clip' | 'group'
    o->setProperty("tracks", i.tracks);  // "Drums · 5 tracks"
    arr.add(juce::var(o));
  }
  return juce::var(arr);
}

/** A registered plugin, instantiated, becomes the engine's undoable
 * AddSlot edit (docs/vst3.md §4); index < 0 appends. Answers once the
 * outcome is known: true when the slot is in the node's chain; false —
 * nothing changed — for a plugin the registry does not hold (at once),
 * one that could not be loaded, and a node deleted before the instance
 * arrived. */
void addPluginToChain(Services s, const juce::String& node_uuid,
                      const juce::String& plugin_uid, int index,
                      Answer answer) {
  AudioEngine* engine = &s.engine;
  const bool known = s.plugins.instantiateAsync(
      plugin_uid, s.engine.currentSampleRateOrFallback(),
      [engine, node_uuid, index, answer](
          std::unique_ptr<juce::AudioPluginInstance> instance,
          const juce::PluginDescription& description) {
        if (instance == nullptr) {
          answer(false);
          return;
        }
        answer(engine->addPluginSlotToChain(
            node_uuid,
            std::make_shared<dsp::Vst3Slot>(
                std::move(instance), description.createIdentifierString(),
                description.name, description.fileOrIdentifier,
                description.isInstrument, description.pluginFormatName),
            index));
      });
  if (!known) {
    juce::Logger::writeToLog("addPluginToChain: unknown plugin uid " +
                             plugin_uid);
    answer(false);
  }
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

void revivePlaceholders(Services s) {
  // Discovery first (the visit must not see a chain change under it),
  // then the instantiations.
  struct Placeholder {
    juce::String node_uuid, slot_uuid, plugin_uid;
  };
  std::vector<Placeholder> placeholders;
  s.engine.forEachVst3Placeholder(
      [&placeholders](const juce::String& node_uuid,
                      const juce::String& slot_uuid,
                      const juce::String& plugin_uid) {
        placeholders.push_back({node_uuid, slot_uuid, plugin_uid});
      });
  AudioEngine* engine = &s.engine;
  for (const auto& p : placeholders) {
    s.plugins.instantiateAsync(
        p.plugin_uid, s.engine.currentSampleRateOrFallback(),
        [engine, p](std::unique_ptr<juce::AudioPluginInstance> instance,
                    const juce::PluginDescription&) {
          engine->reviveVst3Slot(p.node_uuid, p.slot_uuid,
                                 std::move(instance));
        });
  }
}

juce::var findNodeVar(const juce::var& tree, const juce::String& uuid) {
  if (tree.getProperty("id", "").toString() == uuid) return tree;
  if (auto* children = tree.getProperty("nodes", juce::var()).getArray()) {
    for (const auto& child : *children) {
      const juce::var hit = findNodeVar(child, uuid);
      if (!hit.isVoid()) return hit;
    }
  }
  return {};
}

juce::String mimeFor(const juce::File& file) {
  struct Type {
    const char* extension;
    const char* mime;
  };
  // WKWebView will not render an <img> SVG served as text/plain.
  static constexpr Type kTypes[] = {
      {".html", "text/html"},
      {".css", "text/css"},
      {".js", "application/javascript"},
      {".mjs", "application/javascript"},
      {".json", "application/json"},
      {".png", "image/png"},
      {".svg", "image/svg+xml"},
      {".ico", "image/x-icon"},
      {".wav", "audio/wav"},
  };
  const juce::String extension = file.getFileExtension().toLowerCase();
  for (const auto& type : kTypes)
    if (extension == type.extension) return type.mime;
  return "text/plain";
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
      boolMethod("togglePlayback", 0,
                 [e](const auto&) { return e->togglePlayback(); }),
      // Ruler scrub: a phase ADVANCE in samples (the view computes it
      // against the frame zero it seated, docs/frame.md), optionally
      // with the transport reading it was computed against. Answers
      // {advance, clock} — what was applied, and when — so the view
      // keeps its frame facts exact between polls; false when refused
      // (a take is live or armed).
      valueMethod(
          "seekTransport", 1,
          [e](const auto& args) -> juce::var {
            AudioEngine::SeekResult applied;
            if (!e->seekTransport((double)args[0], optSamples(args, 1),
                                  &applied)) {
              return juce::var(false);
            }
            auto* o = new juce::DynamicObject();
            o->setProperty("advance", (double)applied.advance);
            o->setProperty("clock", (double)applied.clock);
            return juce::var(o);
          },
          juce::var(false)),
      // Recording
      boolMethod("startRecordingInNode", 1,
                 [e](const auto& args) {
                   return e->startRecordingInNode(args[0].toString());
                 }),
      boolMethod("stopRecordingInNode", 1,
                 [e](const auto& args) {
                   return e->stopRecordingInNode(args[0].toString());
                 }),
      // State
      valueMethod("getGraphState", 0, [e](const auto&) { return e->getGraphState(); }),
      valueMethod(
          "getWaveform", 2,
          [e](const auto& args) {
            return e->getWaveform(args[0].toString(), (int)args[1]);
          },
          juce::var(juce::Array<juce::var>())),
      // Takes and comping (docs/takes.md).
      boolMethod("newTake", 1,
                 [e](const auto& args) { return e->newTake(args[0].toString()); }),
      boolMethod("selectTake", 2,
                 [e](const auto& args) {
                   return e->selectTake(args[0].toString(), (int)args[1]);
                 }),
      boolMethod("deleteTake", 2,
                 [e](const auto& args) {
                   return e->deleteTake(args[0].toString(), (int)args[1]);
                 }),
      boolMethod("setComp", 2,
                 [e](const auto& args) {
                   // args[1] = [take index per Q cell]
                   std::vector<int> cells;
                   if (auto* arr = args[1].getArray()) {
                     for (const auto& c : *arr) cells.push_back((int)c);
                   }
                   return e->setComp(args[0].toString(), cells);
                 }),
      valueMethod(
          "getTakeWaveform", 3,
          [e](const auto& args) {
            return e->getTakeWaveform(args[0].toString(), (int)args[1], (int)args[2]);
          },
          juce::var(juce::Array<juce::var>())),
      boolMethod("dumpStateToFile", 1,
                 [](const auto& args) {
                   auto stateFile =
                       juce::File::getCurrentWorkingDirectory().getChildFile(
                           "celestrian_state.json");
                   const bool written =
                       stateFile.replaceWithText(args[0].toString());
                   // Functional logging (kept in release): records where
                   // the state landed.
                   juce::Logger::writeToLog(
                       (written ? "State dumped to: " : "State NOT dumped to: ") +
                       stateFile.getFullPathName());
                   return written;
                 }),
      // Graph structure. The two verbs that make a node answer its uuid,
      // "" when refused.
      valueMethod(
          "createNode", 1,
          [e](const auto& args) {
            juce::String created;
            e->createNode(args[0].toString(), strArg(args, 1), &created);
            return created;
          },
          juce::var(juce::String())),
      boolMethod("deleteNode", 1,
                 [e](const auto& args) { return e->deleteNode(args[0].toString()); }),
      boolMethod("renameNode", 2,
                 [e](const auto& args) {
                   return e->renameNode(args[0].toString(), args[1].toString());
                 }),
      boolMethod("reorderNode", 3,
                 [e](const auto& args) {
                   return e->reorderNode(args[0].toString(), args[1].toString(),
                                         (int)args[2]);
                 }),
      valueMethod(
          "combineNodes", 2,
          [e](const auto& args) {
            return e->combineNodes(args[0].toString(), args[1].toString());
          },
          juce::var(juce::String())),
      // Undo / redo
      boolMethod("undo", 0, [e](const auto&) { return e->undo(); }),
      boolMethod("redo", 0, [e](const auto&) { return e->redo(); }),
      // A cancelled drag: (uuid) — the open gesture's step is applied
      // and dropped, and the redo branch it invalidated returns.
      boolMethod("cancelGesture", 1,
                 [e](const auto& args) {
                   return e->cancelGesture(args[0].toString());
                 }),
      // Sessions: the PATH forms. An empty path is the app shell's
      // native chooser (main_component.cc overrides both names); here
      // it is simply refused.
      boolMethod("saveSession", 0,
                 [e](const auto& args) {
                   const juce::String path = strArg(args, 0);
                   return path.isNotEmpty() && e->saveSession(path);
                 }),
      // A load goes through the ProjectManager: the opened bundle
      // becomes the CURRENT project. A raw engine load would leave the
      // mirror writing the loaded session into the previous folder.
      boolMethod("loadSession", 0,
                 [p](const auto& args) {
                   const juce::String path = strArg(args, 0);
                   return path.isNotEmpty() && p->openProject(juce::File(path));
                 }),
      // Bounce (Q19, docs/bounce.md): the direct verb takes a path and,
      // optionally, the render's start in absolute samples (the frame
      // zero the view seated, docs/frame.md); absent, the node's top.
      boolMethod("bounce", 2,
                 [e](const auto& args) {
                   return e->bounce(args[0].toString(), args[1].toString(),
                                    optSamples(args, 2));
                 }),
      // Import (docs/import.md): a path + the origin in absolute
      // samples (the view computes it from the frame zero it seated;
      // the engine snaps it to the Q grid, Q11).
      boolMethod("importAudio", 3,
                 [e](const auto& args) {
                   return e->importAudio(args[0].toString(), args[1].toString(),
                                         (int64_t)(double)args[2]);
                 }),
      // MIDI lane rendering (docs/vst3.md §8.5): notes on demand.
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
                    return juce::var(o);
                  }),
      boolMethod("setProjectsRoot", 1,
                 [p](const auto& args) {
                   return p->setBase(juce::File(args[0].toString()));
                 }),
      voidMethod("renameProject", 0,
                 [p](const auto& args) { p->rename(strArg(args, 0)); }),
      boolMethod("saveProjectNow", 0, [p](const auto&) { return p->saveNow(); }),
      valueMethod("listTemplates", 0,
                  [p](const auto&) { return projectInfosVar(p->listTemplates()); }),
      valueMethod("listRecentProjects", 0,
                  [p](const auto&) { return projectInfosVar(p->listRecents(10)); }),
      boolMethod("newProjectFromTemplate", 0,
                 [p](const auto& args) {
                   return p->newFromTemplate(strArg(args, 0));
                 }),
      boolMethod("openProjectPath", 0,
                 [p](const auto& args) {
                   return p->openProject(juce::File(strArg(args, 0)));
                 }),
      boolMethod("saveAsTemplate", 0,
                 [p](const auto& args) {
                   return p->saveAsTemplate(strArg(args, 0));
                 }),
      valueMethod("duplicateProject", 0,
                  [p](const auto&) {
                    const auto dest = p->duplicateProject();
                    return dest == juce::File() ? juce::String("") : dest.getFileName();
                  }),
      valueMethod("listTrackTemplates", 0,
                  [p](const auto&) {
                    return trackTemplatesVar(p->listTrackTemplates());
                  }),
      boolMethod("saveTrackTemplate", 2,
                 [p](const auto& args) {
                   // (uuid, name) — Q17 save-from-selection
                   return p->saveTrackTemplate(args[1].toString(),
                                               args[0].toString());
                 }),
      boolMethod("createFromTrackTemplate", 1,
                 [p](const auto& args) {
                   return p->createFromTrackTemplate(args[0].toString(),
                                                     strArg(args, 1));
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
                    const double sr = args.size() > 2 ? (double)args[2] : 0.0;
                    const int block = args.size() > 3 ? (int)args[3] : 0;
                    return e->setAudioDevice(strArg(args, 0), strArg(args, 1),
                                             sr, block);
                  }),
      boolMethod("setNodeInput", 2,
                 [e](const auto& args) {
                   return e->setNodeInput(args[0].toString(), (int)args[1]);
                 }),
      boolMethod("setNodeInputRight", 2,
                 [e](const auto& args) {
                   return e->setNodeInputRight(args[0].toString(), (int)args[1]);
                 }),
      voidMethod("setMidiArmed", 2,
                 [e](const auto& args) {
                   e->setMidiArmed(args[0].toString(), (bool)args[1]);
                 }),
      boolMethod("setMonitor", 2,
                 [e](const auto& args) {
                   return e->setMonitor(args[0].toString(), (bool)args[1]);
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
      boolMethod("toggleMute", 1,
                 [e](const auto& args) { return e->toggleMute(args[0].toString()); }),
      boolMethod("setPeriodSource", 2,
                 [e](const auto& args) {
                   return e->setPeriodSource(args[0].toString(),
                                             args[1].toString() == "context"
                                                 ? PeriodSource::CONTEXT_CYCLE
                                                 : PeriodSource::OWN_LENGTH);
                 }),
      // Effects and plugins
      boolMethod("setSlotEnabled", 3,
                 [e](const auto& args) {
                   return e->setSlotEnabled(args[0].toString(),
                                            args[1].toString(), (bool)args[2]);
                 }),
      voidMethod("setSlotParam", 4,
                 [e](const auto& args) {
                   e->setSlotParam(args[0].toString(), args[1].toString(),
                                   args[2].toString(), (double)args[3]);
                 }),
      boolMethod("moveChainSlot", 3,
                 [e](const auto& args) {
                   return e->moveChainSlot(args[0].toString(),
                                           args[1].toString(), (int)args[2]);
                 }),
      // Answers when the plugin's instance has arrived, or could not.
      boolMethod("addPluginToChain", 2,
                 DeferredFn([s](const juce::Array<juce::var>& args,
                                Answer answer) {
                   addPluginToChain(s, args[0].toString(), args[1].toString(),
                                    args.size() > 2 ? (int)args[2] : -1,
                                    std::move(answer));
                 })),
      // The app shell overrides this one to close the slot's editor
      // window first.
      boolMethod("removeChainSlot", 2,
                 [e](const auto& args) {
                   return e->removeChainSlot(args[0].toString(),
                                             args[1].toString());
                 }),
      voidMethod("setEffectScope", 2,
                 [e](const auto& args) {
                   e->setEffectScope(args[0].toString(), (bool)args[1]);
                 }),
      valueMethod("getKnownPlugins", 0, [h](const auto&) { return h->getKnownPluginsVar(); }),
      voidMethod("scanPlugins", 0,
                 [h](const auto& args) { h->startScan(strArg(args, 0)); }),
      valueMethod("getPluginScanStatus", 0,
                  [h](const auto&) { return h->getScanStatusVar(); }),
      // Time maps and the sequencer
      // Both map verbs take an optional trailing `live` (a mid-gesture
      // update that coalesces into the gesture's undo entry).
      boolMethod("setLoopPoints", 3,
                 [e](const auto& args) {
                   return e->setLoopPoints(args[0].toString(),
                                           (juce::int64)args[1],
                                           (juce::int64)args[2],
                                           flagArg(args, 3));
                 }),
      boolMethod("setSegments", 2,
                 [e](const auto& args) {
                   // args[1] = flat [s0, e0, s1, e1, ...] in samples.
                   timing::TimeMap m;
                   if (auto* flat = args[1].getArray()) {
                     for (int i = 0; i + 1 < flat->size() &&
                                     m.n < timing::TimeMap::kMaxSegments;
                          i += 2) {
                       m.segs[m.n++] = {(int64_t)(double)(*flat)[i],
                                        (int64_t)(double)(*flat)[i + 1]};
                     }
                   }
                   return e->setSegments(args[0].toString(), m,
                                         flagArg(args, 2));
                 }),
      // The re-time (loop_selection.md §9): (uuid, shiftSamples,
      // topSamples?, live?). A top that is not a finite number ≥ 0
      // (null, absent) means "no new top"; a non-finite shift is
      // refused. Samples round to the nearest.
      boolMethod("setTiming", 2,
                 [e](const auto& args) {
                   const double shift = (double)args[1];
                   if (!std::isfinite(shift)) {
                     juce::Logger::writeToLog(
                         "setTiming refused - the shift is not a number");
                     return false;
                   }
                   std::optional<int64_t> top;
                   if (args.size() > 2 &&
                       (args[2].isDouble() || args[2].isInt() ||
                        args[2].isInt64())) {
                     const double t = (double)args[2];
                     if (std::isfinite(t) && t >= 0) top = std::llround(t);
                   }
                   return e->setTiming(args[0].toString(), std::llround(shift),
                                       top, flagArg(args, 3));
                 }),
      // The Q hand-off (Q22): (uuid) — that node becomes the island's
      // Q-definer.
      boolMethod("setDefiner", 1,
                 [e](const auto& args) { return e->setDefiner(args[0].toString()); }),
      boolMethod("toggleLoopWindow", 1,
                 [e](const auto& args) {
                   return e->toggleLoopWindow(args[0].toString());
                 }),
      boolMethod("setSequence", 2,
                 [e](const auto& args) {
                   // args[1] = {steps: [{name, len}], gates: {uuid:
                   // [0/1...]}} (docs/sequencer.md); void/empty clears.
                   // args[2] (optional) = the frame zero the view has
                   // seated, absolute samples — the root anchors its
                   // song there (docs/frame.md §4).
                   return e->setSequence(args[0].toString(), args[1],
                                         optSamples(args, 2));
                 }),
      boolMethod("toggleSequence", 1,
                 [e](const auto& args) {
                   return e->toggleSequence(args[0].toString());
                 }),
      boolMethod("auditionStep", 2,
                 [e](const auto& args) {
                   // args[1] = step index, −1 = stop looping.
                   return e->auditionStep(args[0].toString(), (int)args[1]);
                 }),
      // Latency
      boolMethod("startLatencyCalibration", 0,
                 [e](const auto&) { return e->startLatencyCalibration(); }),
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
