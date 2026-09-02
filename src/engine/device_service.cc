// AudioEngine — DEVICE + CALIBRATION: device open and selection (init,
// enableAllInputChannels, setAudioDevice) with its persistence, the
// input and MIDI-input lists, the device lifecycle callbacks
// (audioDeviceAboutToStart / audioDeviceStopped), and latency
// calibration with its per-device persistence (docs/performance.md
// §4, §7). Message thread only, except handleIncomingMidiMessage
// (the MIDI input thread, queue push only).

#include "../audio_engine.h"

#include <algorithm>
#include <cmath>

void AudioEngine::initialiseAudioDevice() { init(1, 2); }

void AudioEngine::init(int inputs, int outputs) {
  // Restore the last chosen device before falling back to the OS default.
  // The default is the wrong answer on a music machine: on Windows it is a
  // 2-channel WASAPI endpoint, and a multi-channel interface's own driver
  // splits the box into stereo endpoints — the interface only appears
  // whole under ASIO, which is never the default type.
  std::unique_ptr<juce::XmlElement> saved;
  auto file = audioDeviceFile();
  if (file.existsAsFile()) {
    saved = juce::parseXML(file);
    if (saved == nullptr) {
      juce::Logger::writeToLog("AudioEngine: stored device setup at " +
                               file.getFullPathName() +
                               " is unreadable - ignoring it.");
    }
  }

  // Ask for the ring's full width, not 8: `initialise` negotiates DOWN to
  // what the hardware has, so the request is a ceiling, not a demand.
  device_error_ = device_manager.initialise(kPreRecordRingChannels, outputs,
                                            saved.get(), true);

  if (device_error_.isNotEmpty() && saved != nullptr) {
    // The stored device is gone (interface unplugged, driver uninstalled).
    // Don't strand the user with no audio — fall back to the default and
    // keep the stored setup on disk so plugging the box back in restores it.
    juce::Logger::writeToLog("AudioEngine: stored device failed to open (" +
                             device_error_ +
                             ") - falling back to the default device.");
    device_error_ = device_manager.initialise(kPreRecordRingChannels, outputs,
                                              nullptr, true);
  }

  if (device_error_.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: device open FAILED: " +
                             device_error_);
  }

  enableAllInputChannels();

  if (auto* device = device_manager.getCurrentAudioDevice()) {
    juce::Logger::writeToLog(
        "AudioEngine: Initialized on '" + device->getName() + "' (" +
        device_manager.getCurrentAudioDeviceType() + ") with " +
        juce::String(device->getActiveInputChannels().countNumberOfSetBits()) +
        " of " + juce::String(device->getInputChannelNames().size()) +
        " input channels.");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: FAILED to get current audio device.");
  }
  device_manager.addAudioCallback(this);
}

void AudioEngine::enableAllInputChannels() {
  auto* device = device_manager.getCurrentAudioDevice();
  if (device == nullptr) return;

  const int available = device->getInputChannelNames().size();
  if (available <= 0) return;

  auto setup = device_manager.getAudioDeviceSetup();
  juce::BigInteger wanted;
  wanted.setRange(0, available, true);
  if (setup.inputChannels == wanted && !setup.useDefaultInputChannels) return;

  setup.inputChannels = wanted;
  setup.useDefaultInputChannels = false;  // else the mask is ignored
  auto err = device_manager.setAudioDeviceSetup(setup, true);
  if (err.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: could not enable all " +
                             juce::String(available) +
                             " input channels: " + err);
  }
}

juce::var AudioEngine::getInputList() const {
  juce::Array<juce::var> names;
  if (auto* device = device_manager.getCurrentAudioDevice()) {
    auto inputNames = device->getInputChannelNames();
    const auto active = device->getActiveInputChannels();
    // Only ACTIVE channels, in active order: the callback's
    // input_channel_data is indexed by active channel, so listing an
    // inactive one would hand the UI an index that addresses a different
    // channel (or none). enableAllInputChannels normally makes these the
    // same list — this stays correct when it can't.
    for (int i = 0; i < inputNames.size(); ++i) {
      if (active[i]) names.add(inputNames[i]);
    }
    juce::Logger::writeToLog("AudioEngine: Found " +
                             juce::String(names.size()) + " active of " +
                             juce::String(inputNames.size()) +
                             " input channels on '" + device->getName() + "'.");
  }
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();
  obj->setProperty("inputs", names);
  return juce::var(obj.get());
}

// --- Device selection (docs/performance.md §4) ---

