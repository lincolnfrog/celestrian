// AudioEngine — THE AUDIO CALLBACK: the one audio-thread entry point
// (pre-record ring write, calibration pass, MIDI drain, ProcessContext
// build, root process, the monotonic clock, master VU) and its perf
// meters. Takes no locks, never allocates; every shared fact arrives
// through atomics, the graph snapshot and the reclaimer's grace
// (docs/performance.md §1).

#include "../audio_engine.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include <algorithm>
#include <cmath>

#include "../stack_node.h"

void AudioEngine::audioDeviceIOCallbackWithContext(
    const float* const* input_channel_data, int num_input_channels,
    float* const* output_channel_data, int num_output_channels, int num_samples,
    const juce::AudioIODeviceCallbackContext& context) {
  juce::ScopedNoDenormals no_denormals;

  // Epoch for deferred reclamation (see retire()).
  callback_count_.fetch_add(1);

  // --- Instrumentation: entry gap (xrun detection) ---
  const int64_t entry_ticks = juce::Time::getHighResolutionTicks();
  if (last_entry_ticks_ != 0) {
    const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
    const double gap_s = (double)(entry_ticks - last_entry_ticks_) / tps;
    const double period_s = (double)num_samples / cached_sample_rate_.load();
    // Gaps well beyond one block period mean the device starved (ignore
    // long idle gaps — those are stop/start, not overruns).
    if (gap_s > 2.0 * period_s && gap_s < 0.5) xrun_count_.fetch_add(1);
  }
  last_entry_ticks_ = entry_ticks;

  for (int i = 0; i < num_output_channels; ++i) {
    if (output_channel_data[i] != nullptr)
      juce::FloatVectorOperations::clear(output_channel_data[i], num_samples);
  }

  // --- Latency calibration pass (docs/performance.md §7) ---
  // While capturing: mirror the input into the calibration buffer and emit
  // the click into the outputs. Same block index for both sides, so the
  // capture timeline and the emission timeline are identical by
  // construction. Everything here is preallocated and bounded.
  if (calibration_phase_.load() == (int)CalibrationPhase::Capturing) {
    const int cap_len = calibration_capture_.getNumSamples();
    int wp = calibration_write_pos_.load();
    const int n = std::min(num_samples, cap_len - wp);

    if (n > 0) {
      if (num_input_channels > 0 && input_channel_data[0] != nullptr) {
        calibration_capture_.copyFrom(0, wp, input_channel_data[0], n);
      }

      // Click: 128 samples, decaying from full scale, starting at
      // calibration_click_pos_ on the shared timeline.
      constexpr int kClickLen = 128;
      for (int i = 0; i < n; ++i) {
        const int t = wp + i;
        const int k = t - calibration_click_pos_;
        if (k >= 0 && k < kClickLen) {
          const float v = 0.9f * (1.0f - (float)k / (float)kClickLen);
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
  // Every input block lands in the ring unconditionally, keyed by the
  // monotonic input clock, so a recording that starts later can still
  // reach audio that has already arrived. Two bounded memcpys per channel.
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

  // --- Live MIDI drain (docs/vst3.md §8, phases 4–5) ---
  // One drain per callback: everything that arrived since the last
  // block, spread across it by arrival timestamp (sub-block onsets for
  // play-through AND recording). The buffer is preallocated; addEvent
  // never grows it here. Every event then joins the arrival history
  // (input-clock indexed) that recording clips capture from — the
  // note twin of the pre-record ring write above.
  live_midi_buffer_.clear();
  midi_input_queue_.drainTo(live_midi_buffer_, num_samples,
                            juce::Time::getMillisecondCounterHiRes() * 0.001);
  midi_history_.pushBlock(live_midi_buffer_, input_clock_);

  if (root_node) {
    celestrian::ProcessContext pc;
    pc.sample_rate = cached_sample_rate_.load();
    pc.num_samples = num_samples;
    pc.is_playing = is_playing_global;
    pc.is_recording = true;  // Enable recording capture from inputs
    pc.master_pos = global_transport_pos;
    pc.live_midi = &live_midi_buffer_;
    if (ring_channels > 0) {
      pc.prerecord_ring = prerecord_ring_.getArrayOfReadPointers();
      pc.prerecord_ring_len = kPreRecordRingLen;
      pc.prerecord_ring_channels = ring_channels;
    }
    pc.input_clock = input_clock_;
    // Recording alignment: a measured round-trip (empirical calibration)
    // takes precedence over the driver-reported latencies, which are
    // often wrong or zero on consumer hardware.
    const int64_t measured = measured_latency_samples_.load();
    pc.input_latency = measured >= 0 ? (int)measured
                                     : cached_input_latency_.load() +
                                           cached_output_latency_.load();
    // MIDI compensation (phase 5): a key pressed on the HEARD beat
    // arrives output-latency after the callback that rendered it — no
    // input-side device delay. The driver's output report is the
    // estimate; when the round trip was measured and the driver reports
    // no output figure, half the round trip is the honest guess.
    {
      const int out_reported = cached_output_latency_.load();
      pc.midi_latency = out_reported > 0 ? out_reported
                        : measured >= 0  ? (int)(measured / 2)
                                         : 0;
    }
    pc.midi_history = &midi_history_;
    // Solo canon (Q16): one snapshot scan per callback answers "is any
    // solo lit anywhere?" — leaves then resolve their own ancestry.
    // (The scan happens below once `snap` is loaded.)
    // Cycle-top of the island frame — loop-window time-maps phase off
    // this (time_maps.md); windowed stacks re-base it for their children.
    // (Q, epoch) as ONE consistent fact (StackNode::readIslandFacts —
    // a re-trim between two separate reads would hand a block a mixed
    // pair).
    const celestrian::StackNode::IslandFacts island_facts =
        root_node->readIslandFacts();
    pc.cycle_epoch = island_facts.epoch;
    // Whole-graph snapshot + island facts: ONE structure load for the
    // entire callback; leaves read island state from the context
    // instead of walking parents.
    pc.snap = graph_snapshot_.load(std::memory_order_acquire);
    jassert(pc.snap != nullptr);  // published at construction, never cleared
    pc.self = 0;
    pc.any_solo = celestrian::snapAnySolo(*pc.snap);
    pc.quantum = island_facts.quantum;
    pc.island_generation = island_facts.generation;
    pc.stop_generation = root_node->stopGeneration();
    pc.island_epoch = pc.cycle_epoch;
    pc.island = root_node.get();
    // The invariant monotonic clock (master_pos twin of island_epoch):
    // mapping stacks fold master_pos on the way down but never this.
    pc.island_pos = global_transport_pos;
    // Context-cycle seed (Q5 one-shots): the island's audible cycle.
    // Each stack recomputes it for its own scope in childContext; this
    // seed is the fallback an all-one-shot ROOT scope inherits.
    pc.context_cycle = celestrian::snapEffectiveCycle(*pc.snap, pc.quantum,
                                                      (int64_t)pc.sample_rate);

    root_node->process(input_channel_data, output_channel_data,
                       num_input_channels, num_output_channels, pc);

    input_clock_ += num_samples;

    if (is_playing_global.load()) {
      // Monotonic transport (kernel.md step 3): the clock only moves
      // forward. Clips align by their stored origins, so commits have
      // nothing to wrap, snap, or reset. The cycle position shown to
      // the UI is a DERIVED view (see getGraphState), which during
      // recording grows linearly from a base frozen at record start so
      // the cursor can extend past the committed LCM (recording.md
      // cursor table).
      const int64_t old_pos = global_transport_pos.load();

      // The take LIFECYCLE lives on the island root (a counter fed by
      // arm/cancel/commit events) and the epoch re-base runs inside the
      // commit event itself (StackNode::takeCommitted); this block is
      // purely VIEW upkeep: freeze the cycle view's base when a take
      // begins so the cursor extends past the committed LCM while
      // recording (recording.md cursor table).
      const bool is_recording = root_node->hasActiveTake();
      if (is_recording && !was_any_node_recording_) {
        // The frozen base continues the view the user was WATCHING —
        // the effective (window-aware) wrap. Snapshot-space math: this
        // runs on the AUDIO thread (graph_snapshot.h).
        const int64_t view_cycle = celestrian::snapEffectiveCycle(
            *pc.snap, root_node->getQuantum(),
            (int64_t)cached_sample_rate_.load());
        const int64_t rel = old_pos - islandEpoch();
        view_base_.store(view_cycle > 0 ? rel % view_cycle : rel);
        view_anchor_t_.store(old_pos);
      }
      was_any_node_recording_ = is_recording;
      view_recording_.store(is_recording);

      global_transport_pos.store(old_pos + num_samples);
    }
  }

  // --- Master output monitor (transport VU meters) ---
  // The output buffers now hold exactly what reaches the device — the
  // master bus. ENVELOPE FOLLOWER metering: per-sample rectified
  // follower with ~15 ms attack and ~400 ms release. Smoothed RMS
  // buries transients and raw block peak slams the dial on every click;
  // a 15 ms attack integrates just long enough that sparse clicks read
  // mid-dial while sustained material reads its true level. A mono
  // device mirrors channel 0 into the right meter.
  {
    const double sr = cached_sample_rate_.load() > 0
                          ? cached_sample_rate_.load()
                          : kFallbackSampleRate;
    const float ka = (float)(1.0 - std::exp(-1.0 / (sr * 0.015)));  // attack
    const float kr = (float)std::exp(-1.0 / (sr * 0.4));            // release
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

void AudioEngine::updatePerfMeters(int64_t entry_ticks, int num_samples) {
  const double tps = (double)juce::Time::getHighResolutionTicksPerSecond();
  const double duration_s =
      (double)(juce::Time::getHighResolutionTicks() - entry_ticks) / tps;
  const double period_s = (double)num_samples / cached_sample_rate_.load();

  const int64_t us = (int64_t)(duration_s * 1.0e6);
  if (us > max_block_us_.load()) max_block_us_.store(us);

  if (period_s > 0.0) {
    const double load = duration_s / period_s;
    // Single writer (audio thread): plain read-modify-write is fine.
    avg_dsp_load_.store(0.9 * avg_dsp_load_.load() + 0.1 * load);
  }
}

juce::var AudioEngine::makePerfState() const {
  juce::DynamicObject::Ptr perf = new juce::DynamicObject();
  perf->setProperty("maxBlockUs", (double)max_block_us_.load());
  perf->setProperty("avgLoadPct", avg_dsp_load_.load() * 100.0);
  perf->setProperty("xruns", (double)xrun_count_.load());

  const int64_t measured = measured_latency_samples_.load();
  const int64_t effective = measured >= 0 ? measured
                                          : cached_input_latency_.load() +
                                                cached_output_latency_.load();
  perf->setProperty("latencyCompensationSamples", (double)effective);
  perf->setProperty("calibrated", measured >= 0);
  // The device's actual rate — the UI must use this (not 44100) for any
  // samples→ms display.
  perf->setProperty("sampleRate", cached_sample_rate_.load());
  return juce::var(perf.get());
}
