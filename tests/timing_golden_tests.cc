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
#include "test_utils.h"

using celestrian::test_utils::asInt64;
using celestrian::test_utils::findSharedFile;

class TimingGoldenTests : public juce::UnitTest {
 public:
  TimingGoldenTests() : juce::UnitTest("Timing Golden Vectors") {}

  void runTest() override {
    using celestrian::timing::armTarget;
    using celestrian::timing::launchPointFor;
    using celestrian::timing::lcm;
    using celestrian::timing::nextStopBoundary;
    using celestrian::timing::originQ;
    using celestrian::timing::playheadPercent;
    using celestrian::timing::QTime;
    using celestrian::timing::snapCommittedDuration;
    using celestrian::timing::throughMapDest;
    using celestrian::timing::TimeMap;
    using celestrian::timing::toSamples;

    beginTest("Load shared/timing_golden.json");
    auto file = findSharedFile("shared/timing_golden.json");
    expect(file.existsAsFile(),
           "shared/timing_golden.json not found (searched upward from cwd and "
           "executable dir)");
    if (!file.existsAsFile()) return;

    auto root = juce::JSON::parse(file.loadFileAsString());
    expect(root.isObject(), "golden file did not parse as JSON");
    if (!root.isObject()) return;

    beginTest("timeline LCM");
    if (auto* cases = root.getProperty("lcm_cases", {}).getArray()) {
      for (auto& c : *cases) {
        int64_t result = asInt64(c, "quantum");
        if (auto* durations = c.getProperty("durations", {}).getArray()) {
          for (auto& d : *durations) {
            int64_t dur = (int64_t)(double)d;
            if (dur > 0) result = lcm(result, dur);
          }
        }
        expectEquals((juce::int64)result, (juce::int64)asInt64(c, "expected"),
                     c.getProperty("name", "?").toString());
      }
    }

    beginTest("launchPointFor");
    if (auto* cases = root.getProperty("launch_point_cases", {}).getArray()) {
      for (auto& c : *cases) {
        expectEquals((juce::int64)launchPointFor(asInt64(c, "startPhase"),
                                                 asInt64(c, "duration")),
                     (juce::int64)asInt64(c, "expected"),
                     c.getProperty("name", "?").toString());
      }
    }

    beginTest("playheadPercent");
    if (auto* cases = root.getProperty("playhead_cases", {}).getArray()) {
      for (auto& c : *cases) {
        double actual =
            playheadPercent(asInt64(c, "masterPos"), asInt64(c, "launchPoint"),
                            asInt64(c, "duration"));
        double expected = (double)c.getProperty("expected", 0.0);
        expect(std::abs(actual - expected) < 1e-9,
               c.getProperty("name", "?").toString() + " - expected " +
                   juce::String(expected) + ", got " + juce::String(actual));
      }
    }

    beginTest("armTarget");
    if (auto* cases = root.getProperty("arm_target_cases", {}).getArray()) {
      for (auto& c : *cases) {
        expectEquals(
            (juce::int64)armTarget(asInt64(c, "rel"), asInt64(c, "quantum"),
                                   asInt64(c, "contextLoop")),
            (juce::int64)asInt64(c, "expected"),
            c.getProperty("name", "?").toString());
      }
    }

    beginTest("nextStopBoundary");
    if (auto* cases = root.getProperty("stop_boundary_cases", {}).getArray()) {
      for (auto& c : *cases) {
        expectEquals((juce::int64)nextStopBoundary(asInt64(c, "recordedLength"),
                                                   asInt64(c, "quantum")),
                     (juce::int64)asInt64(c, "expected"),
                     c.getProperty("name", "?").toString());
      }
    }

    beginTest("snapCommittedDuration");
    if (auto* cases = root.getProperty("snap_cases", {}).getArray()) {
      for (auto& c : *cases) {
        auto name = c.getProperty("name", "?").toString();
        auto result = snapCommittedDuration(asInt64(c, "recordedLength"),
                                            asInt64(c, "quantum"));
        expectEquals((juce::int64)result.duration,
                     (juce::int64)asInt64(c, "expectedDuration"),
                     name + " (duration)");
        expectEquals((juce::int64)result.loop_end,
                     (juce::int64)asInt64(c, "expectedLoopEnd"),
                     name + " (loop_end)");
        expect(result.snapped == (bool)c.getProperty("expectedSnapped", false),
               name + " (snapped)");
      }
    }

    // Shared helper: build a TimeMap from a golden case's "segments".
    auto mapFrom = [this](const juce::var& c, const juce::String& name) {
      TimeMap m;
      if (auto* segs = c.getProperty("segments", {}).getArray()) {
        for (auto& s : *segs) {
          auto* pair = s.getArray();
          expect(pair != nullptr && pair->size() == 2 &&
                     m.n < TimeMap::kMaxSegments,
                 name + " (segment shape)");
          if (pair == nullptr || pair->size() != 2) continue;
          m.segs[m.n++] = {(int64_t)(double)(*pair)[0],
                           (int64_t)(double)(*pair)[1]};
        }
      }
      return m;
    };

    beginTest("through-map arm (heard armTarget on the map-period grid)");
    if (auto* cases =
            root.getProperty("through_map_arm_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const auto name = c.getProperty("name", "?").toString();
        const TimeMap m = mapFrom(c, name);
        const int64_t t_rel = armTarget(asInt64(c, "relHeard"),
                                        asInt64(c, "quantum"), m.period());
        expectEquals((juce::int64)t_rel,
                     (juce::int64)asInt64(c, "expectedHeardTargetRel"),
                     name + " (heard target)");
        expectEquals((juce::int64)m.mapOffset(t_rel),
                     (juce::int64)asInt64(c, "expectedInnerOffset"),
                     name + " (inner offset)");
      }
    }

    beginTest("through-map capture fold (throughMapDest)");
    if (auto* cases =
            root.getProperty("through_map_dest_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const auto name = c.getProperty("name", "?").toString();
        const TimeMap m = mapFrom(c, name);
        if (auto* probes = c.getProperty("probes", {}).getArray()) {
          for (auto& p : *probes) {
            expectEquals(
                (juce::int64)throughMapDest(asInt64(p, "i"),
                                            asInt64(c, "anchorOff"), m,
                                            asInt64(c, "commitCycle")),
                (juce::int64)asInt64(p, "dest"),
                name + " dest(i=" + juce::String(asInt64(p, "i")) + ")");
          }
        }
      }
    }

    beginTest("TimeMap inverse (heardOffsetOf)");
    if (auto* cases = root.getProperty("map_inverse_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const auto name = c.getProperty("name", "?").toString();
        const TimeMap m = mapFrom(c, name);
        if (auto* probes = c.getProperty("probes", {}).getArray()) {
          for (auto& p : *probes) {
            expectEquals((juce::int64)m.heardOffsetOf(asInt64(p, "inner")),
                         (juce::int64)asInt64(p, "heard"),
                         name + " heardOffsetOf(" +
                             juce::String(asInt64(p, "inner")) + ")");
          }
        }
      }
    }

    beginTest("TimeMap (reified map: period / mapOffset / seamDistance)");
    if (auto* cases = root.getProperty("time_map_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const auto name = c.getProperty("name", "?").toString();
        const TimeMap m = mapFrom(c, name);
        expectEquals((juce::int64)m.period(),
                     (juce::int64)asInt64(c, "expectedPeriod"),
                     name + " (period)");
        if (auto* probes = c.getProperty("probes", {}).getArray()) {
          for (auto& p : *probes) {
            const auto h = juce::String(asInt64(p, "h"));
            expectEquals((juce::int64)m.mapOffset(asInt64(p, "h")),
                         (juce::int64)asInt64(p, "inner"),
                         name + " mapOffset(h=" + h + ")");
            expectEquals((juce::int64)m.seamDistance(asInt64(p, "h")),
                         (juce::int64)asInt64(p, "seam"),
                         name + " seamDistance(h=" + h + ")");
          }
        }
      }
    }

    beginTest("originQ (D-T3 physical/musical boundary projection)");
    if (auto* cases = root.getProperty("qtime_origin_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const auto name = c.getProperty("name", "?").toString();
        const QTime q = originQ(asInt64(c, "origin"), asInt64(c, "epoch"),
                                asInt64(c, "qSamples"));
        expectEquals((juce::int64)q.num, (juce::int64)asInt64(c, "expectedNum"),
                     "originQ num: " + name);
        expectEquals((juce::int64)q.den, (juce::int64)asInt64(c, "expectedDen"),
                     "originQ den: " + name);
        // The boundary must be lossless at the same exchange rate:
        // projecting to Q and back lands on the exact sample offset (I1).
        expectEquals((juce::int64)toSamples(q, asInt64(c, "qSamples")),
                     (juce::int64)(asInt64(c, "origin") - asInt64(c, "epoch")),
                     "originQ round-trip: " + name);
      }
    }
  }
};

static TimingGoldenTests timingGoldenTests;
