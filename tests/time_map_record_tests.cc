#include <juce_core/juce_core.h>

#include <algorithm>
#include <memory>
#include <utility>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/heard_index.h"
#include "../src/stack_node.h"
#include "scenario_utils.h"
#include "test_utils.h"

namespace celestrian {

using scenario::Island;
using scenario::mapOf;
using scenario::posmod;
using test_utils::contextFor;
using test_utils::NodeContext;

namespace {

// The engine cases' quantum, in samples (kQuantum inside Rig, where
// Island::Q() hides the short name).
constexpr int64_t kQuantum = 20000;
constexpr int64_t Q = kQuantum;

/** Adds `node` under `parent` and answers it. */
template <typename Node>
Node* adopt(StackNode& parent, std::unique_ptr<Node> node) {
  Node* added = node.get();
  parent.addChild(std::move(node));
  return added;
}

/** A leaf that keeps the context its parent hands it in control: an
 * empty clip, so it plays nothing and adds nothing to any fold. */
struct ProbeNode : public ClipNode {
  ProbeNode() : ClipNode("Probe") {}
  ProcessContext seen{};
  bool called = false;
  void control(const float* const*, int, const ProcessContext& ctx) override {
    seen = ctx;
    called = true;
  }
  void render(float* const*, int, const ProcessContext&) const override {}
};

/** What a node-level take is fed at arrival index `i`: a ramp, so every
 * captured sample says WHEN it was performed. (The engine cases read
 * the scenario harness's ramp, scenario::rampAt.) */
float rampAt(int64_t i) { return (float)(i + 1) * 1e-5f; }

/** The pre-record ring a node-level take captures from:
 * samples[i] == rampAt(i). */
struct RampRing {
  std::vector<float> samples = std::vector<float>(16384);
  const float* channels[1] = {samples.data()};

  RampRing() {
    for (size_t i = 0; i < samples.size(); ++i) {
      samples[i] = rampAt((int64_t)i);
    }
  }
  RampRing(const RampRing&) = delete;

  /** Aims `ctx` at clock `t`: playing, the island and arrival clocks on
   * `t`, the ring behind it. */
  void aim(ProcessContext& ctx, int64_t t) const {
    ctx.is_playing = true;
    ctx.master_pos = t;
    ctx.island_pos = t;
    ctx.input_clock = t;
    ctx.prerecord_ring = channels;
    ctx.prerecord_ring_len = (int)samples.size();
    ctx.prerecord_ring_channels = 1;
  }
};

/** The root a through-map take records under: Q = 1000 at zero 0, a
 * silent committed 4Q clip (so the inner cycle C is 4000), the window
 * [1Q, 3Q) - period 2000, anchored at O + a0 = 1000 (Q18), so pass tops
 * fall at t == 1000 (mod 2000) - and an empty clip to record into. */
struct MappedRoot {
  StackNode root{"Root"};
  ClipNode* take = nullptr;
  RampRing ring;
  int64_t t = 0;  // the clock driveTo has reached

  MappedRoot() {
    root.establishIsland(1000, 0);
    auto committed =
        test_utils::loadedClip("Committed", 44100.0, 0, 4000, 0.0f);
    committed->setLoopPoints(0, 4000);
    committed->is_muted.store(true);
    root.addChild(std::move(committed));
    root.setLoopPoints(1000, 3000);
    take = adopt(root, std::make_unique<ClipNode>("Take", 44100.0));
  }

  /** Runs control in 250-sample blocks up to clock `until`, with the
   * island facts the engine hands a root. */
  void driveTo(int64_t until) {
    NodeContext nc = contextFor(root, 250);
    for (; t < until; t += 250) {
      nc.refresh();
      ring.aim(nc.ctx, t);
      root.control(nullptr, 0, nc.ctx);
    }
  }
};

/** The Island the engine cases run on, with the reads and moves they
 * share. */
struct Rig : Island {
  int64_t top(const juce::String& id) { return iprop(id, "loopTop"); }
  int64_t retime(const juce::String& id) { return iprop(id, "retime"); }
  /** The top stored on `id`: timing::kNoTop until an edit stores one. */
  int64_t storedTop(const juce::String& id) {
    return nodePtr(id)->storedTop();
  }
  /** The region of `id` in whole Qs: "1-5". */
  juce::String region(const juce::String& id) {
    return juce::String(iprop(id, "loopStart") / kQuantum) + "-" +
           juce::String(iprop(id, "loopEnd") / kQuantum);
  }
  /** The content position of `id` sounding at the transport clock. */
  int64_t sounding(const juce::String& id) {
    return heard::nodeInner(*nodePtr(id), islandPos() + zero(),
                            engine.rootScope());
  }
  /** Drives to top + h + m * period: phase `h` of a pass from `top`, m
   * the first pass count from now of the given parity. */
  void park(int64_t top, int64_t h, int64_t period, int parity) {
    const int64_t now = islandPos() + zero();
    int64_t m = std::max<int64_t>((now - top - h + period - 1) / period, 0);
    if ((m & 1) != parity) ++m;
    drive(top + h + m * period - now);
  }
  /** One commit of a splice drag: the 4Q region of `id` from `start`. */
  void slide(const juce::String& id, int64_t start, bool live) {
    engine.setSegments(
        id, timing::TimeMap::single(start, start + 4 * kQuantum), live);
  }
};

}  // namespace

/**
 * Time maps where a take meets them (docs/time_maps.md): what a mapping
 * stack hands its subtree, recording through an active map at node level
 * and through the engine, the map edits and their continuity re-anchor,
 * the re-time and the top (loop_selection.md §9), and multi-segment clip
 * playback.
 */
class TimeMapRecordTests : public juce::UnitTest {
 public:
  TimeMapRecordTests()
      : juce::UnitTest("Time-Map Recording", "TimeMapRecord") {}

  void runTest() override {
    mapContextTests();
    nodeRecordTests();
    mapEditTests();
    timingAndTopTests();
    clipPlaybackTests();
  }

 private:
  /** A mapping stack hands its subtree the facts the through-map arm
   * and capture math runs against - the innermost active map, its
   * origin O, the heard grid anchor O + a0 (Q18: the map's inner start
   * sounds at its own moment) - and re-bases the clock and the frame top
   * onto the map; the island clock passes down unfolded. O is the
   * received top for an unanchored stack. */
  void mapContextTests() {
    struct Row {
      const char* name;
      bool nested;    // a second mapping stack, [0, 300), above the leaf
      bool bypassed;  // the [1000, 2000) window is stored, not applied
      int64_t pos, top;  // the block's clock and the root's frame top
      // What the leaf is handed:
      int64_t period, map_origin, heard_top, master_pos, frame_top;
    };
    const Row rows[] = {
        // rel = (7500 − 7000) mod 1000 = 500 → folded clock 7000+1000+500.
        {"Active map publishes map facts; island_pos never folds", false,
         false, 7500, 7000, 1000, 7000, 8000, 8500, 8000},
        {"Bypassed map publishes nothing", false, true, 7500, 7000, 0, 0, 0,
         7500, 7000},
        // Outer folds 2500 → child time 1500, child zero 1000: the inner
        // stack's RECEIVED top is the outer window top, and its own
        // [0, 300) window folds 1500 to 1000 + 200.
        {"Nested active maps: innermost wins", true, false, 2500, 0, 300, 1000,
         1000, 1200, 1000},
    };
    for (const Row& row : rows) {
      beginTest(row.name);
      StackNode stack("Mapped");
      StackNode* holder = &stack;
      if (row.nested) {
        holder = adopt(stack, std::make_unique<StackNode>("Inner"));
        holder->setLoopPoints(0, 300);
      }
      ProbeNode* probe = adopt(*holder, std::make_unique<ProbeNode>());
      stack.setLoopPoints(1000, 2000);
      stack.setLoopWindowBypassed(row.bypassed);

      NodeContext nc = contextFor(stack, 16, row.pos);
      nc.ctx.is_playing = true;
      nc.ctx.frame_top = row.top;
      stack.control(nullptr, 0, nc.ctx);

      const ProcessContext& seen = probe->seen;
      expect(probe->called, "probe reached");
      expect(seen.map.active() == (row.period > 0),
             "a map is delivered exactly while one is active");
      expectEquals(seen.map.period(), row.period,
                   "the innermost active map's period");
      expectEquals(seen.map_heard_top, row.heard_top,
                   "heard grid anchor = O + mapOffset(0)");
      expectEquals(seen.map_origin, row.map_origin,
                   "map_origin = the mapping stack's frame origin");
      expectEquals(seen.master_pos, row.master_pos,
                   "master_pos folded through every active map");
      expectEquals(seen.frame_top, row.frame_top,
                   "frame_top re-based to the map's heard-0 position");
      expectEquals(seen.island_pos, row.pos,
                   "island_pos passes through UNFOLDED");
    }
  }