juce::var AudioEngine::getAudioDeviceState() const {
  juce::DynamicObject::Ptr obj = new juce::DynamicObject();

  // const_cast: every accessor used here is logically const, but
  // AudioDeviceManager does not mark them so.
  auto& mgr = const_cast<juce::AudioDeviceManager&>(device_manager);

  juce::Array<juce::var> types;
  bool asio_available = false;
  for (auto* type : mgr.getAvailableDeviceTypes()) {
    types.add(type->getTypeName());
    if (type->getTypeName().containsIgnoreCase("ASIO")) asio_available = true;
  }
  obj->setProperty("types", types);
  obj->setProperty("currentType", mgr.getCurrentAudioDeviceType());
  obj->setProperty("asioAvailable", asio_available);

  juce::Array<juce::var> devices;
  if (auto* type = mgr.getCurrentDeviceTypeObject()) {
    type->scanForDevices();  // hot-plug: the picker is opened on demand
    for (const auto& name : type->getDeviceNames(false)) devices.add(name);
  }
  obj->setProperty("devices", devices);

  juce::Array<juce::var> rates, buffers;
  auto* device = mgr.getCurrentAudioDevice();
  if (device != nullptr) {
    obj->setProperty("currentDevice", device->getName());
    for (double r : device->getAvailableSampleRates()) rates.add(r);
    for (int b : device->getAvailableBufferSizes()) buffers.add(b);
    obj->setProperty("currentSampleRate", device->getCurrentSampleRate());
    obj->setProperty("currentBufferSize",
                     device->getCurrentBufferSizeSamples());
    obj->setProperty("inputChannels",
                     device->getActiveInputChannels().countNumberOfSetBits());
    obj->setProperty("outputChannels",
                     device->getActiveOutputChannels().countNumberOfSetBits());
    // What the picker shows as the payoff of switching drivers.
    obj->setProperty("availableInputChannels",
                     device->getInputChannelNames().size());
  } else {
    obj->setProperty("currentDevice", juce::String());
    obj->setProperty("currentSampleRate", 0.0);
    obj->setProperty("currentBufferSize", 0);
    obj->setProperty("inputChannels", 0);
    obj->setProperty("outputChannels", 0);
    obj->setProperty("availableInputChannels", 0);
  }
  obj->setProperty("sampleRates", rates);
  obj->setProperty("bufferSizes", buffers);
  obj->setProperty("error", device_error_);

  return juce::var(obj.get());
}

juce::String AudioEngine::setAudioDevice(const juce::String& type,
                                         const juce::String& device,
                                         double sample_rate, int buffer_size) {
  // Switching driver type first: the device list is scoped to the type, so
  // a name from the new type is meaningless until the type is current.
  if (type.isNotEmpty() && type != device_manager.getCurrentAudioDeviceType()) {
    device_manager.setCurrentAudioDeviceType(type, true);
  }

  auto setup = device_manager.getAudioDeviceSetup();
  if (device.isNotEmpty()) {
    setup.inputDeviceName = device;
    setup.outputDeviceName = device;
  }
  // 0 = "whatever the device prefers" — which is what a type switch leaves
  // behind, and forcing a stale rate onto new hardware just fails the open.
  if (sample_rate > 0) setup.sampleRate = sample_rate;
  if (buffer_size > 0) setup.bufferSize = buffer_size;
  setup.useDefaultInputChannels = true;  // negotiate first…
  setup.useDefaultOutputChannels = true;

  device_error_ = device_manager.setAudioDeviceSetup(setup, true);
  if (device_error_.isNotEmpty()) {
    juce::Logger::writeToLog("AudioEngine: setAudioDevice('" + type + "', '" +
                             device + "') FAILED: " + device_error_);
    return device_error_;
  }

  enableAllInputChannels();  // …then widen to every channel it has
  persistAudioDevice();

  if (auto* opened = device_manager.getCurrentAudioDevice()) {
    juce::Logger::writeToLog(
        "AudioEngine: device set to '" + opened->getName() + "' (" +
        device_manager.getCurrentAudioDeviceType() +
        ") sr=" + juce::String(opened->getCurrentSampleRate()) + " block=" +
        juce::String(opened->getCurrentBufferSizeSamples()) + " inputs=" +
        juce::String(opened->getActiveInputChannels().countNumberOfSetBits()));
  }
  return {};
}

juce::File AudioEngine::audioDeviceFile() const {
  return appDataFile(audio_device_file_override_, "audio_device.xml");
}

void AudioEngine::setAudioDeviceFile(const juce::File& file) {
  audio_device_file_override_ = file;
}

