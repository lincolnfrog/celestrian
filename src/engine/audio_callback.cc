// AudioEngine — THE AUDIO CALLBACK: the one audio-thread entry point
// (pre-record ring write, calibration pass, MIDI drain, then the block —
// renderBlock: ProcessContext build, root process, the transport fades,
// the monotonic clock — in slices when the device's block is longer than
// the graph's ceiling; master VU) and its perf meters. Takes no locks,
// never allocates; every shared fact arrives through atomics, the graph
// snapshot and the reclaimer's grace (docs/performance.md §1).

#include "../audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>

#include "../stack_node.h"
#include "../timing.h"
#include "engine_internal.h"

namespace {
/** The calibration click: this many samples, decaying linearly from
 * kClickPeak. */
constexpr int kClickSamples = 128;
constexpr float kClickPeak = 0.9f;
/** The master meter's ballistics, seconds. */
constexpr double kMeterAttackSeconds = 0.015;
constexpr double kMeterReleaseSeconds = 0.4;
}  // namespace

void AudioEngine::audioDeviceIOCallbackWithContext(
    const float* const* input_channel_data, int num_input_channels,
    float* const* output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext& context) {
  juce::ScopedNoDenormals no_denormals;

  // The reclaimer's epoch (retire()), and who runs the blocks
  // (blocksRunElsewhere).
  callback_count_.fetch_add(1);
  callback_thread_.store(juce::Thread::getCurrentThreadId(),
                         std::memory_order_relaxed);

  // --- Entry gap (xrun detection) ---
  const int64_t entry_ticks = juce::Time::getHighResolutionTicks();
  if (last_entry_ticks_ != 0) {
    const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
    const double gap_s = (double)(entry_ticks - last_entry_ticks_) / tps;
    const double period_s = (double)num_samples / cached_sample_rate_.load();
    // A gap well beyond one block period means the device starved; a
    // long idle gap is a stop/start, not an overrun.
    if (gap_s > 2.0 * period_s && gap_s < 0.5) xrun_count_.fetch_add(1);
  }
  last_entry_ticks_ = entry_ticks;

  for (int i = 0; i < num_output_channels; ++i) {
    if (output_channel_data[i] != nullptr)
      juce::FloatVectorOperations::clear(output_channel_data[i], num_samples);
  }

  // --- Latency calibration pass (docs/performance.md §7) ---
  // While Capturing this thread owns the capture buffer and its write
  // position: it mirrors the input into the buffer and emits the click
  // into the outputs at the same block index, so the capture and the
  // emission share one timeline by construction.
  if (calibration_phase_.load() == (int)CalibrationPhase::Capturing) {
    const int cap_len = calibration_capture_.getNumSamples();
    int wp = calibration_write_pos_.load();
    const int n = std::min(num_samples, cap_len - wp);

    if (n > 0) {
      if (num_input_channels > 0 && input_channel_data[0] != nullptr) {
        calibration_capture_.copyFrom(0, wp, input_channel_data[0], n);
      }
      for (int i = 0; i < n; ++i) {
        const int k = wp + i - calibration_click_pos_;
        if (k >= 0 && k < kClickSamples) {
          const float v =
              kClickPeak * (1.0f - (float)k / (float)kClickSamples);
          for (int ch = 0; ch < num_output_channels; ++ch) {
            if (output_channel_data[ch] != nullptr)
              output_channel_data[ch][i] += v;
          }
        }
      }
      wp += n;
      calibration_write_pos_.store(wp);
    }

    if (wp >= cap_len) {
      calibration_phase_.store((int)CalibrationPhase::Done);
    }
  }

  // --- Pre-record ring write (docs/performance.md §3) ---
  // Every input block lands in the ring, keyed by the monotonic input
  // clock, so a recording that starts later can still reach audio that
  // has already arrived. Two bounded copies per channel.
  const int ring_channels =
      std::min(num_input_channels, (int)kPreRecordRingChannels);
  for (int ch = 0; ch < ring_channels; ++ch) {
    if (input_channel_data[ch] == nullptr) continue;
    const int idx = (int)(input_clock_ % kPreRecordRingLen);
    const int first = std::min(num_samples, kPreRecordRingLen - idx);
    prerecord_ring_.copyFrom(ch, idx, input_channel_data[ch], first);
    if (num_samples > first) {
      prerecord_ring_.copyFrom(ch, 0, input_channel_data[ch] + first,
                               num_samples - first);
    }
  }

  // --- Live MIDI drain (docs/vst3.md §8) ---
  // One drain per callback: everything that arrived since the last
  // block, spread across it by arrival timestamp (sub-block onsets for
  // play-through and recording alike). The buffer is reserved for a full
  // queue (engine_internal::kLiveMidiDrainBytes), so addEvent never
  // grows it here. Every event then joins the arrival history that
  // recording clips capture from — the note twin of the ring write.
  live_midi_buffer_.clear();
  midi_input_queue_.drainTo(live_midi_buffer_, num_samples,
                            juce::Time::getMillisecondCounterHiRes() * 0.001);
  midi_history_.pushBlock(live_midi_buffer_, input_clock_);

  // --- The block ---
  // ONE structure load for the whole callback; leaves read the island
  // facts from the context instead of walking parents.
  const celestrian::GraphSnapshot* snap =
      graph_snapshot_.load(std::memory_order_acquire);
  jassert(snap != nullptr);  // published at construction, never cleared
  if (num_samples <= celestrian::kMaxBlockSamples) {
    renderBlock(input_channel_data, num_input_channels, output_channel_data,
                num_output_channels, num_samples, *snap, live_midi_buffer_,
                ring_channels);
  } else {
    // A DEVICE BLOCK PAST THE CEILING reaches the graph as consecutive
    // slices of the ceiling: every node's scratch is sized for
    // kMaxBlockSamples and none grows on this thread. The ring and the
    // MIDI history above already hold the whole block; each slice takes
    // its own stretch of the device's channels and of the live MIDI,
    // timed from its top.
    const float* in[kSliceChannels];
    float* out[kSliceChannels];
    const int ins = std::min(num_input_channels, kSliceChannels);
    const int outs = std::min(num_output_channels, kSliceChannels);
    for (int at = 0; at < num_samples; at += celestrian::kMaxBlockSamples) {
      const int n = std::min(celestrian::kMaxBlockSamples, num_samples - at);
      for (int ch = 0; ch < ins; ++ch) {
        in[ch] = input_channel_data[ch] != nullptr ? input_channel_data[ch] + at
                                                  : nullptr;
      }
      for (int ch = 0; ch < outs; ++ch) {
        out[ch] = output_channel_data[ch] != nullptr
                      ? output_channel_data[ch] + at
                      : nullptr;
      }
      slice_midi_buffer_.clear();
      slice_midi_buffer_.addEvents(live_midi_buffer_, at, n, -at);
      renderBlock(in, ins, out, outs, n, *snap, slice_midi_buffer_,
                  ring_channels);
    }
  }

  // --- Master output monitor (transport VU meters) ---
  // The output buffers now hold exactly what reaches the device. A
  // per-sample rectified ENVELOPE FOLLOWER: smoothed RMS buries
  // transients and a raw block peak slams the dial on every click; the
  // attack integrates just long enough that sparse clicks read mid-dial
  // while sustained material reads its true level. A mono device mirrors
  // channel 0 into the right meter.
  {
    const double sr = cached_sample_rate_.load() > 0
                          ? cached_sample_rate_.load()
                          : kFallbackSampleRate;
    const float ka = (float)(1.0 - std::exp(-1.0 / (sr * kMeterAttackSeconds)));
    const float kr = (float)std::exp(-1.0 / (sr * kMeterReleaseSeconds));
    for (int ch = 0; ch < 2; ++ch) {
      const int src =
          (ch < num_output_channels && output_channel_data[ch] != nullptr) ? ch
                                                                           : 0;
      auto& meter = ch == 0 ? master_vu_l_ : master_vu_r_;
      float env = meter.load(std::memory_order_relaxed);
      if (src < num_output_channels && output_channel_data[src] != nullptr) {
        const float* d = output_channel_data[src];
        for (int i = 0; i < num_samples; ++i) {
          const float a = std::abs(d[i]);
          env = a > env ? env + (a - env) * ka : env * kr;
        }
      } else {
        for (int i = 0; i < num_samples; ++i) env *= kr;
      }
      meter.store(env, std::memory_order_relaxed);
    }
  }

  updatePerfMeters(entry_ticks, num_samples);
}

