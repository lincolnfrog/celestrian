#include "main_component.h"

#include <juce_core/juce_core.h>

#include <cstddef>
#include <cstring>
#include <vector>

namespace {
juce::String projectInfosToJson(
    const std::vector<celestrian::ProjectManager::Info>& infos) {
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
    const std::vector<celestrian::ProjectManager::TrackTemplateInfo>& infos) {
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

// ---------------------------------------------------------------------------
// WebView bridge adapters.
//
// The Three-Layer Handshake (.agent/style.md) still applies: every
// UI-triggered feature needs (1) the C++ logic, (2) a registration below via
// withNativeFunction, and (3) a JS callNative(...) call. New registrations
// should go through voidCall/valueCall so they inherit the arity guard and
// the DEBUG-only invocation trace. Only genuinely multi-branch or async
// handlers (e.g. saveSession/loadSession, which hand the completion to an
// async file chooser) stay hand-written — those call logBridgeCall
// themselves.
// ---------------------------------------------------------------------------

// Traces a bridge invocation, DEBUG builds only — per-call logging in
// release builds is log spam (owner ruling). In release this compiles to
// nothing. Functional logging (e.g. nativeLog's payload) is separate and
// stays in all builds.
//
// The POLLS are exempt even in DEBUG (owner report 2026-08-13): the
// 50ms graph poll and the 2s project poll are the UI's heartbeat, not
// events — tracing them buries every real bridge call under
// "bridge: getGraphState" spam. Event-shaped calls all still trace.
void logBridgeCall(const char* name) {
#if JUCE_DEBUG
  const juce::String n(name);
  if (n == "getGraphState" || n == "getProjectInfo") return;
  juce::Logger::writeToLog("bridge: " + n);
#else
  juce::ignoreUnused(name);
#endif
}

// Wraps `fn` in a native-function handler that traces the call, runs
// fn(args) only when at least `min_args` arguments arrived (the old
// hand-written guard `args.size() > N` means min_args = N + 1), and always
// completes with true.
template <typename Fn>
auto voidCall(const char* name, int min_args, Fn fn) {
  return [name, min_args, fn = std::move(fn)](
             const juce::Array<juce::var>& args,
             juce::WebBrowserComponent::NativeFunctionCompletion completion) {
    logBridgeCall(name);
    if (args.size() >= min_args) fn(args);
    completion(true);
  };
}

// Same as voidCall, but completes with fn(args)'s return value; when fewer
// than `min_args` arguments arrived it completes with `missing_args_result`
// instead (each call site preserves its historical fallback value).
template <typename Fn>
auto valueCall(const char* name, int min_args, Fn fn,
               juce::var missing_args_result = juce::var()) {
  return [name, min_args, fn = std::move(fn),
          missing_args_result = std::move(missing_args_result)](
             const juce::Array<juce::var>& args,
             juce::WebBrowserComponent::NativeFunctionCompletion completion) {
    logBridgeCall(name);
    if (args.size() >= min_args)
      completion(fn(args));
    else
      completion(missing_args_result);
  };
}
}  // namespace

MainComponent::MainComponent()
    : web_browser(
          juce::WebBrowserComponent::Options{}
              .withNativeIntegrationEnabled()
#if JUCE_WINDOWS
              // On Windows JUCE's default backend is Internet Explorer, which
              // ignores the resource provider entirely (the UI would never
              // load). WebView2 has to be opted into explicitly.
              .withBackend(
                  juce::WebBrowserComponent::Options::Backend::webview2)
              .withWinWebView2Options(
                  juce::WebBrowserComponent::Options::WinWebView2{})
#endif
              .withResourceProvider(
                  [this](const juce::String& path)
                      -> std::optional<juce::WebBrowserComponent::Resource> {
                    return getResource(path);
                  })
              .withNativeFunction(
                  "ping",
                  valueCall("ping", 0, [](const auto&) { return "pong"; }))
              .withNativeFunction("togglePlayback",
                                  voidCall("togglePlayback", 0,
                                           [this](const auto&) {
                                             audio_engine.togglePlayback();
                                           }))
              .withNativeFunction("startRecordingInNode",
                                  voidCall("startRecordingInNode", 1,
                                           [this](const auto& args) {
                                             audio_engine.startRecordingInNode(
                                                 args[0].toString());
                                           }))
              .withNativeFunction("stopRecordingInNode",
                                  voidCall("stopRecordingInNode", 1,
                                           [this](const auto& args) {
                                             audio_engine.stopRecordingInNode(
                                                 args[0].toString());
                                           }))
              .withNativeFunction(
                  "getGraphState",
                  valueCall("getGraphState", 0,
                            [this](const auto&) {
                              return audio_engine.getGraphState();
                            }))
              .withNativeFunction("getWaveform",
                                  valueCall(
                                      "getWaveform", 2,
                                      [this](const auto& args) {
                                        return audio_engine.getWaveform(
                                            args[0].toString(), (int)args[1]);
                                      },
                                      juce::var(juce::Array<juce::var>())))
              .withNativeFunction("toggleStackExpand",
                                  voidCall("toggleStackExpand", 1,
                                           [this](const auto& args) {
                                             audio_engine.toggleStackExpand(
                                                 args[0].toString());
                                           }))
              .withNativeFunction(
                  "createNode",
                  voidCall("createNode", 1,
                           [this](const auto& args) {
                             if (args.size() > 1) {
                               // type, parent_uuid
                               audio_engine.createNode(args[0].toString(),
                                                       args[1].toString());
                             } else {
                               // type only
                               audio_engine.createNode(args[0].toString());
                             }
                           }))
              .withNativeFunction("deleteNode",
                                  voidCall("deleteNode", 1,
                                           [this](const auto& args) {
                                             audio_engine.deleteNode(
                                                 args[0].toString());
                                           }))
              .withNativeFunction("undo", voidCall("undo", 0,
                                                   [this](const auto&) {
                                                     audio_engine.undo();
                                                   }))
              .withNativeFunction(
                  "saveSession",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    logBridgeCall("saveSession");
                    juce::String path =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    if (path.isNotEmpty()) {
                      completion(audio_engine.saveSession(path));
                      return;
                    }
                    // Empty path: pick a bundle directory to create.
                    chooseSessionPath(ChooserMode::SAVE, std::move(completion));
                  })
              .withNativeFunction(
                  "loadSession",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    logBridgeCall("loadSession");
                    juce::String path =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    if (path.isNotEmpty()) {
                      completion(audio_engine.loadSession(path));
                      return;
                    }
                    chooseSessionPath(ChooserMode::OPEN, std::move(completion));
                  })
              .withNativeFunction(
                  "getProjectInfo",
                  valueCall("getProjectInfo", 0,
                            [this](const auto&) {
                              auto* o = new juce::DynamicObject();
                              o->setProperty("id", project_manager_.id());
                              o->setProperty("name",
                                             project_manager_.displayName());
                              o->setProperty("born", project_manager_.born());
                              return juce::JSON::toString(juce::var(o), true);
                            }))
              .withNativeFunction(
                  "renameProject",
                  voidCall("renameProject", 0,
                           [this](const auto& args) {
                             project_manager_.rename(
                                 args.size() > 0 ? args[0].toString() : "");
                           }))
              .withNativeFunction("saveProjectNow",
                                  valueCall("saveProjectNow", 0,
                                            [this](const auto&) {
                                              return project_manager_.saveNow();
                                            }))
              .withNativeFunction(
                  "listTemplates",
                  valueCall("listTemplates", 0,
                            [this](const auto&) {
                              return projectInfosToJson(
                                  project_manager_.listTemplates());
                            }))
              .withNativeFunction(
                  "listRecentProjects",
                  valueCall("listRecentProjects", 0,
                            [this](const auto&) {
                              return projectInfosToJson(
                                  project_manager_.listRecents(10));
                            }))
              .withNativeFunction(
                  "newProjectFromTemplate",
                  valueCall("newProjectFromTemplate", 0,
                            [this](const auto& args) {
                              return project_manager_.newFromTemplate(
                                  args.size() > 0 ? args[0].toString() : "");
                            }))
              .withNativeFunction(
                  "openProjectPath",
                  valueCall("openProjectPath", 0,
                            [this](const auto& args) {
                              return project_manager_.openProject(juce::File(
                                  args.size() > 0 ? args[0].toString() : ""));
                            }))
              .withNativeFunction(
                  "saveAsTemplate",
                  valueCall("saveAsTemplate", 0,
                            [this](const auto& args) {
                              return project_manager_.saveAsTemplate(
                                  args.size() > 0 ? args[0].toString() : "");
                            }))
              .withNativeFunction(
                  "duplicateProject",
                  valueCall("duplicateProject", 0,
                            [this](const auto&) {
                              const auto dest =
                                  project_manager_.duplicateProject();
                              return dest == juce::File() ? juce::String("")
                                                          : dest.getFileName();
                            }))
              .withNativeFunction("redo", voidCall("redo", 0,
                                                   [this](const auto&) {
                                                     audio_engine.redo();
                                                   }))
              .withNativeFunction("renameNode",
                                  voidCall("renameNode", 2,
                                           [this](const auto& args) {
                                             audio_engine.renameNode(
                                                 args[0].toString(),
                                                 args[1].toString());
                                           }))
              .withNativeFunction("reorderNode",
                                  voidCall("reorderNode", 3,
                                           [this](const auto& args) {
                                             audio_engine.reorderNode(
                                                 args[0].toString(),
                                                 args[1].toString(),
                                                 (int)args[2]);
                                           }))
              .withNativeFunction("combineNodes",
                                  valueCall(
                                      "combineNodes", 2,
                                      [this](const auto& args) {
                                        return audio_engine.combineNodes(
                                            args[0].toString(),
                                            args[1].toString());
                                      },
                                      juce::var(juce::String())))
              .withNativeFunction("setNodePosition",
                                  voidCall("setNodePosition", 3,
                                           [this](const auto& args) {
                                             audio_engine.setNodePosition(
                                                 args[0].toString(),
                                                 (double)args[1],
                                                 (double)args[2]);
                                           }))
              .withNativeFunction(
                  "getInputList",
                  valueCall("getInputList", 0,
                            [this](const auto&) {
                              return audio_engine.getInputList();
                            }))
              // Plugin hosting (docs/vst3.md phase 1): the known-plugin
              // registry + background scan. The UI polls scan status
              // while its panel is open (same poll-shaped pattern as
              // the device panel).
              .withNativeFunction(
                  "getKnownPlugins",
                  valueCall("getKnownPlugins", 0,
                            [this](const auto&) {
                              return plugin_host_.getKnownPluginsVar();
                            }))
              .withNativeFunction(
                  "scanPlugins",
                  voidCall("scanPlugins", 0,
                           [this](const auto& args) {
                             plugin_host_.startScan(args.size() > 0
                                                        ? args[0].toString()
                                                        : juce::String());
                           }))
              .withNativeFunction(
                  "getPluginScanStatus",
                  valueCall("getPluginScanStatus", 0,
                            [this](const auto&) {
                              return plugin_host_.getScanStatusVar();
                            }))
              .withNativeFunction(
                  "getAudioDeviceState",
                  valueCall("getAudioDeviceState", 0,
                            [this](const auto&) {
                              return audio_engine.getAudioDeviceState();
                            }))
              .withNativeFunction(
                  "setAudioDevice",
                  valueCall("setAudioDevice", 0,
                            [this](const auto& args) {
                              // (type, device, sampleRate, bufferSize);
                              // trailing args are optional — 0 means "keep the
                              // device's preference".
                              const auto type = args.size() > 0
                                                    ? args[0].toString()
                                                    : juce::String();
                              const auto device = args.size() > 1
                                                      ? args[1].toString()
                                                      : juce::String();
                              const double sr =
                                  args.size() > 2 ? (double)args[2] : 0.0;
                              const int block =
                                  args.size() > 3 ? (int)args[3] : 0;
                              return audio_engine.setAudioDevice(type, device,
                                                                 sr, block);
                            }))
              .withNativeFunction("setNodeInput",
                                  voidCall("setNodeInput", 2,
                                           [this](const auto& args) {
                                             audio_engine.setNodeInput(
                                                 args[0].toString(),
                                                 (int)args[1]);
                                           }))
              .withNativeFunction("setNodeInputRight",
                                  voidCall("setNodeInputRight", 2,
                                           [this](const auto& args) {
                                             audio_engine.setNodeInputRight(
                                                 args[0].toString(),
                                                 (int)args[1]);
                                           }))
              .withNativeFunction("setNodePan",
                                  voidCall("setNodePan", 2,
                                           [this](const auto& args) {
                                             audio_engine.setNodePan(
                                                 args[0].toString(),
                                                 (double)args[1]);
                                           }))
              .withNativeFunction("setNodeGain",
                                  voidCall("setNodeGain", 2,
                                           [this](const auto& args) {
                                             audio_engine.setNodeGain(
                                                 args[0].toString(),
                                                 (double)args[1]);
                                           }))
              .withNativeFunction(
                  "setPeriodSource",
                  voidCall("setPeriodSource", 2,
                           [this](const auto& args) {
                             audio_engine.setPeriodSource(
                                 args[0].toString(),
                                 args[1].toString() == "context"
                                     ? celestrian::PeriodSource::CONTEXT_CYCLE
                                     : celestrian::PeriodSource::OWN_LENGTH);
                           }))
              .withNativeFunction("setSlotEnabled",
                                  voidCall("setSlotEnabled", 3,
                                           [this](const auto& args) {
                                             audio_engine.setSlotEnabled(
                                                 args[0].toString(),
                                                 args[1].toString(),
                                                 (bool)args[2]);
                                           }))
              .withNativeFunction(
                  "setSlotParam",
                  voidCall("setSlotParam", 4,
                           [this](const auto& args) {
                             audio_engine.setSlotParam(
                                 args[0].toString(), args[1].toString(),
                                 args[2].toString(), (double)args[3]);
                           }))
              .withNativeFunction(
                  "moveChainSlot",
                  voidCall("moveChainSlot", 3,
                           [this](const auto& args) {
                             audio_engine.moveChainSlot(args[0].toString(),
                                                        args[1].toString(),
                                                        (int)args[2]);
                           }))
              .withNativeFunction(
                  "addPluginToChain",
                  voidCall("addPluginToChain", 2,
                           [this](const auto& args) {
                             addPluginToChain(
                                 args[0].toString(), args[1].toString(),
                                 args.size() > 2 ? (int)args[2] : -1);
                           }))
              .withNativeFunction(
                  "removeChainSlot",
                  voidCall("removeChainSlot", 2,
                           [this](const auto& args) {
                             // Close-before-removal: never show an
                             // editor for a slot the user just deleted.
                             plugin_editor_windows_.closeFor(
                                 args[1].toString());
                             audio_engine.removeChainSlot(args[0].toString(),
                                                          args[1].toString());
                           }))
              .withNativeFunction("setMidiArmed",
                                  voidCall("setMidiArmed", 2,
                                           [this](const auto& args) {
                                             audio_engine.setMidiArmed(
                                                 args[0].toString(),
                                                 (bool)args[1]);
                                           }))
              .withNativeFunction(
                  "getMidiInputs",
                  valueCall("getMidiInputs", 0,
                            [this](const auto&) {
                              return audio_engine.getMidiInputs();
                            }))
              .withNativeFunction(
                  "openPluginEditor",
                  voidCall("openPluginEditor", 2,
                           [this](const auto& args) {
                             auto* slot = audio_engine.vst3SlotFor(
                                 args[0].toString(), args[1].toString());
                             if (slot != nullptr && slot->instance() != nullptr)
                               plugin_editor_windows_.open(args[1].toString(),
                                                           *slot->instance());
                           }))
              .withNativeFunction("setEffectScope",
                                  voidCall("setEffectScope", 2,
                                           [this](const auto& args) {
                                             audio_engine.setEffectScope(
                                                 args[0].toString(),
                                                 (bool)args[1]);
                                           }))
              .withNativeFunction("setLoopPoints",
                                  voidCall("setLoopPoints", 3,
                                           [this](const auto& args) {
                                             audio_engine.setLoopPoints(
                                                 args[0].toString(),
                                                 (juce::int64)args[1],
                                                 (juce::int64)args[2]);
                                           }))
              .withNativeFunction(
                  "setSegments",
                  voidCall("setSegments", 2,
                           [this](const auto& args) {
                             // args[1] = flat [s0, e0, s1, e1, ...] in samples
                             // (time_maps.md phase 3).
                             celestrian::timing::TimeMap m;
                             if (auto* flat = args[1].getArray()) {
                               for (int i = 0; i + 1 < flat->size() &&
                                               m.n < celestrian::timing::
                                                         TimeMap::kMaxSegments;
                                    i += 2) {
                                 m.segs[m.n++] = {
                                     (int64_t)(double)(*flat)[i],
                                     (int64_t)(double)(*flat)[i + 1]};
                               }
                             }
                             audio_engine.setSegments(args[0].toString(), m);
                           }))
              .withNativeFunction("warpPointer",
                                  valueCall(
                                      "warpPointer", 2,
                                      [this](const auto& args) {
                                        // Move the OS cursor to a
                                        // webview-viewport position (CSS px ==
                                        // JUCE points at default zoom). The
                                        // expanded map drag warps the pointer
                                        // ONTO the handle it grabbed once the
                                        // raw view has opened — pointer and
                                        // geometry stay 1:1, no easing (the
                                        // heard→raw reflow otherwise strands
                                        // the handle away from the mouse; field
                                        // 2026-07-25d).
                                        const auto global =
                                            web_browser.localPointToGlobal(
                                                juce::Point<float>(
                                                    (float)(double)args[0],
                                                    (float)(double)args[1]));
                                        juce::Desktop::setMousePosition(
                                            global.roundToInt());
                                        return true;
                                      },
                                      juce::var(false)))
              // (togglePlay deleted with Q16: per-node Play/Stop is
              // superseded — mute/solo + the one transport are the
              // per-node play controls.)
              .withNativeFunction(
                  "listTrackTemplates",
                  valueCall("listTrackTemplates", 0,
                            [this](const auto&) {
                              return trackTemplatesToJson(
                                  project_manager_.listTrackTemplates());
                            }))
              .withNativeFunction(
                  "saveTrackTemplate",
                  valueCall("saveTrackTemplate", 2,
                            [this](const auto& args) {
                              // (uuid, name) — Q17 save-from-selection
                              return juce::var(
                                  project_manager_.saveTrackTemplate(
                                      args[1].toString(),
                                      args[0].toString()));
                            }))
              .withNativeFunction(
                  "createFromTrackTemplate",
                  valueCall("createFromTrackTemplate", 1,
                            [this](const auto& args) {
                              return juce::var(
                                  project_manager_.createFromTrackTemplate(
                                      args[0].toString(),
                                      args.size() > 1 ? args[1].toString()
                                                      : juce::String()));
                            }))
              .withNativeFunction("toggleSolo",
                                  voidCall("toggleSolo", 1,
                                           [this](const auto& args) {
                                             audio_engine.toggleSolo(
                                                 args[0].toString());
                                           }))
              .withNativeFunction(
                  "toggleMute",
                  voidCall("toggleMute", 1,
                           [this](const auto& args) {
                             if (args[0].isString())
                               audio_engine.toggleMute(args[0].toString());
                             else if (auto* obj = args[0].getDynamicObject())
                               audio_engine.toggleMute(
                                   obj->getProperty("uuid").toString());
                           }))
              .withNativeFunction("toggleLoopWindow",
                                  voidCall("toggleLoopWindow", 1,
                                           [this](const auto& args) {
                                             audio_engine.toggleLoopWindow(
                                                 args[0].toString());
                                           }))
              .withNativeFunction(
                  "setSequence",
                  voidCall("setSequence", 2,
                           [this](const auto& args) {
                             // args[1] = {steps: [{name, len}], gates:
                             // {uuid: [0/1...]}} (docs/sequencer.md);
                             // void/empty clears.
                             audio_engine.setSequence(args[0].toString(),
                                                      args[1]);
                           }))
              .withNativeFunction("toggleSequence",
                                  voidCall("toggleSequence", 1,
                                           [this](const auto& args) {
                                             audio_engine.toggleSequence(
                                                 args[0].toString());
                                           }))
              .withNativeFunction(
                  "startLatencyCalibration",
                  voidCall("startLatencyCalibration", 0,
                           [this](const auto&) {
                             audio_engine.startLatencyCalibration();
                           }))
              .withNativeFunction(
                  "getLatencyCalibration",
                  valueCall("getLatencyCalibration", 0,
                            [this](const auto&) {
                              return audio_engine.getLatencyCalibration();
                            }))
              .withNativeFunction("nativeLog",
                                  voidCall("nativeLog", 1,
                                           [](const auto& args) {
                                             // Functional logging — relaying
                                             // the JS payload IS this
                                             // function's job, so it stays in
                                             // release builds (the debug-only
                                             // rule covers only the invocation
                                             // trace).
                                             juce::Logger::writeToLog(
                                                 "[JS] " + args[0].toString());
                                           }))
              .withNativeFunction(
                  "dumpStateToFile",
                  voidCall("dumpStateToFile", 1, [](const auto& args) {
                    auto stateFile =
                        juce::File::getCurrentWorkingDirectory().getChildFile(
                            "celestrian_state.json");
                    stateFile.replaceWithText(args[0].toString());
                    // Functional logging (kept in release): records where
                    // the state landed.
                    juce::Logger::writeToLog("State dumped to: " +
                                             stateFile.getFullPathName());
                  }))) {
  audio_engine.initialiseAudioDevice();
  // Boot EMPTY (Q17, ruled 2026-08-13 — the launch ritual is retired):
  // the creation menu is the instrument path (+ → Guitar → ●), and `R`
  // on an empty project creates + arms the default track, so the spark
  // still costs one gesture. Session templates load on explicit request
  // via the project menu.

  addAndMakeVisible(web_browser);

  web_browser.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

  setSize(800, 600);

  // Project heartbeat (docs/projects.md): birth + mirror every 3 s.
  startTimer(3000);

  // Live MIDI (docs/vst3.md §8): open every keyboard now and on the
  // heartbeat below (hot-plug pickup) — the engine never touches MIDI
  // devices on its own, so headless tests stay device-free.
  audio_engine.refreshMidiInputs();

  // Plugin revival (docs/vst3.md §6): after ANY successful session load
  // (bridge, chooser, project manager), instantiate every placeholder
  // slot whose plugin is installed on this machine. Editor windows for
  // slots from the PREVIOUS graph close first — their instances are
  // about to be torn down with the old graph.
  audio_engine.setOnSessionLoaded([this] {
    plugin_editor_windows_.closeAll();
    revivePlaceholderPlugins();
  });
}

