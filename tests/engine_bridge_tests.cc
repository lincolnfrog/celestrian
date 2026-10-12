/**
 * Engine bridge contract tests: the UI-facing mutation surface that is
 * not covered by undo_tests.cc. Pins the mixer-knob laws (pan/gain
 * clamp, non-undoable), the input-routing edits (undoable, -1 reverts
 * to mono), loop-window bypass round-trips, the prepare-before-enable
 * effect ordering on a device-less engine, effect-param plumbing, the
 * chain's slot verbs, and the undo depth cap (kUndoDepth eviction
 * safety).
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/dsp/vst3_slot.h"
#include "../src/headless/chirp_codec.h"
#include "stub_plugin_instance.h"
#include "test_utils.h"

namespace celestrian {

using test_utils::deepBool;
using test_utils::findVar;
using test_utils::lastTopLevelId;
using test_utils::nodesOf;

namespace {

/** Number of top-level nodes in a getGraphState() var. */
int topLevelCount(const juce::var& state) {
  auto* nodes = nodesOf(state);
  return nodes ? nodes->size() : 0;
}

/** A numeric fact of a node; -999 when the node or the key is absent,
 * so a missing key never reads as a legal value. */
double doubleProperty(AudioEngine& engine, const juce::String& uuid,
                      const juce::Identifier& property) {
  return (double)findVar(engine.getGraphState(), uuid)
      .getProperty(property, -999.0);
}

/** A node's published effects.chain array. */
juce::var chainOf(AudioEngine& engine, const juce::String& uuid) {
  return findVar(engine.getGraphState(), uuid)
      .getProperty("effects", juce::var())
      .getProperty("chain", juce::var());
}

/** How many slots a node's published chain holds. */
int chainLength(AudioEngine& engine, const juce::String& uuid) {
  return chainOf(engine, uuid).size();
}

/** The chain-entry var of the first slot with `type` in a node's
 * published chain; void when absent. */
juce::var chainEntry(AudioEngine& engine, const juce::String& uuid,
                     const juce::String& type) {
  const juce::var chain = chainOf(engine, uuid);
  if (auto* entries = chain.getArray()) {
    for (const auto& entry : *entries)
      if (entry.getProperty("type", "").toString() == type) return entry;
  }
  return {};
}

/** effects.chain[type].<key> from a node's metadata (numeric). */
double effectProperty(AudioEngine& engine, const juce::String& uuid,
                      const juce::String& fx, const juce::Identifier& key) {
  return (double)chainEntry(engine, uuid, fx).getProperty(key, -999.0);
}

/** The slot uuid of the first `type` slot (the bridge's addressing). */
juce::String slotIdOf(AudioEngine& engine, const juce::String& uuid,
                      const juce::String& type) {
  return chainEntry(engine, uuid, type).getProperty("slot", "").toString();
}

/** A fresh engine, on the heap, holding one top-level clip (`uuid`). */
struct OneClip {
  juce::String addClip() {
    engine.createNode("clip");
    return lastTopLevelId(engine);
  }

  std::unique_ptr<AudioEngine> owner = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owner;
  const juce::String uuid = addClip();
};

}  // namespace

class EngineBridgeTests : public juce::UnitTest {
 public:
  EngineBridgeTests() : juce::UnitTest("Engine Bridge", "Audio Engine") {}

  /** Expect the rig's clip to publish the numeric fact `key` as `want`. */
  void expectFact(OneClip& rig, const juce::Identifier& key, double want,
                  const juce::String& what) {
    expectWithinAbsoluteError(doubleProperty(rig.engine, rig.uuid, key), want,
                              1e-9, what);
  }

