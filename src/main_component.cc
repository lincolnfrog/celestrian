#include "main_component.h"

#include <juce_core/juce_core.h>

#include <cmath>
#include <cstddef>
#include <cstring>
#include <set>
#include <utility>
#include <vector>

#include "bridge_dispatch.h"

namespace {
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
}  // namespace

// ---------------------------------------------------------------------------
// WebView bridge.
//
// The Three-Layer Handshake (.agent/style.md) applies: every UI-triggered
// feature needs (1) the C++ logic, (2) a bridge registration, and (3) a
// JS callNative(...) call. Registrations live in ONE table —
// src/bridge_dispatch.cc (`voidMethod` / `valueMethod`) — shared with
// the headless engine server; only verbs that need a WINDOW (native
// file choosers, plugin editor windows, the OS pointer warp) are bound
// here, via bindWindowVerb. The protocol contract test parses both.
// ---------------------------------------------------------------------------

juce::WebBrowserComponent::Options MainComponent::browserOptions() {
  using Options = juce::WebBrowserComponent::Options;
  using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;
  Options opts =
      Options{}
          .withNativeIntegrationEnabled()
#if JUCE_WINDOWS
          // On Windows JUCE's default backend is Internet Explorer, which
          // ignores the resource provider entirely (the UI would never
          // load). WebView2 has to be opted into explicitly.
          .withBackend(Options::Backend::webview2)
          .withWinWebView2Options(Options::WinWebView2{})
#endif
          .withResourceProvider(
              [this](const juce::String& path)
                  -> std::optional<juce::WebBrowserComponent::Resource> {
                return getResource(path);
              });

  // Window-bound verbs — these OVERRIDE the shared table's entries of
  // the same name (saveSession / loadSession fall back to a chooser on
  // an empty path; removeChainSlot closes the slot's editor first).
  std::set<juce::String> bound;
  auto bindWindowVerb = [&](const char* name, auto fn) {
    bound.insert(name);
    opts = opts.withNativeFunction(name, std::move(fn));
  };
  bindWindowVerb("saveSession", [this](const juce::Array<juce::var>& args,
                                       Completion completion) {
    celestrian::bridge::logCall("saveSession");
    juce::String path = args.size() > 0 ? args[0].toString() : juce::String();
    if (path.isNotEmpty()) {
      completion(audio_engine.saveSession(path));
      return;
    }
    // Empty path: pick a bundle directory to create.
    chooseSessionPath(ChooserMode::SAVE, std::move(completion));
  });
  bindWindowVerb("loadSession", [this](const juce::Array<juce::var>& args,
                                       Completion completion) {
    celestrian::bridge::logCall("loadSession");
    juce::String path = args.size() > 0 ? args[0].toString() : juce::String();
    if (path.isNotEmpty()) {
      completion(audio_engine.loadSession(path));
      return;
    }
    chooseSessionPath(ChooserMode::OPEN, std::move(completion));
  });
  // Bounce (Q19, docs/bounce.md): the dialog verb picks a path
  // natively, then bounces — from the render start the page names
  // (absolute samples, the frame zero it seated; docs/frame.md), or
  // the node's own top.
  bindWindowVerb("bounceWithDialog", [this](const juce::Array<juce::var>& args,
                                            Completion completion) {
    celestrian::bridge::logCall("bounceWithDialog");
    if (args.size() < 1) {
      completion(false);
      return;
    }
    std::optional<int64_t> start;
    if (args.size() > 1 && !args[1].isVoid()) start = (int64_t)(double)args[1];
    bounceWithDialog(args[0].toString(), start, std::move(completion));
  });
  // Import (docs/import.md): the dialog verb picks the file natively,
  // then imports at the origin the page names (absolute samples).
  bindWindowVerb("importAudioWithDialog",
                 [this](const juce::Array<juce::var>& args,
                        Completion completion) {
                   celestrian::bridge::logCall("importAudioWithDialog");
                   if (args.size() < 1) {
                     completion(false);
                     return;
                   }
                   const int64_t origin =
                       args.size() > 1 ? (int64_t)(double)args[1] : 0;
                   importAudioWithDialog(args[0].toString(), origin,
                                         std::move(completion));
                 });
  // Preferences: the chooser verb picks the projects root natively and
  // answers the new path.
  bindWindowVerb("chooseProjectsRoot",
                 [this](const juce::Array<juce::var>&, Completion completion) {
                   celestrian::bridge::logCall("chooseProjectsRoot");
                   chooseProjectsRoot(std::move(completion));
                 });
  bindWindowVerb("removeChainSlot",
                 [this](const juce::Array<juce::var>& args,
                        Completion completion) {
                   celestrian::bridge::logCall("removeChainSlot");
                   if (args.size() >= 2) {
                     // Close-before-removal: never show an editor for a
                     // slot the user just deleted.
                     plugin_editor_windows_.closeFor(args[1].toString());
                     audio_engine.removeChainSlot(args[0].toString(),
                                                  args[1].toString());
                   }
                   completion(true);
                 });
  bindWindowVerb("openPluginEditor",
                 [this](const juce::Array<juce::var>& args,
                        Completion completion) {
                   celestrian::bridge::logCall("openPluginEditor");
                   if (args.size() >= 2) {
                     auto* slot = audio_engine.vst3SlotFor(args[0].toString(),
                                                           args[1].toString());
                     if (slot != nullptr && slot->instance() != nullptr)
                       plugin_editor_windows_.open(args[1].toString(),
                                                   *slot->instance());
                   }
                   completion(true);
                 });
  bindWindowVerb("warpPointer", [this](const juce::Array<juce::var>& args,
                                       Completion completion) {
    celestrian::bridge::logCall("warpPointer");
    if (args.size() < 2) {
      completion(false);
      return;
    }
    // Move the OS cursor to a webview-viewport position. The expanded
    // map drag warps the pointer ONTO the handle it grabbed once the
    // raw view has opened — pointer and geometry stay 1:1, no easing
    // (the heard→raw reflow otherwise strands the handle away from the
    // mouse). CSS px → JUCE points: the page sends its viewport size
    // too, so the mapping is exact under any browser zoom / DPI scale
    // (at 125% display scaling a 1:1 warp lands off the handle and the
    // delta is applied as a real drag). A call without the size maps
    // 1:1.
    double sx = 1.0, sy = 1.0;
    if (args.size() >= 4) {
      const double iw = (double)args[2];
      const double ih = (double)args[3];
      if (iw > 0 && web_browser.getWidth() > 0) sx = web_browser.getWidth() / iw;
      if (ih > 0 && web_browser.getHeight() > 0)
        sy = web_browser.getHeight() / ih;
    }
    const auto global = web_browser.localPointToGlobal(juce::Point<float>(
        (float)((double)args[0] * sx), (float)((double)args[1] * sy)));
    juce::Desktop::setMousePosition(global.roundToInt());
    completion(true);
  });

  // The shared table: every GUI-free protocol method.
  for (auto& m : celestrian::bridge::engineMethods(
           {audio_engine, project_manager_, plugin_host_})) {
    if (bound.count(m.name)) continue;
    auto handler = m.handler;
    opts = opts.withNativeFunction(
        m.name, [handler](const juce::Array<juce::var>& args,
                          Completion completion) {
          handler(args, [completion](juce::var r) { completion(r); });
        });
  }
  return opts;
}

