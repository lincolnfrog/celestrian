#include <juce_core/juce_core.h>

#include <cmath>
#include <memory>
#include <vector>

#include "../src/dsp/fx_chain.h"
#include "../src/dsp/vst3_slot.h"
#include "stub_plugin_instance.h"

namespace celestrian {

/**
 * Vst3Slot + the chain's Q-V1 stereo promotion (docs/vst3.md §3),
 * exercised entirely through the in-tree stub instance (Q-V5: no real
 * plugin binaries in unit tests; the real-binary twin lives in
 * plugin_host_integration_tests.cc).
 */
class Vst3SlotTests : public juce::UnitTest {
 public:
  Vst3SlotTests() : juce::UnitTest("VST3 Slot & Promotion", "DSP") {}

  /** A default chain with a stub-backed vst3 slot appended. Returns
   * the chain; `out_slot` receives the slot for direct assertions. */
  static std::unique_ptr<dsp::FxChain> chainWithStub(
      dsp::Vst3Slot** out_slot, float gain = 0.5f) {
    auto chain = dsp::FxChain::makeDefault();
    auto slots = chain->slots();
    auto slot = test_utils::makeStubGainSlot(gain);
    if (out_slot != nullptr) *out_slot = slot.get();
    slots.push_back(std::move(slot));
    return dsp::FxChain::makeFromSlots(std::move(slots));
  }

