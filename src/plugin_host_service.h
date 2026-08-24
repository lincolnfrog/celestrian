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
 *  - Background scan of the platform default VST3 locations plus an
 *    optional user path, with the DEAD-MAN'S-PEDAL crash blacklist:
 *    the scanner writes each file's path before probing it; a probe
 *    that crashes the app leaves the pedal file naming the culprit,
 *    which is blacklisted on the next launch (docs/vst3.md §4 — the
 *    pragmatic middle ground until out-of-process scanning).
 *
 * Licensing note: JUCE bundles the VST3 SDK headers under the SDK's
 * GPLv3 option, which combines with this project's AGPLv3 exactly as
 * the ASIO SDK does (see the CMakeLists ASIO comment).
 */
class PluginHostService {
 public:
  /** `data_directory` holds known_plugins.xml and the pedal file; the
   * app passes <user app data>/Celestrian, tests pass a temp dir. The
   * constructor loads the persisted list and applies any pedal
   * blacklisting left over from a crashed scan. */
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
   * Already-known files are not re-probed; the completed scan persists
   * the list (including any new blacklistings). Tests pass
   * `include_defaults = false` to stay off the machine's real plugin
   * directories.
   */
  void startScan(const juce::String& extra_path = juce::String(),
                 bool include_defaults = true);

  bool isScanning() const { return scanning_.load(); }

  /** {scanning, progress 0..1, current, count, blacklistCount} for the
   * UI's poll while the plugin panel is open. */
  juce::var getScanStatusVar() const;

  /** Persist the known list (+ blacklist) now. Public so mutations made
   * through knownPlugins() (tests, later phases) can be saved
   * explicitly; the scan thread calls it on completion. */
  void saveKnownPlugins() const;

  // Later phases (instantiation) and tests reach the underlying JUCE
  // objects directly; both are internally locked.
  juce::KnownPluginList& knownPlugins() { return known_plugins_; }
  juce::AudioPluginFormatManager& formats() { return format_manager_; }

  juce::File knownPluginsFile() const;
  juce::File pedalFile() const;

  static constexpr const char* kKnownPluginsFileName = "known_plugins.xml";
  static constexpr const char* kPedalFileName = "scan_dead_mans_pedal.txt";

 private:
  class ScanThread;

  void loadKnownPlugins();
  /** The VST3 format instance owned by the format manager. */
  juce::AudioPluginFormat* vst3Format() const;

  juce::File data_directory_;
  juce::AudioPluginFormatManager format_manager_;
  juce::KnownPluginList known_plugins_;

  // Scan machinery. The scanner is created on the message thread by
  // startScan and consumed by the thread; `current_name_` is the only
  // cross-thread string, guarded by its own lock (message-thread poll
  // reads it — nothing here is audio-thread).
  std::unique_ptr<juce::PluginDirectoryScanner> scanner_;
  std::unique_ptr<ScanThread> scan_thread_;
  std::atomic<bool> scanning_{false};
  std::atomic<float> scan_progress_{0.0f};
  mutable juce::CriticalSection current_name_lock_;
  juce::String current_name_;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginHostService)
};

}  // namespace celestrian
