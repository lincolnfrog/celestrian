#include <juce_core/juce_core.h>

/**
 * A simple console application that runs all registered juce::UnitTests.
 */
int main(int argc, char *argv[]) {
  juce::ignoreUnused(argc, argv);

  juce::UnitTestRunner runner;
  runner.setAssertOnFailure(false);
  runner.runAllTests();

  int numFailures = 0;
  for (int i = 0; i < runner.getNumResults(); ++i) {
    auto *result = runner.getResult(i);
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
