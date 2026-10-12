/**
 * DISPLAY CONTRACT CAPTURE — "the grid you see is the grid you hear"
 * (docs/scenarios.md S30/S31).
 *
 * The engine gates a song's sections in one frame and the UI draws them
 * from the published state; the mock has no audio and the engine tests
 * do not ask what the lanes draw, so this is the seam that holds the
 * two to one frame. Drive the REAL engine through the
 * scenario harness, and for every gated clip measure — by SOLOING it
 * and listening — which Q cells of the island cycle it actually sounds
 * in (the AUDIBLE TRUTH, in the island frame the ruler draws). Dump the
 * published state alongside the truth table to
 * shared/display_contract_capture.json; ui/js/tests/display_contract.test.mjs
 * replays the state through the real deriveViewModel and asserts that
 * every lane is DIMMED exactly where the engine is silent.
 *
 * Scenario: 1Q, 4Q, then an 8Q take armed at phase 2Q after a full
 * cycle (a take off the island zero's phase); a root song 4Q + 4Q
 * gating the 1Q clip off in step 2; a group anchored at phase 2Q with
 * a 4Q member and its own 4Q + 4Q song gating that member off in step
 * 2 (a nested song folds from the GROUP's origin — Q18).
 *
 * Regenerate the fixture by running CelestrianTests (Debug binary).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <map>

#include "../src/audio_engine.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::BLOCK;
using scenario::Island;
using scenario::posmod;

namespace {
constexpr int64_t Q = 20000;

/** A two-step song gating `off_uuid` off in step 2. The steps carry no
 * name (scenario::seqPayload names its steps, and the capture publishes
 * step names). */
juce::var song(int64_t a, int64_t b, const juce::String& off_uuid) {
  auto* payload = new juce::DynamicObject();
  juce::Array<juce::var> arr;
  for (int64_t len : {a, b}) {
    auto* s = new juce::DynamicObject();
    s->setProperty("len", (double)len);
    arr.add(juce::var(s));
  }
  payload->setProperty("steps", arr);
  auto* g = new juce::DynamicObject();
  juce::Array<juce::var> bits;
  bits.add(true);
  bits.add(false);
  g->setProperty(off_uuid, bits);
  payload->setProperty("gates", juce::var(g));
  return juce::var(payload);
}
}  // namespace

class DisplayContractTests : public juce::UnitTest {
 public:
  DisplayContractTests()
      : juce::UnitTest("Display contract capture (see vs hear)", "Scenarios") {}

  void runTest() override {
    beginTest("audible truth per Q cell, captured for the view-model replay");
    Island is;
    const juce::String c1 = is.record(Q);
    const juce::String c2 = is.record(4 * Q);
    is.drive(4 * Q);
    is.driveToPhase(2 * Q);
    const juce::String c3 = is.record(8 * Q);
    expectEquals(is.cycle(), 8 * Q, "8Q island");
    const juce::String root = is.rootId();
    is.engine.setSequence(root, song(4 * Q, 4 * Q, c1));
    expectEquals(is.cycle(), 8 * Q, "the root song is the cycle");

    is.driveToPhase(2 * Q);
    const juce::String g = is.createStack();
    const juce::String c4 = is.record(4 * Q, g);
    expect(is.bprop(g, "anchored"), "the group is anchored");
    const int64_t E = is.zero();
    const int64_t Og = is.origin(g);
    expectEquals(posmod(Og - E, 8 * Q), 2 * Q, "the group sits at phase 2Q");
    is.engine.setSequence(g, song(4 * Q, 4 * Q, c4));
    expectEquals(is.cycle(), 8 * Q, "unchanged: lcm(8Q, 8Q)");

    // THE AUDIBLE TRUTH: solo one clip, listen one cycle, judge each Q
    // cell at its centre (away from the 10 ms gate ramps): the clip's
    // own loop value = ON, silence = OFF, anything else = a harness
    // fault. Cells are in the ISLAND frame — the ruler the lanes draw.
    const int cells = 8;
    std::map<juce::String, std::vector<bool>> truth;
    for (const juce::String& id : {c1, c2, c3, c4}) {
      is.engine.toggleSolo(id);
      is.refresh();
      std::vector<std::pair<int64_t, float>> out;
      is.drive(8 * Q + BLOCK, &out);
      std::vector<bool> row(cells, false);
      std::vector<bool> seen(cells, false);
      for (const auto& [t, v] : out) {
        const int64_t ph = posmod(t - E, 8 * Q);
        if (ph % Q != Q / 2) continue;
        const int cell = (int)(ph / Q);
        const float own = is.loopVal(id, t);
        const bool on = std::abs(v - own) < 1.0e-6f;
        const bool off = std::abs(v) < 1.0e-6f;
        expect(on != off, "cell " + juce::String(cell) + " of " + id +
                              " is either the clip or silence");
        row[(size_t)cell] = on;
        seen[(size_t)cell] = true;
      }
      for (int i = 0; i < cells; ++i) expect(seen[(size_t)i], "every cell judged");
      truth[id] = row;
      is.engine.toggleSolo(id);
    }
    // The laws, restated in the island frame (S30/S31): c1 off in the
    // root song's step 2 = cells 4–7; c4 off in the GROUP song's step 2
    // = cells 6, 7, 0, 1 (the group's origin is 2Q past the zero).
    const std::vector<bool> all_on(cells, true);
    expect(truth[c1] == std::vector<bool>{1, 1, 1, 1, 0, 0, 0, 0},
           "c1 sounds in root step 1 only (island frame)");
    expect(truth[c2] == all_on && truth[c3] == all_on, "ungated clips sound throughout");
    expect(truth[c4] == std::vector<bool>{0, 0, 1, 1, 1, 1, 0, 0},
           "c4 sounds in the group's step 1, which starts 2Q past the zero");

    // --- Dump for the JS replay ---
    auto* doc = new juce::DynamicObject();
    doc->setProperty("quantum", (double)Q);
    doc->setProperty("cycleQ", cells);
    doc->setProperty("groupId", g);
    doc->setProperty("groupPhaseQ", (double)posmod(Og - E, 8 * Q) / (double)Q);
    doc->setProperty("state", is.state());
    auto* tv = new juce::DynamicObject();
    for (const auto& [id, row] : truth) {
      juce::Array<juce::var> bits;
      for (bool b : row) bits.add(b);
      tv->setProperty(id, bits);
    }
    doc->setProperty("truth", juce::var(tv));
    const juce::var v(doc);
    auto outFile =
        test_utils::sharedCaptureFile("display_contract_capture.json");
    outFile.replaceWithText(juce::JSON::toString(v));
    logMessage("capture: " + outFile.getFullPathName());
  }
};

static DisplayContractTests displayContractTests;

}  // namespace celestrian
