#pragma once

#include "audio_engine.h"
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

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainComponent)
};