  void runTest() override {
    beginTest("setNodePan clamps to [-1, 1]; unknown uuid is a no-op");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;
      expectFact(rig, "pan", 0.0, "pan defaults to center");

      engine.setNodePan(uuid, 2.5);
      expectFact(rig, "pan", 1.0, "pan clamped to +1 (hard right)");
      engine.setNodePan(uuid, -7.0);
      expectFact(rig, "pan", -1.0, "pan clamped to -1 (hard left)");

      engine.setNodePan("nonsense", 0.5);  // unknown uuid: must not crash
      expectFact(rig, "pan", -1.0, "unknown-uuid pan left the real node alone");
    }

    beginTest("setNodeGain clamps to [0, 1] (attenuate-only law)");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;
      engine.renameNode(uuid, "Named");  // a second undoable edit to peel off

      const bool could_undo_before = engine.canUndo();
      const bool could_redo_before = engine.canRedo();

      engine.setNodeGain(uuid, 5.0);
      expectFact(rig, "gain", 1.0, "gain clamped to unity (no boost)");
      engine.setNodeGain(uuid, -1.0);
      expectFact(rig, "gain", 0.0, "gain clamped to 0 (silent)");
      engine.setNodePan(uuid, 0.5);

      // Mixer knobs are NOT edits: the undo/redo state is untouched.
      expect(engine.canUndo() == could_undo_before,
             "canUndo unchanged by pan/gain");
      expect(engine.canRedo() == could_redo_before,
             "canRedo unchanged by pan/gain");