  /** Recording through an active map at node level: the root is driven
   * directly, with the island facts the engine would hand it. */
  void nodeRecordTests() {
    beginTest(
        "Record through an active stack window: fold, dense silence, "
        "origin, commit");
    {
      MappedRoot mapped;
      StackNode& root = mapped.root;
      ClipNode* take = mapped.take;

      // The heard offset at t is (t − 1000) mod 2000. Play up to
      // t = 1500 (heard offset 500), then arm THROUGH the map (C = inner
      // 4Q).
      mapped.driveTo(1500);
      take->startRecording(4000);
      // rel_h = 500 → heard target 1000 (absolute 2000); anchor offset
      // 1000 (mid-pass) → inner origin = mapOffset(1000) = 2000.
      // Capture runs one full period (never stopped) and the cap
      // auto-finishes at 2000 heard.
      mapped.driveTo(4500);

      expect(take->recState() == ClipNode::RecState::Idle,
             "one-period cap auto-committed the take");
      expect(!take->capHit(), "clean finish, not the capacity wall");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)4000, "commit duration = C");
      expectEquals((juce::int64)take->origin_samples.load(), (juce::int64)2000,
                   "origin = the anchor's INNER position");
      expectEquals((juce::int64)take->recordedLength(), (juce::int64)2000,
                   "heard length = one map period");
      expectEquals((juce::int64)take->contextCycle(), (juce::int64)2000,
                   "heard frame at arm = effective cycle (window length)");
      expectEquals((juce::int64)root.getIslandZero(), (juce::int64)0,
                   "no island fact moves at commit");
      expectEquals((juce::int64)root.getIntrinsicDuration(), (juce::int64)4000,
                   "island cycle unchanged");

      // The fold: heard [0, 1000) lands at content [0, 1000) (inner
      // [2000, 3000)); heard [1000, 2000) wraps the pass seam to
      // content [3000, 4000) (inner [1000, 2000)); the never-visited
      // inner [3000, 4000) + [0, 1000) — content [1000, 3000) — is
      // LITERAL SILENCE.
      const float* data = take->getAudioBuffer().getReadPointer(0);
      // Capture ran absolute [2000, 4000): heard order k was performed
      // at 2000 + k.
      for (int k : {0, 1, 500, 999}) {
        expectWithinAbsoluteError(data[k], rampAt(2000 + k), 1e-7f,
                                  "pre-seam run at heard order");
      }
      for (int k : {0, 500, 999}) {
        expectWithinAbsoluteError(data[3000 + k], rampAt(3000 + k), 1e-7f,
                                  "post-seam run folded to the tail");
      }
      for (int k : {1000, 1500, 2999}) {
        expectWithinAbsoluteError(data[k], 0.0f, 0.0f,
                                  "unvisited regions are literal silence");
      }

      // I1 pointwise: through the STILL-ACTIVE map, the committed take
      // sounds exactly what was performed at the same heard phase —
      // and identically on every pass.
      auto probeOut = [&](int64_t at) {
        return test_utils::renderBlock(root, 1, at).left[0];
      };
      expectWithinAbsoluteError(probeOut(200), rampAt(2200), 1e-7f,
                                "I1: heard phase 200 replays what was "
                                "performed there");
      expectWithinAbsoluteError(probeOut(2200), rampAt(2200), 1e-7f,
                                "I1: identical on the next pass");

      // DEGRADATION CONTRACT (I9): bypass the map → the clip plays its
      // inner timeline honestly — content at its performed inner
      // moments, silence in the gaps. Nothing was baked.
      root.setLoopWindowBypassed(true);
      expectWithinAbsoluteError(probeOut(2500), rampAt(2500), 1e-7f,
                                "I9: inner 2500 holds the sample "
                                "performed there");
      expectWithinAbsoluteError(probeOut(1500), rampAt(3500), 1e-7f,
                                "I9: inner 1500 (post-seam material)");
      expectWithinAbsoluteError(probeOut(3500), 0.0f, 0.0f,
                                "I9: unvisited inner time is silent");
      // Re-activation restores full coherence (round trip, not cliff).
      root.setLoopWindowBypassed(false);
      expectWithinAbsoluteError(probeOut(200), rampAt(2200), 1e-7f,
                                "I9: re-activation restores coherence");

      // I1 ROUND TRIP, block-exact: rendering through the still-active
      // map in real block sizes reproduces the fed input sample for
      // sample — including blocks that CROSS the map seam (the stack
      // splits a block at every seam).
      // Heard offset φ = (t − 1000) mod 2000 was performed at absolute
      // time 2000 + ((φ − 1000) mod 2000) = 2000 + (t mod 2000).
      int64_t first_mismatch = -1;
      for (int64_t at = 4000; at < 8000 && first_mismatch < 0; at += 512) {
        const auto out = test_utils::renderBlock(root, 512, at).left;
        for (int i = 0; i < 512 && first_mismatch < 0; ++i) {
          if (std::abs(out[(size_t)i] - rampAt(2000 + (at + i) % 2000)) > 1e-7f) {
            first_mismatch = at + i;
          }
        }
      }
      expect(first_mismatch < 0,
             "I1 block round trip through the active map (first mismatch at "
             "t=" + juce::String(first_mismatch) + ")");
    }

