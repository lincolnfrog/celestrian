/**
 * The take lifecycle where the two threads meet (src/clip_node.cc,
 * src/engine/take_service.cc): what the message thread may conclude from
 * a take it sees ending, what a refused arm leaves behind, a take with no
 * input to capture, and the committed edge of a take's reservation.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <memory>
#include <thread>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using scenario::BLOCK;
using scenario::Island;

namespace {
constexpr int64_t Q = 20000;

/** A map that keeps [0, cell) and [2 cell, 3 cell): of a 4-cell take the
 * second and fourth cells are cut. */
timing::TimeMap cutMap(int64_t cell) {
  timing::TimeMap cut;
  cut.n = 2;
  cut.segs[0] = {0, cell};
  cut.segs[1] = {2 * cell, 3 * cell};
  return cut;
}

/** A committed slot of `period` silent samples under `root`, whose Q is
 * `quantum`, and a context that runs the clip's control pass a block of
 * 0.25 input at a time, the clocks advancing with it. */
struct SlotUnderRoot {
  SlotUnderRoot(StackNode& root, int64_t period, int64_t quantum, int block)
      : block(block), in((size_t)block, 0.25f) {
    auto owned = std::make_unique<ClipNode>("slot", 44100.0);
    clip = owned.get();
    root.addChild(std::move(owned));
    juce::AudioBuffer<float> first(1, (int)period);
    first.clear();
    clip->loadCommitted(first, 0);
    clip->duration_samples.store(period);
    root.setQuantum(quantum, 0);
    nc = test_utils::contextFor(root, block);
    nc.driveFrom(*clip);
  }

  void controlBlock() {
    const float* ins[] = {in.data()};
    clip->control(ins, 1, nc.ctx);
    nc.ctx.master_pos += block;
    nc.ctx.island_pos += block;
    nc.ctx.input_clock += block;
  }

  const int block;
  std::vector<float> in;
  ClipNode* clip = nullptr;
  test_utils::NodeContext nc;
};

/** Who runs a stretch of blocks. The engine tells a host that drives its
 * callback on the calling thread from one whose blocks run elsewhere, as
 * a device's do (AudioEngine::blocksRunElsewhere). */
using BlockRunner = std::function<void(const std::function<void()>&)>;
/** On this thread: no block can be in flight while a verb runs. */
const BlockRunner onThisThread = [](const std::function<void()>& blocks) {
  blocks();
};
/** On a thread of its own, joined: the blocks are over when it returns,
 * and the engine has seen them run elsewhere. */
const BlockRunner onDeviceThread = [](const std::function<void()>& blocks) {
  std::thread device(blocks);
  device.join();
};

/** Drive `total` samples of the scenario ramp through the device
 * callback in blocks of `block`, `clock` naming the next input sample. */
void rampBlocks(AudioEngine& engine, int64_t& clock, int64_t total, int block) {
  std::vector<float> in((size_t)block), left((size_t)block),
      right((size_t)block);
  float* ins[] = {in.data()};
  float* outs[] = {left.data(), right.data()};
  for (int64_t remaining = total; remaining > 0;) {
    const int n = (int)std::min<int64_t>(remaining, block);
    for (int i = 0; i < n; ++i) in[(size_t)i] = scenario::rampAt(clock + i);
    engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
    clock += n;
    remaining -= n;
  }
}

/** An island root that notes what a clip had published at the moment it
 * reported its take's end. */
class ProbeIsland : public StackNode {
 public:
  using StackNode::StackNode;
  const ClipNode* watched = nullptr;
  struct Seen {
    int events = 0;
    bool idle = false;
    bool outcome = false;  // a new take's commit / cancel flag
    int64_t duration = 0;
  };
  Seen committed, cancelled;

  void takeCommitted() override {
    note(committed);
    StackNode::takeCommitted();
  }
  void takeCancelled() override {
    note(cancelled);
    StackNode::takeCancelled();
  }

 private:
  void note(Seen& seen) {
    ++seen.events;
    if (watched == nullptr) return;
    seen.idle = !watched->isArmedOrRecording();
    seen.outcome = watched->retakeSettled();
    seen.duration = watched->getIntrinsicDuration();
  }
};

/** An island with no Q whose clips, one per name, are armed as its first
 * take: block() runs one audio block's control pass over every clip —
 * the island facts read once at its top, as the callback reads them —
 * capturing a block of 0.25 input. */
struct FirstTakeUnderProbe {
  explicit FirstTakeUnderProbe(std::initializer_list<const char*> names)
      : in((size_t)BLOCK, 0.25f) {
    for (const char* name : names) {
      auto owned = std::make_unique<ClipNode>(name, 44100.0);
      clips.push_back(owned.get());
      root.addChild(std::move(owned));
    }
    nc = test_utils::contextFor(root, BLOCK);
    for (ClipNode* clip : clips) clip->startRecording();
  }

  void block() {
    const float* ins[] = {in.data()};
    nc.refresh();
    for (ClipNode* clip : clips) {
      nc.driveFrom(*clip);
      clip->control(ins, 1, nc.ctx);
    }
    nc.ctx.master_pos += BLOCK;
    nc.ctx.island_pos += BLOCK;
    nc.ctx.input_clock += BLOCK;
  }

  ProbeIsland root{"root"};
  std::vector<ClipNode*> clips;
  std::vector<float> in;
  test_utils::NodeContext nc;
};
}  // namespace

class TakeLifecycleTests : public juce::UnitTest {
 public:
  TakeLifecycleTests()
      : juce::UnitTest("The take lifecycle", "TakeLifecycle") {}

  void runTest() override {
    firstTakeStopTests();
    settleTests();
    armRefusalTests();
    noInputTests();
    committedEdgeTests();
    takeListTests();
    compRidesTheContentTests();
    spliceTests();
  }

 private:
  ClipNode* clipOf(Island& is, const juce::String& id) {
    return dynamic_cast<ClipNode*>(is.nodePtr(id));
  }

  /** Arm a new take of `id` and let it run its period; returns the
   * clock its content position 0 was captured at. */
  int64_t addTake(Island& is, const juce::String& id) {
    ClipNode* clip = clipOf(is, id);
    // Arm well clear of the slot's top, so the arm is seen pending.
    const int64_t origin = is.origin(id), period = is.dur(id);
    const auto phase = [&] { return scenario::posmod(is.clock - origin, period); };
    while (phase() < BLOCK || phase() > period - 4 * BLOCK) is.drive(BLOCK);
    is.engine.newTake(id);
    is.drive(BLOCK);
    expect(clip->isPendingStart(), "the new take waits for the slot top");
    const int64_t start = clip->getAwaitingStartAt();
    is.settle();
    return start;
  }

