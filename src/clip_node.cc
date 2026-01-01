#include "clip_node.h"
#include "box_node.h"
#include <juce_audio_basics/juce_audio_basics.h>

namespace celestrian {

ClipNode::ClipNode(juce::String node_name, double source_sample_rate)
    : AudioNode(std::move(node_name)), sample_rate(source_sample_rate) {
  // Initial size of 60 seconds
  buffer.setSize(1, (int)(sample_rate * 60));
  buffer.clear();
}

juce::var ClipNode::getMetadata() const {
  auto base = AudioNode::getMetadata();
  auto *obj = base.getDynamicObject();
  obj->setProperty("sampleRate", sample_rate);
  obj->setProperty("inputChannel", preferred_input_channel);
  obj->setProperty("isPendingStart", (bool)is_pending_start.load());
  obj->setProperty("isAwaitingStop", (bool)is_awaiting_stop.load());
  obj->setProperty("isPlaying", (bool)is_playing.load());

  int64_t Q = getEffectiveQuantum();
  if (Q > 0 && is_node_recording.load()) {
    obj->setProperty("recordingStartPhase",
                     (double)(trigger_master_pos.load() % Q));
  }

  return base;
}

int64_t ClipNode::getEffectiveQuantum() const {
  if (parent)
    return parent->getEffectiveQuantum();
  return 0;
}

void ClipNode::process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels, const ProcessContext &context) {

  // Handle PLL Start Anchor
  if (is_pending_start.load()) {
    int64_t Q = getEffectiveQuantum();
    bool should_start = true;

    if (Q > 0) {
      int64_t phase = context.master_pos % Q;
      int64_t dist_to_next = Q - phase;
      int64_t tolerance = (int64_t)(Q * 0.25); // 25% Anticipatory Start

      if (dist_to_next < tolerance) {
        should_start = false; // Wait for the next boundary
      }
    }

    if (should_start) {
      // Latency Compensation:
      // The user played in response to what they HEARD (delayed by
      // output_latency). Their performance reached the software delayed by
      // input_latency. Total compensation = input + output latency.
      int64_t compensated_pos =
          context.master_pos - (context.input_latency + context.output_latency);
      if (compensated_pos < 0)
        compensated_pos = 0;

      trigger_master_pos.store(compensated_pos);
      anchor_phase_samples.store(compensated_pos);

      // Calculate visual X position based on context loop
      // context_loop = max(longest_existing_sibling_duration, Q)
      int64_t Q = getEffectiveQuantum();
      int64_t context_loop = Q > 0 ? Q : 1;

      // Find longest sibling clip (the context loop)
      if (parent != nullptr) {
        auto *box = dynamic_cast<BoxNode *>(parent);
        if (box != nullptr) {
          for (int i = 0; i < box->getNumChildren(); ++i) {
            auto *sibling = box->getChild(i);
            if (sibling != this && !sibling->is_node_recording.load()) {
              int64_t sib_dur = sibling->duration_samples.load();
              if (sib_dur > context_loop) {
                context_loop = sib_dur;
              }
            }
          }
        }
      }

      // base_width = 200px (1 quantum), base_x = column position
      double base_width = 200.0;
      double base_x = x_pos.load();
      if (base_x == 0.0)
        base_x = 100.0;

      // Calculate visual X position based on EFFECTIVE position (what user
      // sees) The user is watching the context clip's playhead, so we need to
      // use the same offset calculation as playback to match what they heard.
      int64_t context_launch_point = 0;
      if (parent != nullptr) {
        auto *box = dynamic_cast<BoxNode *>(parent);
        if (box != nullptr) {
          for (int i = 0; i < box->getNumChildren(); ++i) {
            auto *sibling = box->getChild(i);
            if (sibling != this && !sibling->is_node_recording.load()) {
              int64_t sib_dur = sibling->duration_samples.load();
              if (sib_dur == context_loop) {
                // Found the context clip - use its launch point
                context_launch_point = sibling->launch_point_samples.load();
                break;
              }
            }
          }
        }
      }

      // Calculate offset (same formula as playback uses)
      int64_t playback_offset =
          (context_loop - (context_launch_point % context_loop)) % context_loop;

      // Effective position = what the user SAW (playhead position)
      int64_t effective_pos =
          (compensated_pos + playback_offset) % context_loop;
      int64_t quantum_offset = effective_pos / Q;
      x_pos.store(base_x + quantum_offset * base_width);

      juce::Logger::writeToLog(
          "  → effective_pos=" + juce::String(effective_pos) + " (" +
          juce::String((double)effective_pos / Q) + "Q)");

      is_pending_start.store(false);
      is_recording.store(true);
      is_node_recording.store(true);
      write_pos.store(0);
      live_duration_samples.store(0);
      juce::Logger::writeToLog("ClipNode: Recording Started at master_pos=" +
                               juce::String(compensated_pos) + " (anchor=" +
                               juce::String(anchor_phase_samples.load()) +
                               ", context_loop=" + juce::String(context_loop) +
                               ", Q=" + juce::String(Q) +
                               ", x_pos=" + juce::String(x_pos.load()) + ")");
    }
  }

  // Handle Recording
  if (is_recording.load()) {
    if (context.is_recording && input_channels != nullptr &&
        num_input_channels > 0) {
      const float *in = input_channels[std::min(preferred_input_channel,
                                                num_input_channels - 1)];
      int samples_to_write = std::min(
          context.num_samples, buffer.getNumSamples() - write_pos.load());

      if (samples_to_write > 0) {
        buffer.copyFrom(0, write_pos.load(), in, samples_to_write);

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

        int64_t start_p = write_pos.load();
        write_pos.fetch_add(samples_to_write);
        int64_t end_p = write_pos.load();
        live_duration_samples.store(end_p); // Live update for UI visibility

        if (is_awaiting_stop.load()) {
          int64_t target = awaiting_stop_at.load();
          if (start_p < target && end_p >= target) {
            commitRecording(target);
            is_awaiting_stop.store(false);
            return;
          }
        }
      } else {
        commitRecording();
      }
    }
  }

  // Handle Playback
  if (context.is_playing && is_playing) {
    int64_t start = loop_start_samples.load();
    int64_t end = loop_end_samples.load();
    int64_t dur = end - start;

    if (dur > 0) {
      bool isMutedBySolo = (!context.solo_node_uuid.isEmpty());
      if (isMutedBySolo) {
        // Check if we or any ancestor is soloed
        celestrian::AudioNode *curr = this;
        while (curr != nullptr) {
          if (curr->getUuid() == context.solo_node_uuid) {
            isMutedBySolo = false;
            break;
          }
          curr = curr->getParent();
        }
      }

      // Audio Memory Principle: playback starts from launch_point to maintain
      // alignment with the audio context during recording.
      // Offset the master position so that master_pos=0 starts from
      // launch_point.
      int64_t launch = launch_point_samples.load();
      int64_t offset = (dur - (launch % dur)) % dur;

      for (int i = 0; i < context.num_samples; ++i) {
        // Calculate effective position with launch offset
        int64_t current_master_pos = context.master_pos + i;
        int64_t effective_pos = (current_master_pos + offset) % dur;
        int current_read_pos =
            (int)((start + effective_pos) % buffer.getNumSamples());

        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] != nullptr && !isMutedBySolo) {
            output_channels[ch][i] +=
                buffer.getReadPointer(0)[current_read_pos];
          }
        }
      }

      // Update playhead position for UI
      int64_t effective_pos = (context.master_pos + offset) % dur;
      int64_t absolute_read_pos = start + effective_pos;
      int64_t total = duration_samples.load();
      if (total > 0)
        playhead_pos.store((double)absolute_read_pos / (double)total);
      else
        playhead_pos.store(0.0);
    } else {
      playhead_pos.store(0.0);
    }
  }
}

