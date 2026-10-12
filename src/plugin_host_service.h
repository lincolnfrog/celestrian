#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include <atomic>
#include <functional>
#include <memory>

namespace celestrian {

/**
 * Plugin hosting (docs/vst3.md §4): the format manager, the registry
 * of known plugins, the background scan, and instantiation. MESSAGE
 * THREAD ONLY — nothing here is reachable from the audio callback.
 *
 *  - The format manager holds the hosted formats
 *    (scan_worker::addHostedFormats).
 *  - The registry (`juce::KnownPluginList`) persists as XML in the data
 *    directory.
 *  - A scan loads plugin code ONLY in a worker process
 *    (src/plugin_scan_worker.h): this process enumerates candidate
 *    files, tails the worker's results, blacklists a file whose probe
 *    crashed or hung and starts a fresh worker on the rest.
 *
 * Licensing note: JUCE bundles the VST3 SDK headers under the SDK's
 * GPLv3 option, which combines with this project's AGPLv3 exactly as
 * the ASIO SDK does (see the CMakeLists ASIO comment).
 */
class PluginHostService {
 public:
  /** `data_directory` holds known_plugins.xml and the scan work files;
   * the app passes <user app data>/Celestrian, tests pass a temp dir.
   * The constructor loads the persisted list. The scan worker command
   * defaults to this very executable + --scan-worker. */
  explicit PluginHostService(const juce::File& data_directory);
  ~PluginHostService();

  /**
   * The registry as a JSON-ready var array, name-sorted, one object per
   * plugin. `uid` is the format-specific identity string
   * (PluginDescription::createIdentifierString) the chain save format
   * keys on (docs/vst3.md §6); `format` is the hosting format's name
   * ("VST3", "AudioUnit").
   */
  juce::var getKnownPluginsVar() const;

  /** What an instantiation hands back: the live instance — NULL when
   * the plugin could not be loaded — and the REGISTRY's description of
   * it. A slot takes its identity from that description — one refilled
   * from the hosted instance drops the format tag, and the uid must be
   * the one the registry reports when a saved session revives the
   * slot. */
  using Instantiated =
      std::function<void(std::unique_ptr<juce::AudioPluginInstance>,
                         const juce::PluginDescription&)>;

  /** Instantiates the registered plugin `plugin_uid` at `sample_rate`
   * and the slots' block ceiling (dsp::Vst3Slot::kMaxBlockSize),
   * asynchronously. True: `done` runs exactly once, later on the
   * message thread — with the instance, or with none when the plugin
   * failed to instantiate (logged). False, and `done` never runs, when
   * the registry has no such plugin. */
  bool instantiateAsync(const juce::String& plugin_uid, double sample_rate,
                        Instantiated done);

  /** How a registered description becomes an instance: `created` runs
   * later on the message thread with the instance, or with none and the
   * reason. The format manager's asynchronous creation unless a test puts
   * its own in place, to decide the outcome and its moment. */
  using Creator = std::function<void(
      const juce::PluginDescription&, double sample_rate, int block_size,
      juce::AudioPluginFormat::PluginCreationCallback created)>;
  void setCreatorForTest(Creator creator) { creator_ = std::move(creator); }

  /**
   * Starts a background scan of every format's default locations (the
   * VST3 directories; on macOS the AudioUnit component registry too)
   * plus `extra_path` when non-empty. No-op while a scan is running.
   * Already-known and blacklisted files are not re-probed; the
   * completed scan persists the list (including any new blacklistings).
   *
   * `include_default_locations = false` scans ONLY `extra_path` for
   * VST3 bundles — for tests that must not touch the machine's real
   * plugins (AudioUnits have no directory to confine to, so they are
   * excluded with the defaults; the app always scans the defaults).
   */
  void startScan(const juce::String& extra_path = juce::String(),
                 bool include_default_locations = true);

  bool isScanning() const { return scanning_.load(); }

  /** The scan's status for the UI's poll while the plugin panel is
   * open. `progress` is 0..1; `crashed` names the files THIS scan
   * excluded because their probe crashed or hung. */
  juce::var getScanStatusVar() const;

  /** Persist the known list (+ blacklist) now. Public so mutations made
   * through knownPlugins() (tests) can be saved explicitly; the scan
   * thread calls it on completion. */
  void saveKnownPlugins() const;

  /** The command prefix the scan is launched with; the coordinator
   * appends `<list file> <results file>`. Empty = a scan with anything
   * to probe ends with an error (nothing is ever probed in-process).
   * Tests point it at a broken binary to pin the failure mode; the app
   * leaves the default. Not while scanning. */
  void setScanWorkerCommand(const juce::StringArray& command);
  juce::StringArray scanWorkerCommand() const { return scan_worker_command_; }

  /** How long one probe may stay silent before the worker is killed
   * and the file treated as a crash. Default 60 s. Not while scanning. */
  void setProbeTimeoutMs(int ms) { probe_timeout_ms_ = ms; }

  /** How long a worker may stay silent with NO file in flight — while
   * it starts on its list, or between two files — before it is killed
   * and the scan ends with an error (no file is blamed). Default 60 s.
   * Not while scanning. */
  void setWorkerIdleTimeoutMs(int ms) { worker_idle_timeout_ms_ = ms; }

  // The underlying JUCE objects, for tests. The registry locks its
  // TYPES; its blacklist it does not — while a scan runs, read that
  // through getScanStatusVar.
  juce::KnownPluginList& knownPlugins() { return known_plugins_; }
  juce::AudioPluginFormatManager& formats() { return format_manager_; }

  juce::File knownPluginsFile() const;
  /** Where the coordinator writes list/results files for its workers. */
  juce::File scanWorkDirectory() const;

  static constexpr const char* kKnownPluginsFileName = "known_plugins.xml";
  static constexpr const char* kScanWorkDirectoryName = "scan_work";

 private:
  class ScanThread;

  void loadKnownPlugins();

  juce::File data_directory_;
  juce::AudioPluginFormatManager format_manager_;
  juce::KnownPluginList known_plugins_;
  Creator creator_;  // empty: the format manager creates

  juce::StringArray scan_worker_command_;
  int probe_timeout_ms_ = 60000;
  int worker_idle_timeout_ms_ = 60000;

  // Scan machinery. The thread is created on the message thread by
  // startScan, which hands it the search path. Everything the
  // message-thread poll reads mid-scan sits behind `status_lock_`
  // (nothing here is audio-thread).
  std::unique_ptr<ScanThread> scan_thread_;
  std::atomic<bool> scanning_{false};
  std::atomic<float> scan_progress_{0.0f};
  mutable juce::CriticalSection status_lock_;
  juce::String current_name_;
  juce::StringArray crashed_;
  juce::String scan_error_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginHostService)
};

}  // namespace celestrian
