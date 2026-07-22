#include <juce_core/juce_core.h>

#include <functional>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/clip_node.h"
#include "../src/stack_node.h"

namespace celestrian {

/**
 * Recording through an active time-map (docs/time_maps.md phase 2).
 *
 * Stage 2 (context plumbing): a mapping stack publishes the time-map
 * facts — the map itself, the heard grid anchor (`map_heard_epoch`),
 * the nesting count — to its whole subtree, while the invariant island
 * clock (`island_pos`) passes through unfolded. These are the facts the
 * through-map arm/capture math consumes.
 */
class TimeMapRecordTests : public juce::UnitTest {
 public:
  TimeMapRecordTests()
      : juce::UnitTest("Time-Map Recording", "TimeMapRecord") {}

  /** A leaf that records the context it is handed in control. */
  struct ProbeNode : public AudioNode {
    ProbeNode() : AudioNode("Probe") {}
    ProcessContext seen{};
    bool called = false;
    void control(const float *const *, int,
                 const ProcessContext &ctx) override {
      seen = ctx;
      called = true;
    }
    void render(float *const *, int, const ProcessContext &) const override {}
    juce::var getWaveform(int) const override { return {}; }
    float getCurrentPeak() const override { return 0.0f; }
    NodeType getNodeType() const override { return NodeType::Unknown; }
    int64_t getIntrinsicDuration() const override { return 0; }
  };

