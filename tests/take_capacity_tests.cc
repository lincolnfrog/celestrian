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

#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::nodesOf;
using test_utils::recordClip;

namespace {
juce::var clipVar(AudioEngine& e, const juce::String& uuid) {
  const juce::var s = e.getGraphState();
  if (auto* n = nodesOf(s))
    for (auto& x : *n)
      if (x.getProperty("id", "").toString() == uuid) return x;
  return {};
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
      expect(dur > (int64_t)(65.0 * 44100), "committed well past the old wall");
      // RESERVED STORAGE (take_storage.h, 2026-08-30): the settled take
      // has already compacted to its material — the reservation is a
      // LIVE-take fact now (asserted in the next test), and a later
      // compaction pass is a no-op.
      expectEquals(clipPtr(engine, c1)->contentCapacity(),
                   clipPtr(engine, c1)->recordedLength(),
                   "settled take: capacity == recorded material");
      expect(clipPtr(engine, c1)->reservedStorage() == nullptr,
             "settled take: reservation returned");
      const auto peaksBefore =
          juce::JSON::toString(engine.getWaveform(c1, 200));
      engine.compactIdleTakes();
      expectEquals(clipPtr(engine, c1)->contentCapacity(),
                   clipPtr(engine, c1)->recordedLength(),
                   "capacity == recorded material after compaction");
      expectEquals(juce::JSON::toString(engine.getWaveform(c1, 200)),
                   peaksBefore, "audio identical through the swap");
    }

    beginTest("a LIVE take records into reserved storage, committed ahead of the head");
    {
      AudioEngine engine;
      auto process = makeProcess(engine);
      engine.createNode("clip");
      const juce::String id = [&] {
        auto state = engine.getGraphState();
        return (*state.getDynamicObject()->getProperty("nodes").getArray())[0]
            .getDynamicObject()->getProperty("id").toString();
      }();
      engine.startRecordingInNode(id);
      auto* clip = clipPtr(engine, id);
      expect(clip->reservedStorage() != nullptr, "armed: reserved storage in place");
      expect(clip->contentCapacity() >= ClipNode::kMaxTakeSamples,
             "the address-space reservation is the old bound (record indefinitely)");
      expect(clip->writableCapacity() >= ClipNode::kArmCommitSamples,
             "at least the arm headroom is writable");
      process(3 * 44100);
      engine.getGraphState();  // the poll runs the grower
      expect(clip->writableCapacity() >= clip->recordedLength() + ClipNode::kArmCommitSamples ||
                 clip->writableCapacity() >= clip->contentCapacity(),
             "the grower keeps a headroom ahead of the write head");
      engine.stopRecordingInNode(id);
      process(BLOCK);
      engine.getGraphState();  // settle → compaction
      expect(clip->reservedStorage() == nullptr, "settled: reservation returned");
      expectEquals(clip->contentCapacity(), clip->recordedLength(),
                   "settled: exact-size heap content");
    }

    beginTest("TakeStorage: reserve, commit ahead, clamp at capacity");
    {
      auto st = TakeStorage::reserve(2, 5 * TakeStorage::kChunkSamples + 17);
      expect(st != nullptr, "reservation succeeds");
      expectEquals(st->channels(), 2, "two channels");
      expectEquals(st->capacity(), 5 * TakeStorage::kChunkSamples + 17, "capacity");
      const int64_t c0 = st->committed();
      const int64_t c1 = st->commitTo(TakeStorage::kChunkSamples / 2);
      expect(c1 >= std::min(st->capacity(), TakeStorage::kChunkSamples), "commits at least a chunk");
      expect(c1 >= c0, "monotone");
      const int64_t c2 = st->commitTo(st->capacity() * 3);
      expectEquals(c2, st->capacity(), "clamped at the capacity");
      // Writable end to end within the committed range.
      for (int c = 0; c < 2; ++c) {
        st->channelArray()[c][0] = 1.0f;
        st->channelArray()[c][(size_t)(c2 - 1)] = 2.0f;
      }
      expect(st->channelArray()[1][0] == 1.0f && st->channelArray()[0][(size_t)(c2 - 1)] == 2.0f,
             "pages are backed");
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
      engine.setLoopPoints(c1, 5000, 35000);         // provisional trim
      auto c2 = recordClip(engine, process, 60000);  // arm collapses c1
      engine.compactIdleTakes();                     // keep = recordedLength
      expectEquals(clipPtr(engine, c1)->contentCapacity(),
                   clipPtr(engine, c1)->recordedLength(),
                   "collapsed definer compacted to its FULL material");
      engine.deleteNode(c2);  // re-open ⟹ uncollapse
      expectEquals(
          (int64_t)(double)clipVar(engine, c1).getProperty("duration", 0), dur0,
          "uncollapse restores the full take after compaction");
    }
  }
};

static TakeCapacityTests takeCapacityTests;

}  // namespace celestrian