void ClipNode::startRecording() {
  buffer.clear();
  write_pos.store(0);
  read_pos.store(0);
  current_max_peak.store(0.0f);

  is_pending_start.store(true);
  is_recording.store(false);
  is_node_recording.store(true);

  duration_samples.store(0);
  is_playing.store(false);
}

void ClipNode::stopRecording() {
  if (is_node_recording.load()) {
    int64_t L = (int64_t)write_pos.load();
    int64_t Q = getEffectiveQuantum();

    if (Q > 0) {
      const double TOLERANCE = 0.15; // 15% tolerance for anticipatory stop

      // Candidates: multiples and subdivisions of Q
      std::vector<int64_t> candidates;
      candidates.push_back(Q);
      for (int k : {2, 4, 6, 8, 10, 12, 16})
        candidates.push_back(k * Q);
      for (int d : {2, 4, 8})
        candidates.push_back(Q / d);

      int64_t nextB = -1;
      int64_t minB = std::numeric_limits<int64_t>::max();

      for (int64_t B : candidates) {
        if (B > L && B < minB) {
          minB = B;
          nextB = B;
        }
      }

      // Tolerance is based on the target boundary, not just Q
      // This ensures longer recordings have proportionally larger grace periods
      if (nextB != -1) {
        int64_t threshold = (int64_t)(TOLERANCE * (double)nextB);
        if ((nextB - L) < threshold) {
          awaiting_stop_at.store(nextB);
          is_awaiting_stop.store(true);
          juce::Logger::writeToLog(
              "ClipNode: Anticipatory Stop. Waiting for B=" +
              juce::String(nextB) + " (L=" + juce::String(L) +
              ", threshold=" + juce::String(threshold) + ")");
          return;
        }
      }
    }

    commitRecording();
  }
}

