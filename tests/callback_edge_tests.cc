/**
 * Callback edge-case tests — the device-callback contract under the
 * geometries JUCE actually delivers in the field: zero-sample blocks,
 * mono devices (one output channel, or a null right pointer), input-less
 * devices, plus the small audio-thread services that ride the callback:
 * the master VU envelope follower, the retire() 2-callback reclamation
 * grace, the bounded RtLog drain (2026-07 field hang fix), and the xrun
 * gap heuristic.
 */

#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
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

/** masterPos from getGraphState (the derived cycle view of the clock). */
double masterViewPosition(const AudioEngine& engine) {
  return (double)engine.getGraphState().getProperty("masterPos", -1.0);
}

/** The perf.xruns counter from getGraphState. */
int xrunCount(const AudioEngine& engine) {
  return (int)(double)engine.getGraphState()
      .getProperty("perf", juce::var())
      .getProperty("xruns", -1.0);
}

/**
 * Records a committed clip whose content is a constant `amplitude`
 * (recordClip drives silence; the VU tests need a known level), using the
 * standard mono-in / stereo-out callback geometry.
 */
juce::String recordConstantClip(AudioEngine& engine, float amplitude,
                                int64_t length_samples) {
  const int block_size = 512;
  std::vector<float> input_block((size_t)block_size, amplitude);
  std::vector<float> output_left((size_t)block_size, 0.0f);
  std::vector<float> output_right((size_t)block_size, 0.0f);
  auto process = [&](int total_samples) {
    float* inputs[] = {input_block.data()};
    float* outputs[] = {output_left.data(), output_right.data()};
    int remaining = total_samples;
    while (remaining > 0) {
      const int count = std::min(remaining, block_size);
      engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2, count, {});
      remaining -= count;
    }
  };
  return test_utils::recordClip(engine, process, length_samples);
}

}  // namespace

class CallbackEdgeTests : public juce::UnitTest {
 public:
  CallbackEdgeTests() : juce::UnitTest("Callback Edges", "Audio Engine") {}

  void runTest() override {
    constexpr int kBlockSize = 512;
    constexpr int64_t kClipLength = 44100;

    beginTest("zero-sample callback: no crash, transport unchanged");
    {
      AudioEngine engine;
      const juce::String clip_id =
          recordConstantClip(engine, 0.5f, kClipLength);
      expect(test_utils::isClipCommitted(engine, clip_id), "take committed");
      if (!engine.isPlaying()) engine.togglePlayback();

      test_utils::driveEngine(engine, 4 * kBlockSize);
      const double position_before = masterViewPosition(engine);

      // A zero-sample block: real drivers deliver these around device
      // stop/start. Every per-sample loop in the callback runs zero
      // times and the transport advances by exactly 0. (Observed quirk,
      // deliberately not asserted: num_samples == 0 makes the xrun
      // heuristic's block period 0, so any positive inter-callback gap
      // under 0.5 s counts as an xrun — a stray counter tick, no crash.)
      std::vector<float> input_block((size_t)kBlockSize, 0.0f);
      std::vector<float> output_left((size_t)kBlockSize, 0.0f);
      std::vector<float> output_right((size_t)kBlockSize, 0.0f);
      float* inputs[] = {input_block.data()};
      float* outputs[] = {output_left.data(), output_right.data()};
      for (int i = 0; i < 3; ++i) {
        engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2,
                                                /*num_samples=*/0, {});
      }

      expectWithinAbsoluteError(masterViewPosition(engine), position_before,
                                1.0e-9,
                                "zero-sample callbacks leave masterPos alone");
      expect(engine.isPlaying(), "transport still running");

      test_utils::driveEngine(engine, kBlockSize);
      expect(masterViewPosition(engine) != position_before,
             "a normal block still advances the transport afterwards");
    }

    beginTest(
        "mono device: null right channel and 1 output channel are safe; "
        "right VU mirrors left");
    {
      AudioEngine engine;
      const juce::String clip_id =
          recordConstantClip(engine, 0.5f, kClipLength);
      expect(test_utils::isClipCommitted(engine, clip_id), "take committed");
      if (!engine.isPlaying()) engine.togglePlayback();

      std::vector<float> input_block((size_t)kBlockSize, 0.0f);
      std::vector<float> output_left((size_t)kBlockSize, 0.0f);
      float* inputs[] = {input_block.data()};

      // Geometry A: stereo channel count but a null right pointer.
      {
        float* outputs[] = {output_left.data(), nullptr};
        for (int block = 0; block < 40; ++block) {
          std::fill(output_left.begin(), output_left.end(), 0.0f);
          engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2,
                                                  kBlockSize, {});
        }
        const juce::var state = engine.getGraphState();
        const double vu_left = (double)state.getProperty("masterVuL", -1.0);
        const double vu_right = (double)state.getProperty("masterVuR", -1.0);
        expect(vu_left > 0.05, "clip is audible on the left meter");
        expectWithinAbsoluteError(
            vu_right, vu_left, 0.02 * vu_left + 1.0e-6,
            "null right pointer: right VU mirrors channel 0");
      }

