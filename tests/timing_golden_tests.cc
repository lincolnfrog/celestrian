/**
 * Timing Golden Vector Test (C++ side)
 *
 * Runs src/timing.h against shared/timing_golden.json — the same vectors
 * ui/js/tests/timeline_model_golden.test.mjs runs against timeline_model.js.
 * If both suites pass, the C++ and JS timing math agree.
 */

#include <juce_core/juce_core.h>

#include <cmath>

#include "../src/timing.h"

namespace {

juce::File findGoldenFile() {
  // Search upward from both the working directory and the executable
  // location so the test works from the repo root or the build tree.
  auto searchUpFrom = [](juce::File dir) -> juce::File {
    for (int i = 0; i < 8; ++i) {
      auto candidate = dir.getChildFile("shared/timing_golden.json");
      if (candidate.existsAsFile()) return candidate;
      auto parent = dir.getParentDirectory();
      if (parent == dir) break;
      dir = parent;
    }
    return {};
  };

  auto fromCwd = searchUpFrom(juce::File::getCurrentWorkingDirectory());
  if (fromCwd.existsAsFile()) return fromCwd;

  return searchUpFrom(
      juce::File::getSpecialLocation(juce::File::currentExecutableFile)
          .getParentDirectory());
}

int64_t asInt64(const juce::var &v, const juce::Identifier &prop) {
  return (int64_t)(double)v.getProperty(prop, 0);
}

}  // namespace

class TimingGoldenTests : public juce::UnitTest {
 public:
  TimingGoldenTests() : juce::UnitTest("Timing Golden Vectors") {}

  void runTest() override {
    using namespace celestrian::timing;

    beginTest("Load shared/timing_golden.json");
    auto file = findGoldenFile();
    expect(file.existsAsFile(),
           "shared/timing_golden.json not found (searched upward from cwd and "
           "executable dir)");
    if (!file.existsAsFile()) return;

    auto root = juce::JSON::parse(file.loadFileAsString());
    expect(root.isObject(), "golden file did not parse as JSON");
    if (!root.isObject()) return;

    beginTest("timeline LCM");
    if (auto *cases = root.getProperty("lcm_cases", {}).getArray()) {
      for (auto &c : *cases) {
        int64_t result = asInt64(c, "quantum");
        if (auto *durations = c.getProperty("durations", {}).getArray()) {
          for (auto &d : *durations) {
            int64_t dur = (int64_t)(double)d;
            if (dur > 0) result = lcm(result, dur);
          }
        }
        expectEquals((juce::int64)result, (juce::int64)asInt64(c, "expected"),
                     c.getProperty("name", "?").toString());
      }
    }

    beginTest("launchPointFor");
    if (auto *cases = root.getProperty("launch_point_cases", {}).getArray()) {
      for (auto &c : *cases) {
        expectEquals(
            (juce::int64)launchPointFor(asInt64(c, "startPhase"),
                                        asInt64(c, "duration")),
            (juce::int64)asInt64(c, "expected"),
            c.getProperty("name", "?").toString());
      }
    }

    beginTest("playheadPercent");
    if (auto *cases = root.getProperty("playhead_cases", {}).getArray()) {
      for (auto &c : *cases) {
        double actual =
            playheadPercent(asInt64(c, "masterPos"), asInt64(c, "launchPoint"),
                            asInt64(c, "duration"));
        double expected = (double)c.getProperty("expected", 0.0);
        expect(std::abs(actual - expected) < 1e-9,
               c.getProperty("name", "?").toString() + " — expected " +
                   juce::String(expected) + ", got " + juce::String(actual));
      }
    }

    beginTest("nextStopBoundary");
    if (auto *cases = root.getProperty("stop_boundary_cases", {}).getArray()) {
      for (auto &c : *cases) {
        expectEquals(
            (juce::int64)nextStopBoundary(asInt64(c, "recordedLength"),
                                          asInt64(c, "quantum")),
            (juce::int64)asInt64(c, "expected"),
            c.getProperty("name", "?").toString());
      }
    }

    beginTest("snapCommittedDuration");
    if (auto *cases = root.getProperty("snap_cases", {}).getArray()) {
      for (auto &c : *cases) {
        auto name = c.getProperty("name", "?").toString();
        auto result = snapCommittedDuration(asInt64(c, "recordedLength"),
                                            asInt64(c, "quantum"));
        expectEquals((juce::int64)result.duration,
                     (juce::int64)asInt64(c, "expectedDuration"),
                     name + " (duration)");
        expectEquals((juce::int64)result.loop_end,
                     (juce::int64)asInt64(c, "expectedLoopEnd"),
                     name + " (loop_end)");
        expect(result.snapped ==
                   (bool)c.getProperty("expectedSnapped", false),
               name + " (snapped)");
      }
    }
  }
};

static TimingGoldenTests timingGoldenTests;
