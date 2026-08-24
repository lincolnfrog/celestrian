#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>

#include <iostream>

#include "../src/plugin_scan_worker.h"

namespace {
/** Prints test progress/failures to stdout. JUCE's default runner logs
 * through Logger::writeToLog, which on Windows goes to the debugger
 * (OutputDebugString) — invisible in a console/CI run. */
class ConsoleRunner : public juce::UnitTestRunner {
 protected:
  void logMessage(const juce::String& message) override {
    std::cout << message << std::endl;
  }
};
}  // namespace

/**
 * A simple console application that runs all registered juce::UnitTests.
 */
int main(int argc, char* argv[]) {
  // Scanner-subprocess launch: the out-of-process scan tests make this
  // binary its own scan worker (the app binary does the same in
  // production). Probe plugins until the coordinator disconnects.
  if (argc > 1) {
    const juce::ScopedJuceInitialiser_GUI juce_runtime;
    if (auto worker = celestrian::maybeStartScanWorker(argv[1])) {
      // A console binary has no NSApplication, so runDispatchLoop
      // ([NSApp run] on macOS) returns at once. Pump the run loop
      // directly instead; the worker stops it when the coordinator
      // disconnects.
      auto* message_manager = juce::MessageManager::getInstance();
      while (!message_manager->hasStopMessageBeenSent())
        message_manager->runDispatchLoopUntil(100);
      return 0;
    }
  }

  ConsoleRunner runner;
  runner.setAssertOnFailure(false);
  runner.runAllTests();
  // runner.runTestsInCategory("Audio Engine");

  int numFailures = 0;
  for (int i = 0; i < runner.getNumResults(); ++i) {
    auto* result = runner.getResult(i);
    numFailures += result->failures;
  }

  if (numFailures > 0) {
    std::cout << "\n❌ TESTS FAILED: " << numFailures << " failures\n"
              << std::endl;
    return 1;
  }

  std::cout << "\n✅ ALL TESTS PASSED\n" << std::endl;
  return 0;
}
