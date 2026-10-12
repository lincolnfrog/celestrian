#include "main_component.h"

#include <juce_core/juce_core.h>

#include <cstddef>
#include <cstring>
#include <set>
#include <utility>
#include <vector>

#include "bridge_dispatch.h"

// ---------------------------------------------------------------------------
// The WebView bridge: every entry of the shared table
// (src/bridge_dispatch.h), plus the verbs that need a WINDOW — native
// file choosers, plugin editor windows, the OS pointer — bound here.
// ---------------------------------------------------------------------------

juce::WebBrowserComponent::Options MainComponent::browserOptions() {
  using Options = juce::WebBrowserComponent::Options;
  using Args = juce::Array<juce::var>;
  using celestrian::bridge::Handler;
  using celestrian::bridge::optSamples;
  using celestrian::bridge::strArg;
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

  const auto table = celestrian::bridge::engineMethods(
      {audio_engine, project_manager_, plugin_host_});
  std::set<juce::String> bound;

  // A verb the table does not have: traced, and answered `missing` when
  // fewer than `min_args` arrived.
  auto bindWindowVerb = [&](const char* name, int min_args, juce::var missing,
                            auto fn) {
    bound.insert(name);
    opts = opts.withNativeFunction(
        name, [name, min_args, missing, fn = std::move(fn)](
                  const Args& args, Completion completion) {
          celestrian::bridge::logCall(name);
          if (args.size() < min_args) {
            completion(missing);
            return;
          }
          fn(args, std::move(completion));
        });
  };
  // A verb that OVERRIDES the table entry of the same name: `fn` does
  // the window part and hands the call on to that entry.
  auto bindOverTable = [&](const char* name, auto fn) {
    Handler entry;
    for (const auto& m : table)
      if (m.name == name) entry = m.handler;
    jassert(entry != nullptr);  // the name is not in the table
    bound.insert(name);
    opts = opts.withNativeFunction(
        name, [fn = std::move(fn), entry = std::move(entry)](
                  const Args& args, Completion completion) {
          fn(args, std::move(completion), entry);
        });
  };

  // saveSession / loadSession: the window part is the EMPTY path — a
  // native chooser, whose pick is the table's call.
  const auto pathOrChooser = [this](const char* name, ChooserMode mode) {
    return [this, name, mode](const Args& args, Completion completion,
                              const Handler& by_path) {
      if (strArg(args, 0).isNotEmpty()) {
        by_path(args, std::move(completion));
        return;
      }
      celestrian::bridge::logCall(name);
      chooseSessionPath(mode, std::move(completion),
                        [by_path](const juce::File& dir, Completion done) {
                          by_path({dir.getFullPathName()}, std::move(done));
                        });
    };
  };
  bindOverTable("saveSession", pathOrChooser("saveSession", ChooserMode::SAVE));
  bindOverTable("loadSession", pathOrChooser("loadSession", ChooserMode::OPEN));
  bindOverTable("removeChainSlot", [this](const Args& args,
                                          Completion completion,
                                          const Handler& remove) {
    // The editor closes first: none is left showing a slot the user
    // just removed.
    plugin_editor_windows_.closeFor(strArg(args, 1));
    remove(args, std::move(completion));
  });

  // (uuid, start?) — the render's start in absolute samples.
  bindWindowVerb("bounceWithDialog", 1, false,
                 [this](const Args& args, Completion completion) {
                   bounceWithDialog(args[0].toString(), optSamples(args, 1),
                                    std::move(completion));
                 });
  // (uuid, origin?) — the origin in absolute samples.
  bindWindowVerb("importAudioWithDialog", 1, false,
                 [this](const Args& args, Completion completion) {
                   importAudioWithDialog(args[0].toString(),
                                         optSamples(args, 1).value_or(0),
                                         std::move(completion));
                 });
  bindWindowVerb("chooseProjectsRoot", 0, juce::var(),
                 [this](const Args&, Completion completion) {
                   chooseProjectsRoot(std::move(completion));
                 });
  // False when there is no editor to show: no such plugin slot, or a
  // placeholder whose plugin is missing.
  bindWindowVerb("openPluginEditor", 2, false,
                 [this](const Args& args, Completion completion) {
                   auto* slot = audio_engine.vst3SlotFor(args[0].toString(),
                                                         args[1].toString());
                   if (slot == nullptr || slot->isMissing()) {
                     completion(false);
                     return;
                   }
                   plugin_editor_windows_.open(slot->owner());
                   completion(true);
                 });
  // (x, y, viewportWidth?, viewportHeight?) — moves the OS cursor to a
  // page position. CSS px become JUCE points through the viewport size
  // the page sends, which keeps the landing exact under any browser
  // zoom or display scale; without the size the mapping is 1:1.
  bindWindowVerb("warpPointer", 2, false,
                 [this](const Args& args, Completion completion) {
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
                       web_browser.localPointToGlobal(juce::Point<float>(
                           (float)((double)args[0] * sx),
                           (float)((double)args[1] * sy)));
                   juce::Desktop::setMousePosition(global.roundToInt());
                   completion(true);
                 });

  for (const auto& m : table)
    if (!bound.count(m.name)) opts = opts.withNativeFunction(m.name, m.handler);
  return opts;
}