      // Undo peels the RENAME, not the knobs: pan and gain stay put.
      engine.undo();
      const juce::var node = findVar(engine.getGraphState(), uuid);
      expect(node.getProperty("name", "").toString() == "New Clip",
             "undo reverted the rename (the newest real edit)");
      expectFact(rig, "pan", 0.5, "undo did NOT revert the pan");
      expectFact(rig, "gain", 0.0, "undo did NOT revert the gain");
    }

    beginTest(
        "setNodeInput / setNodeInputRight ride the undo log; "
        "-1 reverts to mono");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;
      const double original_left = doubleProperty(engine, uuid, "inputChannel");
      expectFact(rig, "inputChannelR", -1.0,
                 "fresh clip has no right input (mono)");
      expectFact(rig, "channels", 1.0, "fresh clip is mono");

      engine.setNodeInput(uuid, 3);
      engine.setNodeInputRight(uuid, 4);
      expectFact(rig, "inputChannel", 3.0, "left input set to 3");
      expectFact(rig, "inputChannelR", 4.0, "right input set to 4");
      expectFact(rig, "channels", 2.0, "stereo pair assigned -> 2 channels");

      engine.setNodeInputRight(uuid, -1);
      expectFact(rig, "inputChannelR", -1.0, "-1 clears the right input");
      expectFact(rig, "channels", 1.0, "-1 reverts the clip to mono");

      engine.undo();  // back to right = 4
      expectFact(rig, "inputChannelR", 4.0, "undo restores right input 4");
      expectFact(rig, "channels", 2.0, "undo restores the stereo pair");

      engine.undo();  // back to right = the original, none
      engine.undo();  // back to left = original
      expectFact(rig, "inputChannel", original_left,
                 "two more undos restore the original left");
      expectFact(rig, "inputChannelR", -1.0, "and the original (mono) right");
    }

    beginTest("toggleLoopWindow (LoopBypass) round-trips through undo/redo");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      const juce::String uuid = test_utils::recordSilentTake(engine, 44100);
      expect(test_utils::isClipCommitted(engine, uuid), "take committed");

      const bool bypassed_before = deepBool(engine, uuid, "loopBypassed");
      engine.toggleLoopWindow(uuid);
      expect(deepBool(engine, uuid, "loopBypassed") == !bypassed_before,
             "toggle flipped loopBypassed");
      engine.undo();
      expect(deepBool(engine, uuid, "loopBypassed") == bypassed_before,
             "undo restored the original bypass state");
      engine.redo();
      expect(deepBool(engine, uuid, "loopBypassed") == !bypassed_before,
             "redo flipped it again");
    }

    beginTest("setSlotEnabled via the engine prepares before enabling");
    {
      // Fresh engine: no device ever started, so the prepare runs at the
      // fallback rate. An echo of a tenth of a second, fully wet: an
      // impulse through the node's chain comes back 4410 samples later
      // when the slot was prepared, and not at all when it was not (an
      // unprepared echo has no line and passes the signal through).
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;
      const int echo_at = 4410;
      const auto echoOf = [&](const juce::String& uuid) {
        std::vector<float> block(8192, 0.0f);
        block[0] = 1.0f;
        engine.findNodeByUuidForTest(uuid)->fxChain()->process(
            block.data(), (int)block.size());
        return block[(size_t)echo_at];
      };
      const auto dialEcho = [&](const juce::String& uuid) {
        const juce::String slot = slotIdOf(engine, uuid, "echo");
        engine.setSlotParam(uuid, slot, "time", 0.1);
        engine.setSlotParam(uuid, slot, "feedback", 0.0);
        engine.setSlotParam(uuid, slot, "mix", 1.0);
        return slot;
      };

      engine.setSlotEnabled(uuid, dialEcho(uuid), true);
      expect(effectProperty(engine, uuid, "echo", "enabled") != 0.0,
             "metadata shows the echo enabled");
      expectWithinAbsoluteError(echoOf(uuid), 1.0f, 1e-6f,
                                "the echo sounds: the verb prepared the slot");

      // The control: the flag flipped behind the engine's back enables a
      // slot nobody prepared, and the same read hears nothing.
      const juce::String bare = rig.addClip();
      const juce::String bare_slot = dialEcho(bare);
      engine.findNodeByUuidForTest(bare)
          ->fxChain()
          ->findSlot(bare_slot)
          ->enabled.store(true);
      expectWithinAbsoluteError(echoOf(bare), 0.0f, 1e-9f,
                                "an unprepared echo is silent");

      // Unknown slot uuid: a safe no-op (findSlot returns null; nothing
      // flips, nothing crashes).
      engine.setSlotEnabled(uuid, "no-such-slot", true);
      expect(effectProperty(engine, uuid, "echo", "enabled") != 0.0,
             "known slots untouched by the unknown-slot call");
    }

    beginTest("setSlotParam publishes its value; moveChainSlot reorders, "
              "preserves that state, and is undoable");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;

      const juce::String echo_slot = slotIdOf(engine, uuid, "echo");
      engine.setSlotParam(uuid, echo_slot, "time", 0.5);
      expectWithinAbsoluteError(effectProperty(engine, uuid, "echo", "time"),
                                0.5, 1e-6, "echo time set to 0.5 s");
      // Unknown key: a no-op — the known value is unchanged.
      engine.setSlotParam(uuid, echo_slot, "wobble", 0.9);
      expectWithinAbsoluteError(effectProperty(engine, uuid, "echo", "time"),
                                0.5, 1e-6,
                                "unknown key left the echo time alone");

      // Move echo (index 2) to the head of the chain.
      engine.moveChainSlot(uuid, echo_slot, 0);
      auto typeAt = [&](int i) {
        return chainOf(engine, uuid)[i].getProperty("type", "").toString();
      };
      expectEquals(typeAt(0), juce::String("echo"), "echo moved to head");
      expectEquals(typeAt(1), juce::String("eq"), "eq shifted to index 1");
      expectWithinAbsoluteError(effectProperty(engine, uuid, "echo", "time"),
                                0.5, 1e-6,
                                "slot state survives the reorder");
      expectEquals(slotIdOf(engine, uuid, "echo"), echo_slot,
                   juce::String("slot identity survives the reorder"));

      // Undo restores the canonical order; redo re-applies the move.
      engine.undo();
      expectEquals(typeAt(0), juce::String("eq"), "undo restores order");
      expectEquals(typeAt(2), juce::String("echo"), "echo back at index 2");
      engine.redo();
      expectEquals(typeAt(0), juce::String("echo"), "redo re-applies move");

      // Degenerate moves are not recorded: same index and unknown slot.
      engine.undo();  // back to canonical before probing
      engine.moveChainSlot(uuid, echo_slot, 2);      // already there
      engine.moveChainSlot(uuid, "no-such-slot", 0); // unknown slot
      expectEquals(typeAt(2), juce::String("echo"), "no-op moves change nothing");
    }

    beginTest("addPluginSlotToChain / removeChainSlot: undoable, guarded");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;

      // The stub-backed slot (Q-V5) rides the same engine path the
      // async instantiation completion uses.
      auto slot = test_utils::makeStubGainSlot();
      const juce::String vst3_slot_uuid = slot->slotUuid();
      engine.addPluginSlotToChain(uuid, slot, -1);  // append

      expectEquals(chainLength(engine, uuid), 5, juce::String("slot appended"));
      const juce::var entry = chainOf(engine, uuid)[4];
      expectEquals(entry.getProperty("type", "").toString(),
                   juce::String("vst3"));
      expect((bool)entry.getProperty("enabled", false),
             "an added plugin arrives audible");
      expect(!(bool)entry.getProperty("missing", true), "live, not missing");
      expectEquals((int)entry.getProperty("latency", -1),
                   (int)test_utils::StubPluginInstance::kLatency,
                   juce::String("latency published"));

      // Undo removes it; redo restores THE SAME slot (instance kept by
      // the undo entry).
      const auto lastSlot = [&] {
        return chainOf(engine, uuid)[4].getProperty("slot", "").toString();
      };
      engine.undo();
      expectEquals(chainLength(engine, uuid), 4,
                   juce::String("undo removes the plugin"));
      engine.redo();
      expectEquals(chainLength(engine, uuid), 5,
                   juce::String("redo restores it"));
      expectEquals(lastSlot(), vst3_slot_uuid,
                   juce::String("same slot identity"));

      // removeChainSlot: vst3 only — a built-in refuses.
      engine.removeChainSlot(uuid, slotIdOf(engine, uuid, "reverb"));
      expectEquals(chainLength(engine, uuid), 5,
                   juce::String("built-ins are not removable"));
      engine.removeChainSlot(uuid, vst3_slot_uuid);
      expectEquals(chainLength(engine, uuid), 4,
                   juce::String("vst3 slot removed"));
      engine.undo();
      expectEquals(lastSlot(), vst3_slot_uuid,
                   juce::String("undo restores the removed plugin"));
    }

    beginTest("reviveVst3Slot: placeholder becomes live with kept state");
    {
      OneClip rig;
      AudioEngine& engine = rig.engine;
      const juce::String& uuid = rig.uuid;

      // Install a placeholder directly (the loader's path).
      juce::MemoryBlock state;
      const float saved_gain = 0.25f;
      state.replaceAll(&saved_gain, sizeof(saved_gain));
      auto placeholder = std::make_shared<dsp::Vst3Slot>(
          "Stub-uid", "Stub Gain", "/stub/StubGain.vst3", state,
          /*is_instrument=*/true);
      placeholder->enabled.store(true);
      const juce::String slot_uuid = placeholder->slotUuid();
      {
        auto* node_chain =
            engine.vst3SlotFor(uuid, slot_uuid);  // null — not added yet
        expect(node_chain == nullptr);
      }
      engine.addPluginSlotToChain(uuid, placeholder, -1);
      // (The add force-enables; the placeholder was enabled already.)

      int visited = 0;
      engine.forEachVst3Placeholder(
          [&](const juce::String& node_uuid, const juce::String& s,
              const juce::String& plugin_uid) {
            ++visited;
            expectEquals(node_uuid, uuid);
            expectEquals(s, slot_uuid);
            expectEquals(plugin_uid, juce::String("Stub-uid"));
          });
      expectEquals(visited, 1, juce::String("sweep finds the placeholder"));

      engine.reviveVst3Slot(uuid, slot_uuid,
                            std::make_unique<test_utils::StubPluginInstance>(
                                0.9f));  // state should override this
      auto* live = engine.vst3SlotFor(uuid, slot_uuid);
      expect(live != nullptr && !live->isMissing(), "slot is live");
      auto* stub =
          static_cast<test_utils::StubPluginInstance*>(live->instance());
      expectWithinAbsoluteError(stub->gain, 0.25f, 1e-6f,
                                "kept state applied to the live twin");
      expect(live->enabled.load(), "enable flag carried over");
      expect(live->isInstrument(),
             "instrument flag carried into the live twin");
      int still_missing = 0;
      engine.forEachVst3Placeholder(
          [&](const juce::String&, const juce::String&, const juce::String&) {
            ++still_missing;
          });
      expectEquals(still_missing, 0, juce::String("sweep is now empty"));
    }

    beginTest(
        "undo depth cap: history never exceeds 128 entries and "
        "evictions are safe");
    {
      const auto engine_owner = std::make_unique<AudioEngine>();
      AudioEngine& engine = *engine_owner;
      const int created_count = 130;  // two beyond kUndoDepth (128)
      for (int i = 0; i < created_count; ++i) engine.createNode("clip");
      expect(topLevelCount(engine.getGraphState()) == created_count,
             "130 clips created");

      for (int i = 0; i < 140; ++i) engine.undo();  // beyond exhaustion: safe

      expect(!engine.canUndo(), "undo stack exhausted");
      // Only kUndoDepth (128) inverses were retained: the two oldest
      // creates were evicted, so exactly 130 - 128 = 2 clips survive.
      expect(topLevelCount(engine.getGraphState()) == created_count - 128,
             "at most 128 undos applied (2 evicted creates survive)");
    }
  }
};

