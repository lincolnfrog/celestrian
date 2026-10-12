#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include <functional>
#include <memory>
#include <optional>

#include "audio_engine.h"
#include "plugin_editor_windows.h"
#include "plugin_host_service.h"
#include "project_manager.h"

/**
 * The app shell: owns the engine and its services and hosts the WebView
 * UI. All UI↔engine traffic crosses the bridge browserOptions()
 * registers — the shared table plus the verbs that need a window
 * (src/bridge_dispatch.h says how a method is added). UI assets are
 * served through getResource under a custom scheme (not file://, which
 * CORS blocks). The timer is the project heartbeat
 * (ProjectManager::tick).
 */
class MainComponent : public juce::Component, public juce::Timer {
 public:
  MainComponent();
  ~MainComponent() override;

  void paint(juce::Graphics&) override;
  void resized() override;
  void timerCallback() override;

  /** Hand keyboard focus to the web page (the whole UI lives there).
   * Called whenever the main window becomes active. */
  void focusWebView();

 private:
  using Completion = juce::WebBrowserComponent::NativeFunctionCompletion;
  /** What a chooser's pick is handed to, with the page's completion. */
  using Picked = std::function<void(const juce::File&, Completion)>;

  AudioEngine audio_engine;
  // The project model (docs/projects.md), driven by the component timer.
  celestrian::ProjectManager project_manager_{audio_engine};
  // Plugin hosting (docs/vst3.md §4); its registry persists beside
  // audio_device.xml.
  celestrian::PluginHostService plugin_host_{
      juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
          .getChildFile("Celestrian")};
  // Plugin editor windows (docs/vst3.md §5). Declared after the engine:
  // they close before it tears down.
  celestrian::PluginEditorWindows plugin_editor_windows_;
  // Declared LAST: its options capture references to the members above,
  // which must exist before browserOptions() runs in the initializer
  // list.
  juce::WebBrowserComponent web_browser;

  /** The WebView options: the resource provider, the window verbs, and
   * every entry of the shared bridge table no window verb overrides. */
  juce::WebBrowserComponent::Options browserOptions();

  std::optional<juce::WebBrowserComponent::Resource> getResource(
      const juce::String& path);

  /** Opens `chooser` natively. A pick is handed to `picked` with the
   * page's completion; a dismissed dialog answers `cancelled`. One
   * chooser shows at a time: opening another closes the one still up,
   * whose call is answered `cancelled` — a bridge promise never hangs. */
  void chooseThen(std::unique_ptr<juce::FileChooser> chooser, int flags,
                  juce::var cancelled, Completion done, Picked picked);
  std::unique_ptr<juce::FileChooser> chooser_;
  // Answers the showing chooser's call as cancelled; empty when none is.
  std::function<void()> cancel_open_chooser_;

  // The window verbs' choosers. Each answers false (the projects root:
  // "") when cancelled or refused.

  /** A session bundle directory to create (SAVE) or open (OPEN). */
  enum class ChooserMode { SAVE, OPEN };
  void chooseSessionPath(ChooserMode mode, Completion done, Picked picked);

  /** Bounce (Q19, docs/bounce.md): a WAV to write — suggested as the
   * node's name, in the project folder when one exists, else the user's
   * music folder — then AudioEngine::bounce from `start` (absolute
   * samples; absent, the node's own top). */
  void bounceWithDialog(const juce::String& uuid, std::optional<int64_t> start,
                        Completion done);

  /** Import (docs/import.md): a WAV/AIFF/FLAC to read, then
   * AudioEngine::importAudio at `origin_samples` (absolute; the engine
   * snaps it to the Q grid). */
  void importAudioWithDialog(const juce::String& uuid, int64_t origin_samples,
                             Completion done);

  /** Preferences (docs/projects.md): a directory for the projects
   * root; answers the path now in force. */
  void chooseProjectsRoot(Completion done);

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
