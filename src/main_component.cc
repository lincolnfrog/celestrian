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
                  "togglePlayback",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.togglePlayback();
                    completion(true);
                  })
              .withNativeFunction(
                  "startRecordingInNode",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.startRecordingInNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "stopRecordingInNode",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.stopRecordingInNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "getGraphState",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getGraphState());
                  })
              .withNativeFunction(
                  "getWaveform",
                  [this](const juce::Array<juce::var> &args,
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
                  "enterBox",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.enterBox(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "exitBox",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    audio_engine.exitBox();
                    completion(true);
                  })
              .withNativeFunction(
                  "createNode",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 0)
                      audio_engine.createNode(args[0].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "renameNode",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1)
                      audio_engine.renameNode(args[0].toString(),
                                              args[1].toString());
                    completion(true);
                  })
              .withNativeFunction(
                  "getInputList",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    completion(audio_engine.getInputList());
                  })
              .withNativeFunction(
                  "setNodeInput",
                  [this](const juce::Array<juce::var> &args,
                         juce::WebBrowserComponent::NativeFunctionCompletion
                             completion) {
                    if (args.size() > 1) {
                      audio_engine.setNodeInput(args[0].toString(),
                                                (int)args[1]);
                    }
                    completion(true);
                  })
              .withNativeFunction(
                  "nativeLog",
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
