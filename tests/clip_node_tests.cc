#include <juce_core/juce_core.h>

#include <memory>
#include <vector>

#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::contextFor;
using test_utils::NodeContext;

namespace {

/** An island root with Q = 1000 and its zero at `zero`, holding one empty
 * clip that run() drives a block at a time on a constant 0.4 input. */
struct OneClipIsland {
  explicit OneClipIsland(int64_t zero = 0) {
    parent.setQuantum(1000, zero);
    auto owned = std::make_unique<ClipNode>("Clip", 1000.0);
    clip = owned.get();
    parent.addChild(std::move(owned));
    nc = contextFor(parent);
    nc.driveFrom(*clip);
  }

  /** One block of `num_samples` at clock `master_pos`. */
  void run(int64_t master_pos, int num_samples) {
    nc.ctx.master_pos = master_pos;
    nc.ctx.island_pos = master_pos;
    nc.ctx.num_samples = num_samples;
    clip->process(ins, nullptr, 1, 0, nc.ctx);
  }

  StackNode parent{"Parent"};
  ClipNode* clip = nullptr;
  NodeContext nc;
  std::vector<float> input = std::vector<float>(512, 0.4f);
  float* const ins[1] = {input.data()};
};

}  // namespace

class ClipNodeTests : public juce::UnitTest {
 public:
  ClipNodeTests() : juce::UnitTest("ClipNode", "Audio Engine") {}

