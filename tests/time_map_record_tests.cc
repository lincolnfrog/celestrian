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

    // === Phase 3, Stage 1: multi-segment storage + the Segments edit ===

    beginTest("Map override: storage semantics on the node");
    {
      StackNode s("S");
      timing::TimeMap m;
      m.n = 2;
      m.segs[0] = {0, 1000};
      m.segs[1] = {2000, 3000};
      // Install (single-threaded test: inline delete of the old pointer
      // is fine — no audio thread).
      delete s.exchangeMapOverride(new timing::TimeMap(m));
      expect(s.isLoopWindowActive(), "override alone activates the map");
      expectEquals((juce::int64)s.getEffectivePeriod(), (juce::int64)2000,
                   "effective period = Σ segment lengths");
      expectEquals(s.activeTimeMap().n, 2, "activeTimeMap returns it");
      // Bypass gates BOTH forms; the geometry survives underneath.
      s.setLoopWindowBypassed(true);
      expect(!s.activeTimeMap().active(), "bypass empties the map");
      expect(s.mapOverride() != nullptr, "geometry survives bypass");
      s.setLoopWindowBypassed(false);
      expectEquals(s.activeTimeMap().n, 2, "un-bypass restores");
    }

    beginTest("setSegments: install/publish, delegation, validation, "
              "undo/redo round trips");
    {
      AudioEngine engine;
      engine.createNode("stack");
      juce::String sId;
      {
        const juce::var st = engine.getGraphState();
        sId = (*st.getProperty("nodes", {}).getArray())[0]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      auto segsOf = [&](const juce::String &id) {
        const juce::var st = engine.getGraphState();  // hold the var
        juce::String flat;
        if (auto *a = st.getProperty("nodes", {}).getArray()) {
          for (auto &n : *a) {
            auto *o = n.getDynamicObject();
            if (o && o->getProperty("id").toString() == id) {
              const juce::var sv = o->getProperty("segments");
              if (auto *sa = sv.getArray()) {
                for (auto &v : *sa) {
                  flat += juce::String((int64_t)(double)v) + ",";
                }
              }
            }
          }
        }
        return flat;
      };
      auto makeMap = [](std::initializer_list<std::pair<int64_t, int64_t>>
                            segs) {
        timing::TimeMap m;
        for (auto &s : segs) m.segs[m.n++] = {s.first, s.second};
        return m;
      };

      // Install a 2-segment map (empty stack: intrinsic 0 → no clamp).
      engine.setSegments(sId, makeMap({{0, 1000}, {2000, 3000}}));
      expectEquals(segsOf(sId), juce::String("0,1000,2000,3000,"),
                   "segments published in metadata");

      // Malformed lists refuse (metadata unchanged).
      engine.setSegments(sId, makeMap({{0, 1000}, {500, 1500}}));
      engine.setSegments(sId, makeMap({{2000, 3000}, {0, 1000}}));
      engine.setSegments(sId, makeMap({{0, 0}, {2000, 3000}}));
      expectEquals(segsOf(sId), juce::String("0,1000,2000,3000,"),
                   "overlap/unsorted/empty all refused");

      // n==1 delegates to the single-window path and clears the map.
      engine.setSegments(sId, makeMap({{500, 1500}}));
      expectEquals(segsOf(sId), juce::String(), "override cleared");
      const juce::var st2 = engine.getGraphState();
      auto *o2 = (*st2.getProperty("nodes", {}).getArray())[0]
                     .getDynamicObject();
      expectEquals((juce::int64)(double)o2->getProperty("loopStart"),
                   (juce::int64)500, "delegated to loop points (start)");
      expectEquals((juce::int64)(double)o2->getProperty("loopEnd"),
                   (juce::int64)1500, "delegated to loop points (end)");

      // Undo: the single-window edit restores the override (setsMap).
      engine.undo();
      expectEquals(segsOf(sId), juce::String("0,1000,2000,3000,"),
                   "undo restores the multi-segment map");
      // Undo again: back to no map at all.
      engine.undo();
      expectEquals(segsOf(sId), juce::String(), "undo to pristine");
      // Redo both.
      engine.redo();
      expectEquals(segsOf(sId), juce::String("0,1000,2000,3000,"),
                   "redo reinstalls");
      engine.redo();
      expectEquals(segsOf(sId), juce::String(), "redo re-delegates");

      // Mid-take gate: an armed take in the subtree refuses the edit.
      engine.setSegments(sId, makeMap({{0, 1000}, {2000, 3000}}));
      engine.createNode("clip", sId);
      juce::String cId;
      {
        const juce::var st = engine.getGraphState();
        auto *so = (*st.getProperty("nodes", {}).getArray())[0]
                       .getDynamicObject();
        auto kids = so->getProperty("nodes");
        cId = (*kids.getArray())[0]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      engine.startRecordingInNode(cId);
      engine.setSegments(sId, makeMap({{0, 500}, {600, 900}}));
      expectEquals(segsOf(sId), juce::String("0,1000,2000,3000,"),
                   "gate: refused while a take is live");
      engine.stopRecordingInNode(cId);  // cancel
      engine.setSegments(sId, makeMap({{0, 500}, {600, 900}}));
      expectEquals(segsOf(sId), juce::String("0,500,600,900,"),
                   "gate lifts after cancel");
    }

    beginTest("ENGINE: record through a setSegments cell map (the full "
              "callback path)");
    {
      AudioEngine engine;
      const int BLOCK = 512;
      std::vector<float> inBuf((size_t)BLOCK, 0.1f);
      auto process = [&](int total) {
        float *ins[] = {inBuf.data()};
        float outL[512], outR[512];
        float *outs[] = {outL, outR};
        int remaining = total;
        while (remaining > 0) {
          const int n = std::min(remaining, BLOCK);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          remaining -= n;
        }
      };
      auto nodeProp = [&](const juce::String &id, const char *prop) {
        const juce::var s = engine.getGraphState();  // hold the var
        std::function<double(const juce::var &)> scan =
            [&](const juce::var &arr) -> double {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == id) {
                return (double)o->getProperty(prop);
              }
              const double f = scan(o->getProperty("nodes"));
              if (f == f && f != -1e18) return f;
            }
          }
          return -1e18;
        };
        return (int64_t)scan(s.getProperty("nodes", {}).getArray()
                                 ? s.getProperty("nodes", {})
                                 : juce::var());
      };

      engine.createNode("stack");
      juce::String sId;
      {
        const juce::var st = engine.getGraphState();
        sId = (*st.getProperty("nodes", {}).getArray())[0]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      engine.createNode("clip", sId);
      juce::String aId;
      {
        const juce::var st = engine.getGraphState();
        auto *so = (*st.getProperty("nodes", {}).getArray())[0]
                       .getDynamicObject();
        aId = (*so->getProperty("nodes").getArray())[0]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      // Take A establishes Q (~1 s at 44100).
      engine.startRecordingInNode(aId);
      process(100);
      process(44100);
      engine.stopRecordingInNode(aId);
      for (int i = 0; i < 200 && nodeProp(aId, "isRecording") != 0; ++i) {
        process(512);
      }
      const int64_t dA = nodeProp(aId, "duration");
      expect(dA > 0, "take A committed");

      // Cells {[0, dA/4), [dA/2, 3dA/4)} on the GROUP → period dA/2.
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {0, dA / 4};
      cells.segs[1] = {dA / 2, (3 * dA) / 4};
      engine.setSegments(sId, cells);

      // Record B through the cell map: capped at one period, committed
      // dense at C = the group's inner cycle.
      engine.createNode("clip", sId);
      juce::String bId;
      {
        const juce::var st = engine.getGraphState();
        auto *so = (*st.getProperty("nodes", {}).getArray())[0]
                       .getDynamicObject();
        auto kids = so->getProperty("nodes");
        bId = (*kids.getArray())[kids.getArray()->size() - 1]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      engine.startRecordingInNode(bId);
      // Never stop: the arm waits ≤1 heard pass for its boundary, then
      // one full pass (period = dA/2) auto-commits. Drive past both,
      // then pump until the commit lands.
      process((int)(2 * dA));
      for (int i = 0;
           i < 400 && (nodeProp(bId, "isRecording") != 0 ||
                       nodeProp(bId, "isPendingStart") != 0);
           ++i) {
        process(512);
      }
      expectEquals(nodeProp(bId, "isRecording"), (int64_t)0,
                   "one-period cap auto-committed through the cells");
      expectEquals(nodeProp(bId, "duration"), dA,
                   "commit duration = C (the group inner cycle)");
      // The anchor lands inside a VISITED cell (§3 arm semantics).
      const int64_t orgRel =
          nodeProp(bId, "origin") - nodeProp(aId, "origin");
      const int64_t phase = ((orgRel % dA) + dA) % dA;
      expect((phase >= 0 && phase < dA / 4) ||
                 (phase >= dA / 2 && phase < (3 * dA) / 4),
             "origin phase lands inside a visited cell (got " +
                 juce::String(phase) + " of " + juce::String(dA) + ")");
    }

    beginTest("ENGINE: map edits on a playing clip preserve the sounding "
              "phase (continuity re-anchor, 2026-07-25h)");
    {
      AudioEngine engine;
      const int BLOCK = 512;
      std::vector<float> inBuf((size_t)BLOCK, 0.1f);
      int64_t pumped = 0;  // exact transport position (advances only here)
      auto process = [&](int total) {
        float *ins[] = {inBuf.data()};
        float outL[512], outR[512];
        float *outs[] = {outL, outR};
        int remaining = total;
        while (remaining > 0) {
          const int n = std::min(remaining, BLOCK);
          engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
          pumped += n;
          remaining -= n;
        }
      };
      auto nodeProp = [&](const juce::String &id, const char *prop) {
        const juce::var s = engine.getGraphState();
        std::function<double(const juce::var &)> scan =
            [&](const juce::var &arr) -> double {
          if (auto *a = arr.getArray()) {
            for (auto &n : *a) {
              auto *o = n.getDynamicObject();
              if (o == nullptr) continue;
              if (o->getProperty("id").toString() == id) {
                return (double)o->getProperty(prop);
              }
              const double f = scan(o->getProperty("nodes"));
              if (f == f && f != -1e18) return f;
            }
          }
          return -1e18;
        };
        return (int64_t)scan(s.getProperty("nodes", {}));
      };
      auto childId = [&](const juce::String &sId, int idx) {
        const juce::var st = engine.getGraphState();
        auto *so = (*st.getProperty("nodes", {}).getArray())[0]
                       .getDynamicObject();
        auto kids = so->getProperty("nodes");
        if (idx < 0) idx = kids.getArray()->size() - 1;
        return (*kids.getArray())[idx]
            .getDynamicObject()
            ->getProperty("id")
            .toString();
      };

      engine.createNode("stack");
      juce::String sId;
      {
        const juce::var st = engine.getGraphState();
        sId = (*st.getProperty("nodes", {}).getArray())[0]
                  .getDynamicObject()
                  ->getProperty("id")
                  .toString();
      }
      // Take A defines Q (~1s); take B is a plain 2Q clip.
      engine.createNode("clip", sId);
      const juce::String aId = childId(sId, 0);
      engine.startRecordingInNode(aId);
      process(100);
      process(44100);
      engine.stopRecordingInNode(aId);
      for (int i = 0; i < 200 && nodeProp(aId, "isRecording") != 0; ++i) {
        process(512);
      }
      const int64_t dA = nodeProp(aId, "duration");
      expect(dA > 0, "take A committed");
      engine.createNode("clip", sId);
      const juce::String bId = childId(sId, -1);
      engine.startRecordingInNode(bId);
      process((int)(2 * dA + dA / 2));
      engine.stopRecordingInNode(bId);
      for (int i = 0; i < 400 && (nodeProp(bId, "isRecording") != 0 ||
                                  nodeProp(bId, "isPendingStart") != 0);
           ++i) {
        process(512);
      }
      const int64_t dB = nodeProp(bId, "duration");
      expect(dB >= 2 * dA, "take B committed at >= 2Q");

      // Two committed clips: B is NOT the sole definer — the general
      // continuity branch (not Q13) must carry the phase.
      // Park the playing position inside [0, dB/4).
      auto p0Of = [&](int64_t org, const timing::TimeMap &m) {
        const timing::TimeMap eff =
            m.active() ? m : timing::TimeMap::single(0, dB);
        return eff.mapOffset(pumped - org - eff.mapOffset(0));
      };
      int guard = 0;
      while (guard++ < 400 &&
             p0Of(nodeProp(bId, "origin"), timing::TimeMap::none()) >=
                 dB / 4) {
        process(512);
      }
      const int64_t orgB = nodeProp(bId, "origin");
      const int64_t p0 = p0Of(orgB, timing::TimeMap::none());
      expect(p0 < dB / 4, "parked inside the first quarter");

      // Cut that KEEPS p0's region: {[0, dB/4), [dB/2, 3dB/4)}.
      timing::TimeMap m1;
      m1.n = 2;
      m1.segs[0] = {0, dB / 4};
      m1.segs[1] = {dB / 2, (3 * dB) / 4};
      engine.setSegments(bId, m1);
      const int64_t orgB1 = nodeProp(bId, "origin");
      expect(orgB1 != orgB, "origin re-anchored by the map edit");
      expectEquals((juce::int64)p0Of(orgB1, m1), (juce::int64)p0,
                   "covered position keeps sounding across the edit");

      // Now a map that REMOVES p0's region: {[dB/4, dB/2)} would be
      // n==1 (delegates) — use {[dB/4, dB/2), [3*dB/4, dB)}. The
      // origin stays FIXED (2026-07-25i): deleting the sounding region
      // makes an audible jump expected, and a folded re-anchor rotated
      // the heard lane away from the click.
      timing::TimeMap m2;
      m2.n = 2;
      m2.segs[0] = {dB / 4, dB / 2};
      m2.segs[1] = {(3 * dB) / 4, dB};
      engine.setSegments(bId, m2);
      expectEquals((juce::int64)nodeProp(bId, "origin"), (juce::int64)orgB1,
                   "removed sounding region: origin stays put");

      // ONE undo restores the original origin: consecutive Segments
      // edits coalesce (one gesture, one undo step), and the setsOrigin
      // inverse rides it.
      engine.undo();
      expectEquals((juce::int64)nodeProp(bId, "origin"), (juce::int64)orgB,
                   "undo restores the pre-edit origin");
    }

    // === Phase 3, Stage 2: the fully-fractal clip kernel ===

    beginTest("Multi-segment CLIP playback: the anchoring law, "
              "seam-exact (owner-ruled fully fractal)");
    {
      // A 1000-sample ramp take, origin 100, cells {[250,450),[650,850)}
      // → period 400, anchored at origin + mapOffset(0) = 350.
      ClipNode clip("cells", 44100.0);
      const int N = 1000;
      std::vector<float> content((size_t)N);
      for (int i = 0; i < N; ++i) content[(size_t)i] = (float)(i + 1) * 1e-5f;
      juce::AudioBuffer<float> buf(1, N);
      buf.copyFrom(0, 0, content.data(), N);
      clip.loadCommitted(buf, 0);
      clip.duration_samples.store(N);
      clip.origin_samples.store(100);
      clip.setLoopPoints(0, N);
      timing::TimeMap cells;
      cells.n = 2;
      cells.segs[0] = {250, 450};
      cells.segs[1] = {650, 850};
      delete clip.exchangeMapOverride(new timing::TimeMap(cells));
      clip.startPlayback();

      auto sampleAt = [&](int64_t t) {
        float out[1] = {0.0f};
        float *const outs[] = {out};
        ProcessContext ctx;
        ctx.num_samples = 1;
        ctx.is_playing = true;
        ctx.master_pos = t;
        clip.process(nullptr, outs, 0, 1, ctx);
        return out[0];
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

      // Block render crossing the seam mid-block must be sample-exact
      // (the run splitting inside the clip loop).
      {
        const int B = 128;
        std::vector<float> out((size_t)B, 0.0f);
        float *outPtr = out.data();
        float *const outs[] = {outPtr};
        ProcessContext ctx;
        ctx.num_samples = B;
        ctx.is_playing = true;
        ctx.master_pos = A + 150;  // crosses the seam at heard 200
        clip.process(nullptr, outs, 0, 1, ctx);
        bool ok = true;
        for (int i = 0; i < B && ok; ++i) {
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
      // the same island moments is sample-identical.
      auto old = clip.spliceToMap(cells);
      delete clip.exchangeMapOverride(nullptr);
      expectEquals((juce::int64)clip.getIntrinsicDuration(), (juce::int64)400,
                   "spliced duration = period");
      expectEquals((juce::int64)clip.origin_samples.load(), (juce::int64)350,
                   "spliced origin = old origin + mapOffset(0)");
      expectWithinAbsoluteError(sampleAt(A), content[250], 1e-7f,
                                "spliced: heard 0 unchanged");
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "spliced: seam content unchanged");
      expectWithinAbsoluteError(sampleAt(A + 399), content[849], 1e-7f,
                                "spliced: pass end unchanged");

      // UN-SPLICE: full material + map return; playback unchanged.
      auto displaced = clip.unspliceFromMap(std::move(old), 100, N, 0, N);
      delete clip.exchangeMapOverride(new timing::TimeMap(cells));
      expectEquals((juce::int64)clip.getIntrinsicDuration(), (juce::int64)N,
                   "unspliced duration restored");
      expectWithinAbsoluteError(sampleAt(A + 200), content[650], 1e-7f,
                                "unspliced: mapped playback unchanged");
      clip.setLoopWindowBypassed(true);
      expectWithinAbsoluteError(sampleAt(100 + 999), content[999], 1e-7f,
                                "unspliced: full material intact");
    }
  }
};

static TimeMapRecordTests timeMapRecordTests;

}  // namespace celestrian