static EngineBridgeTests engineBridgeTests;

/**
 * The chirp codec (src/headless/chirp_codec.h): the instrument every
 * engine e2e `listen` assertion measures with. A frame of the sweep
 * must read back as the clock it was written at, and two takes in one
 * mix must come apart.
 */
class ChirpCodecTests : public juce::UnitTest {
 public:
  ChirpCodecTests()
      : juce::UnitTest("Chirp codec (the engine e2e listener)", "Headless") {}

  /** kFrame samples of the sweep from sweep clock `clock`. */
  static std::vector<float> frameAt(int64_t clock, double rate, double gain) {
    std::vector<float> frame((size_t)chirp::kFrame);
    for (int i = 0; i < chirp::kFrame; ++i)
      frame[(size_t)i] = (float)(gain * chirp::chirpAt(clock + i, rate));
    return frame;
  }

  /** One spectrum bin as a span of capture clock, in samples. */
  static double binSpan(double rate) {
    return rate * rate / (chirp::kFrame * chirp::kSweepHzPerSec);
  }

  /** The decoded peak nearest `clock` (a frame's START clock), as an
   * error in bins; a large number when the frame decodes to nothing. */
  static double errorInBins(const std::vector<chirp::Peak>& peaks,
                            int64_t clock, double rate) {
    double nearest = 1.0e9;
    for (const auto& p : peaks) {
      // decode names the clock at the frame's centre.
      const double at_start = p.capture_clock - chirp::kFrame / 2.0;
      nearest = std::min(nearest, std::abs(at_start - (double)clock));
    }
    return nearest / binSpan(rate);
  }