  void runTest() override {
    const double sr = 44100.0;

    beginTest("live slot: prepared stereo, processes, reports latency");
    {
      dsp::Vst3Slot* slot = nullptr;
      auto chain = chainWithStub(&slot);
      chain->prepare(sr);
      auto* stub =
          static_cast<test_utils::StubPluginInstance*>(slot->instance());
      expectEquals(stub->prepare_count, 1, juce::String("prepared once"));
      expectEquals(stub->prepared_rate, sr);
      expectEquals(stub->prepared_block, (int)dsp::Vst3Slot::kMaxBlockSize);
      chain->prepare(sr);  // idempotent per rate (slot dedupes)
      expectEquals(stub->prepare_count, 1, juce::String("no re-prepare"));

      slot->enabled.store(true);
      std::vector<float> l(512, 1.0f), r(512, 1.0f);
      chain->run(l.data(), r.data(), 512, true);
      expectWithinAbsoluteError(l[0], 0.5f, 1e-6f, "stub gain applied L");
      expectWithinAbsoluteError(r[511], 0.5f, 1e-6f, "stub gain applied R");

      expectEquals(slot->latencySamples(),
                   (int)test_utils::StubPluginInstance::kLatency);
      expectEquals(chain->totalLatencySamples(),
                   (int)test_utils::StubPluginInstance::kLatency,
                   juce::String("chain latency sums enabled slots"));
      slot->enabled.store(false);
      expectEquals(chain->totalLatencySamples(), 0,
                   juce::String("disabled slots report no latency"));
    }

    beginTest("prepare is the first prepare only; followRate moves a "
              "prepared slot, released first");
    {
      // The host protocol pairs prepareToPlay with releaseResources: a
      // hosted plugin still active from its first prepare takes a
      // repeat prepare as nothing to do.
      struct PairingStub : test_utils::StubPluginInstance {
        int releases = 0;
        int releases_at_last_prepare = -1;
        void prepareToPlay(double rate, int block) override {
          releases_at_last_prepare = releases;
          StubPluginInstance::prepareToPlay(rate, block);
        }
        void releaseResources() override { ++releases; }
      };
      const auto makeSlot = [] {
        return std::make_shared<dsp::Vst3Slot>(std::make_unique<PairingStub>(),
                                               "Pair-uid", "Pairing",
                                               "/stub/Pairing.vst3");
      };
      auto slot = makeSlot();
      auto* stub = static_cast<PairingStub*>(slot->instance());

      slot->prepare(44100.0);
      expectEquals(stub->prepare_count, 1, juce::String("prepared once"));
      expectEquals(stub->releases, 0,
                   juce::String("a first prepare releases nothing"));

      slot->prepare(48000.0);
      expectEquals(stub->prepare_count, 1,
                   juce::String("prepare leaves a prepared slot alone"));
      expectEquals(stub->prepared_rate, 44100.0);

      slot->followRate(48000.0);
      expectEquals(stub->prepare_count, 2,
                   juce::String("followRate prepares it again"));
      expectEquals(stub->prepared_rate, 48000.0);
      expectEquals(stub->releases_at_last_prepare, 1,
                   juce::String("released before it was prepared again"));

      slot->followRate(48000.0);
      expectEquals(stub->prepare_count, 2,
                   juce::String("already at the rate: nothing to do"));

      auto fresh = makeSlot();
      fresh->followRate(48000.0);
      expectEquals(static_cast<PairingStub*>(fresh->instance())->prepare_count,
                   0, juce::String("a slot never prepared stays so"));
    }

    beginTest("promotion: mono pass goes stereo at the first vst3 slot");
    {
      dsp::Vst3Slot* slot = nullptr;
      auto chain = chainWithStub(&slot);
      chain->prepare(sr);
      slot->enabled.store(true);

      // Caller provides a right buffer (the clip render shape): the
      // pass promotes and REPORTS stereo out.
      std::vector<float> l(256, 0.8f), r(256, 0.0f);
      const bool out_stereo = chain->run(l.data(), r.data(), 256, false);
      expect(out_stereo, "promoted pass reports stereo");
      expectWithinAbsoluteError(l[0], 0.4f, 1e-6f, "L processed");
      expectWithinAbsoluteError(r[0], 0.4f, 1e-6f,
                                "R = promoted duplicate, processed");

      // No vst3 slot enabled: a mono pass stays mono.
      slot->enabled.store(false);
      std::fill(l.begin(), l.end(), 0.8f);
      std::fill(r.begin(), r.end(), 0.0f);
      expect(!chain->run(l.data(), r.data(), 256, false),
             "no promotion without an enabled vst3 slot");
      expectWithinAbsoluteError(r[0], 0.0f, 1e-9f, "R untouched");
    }

    beginTest("promotion order: built-ins BEFORE the vst3 slot stay mono");
    {
      // echo (mono state) before the stub: the echo processes the mono
      // signal; the stub then sees the promoted pair — L and R agree
      // (identical duplicate through a linear effect).
      dsp::Vst3Slot* slot = nullptr;
      auto chain = chainWithStub(&slot);
      chain->prepare(sr);
      auto* echo_slot = chain->slots()[2].get();
      echo_slot->setParam("time", 0.05);
      echo_slot->setParam("mix", 0.8);
      echo_slot->setParam("feedback", 0.0);
      echo_slot->enabled.store(true);
      slot->enabled.store(true);

      std::vector<float> l(8192, 0.0f), r(8192, 0.0f);
      l[0] = 1.0f;
      chain->run(l.data(), r.data(), 8192, false);
      // dry impulse * 0.5, echo at 2205 * 0.8 * 0.5 — on BOTH channels
      expectWithinAbsoluteError(l[0], 0.5f, 0.01f, "dry through stub L");
      expectWithinAbsoluteError(r[0], 0.5f, 0.01f, "dry through stub R");
      expectWithinAbsoluteError(l[2205], 0.4f, 0.01f, "echo through stub L");
      expectWithinAbsoluteError(r[2205], 0.4f, 0.01f, "echo through stub R");
    }

    beginTest("mono caller (null right): internal promotion folds back");
    {
      dsp::Vst3Slot* slot = nullptr;
      auto chain = chainWithStub(&slot);
      chain->prepare(sr);
      slot->enabled.store(true);

      std::vector<float> l(256, 0.8f);
      const bool out_stereo = chain->run(l.data(), nullptr, 256, false);
      expect(!out_stereo, "mono caller stays mono");
      // 0.8 duplicated, both * 0.5, folded 0.5(L+R) = 0.4
      expectWithinAbsoluteError(l[0], 0.4f, 1e-6f, "processed and folded");
    }

    beginTest("mono caller: a chain built around a prepared slot promotes "
              "as built");
    {
      // The add path prepares the ARRIVING slot and publishes the
      // successor chain as built — nothing prepares the chain itself.
      auto slot = test_utils::makeStubGainSlot();
      slot->prepare(sr);
      slot->enabled.store(true);
      auto slots = dsp::FxChain::makeDefault()->slots();
      slots.push_back(slot);
      auto chain = dsp::FxChain::makeFromSlots(std::move(slots));

      std::vector<float> l(256, 0.8f);
      expect(!chain->run(l.data(), nullptr, 256, false),
             "mono caller stays mono");
      expectWithinAbsoluteError(l[0], 0.4f, 1e-6f,
                                "the slot ran: processed and folded");
    }

    beginTest("a plugin that will not run stereo is bypassed and says so");
    {
      // Mono out only: the stereo layout every slot runs at is refused.
      struct MonoOutStub : test_utils::StubPluginInstance {
        bool isBusesLayoutSupported(const BusesLayout& layouts) const override {
          return layouts.getMainOutputChannels() <= 1;
        }
      };
      auto slots = dsp::FxChain::makeDefault()->slots();
      auto slot = std::make_shared<dsp::Vst3Slot>(
          std::make_unique<MonoOutStub>(), "Mono-uid", "Mono Out",
          "/stub/MonoOut.vst3");
      slot->enabled.store(true);
      slots.push_back(slot);
      auto chain = dsp::FxChain::makeFromSlots(std::move(slots));
      chain->prepare(sr);

      std::vector<float> l(128, 0.8f), r(128, 0.8f);
      chain->run(l.data(), r.data(), 128, true);
      expectWithinAbsoluteError(l[0], 0.8f, 1e-9f,
                                "the plugin never sees a two-channel block");
      expectWithinAbsoluteError(r[0], 0.8f, 1e-9f, "right untouched too");
      expect((bool)chain->getMetadata()[4].getProperty("unsupported", false),
             "the slot publishes that its layout is unsupported");

      // A plugin that takes the layout publishes the flag as false.
      dsp::Vst3Slot* fine = nullptr;
      auto good = chainWithStub(&fine);
      good->prepare(sr);
      const juce::var entry = good->getMetadata()[4];
      expect(entry.hasProperty("unsupported") &&
                 !(bool)entry.getProperty("unsupported", true),
             "a stereo plugin is supported");
    }

    beginTest("a share of a slot keeps its plugin instance alive after "
              "every chain has let the slot go");
    {
      // What an open editor window holds: the instance its editor shows
      // must outlive the chains and undo entries that drop the slot.
      struct TrackedStub : test_utils::StubPluginInstance {
        explicit TrackedStub(bool& gone) : destroyed(gone) {}
        ~TrackedStub() override { destroyed = true; }
        bool& destroyed;
      };
      bool destroyed = false;
      dsp::Vst3Slot* raw = nullptr;
      std::unique_ptr<dsp::FxChain> chain;
      {
        auto slots = dsp::FxChain::makeDefault()->slots();
        auto slot = std::make_shared<dsp::Vst3Slot>(
            std::make_unique<TrackedStub>(destroyed), "Tracked-uid", "Tracked",
            "/stub/Tracked.vst3");
        raw = slot.get();
        slots.push_back(std::move(slot));
        chain = dsp::FxChain::makeFromSlots(std::move(slots));
      }
      // The engine hands out the slot by raw pointer; the share is taken
      // from the slot itself.
      std::shared_ptr<dsp::Vst3Slot> share = raw->owner();
      expect(share != nullptr && share.get() == raw, "a share of the slot");
      chain.reset();
      expect(!destroyed, "the last chain is gone; the instance is not");
      share.reset();
      expect(destroyed, "the last share releases the instance");

      // A slot nothing shares has no share to give.
      dsp::Vst3Slot lone("Lone-uid", "Lone", "/stub/Lone.vst3",
                         juce::MemoryBlock());
      expect(lone.owner() == nullptr, "an unshared slot answers null");
    }

    beginTest("placeholder: hard bypass, identity kept, state verbatim");
    {
      juce::MemoryBlock state;
      const float saved_gain = 0.25f;
      state.replaceAll(&saved_gain, sizeof(saved_gain));
      auto slots = dsp::FxChain::makeDefault()->slots();
      auto placeholder = std::make_shared<dsp::Vst3Slot>(
          "Stub-uid", "Stub Gain", "/stub/StubGain.vst3", state);
      placeholder->enabled.store(true);
      auto* raw = placeholder.get();
      slots.push_back(std::move(placeholder));
      auto chain = dsp::FxChain::makeFromSlots(std::move(slots));
      chain->prepare(sr);

      expect(raw->isMissing());
      std::vector<float> l(128, 0.8f), r(128, 0.8f);
      chain->run(l.data(), r.data(), 128, true);
      expectWithinAbsoluteError(l[0], 0.8f, 1e-9f, "placeholder bypasses");

      // Metadata carries missing=true; the SAVE form keeps the blob.
      const auto meta = chain->getMetadata(true);
      const auto& entry = meta[4];
      expect((bool)entry.getProperty("missing", false), "missing published");
      expectEquals(entry.getProperty("type", "").toString(),
                   juce::String("vst3"));
      juce::MemoryBlock round_trip;
      round_trip.fromBase64Encoding(
          entry.getProperty("state", "").toString());
      expect(round_trip == state, "state blob rides the save verbatim");
      // The 20 Hz metadata form must NOT carry the blob.
      expect(!chain->getMetadata().getArray()->getReference(4).hasProperty(
                 "state"),
             "poll metadata omits the state blob");
    }

    beginTest("state round-trip through a live instance");
    {
      dsp::Vst3Slot* slot = nullptr;
      auto chain = chainWithStub(&slot, 0.75f);
      chain->prepare(sr);
      const juce::MemoryBlock saved = slot->stateBlob();

      dsp::Vst3Slot* twin = nullptr;
      auto chain2 = chainWithStub(&twin, 0.1f);
      chain2->prepare(sr);
      twin->restoreState(saved);
      auto* stub =
          static_cast<test_utils::StubPluginInstance*>(twin->instance());
      expectWithinAbsoluteError(stub->gain, 0.75f, 1e-6f,
                                "state restored into the live instance");
    }
  }
};

static Vst3SlotTests vst3_slot_tests;

}  // namespace celestrian
