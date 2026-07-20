/**
 * D4 — the recording wall is gone. Take capacity is a VIRTUAL
 * reservation made at arm (address space only; the OS commits pages as
 * capture writes), so memory cost tracks the recorded material and the
 * machine is the only real limit. Pinned here:
 *   - takes far beyond the old 60 s wall commit intact,
 *   - post-commit compaction returns the reservation with audio
 *     bit-identical (atomic content swap under a playing clip),
 *   - the integrity guard at the reservation bound finishes CLEANLY,
 *   - a lock-collapsed definer keeps its full material through
 *     compaction (uncollapse intact).
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <set>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"

namespace celestrian {

namespace {
juce::Array<juce::var>* nodesOf(const juce::var& s) {
  return s.getProperty("nodes", juce::var()).getArray();
}
juce::var clipVar(AudioEngine& e, const juce::String& uuid) {
  const juce::var s = e.getGraphState();
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid) return x;
  return {};
}
bool clipCommitted(AudioEngine& e, const juce::String& uuid) {
  const auto v = clipVar(e, uuid);
  return !(bool)v.getProperty("isRecording", false) &&
         (double)v.getProperty("duration", 0) > 0;
}
juce::String recordClip(AudioEngine& e, std::function<void(int)> process,
                        int64_t lengthSamples) {
  std::set<juce::String> before;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) before.insert(x.getProperty("id", "").toString());
  }
  e.createNode("clip");
  juce::String id;
  {
    const juce::var s = e.getGraphState();
    if (auto* n = nodesOf(s))
      for (auto& x : *n) {
        auto i = x.getProperty("id", "").toString();
        if (!before.count(i)) id = i;
      }
  }
  e.startRecordingInNode(id);
  process(100);
  process((int)lengthSamples);
  e.stopRecordingInNode(id);
  for (int i = 0; i < 400 && !clipCommitted(e, id); ++i) process(512);
  return id;
}
ClipNode* clipPtr(AudioEngine& e, const juce::String& uuid) {
  // White-box: tests may reach the node for capacity checks.
  return dynamic_cast<ClipNode*>(
      e.currentGraphSnapshotForTest()->entries[0].node->findByUuid(uuid));
}
}  // namespace

class TakeCapacityTests : public juce::UnitTest {
 public:
  TakeCapacityTests() : juce::UnitTest("Take capacity (D4: no wall)") {}

  void runTest() override {
    const int BLOCK = 512;
    std::vector<float> buf(BLOCK, 0.1f);
    auto makeProcess = [&](AudioEngine& e) {
      return [&e, &buf, BLOCK](int total) {
        float* ins[] = {buf.data()};
        float* outs[] = {buf.data(), buf.data()};
        int remaining = total;
        while (remaining > 0) {
          int n = std::min(remaining, BLOCK);
          e.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
    };

    beginTest("a take far beyond the old 60 s wall commits intact");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      // 70 "seconds" at the default 44.1k test rate — the old fixed
      // buffer silently stopped writing at 60.
      const int64_t len = (int64_t)(70.5 * 44100);
      auto c1 = recordClip(engine, process, len);
      const int64_t dur =
          (int64_t)(double)clipVar(engine, c1).getProperty("duration", 0);
      expect(dur > (int64_t)(65.0 * 44100),
             "committed well past the old wall");
      expect(clipPtr(engine, c1)->contentCapacity() >=
                 ClipNode::kMaxTakeSamples,
             "arm-time virtual reservation in place");

      // Compaction: reservation returns, audio identical.
      const auto peaksBefore =
          juce::JSON::toString(engine.getWaveform(c1, 200));
      engine.compactIdleTakes();
      expectEquals(clipPtr(engine, c1)->contentCapacity(),
                   clipPtr(engine, c1)->recordedLength(),
                   "capacity == recorded material after compaction");
      expectEquals(juce::JSON::toString(engine.getWaveform(c1, 200)),
                   peaksBefore, "audio identical through the swap");
    }

    beginTest("the reservation bound finishes CLEANLY (integrity guard)");
    {
      // Node-level: shrink the reservation to a toy size and run the
      // pre-Q first-take path into the wall.
      ClipNode clip("wall-clip", 1000.0);
      clip.startRecording();
      clip.contentForTest().setSize(1, 3000, false, true, false);
      std::vector<float> in((size_t)BLOCK, 0.25f);
      float* ins[] = {in.data()};
      ProcessContext ctx;
      ctx.num_samples = BLOCK;
      ctx.is_recording = true;
      for (int i = 0; i < 10 && clip.recState() != ClipNode::RecState::Idle;
           ++i) {
        clip.control(ins, 1, ctx);
        ctx.master_pos += BLOCK;
        ctx.input_clock += BLOCK;
      }
      expect(clip.recState() == ClipNode::RecState::Idle,
             "auto-committed at the wall — never a zombie");
      expect(clip.capHit(), "the cap-hit fact is surfaced");
      expectEquals(clip.getIntrinsicDuration(), clip.recordedLength(),
                   "clean commit: duration == written material");
      expect(clip.getIntrinsicDuration() > 0 &&
                 clip.getIntrinsicDuration() <= 3000,
             "within the toy capacity");
    }

    beginTest("lock-collapsed definer survives compaction (uncollapse intact)");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      auto c1 = recordClip(engine, process, 44100);
      const int64_t dur0 =
          (int64_t)(double)clipVar(engine, c1).getProperty("duration", 0);
      engine.setLoopPoints(c1, 5000, 35000);          // provisional trim
      auto c2 = recordClip(engine, process, 60000);   // arm collapses c1
      engine.compactIdleTakes();                      // keep = recordedLength
      expectEquals(clipPtr(engine, c1)->contentCapacity(),
                   clipPtr(engine, c1)->recordedLength(),
                   "collapsed definer compacted to its FULL material");
      engine.deleteNode(c2);                          // re-open ⟹ uncollapse
      expectEquals(
          (int64_t)(double)clipVar(engine, c1).getProperty("duration", 0),
          dur0, "uncollapse restores the full take after compaction");
    }
  }
};

static TakeCapacityTests takeCapacityTests;

}  // namespace celestrian
