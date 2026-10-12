/**
 * Loop-region laws at the island's edges (docs/loop_region_audit.md §5):
 *  - a first take scrubs pre-Q geometry the grid it establishes cannot
 *    carry;
 *  - only geometry wins: a definer re-trims Q only while no other node
 *    has geometry in use (a bypassed map is not in use).
 * (An undo across a seek keeps every track on the grid: scenario S43.)
 */

#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "scenario_utils.h"
#include "test_utils.h"

using celestrian::scenario::mapOf;
using celestrian::test_utils::deepProp;
using celestrian::test_utils::rootProp;
using celestrian::test_utils::driveEngine;

namespace {

const int64_t D = 40960;  // 80 blocks of 512

/** An engine (on the heap) whose island the cases build node by node. */
struct Rig {
  std::unique_ptr<AudioEngine> owned = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owned;

  /** A new empty top-level node of `type`. */
  juce::String add(const char* type) {
    return celestrian::test_utils::addNode(engine, type);
  }
  /** A first take of exactly D samples on a new clip: Q := D. */
  juce::String firstTake() {
    const juce::String id = add("clip");
    engine.startRecordingInNode(id);
    driveEngine(engine, D);
    engine.stopRecordingInNode(id);
    driveEngine(engine, 1024);
    return id;
  }
  int64_t loopEnd(const juce::String& id) {
    return (int64_t)deepProp(engine, id, "loopEnd");
  }
};

}  // namespace

class AuditRegressionTests : public juce::UnitTest {
 public:
  AuditRegressionTests() : juce::UnitTest("Loop region regressions") {}

  void runTest() override {
    beginTest("Q-establishment scrub: a pre-Q incoherent window is cleared");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      // Author a window on an empty stack BEFORE any take (legal: the
      // nested-maps arm refusal is pinned on pre-Q authoring).
      const juce::String s1 = rig.add("stack");
      engine.setLoopPoints(s1, 0, 12345);  // no Q yet: length is free
      expectEquals(rig.loopEnd(s1), (int64_t)12345, "pre-Q window accepted");

      // First take elsewhere establishes Q = D — 12345 cannot live on
      // that grid (neither multiple nor divisor), so it is scrubbed.
      rig.firstTake();
      expectEquals(rootProp(engine, "quantum"), D, "Q established");
      expect(rig.loopEnd(s1) <= (int64_t)deepProp(engine, s1, "loopStart"),
             "incoherent pre-Q window scrubbed at establishment");
    }

    beginTest("ONLY GEOMETRY WINS: Q13 re-trim refused under sibling geometry");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      // Sole committed clip = the provisional definer.
      const juce::String a2 = rig.firstTake();
      expectEquals(rootProp(engine, "quantum"), D, "Q := D");

      // A sibling empty stack carries a COHERENT authored window.
      const juce::String s1 = rig.add("stack");
      engine.setLoopPoints(s1, 0, D / 2);
      expectEquals(rig.loopEnd(s1), D / 2, "coherent sibling window accepted");

      // A definer re-trim would strand that window off-grid: with the
      // sibling geometry present this is an ORDINARY window edit — the
      // coherence guard refuses the off-grid length and Q holds.
      engine.setLoopPoints(a2, 0, (D / 4) * 3);
      expectEquals(rootProp(engine, "quantum"), D,
                   "no re-establishment under sibling geometry");
      expectEquals(rig.loopEnd(a2), (int64_t)0, "the off-grid length is refused");
      // A coherent trim still lands as a plain window.
      engine.setLoopPoints(a2, 0, D / 2);
      expectEquals(rootProp(engine, "quantum"), D, "Q still locked");
      expectEquals(rig.loopEnd(a2), D / 2, "plain window landed");
      // Clear the sibling geometry: the definer power returns.
      engine.setLoopPoints(s1, 0, 0);
      engine.setLoopPoints(a2, 0, D / 4);
      expectEquals(rootProp(engine, "quantum"), D / 4,
                   "re-establishment returns once the island is clean");
    }

    beginTest("ONLY GEOMETRY WINS: a BYPASSED sibling map is not in use - "
              "a cut map exactly as a window");
    for (const bool cut_map : {false, true}) {
      Rig rig;
      AudioEngine& engine = rig.engine;
      const juce::String definer = rig.firstTake();
      const juce::String sibling = rig.add("stack");
      if (cut_map) {
        engine.setSegments(sibling, mapOf({{0, D / 4}, {D / 2, 3 * D / 4}}));
      } else {
        engine.setLoopPoints(sibling, 0, D / 2);
      }
      const juce::String label = cut_map ? "a cut map: " : "a window: ";
      const auto definerId = [&] {
        return engine.getGraphState().getProperty("definerId", "").toString();
      };
      expectEquals(definerId(), juce::String(),
                   label + "live sibling geometry: no definer");
      engine.toggleLoopWindow(sibling);
      expectEquals(definerId(), definer,
                   label + "bypassed, it is not in use: the clip defines Q");
      engine.setLoopPoints(definer, 0, D / 4);
      expectEquals(rootProp(engine, "quantum"), D / 4,
                   label + "and its trim re-establishes Q");
    }
  }
};

static AuditRegressionTests auditRegressionTests;
