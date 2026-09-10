#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include "audio_engine.h"
#include "plugin_editor_windows.h"
#include "plugin_host_service.h"
#include "project_manager.h"

/**
 * The app shell: owns the engine + project manager and hosts the WebView
 * UI. All UI↔engine traffic crosses the JUCE native-function bridge
 * registered in the constructor — adding a UI-triggered feature needs
 * all three layers of the handshake (.agent/style.md: C++ logic, a
 * withNativeFunction registration HERE, and the JS callNative call);
 * a missing registration leaves the JS promise hanging forever. UI
 * assets are served through getResource under a custom scheme (not
 * file://, which CORS blocks). The timer drives ProjectManager::tick —
 * the continuous-mirror heartbeat.
 */
class MainComponent : public juce::Component, public juce::Timer {
 public:
  MainComponent();
  ~MainComponent() override;

  void paint(juce::Graphics&) override;
  void resized() override;
  void timerCallback() override;

 private:
  AudioEngine audio_engine;
  // The project model (docs/projects.md): birth at first take +
  // continuous mirror, driven by the component timer (message thread).
  celestrian::ProjectManager project_manager_{audio_engine};
  // Plugin hosting foundation (docs/vst3.md §4): known-plugin registry
  // + background scan, persisted beside audio_device.xml. Message
  // thread only.
  celestrian::PluginHostService plugin_host_{
      juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
          .getChildFile("Celestrian")};
  // Floating native editor windows, keyed by slot uuid (docs/vst3.md
  // §5). Declared after the engine: windows close before the engine
  // (and its plugin instances) tears down.
  celestrian::PluginEditorWindows plugin_editor_windows_;
  // Declared LAST: its options capture references to the members above
  // (the shared bridge table, src/bridge_dispatch.h), which must exist
  // before browserOptions() runs in the initializer list.
  juce::WebBrowserComponent web_browser;

  /** The WebView options: the resource provider, the window-bound
   * bridge verbs (file choosers, plugin editors, the pointer warp), and
   * every GUI-free protocol method from the shared bridge table. */
  juce::WebBrowserComponent::Options browserOptions();

  /** Load-time revival sweep: instantiate every placeholder slot whose
   * plugin is installed here (docs/vst3.md §6). */
  void revivePlaceholderPlugins();

  std::optional<juce::WebBrowserComponent::Resource> getResource(
      const juce::String& path);

  // Opens a native chooser for a session bundle directory, then
  // saves/loads to it and reports success back to the webview. Keeps the
  // chooser alive for the async callback.
  enum class ChooserMode { SAVE, OPEN };
  void chooseSessionPath(
      ChooserMode mode,
      juce::WebBrowserComponent::NativeFunctionCompletion done);
  std::unique_ptr<juce::FileChooser> session_chooser_;

  // Bounce (Q19, docs/bounce.md): opens a native save chooser for the
  // node's WAV — named after the node, in the project folder when one
  // exists, else the user's music folder — then renders through
  // AudioEngine::bounce and reports its verdict to the webview.
  void bounceWithDialog(
      const juce::String& uuid,
      juce::WebBrowserComponent::NativeFunctionCompletion done);
  std::unique_ptr<juce::FileChooser> bounce_chooser_;

  // Import (docs/import.md): opens a native open chooser filtered to
  // WAV/AIFF/FLAC, then imports the pick at `at_q` (a QTime rational)
  // through AudioEngine::importAudio; false when cancelled or refused.
  void importAudioWithDialog(
      const juce::String& uuid, int64_t at_q_num, int64_t at_q_den,
      juce::WebBrowserComponent::NativeFunctionCompletion done);
  std::unique_ptr<juce::FileChooser> import_chooser_;

  // Preferences (docs/projects.md): a native directory chooser for the
  // projects root; answers the chosen path ("" when cancelled).
  void chooseProjectsRoot(
      juce::WebBrowserComponent::NativeFunctionCompletion done);
  std::unique_ptr<juce::FileChooser> root_chooser_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