void AudioEngine::persistAudioDevice() {
  auto state = device_manager.createStateXml();
  if (state == nullptr) {
    // Null means "nothing but defaults" — there is no selection worth
    // storing, and writing an empty file would just shadow a later one.
    return;
  }
  auto file = audioDeviceFile();
  file.getParentDirectory().createDirectory();
  if (state->writeTo(file)) {
    juce::Logger::writeToLog("AudioEngine: device setup persisted -> " +
                             file.getFullPathName());
  } else {
    juce::Logger::writeToLog("AudioEngine: FAILED to persist device setup to " +
                             file.getFullPathName());
  }
}

void AudioEngine::refreshMidiInputs() {
  for (const auto& device : juce::MidiInput::getAvailableDevices()) {
    if (!device_manager.isMidiInputDeviceEnabled(device.identifier))
      device_manager.setMidiInputDeviceEnabled(device.identifier, true);
  }
  if (!midi_callback_registered_) {
    // Empty identifier = every enabled device routes here.
    device_manager.addMidiInputDeviceCallback({}, this);
    midi_callback_registered_ = true;
  }
}

juce::var AudioEngine::getMidiInputs() const {
  juce::Array<juce::var> names;
  for (const auto& device : juce::MidiInput::getAvailableDevices())
    names.add(device.name);
  auto* out = new juce::DynamicObject();
  out->setProperty("devices", names);
  out->setProperty("dropped", midi_input_queue_.droppedCount());
  return juce::var(out);
}

void AudioEngine::handleIncomingMidiMessage(juce::MidiInput*,
                                            const juce::MidiMessage& message) {
  midi_input_queue_.push(message);
}

// --- Latency Calibration (docs/performance.md §7) ---

void AudioEngine::startLatencyCalibration() {
  // Preallocate the capture buffer on the message thread BEFORE flipping
  // the phase — the audio thread only ever writes into existing storage.
  const double sr = cached_sample_rate_.load();
  const int capture_len = (int)(sr * 2.0);  // 2 s window
  calibration_capture_.setSize(1, capture_len, /*keepExistingContent=*/false,
                               /*clearExtraSpace=*/true,
                               /*avoidReallocating=*/false);
  calibration_capture_.clear();
  calibration_click_pos_ = (int)(sr * 0.25);  // 250 ms of noise-floor lead-in
  calibration_write_pos_.store(0);
  measured_latency_samples_.store(-1);  // fall back to reported until done

  juce::Logger::writeToLog(
      "AudioEngine: Latency calibration started (capture " +
      juce::String(capture_len) + " samples, click at " +
      juce::String(calibration_click_pos_) + ")");

  calibration_phase_.store((int)CalibrationPhase::Capturing);
}

juce::var AudioEngine::getLatencyCalibration() {
  const double sr = cached_sample_rate_.load();

  // Run onset detection once, on the message thread, when capture is done.
  if (calibration_phase_.load() == (int)CalibrationPhase::Done &&
      measured_latency_samples_.load() < 0) {
    const float* data = calibration_capture_.getReadPointer(0);
    const int len = calibration_capture_.getNumSamples();
    const int click = calibration_click_pos_;

    // Noise floor from the lead-in, peak from the post-click region.
    float floor_level = 0.0f;
    for (int i = 0; i < click; ++i)
      floor_level = std::max(floor_level, std::abs(data[i]));
    float peak = 0.0f;
    for (int i = click; i < len; ++i) peak = std::max(peak, std::abs(data[i]));

    // Need a clear response well above the room/line noise.
    if (peak < std::max(0.02f, floor_level * 4.0f)) {
      calibration_phase_.store((int)CalibrationPhase::Failed);
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration FAILED - no loopback signal "
          "detected (peak=" +
          juce::String(peak) + ", floor=" + juce::String(floor_level) + ")");
    } else {
      const float threshold = std::max(floor_level * 4.0f, peak * 0.3f);
      for (int i = click; i < len; ++i) {
        if (std::abs(data[i]) >= threshold) {
          measured_latency_samples_.store(i - click);
          break;
        }
      }
      juce::Logger::writeToLog(
          "AudioEngine: Latency calibration DONE - round trip = " +
          juce::String(measured_latency_samples_.load()) + " samples (" +
          juce::String(measured_latency_samples_.load() / sr * 1000.0, 2) +
          " ms)");
      persistCalibration(measured_latency_samples_.load());
    }
  }

  juce::DynamicObject::Ptr result = new juce::DynamicObject();
  const int phase = calibration_phase_.load();
  const char* phase_name = phase == (int)CalibrationPhase::Capturing
                               ? "capturing"
                           : phase == (int)CalibrationPhase::Done   ? "done"
                           : phase == (int)CalibrationPhase::Failed ? "failed"
                                                                    : "idle";
  const int64_t measured = measured_latency_samples_.load();
  result->setProperty("phase", phase_name);
  result->setProperty("roundTripSamples", (double)measured);
  result->setProperty("roundTripMs",
                      measured >= 0 ? measured / sr * 1000.0 : -1.0);
  result->setProperty("calibrated", measured >= 0);
  return juce::var(result.get());
}