MainComponent::~MainComponent() {
  // Editors reference plugin instances owned by the engine's graph —
  // close them before member destruction order gets there.
  plugin_editor_windows_.closeAll();
}

void MainComponent::addPluginToChain(const juce::String& node_uuid,
                                     const juce::String& plugin_uid,
                                     int index) {
  const auto types = plugin_host_.knownPlugins().getTypes();
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
  // Async instantiation (docs/vst3.md §4): the completion lambda runs
  // on the MESSAGE thread; the engine preps + publishes + records the
  // undoable AddSlot. A node deleted mid-flight no-ops in the engine.
  // Identity comes from the REGISTRY description (captured by value) —
  // a description refilled from a hosted instance drops the format
  // tag, and the uid must match what the known list will report at
  // revival time (pinned by plugin_host_integration_tests.cc).
  const juce::PluginDescription description = *found;
  plugin_host_.formats().createPluginInstanceAsync(
      description, audio_engine.currentSampleRateOrFallback(),
      celestrian::dsp::Vst3Slot::kMaxBlockSize,
      [this, node_uuid, index, description](
          std::unique_ptr<juce::AudioPluginInstance> instance,
          const juce::String& error) {
        if (instance == nullptr) {
          juce::Logger::writeToLog("addPluginToChain: instantiation failed: " +
                                   error);
          return;
        }
        auto slot = std::make_shared<celestrian::dsp::Vst3Slot>(
            std::move(instance), description.createIdentifierString(),
            description.name, description.fileOrIdentifier,
            description.isInstrument);
        audio_engine.addVst3SlotToChain(node_uuid, std::move(slot), index);
      });
}

