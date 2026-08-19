#include <juce_core/juce_core.h>

#include <iostream>

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
  juce::ignoreUnused(argc, argv);

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
