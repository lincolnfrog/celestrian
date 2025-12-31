#include "clip_node.h"
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
      is_pending_start.store(false);
      is_recording.store(true);
      is_node_recording.store(true);
      write_pos.store(0);
      juce::Logger::writeToLog(
          "ClipNode: Recording Started (Latency Compensated) at master_pos=" +
          juce::String(compensated_pos) +
          " (Raw=" + juce::String(context.master_pos) + ", RoundTrip=" +
          juce::String(context.input_latency + context.output_latency) + ")");
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
      for (int i = 0; i < context.num_samples; ++i) {
        // Phase-lock to master position within the loop region
        int64_t current_master_pos = context.master_pos + i;
        int64_t phase = current_master_pos % dur;
        int current_read_pos = (int)((start + phase) % buffer.getNumSamples());

        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] != nullptr) {
            output_channels[ch][i] +=
                buffer.getReadPointer(0)[current_read_pos];
          }
        }
      }
      int64_t phase = context.master_pos % dur;
      int64_t absolute_read_pos = start + phase;

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
      const double TOLERANCE = 0.10; // 10% tolerance for anticipatory stop
      int64_t threshold = (int64_t)(TOLERANCE * (double)Q);

      // Candidates
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

      if (nextB != -1 && (nextB - L) < threshold) {
        awaiting_stop_at.store(nextB);
        is_awaiting_stop.store(true);
        juce::Logger::writeToLog("ClipNode: Anticipatory Stop. Waiting for B=" +
                                 juce::String(nextB));
        return;
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
