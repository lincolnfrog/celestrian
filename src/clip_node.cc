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
  obj->setProperty("input_channel", preferred_input_channel);
  return base;
}

void ClipNode::process(const float *const *input_channels,
                       float *const *output_channels, int num_input_channels,
                       int num_output_channels, const ProcessContext &context) {

  // Handle Recording
  if (is_recording || is_awaiting_stop) {
    if (!context.is_recording) {
      static int log_limit = 0;
      if (log_limit++ % 100 == 0)
        juce::Logger::writeToLog("ClipNode: context.is_recording is FALSE");
    } else if (input_channels == nullptr || num_input_channels <= 0) {
      static int log_limit2 = 0;
      if (log_limit2++ % 100 == 0)
        juce::Logger::writeToLog(
            "ClipNode: No input hardware channels available.");
    }

    if (context.is_recording && input_channels != nullptr &&
        num_input_channels > 0) {
      const float *in = input_channels[std::min(preferred_input_channel,
                                                num_input_channels - 1)];
      int samples_to_write = std::min(
          context.num_samples, buffer.getNumSamples() - write_pos.load());

      if (samples_to_write > 0) {
        // juce::Logger::writeToLog("ClipNode: Capturing " +
        // juce::String(samples_to_write) + " samples into buffer.");
        buffer.copyFrom(0, write_pos.load(), in, samples_to_write);

        // Peak tracking across all input channels
        float block_peak = 0.0f;
        for (int ch = 0; ch < num_input_channels; ++ch) {
          if (input_channels[ch] != nullptr) {
            for (int i = 0; i < samples_to_write; ++i) {
              block_peak =
                  std::max(block_peak, std::abs(input_channels[ch][i]));
            }
          }
        }
        last_block_peak.store(block_peak);

        if (block_peak > current_max_peak.load()) {
          current_max_peak.store(block_peak);
        }

        int start_pos = write_pos.load();
        write_pos += samples_to_write;
        int end_pos = write_pos.load();

        // "Magnetic" Quantum Stop Logic
        if (is_awaiting_stop && primary_quantum_samples > 0) {
          // Check if we crossed a quantum boundary in this block
          int64_t last_q = start_pos / primary_quantum_samples;
          int64_t curr_q = end_pos / primary_quantum_samples;
          if (curr_q > last_q) {
            // Snap write_pos to the boundary and stop
            is_recording = false;
            is_awaiting_stop = false;
            duration_samples = write_pos.load();
            is_playing = true; // Auto-playback after recording stops
            is_node_recording = false;
          }
        }
      } else {
        is_recording = false;
        is_awaiting_stop = false;
        duration_samples = write_pos.load();
        is_playing = true; // Auto-playback
        is_node_recording = false;
      }
    }
  }

  // Handle Playback
  if (context.is_playing && is_playing) {
    int duration = (int)duration_samples;
    if (duration > 0) {
      for (int i = 0; i < context.num_samples; ++i) {
        // Phase-lock to master position for perfectly synchronized loops
        int64_t current_master_pos = context.master_pos + i;
        int current_read_pos = (int)(current_master_pos % duration);

        for (int ch = 0; ch < num_output_channels; ++ch) {
          if (output_channels[ch] != nullptr) {
            output_channels[ch][i] +=
                buffer.getReadPointer(0)[current_read_pos];
          }
        }
      }
      playhead_pos = (double)(context.master_pos % duration) / (double)duration;
    }
  }
}

void ClipNode::startRecording() {
  buffer.clear();
  write_pos = 0;
  read_pos = 0;
  current_max_peak = 0.0f;
  is_recording = true;
  is_awaiting_stop = false;
  is_node_recording = true;
}

void ClipNode::stopRecording() {
  if (primary_quantum_samples > 0) {
    is_awaiting_stop = true;
  } else {
    is_recording = false;
    duration_samples = write_pos.load();
    is_node_recording = false;
    is_playing = true; // Auto-playback
  }
}

void ClipNode::startPlayback() {
  if (duration_samples > 0) {
    read_pos = 0;
    is_playing = true;
  }
}

void ClipNode::stopPlayback() { is_playing = false; }

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
