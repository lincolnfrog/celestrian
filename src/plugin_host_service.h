#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include <atomic>
#include <memory>

namespace celestrian {

/**
 * The plugin hosting foundation (docs/vst3.md §4, phase 1): the
 * format manager, the known-plugin registry, and the background scan.
 * MESSAGE THREAD ONLY surface — nothing here is reachable from the
 * audio callback; chain integration (phases 2-3) builds on top of the
 * registry this service owns.
 *
 * Responsibilities:
 *  - `juce::AudioPluginFormatManager` with the VST3 format registered
 *    (format-generic by construction — AU later is one addFormat call).
 *  - `juce::KnownPluginList`, persisted as XML in the app data
 *    directory (the same directory audio_device.xml lives in; tests
 *    pass a temp directory instead).
 *  - OUT-OF-PROCESS background scan: this process only enumerates
 *    candidate files; every probe of not-yet-known plugin code happens
 *    in a scan worker — our own executable re-launched with
 *    `--scan-worker` (src/plugin_scan_worker.h has the protocol). A
 *    plugin that crashes or hangs kills or times out the WORKER; the
 *    coordinator blacklists that file, starts a fresh worker on the
 *    remainder, and the app never notices beyond a status line. The
 *    dead-man's-pedal (crash once, blacklist on relaunch) is the
 *    in-process fallback when no worker command is configured; its
 *    leftovers are honoured at construction.
 *
 * Licensing note: JUCE bundles the VST3 SDK headers under the SDK's
 * GPLv3 option, which combines with this project's AGPLv3 exactly as
 * the ASIO SDK does (see the CMakeLists ASIO comment).
 */
class PluginHostService {
 public:
  /** `data_directory` holds known_plugins.xml, the pedal file, and the
   * scan work files; the app passes <user app data>/Celestrian, tests
   * pass a temp dir. The constructor loads the persisted list, applies
   * any pedal blacklisting left over from a crashed in-process scan,
   * and persists that blacklisting immediately (so a second bad plugin
   * crashing the next scan cannot un-blacklist the first). The scan
   * worker command defaults to this very executable + --scan-worker. */
  explicit PluginHostService(const juce::File& data_directory);
  ~PluginHostService();

  /**
   * The known-plugin registry as a JSON-ready var array, name-sorted:
   * [{name, uid, file, maker, category, version, isInstrument}].
   * `uid` is the format-specific identity string
   * (PluginDescription::createIdentifierString) the chain save format
   * keys on (docs/vst3.md §6).
   */
  juce::var getKnownPluginsVar() const;

  /**
   * Starts a background scan of the default VST3 directories plus
   * `extra_path` when non-empty. No-op while a scan is running.
   * Already-known and blacklisted files are not re-probed; the
   * completed scan persists the list (including any new blacklistings).
   *
   * `include_default_locations = false` scans ONLY `extra_path` — for
   * tests that must not touch the machine's real plugin folders (the
   * app always scans the defaults).
   */
  void startScan(const juce::String& extra_path = juce::String(),
                 bool include_default_locations = true);

  bool isScanning() const { return scanning_.load(); }

  /** {scanning, progress 0..1, current, count, blacklistCount,
   * crashed: [file names this scan excluded because their probe
   * crashed or hung], crashedCount, error, outOfProcess} for the UI's
   * poll while the plugin panel is open. */
  juce::var getScanStatusVar() const;

  /** Persist the known list (+ blacklist) now. Public so mutations made
   * through knownPlugins() (tests) can be saved explicitly; the scan
   * thread calls it on completion. */
  void saveKnownPlugins() const;

  /** The command prefix the scan is launched with; the coordinator
   * appends `<list file> <results file>`. Empty = probe in-process
   * (the pedal fallback). Tests point it at a broken binary to pin the
   * failure mode; the app leaves the default. Not while scanning. */
  void setScanWorkerCommand(const juce::StringArray& command);
  juce::StringArray scanWorkerCommand() const { return scan_worker_command_; }

  /** How long one probe may stay silent before the worker is killed
   * and the file treated as a crash. Default 60 s. Not while scanning. */
  void setProbeTimeoutMs(int ms) { probe_timeout_ms_ = ms; }

  // Instantiation (main_component.cc) and tests reach the underlying
  // JUCE objects directly; both are internally locked.
  juce::KnownPluginList& knownPlugins() { return known_plugins_; }
  juce::AudioPluginFormatManager& formats() { return format_manager_; }

  juce::File knownPluginsFile() const;
  juce::File pedalFile() const;
  /** Where the coordinator writes list/results files for its workers. */
  juce::File scanWorkDirectory() const;

  static constexpr const char* kKnownPluginsFileName = "known_plugins.xml";
  static constexpr const char* kPedalFileName = "scan_dead_mans_pedal.txt";
  static constexpr const char* kScanWorkDirectoryName = "scan_work";

 private:
  class ScanThread;

  void loadKnownPlugins();
  /** The VST3 format instance owned by the format manager. */
  juce::AudioPluginFormat* vst3Format() const;

  juce::File data_directory_;
  juce::AudioPluginFormatManager format_manager_;
  juce::KnownPluginList known_plugins_;

  juce::StringArray scan_worker_command_;
  int probe_timeout_ms_ = 60000;

  // Scan machinery. The thread is created on the message thread by
  // startScan; `scan_search_path_` is handed to it at construction.
  // Everything the message-thread poll reads mid-scan sits behind
  // `status_lock_` (nothing here is audio-thread).
  std::unique_ptr<ScanThread> scan_thread_;
  juce::FileSearchPath scan_search_path_;
  std::atomic<bool> scanning_{false};
  std::atomic<float> scan_progress_{0.0f};
  mutable juce::CriticalSection status_lock_;
  juce::String current_name_;
  juce::StringArray crashed_;
  juce::String scan_error_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginHostService)
};

}  // namespace celestrian
