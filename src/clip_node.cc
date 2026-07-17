#include "clip_node.h"

#include <juce_audio_basics/juce_audio_basics.h>

#include "rt_log.h"
#include "timing.h"

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // Initial size of 60 seconds
  buffer.setSize(1, (int)(sample_rate * 60));
  buffer.clear();
  fx_scratch_.resize(4096, 0.0f);  // typical max device block
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel);
  obj->setProperty("isPendingStart", isPendingStart());
  obj->setProperty("isAwaitingStop", isAwaitingStop());
  // The take's heard frame (Q14 take-marking modulus); 0 = first take.
  obj->setProperty("contextCycle", (double)take_context_cycle_.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());

  // (recordingStartPhase was deleted 2026-07-16: no consumer existed —
  // the take's landing phase is a projection of `origin`.)
  return base;
}

int64_t ClipNode::getEffectiveQuantum() const {
  if (auto *p = parent.load()) return p->getEffectiveQuantum();
  return 0;
}

void ClipNode::process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels, const ProcessContext &context) {
  // === Armed: choose/reach the arm target (state machine, kernel.md §3;
  // re-evaluated every block — deliberate: the latency-compensated clock
  // must be able to land back on a boundary the raw clock already
  // passed). May transition to Capturing within this block.
  if (recState() == RecState::Armed) {
    armEvaluate(context);
  }

  // === Stop request → PendingStop. The boundary is computed HERE, on
  // the audio thread, from the audio thread's own write position — the
  // old message-thread computation raced the recorder and could pick a
  // boundary already behind the write head (unification_audit.md D2).
  if (recState() == RecState::Capturing && stop_requested_.load()) {
    const int64_t Q = getEffectiveQuantum();
    if (Q > 0) {
      const int64_t boundary =
          timing::nextStopBoundary(write_position.load(), Q);
      awaiting_stop_at.store(boundary);
      rec_state_.store((int)RecState::PendingStop);
      RtLog::instance().post("ClipNode: PendingStop at B=%lld (L=%lld)",
                             (long long)boundary,
                             (long long)write_position.load());
    }
    stop_requested_.store(false);
  }

  // Handle Recording (Capturing or PendingStop)
  if (isRecording()) {
    if (context.is_recording && capture_uses_ring_ &&
        context.prerecord_ring != nullptr &&
        context.prerecord_ring_channels > 0) {
      // Arrival-time capture (docs/performance.md §3): copy from the
      // engine's pre-record ring the samples whose arrival times the clip
      // covers. The window start (capture_next_clock_) already encodes the
      // latency compensation, so a note played on the HEARD beat lands on
      // the beat in the clip — the live-block path below cannot do that,
      // because the note's audio arrives ~latency after the boundary.
      const int64_t available_end =
          context.input_clock + context.num_samples;
      int64_t src = capture_next_clock_;
      const int ring_len = context.prerecord_ring_len;
      const int64_t oldest = std::max<int64_t>(0, available_end - ring_len);
      if (src < oldest) {
        RtLog::instance().post(
            "ClipNode: pre-record ring underrun, %lld samples lost",
            (long long)(oldest - src));
        src = oldest;
      }

      if (src < available_end) {
        const int wp = write_position.load();
        const int space = buffer.getNumSamples() - wp;
        const int n =
            (int)std::min<int64_t>(available_end - src, (int64_t)space);
        if (n > 0) {
          const int ch = std::min(preferred_input_channel,
                                  context.prerecord_ring_channels - 1);
          const float *ring = context.prerecord_ring[ch];
          const int idx = (int)(src % ring_len);
          const int first = std::min(n, ring_len - idx);
          buffer.copyFrom(0, wp, ring + idx, first);
          if (n > first) buffer.copyFrom(0, wp + first, ring, n - first);
          capture_next_clock_ = src + n;

          // Peak tracking over the captured region
          float blockPeak = 0.0f;
          const float *written = buffer.getReadPointer(0) + wp;
          for (int i = 0; i < n; ++i) {
            blockPeak = std::max(blockPeak, std::abs(written[i]));
          }
          last_block_peak.store(blockPeak);
          if (blockPeak > current_max_peak.load()) {
            current_max_peak.store(blockPeak);
          }

          const int64_t start_p = wp;
          write_position.fetch_add(n);
          const int64_t end_p = write_position.load();
          live_duration_samples.store(end_p);  // Live update for UI

          if (recState() == RecState::PendingStop) {
            int64_t target = awaiting_stop_at.load();
            if (start_p < target && end_p >= target) {
              commit_master_pos.store(context.master_pos);
              commitRecording(target);
              return;
            }
          }
        }
      }
    } else if (context.is_recording && input_channels != nullptr &&
               num_input_channels > 0) {
      const float *in = input_channels[std::min(preferred_input_channel,
                                                num_input_channels - 1)];
      int samples_to_write = std::min(
          context.num_samples, buffer.getNumSamples() - write_position.load());

      if (samples_to_write > 0) {
        buffer.copyFrom(0, write_position.load(), in, samples_to_write);

        // Peak tracking
        float blockPeak = 0.0f;
        for (int ch = 0; ch < num_input_channels; ++ch) {
          if (input_channels[ch] != nullptr) {
            for (int i = 0; i < samples_to_write; ++i) {
              blockPeak = std::max(blockPeak, std::abs(input_channels[ch][i]));
            }
          }
        }
        last_block_peak.store(blockPeak);

        if (blockPeak > current_max_peak.load()) {
          current_max_peak.store(blockPeak);
        }

        int64_t start_p = write_position.load();
        write_position.fetch_add(samples_to_write);
        int64_t end_p = write_position.load();
        live_duration_samples.store(end_p);  // Live update for UI visibility

        if (recState() == RecState::PendingStop) {
          int64_t target = awaiting_stop_at.load();
          if (start_p < target && end_p >= target) {
            commit_master_pos.store(context.master_pos);
            commitRecording(target);
            return;
          }
        }
        // Note: if samples_to_write <= 0, buffer is full - just stop writing
        // Do NOT call commitRecording here; wait for explicit stop
      }
    }
  }

  // Handle Playback
  if (context.is_playing && is_playing) {
    int64_t start = loop_start_samples.load();
    int64_t end = loop_end_samples.load();
    // Loop window, fractal (I5): the clip's loop region is the
    // single-segment case of the stack's time-map. BYPASSED (or
    // invalid) windows fall back to the full take — commit sets
    // [0, duration) on every clip, so the un-windowed path is identical
    // to the historical behavior.
    if (loop_window_bypassed_.load() || end <= start) {
      start = 0;
      end = duration_samples.load();
    }
    int64_t dur = end - start;

    if (dur > 0) {
      bool isSilenced = is_muted.load() || (context.solo_node != nullptr);
      if (isSilenced && !is_muted.load()) {
        // Check if we or any ancestor is soloed
        const celestrian::AudioNode *curr = this;
        while (curr != nullptr) {
          if (curr == context.solo_node) {
            isSilenced = false;
            break;
          }
          curr = curr->getParent();
        }
      }

      // Audio Memory Principle — the kernel playback equation
      // (docs/kernel.md §2): play content[(t − origin) mod dur], i.e.
      // content sounds at the cycle moment it was performed. Expressed
      // through the launch-point form ((t + launch) mod dur with
      // launch = (−origin) mod dur) so the shared timing.h math — pinned
      // by the golden vectors — stays the single implementation.
      const int64_t offset =
          timing::launchPointFor(origin_samples.load(), dur);

      if (!isSilenced) {
        // Render into the mono fx scratch, run the rack, then sum to
        // the parent — effects shape THIS clip's signal in isolation.
        // Resize is a rare growth (same pattern as StackNode's
        // mix_buffer); constructor pre-reserves a typical block.
        if ((int)fx_scratch_.size() < context.num_samples) {
          fx_scratch_.resize((size_t)context.num_samples);
        }
        for (int i = 0; i < context.num_samples; ++i) {
          int64_t current_master_pos = context.master_pos + i;
          int64_t effective_pos = (current_master_pos + offset) % dur;
          int current_read_position =
              (int)((start + effective_pos) % buffer.getNumSamples());
          fx_scratch_[(size_t)i] =
              buffer.getReadPointer(0)[current_read_position];
        }
        // isLive: enabled slots OR an open panel watching the scope
        // (capture-only pass costs one copy; effects all no-op)
        if (fx_.isLive()) {
          fx_.process(fx_scratch_.data(), context.num_samples);
        }
        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] != nullptr) {
            juce::FloatVectorOperations::add(
                output_channels[ch], fx_scratch_.data(), context.num_samples);
          }
        }
      }

      // Update playhead position for UI (0..1 within this clip)
      playhead_pos.store(
          timing::playheadPercent(context.master_pos, offset, dur));
    } else {
      playhead_pos.store(0.0);
    }
  }
}

