#pragma once

#include "audio_engine.h"
#include "project_manager.h"
#include <juce_gui_extra/juce_gui_extra.h>

class MainComponent : public juce::Component, public juce::Timer {
public:
  MainComponent();
  ~MainComponent() override;

  void paint(juce::Graphics &) override;
  void resized() override;
  void timerCallback() override;

private:
  juce::WebBrowserComponent web_browser;
  AudioEngine audio_engine;
  // The project model (docs/projects.md): birth at first take +
  // continuous mirror, driven by the component timer (message thread).
  celestrian::ProjectManager project_manager_{audio_engine};

  std::optional<juce::WebBrowserComponent::Resource>
  getResource(const juce::String &path);

  // Opens a native chooser for a session bundle directory, then
  // saves/loads to it and reports success back to the webview. Keeps the
  // chooser alive for the async callback.
  void chooseSessionPath(
      bool saving, juce::WebBrowserComponent::NativeFunctionCompletion done);
  std::unique_ptr<juce::FileChooser> session_chooser_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