  /** An undoable arm that records nothing: arm a fresh clip and stop it
   * before its boundary — the arm's own edits (the lock-collapse) stay
   * in the log. Returns the clip. */
  juce::String armAndCancel(Island& is) {
    const juce::String id = is.createClip();
    is.engine.startRecordingInNode(id);
    is.engine.stopRecordingInNode(id);
    expect(!is.engine.hasActiveTake() && is.dur(id) == 0,
           "the arm was cancelled before it captured");
    return id;
  }

  /** Expect the engine's graph to be `before`, fact for fact. */
  void expectGraph(const juce::var& before, AudioEngine& engine,
                   const juce::String& what) {
    const juce::String diff =
        test_utils::firstDifference(before, test_utils::graphFacts(engine));
    expect(diff.isEmpty(), what + (diff.isEmpty() ? "" : " - " + diff));
  }

  /** Fill `slot`'s take list with imports of a `length`-sample WAV
   * written to `dir`; returns the WAV's path. */
  juce::String fillTakeList(Island& is, const juce::String& slot,
                            const juce::File& dir, int64_t length) {
    const juce::String wav =
        test_utils::writeWav(dir, "take.wav", 44100.0, 1, (int)length)
            .getFullPathName();
    for (int k = 1; k < ClipNode::kMaxTakes; ++k) {
      expect(is.engine.importAudio(slot, wav, 0), "an import is a new take");
    }
    return wav;
  }

  void takeListTests() {
    beginTest("a new take cancelled before its slot top: the previous take "
              "stands and nothing is logged");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(4 * Q);
      is.drive(Q / 3);  // mid-period: the slot top is ahead
      const juce::var found = test_utils::graphFacts(engine);
      const bool could_redo = engine.canRedo();
      engine.newTake(id);
      ClipNode* clip = clipOf(is, id);
      expect(clip->isPendingStart(), "armed, waiting for the slot top");
      engine.stopRecordingInNode(id);
      expect(!engine.hasActiveTake() && !engine.hasPendingTakes(),
             "the cancel settles at once");
      expectEquals(clip->takeCount(), 1, "still one take");
      expect(clip->isPlaying(), "the slot sounds again");
      expectGraph(found, engine, "the graph is as it was");
      expect(engine.canRedo() == could_redo, "the log is as it was");
      expectEquals(is.mismatches(4 * Q, is.sumOfLoops({id})), 0,
                   "the take plays on, sample for sample");
      engine.undo();
      expectEquals(is.dur(id), (int64_t)0,
                   "the newest entry is still the take itself");
    }

    beginTest("newTake refusals leave the island as it was: an unknown "
              "node, nothing committed, a one-shot, an active window above, "
              "a step audition above, a different content kind, a full list");
    {
      struct Refusal {
        const char* label;
        // Builds the case on an island holding one committed 2Q clip
        // (`slot`); returns the node to ask a new take of.
        std::function<juce::String(Island&, const juce::String& slot)> build;
      };
      const juce::File dir = test_utils::freshTempDir("new_take_refusals");
      const std::vector<Refusal> refusals = {
          {"an unknown node",
           [](Island&, const juce::String&) { return juce::String("nope"); }},
          {"an empty clip",
           [](Island& is, const juce::String&) { return is.createClip(); }},
          {"an empty stack",
           [](Island& is, const juce::String&) { return is.createStack(); }},
          {"a one-shot",
           [](Island& is, const juce::String&) {
             const juce::String shot = is.record(Q);
             is.engine.setPeriodSource(shot, PeriodSource::CONTEXT_CYCLE);
             return shot;
           }},
          {"an active window above",
           [](Island& is, const juce::String&) {
             const juce::String box = is.createStack();
             const juce::String inner = is.record(2 * Q, box);
             is.engine.setLoopPoints(box, 0, Q);
             return inner;
           }},
          {"a step audition above",
           [](Island& is, const juce::String& slot) {
             is.engine.setSequence(is.rootId(),
                                   scenario::seqPayload({{2 * Q}, {2 * Q}}));
             is.engine.auditionStep(is.rootId(), 1);
             return slot;
           }},
          {"a different content kind",
           [](Island& is, const juce::String& slot) {
             is.engine.addPluginSlotToChain(slot,
                                            test_utils::makeStubSynthSlot(), -1);
             return slot;
           }},
          {"a full take list",
           [this, dir](Island& is, const juce::String& slot) {
             fillTakeList(is, slot, dir, 2 * Q);
             return slot;
           }},
      };
      for (const Refusal& refusal : refusals) {
        Island is;
        AudioEngine& engine = is.engine;
        const juce::String slot = is.record(2 * Q);
        const juce::String target = refusal.build(is, slot);
        const juce::String label = refusal.label;
        const juce::var found = test_utils::graphFacts(engine);
        const bool can_undo = engine.canUndo();
        engine.newTake(target);
        expect(!engine.hasActiveTake() && !engine.hasPendingTakes(),
               label + ": nothing is armed");
        expectGraph(found, engine, label + ": the graph is as it was");
        expect(engine.canUndo() == can_undo, label + ": nothing was logged");
      }
    }

    beginTest("the take caps: a full list takes no further take by any "
              "door; a comp past the cell bound is refused, and can always "
              "be cleared");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String definer = is.record(Q);
      const juce::String slot = is.record(4 * Q);
      ClipNode* clip = clipOf(is, slot);
      const juce::String wav = fillTakeList(
          is, slot, test_utils::freshTempDir("take_caps"), 4 * Q);
      expectEquals(clip->takeCount(), (int)ClipNode::kMaxTakes, "a full list");
      expect(!engine.importAudio(slot, wav, 0), "one more import is refused");
      engine.newTake(slot);
      expect(!engine.hasActiveTake(), "one more new take is refused");
      expectEquals(clip->takeCount(), (int)ClipNode::kMaxTakes,
                   "the list holds what it held");