      // Geometry B: a true mono device — one output channel.
      {
        float* outputs[] = {output_left.data()};
        for (int block = 0; block < 40; ++block) {
          std::fill(output_left.begin(), output_left.end(), 0.0f);
          engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 1,
                                                  kBlockSize, {});
        }
        const juce::var state = engine.getGraphState();
        const double vu_left = (double)state.getProperty("masterVuL", -1.0);
        const double vu_right = (double)state.getProperty("masterVuR", -1.0);
        expect(vu_left > 0.05, "clip is audible on the mono meter");
        expectWithinAbsoluteError(
            vu_right, vu_left, 0.02 * vu_left + 1.0e-6,
            "one output channel: right VU mirrors channel 0");
      }
    }

    beginTest("no inputs (num_input_channels == 0) while a clip is armed");
    {
      AudioEngine engine;
      engine.createNode("clip");
      const juce::String clip_id = test_utils::firstNodeId(engine);
      engine.startRecordingInNode(clip_id);

      // An input-less device: input_channel_data == nullptr, 0 channels.
      // The engine's pre-record ring copy is bounded by the real channel
      // count (0), so the ring stays untouched and the clip's live-block
      // capture path is skipped too.
      std::vector<float> output_left((size_t)kBlockSize, 0.0f);
      std::vector<float> output_right((size_t)kBlockSize, 0.0f);
      float* outputs[] = {output_left.data(), output_right.data()};
      for (int block = 0; block < 20; ++block) {
        engine.audioDeviceIOCallbackWithContext(nullptr, 0, outputs, 2,
                                                kBlockSize, {});
      }

      const juce::var state = engine.getGraphState();
      auto* nodes = test_utils::nodesOf(state);
      expect(nodes != nullptr && nodes->size() == 1, "clip still published");
      const juce::var clip_var = nodes->getReference(0);
      expect((bool)clip_var.getProperty("isRecording", false),
             "the arm still transitions to capturing without inputs");
      // live_duration_samples is only advanced by finishCaptureBlock,
      // which both capture paths (ring and live-block) guard behind
      // having actual input — with none, the take's live duration is
      // pinned at 0 (the UI shows an empty, waiting take).
      expectWithinAbsoluteError(
          (double)clip_var.getProperty("duration", -1.0), 0.0, 1.0e-9,
          "live duration does not advance without any input");

      // Stopping the empty capture and driving on must stay safe.
      engine.stopRecordingInNode(clip_id);
      test_utils::driveEngine(engine, 4 * kBlockSize);
      expect(engine.getGraphState().getDynamicObject() != nullptr,
             "engine still serves graph state after the empty take");
    }

    beginTest("master VU: attack converges on sustained tone, release decays");
    {
      AudioEngine engine;
      const juce::String clip_id =
          recordConstantClip(engine, 0.8f, kClipLength);
      expect(test_utils::isClipCommitted(engine, clip_id), "take committed");
      if (!engine.isPlaying()) engine.togglePlayback();

      // ~50 ms of playback: the follower's ~15 ms attack has converged
      // well past half of the sustained level by then. Measure the
      // sustained level from the actual master output rather than
      // assuming the pan law.
      std::vector<float> input_block((size_t)kBlockSize, 0.0f);
      std::vector<float> output_left((size_t)kBlockSize, 0.0f);
      std::vector<float> output_right((size_t)kBlockSize, 0.0f);
      float* inputs[] = {input_block.data()};
      float* outputs[] = {output_left.data(), output_right.data()};
      float sustained_level = 0.0f;
      for (int block = 0; block < 5; ++block) {  // 5 × 512 ≈ 58 ms @ 44.1 kHz
        std::fill(output_left.begin(), output_left.end(), 0.0f);
        engine.audioDeviceIOCallbackWithContext(inputs, 1, outputs, 2,
                                                kBlockSize, {});
        for (float sample : output_left) {
          sustained_level = std::max(sustained_level, std::abs(sample));
        }
      }
      expect(sustained_level > 0.1f, "the committed clip is audible");

      const double vu_peak =
          (double)engine.getGraphState().getProperty("masterVuL", -1.0);
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

      const double vu_decayed =
          (double)engine.getGraphState().getProperty("masterVuL", -1.0);
      expect(vu_decayed < 0.1 * vu_peak,
             "release: ~1.2 s of silence decays the meter below 10% of its "
             "peak (decayed=" +
                 juce::String(vu_decayed) + ", peak=" + juce::String(vu_peak) +
                 ")");
    }

    beginTest("reclaimer: retire() honors the 2-callback grace");
    {
      // Mechanics pinned here (AudioEngine::retire): every retire() call
      // stamps its deleter with the CURRENT callback_count_ epoch and
      // then sweeps the graveyard, freeing items whose epoch satisfies
      // `epoch + 2 <= now`. Reaping happens ONLY inside retire() calls
      // — callbacks advance the counter but never free anything.
      AudioEngine engine;
      bool freed = false;
      engine.retire([&freed] { freed = true; });
      expect(!freed,
             "the retiring call cannot free its own item "
             "(epoch + 2 > now at zero elapsed callbacks)");

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

    beginTest("RtLog: bounded drain under a post storm; ring-full drop");
    {
      // Regression pin for the 2026-07 field hang: drain() (invoked by
      // every getGraphState poll) must sweep at most kSlots messages per
      // call and RETURN — an unbounded loop against a producer that
      // keeps the FIFO full wedged the message thread.
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
                   "(AbstractFifo capacity is kSlots - 1) — the overflow "
                   "posts were dropped, not queued");
      expectEquals(second_drain_count, first_drain_count,
                   "second drain has nothing left to forward");
      expectEquals(final_count, first_drain_count + 1,
                   "post/drain still round-trips after the storm");
    }

    beginTest("xrun heuristic does not count idle gaps");
    {
      AudioEngine engine;
      // First callback: no previous entry timestamp, so no gap check.
      test_utils::driveEngine(engine, kBlockSize);
      // Consecutive tight-loop callbacks: inter-callback gaps are
      // microseconds against a ~11.6 ms block period, far under the
      // 2× period threshold.
      test_utils::driveEngine(engine, 8 * kBlockSize);
      expectEquals(xrunCount(engine), 0,
                   "normal consecutive driving reports zero xruns");
    }
  }
};

static CallbackEdgeTests callbackEdgeTests;

}  // namespace celestrian
