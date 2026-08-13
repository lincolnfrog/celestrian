/**
 * Group arm (Q7, owner ruling 2026-07-09) + the I2 simultaneity
 * invariant (design_language.md: two sounds that play simultaneously
 * must draw at the same x — here pinned at the source: takes performed
 * together must COMMIT together, sharing one origin and one duration).
 *
 * Canon under test:
 *  - Record is fractal: on a clip it records that clip; on a stack it
 *    records the stack's members — every EMPTY clip beneath it, armed
 *    in ONE engine call ("one performance, N microphones").
 *  - Arm targets emptiness: a committed member is never re-armed (it
 *    just plays); re-recording content is the *takes* feature.
 *  - One arm target, one committed duration: all takes of a group share
 *    the arm boundary and the stop boundary — including the first-take
 *    case, where the first commit establishes Q mid-stop and must not
 *    flip its siblings onto the record-to-next-boundary path.
 */
#include <juce_core/juce_core.h>

#include "../src/audio_engine.h"
#include "test_utils.h"

namespace celestrian {

class GroupArmTests : public juce::UnitTest {
 public:
  GroupArmTests() : juce::UnitTest("Group Arm (Q7)", "Audio Engine") {}

  // --- metadata helpers (gotcha 4: keep vars in locals) ---

  /** Depth-first search of the published state for a node var by id. */
  static juce::var findVar(const juce::var& node, const juce::String& id) {
    if (node.getProperty("id", "").toString() == id) return node;
    if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
      for (auto& k : *kids) {
        juce::var hit = findVar(k, id);
        if (!hit.isVoid()) return hit;
      }
    }
    return {};
  }

  /** All clip ids under `id` (document order). */
  static void clipIdsUnder(const juce::var& node, juce::StringArray& out) {
    if (node.getProperty("type", "").toString() == "clip") {
      out.add(node.getProperty("id", "").toString());
      return;
    }
    if (auto* kids = node.getProperty("nodes", juce::var()).getArray()) {
      for (auto& k : *kids) clipIdsUnder(k, out);
    }
  }

  static juce::var stateOf(AudioEngine& engine) {
    return engine.getGraphState();
  }

  static juce::String lastTopLevelId(AudioEngine& engine) {
    const juce::var state = stateOf(engine);
    auto* nodes = test_utils::nodesOf(state);
    if (nodes == nullptr || nodes->isEmpty()) return {};
    return nodes->getLast().getProperty("id", "").toString();
  }

  static double propOf(AudioEngine& engine, const juce::String& id,
                       const juce::String& key) {
    const juce::var state = stateOf(engine);
    const juce::var node = findVar(state, id);
    return (double)node.getProperty(key, 0.0);
  }

  static bool boolOf(AudioEngine& engine, const juce::String& id,
                     const juce::String& key) {
    const juce::var state = stateOf(engine);
    const juce::var node = findVar(state, id);
    return (bool)node.getProperty(key, false);
  }

  static bool isCommitted(AudioEngine& engine, const juce::String& id) {
    return !boolOf(engine, id, "isRecording") &&
           !boolOf(engine, id, "isPendingStart") &&
           propOf(engine, id, "duration") > 0;
  }

  static bool allCommitted(AudioEngine& engine, const juce::StringArray& ids) {
    for (const auto& id : ids) {
      if (!isCommitted(engine, id)) return false;
    }
    return true;
  }

  void runTest() override {
    constexpr int64_t Q = 44100;

    // =====================================================================
    beginTest("I2: first-take group arm — one origin, one duration, one Q");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };

      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      expect(stack_id.isNotEmpty(), "stack created");
      for (int i = 0; i < 3; ++i) engine.createNode("clip", stack_id);

      juce::StringArray clip_ids;
      {
        const juce::var state = stateOf(engine);
        const juce::var stack = findVar(state, stack_id);
        clipIdsUnder(stack, clip_ids);
      }
      expectEquals(clip_ids.size(), 3, "three empty members");