  void runTest() override {
    beginTest("Active map publishes map facts; island_pos never folds");
    {
      StackNode stack("Mapped");
      auto probe = std::make_unique<ProbeNode>();
      auto *p = probe.get();
      stack.addChild(std::move(probe));
      stack.setLoopPoints(1000, 2000);  // window [1000, 2000), len 1000

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 16;
      ctx.master_pos = 7500;
      ctx.cycle_epoch = 7000;
      ctx.island_pos = 7500;
      stack.control(nullptr, 0, ctx);

      expect(p->called, "probe reached");
      expect(p->seen.map.active(), "map delivered active");
      expectEquals((juce::int64)p->seen.map.period(), (juce::int64)1000,
                   "map period");
      expectEquals((juce::int64)p->seen.map_heard_epoch, (juce::int64)7000,
                   "heard grid anchor = the RECEIVED cycle top");
      expectEquals(p->seen.map_count, 1, "one active map on the chain");
      // rel = (7500 − 7000) mod 1000 = 500 → folded clock 7000+1000+500.
      expectEquals((juce::int64)p->seen.master_pos, (juce::int64)8500,
                   "master_pos folded through the map");
      expectEquals((juce::int64)p->seen.cycle_epoch, (juce::int64)8000,
                   "cycle_epoch re-based to the map's heard-0 position");
      expectEquals((juce::int64)p->seen.island_pos, (juce::int64)7500,
                   "island_pos passes through UNFOLDED");
    }

    beginTest("Bypassed map publishes nothing");
    {
      StackNode stack("Bypassed");
      auto probe = std::make_unique<ProbeNode>();
      auto *p = probe.get();
      stack.addChild(std::move(probe));
      stack.setLoopPoints(1000, 2000);
      stack.setLoopWindowBypassed(true);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 16;
      ctx.master_pos = 7500;
      ctx.cycle_epoch = 7000;
      ctx.island_pos = 7500;
      stack.control(nullptr, 0, ctx);

      expect(!p->seen.map.active(), "no map delivered");
      expectEquals(p->seen.map_count, 0, "map_count 0");
      expectEquals((juce::int64)p->seen.master_pos, (juce::int64)7500,
                   "clock passes straight through");
    }

    beginTest("Nested active maps: innermost wins, count reports 2");
    {
      StackNode outer("Outer");
      auto inner = std::make_unique<StackNode>("Inner");
      auto *innerPtr = inner.get();
      auto probe = std::make_unique<ProbeNode>();
      auto *p = probe.get();
      innerPtr->addChild(std::move(probe));
      innerPtr->setLoopPoints(0, 300);
      outer.addChild(std::move(inner));
      outer.setLoopPoints(1000, 2000);

      ProcessContext ctx;
      ctx.is_playing = true;
      ctx.num_samples = 16;
      ctx.master_pos = 2500;
      ctx.cycle_epoch = 0;
      ctx.island_pos = 2500;
      outer.control(nullptr, 0, ctx);

      expectEquals(p->seen.map_count, 2,
                   "composed maps counted (recording refuses > 1)");
      expectEquals((juce::int64)p->seen.map.period(), (juce::int64)300,
                   "innermost map delivered");
      // Outer folds 2500 → child time 1500, child epoch 1000; the inner
      // stack's RECEIVED epoch is therefore the outer window top.
      expectEquals((juce::int64)p->seen.map_heard_epoch, (juce::int64)1000,
                   "heard anchor = inner stack's received cycle top");
      expectEquals((juce::int64)p->seen.island_pos, (juce::int64)2500,
                   "island_pos still unfolded through two maps");
    }

    // === Stage 4: the through-map record path itself ===

    // Arrival-indexed ramp so every captured sample identifies WHEN it
    // was performed: ring[i] = rampAt(i).
    auto rampAt = [](int64_t i) { return (float)(i + 1) * 1e-5f; };
    std::vector<float> ring(16384);
    for (size_t i = 0; i < ring.size(); ++i) ring[i] = rampAt((int64_t)i);
    const float *ringPtrs[1] = {ring.data()};

    // Drive control in fixed blocks over [t, until) with the island
    // facts a mapping-root graph would receive from the engine.
    auto driveControl = [&](StackNode &root, int64_t &t, int64_t until,
                            int block) {
      while (t < until) {
        ProcessContext ctx;
        ctx.num_samples = block;
        ctx.is_playing = true;
        ctx.is_recording = true;
        ctx.master_pos = t;
        ctx.island_pos = t;
        ctx.cycle_epoch = 0;
        ctx.quantum = 1000;
        ctx.island_epoch = 0;
        ctx.island = &root;
        ctx.input_clock = t;
        ctx.prerecord_ring = ringPtrs;
        ctx.prerecord_ring_len = (int)ring.size();
        ctx.prerecord_ring_channels = 1;
        root.control(nullptr, 0, ctx);
        t += block;
      }
    };

    // A committed (muted) 4Q sibling so the stack has an inner cycle.
    auto makeCommittedSibling = [&]() {
      auto clip = std::make_unique<ClipNode>("Committed", 44100.0);
      juce::AudioBuffer<float> content(1, 4000);
      content.clear();
      clip->loadCommitted(content, 0);
      clip->duration_samples.store(4000);
      clip->origin_samples.store(0);
      clip->setLoopPoints(0, 4000);
      clip->is_muted.store(true);
      return clip;
    };

    beginTest(
        "FIELD-style: record through an active stack window (fold + "
        "dense silence + origin + commit)");
    {
      StackNode root("Root");
      root.establishIsland(1000, 0);  // Q = 1000, epoch = 0
      root.addChild(makeCommittedSibling());
      root.setLoopPoints(1000, 3000);  // window [1Q, 3Q): period 2000

      auto takeOwned = std::make_unique<ClipNode>("Take", 44100.0);
      auto *take = takeOwned.get();
      root.addChild(std::move(takeOwned));

      // Play up to t = 500, then arm THROUGH the map (C = inner 4Q).
      int64_t t = 0;
      driveControl(root, t, 500, 250);
      take->startRecording(4000);
      // rel_h = 500 → heard target 1000; anchor offset 1000 (mid-pass)
      // → inner origin = mapOffset(1000) = 2000. Capture runs one full
      // period (never stopped) and the cap auto-finishes at 2000 heard.
      driveControl(root, t, 3500, 250);

      expect(take->recState() == ClipNode::RecState::Idle,
             "one-period cap auto-committed the take");
      expect(!take->capHit(), "clean finish, not the D4 wall");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)4000, "commit duration = C (ruling 2)");
      expectEquals((juce::int64)take->origin_samples.load(), (juce::int64)2000,
                   "origin = the anchor's INNER position");
      expectEquals((juce::int64)take->recordedLength(), (juce::int64)2000,
                   "heard length = one map period");
      expectEquals((juce::int64)take->contextCycle(), (juce::int64)2000,
                   "heard frame at arm = effective cycle (window length)");
      expectEquals((juce::int64)root.getIslandEpoch(), (juce::int64)0,
                   "no epoch re-base (C divides the island cycle)");
      expectEquals((juce::int64)root.getIntrinsicDuration(),
                   (juce::int64)4000, "island cycle unchanged");

      // The fold: heard [0, 1000) lands at content [0, 1000) (inner
      // [2000, 3000)); heard [1000, 2000) wraps the pass seam to
      // content [3000, 4000) (inner [1000, 2000)); the never-visited
      // inner [3000, 4000) + [0, 1000) — content [1000, 3000) — is
      // LITERAL SILENCE (ruling 2).
      const auto &buf = take->getAudioBuffer();
      const float *data = buf.getReadPointer(0);
      for (int k : {0, 1, 500, 999}) {
        expectWithinAbsoluteError(data[k], rampAt(1000 + k), 1e-7f,
                                  "pre-seam run at heard order");
      }
      for (int k : {0, 500, 999}) {
        expectWithinAbsoluteError(data[3000 + k], rampAt(2000 + k), 1e-7f,
                                  "post-seam run folded to the tail");
      }
      for (int k : {1000, 1500, 2999}) {
        expectWithinAbsoluteError(data[k], 0.0f, 0.0f,
                                  "unvisited regions are literal silence");
      }

