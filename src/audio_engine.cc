#include "audio_engine.h"

AudioEngine::AudioEngine() {
  juce::Logger::writeToLog("AudioEngine: Initializing...");

  juce::RuntimePermissions::request(
      juce::RuntimePermissions::recordAudio, [this](bool granted) {
        if (granted) {
          juce::Logger::writeToLog(
              "AudioEngine: Permission granted on startup.");
          init(1, 2);
        } else {
          juce::Logger::writeToLog(
              "AudioEngine: Permission denied on startup.");
          init(0, 2);
        }
      });
}

void AudioEngine::init(int inputs, int outputs) {
  auto error = device_manager.initialiseWithDefaultDevices(inputs, outputs);
  if (error.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: Init error: " + error);
  }

  auto current_setup = device_manager.getAudioDeviceSetup();
  juce::Logger::writeToLog(
      "AudioEngine: Current Setup - In: " +
      juce::String(current_setup.inputChannels.countNumberOfSetBits()) +
      ", Out: " +
      juce::String(current_setup.outputChannels.countNumberOfSetBits()));

  device_manager.addAudioCallback(this);
}

AudioEngine::~AudioEngine() { device_manager.removeAudioCallback(this); }

// Initialize with a larger buffer to prevent early cutoffs
void AudioEngine::startRecording() {
  recorded_buffer.setSize(1, 44100 * 60); // 60 seconds at 44.1k
  recorded_buffer.clear();
  write_pos = 0;
  current_max_peak = 0.0f;
  recording = true;
  playing = false;
  juce::Logger::writeToLog("AudioEngine: Recording started.");
}

void AudioEngine::stopRecording() {
  recording = false;
  juce::Logger::writeToLog(
      "AudioEngine: Recording stopped. Samples: " + juce::String(write_pos) +
      " | Max Peak: " + juce::String(current_max_peak.load()));

  // We don't shrink the buffer anymore to avoid concurrency issues during
  // playback The numSamples check in getWaveform/playback handles the logical
  // length
}

void AudioEngine::startPlayback() {
  if (write_pos > 0) {
    read_pos = 0;
    playing = true;
    juce::Logger::writeToLog("AudioEngine: Playback started at position 0.");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: Playback failed (no samples recorded).");
  }
}

void AudioEngine::stopPlayback() {
  playing = false;
  juce::Logger::writeToLog("AudioEngine: Playback stopped.");
}

juce::var AudioEngine::getWaveformAsJSON(int num_peaks) const {
  juce::Array<juce::var> peaks;
  int num_samples = (int)write_pos;
  if (num_samples == 0)
    return peaks;

  int step = std::max(1, num_samples / num_peaks);
  auto *data = recorded_buffer.getReadPointer(0);

  for (int i = 0; i < num_peaks; ++i) {
    int start = i * step;
    int end = std::min(num_samples, start + step);
    float max_val = 0.0f;
    for (int s = start; s < end; ++s) {
      max_val = std::max(max_val, std::abs(data[s]));
    }
    peaks.add(max_val);
  }

  return peaks;
}

void AudioEngine::audioDeviceIOCallbackWithContext(
    const float *const *inputChannelData, int numInputChannels,
    float *const *outputChannelData, int numOutputChannels, int numSamples,
    const juce::AudioIODeviceCallbackContext &context) {

  // Handle recording (Mono)
  if (recording && inputChannelData != nullptr && numInputChannels > 0) {
    const float *in = inputChannelData[0];
    if (in != nullptr) {
      int samples_to_write = std::min(
          numSamples, (int)recorded_buffer.getNumSamples() - (int)write_pos);

      if (samples_to_write > 0) {
        recorded_buffer.copyFrom(0, (int)write_pos, in, samples_to_write);

        // Track peak for diagnostics
        float peak = 0.0f;
        for (int i = 0; i < samples_to_write; ++i) {
          peak = std::max(peak, std::abs(in[i]));
        }
        if (peak > current_max_peak)
          current_max_peak = peak;

        write_pos += samples_to_write;
      } else {
        recording = false;
      }
    }
  }

  // Handle playback (Stereo output from Mono buffer)
  if (playing) {
    int samples_to_read = std::min(numSamples, (int)write_pos - (int)read_pos);

    if (samples_to_read > 0) {
      auto *buffer_data = recorded_buffer.getReadPointer(0);
      for (int ch = 0; ch < numOutputChannels; ++ch) {
        if (outputChannelData[ch] != nullptr) {
          juce::FloatVectorOperations::copy(
              outputChannelData[ch], buffer_data + read_pos, samples_to_read);

          if (samples_to_read < numSamples) {
            juce::FloatVectorOperations::clear(outputChannelData[ch] +
                                                   samples_to_read,
                                               numSamples - samples_to_read);
          }
        }
      }
      read_pos += samples_to_read;
    } else {
      playing = false;
      for (int ch = 0; ch < numOutputChannels; ++ch) {
        if (outputChannelData[ch] != nullptr) {
          juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
        }
      }
    }
  } else {
    for (int ch = 0; ch < numOutputChannels; ++ch) {
      if (outputChannelData[ch] != nullptr) {
        juce::FloatVectorOperations::clear(outputChannelData[ch], numSamples);
      }
    }
  }
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice *device) {
  sample_rate = device->getCurrentSampleRate();
}

void AudioEngine::audioDeviceStopped() {}