void AudioEngine::audioDeviceAboutToStart(juce::AudioIODevice* device) {
  if (device) {
    cached_input_latency_.store(device->getInputLatencyInSamples());
    cached_output_latency_.store(device->getOutputLatencyInSamples());
    cached_sample_rate_.store(device->getCurrentSampleRate());

    // Latency self-report (docs/performance.md §6.3): if the reported
    // latencies are zero, recording compensation is a no-op and empirical
    // calibration is the only trustworthy source.
    juce::Logger::writeToLog(
        "AudioEngine: Device started: '" + device->getName() +
        "' sr=" + juce::String(device->getCurrentSampleRate()) +
        " block=" + juce::String(device->getCurrentBufferSizeSamples()) +
        " inLatency=" + juce::String(device->getInputLatencyInSamples()) +
        " outLatency=" + juce::String(device->getOutputLatencyInSamples()));

    // A calibration is only valid for the exact device configuration it
    // was measured on.
    current_device_key_ = device->getName() + "|" +
                          juce::String(device->getCurrentSampleRate()) + "|" +
                          juce::String(device->getCurrentBufferSizeSamples());
    restoreCalibrationForCurrentDevice();
  }
}

// --- Calibration persistence (docs/performance.md §7) ---

juce::File AudioEngine::appDataFile(const juce::File& override_file,
                                    const juce::String& file_name) {
  if (override_file != juce::File()) return override_file;
  return juce::File::getSpecialLocation(
             juce::File::userApplicationDataDirectory)
      .getChildFile("Celestrian")
      .getChildFile(file_name);
}

juce::File AudioEngine::calibrationFile() const {
  return appDataFile(calibration_file_override_, "calibration.json");
}

void AudioEngine::setCalibrationFile(const juce::File& file) {
  calibration_file_override_ = file;
}

void AudioEngine::persistCalibration(int64_t samples) {
  // No device key means no device ever started (unit tests) — a value
  // measured there is not attributable to hardware, so don't store it.
  if (current_device_key_.isEmpty() || samples < 0) return;

  auto file = calibrationFile();
  juce::var root;
  if (file.existsAsFile()) {
    root = juce::JSON::parse(file.loadFileAsString());
  }
  if (root.getDynamicObject() == nullptr) {
    root = juce::var(new juce::DynamicObject());
  }
  root.getDynamicObject()->setProperty(current_device_key_, (double)samples);

  file.getParentDirectory().createDirectory();
  file.replaceWithText(juce::JSON::toString(root, true));

  juce::Logger::writeToLog("AudioEngine: Calibration persisted for '" +
                           current_device_key_ + "' (" + juce::String(samples) +
                           " samples) -> " + file.getFullPathName());
}

void AudioEngine::restoreCalibrationForCurrentDevice() {
  int64_t restored = -1;

  auto file = calibrationFile();
  if (current_device_key_.isNotEmpty() && file.existsAsFile()) {
    auto root = juce::JSON::parse(file.loadFileAsString());
    if (auto* obj = root.getDynamicObject()) {
      if (obj->hasProperty(current_device_key_)) {
        restored = (int64_t)(double)obj->getProperty(current_device_key_);
      }
    }
  }

  // Found -> use the empirical value from a previous session. Not found ->
  // reset: a value measured on a different device config must not carry
  // over (that would be silently wrong compensation).
  measured_latency_samples_.store(restored);

  if (restored >= 0) {
    juce::Logger::writeToLog(
        "AudioEngine: Calibration restored for '" + current_device_key_ +
        "': " + juce::String(restored) + " samples (" +
        juce::String(restored / cached_sample_rate_.load() * 1000.0, 2) +
        " ms)");
  } else {
    juce::Logger::writeToLog(
        "AudioEngine: No stored calibration for '" + current_device_key_ +
        "' - using device-reported latencies until calibrated.");
  }
}

void AudioEngine::audioDeviceStopped() {
  // The callback is no longer running; everything pending is safe to free.
  flushGraveyard();
}
