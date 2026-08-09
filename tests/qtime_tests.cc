/**
 * QTime tests (C++ side).
 *
 * Golden vectors: runs src/qtime.h against the qtime_* sections of
 * shared/timing_golden.json — the same vectors
 * ui/js/tests/qtime_golden.test.mjs runs against ui/js/qtime.js.
 *
 * Properties: the invariants the golden vectors can only sample —
 * normalization, exact round-trip (toSamples ∘ fromSamples = id),
 * monotonicity of the rounding law, and the tie rule.
 */

#include <juce_core/juce_core.h>

#include "../src/qtime.h"
#include "test_utils.h"

using celestrian::test_utils::asInt64;
using celestrian::test_utils::findSharedFile;

class QTimeTests : public juce::UnitTest {
 public:
  QTimeTests() : juce::UnitTest("QTime (rational musical time)") {}

  void runTest() override {
    using celestrian::timing::fromSamples;
    using celestrian::timing::qadd;
    using celestrian::timing::qcmp;
    using celestrian::timing::qeq;
    using celestrian::timing::qlcm;
    using celestrian::timing::qsub;
    using celestrian::timing::qtime;
    using celestrian::timing::QTime;
    using celestrian::timing::toSamples;

    beginTest("normalization invariants");
    {
      expect(qeq(qtime(2, 4), {1, 2}), "2/4 -> 1/2");
      expect(qeq(qtime(3, -6), {-1, 2}), "3/-6 -> -1/2 (den > 0)");
      expect(qeq(qtime(-3, -6), {1, 2}), "-3/-6 -> 1/2");
      expect(qeq(qtime(0, 5), {0, 1}), "0/5 -> canonical zero");
      expect(qeq(qtime(7, 0), {0, 1}), "den 0 -> canonical zero (guard)");
    }

    beginTest("golden vectors");
    auto file = findSharedFile("shared/timing_golden.json");
    expect(file.existsAsFile(), "shared/timing_golden.json not found");
    if (!file.existsAsFile()) return;
    auto root = juce::JSON::parse(file.loadFileAsString());

    if (auto* cases =
            root.getProperty("qtime_to_samples_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const QTime t = qtime(asInt64(c, "num"), asInt64(c, "den"));
        expectEquals((juce::int64)toSamples(t, asInt64(c, "qSamples")),
                     (juce::int64)asInt64(c, "expected"),
                     "toSamples: " + c.getProperty("name", "?").toString());
      }
    }

    if (auto* cases =
            root.getProperty("qtime_from_samples_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const QTime t =
            fromSamples(asInt64(c, "samples"), asInt64(c, "qSamples"));
        const auto name = c.getProperty("name", "?").toString();
        expectEquals((juce::int64)t.num, (juce::int64)asInt64(c, "expectedNum"),
                     "fromSamples num: " + name);
        expectEquals((juce::int64)t.den, (juce::int64)asInt64(c, "expectedDen"),
                     "fromSamples den: " + name);
      }
    }

    if (auto* cases = root.getProperty("qtime_lcm_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const QTime r = qlcm(qtime(asInt64(c, "aNum"), asInt64(c, "aDen")),
                             qtime(asInt64(c, "bNum"), asInt64(c, "bDen")));
        const auto name = c.getProperty("name", "?").toString();
        expectEquals((juce::int64)r.num, (juce::int64)asInt64(c, "expectedNum"),
                     "qlcm num: " + name);
        expectEquals((juce::int64)r.den, (juce::int64)asInt64(c, "expectedDen"),
                     "qlcm den: " + name);
      }
    }

    if (auto* cases = root.getProperty("qtime_arith_cases", {}).getArray()) {
      for (auto& c : *cases) {
        const QTime a = qtime(asInt64(c, "aNum"), asInt64(c, "aDen"));
        const QTime b = qtime(asInt64(c, "bNum"), asInt64(c, "bDen"));
        const bool isAdd = c.getProperty("op", "").toString() == "add";
        const QTime r = isAdd ? qadd(a, b) : qsub(a, b);
        const auto name = c.getProperty("name", "?").toString();
        expectEquals((juce::int64)r.num, (juce::int64)asInt64(c, "expectedNum"),
                     "arith num: " + name);
        expectEquals((juce::int64)r.den, (juce::int64)asInt64(c, "expectedDen"),
                     "arith den: " + name);
      }
    }

    beginTest("round-trip: toSamples(fromSamples(s)) == s exactly");
    {
      // fromSamples is exact by construction, so the round trip must be
      // the identity for every integer sample count — including awkward
      // rates and negative offsets. This is the I1-preservation property.
      const int64_t rates[] = {44100, 44101, 48000, 96000, 12345};
      for (int64_t q : rates) {
        for (int64_t s = -3; s <= 3; ++s) {
          const int64_t base[] = {0, 1, q / 8, q / 3, q - 1, q, 7 * q + 13};
          for (int64_t b : base) {
            const int64_t samples = b + s;
            expectEquals((juce::int64)toSamples(fromSamples(samples, q), q),
                         (juce::int64)samples,
                         "round trip s=" + juce::String(samples) +
                             " q=" + juce::String(q));
          }
        }
      }
    }

    beginTest("monotonicity of the rounding law");
    {
      // Sweep n/24 Q for n in [-48, 96]: toSamples must be
      // non-decreasing (a boundary later in music is never earlier in
      // samples), at an exchange rate not divisible by 24.
      const int64_t q = 44101;
      int64_t prev = toSamples(qtime(-48, 24), q);
      for (int64_t n = -47; n <= 96; ++n) {
        const int64_t cur = toSamples(qtime(n, 24), q);
        expect(cur >= prev, "monotone at n=" + juce::String(n));
        prev = cur;
      }
    }

    beginTest("tie rule: exact halves round toward +inf");
    {
      // q even: k + 1/2 Q is an exact half only when q/2 is odd… avoid
      // second-guessing — construct ties directly: t = (2k+1)/(2q) Q at
      // exchange rate q gives exactly k + 0.5 samples.
      const int64_t q = 44100;
      for (int64_t k : {int64_t(0), int64_t(5), int64_t(-6), int64_t(22049)}) {
        const QTime t = qtime(2 * k + 1, 2 * q);
        expectEquals((juce::int64)toSamples(t, q), (juce::int64)(k + 1),
                     "tie at k=" + juce::String(k) + " rounds up");
      }
    }

    beginTest("qcmp is exact");
    {
      expect(qcmp(qtime(1, 3), qtime(1, 2)) < 0, "1/3 < 1/2");
      expect(qcmp(qtime(2, 4), qtime(1, 2)) == 0, "2/4 == 1/2");
      expect(qcmp(qtime(-1, 2), qtime(-2, 3)) > 0, "-1/2 > -2/3");
    }
  }
};

static QTimeTests qtimeTests;