      // ONE call arms the whole set (the drum-mic case).
      engine.startRecordingInNode(stack_id);
      process(Q);
      // ONE call stops the whole set. First-take group stop: the first
      // commit establishes Q — the Q-at-stop snapshot must keep the
      // siblings on the same immediate-commit path (see
      // ClipNode::stopRecording(bool)).
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 40 && !allCommitted(engine, clip_ids); ++i) {
        process(512);
      }
      expect(allCommitted(engine, clip_ids), "all three takes committed");

      const double d0 = propOf(engine, clip_ids[0], "duration");
      const double o0 = propOf(engine, clip_ids[0], "origin");
      expectEquals(d0, (double)Q, "first-take duration defines Q");
      for (const auto& id : clip_ids) {
        expectEquals(propOf(engine, id, "duration"), d0,
                     "I2: one committed duration for the group");
        expectEquals(propOf(engine, id, "origin"), o0,
                     "I2: one origin for the group");
      }
      const juce::var state = stateOf(engine);
      expectEquals((double)state.getProperty("quantum", 0.0), d0,
                   "island Q established once, from the shared take");
      expect(!engine.hasActiveTake(), "take counter balanced (3 arm/3 commit)");
    }

    // =====================================================================
    beginTest("Q7: arm targets emptiness — committed member just plays");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };

      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      juce::StringArray first;
      {
        const juce::var state = stateOf(engine);
        const juce::var stack = findVar(state, stack_id);
        clipIdsUnder(stack, first);
      }
      const juce::String base_id = first[0];

      // Take 1 (group arm of a single empty member) establishes Q.
      engine.startRecordingInNode(stack_id);
      process(Q);
      engine.stopRecordingInNode(stack_id);
      for (int i = 0; i < 40 && !isCommitted(engine, base_id); ++i) {
        process(512);
      }
      expectEquals(propOf(engine, base_id, "duration"), (double)Q,
                   "base member committed at 1Q");

      // Two new empty members join the stack; arm the GROUP mid-cycle.
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray all_ids;
      {
        const juce::var state = stateOf(engine);
        const juce::var stack = findVar(state, stack_id);
        clipIdsUnder(stack, all_ids);
      }
      expectEquals(all_ids.size(), 3, "three members");
      const juce::String b_id = all_ids[1];
      const juce::String c_id = all_ids[2];

      process(Q / 2);  // t = 1.5Q — mid-cycle click (Q11 pends the arm)
      engine.startRecordingInNode(stack_id);

      expect(!boolOf(engine, base_id, "isPendingStart") &&
                 !boolOf(engine, base_id, "isRecording"),
             "committed member is NOT re-armed (arm targets emptiness)");
      expect(boolOf(engine, b_id, "isPendingStart"), "empty member B armed");
      expect(boolOf(engine, c_id, "isPendingStart"), "empty member C armed");

      process(Q / 2);      // reach the 2Q boundary: both begin capture
      process(Q - 200);    // capture just short of 1Q (stop boundary = 1Q)
      engine.stopRecordingInNode(stack_id);
      process(400);        // audio thread picks the boundary and commits
      juce::StringArray new_ids;
      new_ids.add(b_id);
      new_ids.add(c_id);
      for (int i = 0; i < 400 && !allCommitted(engine, new_ids); ++i) {
        process(512);
      }
      expect(allCommitted(engine, new_ids), "both group takes committed");

      const double db = propOf(engine, b_id, "duration");
      const double ob = propOf(engine, b_id, "origin");
      expectEquals(propOf(engine, c_id, "duration"), db,
                   "I2: one committed duration for the group");
      expectEquals(propOf(engine, c_id, "origin"), ob,
                   "I2: one origin for the group");
      expectEquals(ob, (double)(2 * Q),
                   "group arm anchored at the shared next-Q boundary (Q11)");
      expectEquals(propOf(engine, base_id, "duration"), (double)Q,
                   "committed member untouched by the group take");
      expect(!engine.hasActiveTake(), "take counter balanced");
    }

    // =====================================================================
    beginTest("Direct arm on a committed clip is refused (takes ≠ arm)");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };

      const juce::String id = test_utils::recordClip(engine, process, Q);
      expect(isCommitted(engine, id), "clip committed");
      const double committed_len = propOf(engine, id, "duration");

      engine.startRecordingInNode(id);
      expect(!boolOf(engine, id, "isPendingStart") &&
                 !boolOf(engine, id, "isRecording"),
             "committed clip stays Idle — re-recording is the takes feature");
      expect(!engine.hasActiveTake(), "no phantom take armed");
      expectEquals(propOf(engine, id, "duration"), committed_len,
                   "content untouched");
    }

    // =====================================================================
    beginTest("Group stop while pending cancels the whole set");
    {
      AudioEngine engine;
      auto process = [&](int64_t n) { test_utils::driveEngine(engine, n); };

      // Establish Q with a plain clip first.
      const juce::String base_id = test_utils::recordClip(engine, process, Q);

      engine.createNode("stack");
      const juce::String stack_id = lastTopLevelId(engine);
      engine.createNode("clip", stack_id);
      engine.createNode("clip", stack_id);
      juce::StringArray members;
      {
        const juce::var state = stateOf(engine);
        const juce::var stack = findVar(state, stack_id);
        clipIdsUnder(stack, members);
      }

      // Arm mid-cycle (both PEND), then stop before the boundary: a
      // group stop of armed-not-capturing takes is a group CANCEL.
      process(Q / 4);
      engine.startRecordingInNode(stack_id);
      expect(engine.hasActiveTake(), "group take armed");
      engine.stopRecordingInNode(stack_id);
      expect(!engine.hasActiveTake(),
             "group cancel balances the take counter");
      for (const auto& id : members) {
        expect(!boolOf(engine, id, "isPendingStart") &&
                   !boolOf(engine, id, "isRecording"),
               "member back to Idle after group cancel");
        expectEquals(propOf(engine, id, "duration"), 0.0,
                     "cancelled member has no content");
      }
    }
  }
};

static GroupArmTests group_arm_tests;

}  // namespace celestrian