void MainComponent::revivePlaceholderPlugins() {
  // Discovery pass first (the visit mutates no chains), then the async
  // instantiations; each completion swaps its live twin in.
  struct Pending {
    juce::String node_uuid, slot_uuid, plugin_uid;
  };
  std::vector<Pending> pending;
  audio_engine.forEachVst3Placeholder(
      [&pending](const juce::String& node_uuid, const juce::String& slot_uuid,
                 const juce::String& plugin_uid) {
        pending.push_back({node_uuid, slot_uuid, plugin_uid});
      });
  const auto types = plugin_host_.knownPlugins().getTypes();
  for (const auto& p : pending) {
    const juce::PluginDescription* found = nullptr;
    for (const auto& type : types) {
      if (type.createIdentifierString() == p.plugin_uid) {
        found = &type;
        break;
      }
    }
    if (found == nullptr) continue;  // not installed here: stays missing
    plugin_host_.formats().createPluginInstanceAsync(
        *found, audio_engine.currentSampleRateOrFallback(),
        celestrian::dsp::Vst3Slot::kMaxBlockSize,
        [this, p](std::unique_ptr<juce::AudioPluginInstance> instance,
                  const juce::String& error) {
          if (instance == nullptr) {
            juce::Logger::writeToLog("revive: instantiation failed: " + error);
            return;
          }
          audio_engine.reviveVst3Slot(p.node_uuid, p.slot_uuid,
                                      std::move(instance));
        });
  }
}