void ClipNode::commitRecording(int64_t final_duration) {
  if (is_node_recording.load()) {
    is_recording.store(false);
    is_pending_start.store(false);
    is_awaiting_stop.store(false);
    is_node_recording.store(false);

    int64_t L = (int64_t)write_pos.load();
    int64_t Q = getEffectiveQuantum();
    int64_t dur = L;

    if (Q > 0 && final_duration <= 0) {
      // Hysteresis Snapping Logic
      const double HYSTERESIS_THRESHOLD = 0.15; // 15% tolerance

      // Candidates: Even multiples (2, 4, 6, 8...) and power-of-2 divisions
      std::vector<int64_t> candidates;
      candidates.push_back(Q); // 1x
      for (int k : {2, 4, 6, 8, 10, 12, 16})
        candidates.push_back(k * Q);
      for (int d : {2, 4, 8})
        candidates.push_back(Q / d);

      int64_t bestB = -1;
      int64_t minDiff = std::numeric_limits<int64_t>::max();

      for (int64_t B : candidates) {
        if (B <= 0)
          continue;
        int64_t diff = std::abs(L - B);
        if (diff < minDiff) {
          minDiff = diff;
          bestB = B;
        }
      }

      if (bestB != -1 &&
          minDiff < (int64_t)(HYSTERESIS_THRESHOLD * (double)Q)) {
        dur = bestB;
        juce::Logger::writeToLog(
            "ClipNode: Late Snap to B=" + juce::String(bestB) +
            " (L=" + juce::String(L) + ")");
        loop_start_samples.store(0);
        loop_end_samples.store(dur);
      } else {
        // Outside tolerance: Keep raw duration but snap loop region to previous
        // clean multiple.
        int64_t loop_end = L;
        if (Q > 0) {
          loop_end = (L / Q) * Q;
          if (loop_end == 0)
            loop_end = Q / 2; // Default subdivision if too short
        }

        loop_start_samples.store(0);
        loop_end_samples.store(loop_end);

        juce::Logger::writeToLog(
            "ClipNode: Instant Stop at L=" + juce::String(L) +
            " (Outside tolerance). " + "Loop Region set to " +
            juce::String(loop_end));
      }
    } else if (final_duration > 0) {
      dur = final_duration;
      juce::Logger::writeToLog("ClipNode: Anticipatory Snap to B=" +
                               juce::String(dur));
      loop_start_samples.store(0);
      loop_end_samples.store(dur);
    } else {
      // No quantum or fallback
      loop_start_samples.store(0);
      loop_end_samples.store(dur);
    }

    duration_samples.store(dur);

    // Phase-Locked Cyclic Shift (Rotation)
    if (dur > 0) {
      int64_t anchor = trigger_master_pos.load();
      int64_t phase = anchor % dur;

      if (phase > 0) {
        // Right-rotate buffer by phase to align master_pos=0 with buffer start
        // If master_pos anchor was at phase P, then buffer[0] is master_pos P.
        // We want buffer[P] to be what was originally buffer[0].
        // So we need to shift the buffer right by P.
        int shift = (int)phase;

        juce::AudioBuffer<float> temp(1, (int)dur);
        temp.clear();

        // Copy original to temp with shift
        for (int i = 0; i < dur; ++i) {
          int targetIdx = (i + shift) % (int)dur;
          temp.setSample(0, targetIdx, buffer.getSample(0, i));
        }

        buffer.copyFrom(0, 0, temp, 0, 0, (int)dur);
      }
    }

    // Set launch point to anchor phase so playback maintains alignment
    // This ensures the Audio Memory Principle is preserved
    launch_point_samples.store(anchor_phase_samples.load());

    juce::Logger::writeToLog(
        "ClipNode: Recording committed. Duration=" + juce::String(dur) +
        ", anchor_phase=" + juce::String(anchor_phase_samples.load()) +
        ", launch_point=" + juce::String(launch_point_samples.load()));

    is_playing.store(true); // Auto-playback after recording stops
  }
}

void ClipNode::startPlayback() {
  if (duration_samples.load() > 0) {
    read_pos.store(0);
    is_playing.store(true);
  }
}

void ClipNode::stopPlayback() { is_playing.store(false); }

juce::var ClipNode::getWaveform(int num_peaks) const {
  juce::Array<juce::var> peaks;
  int total_samples = (int)duration_samples;
  if (total_samples <= 0)
    total_samples = write_pos.load();

  if (total_samples <= 0)
    return peaks;

  int window_size = std::max(1, total_samples / num_peaks);
  const float *data = buffer.getReadPointer(0);

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

  static int log_limit = 0;
  if (log_limit++ % 10 == 0) {
    juce::Logger::writeToLog("ClipNode: getWaveform for " + getName() +
                             " returned " + juce::String(peaks.size()) +
                             " peaks. Max: " + juce::String(peaks[0]));
  }

  return peaks;
}

} // namespace celestrian
