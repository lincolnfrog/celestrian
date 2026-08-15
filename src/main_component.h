#pragma once

#include <juce_gui_extra/juce_gui_extra.h>

#include "audio_engine.h"
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
  juce::WebBrowserComponent web_browser;
  AudioEngine audio_engine;
  // The project model (docs/projects.md): birth at first take +
  // continuous mirror, driven by the component timer (message thread).
  celestrian::ProjectManager project_manager_{audio_engine};
  // Plugin hosting foundation (docs/vst3.md §4): known-plugin registry
  // + background scan, persisted beside audio_device.xml. Message
  // thread only; the chain integration arrives in phases 2-3.
  celestrian::PluginHostService plugin_host_{
      juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
          .getChildFile("Celestrian")};

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

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
