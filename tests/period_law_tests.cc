/**
 * THE PERIOD LAW (src/period_law.h) against the `period_law_cases` tree
 * fixtures in shared/timing_golden.json — through BOTH providers: the
 * ownership tree (message thread) and the graph snapshot (audio
 * thread), each judging the drift clause (Q22) against the case's
 * `quantum`. ui/js/tests/period_law.test.mjs runs the same fixtures
 * through the JS twin.
 */

#include <juce_core/juce_core.h>

#include <map>
#include <memory>

#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/period_law.h"
#include "../src/sequence.h"
#include "../src/stack_node.h"
#include "test_utils.h"

using celestrian::test_utils::asInt64;
using celestrian::test_utils::findSharedFile;

namespace celestrian {

class PeriodLawTests : public juce::UnitTest {
 public:
  PeriodLawTests() : juce::UnitTest("Period law (one law, two providers)") {}

  /** Build the fixture node; every node registers itself by id. */
  std::unique_ptr<AudioNode> build(const juce::var& v,
                                   std::map<juce::String, AudioNode*>& by_id) {
    const juce::String id = v.getProperty("id", "?").toString();
    std::unique_ptr<AudioNode> node;
    if (v.getProperty("type", "").toString() == "clip") {
      auto clip = std::make_unique<ClipNode>(id, 44100.0);
      clip->duration_samples.store(asInt64(v, "duration"));
      node = std::move(clip);
    } else {
      auto stack = std::make_unique<StackNode>(id);
      if (auto* kids = v.getProperty("children", juce::var()).getArray()) {
        for (auto& k : *kids) stack->addChild(build(k, by_id));
      }
      if (v.hasProperty("sequenceLen")) {
        auto* seq = new Sequence();
        seq->steps.push_back({asInt64(v, "sequenceLen"), "song"});
        seq->finalize();
        delete stack->exchangeSequence(seq);
        // THE STEP AUDITION: its derived map is the step's span.
        if (v.hasProperty("audition"))
          stack->setAuditionStep((int)v.getProperty("audition", -1));
      }
      node = std::move(stack);
    }
    if (auto* w = v.getProperty("window", juce::var()).getArray();
        w != nullptr && w->size() == 2) {
      node->setLoopPoints((int64_t)(double)(*w)[0], (int64_t)(double)(*w)[1]);
      node->setLoopWindowBypassed(false);
    }
    if (v.getProperty("periodSource", "").toString() == "context") {
      node->period_from_context_.store(true);
    }
    by_id[id] = node.get();
    return node;
  }

  void runTest() override {
    beginTest("golden tree fixtures: tree provider == snapshot provider "
              "== expected");
    auto file = findSharedFile("shared/timing_golden.json");
    expect(file.existsAsFile(), "shared/timing_golden.json not found");
    if (!file.existsAsFile()) return;
    auto golden = juce::JSON::parse(file.loadFileAsString());
    auto* cases = golden.getProperty("period_law_cases", {}).getArray();
    expect(cases != nullptr, "period_law_cases present");
    if (cases == nullptr) return;

    for (auto& c : *cases) {
      const auto name = c.getProperty("name", "?").toString();
      std::map<juce::String, AudioNode*> by_id;
      StackNode root("root");
      if (auto* tree = c.getProperty("tree", juce::var()).getArray()) {
        for (auto& n : *tree) root.addChild(build(n, by_id));
      }
      by_id["root"] = &root;
      const int64_t quantum = asInt64(c, "quantum");
      const int64_t fallback = asInt64(c, "fallback");
      // The island Q the drift clause judges against reaches the
      // conveniences (ownPeriodOf / getEffectivePeriod) through the
      // root, as in a live island.
      root.setQuantum(quantum, 0);
      std::unique_ptr<GraphSnapshot> snap(buildGraphSnapshot(root));
      // Entry index of every node in the snapshot.
      std::map<const AudioNode*, int> entry_of;
      for (int i = 0; i < (int)snap->entries.size(); ++i) {
        entry_of[snap->entries[(size_t)i].node] = i;
      }
      const period_law::TreeProvider tp{quantum};
      const SnapProvider sp{*snap, quantum};

      auto* expected = c.getProperty("expected", juce::var()).getDynamicObject();
      if (expected != nullptr) {
        for (const auto& kv : expected->getProperties()) {
          const juce::String id = kv.name.toString();
          const AudioNode* node = by_id[id];
          expect(node != nullptr, name + ": fixture node " + id);
          if (node == nullptr) continue;
          const int64_t want_own = asInt64(kv.value, "own");
          const int64_t want_contribution = asInt64(kv.value, "contribution");
          expectEquals((juce::int64)period_law::ownPeriod(tp, node),
                       (juce::int64)want_own, name + ": tree own(" + id + ")");
          expectEquals((juce::int64)period_law::contribution(tp, node),
                       (juce::int64)want_contribution,
                       name + ": tree contribution(" + id + ")");
          expectEquals((juce::int64)period_law::ownPeriodOf(*node),
                       (juce::int64)want_own,
                       name + ": ownPeriodOf(" + id + ") reads the island Q");
          expectEquals((juce::int64)period_law::contributionOf(*node),
                       (juce::int64)want_contribution,
                       name + ": contributionOf(" + id + ") reads the island Q");
          const int idx = entry_of[node];
          expectEquals((juce::int64)period_law::ownPeriod(sp, idx),
                       (juce::int64)want_own, name + ": snap own(" + id + ")");
          expectEquals((juce::int64)period_law::contribution(sp, idx),
                       (juce::int64)want_contribution,
                       name + ": snap contribution(" + id + ")");
          expectEquals((juce::int64)snapEffectivePeriod(*snap, idx, quantum),
                       (juce::int64)want_own,
                       name + ": snapEffectivePeriod(" + id + ")");
          expectEquals((juce::int64)snapPeriodContribution(*snap, idx, quantum),
                       (juce::int64)want_contribution,
                       name + ": snapPeriodContribution(" + id + ")");
          expectEquals((juce::int64)node->getEffectivePeriod(),
                       (juce::int64)want_own,
                       name + ": getEffectivePeriod(" + id + ") is own");
          // THE DRIFT PREDICATE agrees on both providers: a node drifts
          // iff it looped (not a one-shot, not skipped) yet contributes
          // nothing while playing a period.
          const bool want_drift = !node->periodFromContext() &&
                                  want_own > 0 && want_contribution == 0;
          expect(period_law::drifts(tp, node) == want_drift,
                 name + ": tree drifts(" + id + ")");
          expect(period_law::drifts(sp, idx) == want_drift,
                 name + ": snap drifts(" + id + ")");
        }
      }
      const int64_t want_cycle = asInt64(c, "islandCycle");
      expectEquals(
          (juce::int64)period_law::islandCycle(tp, &root, quantum, fallback),
          (juce::int64)want_cycle, name + ": tree island cycle");
      expectEquals((juce::int64)snapEffectiveCycle(*snap, quantum, fallback),
                   (juce::int64)want_cycle, name + ": snap island cycle");

      if (c.hasProperty("skip")) {
        const AudioNode* skipped = by_id[c.getProperty("skip", "").toString()];
        expect(skipped != nullptr, name + ": skip node");
        if (skipped != nullptr) {
          expectEquals((juce::int64)period_law::ownPeriodOf(root, skipped),
                       (juce::int64)asInt64(c, "rootOwnSkipping"),
                       name + ": own(root) skipping " +
                           c.getProperty("skip", "").toString());
        }
      }
    }
  }
};

static PeriodLawTests periodLawTests;

}  // namespace celestrian