MainComponent::MainComponent() : web_browser(browserOptions()) {
  audio_engine.initialiseAudioDevice();

  addAndMakeVisible(web_browser);

  // --debug-ui puts ?debug=true on the page URL (ui/js/debug_flags.js:
  // the verbose log and the map-gesture recorder). getResource strips
  // the query back off.
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

  // After every successful session load: the previous session's editor
  // windows close (their slots have left the graph), and the loaded
  // one's placeholder slots are revived.
  audio_engine.setOnSessionLoaded([this] {
    plugin_editor_windows_.closeAll();
    celestrian::bridge::revivePlaceholders(
        {audio_engine, project_manager_, plugin_host_});
  });
}

MainComponent::~MainComponent() {
  // The heartbeat is the only other writer of the mirror: whatever
  // changed since its last tick (a committed take, an edit) reaches the
  // project folder before the session is dropped.
  project_manager_.flush();
  plugin_editor_windows_.closeAll();
}

void MainComponent::chooseThen(std::unique_ptr<juce::FileChooser> chooser,
                               int flags, juce::var cancelled, Completion done,
                               Picked picked) {
  // Replacing a chooser destroys it without running its callback, so
  // the call it was opened for is answered here.
  if (auto answer = std::exchange(cancel_open_chooser_, nullptr)) answer();
  chooser_ = std::move(chooser);
  cancel_open_chooser_ = [done, cancelled] { done(cancelled); };
  chooser_->launchAsync(
      flags, [this, done, cancelled,
              picked = std::move(picked)](const juce::FileChooser& fc) {
        cancel_open_chooser_ = nullptr;
        const juce::File file = fc.getResult();
        if (file == juce::File())
          done(cancelled);
        else
          picked(file, done);
      });
}

void MainComponent::chooseSessionPath(ChooserMode mode, Completion done,
                                      Picked picked) {
  const bool saving = mode == ChooserMode::SAVE;
  chooseThen(
      std::make_unique<juce::FileChooser>(
          saving ? "Save session as..." : "Open session",
          juce::File::getSpecialLocation(juce::File::userDocumentsDirectory)
              .getChildFile("Celestrian Sessions")),
      juce::FileBrowserComponent::canSelectDirectories |
          (saving ? juce::FileBrowserComponent::saveMode
                  : juce::FileBrowserComponent::openMode),
      false, std::move(done), std::move(picked));
}

void MainComponent::bounceWithDialog(const juce::String& uuid,
                                     std::optional<int64_t> start,
                                     Completion done) {
  // A live take refuses the bounce (AudioEngine::bounce); no dialog for
  // a render that cannot happen.
  if (audio_engine.hasActiveTake()) {
    done(false);
    return;
  }
  const juce::String name =
      celestrian::bridge::findNodeVar(audio_engine.getGraphState(), uuid)
          .getProperty("name", "")
          .toString();
  const juce::File folder =
      project_manager_.born()
          ? project_manager_.folder()
          : juce::File::getSpecialLocation(juce::File::userMusicDirectory);
  const juce::File suggested = folder.getChildFile(
      juce::File::createLegalFileName(name.isNotEmpty() ? name : "bounce") +
      ".wav");
  chooseThen(
      std::make_unique<juce::FileChooser>("Bounce to WAV", suggested, "*.wav"),
      juce::FileBrowserComponent::saveMode |
          juce::FileBrowserComponent::canSelectFiles |
          juce::FileBrowserComponent::warnAboutOverwriting,
      false, std::move(done),
      [this, uuid, start](const juce::File& file, Completion answer) {
        answer(audio_engine.bounce(
            uuid, file.withFileExtension("wav").getFullPathName(), start));
      });
}