  void runTest() override {
    beginTest("First take on a lone clip: armed until the audio thread "
              "starts it, capturing, then committed whole and playing");
    {
      ClipNode node("TestClip", 44100.0);
      expect(!node.isRecording() && !node.isPlaying(), "a fresh clip is idle");
      node.startPlayback();
      expect(!node.isPlaying(), "nothing to play yet");

      node.startRecording();
      expect(node.isPendingStart() && !node.isRecording(),
             "armed: the audio thread starts the capture");
      float input[10] = {0.5f, -0.7f, 0.2f};
      float* const inputs[] = {input};
      NodeContext nc = contextFor(node, 10);
      node.process(inputs, nullptr, 1, 0, nc.ctx);
      expect(node.isRecording() && !node.isPendingStart(), "capturing");
      expectEquals(node.recordedLength(), (int64_t)10, "the write position");
      expectWithinAbsoluteError(node.last_block_peak.load(), 0.7f, 0.001f,
                                "the block's peak");
      expect(node.getWaveform(1).getArray()->isEmpty(),
             "no peaks while capturing");

      node.stopRecording();  // a request: the take is the audio thread's to end
      expect(node.isRecording() && node.isAwaitingStop(),
             "asked to stop: still capturing");
      expectEquals(node.getIntrinsicDuration(), (int64_t)0, "nothing committed");
      // No Q: the next block top commits it, at its write head, and
      // captures none of that block.
      node.control(inputs, 1, nc.ctx);
      expect(!node.isRecording() && !node.isAwaitingStop(), "committed");
      expect(node.isPlaying(), "a committed take plays");
      expectEquals(node.recordedLength(), (int64_t)10);
      expectEquals(node.getIntrinsicDuration(), (int64_t)10,
                   "the take is as long as it was recorded");
      expect(node.getLoopStart() == 0 && node.getLoopEnd() == 0 &&
                 !node.isLoopWindowActive(),
             "whole: a commit writes no window");
      const juce::var waveform = node.getWaveform(1);
      expect(waveform.isArray());
      expectWithinAbsoluteError((float)waveform[0], 0.7f, 0.001f,
                                "the commit publishes the take's peaks");
    }

    beginTest("Origin Alignment: content plays at its origin");
    {
      // The kernel invariant (docs/kernel.md, recording.md Example 2):
      // content[0] sounds at master ≡ origin (mod duration).
      const double SR = 100.0;
      StackNode parent("Parent");
      // Q = 100 under a 200-sample context loop; attaching content
      // establishes nothing, so the island facts are set explicitly.
      parent.addChild(test_utils::committedClip("QClip", SR, 100, 0.0f));
      parent.addChild(test_utils::committedClip("ContextClip", SR, 200, 0.0f));
      parent.setQuantum(100, 0);

      // Record clip C starting at master_pos=100: origin = 100 within
      // the 200-sample context.
      auto clipC = std::make_unique<ClipNode>("Anchored", SR);
      auto* c = clipC.get();
      parent.addChild(std::move(clipC));

      auto v = [](int k) { return (float)(k + 1) * 0.001f; };

      float rec1[150];
      for (int i = 0; i < 150; ++i) rec1[i] = v(i);
      float* const recIns1[] = {rec1};
      NodeContext recNc = contextFor(parent, 150, 100);
      recNc.driveFrom(*c);
      ProcessContext& recCtx = recNc.ctx;

      c->startRecording();
      c->process(recIns1, nullptr, 1, 0, recCtx);
      c->stopRecording();  // L=150 -> awaits the 200 stop boundary

      float rec2[50];
      for (int i = 0; i < 50; ++i) rec2[i] = v(150 + i);
      float* const recIns2[] = {rec2};
      recCtx.num_samples = 50;
      recCtx.master_pos = 250;
      c->process(recIns2, nullptr, 1, 0, recCtx);

      expectEquals(c->duration_samples.load(), (int64_t)200);
      expectEquals(c->origin_samples.load(), (int64_t)100);

      // At master ≡ origin (100), content[0] plays — what was performed
      // at cycle moment 100 replays at cycle moment 100 (I1).
      float outL[10] = {0.0f};
      float* const outs[] = {outL};
      NodeContext playNc = contextFor(parent, 10, 100);
      playNc.driveFrom(*c);
      ProcessContext& playCtx = playNc.ctx;
      playCtx.is_playing = true;
      c->process(nullptr, outs, 0, 1, playCtx);
      for (int i = 0; i < 10; ++i) {
        expectWithinAbsoluteError(outL[i], v(i), 0.0001f);
      }

      // At master 0 (wrap: 0 ≡ origin + 100 mod 200), content[100] plays.
      for (int i = 0; i < 10; ++i) outL[i] = 0.0f;
      playCtx.master_pos = 0;
      c->process(nullptr, outs, 0, 1, playCtx);
      for (int i = 0; i < 10; ++i) {
        expectWithinAbsoluteError(outL[i], v(100 + i), 0.0001f);
      }

      // Waveform is the raw buffer — no remapping anywhere.
      auto wf = c->getWaveform(200);
      expect(wf.isArray());
      expectWithinAbsoluteError((float)wf.getArray()->getReference(0), v(0),
                                0.0001f);
      expectWithinAbsoluteError((float)wf.getArray()->getReference(100), v(100),
                                0.0001f);
    }

    beginTest("State machine: stopping an ARMED clip cancels cleanly");
    {
      OneClipIsland island;
      ClipNode* c = island.clip;
      c->startRecording();
      island.run(100, 50);  // the target, 1000, is blocks away
      expect(c->isPendingStart(), "armed, not yet capturing");
      expect(!c->isRecording());

      c->stopRecording();  // a stop while armed is a cancel
      expect(!c->isPendingStart(), "cancel leaves Idle");
      expect(!c->isRecording());
      expect(!c->isAwaitingStop());
      expectEquals(c->duration_samples.load(), (int64_t)0, "no content");

      // And nothing captures afterwards.
      island.run(1000, 50);
      expect(!c->isRecording(), "cancelled clip never starts capturing");
    }

    beginTest("State machine: stop boundary is picked by the AUDIO thread");
    {
      // The boundary comes from the audio thread's own write position;
      // the message thread's stop is a request.
      OneClipIsland island;
      ClipNode* c = island.clip;
      c->startRecording();
      island.run(0, 300);  // on the boundary: capture starts now, L = 300
      expect(c->isRecording());

      c->stopRecording();
      expect(c->isAwaitingStop(), "awaiting immediately (stop_requested)");
      expect(c->isRecording(), "still recording while awaiting stop");

      // Next audio block: boundary = nextStopBoundary(300, 1000) = 500
      // (the Q/2 subdivision).
      island.run(300, 100);  // L = 400, no commit yet
      expect(c->isRecording(), "boundary (500) not reached at L=400");
      island.run(400, 100);  // L = 500 -> commit
      expect(!c->isRecording(), "committed at the boundary");
      expect(!c->isAwaitingStop());
      expectEquals(c->duration_samples.load(), (int64_t)500,
                   "committed exactly at nextStopBoundary(300, 1000)");
    }

    beginTest("getWaveform is gated by the recording state machine");
    {
      // The message thread may read clip content only in Idle.
      OneClipIsland island;
      ClipNode* c = island.clip;
      auto peakCount = [](const juce::var& wf) {
        return wf.getArray() ? wf.getArray()->size() : -1;
      };

      c->startRecording();
      expectEquals(peakCount(c->getWaveform(8)), 0, "Armed: no peaks");
      island.run(100, 50);  // the target, 1000, is blocks away
      expect(c->isPendingStart(), "still armed after evaluation");
      expectEquals(peakCount(c->getWaveform(8)), 0,
                   "Armed (evaluated): no peaks");

      island.run(1000, 300);  // the boundary: capture starts, L = 300
      expect(c->isRecording(), "capturing");
      expectEquals(peakCount(c->getWaveform(8)), 0, "Capturing: no peaks");

      c->stopRecording();  // request only; boundary picked on audio thread
      expect(c->isAwaitingStop());
      expectEquals(peakCount(c->getWaveform(8)), 0,
                   "stop requested: no peaks");

      // Boundary = nextStopBoundary(300, 1000) = 500 -> commit at L=500.
      island.run(1300, 200);
      expect(!c->isRecording(), "committed");
      auto wf = c->getWaveform(8);
      expectEquals(peakCount(wf), 8, "Idle-with-content: peaks published");
      expectWithinAbsoluteError((float)wf.getArray()->getReference(0), 0.4f,
                                0.001f, "committed content readable");
    }

    beginTest("Take lifecycle: island counter tracks arm/cancel/removal");
    {
      OneClipIsland island;
      StackNode& parent = island.parent;
      ClipNode* a = island.clip;

      expect(!parent.hasActiveTake());
      a->startRecording();
      expect(parent.hasActiveTake(), "armed take counted on the island");
      a->stopRecording();  // Armed -> cancel
      expect(!parent.hasActiveTake(), "cancel balances the counter");

      // Removing a live take balances the counter too (its commit/cancel
      // event will never arrive).
      auto clipB = std::make_unique<ClipNode>("B", 1000.0);
      auto* b = clipB.get();
      parent.addChild(std::move(clipB));
      b->startRecording();
      expect(parent.hasActiveTake());
      // B is the last child; the detached ownership drops: destroyed.
      parent.removeChild(parent.getNumChildren() - 1);
      expect(!parent.hasActiveTake(), "removal balances the counter");
    }

    beginTest("An arm targets the next heard boundary and starts in the "
              "block that reaches it: a click just before it (the pickup), "
              "and a click farther out");
    {
      // The island's zero is 700, so the heard boundaries are 700 + kQ.
      // The target is the next of them whatever the distance: no deferral
      // window sits on top.
      struct Row {
        const char* what;
        int64_t click_at, reach_at;
      };
      const Row rows[] = {{"100 before the boundary", 1600, 1650},
                          {"600 before the boundary", 1100, 1680}};
      for (const Row& row : rows) {
        const juce::String what(row.what);
        OneClipIsland island(700);
        ClipNode* c = island.clip;
        c->startRecording();
        island.run(row.click_at, 50);
        expect(c->isPendingStart(),
               what + ": armed, this block ends short of 1700");
        expectEquals(c->getAwaitingStartAt(), (int64_t)1700,
                     what + ": the target is the boundary the performer heard");
        expectEquals(c->origin_samples.load(), (int64_t)1700,
                     what + ": and already the take's origin");
        island.run(row.reach_at, 50);
        expect(c->isRecording(),
               what + ": capture starts in the block that reaches it");
        expectEquals(c->origin_samples.load(), (int64_t)1700,
                     what + ": origin = the heard boundary, 0 (mod Q) in the "
                            "island frame");
      }
    }

    beginTest("A clip adopts its origin and its anchor at a block top: its "
              "frame origin is its own origin, gated like a stack's");
    {
      ClipNode clip("Framed", 1000.0);
      NodeContext nc = contextFor(clip, 16);
      nc.ctx.frame_top = 123;  // what an unanchored node would answer
      nc.ctx.island_generation = 4;
      clip.setOriginGated(700, 0);
      clip.process(nullptr, nullptr, 0, 0, nc.ctx);
      expectEquals(clip.frameOrigin(nc.ctx), (int64_t)700,
                   "a leaf is anchored: its frame origin is its origin");
      // An origin gated on a later island generation waits for it.
      clip.setOriginGated(900, 5);
      clip.process(nullptr, nullptr, 0, 0, nc.ctx);
      expectEquals(clip.frameOrigin(nc.ctx), (int64_t)700,
                   "the gated origin is not adopted early");
      nc.ctx.island_generation = 5;
      clip.process(nullptr, nullptr, 0, 0, nc.ctx);
      expectEquals(clip.frameOrigin(nc.ctx), (int64_t)900,
                   "adopted at the block top that carries its generation");
    }

    beginTest("A one-shot clip publishes the phase of its shot over the map "
              "period, and 0 in its rest");
    {
      // A 1000-sample take windowed to [200, 600): the shot is 400 long,
      // fired once per 2000-sample cycle at origin + 200.
      const double SR = 1000.0;
      auto clip = test_utils::committedClip("Shot", SR, 1000, 0.5f);
      clip->setLoopPoints(200, 600);
      expect(clip->getLoopStart() == 200 && clip->getLoopEnd() == 600,
             "the window as it was set");
      clip->period_from_context_.store(true);
      const auto phaseAt = [&](int64_t master_pos) {
        float out[16] = {0.0f};
        float* const outs[] = {out, out};
        NodeContext nc = contextFor(*clip, 16, master_pos);
        nc.ctx.is_playing = true;
        nc.ctx.context_cycle = 2000;
        clip->process(nullptr, outs, 0, 2, nc.ctx);
        return clip->playhead_pos.load();
      };
      const int64_t top = clip->origin_samples.load() + 200;
      expectWithinAbsoluteError(phaseAt(top), 0.0, 1e-9, "the shot's top");
      expectWithinAbsoluteError(phaseAt(top + 100), 0.25, 1e-9,
                                "a quarter of the way through the shot");
      expectWithinAbsoluteError(phaseAt(top + 300), 0.75, 1e-9,
                                "three quarters through");
      expectWithinAbsoluteError(phaseAt(top + 1000), 0.0, 1e-9,
                                "resting: no phase");
      expectWithinAbsoluteError(phaseAt(top + 2100), 0.25, 1e-9,
                                "the next firing starts the shot over");
      // A loop's phase is over its own period: the same reading.
      clip->period_from_context_.store(false);
      expectWithinAbsoluteError(phaseAt(top + 500), 0.25, 1e-9,
                                "a loop: its pass, folded on the map period");
    }
  }
};

static ClipNodeTests clipNodeTests;

}  // namespace celestrian
