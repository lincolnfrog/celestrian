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
                  "ping", [](const juce::Array<juce::var>& args,
                             juce::WebBrowserComponent::NativeFunctionCompletion
                                 completion) { completion("pong"); })
              .withNativeFunction(
                  "togglePlayback",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.togglePlayback();
                    completion(true);
                  })
              .withNativeFunction(
                  "startRecordingInNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.startRecordingInNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "stopRecordingInNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.stopRecordingInNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "getGraphState",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getGraphState());
                  })
              .withNativeFunction(
                  "getWaveform",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() >= 2) {
                      completion(audio_engine.getWaveform(args[0].toString(),
                                                          (int)args[1]));
                    } else {
                      completion(juce::Array<juce::var>());
                    }
                  })
              .withNativeFunction(
                  "toggleStackExpand",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.toggleStackExpand(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "createNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      // type, parent_uuid
                      audio_engine.createNode(args[0].toString(),
                                              args[1].toString());
                    } else if (args.size() > 0) {
                      // type only
                      audio_engine.createNode(args[0].toString());
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "deleteNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.deleteNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "undo",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    audio_engine.undo();
                    completion(true);
                  })
              .withNativeFunction(
                  "saveSession",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::String path =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    if (path.isNotEmpty()) {
                      completion(audio_engine.saveSession(path));
                      return;
                    }
                    // Empty path: pick a bundle directory to create.
                    chooseSessionPath(true, std::move(completion));
                  })
              .withNativeFunction(
                  "loadSession",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    juce::String path =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    if (path.isNotEmpty()) {
                      completion(audio_engine.loadSession(path));
                      return;
                    }
                    chooseSessionPath(false, std::move(completion));
                  })
              .withNativeFunction(
                  "getProjectInfo",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    auto* o = new juce::DynamicObject();
                    o->setProperty("id", project_manager_.id());
                    o->setProperty("name", project_manager_.displayName());
                    o->setProperty("born", project_manager_.born());
                    completion(juce::JSON::toString(juce::var(o), true));
                  })
              .withNativeFunction(
                  "renameProject",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    project_manager_.rename(args.size() > 0 ? args[0].toString()
                                                            : "");
                    completion(true);
                  })
              .withNativeFunction(
                  "saveProjectNow",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    completion(project_manager_.saveNow());
                  })
              .withNativeFunction(
                  "listTemplates",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    completion(
                        projectInfosToJson(project_manager_.listTemplates()));
                  })
              .withNativeFunction(
                  "listRecentProjects",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    completion(
                        projectInfosToJson(project_manager_.listRecents(10)));
                  })
              .withNativeFunction(
                  "newProjectFromTemplate",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(project_manager_.newFromTemplate(
                        args.size() > 0 ? args[0].toString() : ""));
                  })
              .withNativeFunction(
                  "openProjectPath",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(project_manager_.openProject(
                        juce::File(args.size() > 0 ? args[0].toString() : "")));
                  })
              .withNativeFunction(
                  "saveAsTemplate",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(project_manager_.saveAsTemplate(
                        args.size() > 0 ? args[0].toString() : ""));
                  })
              .withNativeFunction(
                  "duplicateProject",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    const auto dest = project_manager_.duplicateProject();
                    completion(dest == juce::File() ? juce::String("")
                                                    : dest.getFileName());
                  })
              .withNativeFunction(
                  "redo",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    (void)args;
                    audio_engine.redo();
                    completion(true);
                  })
              .withNativeFunction(
                  "renameNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1)
                      audio_engine.renameNode(args[0].toString(),
                                              args[1].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "reorderNode",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 2)
                      audio_engine.reorderNode(
                          args[0].toString(), args[1].toString(), (int)args[2]);
                    completion(true);
                  })
              .withNativeFunction(
                  "combineNodes",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1)
                      completion(audio_engine.combineNodes(args[0].toString(),
                                                           args[1].toString()));
                    else
                      completion(juce::String());
                  })
              .withNativeFunction(
                  "setNodePosition",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 2)
                      audio_engine.setNodePosition(
                          args[0].toString(), (double)args[1], (double)args[2]);
                    completion(true);
                  })
              .withNativeFunction(
                  "getInputList",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getInputList());
                  })
              .withNativeFunction(
                  "getAudioDeviceState",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getAudioDeviceState());
                  })
              .withNativeFunction(
                  "setAudioDevice",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    // (type, device, sampleRate, bufferSize); trailing args
                    // are optional — 0 means "keep the device's preference".
                    const auto type =
                        args.size() > 0 ? args[0].toString() : juce::String();
                    const auto device =
                        args.size() > 1 ? args[1].toString() : juce::String();
                    const double sr = args.size() > 2 ? (double)args[2] : 0.0;
                    const int block = args.size() > 3 ? (int)args[3] : 0;
                    completion(
                        audio_engine.setAudioDevice(type, device, sr, block));
                  })
              .withNativeFunction(
                  "setNodeInput",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setNodeInput(args[0].toString(),
                                                (int)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setNodeInputRight",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setNodeInputRight(args[0].toString(),
                                                     (int)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setNodePan",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setNodePan(args[0].toString(),
                                              (double)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setNodeGain",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setNodeGain(args[0].toString(),
                                               (double)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setPeriodSource",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setPeriodSource(
                          args[0].toString(), args[1].toString() == "context");
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setEffectEnabled",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 2) {
                      audio_engine.setEffectEnabled(args[0].toString(),
                                                    args[1].toString(),
                                                    (bool)args[2]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setEffectParam",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 3) {
                      audio_engine.setEffectParam(
                          args[0].toString(), args[1].toString(),
                          args[2].toString(), (double)args[3]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setEffectScope",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setEffectScope(args[0].toString(),
                                                  (bool)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setLoopPoints",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 2) {
                      audio_engine.setLoopPoints(args[0].toString(),
                                                 (juce::int64)args[1],
                                                 (juce::int64)args[2]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "setSegments",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    // args[1] = flat [s0, e0, s1, e1, ...] in samples
                    // (time_maps.md phase 3).
                    if (args.size() > 1) {
                      celestrian::timing::TimeMap m;
                      if (auto* flat = args[1].getArray()) {
                        for (int i = 0;
                             i + 1 < flat->size() &&
                             m.n < celestrian::timing::TimeMap::kMaxSegments;
                             i += 2) {
                          m.segs[m.n++] = {(int64_t)(double)(*flat)[i],
                                           (int64_t)(double)(*flat)[i + 1]};
                        }
                      }
                      audio_engine.setSegments(args[0].toString(), m);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "warpPointer",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    // Move the OS cursor to a webview-viewport position
                    // (CSS px == JUCE points at default zoom). The
                    // expanded map drag warps the pointer ONTO the
                    // handle it grabbed once the raw view has opened —
                    // pointer and geometry stay 1:1, no easing (the
                    // heard→raw reflow otherwise strands the handle
                    // away from the mouse; field 2026-07-25d).
                    if (args.size() > 1) {
                      const auto global =
                          web_browser.localPointToGlobal(juce::Point<float>(
                              (float)(double)args[0], (float)(double)args[1]));
                      juce::Desktop::setMousePosition(global.roundToInt());
                      completion(true);
                    } else {
                      completion(false);
                    }
                  })
              .withNativeFunction(
                  "togglePlay",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.togglePlay(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "toggleSolo",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.toggleSolo(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "toggleMute",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0) {
                      if (args[0].isString())
                        audio_engine.toggleMute(args[0].toString());
                      else if (auto* obj = args[0].getDynamicObject())
                        audio_engine.toggleMute(
                            obj->getProperty("uuid").toString());
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "toggleLoopWindow",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.toggleLoopWindow(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "startLatencyCalibration",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.startLatencyCalibration();
                    completion(true);
                  })
              .withNativeFunction(
                  "getLatencyCalibration",
                  [this](const juce::Array<juce::var>& args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getLatencyCalibration());
                  })
              .withNativeFunction(
                  "nativeLog",
                  [](const juce::Array<juce::var>& args,
                     juce::WebBrowserComponent::NativeFunctionCompletion
                         completion) {
                    if (args.size() > 0)
                      juce::Logger::writeToLog("[JS] " + args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "dumpStateToFile",
                  [](const juce::Array<juce::var>& args,
                     juce::WebBrowserComponent::NativeFunctionCompletion
                         completion) {
                    if (args.size() > 0) {
                      auto stateFile =
                          juce::File::getCurrentWorkingDirectory().getChildFile(
                              "celestrian_state.json");
                      stateFile.replaceWithText(args[0].toString());
                      juce::Logger::writeToLog("State dumped to: " +
                                               stateFile.getFullPathName());
                    }
                    completion(true);
                  })) {
  audio_engine.initialiseAudioDevice();
  // The launch ritual (docs/projects.md): boot into the last template —
  // or, on first run, build the minimal Default template (one ready
  // track) and boot into that. Either way: launch → hit record. One
  // click, never an empty screen.
  project_manager_.ensureLaunchSession();

  addAndMakeVisible(web_browser);

  web_browser.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

  setSize(800, 600);

  // Project heartbeat (docs/projects.md): birth + mirror every 3 s.
  startTimer(3000);
}

MainComponent::~MainComponent() {}

void MainComponent::chooseSessionPath(
    bool saving, juce::WebBrowserComponent::NativeFunctionCompletion done) {
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