void ClipNode::armEvaluate(const ProcessContext &context) {
  const int64_t Q = getEffectiveQuantum();

  // Latency compensation: the performer plays against what they HEARD
  // (delayed by output latency); it reaches the software input latency
  // later. Total compensation = input + output (or the calibrated
  // round trip, which the engine substitutes for both).
  int64_t compensated_pos =
      context.master_pos - (context.input_latency + context.output_latency);
  if (compensated_pos < 0) compensated_pos = 0;

  if (Q <= 0) {
    // First clip: starts NOW. This arm moment IS the island epoch —
    // captured as data at the root (the clock is never reset,
    // kernel.md); commit stores Q + epoch together with the same value.
    origin_samples.store(compensated_pos);
    rootNode()->establishIsland(0, compensated_pos);
    beginCapture(context, compensated_pos, compensated_pos);
    RtLog::instance().post(
        "ClipNode: Recording Started at master_pos=%lld (first clip)",
        (long long)compensated_pos);
    return;
  }

  // ALL cycle-relative math happens in the ISLAND EPOCH frame — mixing
  // absolute-frame math with the epoch-rebased view was the field bug
  // "clip 3 anchored at 3Q instead of 0Q".
  const int64_t epoch = getIslandEpoch();

  // Context loop = the loop the performer was listening to: longest
  // committed sibling, min Q — computed by the PARENT and passed down
  // (P1-6: leaves never inspect siblings).
  const int64_t context_loop = std::max(Q, context.context_loop);

  int64_t rel = compensated_pos - epoch;
  if (rel < 0) rel = 0;

  // THE canonical timing fact: this clip's content belongs at the arm
  // target — stored ABSOLUTE (docs/kernel.md). Anchor, launch point,
  // and lane x are all projections of this one value. Re-stored per
  // block while Armed; it converges to the chosen boundary.
  //
  // The target is the next Q boundary in the HEARD frame
  // (latency-compensated, epoch-relative): a click shortly before a
  // boundary compensates back ONTO it — "the pickup" (E-A) needs no
  // extra machinery. The old anticipatory-window DEFERRAL is deleted
  // (field bug 2026-07-16): it added nothing — any click before a
  // boundary already targets that boundary — and when the compensation
  // was small it skipped past the boundary and overshot the take to
  // the NEXT one (clip armed before 2Q anchored at 3Q).
  const int64_t target = epoch + timing::armTarget(rel, Q, context_loop);

  // HEARD-FRAME ORIGIN FOLD (Q15, field 2026-07-16e): when active
  // windows make the audible cycle SHORTER than the intrinsic one, the
  // heard world is exactly heard-cycle-periodic — so every boundary in
  // {target − k·heard} is AUDIBLY IDENTICAL as an anchor, differing
  // only by intrinsic phase the performer can neither hear nor see
  // (the cursor wraps on the heard cycle). Store the representative
  // that lands in the FIRST heard window of the intrinsic frame: the
  // take anchors where the cursor actually sweeps, instead of a
  // die-roll among equivalent slots (field: take "started at 1Q
  // instead of 0Q"). Capture still starts at the REAL boundary
  // (`target`); I1 holds exactly (playback shifts by whole heard
  // cycles); nothing else moves (no epoch change — I4). No-op in the
  // mainline (heard == intrinsic when no window is active).
  int64_t origin = target;
  {
    const int64_t heard = rootNode()->activeTakeHeardCycle();
    const int64_t intrinsic = rootNode()->activeTakeIntrinsicCycle();
    if (heard > 0 && intrinsic > heard) {
      const int64_t rel_t =
          ((target - epoch) % intrinsic + intrinsic) % intrinsic;
      origin = target - (rel_t / heard) * heard;
    }
  }
  origin_samples.store(origin);
  awaiting_start_at.store(target);

  // Start when the compensated clock is at/near the target, or when the
  // target falls inside this block.
  if (compensated_pos >= target || target - compensated_pos < 512) {
    beginCapture(context, target, compensated_pos);
    RtLog::instance().post("ClipNode: Recording Started (at Q boundary)");
  } else if (context.master_pos < target &&
             context.master_pos + context.num_samples >= target) {
    beginCapture(context, target, compensated_pos);
    RtLog::instance().post(
        "ClipNode: Recording Started (crossed Q boundary at %lld)",
        (long long)target);
  }
}