  void runTest() override {
    // Hann with a parabola through the log magnitudes reads a steady
    // tone to under two hundredths of a bin, wherever it falls between
    // two bins.
    const double single_tolerance_bins = 0.02;

    beginTest("a frame of the sweep written at clock c reads back as c, "
              "to under two hundredths of a bin");
    for (const double rate : {44100.0, 48000.0, 96000.0}) {
      double worst = 0.0;
      int frames = 0, clean = 0;
      // A prime step walks the tone across every fraction of a bin,
      // from the sweep's first second to its last ten.
      for (int64_t clock = 0; clock < (int64_t)(230.0 * rate); clock += 9973) {
        const auto peaks =
            chirp::decode(frameAt(clock, rate, 0.5).data(), rate);
        ++frames;
        if (peaks.size() == 1) ++clean;
        worst = std::max(worst, errorInBins(peaks, clock, rate));
      }
      expectEquals(clean, frames,
                   "one take in the frame decodes to exactly one peak at " +
                       juce::String(rate));
      expectLessThan(worst, single_tolerance_bins,
                     "worst error in bins at " + juce::String(rate));
    }

    beginTest("the level is the take's amplitude, within the window's "
              "scalloping");
    {
      const double rate = 44100.0;
      for (const double amplitude : {0.5, 0.1}) {
        for (int64_t clock = 44100; clock < 44100 * 60; clock += 99991) {
          const auto peaks =
              chirp::decode(frameAt(clock, rate, amplitude).data(), rate);
          expect(peaks.size() == 1, "one peak");
          if (peaks.size() != 1) continue;
          // A Hann window reads a tone halfway between two bins 1.4 dB low.
          expect(peaks[0].level > 0.84 * amplitude &&
                     peaks[0].level < 1.01 * amplitude,
                 "level " + juce::String(peaks[0].level) + " for amplitude " +
                     juce::String(amplitude));
        }
      }
    }

    beginTest("two takes captured one second apart resolve in one mix");
    for (const double rate : {44100.0, 48000.0}) {
      // Two neighbours pull at each other's skirts: looser than a lone
      // tone, far inside the half frame the listener attributes by.
      const double pair_tolerance_bins = 0.03;
      double worst = 0.0;
      int frames = 0, resolved = 0;
      for (int64_t first = (int64_t)rate; first < (int64_t)(200.0 * rate);
           first += 300007) {
        const int64_t second = first + (int64_t)rate;
        std::vector<float> mix = frameAt(first, rate, 0.4);
        const std::vector<float> other = frameAt(second, rate, 0.4);
        for (size_t i = 0; i < mix.size(); ++i) mix[i] += other[i];
        const auto peaks = chirp::decode(mix.data(), rate);
        ++frames;
        if (peaks.size() == 2) ++resolved;
        worst = std::max(worst, errorInBins(peaks, first, rate));
        worst = std::max(worst, errorInBins(peaks, second, rate));
      }
      expectEquals(resolved, frames,
                   "two takes decode to exactly two peaks at " +
                       juce::String(rate));
      expectLessThan(worst, pair_tolerance_bins,
                     "each take reads back as its own clock at " +
                         juce::String(rate));
    }

    beginTest("silence, and a signal under the floor, decode to nothing");
    {
      const double rate = 44100.0;
      const std::vector<float> silence((size_t)chirp::kFrame, 0.0f);
      expect(chirp::decode(silence.data(), rate).empty(), "silence");
      expect(chirp::decode(
                 frameAt(441000, rate, chirp::kSilenceAmplitude / 2).data(),
                 rate)
                 .empty(),
             "half the silence amplitude");
    }

    beginTest("input channels start a whole share of the sweep apart");
    {
      const double rate = 44100.0;
      const int channels = 5;
      const int64_t share =
          (int64_t)(chirp::kSweepSeconds * rate / channels);
      expectEquals((juce::int64)chirp::channelShift(0, channels, rate),
                   (juce::int64)0);
      expectEquals((juce::int64)chirp::channelShift(3, channels, rate),
                   (juce::int64)(3 * share));
      // What channel 3 records at sweep clock 0 decodes as its own range.
      const auto peaks = chirp::decode(
          frameAt(chirp::channelShift(3, channels, rate), rate, 0.5).data(),
          rate);
      expectLessThan(
          errorInBins(peaks, chirp::channelShift(3, channels, rate), rate),
          single_tolerance_bins, "channel 3's clock range");
    }
  }
};

static ChirpCodecTests chirpCodecTests;

}  // namespace celestrian