void MainComponent::importAudioWithDialog(const juce::String& uuid,
                                          int64_t origin_samples,
                                          Completion done) {
  // A live take refuses the import (AudioEngine::importAudio); no
  // dialog for an import that cannot land.
  if (audio_engine.hasActiveTake()) {
    done(false);
    return;
  }
  chooseThen(
      std::make_unique<juce::FileChooser>(
          "Import audio",
          juce::File::getSpecialLocation(juce::File::userMusicDirectory),
          "*.wav;*.aif;*.aiff;*.flac"),
      juce::FileBrowserComponent::openMode |
          juce::FileBrowserComponent::canSelectFiles,
      false, std::move(done),
      [this, uuid, origin_samples](const juce::File& file, Completion answer) {
        answer(audio_engine.importAudio(uuid, file.getFullPathName(),
                                        origin_samples));
      });
}

void MainComponent::chooseProjectsRoot(Completion done) {
  chooseThen(
      std::make_unique<juce::FileChooser>("Projects folder",
                                          project_manager_.baseFolder()),
      juce::FileBrowserComponent::openMode |
          juce::FileBrowserComponent::canSelectDirectories,
      juce::String(), std::move(done),
      [this](const juce::File& dir, Completion answer) {
        // "" too when the folder cannot be made.
        answer(project_manager_.setBase(dir)
                   ? project_manager_.baseFolder().getFullPathName()
                   : juce::String());
      });
}

void MainComponent::timerCallback() {
  // Engine housekeeping independent of the WebView's poll cadence (a
  // throttled poll must not starve a live take's storage grower).
  audio_engine.tick();
  // Hot-plugged MIDI keyboards join on the heartbeat (cheap: enable is
  // an idempotent per-device check).
  audio_engine.refreshMidiInputs();
  project_manager_.tick();
}
void MainComponent::paint(juce::Graphics& g) {
  g.fillAll(
      getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
}
void MainComponent::resized() { web_browser.setBounds(getLocalBounds()); }

void MainComponent::focusWebView() {
  if (!web_browser.isShowing()) return;
  // Drop, then re-take: grabbing a component JUCE already records as
  // focused is a no-op, and only a real focus gain makes the embedded
  // WebView2 component call MoveFocus into the page.
  juce::Component::unfocusAllComponents();
  web_browser.grabKeyboardFocus();
}

std::optional<juce::WebBrowserComponent::Resource> MainComponent::getResource(
    const juce::String& path) {
  // Resources resolve by PATH only. The document request carries the
  // page's query string and fragment (?debug=true); left on, the file
  // lookup misses and the window stays blank.
  juce::String cleanPath = path.upToFirstOccurrenceOf("?", false, false)
                               .upToFirstOccurrenceOf("#", false, false);
  if (cleanPath.startsWith("/")) cleanPath = cleanPath.substring(1);
  if (cleanPath.isEmpty()) cleanPath = "index.html";

  // ui/ sits beside the executable in a deployed bundle, and in the
  // working directory during development.
  juce::File uiDir =
      juce::File::getSpecialLocation(juce::File::currentExecutableFile)
          .getParentDirectory()
          .getChildFile("ui");
  if (!uiDir.isDirectory()) {
    uiDir = juce::File::getCurrentWorkingDirectory().getChildFile("ui");
  }

  const juce::File file = uiDir.getChildFile(cleanPath);
  juce::MemoryBlock mb;
  if (!file.existsAsFile() || !file.loadFileAsData(mb)) return std::nullopt;

  std::vector<std::byte> data(mb.getSize());
  std::memcpy(data.data(), mb.getData(), mb.getSize());
  return juce::WebBrowserComponent::Resource{std::move(data),
                                             celestrian::bridge::mimeFor(file)};
}