void ClipNode::beginCapture(const ProcessContext &context, int64_t target,
                            int64_t compensated_pos) {
  // The take's HEARD FRAME: the EFFECTIVE island cycle it is being
  // performed against (snapshotted at arm on the island root; falls
  // back to the intrinsic cycle for pre-window engine states). Display
  // take-marking folds by this — "which heard cycle" never matters, the
  // phase within it always does (Q14) — making the mark stable across
  // later frame growth and epoch re-bases.
  const int64_t heard = rootNode()->activeTakeHeardCycle();
  take_context_cycle_.store(
      heard > 0 ? heard : rootNode()->activeTakeIntrinsicCycle());

  rec_state_.store((int)RecState::Capturing);
  awaiting_start_at.store(0);
  write_position.store(0);
  live_duration_samples.store(0);
  // Capture window (performance.md §3): clip position 0 holds the input
  // that ARRIVED at performance-time `target`, i.e. (target −
  // compensated) samples after this block's first arrival. A negative
  // delta (boundary just passed) reaches back into the pre-record ring.
  capture_uses_ring_ = (context.prerecord_ring != nullptr);
  capture_next_clock_ = context.input_clock + (target - compensated_pos);
}

void ClipNode::startRecording() {
  if (recState() != RecState::Idle) return;  // idempotent; keeps the
                                             // island take counter exact

  buffer.clear();
  write_position.store(0);
  read_position.store(0);
  current_max_peak.store(0.0f);
  awaiting_start_at.store(0);
  stop_requested_.store(false);

  duration_samples.store(0);
  live_duration_samples.store(0);
  is_playing.store(false);

  rec_state_.store((int)RecState::Armed);
  rootNode()->takeArmed();
}

