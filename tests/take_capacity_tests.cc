/**
 * Take capacity is a VIRTUAL reservation made at arm (address space
 * only; pages are committed ahead of the write head), so memory cost
 * tracks the recorded material and the machine is the only real limit.
 * Pinned here:
 *   - a take longer than the arm-time commit records intact, its
 *     content the input sample for sample;
 *   - a settled take holds exactly its material, and compaction of a
 *     buffer with slack (compactIdleTakes) swaps it under a PLAYING
 *     clip with the audio unchanged;
 *   - the integrity guard at the reservation bound finishes CLEANLY;
 *   - a lock-collapsed definer keeps its full material through
 *     compaction (uncollapse intact).
 */

#include <juce_core/juce_core.h>

#include <cmath>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::addNode;
using test_utils::clipOf;
using test_utils::deepProp;
using test_utils::EngineRig;

class TakeCapacityTests : public juce::UnitTest {
 public:
  TakeCapacityTests() : juce::UnitTest("Take capacity") {}

  void runTest() override {
    const int BLOCK = EngineRig::BLOCK;

    beginTest("a take longer than the arm-time commit records intact");
    {
      // The rig's input is a ramp: sample i of the island's first take
      // is rampAt(i).
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const int64_t len = ClipNode::kArmCommitSamples + 10 * 44100;
      const juce::String c1 = addNode(engine, "clip");
      // The reservation commits on demand, as on the eager platform.
      TakeStorage::commit_on_demand.store(true);
      engine.startRecordingInNode(c1);
      TakeStorage::commit_on_demand.store(false);
      // The poll runs between blocks, as in the app: its grower keeps
      // the take's reach committed ahead of the write head.
      for (int64_t done = 0; done < len; done += 64 * BLOCK) {
        rig.drive(64 * BLOCK);
        engine.tick();
      }
      engine.stopRecordingInNode(c1);
      rig.drive(BLOCK);
      const int64_t dur = (int64_t)deepProp(engine, c1, "duration");
      expect(dur >= len, "committed past the arm-time commit");
      ClipNode* clip = clipOf(engine, c1);
      expect(!clip->capHit(), "it never met its wall");
      // The settled take has compacted to its material: the reservation
      // is a LIVE-take fact (the next test).
      expectEquals(clip->contentCapacity(), clip->recordedLength(),
                   "settled take: capacity == recorded material");
      expect(clip->reservedStorage() == nullptr,
             "settled take: reservation returned");
      const float* content = clip->getAudioBuffer().getReadPointer(0);
      int64_t wrong = 0;
      for (int64_t i = 0; i < dur; ++i) {
        if (std::abs(content[i] - EngineRig::rampAt(i)) > 1e-7f) ++wrong;
      }
      expectEquals(wrong, (int64_t)0, "every sample of the take is the input");
    }

    beginTest("compaction swaps a buffer with slack under a PLAYING clip: "
              "the audio is unchanged");
    {
      // The scenario island: a ramp take, so every sample played says
      // which sample of the take it is.
      scenario::Island is;
      const int64_t take = 2 * 44100;
      const juce::String id = is.record(take);
      auto* clip = dynamic_cast<ClipNode*>(is.nodePtr(id));
      const int64_t material = clip->recordedLength();
      // A buffer far larger than its take (content that reached the
      // clip outside a reservation: nothing compacted it at settle).
      clip->contentForTest().setSize(
          1, (int)(material + 2 * TakeStorage::kChunkSamples),
          /*keepExistingContent=*/true, /*clearExtraSpace=*/true,
          /*avoidReallocating=*/false);
      expect(clip->contentCapacity() > material, "the buffer has slack");
      expectEquals(is.mismatches(2 * take, is.sumOfLoops({id})), 0,
                   "the take plays, sample for sample");
      is.engine.compactIdleTakes();
      expectEquals(clip->contentCapacity(), material,
                   "compacted to its material");
      expectEquals(is.mismatches(2 * take, is.sumOfLoops({id})), 0,
                   "and plays on unchanged through the swap");
    }

    beginTest("a LIVE take records into reserved storage, committed ahead of the head");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String id = addNode(engine, "clip");
      engine.startRecordingInNode(id);
      auto* clip = clipOf(engine, id);
      expect(clip->reservedStorage() != nullptr, "armed: reserved storage in place");
      expect(clip->contentCapacity() >= ClipNode::kMaxTakeSamples,
             "the address-space reservation is the whole take bound");
      expect(clip->writableCapacity() >= ClipNode::kArmCommitSamples,
             "at least the arm headroom is writable");
      rig.drive(3 * 44100);
      engine.getGraphState();  // the poll runs the grower
      expect(clip->writableCapacity() >= clip->recordedLength() + ClipNode::kArmCommitSamples ||
                 clip->writableCapacity() >= clip->contentCapacity(),
             "the grower keeps a headroom ahead of the write head");
      engine.stopRecordingInNode(id);
      rig.drive(BLOCK);
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

    beginTest("TakeStorage on demand: the committed edge starts at 0 and "
              "only commitTo moves it");
    {
      TakeStorage::commit_on_demand.store(true);
      auto st = TakeStorage::reserve(1, 3 * TakeStorage::kChunkSamples);
      TakeStorage::commit_on_demand.store(false);
      expect(st != nullptr, "reservation succeeds");
      expectEquals(st->committed(), (int64_t)0, "nothing is committed yet");
      expectEquals(st->commitTo(1), TakeStorage::kChunkSamples,
                   "a commit rounds up to a chunk");
      expectEquals(st->commitTo(1), TakeStorage::kChunkSamples,
                   "and never moves the edge back or on by itself");
      expectEquals(st->commitTo(st->capacity() + 1), st->capacity(),
                   "clamped at the capacity");
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
      test_utils::NodeContext nc = test_utils::contextFor(clip, BLOCK);
      ProcessContext& ctx = nc.ctx;
      for (int i = 0; i < 10 && clip.recState() != ClipNode::RecState::Idle;
           ++i) {
        clip.control(ins, 1, ctx);
        ctx.master_pos += BLOCK;
        ctx.input_clock += BLOCK;
      }
      expect(clip.recState() == ClipNode::RecState::Idle,
             "auto-committed at the wall - never a zombie");
      expect(clip.capHit(), "the cap-hit fact is surfaced");
      expectEquals(clip.getIntrinsicDuration(), clip.recordedLength(),
                   "clean commit: duration == written material");
      expect(clip.getIntrinsicDuration() > 0 &&
                 clip.getIntrinsicDuration() <= 3000,
             "within the toy capacity");
    }

    beginTest("with Q established, a take nearing its wall finishes at the "
              "last boundary that fits");
    {
      const int64_t q = 1000, toy_capacity = 20000;
      StackNode root("root");
      auto owned = std::make_unique<ClipNode>("wall-clip", 1000.0);
      ClipNode* clip = owned.get();
      root.addChild(std::move(owned));
      root.setQuantum(q, 0);
      clip->startRecording();
      clip->contentForTest().setSize(1, (int)toy_capacity, false, true, false);
      std::vector<float> block((size_t)BLOCK, 0.25f);
      float* ins[] = {block.data()};
      test_utils::NodeContext nc = test_utils::contextFor(root, BLOCK);
      nc.driveFrom(*clip);
      for (int i = 0; i < 100 && clip->recState() != ClipNode::RecState::Idle;
           ++i) {
        clip->control(ins, 1, nc.ctx);
        nc.ctx.master_pos += BLOCK;
        nc.ctx.island_pos += BLOCK;
        nc.ctx.input_clock += BLOCK;
      }
      expect(clip->recState() == ClipNode::RecState::Idle,
             "auto-finished - never a zombie");
      expect(clip->capHit(), "the cap-hit fact is surfaced");
      const int64_t duration = clip->getIntrinsicDuration();
      expect(duration > 0 && duration % q == 0, "committed on a Q boundary");
      expect(clip->recordedLength() <= toy_capacity,
             "its stop run stayed inside the wall");
      expect(duration >= toy_capacity - ClipNode::stopRun(q) - 2 * BLOCK,
             "and it finished no earlier than the wall asked");
    }

    beginTest("lock-collapsed definer survives compaction (uncollapse intact)");
    {
      EngineRig rig;
      AudioEngine& engine = rig.engine;
      const juce::String c1 = rig.recordClip(44100);
      const int64_t dur0 = (int64_t)deepProp(engine, c1, "duration");
      engine.setLoopPoints(c1, 5000, 35000);          // provisional trim
      const juce::String c2 = rig.recordClip(60000);  // arm collapses c1
      ClipNode* definer = clipOf(engine, c1);
      expect(definer->isCollapsed() && definer->getIntrinsicDuration() == 30000,
             "the arm collapsed the definer to its window");
      // Slack past the full take, so the compaction has work to do: it
      // must keep the recorded length, not the collapsed duration.
      definer->contentForTest().setSize(
          1, (int)(dur0 + 2 * TakeStorage::kChunkSamples),
          /*keepExistingContent=*/true, /*clearExtraSpace=*/true,
          /*avoidReallocating=*/false);
      engine.compactIdleTakes();
      expectEquals(definer->contentCapacity(), dur0,
                   "collapsed definer compacted to its FULL material");
      engine.deleteNode(c2);  // re-open ⟹ uncollapse
      expectEquals((int64_t)deepProp(engine, c1, "duration"), dur0,
                   "uncollapse restores the full take after compaction");
      // The island's first take holds the ramp from clock 0.
      expectWithinAbsoluteError(
          definer->getAudioBuffer().getSample(0, (int)dur0 - 1),
          EngineRig::rampAt(dur0 - 1), 1e-7f,
          "with the material the trim had cut");
    }
  }
};

static TakeCapacityTests takeCapacityTests;

}  // namespace celestrian
