/**
 * THE PERIOD LAW (src/period_law.h) against the `period_law_cases` tree
 * fixtures in shared/timing_golden.json — through BOTH providers: the
 * ownership tree (message thread) and the graph snapshot (audio
 * thread), each judging the drift clause (Q22) against the case's
 * `quantum`. ui/js/tests/period_law.test.mjs runs the same fixtures
 * through the JS twin. The scope cycle's value form runs against
 * `scope_cycle_cases`, as ui/js/tests/scope_cycle.test.mjs runs its
 * twin.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <map>
#include <memory>
#include <vector>

#include "../src/clip_node.h"
#include "../src/graph_snapshot.h"
#include "../src/heard_index.h"
#include "../src/period_law.h"
#include "../src/sequence.h"
#include "../src/stack_node.h"
#include "test_utils.h"

using celestrian::test_utils::asInt64;
using celestrian::test_utils::findSharedFile;

namespace celestrian {

class PeriodLawTests : public juce::UnitTest {
 public:
  PeriodLawTests()
      : juce::UnitTest("Period law (one law, two providers)", "Golden") {}

  /** A leaf that records the context its parent hands it in control —
   * what the audio thread actually passes down. An empty clip: it plays
   * nothing, so it adds nothing to any fold. */
  struct ProbeNode : public ClipNode {
    ProbeNode() : ClipNode("Probe") {}
    ProcessContext seen{};
    void control(const float* const*, int, const ProcessContext& ctx) override {
      seen = ctx;
    }
    void render(float* const*, int, const ProcessContext&) const override {}
  };

  /** A fixture clip with a take being captured into it (`recording`). */
  struct LiveTake {
    ClipNode* clip = nullptr;
    int64_t captured = 0;  // samples of the take captured so far
  };

  /** Build the fixture node; every node registers itself by id, and a
   * `recording` clip in `live`. */
  std::unique_ptr<AudioNode> build(const juce::var& v,
                                   std::map<juce::String, AudioNode*>& by_id,
                                   std::vector<LiveTake>& live) {
    const juce::String id = v.getProperty("id", "?").toString();
    std::unique_ptr<AudioNode> node;
    if (v.getProperty("type", "").toString() == "clip") {
      auto clip = std::make_unique<ClipNode>(id, 44100.0);
      clip->duration_samples.store(asInt64(v, "duration"));
      if ((bool)v.getProperty("recording", false)) {
        live.push_back({clip.get(), asInt64(v, "captured")});
      }
      node = std::move(clip);
    } else {
      auto stack = std::make_unique<StackNode>(id);
      if (auto* kids = v.getProperty("children", juce::var()).getArray()) {
        for (auto& k : *kids) stack->addChild(build(k, by_id, live));
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

  /** Bring `take.clip` to the state the fixture names — a take being
   * captured into it, `captured` samples in — as the engine does: the
   * message thread arms it (a committed slot is re-taken and keeps its
   * period; an empty clip prepares its first take) and the audio
   * thread's control starts the capture. The clock stands at the island
   * zero, the top of every fixture slot, so one block of `captured`
   * samples is the whole take so far. */
  void capture(StackNode& root, const LiveTake& take,
               const juce::String& name) {
    ClipNode& clip = *take.clip;
    const juce::String who = name + ": " + clip.getName();
    const int64_t committed = clip.getIntrinsicDuration();
    expect(committed > 0 ? clip.mayRetake() : clip.mayRecord(),
           who + " may arm");
    committed > 0 ? clip.prepareRetake() : clip.prepareRecording();
    clip.publishArm();
    test_utils::NodeContext nc =
        test_utils::contextFor(root, (int)take.captured);
    nc.driveFrom(clip);
    clip.control(nullptr, 0, nc.ctx);
    expect(clip.isRecording(), who + " is capturing");
    expectEquals((juce::int64)clip.live_duration_samples.load(),
                 (juce::int64)take.captured, who + ": the live count");
    expectEquals((juce::int64)clip.getIntrinsicDuration(),
                 (juce::int64)committed, who + ": the committed length");
  }

  void runTest() override {
    testScopeCycle();

    beginTest("golden: the scope cycle, from a stack's own period");
    auto file = findSharedFile("shared/timing_golden.json");
    expect(file.existsAsFile(), "shared/timing_golden.json not found");
    if (!file.existsAsFile()) return;
    auto golden = juce::JSON::parse(file.loadFileAsString());
    auto* scope_cases = golden.getProperty("scope_cycle_cases", {}).getArray();
    expect(scope_cases != nullptr && !scope_cases->isEmpty(),
           "scope_cycle_cases present");
    if (scope_cases != nullptr) {
      for (auto& c : *scope_cases) {
        expectEquals(
            (juce::int64)period_law::scopeCycle(
                asInt64(c, "own"), (bool)c.getProperty("authored", false),
                asInt64(c, "quantum"), asInt64(c, "received")),
            (juce::int64)asInt64(c, "expected"),
            c.getProperty("name", "?").toString());
      }
    }

    beginTest("golden tree fixtures: tree provider == snapshot provider "
              "== expected");
    auto* cases = golden.getProperty("period_law_cases", {}).getArray();
    expect(cases != nullptr && !cases->isEmpty(), "period_law_cases present");
    if (cases == nullptr) return;

    for (auto& c : *cases) {
      const auto name = c.getProperty("name", "?").toString();
      std::map<juce::String, AudioNode*> by_id;
      std::vector<LiveTake> live;
      StackNode root("root");
      if (auto* tree = c.getProperty("tree", juce::var()).getArray()) {
        for (auto& n : *tree) root.addChild(build(n, by_id, live));
      }
      by_id["root"] = &root;
      const int64_t quantum = asInt64(c, "quantum");
      const int64_t fallback = asInt64(c, "fallback");
      // The island Q the drift clause judges against reaches the
      // conveniences (ownPeriodOf / getEffectivePeriod) through the
      // root, as in a live island.
      root.setQuantum(quantum, 0);
      for (const LiveTake& take : live) capture(root, take, name);
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
          // THE SCOPE CYCLE a stack hands its children follows from its
          // own period — the same answer over both providers.
          if (node->getNodeType() == NodeType::Stack) {
            const int64_t received = 7777777;  // the cycle it was handed
            const bool authored = node->activeTimeMap().active() ||
                                  node->activeSequenceLen() > 0;
            const int64_t want_scope =
                want_own <= 0 ? received
                : (authored || quantum <= 0) ? want_own
                                             : timing::lcm(quantum, want_own);
            expectEquals(
                (juce::int64)period_law::scopeCycle(tp, node, received),
                (juce::int64)want_scope, name + ": tree scope cycle(" + id + ")");
            expectEquals(
                (juce::int64)period_law::scopeCycle(sp, idx, received),
                (juce::int64)want_scope, name + ": snap scope cycle(" + id + ")");
          }
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

  /** The cycle a stack's children RECEIVE — observed in the context the
   * audio thread hands a probe child — is period_law::scopeCycle, and
   * heard::childScopeOf composes the same value. */
  void testScopeCycle() {
    beginTest("the scope cycle: the context a stack's children receive, "
              "the law over the snapshot, and heard:: agree");
    constexpr int64_t kQ = 1000;
    constexpr int64_t kReceived = 7777777;
    const auto loop = [](const char* name, int64_t len) {
      auto clip = std::make_unique<ClipNode>(name, 44100.0);
      clip->duration_samples.store(len);
      return clip;
    };
    const auto check = [&](const juce::String& name, int64_t quantum,
                           const std::function<void(StackNode&)>& shape,
                           int64_t want) {
      StackNode root("root");
      root.setQuantum(quantum, 0);
      auto group = std::make_unique<StackNode>("group");
      StackNode* g = group.get();
      auto probe = std::make_unique<ProbeNode>();
      ProbeNode* p = probe.get();
      group->addChild(std::move(probe));
      shape(*g);
      root.addChild(std::move(group));

      test_utils::NodeContext nc = test_utils::contextFor(root, 16);
      nc.driveFrom(*g);
      nc.ctx.context_cycle = kReceived;
      g->control(nullptr, 0, nc.ctx);
      expectEquals((juce::int64)p->seen.context_cycle, (juce::int64)want,
                   name + ": the context the children receive");
      expectEquals((juce::int64)period_law::scopeCycle(
                       SnapProvider{*nc.snap, quantum}, nc.ctx.self, kReceived),
                   (juce::int64)want, name + ": the law over the snapshot");
      const heard::Scope scope{0, kReceived, quantum};
      expectEquals((juce::int64)heard::childScopeOf(*g, scope, 0,
                                                    g->activeTimeMap())
                       .context_cycle,
                   (juce::int64)want, name + ": heard::childScopeOf");
    };

    check("looping content on the grid", kQ,
          [&](StackNode& g) { g.addChild(loop("a", 3 * kQ)); }, 3 * kQ);
    check("a loop that divides Q folds up to Q", kQ,
          [&](StackNode& g) { g.addChild(loop("a", kQ / 2)); }, kQ);
    check("no grid: the content's own period", 0,
          [&](StackNode& g) { g.addChild(loop("a", 1500)); }, 1500);
    check("a drifting loop extends nothing: the received cycle", 2 * kQ,
          [&](StackNode& g) { g.addChild(loop("a", 3 * kQ)); }, kReceived);
    check("a map: one map pass, whatever Q is", 3 * kQ, [&](StackNode& g) {
      g.addChild(loop("a", 8 * kQ));
      g.setLoopPoints(0, 2 * kQ);
    }, 2 * kQ);
    check("a song: the whole song", kQ, [&](StackNode& g) {
      g.addChild(loop("a", 2 * kQ));
      auto* song = new Sequence();
      song->steps.push_back({5 * kQ, "song"});
      song->finalize();
      delete g.exchangeSequence(song);
    }, 5 * kQ);
    check("only one-shots: the received cycle", kQ, [&](StackNode& g) {
      auto shot = loop("shot", 2 * kQ);
      shot->period_from_context_.store(true);
      g.addChild(std::move(shot));
    }, kReceived);
    check("empty: the received cycle", kQ, [](StackNode&) {}, kReceived);
  }
};

static PeriodLawTests periodLawTests;

}  // namespace celestrian