void ClipNode::stopRecording() {
  switch (recState()) {
    case RecState::Armed:
      // Never started capturing: stopping an armed clip is a CANCEL —
      // back to Idle with no content. (Previously this wedged the clip
      // into a phantom awaiting-stop before capture had even begun.)
      rec_state_.store((int)RecState::Idle);
      awaiting_start_at.store(0);
      rootNode()->takeCancelled();
      juce::Logger::writeToLog("ClipNode: Arm cancelled before capture");
      break;

    case RecState::Capturing:
      if (getEffectiveQuantum() > 0) {
        // ALWAYS record forward to the next clean boundary (owner
        // ruling). The boundary itself is computed by the AUDIO thread
        // at the top of its next block (see process()) — computing it
        // here from a racing write position was unification_audit.md D2.
        stop_requested_.store(true);
        juce::Logger::writeToLog(
            "ClipNode: Stop requested — finishing to the next boundary");
      } else {
        // First clip: immediate commit. The recorded length stands in
        // for the commit position — a node-level diagnostic only.
        commit_master_pos.store(write_position.load());
        commitRecording();
      }
      break;

    case RecState::PendingStop:
    case RecState::Idle:
      break;  // already stopping / nothing to stop
  }
}

void ClipNode::commitRecording(int64_t final_duration) {
  if (recState() != RecState::Idle) {
    rec_state_.store((int)RecState::Idle);
    stop_requested_.store(false);
    awaiting_stop_at.store(0);

    int64_t L = (int64_t)write_position.load();
    int64_t Q = getEffectiveQuantum();
    int64_t duration = L;

    if (Q > 0 && final_duration <= 0) {
      // Hysteresis snapping — shared math in timing.h.
      auto snap = timing::snapCommittedDuration(L, Q);
      duration = snap.duration;
      loop_start_samples.store(0);
      loop_end_samples.store(snap.loop_end);

      if (snap.snapped) {
        RtLog::instance().post("ClipNode: Late Snap to B=%lld (L=%lld)",
                               (long long)snap.duration, (long long)L);
      } else {
        RtLog::instance().post(
            "ClipNode: Instant Stop at L=%lld (Outside tolerance). Loop "
            "Region set to %lld",
            (long long)L, (long long)snap.loop_end);
      }
    } else if (final_duration > 0) {
      duration = final_duration;
      RtLog::instance().post("ClipNode: Anticipatory Snap to B=%lld",
                             (long long)duration);
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
    } else {
      // No quantum or fallback (first clip case)
      loop_start_samples.store(0);
      loop_end_samples.store(duration);
    }

    duration_samples.store(duration);  // CRITICAL: Store final duration so UI
                                       // knows clip is valid!

    // First committed clip in the island establishes Q — stored once at
    // the island root, never derived again (P0-3; Q survives its
    // creator per owner ruling). Epoch = this clip's origin.
    const int64_t origin = origin_samples.load();
    if (Q == 0) {
      rootNode()->establishIsland(duration, origin);
      RtLog::instance().post(
          "ClipNode: Island quantum established: Q=%lld epoch=%lld",
          (long long)duration, (long long)origin);
    }

    // Nothing else to compute: origin was stored at arm and duration
    // above — anchor, launch point, and lane x are all projections of
    // (origin, duration) derived at read time (kernel.md §2 table).
    RtLog::instance().post(
        "ClipNode: Commit. Duration=%lld, Origin=%lld, Launch(derived)=%lld",
        (long long)duration, (long long)origin,
        (long long)timing::launchPointFor(origin, duration));

    is_playing.store(true);

    // The commit EVENT (unification_audit.md §1.5): carries the take's
    // origin to the island root, which owns the epoch re-base decision.
    // Runs AFTER duration_samples is stored so the island's composite
    // duration includes this take.
    rootNode()->takeCommitted(origin);
  }
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) {
    read_position.store(0);
    is_playing.store(true);
  }
}

void ClipNode::stopPlayback() { is_playing.store(false); }

juce::var ClipNode::getWaveform(int num_peaks) const {
  juce::Array<juce::var> peaks;
  int total_samples = (int)duration_samples;
  if (total_samples <= 0) total_samples = write_position.load();

  if (total_samples <= 0) return peaks;

  int window_size = std::max(1, total_samples / num_peaks);
  const float *data = buffer.getReadPointer(0);

  // Raw reads: the buffer IS the origin frame; the UI positions it via
  // the clip's origin (x), so no index remapping is needed anywhere.
  for (int i = 0; i < num_peaks; ++i) {
    int start = i * window_size;
    int end = std::max(start + 1, std::min(start + window_size, total_samples));
    float peak = 0.0f;
    if (start < total_samples) {
      for (int s = start; s < end; ++s) {
        peak = std::max(peak, std::abs(data[s]));
      }
    }
    peaks.add(peak);
  }

  return peaks;
}

}  // namespace celestrian
