#include <juce_gui_basics/juce_gui_basics.h>

#include "main_component.h"
#include "plugin_scan_worker.h"

class CelestrianApplication : public juce::JUCEApplication {
 public:
  CelestrianApplication() {}

  const juce::String getApplicationName() override { return "Celestrian"; }
  const juce::String getApplicationVersion() override { return "0.1.0"; }
  // MUST stay true: the plugin scan re-launches this executable as a
  // worker (--scan-worker, below). With single-instance enforcement JUCE
  // would hand the worker's command line to the running app via
  // anotherInstanceStarted() and the child would exit without scanning.
  bool moreThanOneInstanceAllowed() override { return true; }

  void initialise(const juce::String& commandLine) override {
    // SCAN WORKER MODE (docs/vst3.md §4): the running app re-launches
    // this executable with --scan-worker to probe plugins out of
    // process. No window, no logger (it would wipe the parent's log),
    // no dock icon; probe the list, exit with the worker's code. A bad
    // plugin kills THIS process and the parent shrugs it off.
    const auto args = getCommandLineParameterArray();
    if (celestrian::scan_worker::isWorkerInvocation(args)) {
#if JUCE_MAC
      juce::Process::setDockIconVisible(false);  // no bouncing icon per worker
#endif
      setApplicationReturnValue(celestrian::scan_worker::run(args));
      quit();
      return;
    }

    // Set up file logger - overwrites each run
    auto logFile = juce::File::getCurrentWorkingDirectory().getChildFile(
        "celestrian_debug.log");
    logFile.deleteFile();  // Wipe previous run's logs
    fileLogger.reset(new juce::FileLogger(logFile, "Celestrian Debug Log"));
    juce::Logger::setCurrentLogger(fileLogger.get());

    mainWindow.reset(new MainWindow(getApplicationName()));
  }

  void shutdown() override {
    juce::Logger::setCurrentLogger(nullptr);
    fileLogger.reset();
    mainWindow.reset();
  }

  void systemRequestedQuit() override { quit(); }

  void anotherInstanceStarted(const juce::String& commandLine) override {}

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
  std::unique_ptr<juce::FileLogger> fileLogger;
};

START_JUCE_APPLICATION(CelestrianApplication)
