#pragma once

#include <atomic>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_utils/juce_audio_utils.h>

class AudioEngine : public juce::AudioIODeviceCallback {
public:
  AudioEngine();
  ~AudioEngine() override;

  void startRecording();
  void stopRecording();
  void startPlayback();
  void stopPlayback();

  bool isRecording() const { return recording; }
  bool isPlaying() const { return playing; }

  juce::var getWaveformAsJSON(int num_peaks) const;

  void audioDeviceIOCallbackWithContext(
      const float *const *inputChannelData, int numInputChannels,
      float *const *outputChannelData, int numOutputChannels, int numSamples,
      const juce::AudioIODeviceCallbackContext &context) override;
  void audioDeviceAboutToStart(juce::AudioIODevice *device) override;
  void audioDeviceStopped() override;

private:
  void init(int inputs, int outputs);

  juce::AudioDeviceManager device_manager;

  juce::AudioBuffer<float> recorded_buffer;
  std::atomic<int> write_pos{0};
  std::atomic<int> read_pos{0};

  std::atomic<bool> recording{false};
  std::atomic<bool> playing{false};

  double sample_rate = 44100.0;
  std::atomic<float> current_max_peak{0.0f};

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AudioEngine)
};