      // I1 pointwise: through the STILL-ACTIVE map, the committed take
      // sounds exactly what was performed at the same heard phase —
      // and identically on every pass (single-sample probes are
      // seam-exact even before the stage-5 block splitting).
      auto probeOut = [&](int64_t at) {
        ProcessContext ctx;
        ctx.num_samples = 1;
        ctx.is_playing = true;
        ctx.master_pos = at;
        ctx.island_pos = at;
        ctx.cycle_epoch = 0;
        ctx.quantum = 1000;
        ctx.island_epoch = 0;
        ctx.island = &root;
        float out[1] = {0.0f};
        float *const outs[] = {out};
        root.process(nullptr, outs, 0, 1, ctx);
        return out[0];
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
      expectWithinAbsoluteError(probeOut(2500), rampAt(1500), 1e-7f,
                                "I9: inner 2500 holds the sample "
                                "performed there");
      expectWithinAbsoluteError(probeOut(1500), rampAt(2500), 1e-7f,
                                "I9: inner 1500 (post-seam material)");
      expectWithinAbsoluteError(probeOut(3500), 0.0f, 0.0f,
                                "I9: unvisited inner time is silent");
      // Re-activation restores full coherence (round trip, not cliff).
      root.setLoopWindowBypassed(false);
      expectWithinAbsoluteError(probeOut(200), rampAt(2200), 1e-7f,
                                "I9: re-activation restores coherence");

      // I1 ROUND TRIP, block-exact: rendering through the still-active
      // map in real block sizes reproduces the fed input sample for
      // sample — including blocks that CROSS the map seam (the stage-5
      // sub-block split; before it, each seam blurred up to a block).
      // Heard phase φ = t mod 2000 was performed at heard time
      // 1000 + ((φ − 1000) mod 2000).
      {
        bool allMatch = true;
        int64_t firstMismatch = -1;
        for (int64_t t = 4000; t < 8000 && allMatch; t += 512) {
          const int n = 512;
          std::vector<float> out((size_t)n, 0.0f);
          float *outPtr = out.data();
          float *const outs[] = {outPtr};
          ProcessContext ctx;
          ctx.num_samples = n;
          ctx.is_playing = true;
          ctx.master_pos = t;
          ctx.island_pos = t;
          ctx.cycle_epoch = 0;
          ctx.quantum = 1000;
          ctx.island_epoch = 0;
          ctx.island = &root;
          root.process(nullptr, outs, 0, 1, ctx);
          for (int i = 0; i < n; ++i) {
            const int64_t phase = (t + i) % 2000;
            const float expected =
                rampAt(1000 + (((phase - 1000) % 2000) + 2000) % 2000);
            if (std::abs(out[(size_t)i] - expected) > 1e-7f) {
              allMatch = false;
              firstMismatch = t + i;
              break;
            }
          }
        }
        expect(allMatch,
               "I1 block round trip through the active map (first "
               "mismatch at t=" +
                   juce::String(firstMismatch) + ")");
      }
    }

