#include "main_component.h"

#include <juce_core/juce_core.h>

#include <cmath>
#include <cstddef>
#include <cstring>
#include <utility>
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

/** The published name of node `uuid` in a getGraphState tree (empty
 * when absent) — the bounce dialog's default file name. */
juce::String nodeNameIn(const juce::var& node, const juce::String& uuid) {
  if (node.getProperty("id", "").toString() == uuid)
    return node.getProperty("name", "").toString();
  if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
    for (const auto& kid : *kids) {
      const juce::String hit = nodeNameIn(kid, uuid);
      if (hit.isNotEmpty()) return hit;
    }
  }
  return {};
}

/** A QTime rational from a bridge argument: a [num, den] array, or a
 * bare number taken as whole Qs. */
std::pair<int64_t, int64_t> qtimeArg(const juce::var& v) {
  if (auto* arr = v.getArray(); arr != nullptr && arr->size() >= 2) {
    const int64_t den = (int64_t)(double)(*arr)[1];
    return {(int64_t)(double)(*arr)[0], den == 0 ? 1 : den};
  }
  return {(int64_t)std::llround((double)v), 1};
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
// The Three-Layer Handshake (.agent/style.md) applies: every
// UI-triggered feature needs (1) the C++ logic, (2) a registration below via
// withNativeFunction, and (3) a JS callNative(...) call. New registrations
// should go through voidCall/valueCall so they inherit the arity guard and
// the DEBUG-only invocation trace. Only genuinely multi-branch or async
// handlers (e.g. saveSession/loadSession, which hand the completion to an
// async file chooser) stay hand-written — those call logBridgeCall
// themselves.
// ---------------------------------------------------------------------------

// Traces a bridge invocation, DEBUG builds only — per-call logging in
// release builds is log spam. In release this compiles to nothing.
// Functional logging (e.g. nativeLog's payload) is separate and stays in
// all builds.
//
// The POLLS are exempt even in DEBUG: the 50ms graph poll and the 2s
// project poll are the UI's heartbeat, not events — tracing them buries
// every real bridge call under "bridge: getGraphState" spam.
// Event-shaped calls all trace.
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
// fn(args) only when at least `min_args` arguments arrived, and always
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
// instead.
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
              // Ruler scrub: target in the published-masterPos domain,
              // samples. Returns false when refused (a take is live or
              // armed).
              .withNativeFunction(
                  "seekTransport",
                  valueCall(
                      "seekTransport", 1,
                      [this](const auto& args) {
                        return audio_engine.seekTransport((double)args[0]);
                      },
                      juce::var(false)))
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
              // Takes and comping (docs/takes.md).
              .withNativeFunction("newTake",
                                  voidCall("newTake", 1,
                                           [this](const auto& args) {
                                             audio_engine.newTake(
                                                 args[0].toString());
                                           }))
              .withNativeFunction("selectTake",
                                  voidCall("selectTake", 2,
                                           [this](const auto& args) {
                                             audio_engine.selectTake(
                                                 args[0].toString(),
                                                 (int)args[1]);
                                           }))
              .withNativeFunction("deleteTake",
                                  voidCall("deleteTake", 2,
                                           [this](const auto& args) {
                                             audio_engine.deleteTake(
                                                 args[0].toString(),
                                                 (int)args[1]);
                                           }))
              .withNativeFunction(
                  "setComp",
                  voidCall("setComp", 2,
                           [this](const auto& args) {
                             // args[1] = [take index per Q cell]
                             std::vector<int> cells;
                             if (auto* arr = args[1].getArray()) {
                               for (const auto& c : *arr)
                                 cells.push_back((int)c);
                             }
                             audio_engine.setComp(args[0].toString(), cells);
                           }))
              .withNativeFunction(
                  "getTakeWaveform",
                  valueCall(
                      "getTakeWaveform", 3,
                      [this](const auto& args) {
                        return audio_engine.getTakeWaveform(
                            args[0].toString(), (int)args[1], (int)args[2]);
                      },
                      juce::var(juce::Array<juce::var>())))
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
              // Bounce (Q19, docs/bounce.md): the direct verb takes a
              // path; the dialog verb picks one natively, then bounces.
              .withNativeFunction(
                  "bounce",
                  valueCall(
                      "bounce", 2,
                      [this](const auto& args) {
                        return audio_engine.bounce(args[0].toString(),
                                                   args[1].toString());
                      },
                      false))
              .withNativeFunction(
                  "bounceWithDialog",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    logBridgeCall("bounceWithDialog");
                    if (args.size() < 1) {
                      completion(false);
                      return;
                    }
                    bounceWithDialog(args[0].toString(), std::move(completion));
                  })
              // Import (docs/import.md): the direct verb takes a path +
              // a QTime placement; the dialog verb picks the file
              // natively, then imports.
              .withNativeFunction(
                  "importAudio",
                  valueCall(
                      "importAudio", 3,
                      [this](const auto& args) {
                        const auto at = qtimeArg(args[2]);
                        return audio_engine.importAudio(
                            args[0].toString(), args[1].toString(), at.first,
                            at.second);
                      },
                      false))
              .withNativeFunction(
                  "importAudioWithDialog",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    logBridgeCall("importAudioWithDialog");
                    if (args.size() < 1) {
                      completion(false);
                      return;
                    }
                    const auto at = qtimeArg(args.size() > 1 ? args[1]
                                                             : juce::var(0));
                    importAudioWithDialog(args[0].toString(), at.first,
                                          at.second, std::move(completion));
                  })
              // MIDI lane rendering (docs/vst3.md §11): notes on demand,
              // like waveforms.
              .withNativeFunction(
                  "getMidiNotes",
                  valueCall(
                      "getMidiNotes", 1,
                      [this](const auto& args) {
                        return audio_engine.getMidiNotes(args[0].toString());
                      },
                      juce::var(juce::Array<juce::var>())))
              .withNativeFunction(
                  "getProjectInfo",
                  valueCall("getProjectInfo", 0,
                            [this](const auto&) {
                              auto* o = new juce::DynamicObject();
                              o->setProperty("id", project_manager_.id());
                              o->setProperty("name",
                                             project_manager_.displayName());
                              o->setProperty("born", project_manager_.born());
                              // The library folders (the preferences
                              // panel, docs/projects.md): the projects
                              // root and the track-template library
                              // beneath it.
                              o->setProperty(
                                  "projectsRoot",
                                  project_manager_.projectsRoot()
                                      .getFullPathName());
                              o->setProperty(
                                  "trackTemplatesRoot",
                                  project_manager_.trackTemplatesRoot()
                                      .getFullPathName());
                              return juce::JSON::toString(juce::var(o), true);
                            }))
              // Preferences: the projects root is a persisted choice
              // (<app data>/Celestrian/projects_root.json, the
              // audio-device discipline); the chooser verb picks it
              // natively and answers the new path.
              .withNativeFunction(
                  "setProjectsRoot",
                  valueCall(
                      "setProjectsRoot", 1,
                      [this](const auto& args) {
                        return project_manager_.setBase(
                            juce::File(args[0].toString()));
                      },
                      false))
              .withNativeFunction(
                  "chooseProjectsRoot",
                  [this](const juce::Array<juce::var>&,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    logBridgeCall("chooseProjectsRoot");
                    chooseProjectsRoot(std::move(completion));
                  })
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
              .withNativeFunction("setMonitor",
                                  voidCall("setMonitor", 2,
                                           [this](const auto& args) {
                                             audio_engine.setMonitor(
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
                                        // webview-viewport position. The
                                        // expanded map drag warps the pointer
                                        // ONTO the handle it grabbed once the
                                        // raw view has opened — pointer and
                                        // geometry stay 1:1, no easing (the
                                        // heard→raw reflow otherwise strands
                                        // the handle away from the mouse).
                                        // CSS px → JUCE points: the page
                                        // sends its viewport size too, so
                                        // the mapping is exact under any
                                        // browser zoom / DPI scale (at 125%
                                        // display scaling a 1:1 warp lands
                                        // off the handle and the delta is
                                        // applied as a real drag). A call
                                        // without the size maps 1:1.
                                        double sx = 1.0, sy = 1.0;
                                        if (args.size() >= 4) {
                                          const double iw = (double)args[2];
                                          const double ih = (double)args[3];
                                          if (iw > 0 && web_browser.getWidth() > 0)
                                            sx = web_browser.getWidth() / iw;
                                          if (ih > 0 && web_browser.getHeight() > 0)
                                            sy = web_browser.getHeight() / ih;
                                        }
                                        const auto global =
                                            web_browser.localPointToGlobal(
                                                juce::Point<float>(
                                                    (float)((double)args[0] * sx),
                                                    (float)((double)args[1] * sy)));
                                        juce::Desktop::setMousePosition(
                                            global.roundToInt());
                                        return true;
                                      },
                                      juce::var(false)))
              // (No per-node togglePlay (Q16): mute/solo + the one
              // transport are the per-node play controls.)
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
                  "auditionStep",
                  voidCall("auditionStep", 2,
                           [this](const auto& args) {
                             // args[1] = step index, −1 = stop looping
                             // (docs/sequencer.md §11.2).
                             audio_engine.auditionStep(args[0].toString(),
                                                       (int)args[1]);
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
  // Boot EMPTY (Q17): the creation menu is the instrument path
  // (+ → Guitar → ●), and `R` on an empty project creates + arms the
  // default track, so the spark costs one gesture. Session templates
  // load on explicit request via the project menu.

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
            description.isInstrument, description.pluginFormatName);
        audio_engine.addPluginSlotToChain(node_uuid, std::move(slot), index);
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
      saving ? juce::String("Save session as...") : juce::String("Open session");
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

void MainComponent::bounceWithDialog(
    const juce::String& uuid,
    juce::WebBrowserComponent::NativeFunctionCompletion done) {
  // A live take refuses the bounce (AudioEngine::bounce); no dialog for
  // a render that cannot happen.
  if (audio_engine.hasActiveTake()) {
    done(false);
    return;
  }
  const juce::String name = nodeNameIn(audio_engine.getGraphState(), uuid);
  const juce::File folder =
      project_manager_.born()
          ? project_manager_.folder()
          : juce::File::getSpecialLocation(juce::File::userMusicDirectory);
  const juce::File suggested = folder.getChildFile(
      juce::File::createLegalFileName(name.isNotEmpty() ? name : "bounce") +
      ".wav");
  bounce_chooser_ =
      std::make_unique<juce::FileChooser>("Bounce to WAV", suggested, "*.wav");
  const int flags = juce::FileBrowserComponent::saveMode |
                    juce::FileBrowserComponent::canSelectFiles |
                    juce::FileBrowserComponent::warnAboutOverwriting;
  bounce_chooser_->launchAsync(
      flags,
      [this, uuid, done = std::move(done)](const juce::FileChooser& fc) mutable {
        const juce::File file = fc.getResult();
        if (file == juce::File()) {
          done(false);  // cancelled
          return;
        }
        done(audio_engine.bounce(
            uuid, file.withFileExtension("wav").getFullPathName()));
      });
}

void MainComponent::importAudioWithDialog(
    const juce::String& uuid, int64_t at_q_num, int64_t at_q_den,
    juce::WebBrowserComponent::NativeFunctionCompletion done) {
  // A live take refuses the import (AudioEngine::importAudio); no
  // dialog for an import that cannot land.
  if (audio_engine.hasActiveTake()) {
    done(false);
    return;
  }
  const juce::File start =
      juce::File::getSpecialLocation(juce::File::userMusicDirectory);
  import_chooser_ = std::make_unique<juce::FileChooser>(
      "Import audio", start, "*.wav;*.aif;*.aiff;*.flac");
  const int flags = juce::FileBrowserComponent::openMode |
                    juce::FileBrowserComponent::canSelectFiles;
  import_chooser_->launchAsync(
      flags, [this, uuid, at_q_num, at_q_den,
              done = std::move(done)](const juce::FileChooser& fc) mutable {
        const juce::File file = fc.getResult();
        if (file == juce::File()) {
          done(false);  // cancelled
          return;
        }
        done(audio_engine.importAudio(uuid, file.getFullPathName(), at_q_num,
                                      at_q_den));
      });
}

void MainComponent::chooseProjectsRoot(
    juce::WebBrowserComponent::NativeFunctionCompletion done) {
  root_chooser_ = std::make_unique<juce::FileChooser>(
      "Projects folder", project_manager_.baseFolder());
  const int flags = juce::FileBrowserComponent::openMode |
                    juce::FileBrowserComponent::canSelectDirectories;
  root_chooser_->launchAsync(
      flags, [this, done = std::move(done)](const juce::FileChooser& fc) mutable {
        const juce::File dir = fc.getResult();
        if (dir == juce::File() || !project_manager_.setBase(dir)) {
          done(juce::String());  // cancelled, or the folder cannot be made
          return;
        }
        done(project_manager_.baseFolder().getFullPathName());
      });
}

void MainComponent::timerCallback() {
  // Engine housekeeping independent of the WebView's poll cadence (a
  // throttled poll must not starve a live take's storage grower).
  audio_engine.tick();
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
    // WKWebView refuses to render an <img> SVG served as text/plain (the
    // brand mark shows as a broken-image icon).
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