void MainComponent::chooseSessionPath(
    ChooserMode mode,
    juce::WebBrowserComponent::NativeFunctionCompletion done) {
  const bool saving = mode == ChooserMode::SAVE;
  auto start =
      juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
          .getChildFile("Celestrian Sessions");
  const auto title =
      saving ? juce::String("Save session as…") : juce::String("Open session");
  session_chooser_ = std::make_unique<juce::FileChooser>(title, start);

  const int flags = juce::FileBrowserComponent::canSelectDirectories |
                    (saving ? juce::FileBrowserComponent::saveMode
                            : juce::FileBrowserComponent::openMode);

  session_chooser_->launchAsync(
      flags, [this, saving,
              done = std::move(done)](const juce::FileChooser& fc) mutable {
        const auto file = fc.getResult();
        if (file == juce::File()) {
          done(false);  // cancelled
          return;
        }
        // Loads route through the ProjectManager so the opened bundle
        // becomes the CURRENT project (identity, name, mirror target) —
        // a raw engine load would leave the mirror pointed elsewhere.
        const bool ok = saving
                            ? audio_engine.saveSession(file.getFullPathName())
                            : project_manager_.openProject(file);
        done(ok);
      });
}

void MainComponent::timerCallback() {
  // Hot-plugged MIDI keyboards join on the heartbeat (cheap: enable is
  // an idempotent per-device check).
  audio_engine.refreshMidiInputs();
  // Project heartbeat (docs/projects.md): births the project at the
  // first committed take, then keeps the folder mirroring the session.
  project_manager_.tick();
}
void MainComponent::paint(juce::Graphics& g) {
  g.fillAll(
      getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
}
void MainComponent::resized() { web_browser.setBounds(getLocalBounds()); }

std::optional<juce::WebBrowserComponent::Resource> MainComponent::getResource(
    const juce::String& path) {
  juce::String cleanPath = path;
  if (cleanPath.startsWith("/")) cleanPath = cleanPath.substring(1);
  if (cleanPath.isEmpty()) cleanPath = "index.html";

  // Find UI directory relative to executable (works for deployed app bundles)
  juce::File execFile =
      juce::File::getSpecialLocation(juce::File::currentExecutableFile);
  juce::File uiDir = execFile.getParentDirectory().getChildFile("ui");

  // Fallback for development: check if ui/ exists next to the source
  if (!uiDir.isDirectory()) {
    uiDir = juce::File::getCurrentWorkingDirectory().getChildFile("ui");
  }

  juce::File file = uiDir.getChildFile(cleanPath);

  if (!file.existsAsFile()) return std::nullopt;

  juce::MemoryBlock mb;
  if (!file.loadFileAsData(mb)) return std::nullopt;

  juce::String mimeType = "text/plain";
  auto ext = file.getFileExtension().toLowerCase();
  if (ext == ".html")
    mimeType = "text/html";
  else if (ext == ".css")
    mimeType = "text/css";
  else if (ext == ".js")
    mimeType = "application/javascript";
  else if (ext == ".png")
    mimeType = "image/png";
  else if (ext == ".svg")
    // Served as text/plain, WKWebView refuses to render an <img> SVG —
    // the brand mark showed as a broken-image icon (field 2026-08-08h).
    mimeType = "image/svg+xml";
  else if (ext == ".ico")
    mimeType = "image/x-icon";
  else if (ext == ".json")
    mimeType = "application/json";

  std::vector<std::byte> data(mb.getSize());
  std::memcpy(data.data(), mb.getData(), mb.getSize());

  return juce::WebBrowserComponent::Resource{std::move(data),
                                             std::move(mimeType)};
}