    beginTest("Through-map: user stop before one period clamps to the "
              "heard boundary, still commits dense C");
    {
      StackNode root("Root");
      root.establishIsland(1000, 0);
      root.addChild(makeCommittedSibling());
      root.setLoopPoints(1000, 3000);

      auto takeOwned = std::make_unique<ClipNode>("Take", 44100.0);
      auto *take = takeOwned.get();
      root.addChild(std::move(takeOwned));

      int64_t t = 0;
      driveControl(root, t, 500, 250);
      take->startRecording(4000);
      driveControl(root, t, 1600, 250);  // capture from 1000 → heard 600
      take->stopRecording();
      driveControl(root, t, 2500, 250);  // boundary 1000 → commit

      expect(take->recState() == ClipNode::RecState::Idle, "committed");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)4000, "duration = C even for short takes");
      expectEquals((juce::int64)take->recordedLength(), (juce::int64)1000,
                   "stopped at the heard Q boundary");
      const float *data = take->getAudioBuffer().getReadPointer(0);
      expectWithinAbsoluteError(data[0], rampAt(1000), 1e-7f,
                                "content starts at the anchor");
      expectWithinAbsoluteError(data[999], rampAt(1999), 1e-7f,
                                "content ends at the stop boundary");
      expectWithinAbsoluteError(data[1000], 0.0f, 0.0f,
                                "beyond the take: silence");
      expectWithinAbsoluteError(data[3500], 0.0f, 0.0f,
                                "pre-anchor window region: silence");
    }

    beginTest("Through-map: multi-segment map folds segment-general "
              "(cells {Q1, Q3-Q5})");
    {
      // Drive the CLIP directly with a crafted context — the phase-3
      // editor doesn't exist yet, but the record path must already be
      // segment-general (owner direction 2026-07-21).
      ClipNode take("Take", 44100.0);
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {0, 1000};
      cells.segs[1] = {2000, 5000};  // period 4000, inner cycle 5000

      take.startRecording(5000);

      int64_t t = 2500;  // arm mid-Q inside the second segment's pass
      auto drive = [&](int64_t until) {
        while (t < until) {
          ProcessContext ctx;
          ctx.num_samples = 250;
          ctx.is_playing = true;
          ctx.is_recording = true;
          ctx.master_pos = t;  // (a real parent would deliver mapped time;
                               // the arm/capture math only uses island_pos)
          ctx.island_pos = t;
          ctx.cycle_epoch = 0;
          ctx.quantum = 1000;
          ctx.island_epoch = 0;
          ctx.map = cells;
          ctx.map_heard_epoch = 0;
          ctx.map_count = 1;
          ctx.input_clock = t;
          ctx.prerecord_ring = ringPtrs;
          ctx.prerecord_ring_len = (int)ring.size();
          ctx.prerecord_ring_channels = 1;
          take.control(nullptr, 0, ctx);
          t += 250;
        }
      };
      // rel_h = 2500 → heard target 3000 (golden), anchor 3000 →
      // inner origin = mapOffset(3000) = 4000. Full period = 4000.
      drive(7500);

      expect(take.recState() == ClipNode::RecState::Idle,
             "cap committed after one 4Q-heard pass");
      expectEquals((juce::int64)take.duration_samples.load(),
                   (juce::int64)5000, "duration = the 5Q inner cycle");
      expectEquals((juce::int64)take.origin_samples.load(), (juce::int64)4000,
                   "anchor mapped into the visited segment");
      expectEquals((juce::int64)take.recordedLength(), (juce::int64)4000,
                   "heard length = one period");

      // Content runs (heard i ↔ arrival 3000 + i):
      //  [0,1000)   ← heard [0,1000)    (segment-1 tail)
      //  [1000,2000) ← heard [1000,2000) (wrap into segment 0)
      //  [3000,5000) ← heard [2000,4000) (segment 1 head)
      //  [2000,3000) = the skipped Q2 → silence.
      const float *data = take.getAudioBuffer().getReadPointer(0);
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

    beginTest("Bypassed map at arm → plain recording (ruling 4)");
    {
      StackNode root("Root");
      root.establishIsland(1000, 0);
      root.addChild(makeCommittedSibling());
      root.setLoopPoints(1000, 3000);
      root.setLoopWindowBypassed(true);  // map inactive

      auto takeOwned = std::make_unique<ClipNode>("Take", 44100.0);
      auto *take = takeOwned.get();
      root.addChild(std::move(takeOwned));

      int64_t t = 0;
      driveControl(root, t, 500, 250);
      take->startRecording();  // the engine walk finds no active map
      driveControl(root, t, 2600, 250);  // capture from 1000, heard 1600
      take->stopRecording();
      driveControl(root, t, 3500, 250);  // boundary 2000

      expect(take->recState() == ClipNode::RecState::Idle, "committed");
      expectEquals((juce::int64)take->duration_samples.load(),
                   (juce::int64)2000,
                   "mainline commit (stop boundary), NOT C");
      expectEquals((juce::int64)take->origin_samples.load(), (juce::int64)1000,
                   "mainline arm target (no map, no fold)");
      const float *data = take->getAudioBuffer().getReadPointer(0);
      expectWithinAbsoluteError(data[0], rampAt(1000), 1e-7f,
                                "linear capture from the target");
      expectWithinAbsoluteError(data[1999], rampAt(2999), 1e-7f,
                                "linear to the boundary — no fold");
    }

    beginTest("Engine gate: nested ACTIVE maps refuse the arm; one map "
              "arms through");
    {
      AudioEngine engine;
      engine.createNode("stack");
      auto rootState = engine.getGraphState();
      auto nodesVar = rootState.getDynamicObject()->getProperty("nodes");
      const juce::String outerId =
          (*nodesVar.getArray())[0].getDynamicObject()->getProperty("id");
      engine.createNode("stack", outerId);
      // Re-read to find the inner stack and create the clip inside it.
      auto findChildId = [&](const juce::String &parentId) {
        auto st = engine.getGraphState();
        auto nv = st.getDynamicObject()->getProperty("nodes");
        std::function<juce::String(const juce::var &)> scan =
            [&](const juce::var &arr) -> juce::String {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == parentId) {
                auto kids = o->getProperty("nodes");
                if (auto *ka = kids.getArray(); ka && ka->size() > 0) {
                  return (*ka)[ka->size() - 1]
                      .getDynamicObject()
                      ->getProperty("id")
                      .toString();
                }
                return {};
              }
              auto found = scan(o->getProperty("nodes"));
              if (found.isNotEmpty()) return found;
            }
          }
          return juce::String();
        };
        return scan(nv);
      };
      const juce::String innerId = findChildId(outerId);
      expect(innerId.isNotEmpty(), "inner stack created");
      engine.createNode("clip", innerId);
      const juce::String clipId = findChildId(innerId);
      expect(clipId.isNotEmpty(), "clip created");

      // Metadata-only observation (the engine-test discipline): a
      // refused arm leaves the clip neither pending nor recording.
      auto clipArmedOrRecording = [&](const juce::String &id) {
        const juce::var s = engine.getGraphState();  // hold the var
        std::function<bool(const juce::var &)> scan =
            [&](const juce::var &arr) -> bool {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == id) {
                return (bool)o->getProperty("isPendingStart") ||
                       (bool)o->getProperty("isRecording");
              }
              if (scan(o->getProperty("nodes"))) return true;
            }
          }
          return false;
        };
        return scan(s.getProperty("nodes", {}));
      };

      // Activate windows on BOTH ancestors → composed maps → refuse.
      engine.setLoopPoints(outerId, 0, 1000);
      engine.setLoopPoints(innerId, 0, 500);
      engine.startRecordingInNode(clipId);
      expect(!clipArmedOrRecording(clipId),
             "nested active maps: arm refused");

      // Bypass one → a single active map → the arm proceeds.
      engine.toggleLoopWindow(innerId);
      engine.startRecordingInNode(clipId);
      expect(clipArmedOrRecording(clipId),
             "single active map: arm proceeds");

      // === Stage 6: MID-TAKE MAP-EDIT GATE (owner-ruled: refuse) ===
      auto windowOf = [&](const juce::String &id) {
        const juce::var s = engine.getGraphState();  // hold the var
        std::function<std::pair<int64_t, int64_t>(const juce::var &)> scan =
            [&](const juce::var &arr) -> std::pair<int64_t, int64_t> {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == id) {
                return {(int64_t)(double)o->getProperty("loopStart"),
                        (int64_t)(double)o->getProperty("loopEnd")};
              }
              auto found = scan(o->getProperty("nodes"));
              if (found.second != -1) return found;
            }
          }
          return {int64_t{-1}, int64_t{-1}};
        };
        return scan(s.getProperty("nodes", {}));
      };

      // The clip is live in OUTER's subtree — its window edit refuses.
      engine.setLoopPoints(outerId, 0, 700);
      expectEquals((juce::int64)windowOf(outerId).second, (juce::int64)1000,
                   "gate: window edit refused while a take is live");
      auto bypassedOf = [&](const juce::String &id) {
        const juce::var s = engine.getGraphState();  // hold the var
        std::function<int(const juce::var &)> scan =
            [&](const juce::var &arr) -> int {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == id) {
                return (bool)o->getProperty("loopBypassed") ? 1 : 0;
              }
              const int found = scan(o->getProperty("nodes"));
              if (found != -1) return found;
            }
          }
          return -1;
        };
        return scan(s.getProperty("nodes", {}));
      };
      engine.toggleLoopWindow(outerId);
      expectEquals(bypassedOf(outerId), 0,
                   "gate: bypass toggle refused while a take is live");

      // A SIBLING stack (no take in its subtree) stays editable.
      engine.createNode("stack", outerId);
      const juce::String sibId = findChildId(outerId);
      engine.setLoopPoints(sibId, 0, 300);
      expectEquals((juce::int64)windowOf(sibId).second, (juce::int64)300,
                   "gate: sibling window stays editable");

      // Cancel the take → the gate lifts.
      engine.stopRecordingInNode(clipId);  // armed, no capture → cancel
      engine.setLoopPoints(outerId, 0, 700);
      expectEquals((juce::int64)windowOf(outerId).second, (juce::int64)700,
                   "gate lifts when the take ends");
    }
  }
};

static TimeMapRecordTests timeMapRecordTests;

}  // namespace celestrian
