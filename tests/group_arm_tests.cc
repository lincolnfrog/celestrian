/**
 * Group arm (Q7) and the I2 simultaneity invariant (design_language.md:
 * two sounds that play simultaneously must draw at the same x — here
 * pinned at the source: takes performed together COMMIT together,
 * sharing one origin and one duration).
 *
 * Canon under test:
 *  - Record is fractal: on a clip it records that clip; on a stack it
 *    records the stack's members — every EMPTY clip beneath it, armed
 *    in ONE engine call ("one performance, N microphones").
 *  - Arm targets emptiness: a committed member is never re-armed (it
 *    just plays); re-recording content is the *takes* feature.
 *  - One arm target, one committed duration: all takes of a group share
 *    the arm boundary and the stop boundary. (The first-take group, whose
 *    first commit establishes Q mid-stop, is scenario S10.)
 */
#include <juce_core/juce_core.h>

#include <memory>

#include "../src/audio_engine.h"
#include "test_utils.h"

namespace celestrian {

namespace {

constexpr int64_t Q = 44100;

/** An engine (on the heap) and the published facts the cases read. */
struct Rig {
  std::unique_ptr<AudioEngine> owned = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owned;

  void process(int64_t n) { test_utils::driveEngine(engine, n); }

  /** A committed 1Q clip at the top level: it establishes Q. */
  juce::String recordBase() {
    return test_utils::recordClip(engine, [&](int n) { process(n); }, Q);
  }
  /** A new top-level stack. */
  juce::String addStack() { return test_utils::addNode(engine, "stack"); }
  /** `count` more empty clips under `stack_id`; answers every clip there. */
  juce::StringArray addMembers(const juce::String& stack_id, int count) {
    for (int i = 0; i < count; ++i) engine.createNode("clip", stack_id);
    juce::StringArray ids;
    test_utils::clipIdsUnder(
        test_utils::findVar(engine.getGraphState(), stack_id), ids);
    return ids;
  }

  double prop(const juce::String& id, const char* key) {
    return test_utils::deepProp(engine, id, key);
  }
  /** Armed or capturing. */
  bool hot(const juce::String& id) {
    return test_utils::deepBool(engine, id, "isPendingStart") ||
           test_utils::deepBool(engine, id, "isRecording");
  }
  bool committed(const juce::String& id) {
    return !hot(id) && prop(id, "duration") > 0;
  }
  /** Drive until every one of `ids` has committed; answers whether. */
  bool settle(const juce::StringArray& ids) {
    const auto all = [&] {
      for (const auto& id : ids) {
        if (!committed(id)) return false;
      }
      return true;
    };
    for (int i = 0; i < 400 && !all(); ++i) process(512);
    return all();
  }
};

}  // namespace

class GroupArmTests : public juce::UnitTest {
 public:
  GroupArmTests() : juce::UnitTest("Group Arm (Q7)", "Audio Engine") {}

  void runTest() override {
    beginTest("Q7: arm targets emptiness - committed member just plays");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      const juce::String stack_id = rig.addStack();
      const juce::String base_id = rig.addMembers(stack_id, 1)[0];

      // Take 1 (group arm of a single empty member) establishes Q.
      engine.startRecordingInNode(stack_id);
      rig.process(Q);
      engine.stopRecordingInNode(stack_id);
      expect(rig.settle({base_id}), "base member committed");
      expectEquals(rig.prop(base_id, "duration"), (double)Q,
                   "base member committed at 1Q");

      // Two new empty members join the stack; arm the GROUP mid-cycle.
      const juce::StringArray all_ids = rig.addMembers(stack_id, 2);
      expectEquals(all_ids.size(), 3, "three members");
      const juce::String b_id = all_ids[1];
      const juce::String c_id = all_ids[2];

      rig.process(Q / 2);  // t = 1.5Q — mid-cycle click (Q11 pends the arm)
      engine.startRecordingInNode(stack_id);

      expect(!rig.hot(base_id),
             "committed member is NOT re-armed (arm targets emptiness)");
      expect(test_utils::deepBool(engine, b_id, "isPendingStart"),
             "empty member B armed");
      expect(test_utils::deepBool(engine, c_id, "isPendingStart"),
             "empty member C armed");

      rig.process(Q / 2);    // reach the 2Q boundary: both begin capture
      rig.process(Q - 200);  // capture just short of 1Q (stop boundary = 1Q)
      engine.stopRecordingInNode(stack_id);
      rig.process(400);  // audio thread picks the boundary and commits
      expect(rig.settle({b_id, c_id}), "both group takes committed");

      const double db = rig.prop(b_id, "duration");
      const double ob = rig.prop(b_id, "origin");
      expectEquals(rig.prop(c_id, "duration"), db,
                   "I2: one committed duration for the group");
      expectEquals(rig.prop(c_id, "origin"), ob,
                   "I2: one origin for the group");
      expectEquals(ob, (double)(2 * Q),
                   "group arm anchored at the shared next-Q boundary (Q11)");
      expectEquals(db, (double)Q, "one Q each, to the shared stop boundary");
      expectEquals(rig.prop(base_id, "duration"), (double)Q,
                   "committed member untouched by the group take");
      expect(!engine.hasActiveTake(), "take counter balanced");
    }

    beginTest("Direct arm on a committed clip is refused (takes != arm)");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = rig.recordBase();
      expect(rig.committed(id), "clip committed");
      const double committed_len = rig.prop(id, "duration");

      engine.startRecordingInNode(id);
      expect(!rig.hot(id),
             "committed clip stays Idle - re-recording is the takes feature");
      expect(!engine.hasActiveTake(), "no phantom take armed");
      expectEquals(rig.prop(id, "duration"), committed_len, "content untouched");
    }

    beginTest("Group stop while pending cancels the whole set");
    {
      Rig rig;
      AudioEngine& engine = rig.engine;
      rig.recordBase();  // Q
      const juce::String stack_id = rig.addStack();
      const juce::StringArray members = rig.addMembers(stack_id, 2);

      // Arm mid-cycle (both PEND), then stop before the boundary: a
      // group stop of armed-not-capturing takes is a group CANCEL.
      rig.process(Q / 4);
      engine.startRecordingInNode(stack_id);
      expect(engine.hasActiveTake(), "group take armed");
      for (const auto& id : members) expect(rig.hot(id), "member armed");
      engine.stopRecordingInNode(stack_id);
      expect(!engine.hasActiveTake(),
             "group cancel balances the take counter");
      for (const auto& id : members) {
        expect(!rig.hot(id), "member back to Idle after group cancel");
        expectEquals(rig.prop(id, "duration"), 0.0,
                     "cancelled member has no content");
      }
    }
  }
};

static GroupArmTests group_arm_tests;

}  // namespace celestrian