MainComponent::MainComponent() : web_browser(browserOptions()) {
  audio_engine.initialiseAudioDevice();
  // Boot EMPTY (Q17): the creation menu is the instrument path
  // (+ → Guitar → ●), and `R` on an empty project creates + arms the
  // default track, so the spark costs one gesture. Session templates
  // load on explicit request via the project menu.

  addAndMakeVisible(web_browser);

  // DEBUG UI (--debug-ui): sets ?debug=true on the page, which turns on
  // debug_flags.js — the verbose log line and the map-gesture flight
  // recorder (window.__mapDbg, plus the commit trace that names which
  // writer touched a loop region). Off by default; the recorder is too
  // chatty for normal runs. getResource strips the query back off.
  juce::String url = juce::WebBrowserComponent::getResourceProviderRoot();
  if (auto* app = juce::JUCEApplication::getInstance();
      app != nullptr && app->getCommandLineParameterArray().contains("--debug-ui")) {
    if (!url.endsWithChar('/')) url << "/";
    url << "?debug=true";
    juce::Logger::writeToLog("Debug UI enabled: " + url);
  }
  web_browser.goToURL(url);

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
    const juce::String& uuid, std::optional<int64_t> start,
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
      [this, uuid, start,
       done = std::move(done)](const juce::FileChooser& fc) mutable {
        const juce::File file = fc.getResult();
        if (file == juce::File()) {
          done(false);  // cancelled
          return;
        }
        done(audio_engine.bounce(
            uuid, file.withFileExtension("wav").getFullPathName(), start));
      });
}

void MainComponent::importAudioWithDialog(
    const juce::String& uuid, int64_t origin_samples,
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
      flags, [this, uuid, origin_samples,
              done = std::move(done)](const juce::FileChooser& fc) mutable {
        const juce::File file = fc.getResult();
        if (file == juce::File()) {
          done(false);  // cancelled
          return;
        }
        done(audio_engine.importAudio(uuid, file.getFullPathName(),
                                      origin_samples));
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
  // The document request carries the page's query string / fragment
  // (?debug=true — see the goToURL below). Resources resolve by PATH
  // only: leaving the query on would send "index.html?debug=true" to
  // the filesystem, miss, and hand WebView2 nothing — a blank window.
  cleanPath = cleanPath.upToFirstOccurrenceOf("?", false, false);
  cleanPath = cleanPath.upToFirstOccurrenceOf("#", false, false);
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