void AudioEngine::renderBlock(const float* const* input_channel_data,
                              int num_input_channels,
                              float* const* output_channel_data,
                              int num_output_channels, int num_samples,
                              const celestrian::GraphSnapshot& snap,
                              const juce::MidiBuffer& live_midi,
                              int ring_channels) {
  // --- The transport fades' state (the fades follow process below) ---
  // A stop starts a tail — one declick length still rendered and
  // clocked, ramping out — from the gain a start fade had reached; a
  // play during the tail resumes from the gain the tail reached. Either
  // way the master never steps.
  const bool want_playing = is_playing_global.load();
  const bool fades = transport_fades_enabled.load(std::memory_order_relaxed);
  const int64_t fade_len =
      celestrian::ClipNode::seamFadeSamples(cached_sample_rate_.load());
  if (want_playing) {
    if (stop_tail_pos_ >= 0) play_fade_pos_ = fade_len - stop_tail_pos_;
    stop_tail_pos_ = -1;
  } else if (was_playing_ && fades && stop_tail_pos_ < 0 && fade_len > 0) {
    stop_tail_pos_ = std::max<int64_t>(0, fade_len - play_fade_pos_);
  }
  const bool playing = want_playing || stop_tail_pos_ >= 0;

  // The render facts are built by the helper the offline bounce shares;
  // what follows it is the callback's live input.
  celestrian::ProcessContext pc = celestrian::engine_internal::renderContext(
      *root_node, snap, cached_sample_rate_.load(), num_samples,
      global_transport_pos.load(), playing);
  pc.live_midi = &live_midi;
  if (ring_channels > 0) {
    pc.prerecord_ring = prerecord_ring_.getArrayOfReadPointers();
    pc.prerecord_ring_len = kPreRecordRingLen;
    pc.prerecord_ring_channels = ring_channels;
  }
  pc.input_clock = input_clock_;
  const int64_t measured = measured_latency_samples_.load();
  const int out_reported = cached_output_latency_.load();
  pc.input_latency = (int)celestrian::engine_internal::recordingLatency(
      measured, cached_input_latency_.load(), out_reported);
  // MIDI compensation: a key pressed on the HEARD beat arrives one
  // output latency after the callback that rendered it, with no
  // input-side device delay. The driver's output report is the estimate;
  // with none, half a measured round trip is the honest guess.
  pc.midi_latency = out_reported > 0 ? out_reported
                    : measured >= 0  ? (int)(measured / 2)
                                     : 0;
  pc.midi_history = &midi_history_;

  root_node->process(input_channel_data, output_channel_data,
                     num_input_channels, num_output_channels, pc);

  // THE PLAY-START FADE: content resumes wherever the transport stands
  // — usually mid-waveform — so the first blocks after a start ramp in
  // (the seam fade's length and curve). On the master, after every node
  // and plugin: whatever starts sounding, nothing steps.
  if (playing && !was_playing_) play_fade_pos_ = 0;
  was_playing_ = playing;
  if (want_playing && play_fade_pos_ < fade_len && fades) {
    const int n =
        (int)std::min<int64_t>(num_samples, fade_len - play_fade_pos_);
    for (int ch = 0; ch < num_output_channels; ++ch) {
      float* out = output_channel_data[ch];
      if (out == nullptr) continue;
      for (int i = 0; i < n; ++i) {
        out[i] *= celestrian::ClipNode::fadeRamp(play_fade_pos_ + i, fade_len);
      }
    }
    play_fade_pos_ += n;
  }
  // THE STOP FADE: the tail ramps the master out (the start ramp
  // mirrored); once it ends, the rest of the block is silence and the
  // transport halts at the block's end.
  if (stop_tail_pos_ >= 0) {
    const int n =
        (int)std::min<int64_t>(num_samples, fade_len - stop_tail_pos_);
    for (int ch = 0; ch < num_output_channels; ++ch) {
      float* out = output_channel_data[ch];
      if (out == nullptr) continue;
      for (int i = 0; i < n; ++i) {
        out[i] *= celestrian::ClipNode::fadeRamp(
            fade_len - 1 - (stop_tail_pos_ + i), fade_len);
      }
      if (n < num_samples)
        juce::FloatVectorOperations::clear(out + n, num_samples - n);
    }
    stop_tail_pos_ += n;
    if (stop_tail_pos_ >= fade_len) {
      stop_tail_pos_ = -1;
      was_playing_ = false;
    }
  }

  input_clock_ += num_samples;

  if (playing) {
    // THE MONOTONIC CLOCK only moves forward: clips align by their
    // stored origins, so a commit has nothing to wrap, snap or reset.
    const int64_t old_pos = global_transport_pos.load();

    // THE CURSOR VIEW under a take (recording.md cursor table): the take
    // lifecycle lives on the island root; this only keeps the view's
    // base, so the published cursor grows linearly while a take records.
    const bool is_recording = root_node->hasActiveTake();
    if (is_recording && pc.quantum <= 0) {
      // THE FIRST TAKE has no cycle to continue: its arm block stores
      // the island zero at the take's own top (ClipNode::armEvaluate),
      // and the cursor is the clock read from that zero — the take's
      // own position. Stored every block until Q exists: a block may
      // count the take before its clip has run the arm, and the pair is
      // constant from the arm block on.
      view_base_.store(0);
      view_anchor_t_.store(root_node->readIslandFacts().zero);
    } else if (is_recording && !was_any_node_recording_) {
      // With Q the base is frozen as the take begins and continues the
      // view the user was watching: this block's place in the audible
      // cycle, from the root's frame top (the top getGraphState folds
      // masterPos from) — a place in the cycle even when the clock
      // stands before that top (a backward seek).
      const int64_t rel = old_pos - root_node->frameOrigin(pc);
      view_base_.store(pc.context_cycle > 0
                           ? celestrian::timing::posMod(rel, pc.context_cycle)
                           : rel);
      view_anchor_t_.store(old_pos);
    }
    was_any_node_recording_ = is_recording;
    view_recording_.store(is_recording);

    global_transport_pos.store(old_pos + num_samples);
  }
}

void AudioEngine::updatePerfMeters(int64_t entry_ticks, int num_samples) {
  const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
  const double duration_s =
      (double)(juce::Time::getHighResolutionTicks() - entry_ticks) / tps;
  const double period_s = (double)num_samples / cached_sample_rate_.load();

  const int64_t us = (int64_t)(duration_s * 1.0e6);
  if (us > max_block_us_.load()) max_block_us_.store(us);

  if (period_s > 0.0) {
    const double load = duration_s / period_s;
    // Single writer (this thread): a plain read-modify-write is fine.
    avg_dsp_load_.store(0.9 * avg_dsp_load_.load() + 0.1 * load);
  }
}