      engine.setComp(slot, {0, 1, 2, 3});
      expectEquals((int)clip->compCells().size(), 4, "a comp of four Q cells");
      // Q shrinks under the comp (a hand-off, then the definer's trim):
      // the slot is now 320 cells of Q long.
      engine.setDefiner(definer);
      engine.setLoopPoints(definer, 0, 250);
      expectEquals(is.Q(), (int64_t)250, "Q is 250 samples");
      engine.setComp(slot, std::vector<int>(320, 0));
      expectEquals((int)clip->compCells().size(), 4,
                   "320 cells pass the bound: refused, the comp stands");
      engine.setComp(slot, {});
      expect(clip->compCells().empty(), "clearing it is never refused");
      engine.undo();
      expectEquals((int)clip->compCells().size(), 4, "undo brings it back");
    }
  }

  void compRidesTheContentTests() {
    beginTest("a comp rides a lock-collapse: the trimmed loop plays the "
              "cells it played, the cut ones come back with the undo");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(4 * Q);
      ClipNode* clip = clipOf(is, id);
      const int64_t take0 = is.captured.at(id);
      const int64_t take1 = addTake(is, id);
      expectEquals(clip->takeCount(), 2, "two takes; the second is active");
      // The definer's trim: Q := 2Q, off the comp's grid by half a Q.
      const int64_t ws = Q / 2, len = 2 * Q;
      engine.setLoopPoints(id, ws, ws + len);
      expectEquals(is.Q(), len, "the trim is the grid");
      engine.setComp(id, {1, 0});  // [0, 2Q) take 1, [2Q, 4Q) take 0
      const int64_t origin = is.origin(id);
      // What sounds: the window over the comp'd takes, in raw positions.
      const auto sounds = [=](int64_t t) {
        const int64_t raw = ws + scenario::posmod(t - origin - ws, len);
        return scenario::rampAt((raw < 2 * Q ? take1 : take0) + raw);
      };
      expectEquals(is.mismatches(2 * len, sounds), 0,
                   "trimmed: the window plays both cells");
      const juce::var trimmed = test_utils::graphFacts(engine);

      armAndCancel(is);
      expectEquals(is.dur(id), len, "the arm collapsed the definer");
      expectEquals(is.mismatches(2 * len, sounds), 0,
                   "collapsed: the same cells sound");
      expectEquals(is.iprop(id, "compCellLen"), 2 * Q, "the cell length");
      expectEquals(is.iprop(id, "compOffset"), -ws,
                   "the cells slid with the content");

      engine.undo();  // the collapse
      engine.undo();  // the armed clip's creation
      expectGraph(trimmed, engine, "undo: the trimmed take and its comp");
      expectEquals(is.mismatches(2 * len, sounds), 0,
                   "uncollapsed: the same cells sound");
      engine.redo();
      engine.redo();
      expectEquals(is.mismatches(2 * len, sounds), 0,
                   "collapsed again: the same cells sound");
    }

    beginTest("a comp over a cut map: the splice keeps what sounded and "
              "consumes the comp; undo brings takes, map and comp back");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(4 * Q);
      ClipNode* clip = clipOf(is, id);
      const int64_t take0 = is.captured.at(id);
      const int64_t take1 = addTake(is, id);
      engine.setSegments(id, cutMap(Q));
      expectEquals(is.Q(), 2 * Q, "the cut map is the grid");
      engine.setComp(id, {1, 0});  // [0, 2Q) take 1, [2Q, 4Q) take 0
      const int64_t origin = is.origin(id);
      const auto sounds = [=](int64_t t) {
        const int64_t h = scenario::posmod(t - origin, 2 * Q);
        const int64_t raw = h < Q ? h : Q + h;
        return scenario::rampAt((raw < 2 * Q ? take1 : take0) + raw);
      };
      expectEquals(is.mismatches(4 * Q, sounds), 0,
                   "cut: the map plays a cell of each take");
      const juce::var cut_graph = test_utils::graphFacts(engine);

      armAndCancel(is);
      expectEquals(is.dur(id), 2 * Q, "the arm spliced the definer");
      expect(clip->compCells().empty(), "the comp is consumed");
      expectEquals(is.mismatches(4 * Q, sounds), 0,
                   "spliced: what sounded still sounds");
      engine.undo();
      engine.undo();
      expectGraph(cut_graph, engine, "undo: takes, map and comp");
      expectEquals(is.mismatches(4 * Q, sounds), 0,
                   "un-spliced: the same audio");
    }
  }

  void spliceTests() {
    beginTest("the splice at a lock leaves the take whole: no window is "
              "stored on it; undo puts the cut map back, redo splices again");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(4 * Q);
      ClipNode* clip = clipOf(is, id);
      engine.setSegments(id, cutMap(Q));
      const juce::var cut_graph = test_utils::graphFacts(engine);
      const auto wholeTake = [&](const juce::String& when) {
        expectEquals(is.dur(id), 2 * Q, when + ": the kept cells are the take");
        expectEquals(clip->storedMap().n, 0, when + ": no map is stored");
        expect(!is.bprop(id, "windowActive"), when + ": no window plays");
        expectEquals((int64_t)is.prop(id, "loopEnd"), (int64_t)0,
                     when + ": no window is published");
      };
      armAndCancel(is);
      wholeTake("spliced");
      engine.undo();  // the splice
      const timing::TimeMap back = clip->storedMap();
      expectEquals(back.n, 2, "undo: the cut map is back");
      expect(back.segs[0].start == 0 && back.segs[0].end == Q &&
                 back.segs[1].start == 2 * Q && back.segs[1].end == 3 * Q,
             "undo: cell for cell");
      engine.undo();  // the armed clip's creation
      expectGraph(cut_graph, engine, "undo: the graph as it was");
      engine.redo();
      engine.redo();
      wholeTake("spliced again");
    }

    beginTest("the splice at a lock cuts EVERY take of the slot to the kept "
              "cells; undo brings each back whole");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(4 * Q);
      ClipNode* clip = clipOf(is, id);
      const int64_t starts[] = {is.captured.at(id), addTake(is, id),
                                addTake(is, id)};
      expectEquals(clip->takeCount(), 3, "three takes");
      engine.setSegments(id, cutMap(Q));
      const int64_t origin = is.origin(id);
      // Take k through the cut map, before and after the splice.
      const auto cutTake = [=](int64_t start) {
        return [=](int64_t t) {
          const int64_t h = scenario::posmod(t - origin, 2 * Q);
          return scenario::rampAt(start + (h < Q ? h : Q + h));
        };
      };
      const juce::var cut_graph = test_utils::graphFacts(engine);
      armAndCancel(is);
      expectEquals(is.dur(id), 2 * Q, "the arm spliced the definer");
      for (int k = 2; k >= 0; --k) {
        if (clip->activeTake() != k) engine.selectTake(id, k);
        expectEquals(clip->getAudioBuffer().getNumSamples(), (int)(2 * Q),
                     "take " + juce::String(k) + " is the kept cells long");
        expectEquals(is.mismatches(4 * Q, cutTake(starts[k])), 0,
                     "take " + juce::String(k) + " plays its kept cells");
      }
      engine.undo();  // select take 0
      engine.undo();  // select take 1
      engine.undo();  // the splice
      engine.undo();  // the armed clip's creation
      expectGraph(cut_graph, engine, "undo: the slot as it was");
      engine.setLoopPoints(id, 0, 0);  // whole takes again
      for (int k = 0; k < 3; ++k) {
        if (clip->activeTake() != k) engine.selectTake(id, k);
        const int64_t start = starts[k];
        expectEquals(is.mismatches(4 * Q, [=](int64_t t) {
                       return scenario::rampAt(
                           start + scenario::posmod(t - origin, 4 * Q));
                     }),
                     0, "take " + juce::String(k) + " is whole again");
      }
    }

    beginTest("the splice at a lock cuts a MIDI take's notes to the kept "
              "cells; undo brings them back");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.createClip();
      engine.addPluginSlotToChain(id, test_utils::makeStubSynthSlot(), -1);
      ClipNode* clip = clipOf(is, id);
      // A note-on in each quarter of a 4Q take, each released a block on.
      engine.startRecordingInNode(id);
      const int64_t quarter = 16 * BLOCK;
      for (int k = 0; k < 4; ++k) {
        engine.handleIncomingMidiMessage(
            nullptr, juce::MidiMessage::noteOn(1, 60 + k, (juce::uint8)100));
        is.drive(BLOCK);
        engine.handleIncomingMidiMessage(nullptr,
                                         juce::MidiMessage::noteOff(1, 60 + k));
        is.drive(quarter - BLOCK);
      }
      engine.stopRecordingInNode(id);
      is.settle();
      expectEquals(is.dur(id), 4 * quarter, "a 4-quarter MIDI take");
      const std::vector<MidiEvent> whole = clip->midiSequence().snapshot();
      expectEquals((int)whole.size(), 8, "four notes, on and off");

      engine.setSegments(id, cutMap(quarter));
      armAndCancel(is);
      expectEquals(is.dur(id), 2 * quarter, "the arm spliced the definer");
      const std::vector<MidiEvent> kept = clip->midiSequence().snapshot();
      expectEquals((int)kept.size(), 4, "the notes of the two kept quarters");
      if (kept.size() == 4 && whole.size() == 8) {
        expectEquals(kept[0].note(), 60, "the first quarter's note");
        expectEquals(kept[0].pos, whole[0].pos, "where it was");
        expectEquals(kept[2].note(), 62, "the third quarter's note");
        expectEquals(kept[2].pos, whole[4].pos - quarter,
                     "moved up by the quarter cut ahead of it");
      }
      engine.undo();
      engine.undo();
      const std::vector<MidiEvent> back = clip->midiSequence().snapshot();
      expectEquals((int)back.size(), 8, "undo: every note is back");
      bool same = back.size() == whole.size();
      for (size_t i = 0; same && i < back.size(); ++i) {
        same = back[i].pos == whole[i].pos && back[i].note() == whole[i].note();
      }
      expect(same, "undo: each where it was");
      expectEquals(is.dur(id), 4 * quarter, "undo: the take is whole");
    }
  }

  /** For its scope, take reservations commit on demand everywhere (the
   * eager platform's behaviour — TakeStorage::commit_on_demand). */
  struct CommitOnDemand {
    CommitOnDemand() {
      TakeStorage::commit_on_demand.store(true);
      TakeStorage::cut_writes.store(0);
    }
    ~CommitOnDemand() { TakeStorage::commit_on_demand.store(false); }
  };

  void committedEdgeTests() {
    // What an arm commits before the grower first runs, in whole chunks.
    const int64_t arm_commit =
        (ClipNode::kArmCommitSamples / TakeStorage::kChunkSamples + 1) *
        TakeStorage::kChunkSamples;

    beginTest("a through-map arm commits its whole cycle before it clears "
              "it");
    {
      CommitOnDemand seam;
      const int64_t cycle = arm_commit + TakeStorage::kChunkSamples + 1000;
      ClipNode clip("through", 44100.0);
      const juce::AudioBuffer<float>* stand_in = &clip.getAudioBuffer();
      const ClipNode::TakeState displaced = clip.prepareRecording(cycle);
      expect(displaced.buffer.get() == stand_in && stand_in != nullptr,
             "the arm hands back the content its storage displaced");
      expect(clip.reservedStorage() != nullptr, "reserved storage");
      expect(clip.reservedStorage()->committed() >= cycle,
             "the cycle is committed");
      expectEquals(TakeStorage::cut_writes.load(), (int64_t)0,
                   "the clear stayed inside committed pages");
    }

    beginTest("a new take of a slot longer than the arm commit records the "
              "whole period");
    {
      CommitOnDemand seam;
      const int64_t period = arm_commit + TakeStorage::kChunkSamples + 1000;
      const int block = 4096;
      StackNode root("root");
      SlotUnderRoot slot(root, period, Q, block);
      ClipNode* clip = slot.clip;

      expect(clip->mayRetake(), "a new take may arm");
      clip->prepareRetake();
      expect(clip->reservedStorage() != nullptr &&
                 clip->reservedStorage()->committed() >= period,
             "the slot's period is committed at the arm");
      clip->publishArm();
      for (int64_t i = 0; i < 2 * period / block && !clip->retakeSettled();
           ++i) {
        slot.controlBlock();
      }
      ClipNode::TakeState displaced;
      expect(clip->settleRetake(displaced), "the new take committed");
      expect(!clip->capHit(), "it never met its wall");
      expectEquals(clip->getAudioBuffer().getSample(0, (int)period - 1), 0.25f,
                   "its last sample is captured input");
      expectEquals(TakeStorage::cut_writes.load(), (int64_t)0,
                   "no write was cut at the committed edge");
    }

    beginTest("an island whose Q exceeds the arm commit records a full take");
    {
      CommitOnDemand seam;
      const auto owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owner;
      const int block = 4096;
      std::vector<float> in((size_t)block, 0.25f), l((size_t)block),
          r((size_t)block);
      float* ins[] = {in.data()};
      float* outs[] = {l.data(), r.data()};
      // Drive with the poll (and so the grower) running every block.
      const auto drive = [&](int64_t samples) {
        for (int64_t done = 0; done < samples; done += block) {
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, block, {});
          engine.tick();
        }
      };
      const auto record = [&](int64_t samples) {
        engine.createNode("clip");
        const juce::String id = test_utils::lastTopLevelId(engine);
        auto* clip = dynamic_cast<ClipNode*>(engine.findNodeByUuidForTest(id));
        engine.startRecordingInNode(id);
        for (int i = 0; i < 4000 && !clip->isRecording(); ++i) drive(block);
        drive(samples);
        engine.stopRecordingInNode(id);
        for (int i = 0; i < 4000 && engine.hasActiveTake(); ++i) drive(block);
        engine.tick();
        return clip;
      };
      ClipNode* first = record(arm_commit + TakeStorage::kChunkSamples);
      const int64_t big_q = first->getIntrinsicDuration();
      expect(big_q > arm_commit, "Q is longer than the arm commit");
      expect(!first->capHit(), "the first take never met its wall");
      ClipNode* second = record(big_q / 2 + block);
      expect(!second->capHit(), "the second take never met its wall");
      expectEquals(second->getIntrinsicDuration(), big_q,
                   "it ran to its Q boundary");
      expect(second->getAudioBuffer().getNumSamples() > big_q / 2 &&
                 second->getAudioBuffer().getSample(0, (int)(big_q / 2)) ==
                     0.25f,
             "and holds what was played");
      expectEquals(TakeStorage::cut_writes.load(), (int64_t)0,
                   "no write was cut at the committed edge");
    }
  }

  void armRefusalTests() {
    beginTest("a refused arm changes nothing: an unknown node, no empty "
              "clip, nested windows, a window over a cued song, a cycle too "
              "large for a take");
    {
      // Every arm here has everything to do: a Q hand-off whose definer
      // carries a provisional trim (the arm lock-collapses it and ends
      // the hand-off), a stopped transport (the arm starts it) and a redo
      // branch (a logged edit drops it). A refused arm does none of it.
      struct Refusal {
        const char* label;
        // Builds what the arm aims at on the island and returns it.
        std::function<juce::String(Island&, const juce::String& definer)> build;
      };
      const std::vector<Refusal> refusals = {
          {"an unknown node",
           [](Island&, const juce::String&) {
             return juce::String("no-such-node");
           }},
          {"no empty clip",
           [](Island&, const juce::String& definer) { return definer; }},
          {"nested windows",
           [this](Island& is, const juce::String&) {
             const juce::String outer = is.createStack();
             const juce::String inner = is.createStack(outer);
             const juce::String target = is.createClip(inner);
             is.engine.setLoopPoints(outer, 0, 2 * Q);
             is.engine.setLoopPoints(inner, 0, 2 * Q);
             expect(is.bprop(outer, "windowActive") &&
                        is.bprop(inner, "windowActive"),
                    "two nested active windows");
             return target;
           }},
          {"a window over a cued song",
           [this](Island& is, const juce::String&) {
             // The nearest song above the target has no cue (so the arm
             // aims at no step); the window above it lies over a cued song.
             const juce::String outer = is.createStack();
             const juce::String inner = is.createStack(outer);
             const juce::String target = is.createClip(inner);
             is.engine.setSequence(
                 outer, scenario::seqPayload({{2 * Q, false}, {2 * Q, true}}));
             is.engine.setSequence(inner,
                                   scenario::seqPayload({{2 * Q}, {2 * Q}}));
             is.engine.setLoopPoints(outer, 0, 2 * Q);
             expect(is.bprop(outer, "windowActive"),
                    "a window over the cued song");
             return target;
           }},
          {"a cycle too large",
           [this](Island& is, const juce::String&) {
             const juce::String box = is.createStack();
             const juce::String target = is.createClip(box);
             const int64_t cells = ClipNode::kMaxTakeSamples / (2 * Q);
             is.engine.setLoopPoints(box, 0, cells * 2 * Q);
             expect(is.bprop(box, "windowActive"),
                    "a window longer than a take");
             return target;
           }},
      };
      for (const Refusal& refusal : refusals) {
        const juce::String label = refusal.label;
        Island is;
        AudioEngine& engine = is.engine;
        is.record(Q);
        const juce::String definer = is.record(4 * Q);
        engine.setDefiner(definer);
        engine.setLoopPoints(definer, Q, 3 * Q);
        expectEquals(is.Q(), 2 * Q,
                     "the designated definer's trim is the grid");
        expectEquals(is.sprop(is.rootId(), "definerId"), definer,
                     "the hand-off stands");
        const juce::String target = refusal.build(is, definer);
        engine.renameNode(definer, "marker");
        engine.undo();
        if (engine.isPlaying()) engine.togglePlayback();
        is.drive(4 * BLOCK);
        expect(!engine.isPlaying() && engine.canRedo(), "stopped, with a redo");

        const juce::var found = test_utils::graphFacts(engine);
        const bool can_undo = engine.canUndo();
        engine.startRecordingInNode(target);
        expect(!engine.hasActiveTake() && !engine.hasPendingTakes(),
               label + ": nothing is armed");
        expect(!engine.isPlaying(), label + ": the transport stays stopped");
        expectGraph(found, engine, label + ": the graph is as it was");
        expect(engine.canUndo() == can_undo && engine.canRedo(),
               label + ": the log holds what it held");
        engine.redo();
        expectEquals(is.sprop(definer, "name"), juce::String("marker"),
                     label + ": the redo branch is the one it found");
      }
    }

    beginTest("a second arm under a live take is refused whole");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(Q);
      const juce::String a = is.createClip();
      const juce::String b = is.createClip();
      engine.startRecordingInNode(a);
      is.waitFor([&] { return is.bprop(a, "isRecording"); });
      engine.startRecordingInNode(b);
      expect(!is.bprop(b, "isPendingStart") && !is.bprop(b, "isRecording"),
             "the second clip is not armed");
      engine.stopRecordingInNode(a);
      is.settle();
      expectEquals(is.dur(b), (int64_t)0, "...and never records");
    }
  }

  void noInputTests() {
    beginTest("a take with no input runs by the clock over silence: its "
              "stop commits at the boundary");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(Q);
      const juce::String id = is.createClip();
      ClipNode* clip = clipOf(is, id);
      engine.startRecordingInNode(id);
      // The reservation holds whatever was there: capture must write the
      // silence, not leave the pages as it found them.
      juce::FloatVectorOperations::fill(
          clip->contentForTest().getWritePointer(0), 1.0f, (int)(3 * Q));
      is.has_input = false;
      is.waitFor([&] { return clip->isRecording(); }, 200);
      expect(clip->isRecording(), "the take captures without an input");
      is.drive(Q + Q / 2);
      expect(is.iprop(id, "duration") > Q, "the live take follows the clock");
      engine.stopRecordingInNode(id);
      is.waitFor([&] { return !engine.hasActiveTake(); }, 400);
      engine.tick();
      expect(!engine.hasActiveTake(), "the island is idle again");
      expectEquals(is.dur(id), 2 * Q, "committed at the next boundary");
      const juce::AudioBuffer<float>& content = clip->getAudioBuffer();
      const int span = (int)std::min<int64_t>(2 * Q, content.getNumSamples());
      expectEquals(content.getMagnitude(0, 0, span), 0.0f,
                   "the take is silence");
      expect(engine.canUndo(), "the take is in the log");
      engine.undo();
      expectEquals(is.dur(id), (int64_t)0, "undo strips it");
    }

    beginTest("the first take of an island with no input: stop commits what "
              "the clock ran");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.has_input = false;
      const juce::String id = is.createClip();
      engine.startRecordingInNode(id);
      is.drive(Q);
      expect(is.bprop(id, "isRecording"), "capturing");
      engine.stopRecordingInNode(id);
      is.settle();
      expect(is.dur(id) >= Q - BLOCK && is.dur(id) <= Q,
             "the take is as long as the clock ran");
      expectEquals(is.Q(), is.dur(id), "and establishes Q");
    }
  }

  /** Record a first take on `target` (a clip, or a group of empty
   * clips) for `length` samples through `blocks`, and ask it to stop.
   * Returns the write head the stop found. */
  int64_t recordFirstTakeAndAsk(Island& is, const juce::String& target,
                                const juce::String& member, int64_t length,
                                const BlockRunner& blocks) {
    is.engine.startRecordingInNode(target);
    blocks([&] { is.drive(length); });
    ClipNode* clip = clipOf(is, member);
    expect(clip->isRecording(), "capturing");
    const int64_t head = clip->recordedLength();
    expect(is.engine.stopRecordingInNode(target), "the stop is taken");
    return head;
  }

  void firstTakeStopTests() {
    beginTest("a first take's stop, with another thread running the blocks, "
              "is a request: the take ends at the next block top, at the "
              "write head the stop found, and settles when that lands");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.createClip();
      const int64_t head =
          recordFirstTakeAndAsk(is, id, id, Q, onDeviceThread);
      ClipNode* clip = clipOf(is, id);
      expect(clip->isRecording() && clip->isAwaitingStop(),
             "asked, not ended: the take is the audio thread's to end");
      expect(engine.hasActiveTake(), "the island still counts it");
      expectEquals(is.Q(), (int64_t)0, "no Q yet");  // a poll: nothing settles
      expect(engine.hasPendingTakes(),
             "nothing is logged before the commit lands");
      expect(!engine.undo(), "and the log waits, as under any live take");
      expectEquals(clip->recordedLength(), head, "and nothing more is captured");

      std::vector<std::pair<int64_t, float>> commit_block;
      onDeviceThread([&] { is.drive(BLOCK, &commit_block); });
      expect(!clip->isArmedOrRecording(), "the next block top committed it");
      expectEquals(clip->getIntrinsicDuration(), head,
                   "at the write head the stop found");
      expectEquals(clip->recordedLength(), head,
                   "which is every sample the content holds");
      expect(!engine.hasActiveTake(), "the island counts no take");
      expectEquals(is.Q(), head, "the take is Q");  // a poll: the settle
      expect(!engine.hasPendingTakes(),
             "the settle ran once the commit had landed");
      // The block that committed it captured nothing and plays the take
      // from its top: content[k] was captured at clock origin + k.
      const int64_t origin = is.origin(id);
      int silent_or_wrong = 0;
      for (const auto& [t, heard] : commit_block) {
        const float want =
            scenario::rampAt(origin + scenario::posmod(t - origin, head));
        if (std::abs(heard - want) > 2.0e-7f) ++silent_or_wrong;
      }
      expectEquals(silent_or_wrong, 0, "the commit block plays the take");
      is.captured[id] = origin;
      expectEquals(is.mismatches(2 * head, is.sumOfLoops({id})), 0,
                   "and it loops on, sample for sample");

      // The count is exact: an island the commit had counted down twice
      // would read no live take under the next arm.
      const juce::String next = is.createClip();
      engine.startRecordingInNode(next);
      expect(engine.hasActiveTake(), "the next arm is counted");
      engine.stopRecordingInNode(next);
      expect(!engine.hasActiveTake(), "and its cancel balances it");
      engine.undo();  // the next clip's arm left nothing; this is its creation
      engine.undo();
      expectEquals(is.dur(id), (int64_t)0, "the take is one undo step");
    }

    beginTest("a first take's stop with no other thread running the blocks: "
              "the engine runs the block top itself and the take is committed "
              "when the call returns");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.createClip();
      const int64_t head = recordFirstTakeAndAsk(is, id, id, Q, onThisThread);
      ClipNode* clip = clipOf(is, id);
      expect(!clip->isArmedOrRecording() && !engine.hasActiveTake(),
             "committed at once");
      expectEquals(clip->getIntrinsicDuration(), head, "at the write head");
      expect(!engine.hasPendingTakes() && engine.canUndo(), "and settled");
      expectEquals(is.Q(), head, "the take is Q");
    }

    beginTest("a first take is as long as its content, whatever the block "
              "size and whoever runs the blocks");
    {
      for (const BlockRunner& blocks : {onThisThread, onDeviceThread}) {
        for (const int block : {64, 500, 512, 4096}) {
          AudioEngine engine;
          const juce::String id = test_utils::addNode(engine, "clip");
          int64_t clock = 0;
          const auto run = [&](int64_t total) {
            blocks([&] { rampBlocks(engine, clock, total, block); });
          };
          const int64_t length = 3 * 4096 + 1234;  // ends inside a block
          engine.startRecordingInNode(id);
          run(length);
          engine.stopRecordingInNode(id);
          run(block);
          ClipNode* clip = test_utils::clipOf(engine, id);
          const juce::String at = " (block " + juce::String(block) + ")";
          expect(!clip->isArmedOrRecording(), "committed" + at);
          expectEquals(clip->getIntrinsicDuration(), length,
                       "every sample driven while it captured" + at);
          expectEquals(clip->recordedLength(), length,
                       "and not a block more in the content" + at);
          const float* take = clip->getAudioBuffer().getReadPointer(0);
          expectWithinAbsoluteError(take[0], scenario::rampAt(0), 1.0e-7f,
                                    "the first sample" + at);
          expectWithinAbsoluteError(take[length - 1],
                                    scenario::rampAt(length - 1), 1.0e-7f,
                                    "the last sample" + at);
        }
      }
    }

    beginTest("a MIDI first take: a note struck in the block the stop is "
              "asked in is closed at the take's last sample, once");
    {
      for (const BlockRunner& blocks : {onThisThread, onDeviceThread}) {
        Island is;
        AudioEngine& engine = is.engine;
        const juce::String id = is.createClip();
        engine.addPluginSlotToChain(id, test_utils::makeStubSynthSlot(), -1);
        engine.startRecordingInNode(id);
        blocks([&] { is.drive(4 * BLOCK); });
        // Struck now: the next block — the last the take captures — holds it.
        engine.handleIncomingMidiMessage(
            nullptr, juce::MidiMessage::noteOn(1, 60, (juce::uint8)100));
        blocks([&] { is.drive(BLOCK); });
        ClipNode* clip = clipOf(is, id);
        expectEquals(clip->midiSequence().count(), 1, "the note-on is captured");
        const int64_t head = clip->recordedLength();
        engine.stopRecordingInNode(id);
        blocks([&] { is.drive(BLOCK); });
        expect(!clip->isArmedOrRecording(), "committed");
        expectEquals(clip->getIntrinsicDuration(), head, "at the write head");
        const MidiSequence& notes = clip->midiSequence();
        expectEquals(notes.count(), 2, "the note-on and its close: no event twice");
        if (notes.count() == 2) {
          expect(!notes[0].isNoteOff() && notes[0].note() == 60, "the note-on");
          expect(notes[1].isNoteOff() && notes[1].note() == 60, "its note-off");
          expectEquals((int64_t)notes[1].pos, head - 1,
                       "at the take's last sample");
        }
        blocks([&] { is.drive(4 * BLOCK); });
        expectEquals(clip->midiSequence().count(), 2,
                     "nothing is appended to a committed take");
      }
    }

    beginTest("a first-take group stops as one: every member commits at the "
              "same block top, at one length");
    {
      for (const BlockRunner& blocks : {onThisThread, onDeviceThread}) {
        Island is;
        AudioEngine& engine = is.engine;
        const juce::String group = is.createStack();
        const juce::StringArray mics{is.createClip(group), is.createClip(group),
                                     is.createClip(group)};
        const auto* root = dynamic_cast<StackNode*>(is.nodePtr(is.rootId()));
        const uint32_t generation = root->stopGeneration();
        const int64_t head =
            recordFirstTakeAndAsk(is, group, mics[0], Q + 300, blocks);
        expectEquals((int)(root->stopGeneration() - generation), 1,
                     "the members are asked as ONE published generation: no "
                     "block top can fall between two of them");
        blocks([&] { is.drive(BLOCK); });
        for (const auto& mic : mics) {
          const ClipNode* clip = clipOf(is, mic);
          expect(!clip->isArmedOrRecording(), "committed");
          expectEquals(clip->getIntrinsicDuration(), head, "at the one length");
          expectEquals(clip->recordedLength(), head, "the content's length");
          expectEquals(clip->origin_samples.load(),
                       clipOf(is, mics[0])->origin_samples.load(),
                       "from the one origin");
        }
        expect(!engine.hasActiveTake(), "the island counts no take");
        expectEquals(is.Q(), head, "the group take is Q");
        expectEquals(is.iprop(group, "loopEnd"), (int64_t)0,
                     "no window: nothing was padded");
        engine.undo();
        for (const auto& mic : mics) {
          expectEquals(is.dur(mic), (int64_t)0, "one undo step strips them all");
        }
      }
    }

    beginTest("a parked group stop waits for its generation before Q too: "
              "no member ends at a block top that falls between two members' "
              "requests, and all end at the top that reads it");
    {
      FirstTakeUnderProbe group({"a", "b", "c"});
      for (int i = 0; i < 3; ++i) group.block();
      const uint32_t generation = group.root.nextStopGeneration();
      group.clips[0]->stopRecording(generation);
      group.clips[1]->stopRecording(generation);
      group.block();  // a block top before the third member is asked
      for (const ClipNode* clip : group.clips) {
        expect(clip->isRecording(), "parked: every member still captures");
      }
      expectEquals(group.root.committed.events, 0, "nothing committed");
      group.clips[2]->stopRecording(generation);
      group.root.publishStopGeneration(generation);
      group.block();
      for (const ClipNode* clip : group.clips) {
        expect(!clip->isArmedOrRecording(), "published: every member ended");
        expectEquals(clip->getIntrinsicDuration(), (int64_t)(4 * BLOCK),
                     "at the one write head");
      }
      expectEquals(group.root.committed.events, 3, "one commit a member");
      expect(!group.root.hasActiveTake(), "the island counts no take");
      expectEquals(group.root.getQuantum(), (int64_t)(4 * BLOCK),
                   "the take is Q, established once");
    }

    beginTest("a first take asked to stop in the block it meets its wall "
              "commits once, whichever comes first");
    {
      // A toy reservation of 3000 samples: five blocks in, the next block
      // top is the wall's.
      const auto toWall = [](FirstTakeUnderProbe& take) {
        take.clips[0]->contentForTest().setSize(1, 3000, false, true, false);
        for (int i = 0; i < 5; ++i) take.block();
      };
      {
        FirstTakeUnderProbe take({"asked"});
        toWall(take);
        expect(take.clips[0]->isRecording(), "at the wall, still capturing");
        take.clips[0]->stopRecording();
        take.block();  // the stop is taken up first; the wall never judges
        expectEquals(take.root.committed.events, 1, "the stop committed it");
        expect(!take.clips[0]->capHit(), "the wall did not");
        expectEquals(take.clips[0]->getIntrinsicDuration(),
                     (int64_t)(5 * BLOCK), "at the write head");
        for (int i = 0; i < 3; ++i) take.block();
        expectEquals(take.root.committed.events, 1, "and nothing commits again");
        expect(!take.root.hasActiveTake(), "the island's count is exact");
      }
      {
        FirstTakeUnderProbe take({"walled"});
        toWall(take);
        take.block();  // the wall commits
        expectEquals(take.root.committed.events, 1, "the wall committed it");
        expect(take.clips[0]->capHit(), "and says so");
        take.clips[0]->stopRecording();  // asked of a take already ended
        expect(!take.clips[0]->isAwaitingStop(), "nothing is left to stop");
        for (int i = 0; i < 3; ++i) take.block();
        expectEquals(take.root.committed.events, 1, "one commit");
        expect(!take.root.hasActiveTake(), "the island's count is exact");
      }
    }
  }

  void settleTests() {
    beginTest("a performance stays pending while the island still counts "
              "its take: a clip seen Idle with nothing committed is not a "
              "cancelled take");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.createClip();
      engine.startRecordingInNode(id);
      is.drive(8 * BLOCK);
      ClipNode* clip = clipOf(is, id);
      expect(clip->isRecording(), "capturing");
      // The clip as a poll could find it part-way through its commit:
      // Idle already, its duration and the island's commit event still
      // to come.
      ClipNode::TakeState parked = clip->stripTake();
      expect(!clip->isArmedOrRecording() && clip->getIntrinsicDuration() == 0,
             "the clip reads Idle with no duration");
      expect(engine.hasActiveTake(), "the island still counts the take");
      engine.tick();
      expect(engine.hasPendingTakes(), "the performance is still pending");

      // The commit completes.
      clip->duration_samples.store(BLOCK);
      is.nodePtr(is.rootId())->takeCommitted();
      engine.tick();
      expect(!engine.hasPendingTakes(), "settled once the island counts none");
      engine.undo();
      expect(is.nodePtr(id) != nullptr,
             "the take is the undo step, not the clip's creation");
      expectEquals(is.dur(id), (int64_t)0, "undo strips the take");
    }

    beginTest("a new take is unsettled until its outcome is published");
    {
      Island is;
      AudioEngine& engine = is.engine;
      const juce::String id = is.record(Q);
      ClipNode* clip = clipOf(is, id);
      engine.newTake(id);
      is.waitFor([&] { return clip->isRecording(); });
      expect(clip->isRecording(), "the new take is capturing");
      // Idle, the island's count already down, and neither a commit nor a
      // cancel published for the slot.
      auto displaced = clip->installImportedTake(
          std::make_unique<juce::AudioBuffer<float>>(1, (int)Q),
          clip->origin_samples.load(), Q, 0, 0);
      is.nodePtr(is.rootId())->takeCommitted();
      expect(!clip->isArmedOrRecording() && !engine.hasActiveTake() &&
                 !clip->retakeSettled(),
             "Idle, uncounted, no outcome");
      engine.tick();
      expect(engine.hasPendingTakes(),
             "the new take waits for its commit or its cancel");
    }

    beginTest("a take's end reaches the island after the clip has published "
              "it: Idle, the duration, a new take's outcome");
    {
      const int64_t period = 8 * BLOCK;
      ProbeIsland root("root");
      SlotUnderRoot slot(root, period, period, BLOCK);
      ClipNode* clip = slot.clip;
      root.watched = clip;
      const auto block = [&] { slot.controlBlock(); };

      // A new take, run to its cap: the audio thread commits it.
      expect(clip->mayRetake(), "a new take may arm on the committed slot");
      clip->prepareRetake();
      clip->publishArm();
      for (int i = 0; i < 64 && root.committed.events == 0; ++i) block();
      expectEquals(root.committed.events, 1, "the new take committed");
      expect(root.committed.idle, "commit: the clip was Idle");
      expect(root.committed.outcome, "commit: the outcome was published");
      expectEquals(root.committed.duration, period, "commit: the slot's period");
      ClipNode::TakeState displaced;
      expect(clip->settleRetake(displaced), "the new take joins the list");

      // A further take, stopped short: the audio thread cancels it.
      expect(clip->mayRetake(), "a further take may arm");
      clip->prepareRetake();
      clip->publishArm();
      for (int i = 0; i < 64 && !clip->isRecording(); ++i) block();
      expect(clip->isRecording(), "capturing");
      clip->stopRecording();
      block();
      expectEquals(root.cancelled.events, 1, "the short take cancelled");
      expect(root.cancelled.idle, "cancel: the clip was Idle");
      expect(root.cancelled.outcome, "cancel: the outcome was published");
    }

    beginTest("a take that committed before the next arm is logged before "
              "anything that arm's take lets through");
    {
      Island is;
      AudioEngine& engine = is.engine;
      is.record(Q);
      const juce::String a = is.createClip();
      const juce::String b = is.createClip();
      engine.startRecordingInNode(a);
      is.waitFor([&] { return engine.hasActiveTake() && is.bprop(a, "isRecording"); });
      engine.stopRecordingInNode(a);
      // The audio thread commits A at its boundary; no poll runs between
      // that and the next arm.
      for (int i = 0; i < 400 && engine.hasActiveTake(); ++i) is.drive(BLOCK);
      expect(!engine.hasActiveTake(), "A committed on the audio thread");
      engine.startRecordingInNode(b);
      const juce::String c = is.createClip();  // an edit a live take allows
      is.waitFor([&] { return is.bprop(b, "isRecording"); });
      engine.stopRecordingInNode(b);
      is.settle();
      expect(is.dur(a) > 0 && is.dur(b) > 0, "both takes committed");

      engine.undo();
      expectEquals(is.dur(b), (int64_t)0, "undo 1: B's take");
      engine.undo();
      expect(is.nodePtr(c) == nullptr, "undo 2: the clip made during B's take");
      expect(is.dur(a) > 0, "...A's take still stands");
      engine.undo();
      expectEquals(is.dur(a), (int64_t)0, "undo 3: A's take");
    }
  }
};

static TakeLifecycleTests takeLifecycleTests;

}  // namespace celestrian
