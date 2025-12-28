#include "main_component.h"
#include <juce_gui_basics/juce_gui_basics.h>

class CelestrianApplication : public juce::JUCEApplication {
public:
  CelestrianApplication() {}

  const juce::String getApplicationName() override { return "Celestrian"; }
  const juce::String getApplicationVersion() override { return "0.1.0"; }
  bool moreThanOneInstanceAllowed() override { return true; }

  void initialise(const juce::String &commandLine) override {
    mainWindow.reset(new MainWindow(getApplicationName()));
  }

  void shutdown() override { mainWindow.reset(); }

  void systemRequestedQuit() override { quit(); }

  void anotherInstanceStarted(const juce::String &commandLine) override {}

  class MainWindow : public juce::DocumentWindow {
  public:
    MainWindow(juce::String name)
        : DocumentWindow(
              name,
              juce::Desktop::getInstance().getDefaultLookAndFeel().findColour(
                  juce::ResizableWindow::backgroundColourId),
              DocumentWindow::allButtons) {
      setUsingNativeTitleBar(true);
      setContentOwned(new MainComponent(), true);

#if JUCE_IOS || JUCE_ANDROID
      setFullScreen(true);
#else
      setResizable(true, true);
      centreWithSize(getWidth(), getHeight());
#endif

      setVisible(true);
    }

    void closeButtonPressed() override {
      JUCEApplication::getInstance()->systemRequestedQuit();
    }

  private:
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(MainWindow)
  };

private:
  std::unique_ptr<MainWindow> mainWindow;
};

START_JUCE_APPLICATION(CelestrianApplication)
