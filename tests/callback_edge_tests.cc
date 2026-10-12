/**
 * Callback edge-case tests — the device-callback contract under the
 * geometries JUCE actually delivers in the field: zero-sample blocks,
 * mono devices (one output channel, or a null right pointer), input-less
 * devices, plus the small audio-thread services that ride the callback:
 * the master VU envelope follower, the retire() 2-callback reclamation
 * grace, the bounded RtLog drain, and the xrun gap heuristic.
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

#include "../src/audio_engine.h"
#include "../src/rt_log.h"
#include "test_utils.h"

namespace celestrian {

namespace {

/** A logger that only counts lines — keeps the RtLog storm test from
 *  spamming the console while making the drained line count assertable. */
class CountingLogger : public juce::Logger {
 public:
  void logMessage(const juce::String&) override { ++line_count_; }
  int lineCount() const { return line_count_; }

 private:
  int line_count_ = 0;
};

constexpr int kBlockSize = 512;
constexpr int64_t kClipLength = 44100;

/** The perf.xruns counter from getGraphState. */
int xrunCount(AudioEngine& engine) {
  return (int)(double)engine.getGraphState()
      .getProperty("perf", juce::var())
      .getProperty("xruns", -1.0);
}

/** An engine (on the heap: ~130 KB each) and one block of device I/O. */
struct Device {
  std::unique_ptr<AudioEngine> owned = std::make_unique<AudioEngine>();
  AudioEngine& engine = *owned;
  std::vector<float> input = std::vector<float>((size_t)kBlockSize, 0.0f);
  std::vector<float> left = std::vector<float>((size_t)kBlockSize, 0.0f);
  std::vector<float> right = std::vector<float>((size_t)kBlockSize, 0.0f);

  /** One callback of `count` samples over `channels` output channels
   * (`right_out` null: a stereo count with no right pointer). The left
   * output is cleared first, so it holds this block alone. */
  void block(int count = kBlockSize, int channels = 2, bool right_out = true) {
    std::fill(left.begin(), left.end(), 0.0f);
    float* inputs[] = {input.data()};
    float* outputs[] = {left.data(), right_out ? right.data() : nullptr};
    engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, channels,
                                            count, {});
  }

  /** A committed take of kClipLength samples of the constant
   * `amplitude`, then playing over silent input; answers whether the
   * take committed. */
  bool playConstantTake(float amplitude) {
    std::fill(input.begin(), input.end(), amplitude);
    const juce::String clip_id = test_utils::recordClip(
        engine,
        [&](int total) {
          for (int done = 0; done < total; done += kBlockSize) {
            block(std::min(kBlockSize, total - done));
          }
        },
        kClipLength);
    std::fill(input.begin(), input.end(), 0.0f);
    if (!engine.isPlaying()) engine.togglePlayback();
    return test_utils::isClipCommitted(engine, clip_id);
  }

  double vu(const char* key) {
    return (double)engine.getGraphState().getProperty(key, -1.0);
  }
};

}  // namespace

class CallbackEdgeTests : public juce::UnitTest {
 public:
  CallbackEdgeTests() : juce::UnitTest("Callback Edges", "Audio Engine") {}

