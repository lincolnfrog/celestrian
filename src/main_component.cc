#include "main_component.h"
#include <cstddef>
#include <cstring>
#include <juce_core/juce_core.h>
#include <vector>

MainComponent::MainComponent()
    : web_browser(
          juce::WebBrowserComponent::Options{}
              .withNativeIntegrationEnabled()
              .withResourceProvider(
                  [this](const juce::String &path)
                      -> std::optional<juce::WebBrowserComponent::Resource> {
                    juce::String cleanPath = path;
                    if (cleanPath.startsWith("/"))
                      cleanPath = cleanPath.substring(1);
                    if (cleanPath.isEmpty())
                      cleanPath = "index.html";

                    juce::File uiDir("/Users/lincolnfrog/code/celestrian/ui");
                    juce::File file = uiDir.getChildFile(cleanPath);

                    if (!file.existsAsFile())
                      return std::nullopt;

                    juce::MemoryBlock mb;
                    if (!file.loadFileAsData(mb))
                      return std::nullopt;

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

                    std::vector<std::byte> data(mb.getSize());
                    std::memcpy(data.data(), mb.getData(), mb.getSize());

                    return juce::WebBrowserComponent::Resource{
                        std::move(data), std::move(mimeType)};
                  })
              .withNativeFunction(
                  "ping", [](const juce::Array<juce::var> &args,
                             juce::WebBrowserComponent::NativeFunctionCompletion
                                 completion) { completion("pong"); })
              .withNativeFunction(
                  "toggle_playback",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.toggle_playback();
                    completion(true);
                  })
              .withNativeFunction(
                  "start_recording_in_node",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.start_recording_in_node(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "stop_recording_in_node",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.stop_recording_in_node(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "get_graph_state",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.get_graph_state());
                  })
              .withNativeFunction(
                  "get_waveform",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() >= 2) {
                      completion(audio_engine.get_waveform(args[0].toString(),
                                                           (int)args[1]));
                    } else {
                      completion(juce::Array<juce::var>());
                    }
                  })
              .withNativeFunction(
                  "enter_box",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.enter_box(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "exit_box",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.exit_box();
                    completion(true);
                  })
              .withNativeFunction(
                  "create_node",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.create_node(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "rename_node",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1)
                      audio_engine.rename_node(args[0].toString(),
                                               args[1].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "native_log",
                  [](const juce::Array<juce::var> &args,
                     juce::WebBrowserComponent::NativeFunctionCompletion
                         completion) {
                    if (args.size() > 0)
                      juce::Logger::writeToLog("[JS] " + args[0].toString());
                    completion(true);
                  })) {

  addAndMakeVisible(web_browser);

  web_browser.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());

  setSize(800, 600);
}

MainComponent::~MainComponent() {}
void MainComponent::timerCallback() {}
void MainComponent::paint(juce::Graphics &g) {
  g.fillAll(
      getLookAndFeel().findColour(juce::ResizableWindow::backgroundColourId));
}
void MainComponent::resized() { web_browser.setBounds(getLocalBounds()); }