    beginTest(
        "Through-map: user stop before one period clamps to the "
        "heard boundary, still commits dense C");
    {
      MappedRoot mapped;
      ClipNode* take = mapped.take;
      mapped.driveTo(500);
      take->startRecording(4000);
      mapped.driveTo(1600);  // capture from 1000 → heard 600
      take->stopRecording();
      mapped.driveTo(2500);  // boundary 1000 → commit

      expect(take->recState() == ClipNode::RecState::Idle, "committed");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)4000, "duration = C even for short takes");
      expectEquals((juce::int64)take->recordedLength(), (juce::int64)1000,
                   "stopped at the heard Q boundary");
      const float* data = take->getAudioBuffer().getReadPointer(0);
      expectWithinAbsoluteError(data[0], rampAt(1000), 1e-7f,
                                "content starts at the anchor");
      expectWithinAbsoluteError(data[999], rampAt(1999), 1e-7f,
                                "content ends at the stop boundary");
      expectWithinAbsoluteError(data[1000], 0.0f, 0.0f,
                                "beyond the take: silence");
      expectWithinAbsoluteError(data[3500], 0.0f, 0.0f,
                                "pre-anchor window region: silence");
    }

    beginTest("getWaveform gated mid-take (through-map fold)");
    {
      // The motivating case for the gate: the fold scatters capture
      // writes across [0, C) while write_position counts HEARD samples,
      // so a mid-take read bounded by write_position could overlap an
      // in-flight captureWrite. The state gate makes the buffer
      // message-thread-readable only in Idle.
      MappedRoot mapped;
      ClipNode* take = mapped.take;
      auto peakCount = [](const juce::var& wf) {
        return wf.getArray() ? wf.getArray()->size() : -1;
      };

      mapped.driveTo(500);
      take->startRecording(4000);
      expectEquals(peakCount(take->getWaveform(8)), 0, "Armed: no peaks");
      mapped.driveTo(1600);  // capturing, mid-fold
      expect(take->recState() == ClipNode::RecState::Capturing, "capturing");
      expectEquals(peakCount(take->getWaveform(8)), 0,
                   "Capturing (fold in flight): no peaks");
      take->stopRecording();
      expectEquals(peakCount(take->getWaveform(8)), 0,
                   "stop requested: no peaks");
      mapped.driveTo(2500);  // heard boundary 1000 → commit

      expect(take->recState() == ClipNode::RecState::Idle, "committed");
      auto wf = take->getWaveform(8);
      expectEquals(peakCount(wf), 8, "Idle-with-content: peaks published");
      expect((float)wf.getArray()->getReference(0) > 0.0f,
             "committed content readable after the gate lifts");
    }

    beginTest(
        "Through-map: multi-segment map folds segment-general "
        "(cells {Q1, Q3-Q5})");
    {
      // Drive the CLIP directly with a crafted context: the clip stands
      // as its own island (no lifecycle events) and the test authors
      // the map facts a mapping parent would deliver, plus Q = 1000 —
      // the record path must be segment-general.
      ClipNode take("Take", 44100.0);
      const RampRing ring;
      take.startRecording(5000);

      NodeContext nc = contextFor(take, 250);
      nc.ctx.quantum = 1000;
      nc.ctx.map = mapOf({{0, 1000}, {2000, 5000}});  // period 4000 of 5000
      nc.ctx.map_heard_top = 0;
      // Arm mid-Q inside the second segment's pass: rel_h = 2500 → heard
      // target 3000 (golden), anchor 3000 → inner origin =
      // mapOffset(3000) = 4000. Full period = 4000. (A real parent would
      // deliver mapped time as master_pos; the arm and capture math only
      // reads island_pos.)
      for (int64_t t = 2500; t < 7500; t += 250) {
        ring.aim(nc.ctx, t);
        take.control(nullptr, 0, nc.ctx);
      }

      expect(take.recState() == ClipNode::RecState::Idle,
             "cap committed after one 4Q-heard pass");
      expectEquals((juce::int64)take.duration_samples.load(), (juce::int64)5000,
                   "duration = the 5Q inner cycle");
      expectEquals((juce::int64)take.origin_samples.load(), (juce::int64)4000,
                   "anchor mapped into the visited segment");
      expectEquals((juce::int64)take.recordedLength(), (juce::int64)4000,
                   "heard length = one period");

      // Content runs (heard i ↔ arrival 3000 + i):
      //  [0,1000)   ← heard [0,1000)    (segment-1 tail)
      //  [1000,2000) ← heard [1000,2000) (wrap into segment 0)
      //  [3000,5000) ← heard [2000,4000) (segment 1 head)
      //  [2000,3000) = the skipped Q2 → silence.
      const float* data = take.getAudioBuffer().getReadPointer(0);
      for (int k : {0, 999}) {
        expectWithinAbsoluteError(data[k], rampAt(3000 + k), 1e-7f,
                                  "run 1 (segment-1 tail)");
      }
      for (int k : {1000, 1999}) {
        expectWithinAbsoluteError(data[k], rampAt(3000 + k), 1e-7f,
                                  "run 2 (wrapped into segment 0)");
      }
      for (int k : {3000, 4999}) {
        expectWithinAbsoluteError(data[k], rampAt(2000 + k), 1e-7f,
                                  "run 3 (segment-1 head)");
      }
      for (int k : {2000, 2500, 2999}) {
        expectWithinAbsoluteError(data[k], 0.0f, 0.0f,
                                  "skipped cell is literal silence");
      }
    }

    beginTest("Bypassed map at arm -> plain recording");
    {
      MappedRoot mapped;
      ClipNode* take = mapped.take;
      mapped.root.setLoopWindowBypassed(true);  // map inactive

      mapped.driveTo(500);
      take->startRecording();  // the engine walk finds no active map
      mapped.driveTo(2600);    // capture from 1000, heard 1600
      take->stopRecording();
      mapped.driveTo(3500);  // boundary 2000

      expect(take->recState() == ClipNode::RecState::Idle, "committed");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)2000, "mainline commit (stop boundary), NOT C");
      expectEquals((juce::int64)take->origin_samples.load(), (juce::int64)1000,
                   "mainline arm target (no map, no fold)");
      const float* data = take->getAudioBuffer().getReadPointer(0);
      expectWithinAbsoluteError(data[0], rampAt(1000), 1e-7f,
                                "linear capture from the target");
      expectWithinAbsoluteError(data[1999], rampAt(2999), 1e-7f,
                                "linear to the boundary - no fold");
    }
  }

  /** Maps through the engine: the arm gate, the map's storage and the
   * cell-map verb, a take recorded through a cell map, and the
   * continuity re-anchor of a map edit under a playing take. */
  void mapEditTests() {
    beginTest(
        "Engine gate: nested ACTIVE maps refuse the arm; one map "
        "arms through");
    {
      // An island with no Q yet: the gate judges the windows alone.
      Rig is;
      const juce::String outer = is.createStack();
      const juce::String inner = is.createStack(outer);
      expect(inner.isNotEmpty(), "inner stack created");
      const juce::String clip = is.createClip(inner);
      expect(clip.isNotEmpty(), "clip created");

      // A refused arm leaves the clip neither pending nor recording.
      auto armed = [&] {
        return is.bprop(clip, "isPendingStart") || is.bprop(clip, "isRecording");
      };

      // Windows on BOTH ancestors: composed maps refuse the arm.
      is.window(outer, 0, 1000);
      is.window(inner, 0, 500);
      is.engine.startRecordingInNode(clip);
      expect(!armed(), "nested active maps: arm refused");

      // Bypass one: a single active map, and the arm proceeds.
      is.engine.toggleLoopWindow(inner);
      is.engine.startRecordingInNode(clip);
      expect(armed(), "single active map: arm proceeds");
    }

    beginTest("Map override: storage semantics on the node");
    {
      StackNode s("S");
      s.setMap(mapOf({{0, 1000}, {2000, 3000}}));
      expect(s.isLoopWindowActive(), "override alone activates the map");
      expectEquals((juce::int64)s.getEffectivePeriod(), (juce::int64)2000,
                   "effective period = sum of segment lengths");
      expectEquals(s.activeTimeMap().n, 2, "activeTimeMap returns it");
      // Bypass gates BOTH forms; the geometry survives underneath.
      s.setLoopWindowBypassed(true);
      expect(!s.activeTimeMap().active(), "bypass empties the map");
      expect(s.hasSegmentMap(), "geometry survives bypass");
      s.setLoopWindowBypassed(false);
      expectEquals(s.activeTimeMap().n, 2, "un-bypass restores");
    }

    beginTest(
        "setSegments: install/publish, delegation, validation, "
        "undo/redo round trips");
    {
      Rig is;
      const juce::String stack = is.createStack();
      // The stack's published "segments", flat: "start,end,start,end,".
      auto segments = [&] {
        const juce::var list = is.node(stack).getProperty("segments", {});
        juce::String flat;
        if (auto* values = list.getArray()) {
          for (const auto& v : *values) {
            flat += juce::String((int64_t)(double)v) + ",";
          }
        }
        return flat;
      };
      const juce::String two_cells("0,1000,2000,3000,");

      // Install a 2-segment map (empty stack: intrinsic 0 → no clamp).
      is.engine.setSegments(stack, mapOf({{0, 1000}, {2000, 3000}}));
      expectEquals(segments(), two_cells, "segments published in metadata");

      // Malformed lists refuse (metadata unchanged).
      is.engine.setSegments(stack, mapOf({{0, 1000}, {500, 1500}}));
      is.engine.setSegments(stack, mapOf({{2000, 3000}, {0, 1000}}));
      is.engine.setSegments(stack, mapOf({{0, 0}, {2000, 3000}}));
      expectEquals(segments(), two_cells, "overlap/unsorted/empty all refused");

      // n==1 delegates to the single-window path and clears the map.
      is.engine.setSegments(stack, mapOf({{500, 1500}}));
      expectEquals(segments(), juce::String(), "override cleared");
      expectEquals(is.iprop(stack, "loopStart"), (int64_t)500,
                   "delegated to loop points (start)");
      expectEquals(is.iprop(stack, "loopEnd"), (int64_t)1500,
                   "delegated to loop points (end)");

      // Undo: the single-window edit restores the override.
      is.engine.undo();
      expectEquals(segments(), two_cells, "undo restores the multi-segment map");
      // Undo again: back to no map at all.
      is.engine.undo();
      expectEquals(segments(), juce::String(), "undo to pristine");
      // Redo both.
      is.engine.redo();
      expectEquals(segments(), two_cells, "redo reinstalls");
      is.engine.redo();
      expectEquals(segments(), juce::String(), "redo re-delegates");
    }

    beginTest(
        "ENGINE: record through a setSegments cell map (the full "
        "callback path)");
    {
      Rig is;
      const juce::String group = is.createStack();
      const juce::String a = is.record(Q, group);  // take A establishes Q
      const int64_t C = is.dur(a);
      expectEquals(C, Q, "take A committed");

      // Cells {[0, C/4), [C/2, 3C/4)} on the GROUP → period C/2.
      is.engine.setSegments(group, mapOf({{0, C / 4}, {C / 2, 3 * C / 4}}));

      // Record B through the cell map and never stop: the arm waits ≤1
      // heard pass for its boundary, then one full pass (the period)
      // auto-commits it, dense at C = the group's inner cycle.
      const juce::String b = is.createClip(group);
      is.engine.startRecordingInNode(b);
      is.settle();
      expect(!is.bprop(b, "isRecording"),
             "one-period cap auto-committed through the cells");
      expectEquals(is.dur(b), C, "commit duration = C (the group inner cycle)");
      // The anchor lands inside a VISITED cell (§3 arm semantics).
      const int64_t phase = posmod(is.origin(b) - is.origin(a), C);
      expect(phase < C / 4 || (phase >= C / 2 && phase < 3 * C / 4),
             "origin phase lands inside a visited cell (got " +
                 juce::String(phase) + " of " + juce::String(C) + ")");
    }

    beginTest(
        "ENGINE: the continuity re-anchor - sounding sample kept, "
        "the island zero never moves");
    {
      // Take A defines Q; take B is a plain 3Q clip beside it. B is NOT
      // the sole definer, so the general continuity branch (not Q13)
      // carries the phase.
      Rig is;
      const juce::String group = is.createStack();
      is.record(Q, group);
      const juce::String b = is.record(3 * Q, group);
      const int64_t len = is.dur(b);
      expectEquals(len, 3 * Q, "take B committed at 3Q, on the Q grid");

      // The content position sounding now from origin `org` under map
      // `m` (none: the whole take), by the map law itself.
      auto soundingFrom = [&](int64_t org, const timing::TimeMap& m) {
        const timing::TimeMap eff =
            m.active() ? m : timing::TimeMap::single(0, len);
        return eff.mapOffset(is.clock - org - eff.mapOffset(0));
      };
      // Park a quarter Q into an ODD pass of the take: a 2Q cut over a
      // 3Q take must then move the origin to keep the sample sounding.
      const int64_t O = is.origin(b), zero = is.zero();
      is.park(O, Q / 4, len, 1);
      const int64_t p0 = soundingFrom(O, timing::TimeMap::none());
      expectEquals(p0, Q / 4, "parked inside the first quarter");

      // A cut that KEEPS p0's region: the sounding sample keeps sounding
      // - the origin re-anchors by whole Qs - and the island zero stays
      // (docs/frame.md: where B's tile sits is the view's seating).
      const timing::TimeMap keeps = mapOf({{0, Q}, {2 * Q, 3 * Q}});
      is.engine.setSegments(b, keeps);
      const int64_t O1 = is.origin(b);
      expectEquals(soundingFrom(O1, keeps), p0,
                   "covered position keeps sounding across the edit");
      expect(O1 != O, "after an odd pass count the origin had to move");
      expectEquals(posmod(O1 - O, Q), (int64_t)0,
                   "the delta is a whole number of Qs");
      expectEquals(is.zero(), zero, "the zero stays through the re-anchor");

      // A map that REMOVES p0's region: the origin stays put (you deleted
      // what you were hearing; the jump is expected), and so does the
      // zero. `live`: the same GESTURE as the cut above (a drag streaming
      // commits), so it joins that undo step.
      const timing::TimeMap removes = mapOf({{Q, 2 * Q}, {2 * Q, 3 * Q}});
      is.engine.setSegments(b, removes, /*live=*/true);
      expectEquals(is.origin(b), O1,
                   "removed sounding region: origin stays put");
      expectEquals(is.zero(), zero, "a map edit never moves the zero");
      // ONE undo restores the gesture's start.
      is.engine.undo();
      expectEquals(is.origin(b), O, "undo restores the pre-edit origin");
      expectEquals(is.zero(), zero, "undo restores the pre-edit zero");

      // SEPARATE GESTURES ARE SEPARATE UNDO STEPS: the same two maps as
      // two gestures (no `live`) — one undo takes back the second alone,
      // leaving the first's anchors standing.
      is.engine.setSegments(b, keeps);
      const int64_t O2 = is.origin(b);
      is.engine.setSegments(b, removes);
      expectEquals(is.zero(), zero, "gesture 2: the zero still never moves");
      is.engine.undo();
      expectEquals(is.origin(b), O2,
                   "one undo: back to gesture 1's origin, not before it");
      expectEquals(is.zero(), zero, "one undo: back to gesture 1's zero");
      is.engine.undo();
      expectEquals(is.origin(b), O, "the second undo takes back gesture 1");
    }

    beginTest(
        "ENGINE: the continuity re-anchor picks the NEAREST representative, "
        "at any pass count (SM-4) - a trim moves by the least whole-Q "
        "amount; a group slide keeps its subtree");
    {
      // The solve answers the representative nearest the old origin
      // (time_maps.md §5), never the most recent pass O + m·P: the view
      // seats from absolute tops, so the seat must not flip with the
      // parity of m. A playing slide's own facts are scenario S40's.
      // Mock twin: ui/js/tests/continuity_origin.test.mjs; the algebra
      // is golden-pinned (continuity_origin_cases).
      for (int parity : {1, 0}) {
        const juce::String tag = parity ? " (odd passes)" : " (even passes)";
        Rig is;
        is.record(Q);
        is.record(2 * Q);
        const juce::String b = is.record(10 * Q);
        is.window(b, 0, 5 * Q);
        const int64_t O = is.origin(b);
        is.park(O, 5 * Q / 2, 5 * Q, parity);
        const int64_t p0 = is.sounding(b);
        expectEquals(p0, 5 * Q / 2, "parked at content 2.5Q" + tag);
        is.window(b, Q, 6 * Q);  // a whole-Q slide
        is.window(b, Q + 3 * Q / 10, 6 * Q + 3 * Q / 10);  // ⌥ free
        // A head trim [1.3Q, 6.3Q) → [2.3Q, 6.3Q): the sounding sample
        // is 1Q earlier in the pass. The least whole-Q move keeps it.
        is.window(b, 2 * Q + 3 * Q / 10, 6 * Q + 3 * Q / 10);
        const int64_t d = is.origin(b) - O;
        expectEquals(posmod(d, Q), (int64_t)0, "trim: a whole number of Qs" + tag);
        expect(std::abs(d) <= 2 * Q,
               "trim: the least move (got " + juce::String(d / Q) + "Q)" + tag);
        expectEquals(is.sounding(b), p0, "trim: the sounding sample sounds" + tag);
      }
      // A GROUP: the rider re-anchors the stack and moves its subtree
      // (applySetsOrigin) — a slide of the stack's window moves nothing.
      for (int parity : {1, 0}) {
        const juce::String tag = parity ? " (odd passes)" : " (even passes)";
        Rig is;
        is.record(Q);
        const juce::String g = is.recordGroup(2, 4 * Q);
        juce::StringArray mics;
        is.clipIds(mics, g);
        is.window(g, 0, 2 * Q);
        const int64_t Og = is.iprop(g, "origin");
        const int64_t Om = is.origin(mics[0]);
        is.park(Og, 3 * Q / 2, 2 * Q, parity);
        is.window(g, Q, 3 * Q);
        expectEquals(is.iprop(g, "origin"), Og, "group slide: the stack stays" + tag);
        expectEquals(is.origin(mics[0]), Om, "group slide: the members stay" + tag);
      }
    }

    beginTest(
        "ENGINE: a map edit under a bypass re-anchors nothing - the take "
        "plays whole before and after");
    {
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      is.engine.toggleLoopWindow(b);  // bypassed: the take plays whole
      const int64_t O = is.origin(b);
      // Park inside [0, 3Q) of the take, whole passes after its origin:
      // under a 3Q window that position would sound a whole Q elsewhere.
      is.driveToPhase(posmod(O - is.zero() + Q, is.cycle()));
      is.drive(Q / 2);
      const int64_t p0 = is.sounding(b);
      is.window(b, 0, 3 * Q);
      expect(is.bprop(b, "loopBypassed"), "a window edit keeps the bypass");
      expectEquals(is.iprop(b, "loopEnd"), 3 * Q, "the window is stored");
      expectEquals(is.origin(b), O, "window: the origin stays");
      expectEquals(is.sounding(b), p0, "...and the sounding sample sounds on");
      is.engine.setSegments(b, mapOf({{0, Q}, {2 * Q, 3 * Q}}));
      expect(is.bprop(b, "loopBypassed"), "a cell map keeps the bypass");
      expectEquals(is.origin(b), O, "cell map: the origin stays");
      expectEquals(is.sounding(b), p0, "...and the sounding sample sounds on");
    }
  }

  /** The re-time and the top (loop_selection.md §9), and the undo steps
   * a map or re-time gesture forms. Mock twin:
   * ui/js/tests/set_timing.test.mjs. */
  void timingAndTopTests() {
    beginTest(
        "ENGINE: setTiming - the shift moves the origin by any amount and "
        "counts it into the re-time, moving no other fact; one undo step "
        "restores origin, re-time and top together; a live drag is one "
        "step; a re-time never coalesces into a map edit");
    {
      Rig is;
      const juce::String c1 = is.record(Q);
      const juce::String b = is.record(4 * Q);
      const int64_t O = is.origin(b), O1 = is.origin(c1);
      const int64_t zero = is.zero(), q = is.Q();
      expectEquals(is.retime(b), (int64_t)0, "a fresh take is as played");
      expectEquals(is.top(b), (int64_t)0, "no map, no top: the take's start");

      is.engine.setTiming(b, Q);  // the lane ↺ drag, whole Q
      expectEquals(is.origin(b), O + Q, "the origin moved by the shift");
      expectEquals(is.retime(b), Q, "...and the re-time counts it");
      expectEquals(is.Q(), q, "Q stays");
      expectEquals(is.zero(), zero, "the zero stays");
      expectEquals(is.origin(c1), O1, "the other take stays");
      expectEquals(is.retime(c1), (int64_t)0, "...as played");
      expectEquals(is.dur(b), 4 * Q, "the take's length stays");
      expectEquals(is.iprop(b, "loopEnd"), (int64_t)0, "no map appears");
      is.engine.setTiming(b, 3 * Q / 10);  // ⌥: free, sub-Q
      expectEquals(is.origin(b), O + Q + 3 * Q / 10,
                   "a free shift lands exactly - never re-folded onto the grid");
      expectEquals(is.retime(b), Q + 3 * Q / 10, "...counted");
      is.engine.undo();
      expectEquals(is.origin(b), O + Q, "undo takes back the free shift");
      expectEquals(is.retime(b), Q, "...with its re-time");
      is.engine.redo();
      expectEquals(is.origin(b), O + Q + 3 * Q / 10, "redo");
      expectEquals(is.retime(b), Q + 3 * Q / 10, "...re-time too");
      is.engine.setTiming(b, -is.retime(b));  // "timing as played"
      expectEquals(is.origin(b), O, "as played: the performed origin");
      expectEquals(is.retime(b), (int64_t)0, "...re-time 0");

      // THE PANEL'S START MARKER: a new top and the compensating shift
      // in one call, so the ↺ keeps its moment. [Q, 3Q): the top (the
      // region start Q, which the window stored) sounds at O + Q; a top
      // at 2Q is heard Q in, so the shift is −Q.
      is.window(b, Q, 3 * Q);
      auto topMoment = [&](const juce::String& id) {
        const int64_t a0 = is.iprop(id, "loopStart");
        return is.origin(id) + a0 + (is.top(id) - a0);  // one segment
      };
      const int64_t moment0 = topMoment(b);
      is.engine.setTiming(b, -Q, 2 * Q);
      expectEquals(is.top(b), 2 * Q, "the top is stored");
      expectEquals(is.origin(b), O - Q, "the origin compensates");
      expectEquals(is.retime(b), -Q, "...and the re-time counts it");
      expectEquals(topMoment(b), moment0, "the (top) kept its moment");
      is.engine.undo();
      expectEquals(is.origin(b), O, "undo: the origin,");
      expectEquals(is.retime(b), (int64_t)0, "the re-time,");
      expectEquals(is.top(b), Q, "and the top (the region start the window stored)");
      is.engine.redo();
      expectEquals(is.origin(b), O - Q, "redo: the origin,");
      expectEquals(is.retime(b), -Q, "the re-time,");
      expectEquals(is.top(b), 2 * Q, "and the top, together");

      // A LIVE drag: the first commit opens the step, the rest coalesce.
      const int64_t Og = is.origin(b), Rg = is.retime(b);
      is.engine.setTiming(b, Q / 10);
      is.engine.setTiming(b, Q / 10, std::nullopt, true);
      is.engine.setTiming(b, -Q / 20, std::nullopt, true);
      expectEquals(is.origin(b), Og + 3 * Q / 20, "the streamed commits applied");
      expectEquals(is.retime(b), Rg + 3 * Q / 20, "...and counted");
      is.engine.undo();
      expectEquals(is.origin(b), Og, "one undo takes the whole drag back");
      expectEquals(is.retime(b), Rg, "...its re-time too");
      expectEquals(is.top(b), 2 * Q, "...and leaves the top");
      // Two gestures are two steps.
      is.engine.setTiming(b, Q / 10);
      is.engine.setTiming(b, Q / 10);
      is.engine.undo();
      expectEquals(is.origin(b), Og + Q / 10, "separate gestures: one step each");
      is.engine.undo();
      expectEquals(is.origin(b), Og, "...two undos");
      // Swap and shift are different gestures: a live re-time never
      // coalesces into a map edit's step.
      is.window(b, 2 * Q, 4 * Q);
      is.engine.setTiming(b, Q / 10, std::nullopt, true);
      is.engine.undo();
      expectEquals(is.origin(b), Og, "the re-time undid on its own");
      expectEquals(is.iprop(b, "loopStart"), 2 * Q, "...the slide stands");
    }

    beginTest(
        "ENGINE: setTiming refusals - the Q-definer, a stack, an empty clip, "
        "an unknown node and a top outside the kept set (refused whole) "
        "record nothing");
    {
      Rig is;
      const juce::String c1 = is.record(Q);
      // THE Q-DEFINER: the island's only content — its frame top is the
      // island zero.
      const int64_t O1 = is.origin(c1);
      is.engine.setTiming(c1, Q / 2);
      expectEquals(is.origin(c1), O1, "the Q-definer refuses");
      expectEquals(is.iprop(c1, "retime"), (int64_t)0, "...nothing counted");
      const juce::String b = is.record(4 * Q);
      is.window(b, Q, 3 * Q);
      const juce::String g = is.createStack();
      const juce::String e = is.createClip();
      const int64_t Ob = is.origin(b);
      // THE PROBE: a redo branch survives only when nothing is recorded.
      is.engine.renameNode(b, "probe");
      is.engine.undo();
      expect(is.engine.canRedo(), "the probe's redo branch");
      is.engine.setTiming(b, Q, 0);      // top before the window
      is.engine.setTiming(b, Q, 3 * Q);  // top at the window's end
      is.engine.setTiming(b, Q, 9 * Q);  // top past the take
      expectEquals(is.origin(b), Ob, "a top outside the kept set refuses the whole call");
      expectEquals(is.iprop(b, "retime"), (int64_t)0, "...no partial shift");
      expectEquals(is.iprop(b, "loopTop"), Q, "...no top");
      is.engine.setTiming(g, Q);          // an EMPTY group: nothing committed
      is.engine.setTiming(e, Q);          // nothing committed
      is.engine.setTiming("no-such-node", Q);
      is.engine.setTiming(b, 0);          // the identity: records nothing
      expect(is.engine.canRedo(), "none of them recorded (the redo branch survives)");
      expectEquals(is.iprop(g, "origin"), (int64_t)0, "the stack is untouched");
      // Every loop node publishes its re-time: 0 for a group nothing has
      // moved.
      expectEquals(is.iprop(g, "retime"), (int64_t)0, "the group is as played");
      // The control: with nothing to refuse it, the re-time lands.
      is.engine.setTiming(b, Q);
      expectEquals(is.origin(b), Ob + Q, "the re-time lands");
    }

    beginTest(
        "ENGINE: a new take plays as performed and resets the re-time - a 4Q "
        "take shifted +1Q, then a new take: armed at the "
        "shifted slot top, it sounds where it was played with re-time 0, so "
        "'timing as played' leaves it there; undo brings back the old take "
        "with its +1Q, redo the 0");
    {
      // The output checks are the scenario harness's (docs/scenarios.md,
      // S15/S41): content[k] of a take is the harness ramp at its capture
      // boundary + k.
      using scenario::rampAt;
      Rig is;
      const juce::String c1 = is.record(Q);
      const juce::String b = is.record(4 * Q);
      const int64_t cap = is.captured.at(b);
      is.engine.setTiming(b, Q);
      expectEquals(is.retime(b), Q, "the take is shifted +1Q");
      // A NEW TAKE, armed mid-period: it waits for the slot's own top —
      // the SHIFTED origin — and captures exactly one period.
      is.drive(Q / 2);
      is.engine.newTake(b);
      is.waitFor([&] { return is.bprop(b, "isRecording"); });
      const int64_t start2 = is.clock - is.iprop(b, "duration");
      expectEquals(posmod(start2 - (cap + Q), 4 * Q), (int64_t)0,
                   "armed at the shifted slot top");
      is.settle();
      expectEquals(is.iprop(b, "takes"), (int64_t)2, "two takes");
      expectEquals(is.iprop(b, "activeTake"), (int64_t)1, "the new one is active");
      expectEquals(is.origin(b), cap + Q, "the slot keeps its origin");
      expectEquals(is.retime(b), (int64_t)0, "the re-time resets: the new take is as played");
      auto asPlayed = [&](int64_t t) {
        return is.loopVal(c1, t) + rampAt(start2 + posmod(t - start2, 4 * Q));
      };
      expectEquals(is.mismatches(8 * Q, asPlayed), 0,
                   "the new take sounds exactly where it was played");
      // "Timing as played" (−retime) is the identity now: the new take
      // stays on its performance.
      is.engine.setTiming(b, -is.retime(b));
      expectEquals(is.origin(b), cap + Q, "'timing as played' leaves it there");
      expectEquals(is.mismatches(4 * Q, asPlayed), 0, "...still as played");
      is.engine.undo();
      expectEquals(is.iprop(b, "takes"), (int64_t)1, "undo: the old take alone");
      expectEquals(is.iprop(b, "activeTake"), (int64_t)0, "...active");
      expectEquals(is.retime(b), Q, "...with its +1Q");
      expectEquals(is.mismatches(8 * Q, [&](int64_t t) {
        return is.loopVal(c1, t) + is.val(b, posmod(t - cap - Q, 4 * Q));
      }), 0, "the old take sounds a Q later than played again");
      is.engine.redo();
      expectEquals(is.iprop(b, "takes"), (int64_t)2, "redo: the new take");
      expectEquals(is.iprop(b, "activeTake"), (int64_t)1, "...active");
      expectEquals(is.retime(b), (int64_t)0, "...re-time 0 again");
      expectEquals(is.mismatches(4 * Q, asPlayed), 0, "...as played");
      // The older take keeps its shift as a baked fact; ⌘Z still
      // reaches it behind the new take.
      is.engine.undo();
      is.engine.undo();
      expectEquals(is.origin(b), cap, "two undos: the shift is gone too");
      expectEquals(is.retime(b), (int64_t)0, "...as played");
    }

    beginTest(
        "ENGINE: the top rides every map edit - kept while the new region "
        "plays it, else the new region start, stored; undo restores it "
        "exactly; a bypass leaves it; a live drag reconciles from its "
        "gesture's start");
    {
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      const int64_t O = is.origin(b);
      is.window(b, Q, 3 * Q);
      is.engine.setTiming(b, 0, 2 * Q);  // a top alone: no shift
      expectEquals(is.top(b), 2 * Q, "the top is stored");
      expectEquals(is.origin(b), O, "...and nothing moved in time");
      // setLoopPoints — a SWAP keeps the origin, so the top keeps its
      // moment while the region still plays it.
      is.window(b, 3 * Q / 2, 7 * Q / 2);
      expectEquals(is.top(b), 2 * Q, "a slide that still plays the top keeps it");
      expectEquals(is.origin(b), O, "...and the origin (a swap)");
      is.window(b, 3 * Q, 5 * Q);
      expectEquals(is.top(b), 3 * Q, "a slide past it resets it to the region start");
      is.engine.undo();
      expectEquals(is.top(b), 2 * Q, "undo restores the old top exactly");
      expectEquals(is.iprop(b, "loopStart"), 3 * Q / 2, "...with its region");
      is.engine.redo();
      expectEquals(is.top(b), 3 * Q, "redo: the region start again");
      // setSegments — a CELL CUT under the top drops it; a HEAL keeps it.
      is.window(b, Q, 5 * Q);
      is.engine.setTiming(b, 0, 7 * Q / 2);
      expectEquals(is.top(b), 7 * Q / 2, "a top in [3Q,4Q)");
      is.engine.setSegments(b, mapOf({{Q, 3 * Q}, {4 * Q, 5 * Q}}));
      expectEquals(is.top(b), Q, "the cut removed its cell: the region start");
      is.engine.undo();
      expectEquals(is.top(b), 7 * Q / 2, "undo: the top is back");
      is.engine.setSegments(b, mapOf({{Q, 3 * Q}, {4 * Q, 5 * Q}}));
      is.engine.setTiming(b, 0, 9 * Q / 2);
      expectEquals(is.top(b), 9 * Q / 2, "a top in the second segment");
      is.engine.setSegments(b, mapOf({{Q, 5 * Q}}));  // heal (n = 1)
      expectEquals(is.top(b), 9 * Q / 2, "the heal still plays it");
      // A bypass leaves it; a CLEAR keeps it (the whole take plays it).
      is.engine.toggleLoopWindow(b);
      expect(is.bprop(b, "loopBypassed"), "bypassed");
      expectEquals(is.top(b), 9 * Q / 2, "a bypass leaves the top alone");
      is.engine.toggleLoopWindow(b);
      is.window(b, 0, 0);
      expectEquals(is.top(b), 9 * Q / 2, "a cleared map keeps the top");
      // THE GESTURE'S START: a live drag reconciles every commit against
      // the top the drag started with, so sweeping past the ↺ and back
      // keeps it; the one undo step restores it exactly.
      is.window(b, Q, 5 * Q);
      is.engine.setTiming(b, 0, 2 * Q);
      is.engine.setLoopPoints(b, 3 * Q / 2, 11 * Q / 2);  // the drag's first commit
      is.engine.setLoopPoints(b, 5 * Q / 2, 13 * Q / 2, true);
      expectEquals(is.top(b), 5 * Q / 2, "mid-drag the region left the top");
      is.engine.setLoopPoints(b, 3 * Q / 2, 11 * Q / 2, true);
      expectEquals(is.top(b), 2 * Q, "...and back: the drag's own top returns");
      is.engine.setSegments(b, mapOf({{3 * Q, 4 * Q}, {5 * Q, 8 * Q}}), true);
      expectEquals(is.top(b), 3 * Q, "a live cut that drops it");
      is.engine.undo();
      expectEquals(is.top(b), 2 * Q, "one undo: the gesture's top");
      expectEquals(is.iprop(b, "loopStart"), Q, "...and its region");
    }

    beginTest(
        "ENGINE: an UNSET top (a take never edited) is its region start "
        "until the first map edit STORES it - a left slide keeps the top "
        "where it showed, a right slide past it takes the new start, a reset "
        "stays put when the region slides back, and a live drag reconciles "
        "from where it showed");
    {
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      auto* clip = dynamic_cast<ClipNode*>(is.nodePtr(b));
      expect(clip != nullptr, "the take");
      // A window no edit has reconciled a top against — a take's
      // commit-time window, a session saved before tops: set on the node
      // itself, the top unset, the region start standing in.
      auto fresh = [&](int64_t a, int64_t e) {
        if (clip == nullptr) return;
        clip->setLoopPoints(a, e);
        clip->setStoredTop(timing::kNoTop);
        expectEquals(is.top(b), a, "unset: the region start stands in");
      };
      fresh(2 * Q, 4 * Q);
      is.window(b, Q, 3 * Q);  // left 1Q
      expectEquals(is.top(b), 2 * Q,
                   "a left slide keeps the top where it showed: the splice "
                   "comes apart");
      expectEquals(is.storedTop(b), 2 * Q, "...stored");
      is.engine.undo();
      expectEquals(is.storedTop(b), timing::kNoTop, "undo: unset, exactly as found");
      expectEquals(is.top(b), 2 * Q, "...the region start again");
      is.window(b, 3 * Q, 5 * Q);  // right 1Q
      expectEquals(is.top(b), 3 * Q, "a right slide past it: the new start");
      // THE RESET STAYS PUT (bars 1–4 → 3–6 → 2–5): stored at the reset,
      // the top holds bar 3 when the region slides back over it.
      fresh(0, 4 * Q);
      is.window(b, 2 * Q, 6 * Q);
      expectEquals(is.top(b), 2 * Q, "bars 3-6 drop bar 1: the top resets to bar 3");
      is.window(b, Q, 5 * Q);
      expectEquals(is.top(b), 2 * Q, "back to bars 2-5: the top stays on bar 3");
      // A LIVE DRAG from an unset top reconciles every commit from the
      // top it showed when the drag began (the gesture's first inverse
      // carries it), not from the last commit's.
      fresh(2 * Q, 4 * Q);
      is.engine.setLoopPoints(b, 3 * Q, 5 * Q);  // the drag's first commit
      expectEquals(is.top(b), 3 * Q, "mid-drag the region left the top");
      is.engine.setLoopPoints(b, Q, 3 * Q, true);
      expectEquals(is.top(b), 2 * Q, "...and back past it: the drag's own top");
      // A live cut that drops it.
      is.engine.setSegments(b, mapOf({{Q, 2 * Q}, {3 * Q, 4 * Q}}), true);
      expectEquals(is.top(b), Q, "a live commit that drops it: the region start");
      is.engine.undo();
      expectEquals(is.storedTop(b), timing::kNoTop,
                   "one undo: unset, as the drag found it");
      expectEquals(is.iprop(b, "loopStart"), 2 * Q, "...with its region");
    }

    beginTest(
        "ENGINE: a drag whose first commit records nothing (an identity - "
        "engaged, no whole Q crossed yet - or a refusal) is still its own "
        "undo step: two splice drags on one clip are two steps, each undo "
        "restoring its start and its stored top exactly; two re-time drags "
        "opening on a zero shift are two steps; a drag that returns to its "
        "start and dwells is one step; an undo ends the gesture");
    {
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      auto expectRegion = [&](const char* want, const juce::String& why) {
        expect(is.region(b) == want, why + " (" + is.region(b) + ")");
      };
      // A WHOLE-Q SPLICE DRAG over a window commits the slid window
      // (Rig::slide); its first commit is the window it found — an
      // identity, recording nothing.
      is.window(b, Q, 5 * Q);
      is.engine.setTiming(b, 0, 2 * Q);  // the ↺ on 2Q
      // Drag 1: [Q,5Q) → [3Q,7Q) leaves the ↺ behind: the region start.
      is.slide(b,Q, false);
      is.slide(b,2 * Q, true);
      is.slide(b,3 * Q, true);
      expectEquals(is.storedTop(b), 3 * Q, "drag 1 dropped the (top)");
      // Drag 2 back to [Q,5Q) reconciles from ITS start (3Q, which the
      // region keeps playing) — never drag 1's (2Q).
      is.slide(b,3 * Q, false);
      is.slide(b,2 * Q, true);
      is.slide(b,Q, true);
      expectEquals(is.storedTop(b), 3 * Q, "drag 2 kept the (top) it found");
      is.engine.undo();
      expectRegion("3-7", "undo: drag 2 alone");
      expectEquals(is.storedTop(b), 3 * Q, "...with its (top)");
      is.engine.undo();
      expectRegion("1-5", "undo: drag 1");
      expectEquals(is.storedTop(b), 2 * Q, "...its (top) exactly");
      is.engine.redo();
      is.engine.redo();
      expect(is.region(b) == "1-5" && is.storedTop(b) == 3 * Q, "redo: both drags");

      // RE-TIME DRAGS opening on a zero shift (the ↺ grabbed, not yet
      // moved): two drags, two steps.
      const int64_t O = is.origin(b), R = is.iprop(b, "retime");
      is.engine.setTiming(b, 0);
      is.engine.setTiming(b, Q, std::nullopt, true);
      is.engine.setTiming(b, Q, std::nullopt, true);
      is.engine.setTiming(b, 0);
      is.engine.setTiming(b, -Q / 2, std::nullopt, true);
      is.engine.setTiming(b, -Q / 4, std::nullopt, true);
      expectEquals(is.origin(b), O + 5 * Q / 4, "both drags applied");
      is.engine.undo();
      expectEquals(is.origin(b), O + 2 * Q, "undo: re-time drag 2 alone");
      expectEquals(is.iprop(b, "retime"), R + 2 * Q, "...its re-time");
      is.engine.undo();
      expectEquals(is.origin(b), O, "undo: re-time drag 1");
      expectEquals(is.iprop(b, "retime"), R, "...its re-time");

      // A DRAG THAT DWELLS and RETURNS TO ITS START is one step: its
      // identities (and a refused commit) record nothing and keep it —
      // and so does a read between commits (only a logged step ends it).
      is.slide(b,Q, false);
      is.slide(b,Q, true);
      is.slide(b,4 * Q, true);
      is.engine.setLoopPoints(b, 4 * Q, 13 * Q / 2, true);  // off Q: refused
      is.slide(b,4 * Q, true);
      is.engine.getWaveform(b, 64);
      is.slide(b,Q, true);  // back at its start
      is.slide(b,Q, true);
      is.slide(b,0, true);
      expectRegion("0-4", "the drag landed");
      expectEquals(is.storedTop(b), 3 * Q, "...reconciled from its start");
      is.engine.undo();
      expectRegion("1-5", "one undo: the drag's start");
      expectEquals(is.storedTop(b), 3 * Q, "...and its (top)");
      is.engine.undo();
      expectRegion("3-7", "the next undo is drag 2's");

      // AN UNDO ENDS THE GESTURE: a live commit after it logs its own
      // step, never joining the entry the undo left on top (drag 1's).
      is.slide(b,2 * Q, false);
      is.engine.undo();
      is.slide(b,4 * Q, true);
      is.engine.undo();
      expectRegion("3-7", "the stray live commit undid alone");
      expectEquals(is.storedTop(b), 3 * Q, "...with its (top)");
      // A REFUSED first commit opens its gesture too.
      is.engine.setLoopPoints(b, 3 * Q, 11 * Q / 2);  // off Q: refused
      is.slide(b,2 * Q, true);
      is.engine.undo();
      expectRegion("3-7", "after a refused first commit");
      is.engine.undo();
      expectRegion("1-5", "drag 1's start, still one step away");
    }

    beginTest(
        "ENGINE: a CANCELLED drag (cancelGesture) leaves the log as it found "
        "it - its step dropped, the redo branch back; a re-time's origin, "
        "re-time and top exactly as they were, an unset top unset");
    {
      // Mock twin: ui/js/tests/undo.test.mjs ("a cancelled drag…"). A
      // restore by one more live commit would leave a (start → start)
      // undo step and lose the redo branch the first commit invalidated.
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      const juce::String c = is.record(4 * Q);
      is.window(b, 2 * Q, 6 * Q);
      // A redo branch to lose: a rename, undone.
      is.engine.renameNode(b, "Bass");
      is.engine.undo();
      expect(is.engine.canRedo(), "redo holds the rename");

      // THE DRAG: its first commit opens the gesture and logs its step
      // (redo is invalidated - for now); the live ones coalesce.
      is.slide(b,3 * Q, false);
      expect(!is.engine.canRedo(), "an edit invalidates the redo branch");
      is.slide(b,4 * Q, true);
      expect(is.region(b) == "4-8", "the drag landed (" + is.region(b) + ")");
      // ESCAPE.
      is.engine.cancelGesture(b);
      expect(is.region(b) == "2-6", "back where the gesture found it (" + is.region(b) + ")");
      expect(is.engine.canRedo(), "the redo branch is back");
      is.engine.redo();
      expect(is.sprop(b, "name") == "Bass", "...and it is the same branch");
      // No step is the cancelled drag's: ⌘Z undoes the rename, then the
      // window itself.
      is.engine.undo();
      expect(is.sprop(b, "name") != "Bass", "undo: the rename");
      is.engine.undo();
      expect(is.region(b) == "0-0", "undo: the window (" + is.region(b) + ")");
      is.engine.redo();
      expect(is.region(b) == "2-6", "redo: the window");

      // A gesture that logged NOTHING (its first commit an identity)
      // cancels to nothing, and the stack is not touched.
      is.slide(b,2 * Q, false);
      is.engine.cancelGesture(b);
      expect(is.region(b) == "2-6", "an identity gesture: nothing to put back");
      is.engine.undo();
      expect(is.region(b) == "0-0", "the step on top is still the window's");
      is.engine.redo();
      // Another node's gesture is not this node's to cancel…
      is.slide(b,3 * Q, false);
      is.engine.cancelGesture(c);
      expect(is.region(b) == "3-7", "another node's cancel changes nothing");
      // …and a gesture that has ENDED (another entry was logged) cannot
      // be cancelled: the step on top is not its own.
      is.engine.renameNode(b, "Keys");
      is.engine.cancelGesture(b);
      expect(is.sprop(b, "name") == "Keys" && is.region(b) == "3-7",
             "an ended gesture is not cancelled");

      // A RE-TIME drag on a plain loop whose top was never set: the
      // cancel puts back origin and re-time, and the top is UNSET again
      // (a restore by commit could only store it where it showed).
      const AudioNode* cn = is.nodePtr(c);
      expect(cn != nullptr && cn->storedTop() == timing::kNoTop, "never set");
      const int64_t O = is.origin(c), R = is.iprop(c, "retime");
      is.engine.setTiming(c, Q, 2 * Q);                    // opens: +1Q, ↺ on 2Q
      is.engine.setTiming(c, Q / 2, 3 * Q, true);          // live
      expectEquals(is.origin(c), O + 3 * Q / 2, "the re-time applied");
      expectEquals(cn->storedTop(), 3 * Q, "the top stored");
      is.engine.cancelGesture(c);
      expectEquals(is.origin(c), O, "cancel: the origin");
      expectEquals(is.iprop(c, "retime"), R, "...the re-time");
      expect(cn->storedTop() == timing::kNoTop, "...and the top unset again");

      // A SEEK while the gesture is open moves every absolute the log
      // holds - the redo branch the gesture keeps too: put back by the
      // cancel, it must land on the moved island.
      is.engine.setTiming(c, Q);       // an entry whose redo carries an origin
      is.engine.undo();
      expectEquals(is.origin(c), O, "undone");
      is.slide(b,2 * Q, false);             // b's gesture: the redo branch is kept
      is.slide(b,4 * Q, true);
      const int64_t z0 = is.zero();
      expect(is.engine.seekTransport((double)(Q / 2 + 123)), "seek applied");
      const int64_t moved = is.zero() - z0;
      expect(moved != 0, "the seek moved the island");
      expectEquals(is.origin(c), O + moved, "c rode the seek");
      is.engine.cancelGesture(b);
      expect(is.engine.canRedo(), "the kept branch is back");
      is.engine.redo();
      expectEquals(is.origin(c), O + moved + Q,
                   "redo lands on the moved island, 1Q on");
    }

    beginTest(
        "ENGINE: an identity setSegments (the stored cell map again) records "
        "nothing - the undo stack and the redo branch stand - and a drag "
        "whose first commit it is still forms one undo step");
    {
      // Mock twins: ui/js/tests/mock_contract.test.mjs and the
      // differential's window/refusals and cuts/refusals journeys.
      Rig is;
      is.record(Q);
      const juce::String b = is.record(8 * Q);
      const AudioNode* node = is.nodePtr(b);
      expect(node != nullptr, "the take");
      // Two cells a Q apart, from `a`: period 2Q.
      auto cells = [](int64_t a) {
        return mapOf({{a, a + Q}, {a + 2 * Q, a + 3 * Q}});
      };
      auto mapIs = [&](const timing::TimeMap& want) {
        if (node == nullptr) return false;
        const timing::TimeMap m = node->storedMap();
        bool same = m.n == want.n;
        for (int i = 0; same && i < m.n; ++i)
          same = m.segs[i].start == want.segs[i].start &&
                 m.segs[i].end == want.segs[i].end;
        return same;
      };
      expect(mapIs(timing::TimeMap::none()), "a fresh take: no map");
      is.engine.setSegments(b, cells(Q));      // step A
      is.engine.setSegments(b, cells(2 * Q));  // step B
      is.engine.undo();
      expect(is.engine.canRedo(), "B waits on the redo branch");
      is.engine.setSegments(b, cells(Q));      // the stored map again
      expect(mapIs(cells(Q)), "the identity changed nothing");
      expect(is.engine.canRedo(), "...and kept the redo branch");
      is.engine.redo();
      expect(mapIs(cells(2 * Q)), "redo: B");
      is.engine.undo();
      is.engine.undo();
      expect(mapIs(timing::TimeMap::none()),
             "two undos reach A's own step: the identity stacked none");
      // A DRAG whose first commit is the identity opens its gesture
      // anyway: its live commits form ONE step, and a live commit that
      // dwells on the stored map records nothing.
      is.engine.redo();
      expect(mapIs(cells(Q)), "A again");
      is.engine.setSegments(b, cells(Q));  // the drag's first commit
      is.engine.setSegments(b, cells(2 * Q), true);
      is.engine.setSegments(b, cells(3 * Q), true);
      is.engine.setSegments(b, cells(3 * Q), true);  // dwelling
      expect(mapIs(cells(3 * Q)), "the drag landed");
      is.engine.undo();
      expect(mapIs(cells(Q)), "one undo takes the whole drag back");
      is.engine.undo();
      expect(mapIs(timing::TimeMap::none()), "...and the next is A's");
    }

    beginTest(
        "ENGINE: the Q13 definer's re-trim reconciles its top; the "
        "lock-collapse carries the top (raw - the window start) and the "
        "undo puts it back");
    {
      Rig is;
      const juce::String c = is.record(Q);
      const juce::String d = is.record(2 * Q);
      is.engine.setTiming(c, 0, Q / 2);  // c is not the definer while d exists
      expectEquals(is.iprop(c, "loopTop"), Q / 2, "a top on the first take");
      is.engine.deleteNode(d);  // c is the island's only content again
      expectEquals(is.state().getProperty("definerId", "").toString(), c,
                   "c defines Q again");
      is.engine.setLoopPoints(c, Q / 4, 3 * Q / 4);  // Q13: Q := Q/2
      expectEquals(is.Q(), Q / 2, "the re-trim re-established Q");
      expectEquals(is.iprop(c, "loopTop"), Q / 2, "...and kept the top it plays");
      const int64_t moment = is.origin(c) + is.iprop(c, "loopTop");
      // A take armed against the trimmed island COLLAPSES the definer:
      // its window becomes the take (base += Q/4, origin += Q/4).
      const juce::String e = is.createClip();
      is.engine.startRecordingInNode(e);
      expectEquals(is.dur(c), Q / 2, "collapsed to the window");
      expectEquals(is.iprop(c, "loopTop"), Q / 4, "the top, re-expressed in the collapsed take");
      expectEquals(is.origin(c) + is.iprop(c, "loopTop"), moment,
                   "...at the same moment");
      is.engine.stopRecordingInNode(e);  // armed: a cancel
      is.settle();
      is.engine.undo();  // the collapse
      expectEquals(is.dur(c), Q, "uncollapsed");
      expectEquals(is.iprop(c, "loopTop"), Q / 2, "the raw top is back");
      is.engine.setLoopPoints(c, 0, Q / 4);  // a re-trim that drops it
      expectEquals(is.iprop(c, "loopTop"), (int64_t)0, "a re-trim past the top resets it");
      is.engine.undo();
      expectEquals(is.iprop(c, "loopTop"), Q / 2, "undo: the top with the trim");
      expectEquals(is.Q(), Q / 2, "...and the grid it re-established");
    }
  }

  /** A clip plays its own multi-segment map, and splices to it. */
  void clipPlaybackTests() {
    beginTest(
        "Multi-segment CLIP playback: the anchoring law, seam-exact");
    {
      // A 1000-sample ramp take, origin 100, cells {[250,450),[650,850)}
      // → period 400, anchored at origin + mapOffset(0) = 350.
      const int N = 1000;
      std::vector<float> content((size_t)N);
      for (int i = 0; i < N; ++i) content[(size_t)i] = rampAt(i);
      auto owned = test_utils::loadedClip("cells", 44100.0, 100, N, rampAt);
      ClipNode& clip = *owned;
      clip.setLoopPoints(0, N);
      const timing::TimeMap cells = mapOf({{250, 450}, {650, 850}});
      clip.setMap(cells);
      clip.startPlayback();

      auto sampleAt = [&](int64_t t) {
        return test_utils::renderBlock(clip, 1, t).left[0];
      };
      const int64_t A = 100 + 250;  // origin + mapOffset(0)
      expectWithinAbsoluteError(sampleAt(A), content[250], 1e-7f,
                                "heard 0 = first segment's start");
      expectWithinAbsoluteError(sampleAt(A + 199), content[449], 1e-7f,
                                "end of segment 0");
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "SEAM: heard 200 jumps to segment 1");
      expectWithinAbsoluteError(sampleAt(A + 399), content[849], 1e-7f,
                                "end of the pass");
      expectWithinAbsoluteError(sampleAt(A + 400), content[250], 1e-7f,
                                "pass wraps to the top");

      // A block crossing the seam at heard 200 must be sample-exact (the
      // run splitting inside the clip loop).
      {
        const auto out = test_utils::renderBlock(clip, 128, A + 150).left;
        bool ok = true;
        for (int i = 0; i < 128 && ok; ++i) {
          const int64_t h = 150 + i;
          const int64_t p = h < 200 ? 250 + h : 650 + (h - 200);
          ok = std::abs(out[(size_t)i] - content[(size_t)p]) < 1e-7f;
        }
        expect(ok, "mid-block seam is sample-exact");
      }

      // Bypass → honest full take (Degradation Contract on clips).
      clip.setLoopWindowBypassed(true);
      expectWithinAbsoluteError(sampleAt(100 + 500), content[500], 1e-7f,
                                "bypassed: content at its inner moment");
      clip.setLoopWindowBypassed(false);
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "re-activation restores the map");

      // SPLICE COLLAPSE: the kept cells become the take; playback at
      // the same island moments is sample-identical. A stored top (raw
      // 700, heard offset 250 — it sounds at 100 + 250 + 250 = 600)
      // lands at its heard offset in the spliced take, keeping its
      // moment (350 + 250).
      clip.setStoredTop(700);
      auto old = clip.spliceToMap(cells);  // geometry := the new full span
      expectEquals((juce::int64)clip.getIntrinsicDuration(), (juce::int64)400,
                   "spliced duration = period");
      expectEquals((juce::int64)clip.origin_samples.load(), (juce::int64)350,
                   "spliced origin = old origin + mapOffset(0)");
      expectEquals((juce::int64)clip.storedTop(), (juce::int64)250,
                   "spliced top = its heard offset (the moment holds)");
      expectWithinAbsoluteError(sampleAt(A), content[250], 1e-7f,
                                "spliced: heard 0 unchanged");
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "spliced: seam content unchanged");
      expectWithinAbsoluteError(sampleAt(A + 399), content[849], 1e-7f,
                                "spliced: pass end unchanged");

      // UN-SPLICE: full material + map return; playback unchanged.
      auto displaced = clip.unspliceFromMap(std::move(old), 100, N, 0, N,
                                            /*old_collapsed_from=*/0,
                                            /*old_top=*/700);
      clip.setMap(cells);
      expectEquals((juce::int64)clip.getIntrinsicDuration(), (juce::int64)N,
                   "unspliced duration restored");
      expectEquals((juce::int64)clip.storedTop(), (juce::int64)700,
                   "unspliced top restored raw");
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "unspliced: mapped playback unchanged");
      // A stored top the map does NOT play (raw 500, in the cut) was not
      // the effective one — the region start stood in — so the splice
      // stores that start, 0: a top once set stays a fact (only a take
      // never edited is unset).
      clip.setStoredTop(500);
      auto old2 = clip.spliceToMap(cells);
      expectEquals((juce::int64)clip.storedTop(), (juce::int64)0,
                   "a dropped top: the spliced take's start, stored");
      auto displaced2 = clip.unspliceFromMap(std::move(old2), 100, N, 0, N,
                                             /*old_collapsed_from=*/0,
                                             /*old_top=*/500);
      clip.setMap(cells);
      expectEquals((juce::int64)clip.storedTop(), (juce::int64)500,
                   "...and the un-splice puts the raw one back");
      clip.setLoopWindowBypassed(true);
      expectWithinAbsoluteError(sampleAt(100 + 999), content[999], 1e-7f,
                                "unspliced: full material intact");
    }
  }
};

static TimeMapRecordTests timeMapRecordTests;

}  // namespace celestrian