  void runTest() override {
    using test_utils::rootProp;

    beginTest("zero-sample callback: no crash, transport unchanged");
    {
      Device device;
      AudioEngine& engine = device.engine;
      expect(device.playConstantTake(0.5f), "take committed");

      test_utils::driveEngine(engine, 4 * kBlockSize);
      const int64_t position_before = rootProp(engine, "masterPos");

      // A zero-sample block: real drivers deliver these around device
      // stop/start. Every per-sample loop in the callback runs zero
      // times and the transport advances by exactly 0. (Observed quirk,
      // deliberately not asserted: num_samples == 0 makes the xrun
      // heuristic's block period 0, so any positive inter-callback gap
      // under 0.5 s counts as an xrun — a stray counter tick, no crash.)
      for (int i = 0; i < 3; ++i) device.block(/*count=*/0);

      expectEquals(rootProp(engine, "masterPos"), position_before,
                   "zero-sample callbacks leave masterPos alone");
      expect(engine.isPlaying(), "transport still running");

      test_utils::driveEngine(engine, kBlockSize);
      expect(rootProp(engine, "masterPos") != position_before,
             "a normal block still advances the transport afterwards");
    }

    beginTest("a device block past the ceiling reaches the graph in slices: "
              "it sounds and records what ceiling-sized blocks do, and no "
              "node's scratch grows");
    {
      using test_utils::EngineRig;
      // One device callback of `n` samples of the rig's ramp.
      const auto callback = [](EngineRig& rig, int n, std::vector<float>& heard) {
        std::vector<float> in((size_t)n), left((size_t)n), right((size_t)n);
        for (int i = 0; i < n; ++i) in[(size_t)i] = EngineRig::rampAt(rig.clock + i);
        float* ins[] = {in.data()};
        float* outs[] = {left.data(), right.data()};
        rig.engine.audioDeviceIOCallbackWithContext(ins, 1, outs, 2, n, {});
        rig.clock += n;
        heard.insert(heard.end(), left.begin(), left.end());
      };
      // Twin rigs with one history: `big` runs every span as one block of
      // two ceilings, `ceiling` as two blocks of one.
      const int ceiling_block = kMaxBlockSamples;
      EngineRig big, ceiling;
      std::vector<float> big_heard, ceiling_heard;
      const auto span = [&] {
        callback(big, 2 * ceiling_block, big_heard);
        callback(ceiling, ceiling_block, ceiling_heard);
        callback(ceiling, ceiling_block, ceiling_heard);
      };
      const juce::String big_loop = big.recordClip(4096);
      const juce::String ceiling_loop = ceiling.recordClip(4096);
      const auto scratchOf = [](EngineRig& rig, const juce::String& clip) {
        auto* root = dynamic_cast<StackNode*>(
            rig.engine.findNodeByUuidForTest(test_utils::rootId(rig.engine)));
        return test_utils::clipOf(rig.engine, clip)->renderScratchSamplesForTest() +
               root->renderScratchSamplesForTest();
      };
      const int scratch_before = scratchOf(big, big_loop);

      // Playback, then a second take armed, captured and stopped across
      // such blocks.
      span();
      const juce::String big_take = test_utils::addNode(big.engine, "clip");
      const juce::String ceiling_take = test_utils::addNode(ceiling.engine, "clip");
      big.engine.startRecordingInNode(big_take);
      ceiling.engine.startRecordingInNode(ceiling_take);
      span();
      span();
      big.engine.stopRecordingInNode(big_take);
      ceiling.engine.stopRecordingInNode(ceiling_take);
      span();
      span();

      expectEquals(big.engine.transportClock(), ceiling.engine.transportClock(),
                   "the clock moved as far");
      expect(big_heard == ceiling_heard,
             "the same samples as the ceiling-sized blocks");
      const ClipNode* big_clip = test_utils::clipOf(big.engine, big_take);
      const ClipNode* ceiling_clip = test_utils::clipOf(ceiling.engine, ceiling_take);
      const int64_t length = big_clip->getIntrinsicDuration();
      expect(length > 0 && !big_clip->isArmedOrRecording(), "the take committed");
      expectEquals(length, ceiling_clip->getIntrinsicDuration(), "at one length");
      expectEquals(big_clip->origin_samples.load(),
                   ceiling_clip->origin_samples.load(), "from one origin");
      bool same_content = length > 0;
      for (int64_t i = 0; i < length && same_content; ++i) {
        same_content = big_clip->getAudioBuffer().getSample(0, (int)i) ==
                       ceiling_clip->getAudioBuffer().getSample(0, (int)i);
      }
      expect(same_content, "holding the same samples");
      expectEquals(scratchOf(big, big_loop), scratch_before,
                   "and no node's scratch grew for the long blocks");
    }

    beginTest(
        "mono device: null right channel and 1 output channel are safe; "
        "right VU mirrors left");
    {
      Device device;
      expect(device.playConstantTake(0.5f), "take committed");

      // A stereo channel count with a null right pointer, then a true
      // mono device.
      struct Geometry {
        const char* what;
        int channels;
        bool right_out;
      };
      const Geometry geometries[] = {{"null right pointer", 2, false},
                                     {"one output channel", 1, true}};
      for (const Geometry& geometry : geometries) {
        const juce::String what(geometry.what);
        for (int block = 0; block < 40; ++block) {
          device.block(kBlockSize, geometry.channels, geometry.right_out);
        }
        const double vu_left = device.vu("masterVuL");
        expect(vu_left > 0.05, what + ": the clip is audible on the meter");
        expectWithinAbsoluteError(device.vu("masterVuR"), vu_left,
                                  0.02 * vu_left + 1.0e-6,
                                  what + ": right VU mirrors channel 0");
      }
    }

    beginTest("no inputs (num_input_channels == 0) while a clip is armed");
    {
      auto owned = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owned;
      engine.createNode("clip");
      const juce::String clip_id = test_utils::firstNodeId(engine);
      engine.startRecordingInNode(clip_id);

      // An input-less device: input_channel_data == nullptr, 0 channels.
      // The engine's pre-record ring copy is bounded by the real channel
      // count (0), so the context carries no ring and no live block: the
      // take runs by the clock, over silence.
      std::vector<float> output_left((size_t)kBlockSize, 0.0f);
      std::vector<float> output_right((size_t)kBlockSize, 0.0f);
      float* outputs[] = {output_left.data(), output_right.data()};
      const int blocks = 20;
      for (int block = 0; block < blocks; ++block) {
        engine.audioDeviceIOCallbackWithContext(nullptr, 0, outputs, 2,
                                                kBlockSize, {});
      }

      const juce::var state = engine.getGraphState();
      auto* nodes = test_utils::nodesOf(state);
      expect(nodes != nullptr && nodes->size() == 1, "clip still published");
      const juce::var clip_var = nodes->getReference(0);
      expect((bool)clip_var.getProperty("isRecording", false),
             "the arm still transitions to capturing without inputs");
      expectEquals((int64_t)(double)clip_var.getProperty("duration", -1.0),
                   (int64_t)blocks * kBlockSize,
                   "the live take follows the clock without any input");

      // The stop commits what the clock ran: a first take, so Q.
      engine.stopRecordingInNode(clip_id);
      test_utils::driveEngine(engine, 4 * kBlockSize);
      expect(test_utils::isClipCommitted(engine, clip_id),
             "the silent take commits");
      expectEquals(
          (int64_t)(double)engine.getGraphState().getProperty("quantum", 0.0),
          (int64_t)blocks * kBlockSize, "and establishes Q");
    }

    beginTest("master VU: attack converges on sustained tone, release decays");
    {
      Device device;
      AudioEngine& engine = device.engine;
      expect(device.playConstantTake(0.8f), "take committed");

      // ~50 ms of playback: the follower's ~15 ms attack has converged
      // well past half of the sustained level by then. Measure the
      // sustained level from the actual master output rather than
      // assuming the pan law.
      float sustained_level = 0.0f;
      for (int block = 0; block < 5; ++block) {  // 5 × 512 ≈ 58 ms @ 44.1 kHz
        device.block();
        sustained_level =
            std::max(sustained_level, test_utils::peakOf(device.left));
      }
      expect(sustained_level > 0.1f, "the committed clip is audible");

      const double vu_peak = device.vu("masterVuL");
      expect(vu_peak > 0.5 * sustained_level,
             "attack: ~50 ms of sustained tone lifts the meter past half "
             "the sustained level (vu=" +
                 juce::String(vu_peak) +
                 ", level=" + juce::String(sustained_level) + ")");

      // Stop the transport and drive ~1.2 s of silence: the ~400 ms
      // release leaves exp(-3) ≈ 5% of the peak — under the 10% band.
      engine.togglePlayback();
      expect(!engine.isPlaying(), "transport stopped");
      test_utils::driveEngine(engine, (int64_t)(1.2 * 44100.0));

      const double vu_decayed = device.vu("masterVuL");
      expect(vu_decayed < 0.1 * vu_peak,
             "release: ~1.2 s of silence decays the meter below 10% of its "
             "peak (decayed=" +
                 juce::String(vu_decayed) + ", peak=" + juce::String(vu_peak) +
                 ")");
    }

    beginTest("reclaimer: retire() honors the 2-callback grace");
    {
      // Mechanics pinned here (AudioEngine::retire): every retire() call
      // stamps its deleter with the CURRENT callback_count_ zero and
      // then sweeps the graveyard, freeing items whose zero satisfies
      // `zero + 2 <= now`. Reaping happens ONLY inside retire() calls
      // — callbacks advance the counter but never free anything.
      auto owned = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owned;
      bool freed = false;
      engine.retire([&freed] { freed = true; });
      expect(!freed,
             "the retiring call cannot free its own item "
             "(zero + 2 > now at zero elapsed callbacks)");

      test_utils::driveEngine(engine, kBlockSize);  // callback #1
      engine.retire([] {});  // reap attempt at one elapsed callback
      expect(!freed, "one completed callback is still inside the grace");

      test_utils::driveEngine(engine, kBlockSize);  // callback #2
      expect(!freed, "callbacks themselves never reap");

      engine.retire([] {});  // reap attempt at two elapsed callbacks
      expect(freed,
             "a retire() call after two completed callbacks frees "
             "the item");
    }

    beginTest("reclaimer: a publish re-stamps every pending retirement "
              "AFTER the snapshot exchange");
    {
      // Ordering law (AudioEngine::publishGraph): a node detached during
      // an edit stays reachable through the OLD snapshot until the
      // publish exchanges it, so its two-callback clock must start at
      // the publish, not at the detach. publishGraph parks detached
      // nodes (retireNode) and, belt and braces, bumps every pending
      // graveyard stamp to the post-exchange count. Pinned here through
      // the public surface: an item retired at count 0, two callbacks
      // later a structural edit publishes (stamp -> 2), and the very
      // next reap attempt must NOT free it.
      auto owned = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owned;
      bool freed = false;
      engine.retire([&freed] { freed = true; });  // stamped at 0
      test_utils::driveEngine(engine, kBlockSize);   // 1
      test_utils::driveEngine(engine, kBlockSize);   // 2
      engine.createNode("clip");  // structural edit -> publishGraph
      engine.retire([] {});       // reap attempt at count 2
      expect(!freed,
             "re-stamped to the publish's count: still inside the grace");
      test_utils::driveEngine(engine, kBlockSize);  // 3
      engine.retire([] {});
      expect(!freed, "one callback past the publish: still inside");
      test_utils::driveEngine(engine, kBlockSize);  // 4
      engine.retire([] {});
      expect(freed, "two callbacks past the publish: freed");
    }

    beginTest("RtLog: bounded drain under a post storm; ring-full drop");
    {
      // drain() (invoked by every getGraphState poll) sweeps at most
      // kSlots messages per call and RETURNS — an unbounded loop against
      // a producer that keeps the FIFO full would wedge the message
      // thread.
      RtLog& log = RtLog::instance();
      log.drain();  // start from an empty ring

      // All expects run AFTER the real logger is restored — a counting
      // logger that is current while an expect fails would swallow the
      // runner's failure output.
      double drain_elapsed_ms = 0.0;
      int first_drain_count = 0;
      int second_drain_count = 0;
      int final_count = 0;
      {
        CountingLogger counting_logger;
        juce::Logger::setCurrentLogger(&counting_logger);

        // kSlots + 100 posts: the ring accepts kSlots − 1 messages
        // (juce::AbstractFifo keeps one slot in reserve), the overflow
        // is dropped at post() (dropping beats blocking the audio
        // thread).
        for (int i = 0; i < RtLog::kSlots + 100; ++i) {
          log.post("callback_edge_tests storm message %d", i);
        }

        const double drain_start_ms = juce::Time::getMillisecondCounterHiRes();
        log.drain();
        drain_elapsed_ms =
            juce::Time::getMillisecondCounterHiRes() - drain_start_ms;
        first_drain_count = counting_logger.lineCount();

        log.drain();  // a second sweep finds no remainder
        second_drain_count = counting_logger.lineCount();

        // The ring is fully usable after the storm.
        log.post("callback_edge_tests post-storm message");
        log.drain();
        final_count = counting_logger.lineCount();

        juce::Logger::setCurrentLogger(nullptr);
      }

      expect(drain_elapsed_ms < 5000.0, "one drain sweep returns promptly");
      expectEquals(first_drain_count, (int)RtLog::kSlots - 1,
                   "first drain forwards exactly one full ring "
                   "(AbstractFifo capacity is kSlots - 1) - the overflow "
                   "posts were dropped, not queued");
      expectEquals(second_drain_count, first_drain_count,
                   "second drain has nothing left to forward");
      expectEquals(final_count, first_drain_count + 1,
                   "post/drain still round-trips after the storm");
    }

    beginTest("xrun heuristic: a callback that arrives late counts one; the "
              "first callback after a device start counts none");
    {
      auto owned = std::make_unique<AudioEngine>();
      AudioEngine& engine = *owned;
      // A block is ~11.6 ms here; a gap past twice that (and under the
      // half second that reads as a stop) is a starved device.
      const int late_ms = 60;
      test_utils::driveEngine(engine, kBlockSize);  // the gap's reference
      const int before = xrunCount(engine);
      juce::Thread::sleep(late_ms);
      test_utils::driveEngine(engine, kBlockSize);
      expectEquals(xrunCount(engine), before + 1,
                   "the late callback is one xrun");

      // A device start resets the reference: the wait before its first
      // block is not a gap.
      engine.audioDeviceAboutToStart(nullptr);
      const int at_start = xrunCount(engine);
      juce::Thread::sleep(late_ms);
      test_utils::driveEngine(engine, kBlockSize);
      expectEquals(xrunCount(engine), at_start,
                   "the first block after a start is no xrun");
    }
  }
};

static CallbackEdgeTests callbackEdgeTests;

}  // namespace celestrian
