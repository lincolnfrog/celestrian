#include "plugin_host_service.h"

namespace celestrian {

/**
 * The background scan worker. One-shot: constructed per scan, joined in
 * the service destructor (stopThread's exit flag is checked between
 * files, so shutdown never waits on more than the file being probed).
 */
class PluginHostService::ScanThread : public juce::Thread {
 public:
  explicit ScanThread(PluginHostService& owner)
      : juce::Thread("Celestrian plugin scan"), owner_(owner) {}

  void run() override {
    juce::String name_being_scanned;
    while (!threadShouldExit() &&
           owner_.scanner_->scanNextFile(true, name_being_scanned)) {
      {
        const juce::ScopedLock lock(owner_.current_name_lock_);
        owner_.current_name_ = name_being_scanned;
      }
      owner_.scan_progress_.store(owner_.scanner_->getProgress());
    }
    // A clean pass persists everything the scan learned — including
    // files the scanner blacklisted after a failed (non-crashing)
    // probe. A crashed scan never reaches this line; the pedal file
    // does that recovery on next launch instead.
    owner_.saveKnownPlugins();
    owner_.scan_progress_.store(1.0f);
    owner_.scanning_.store(false);
  }

 private:
  PluginHostService& owner_;
};

PluginHostService::PluginHostService(const juce::File& data_directory)
    : data_directory_(data_directory) {
  format_manager_.addFormat(new juce::VST3PluginFormat());
  loadKnownPlugins();
  // Crash recovery: a pedal file with content is the fingerprint of a
  // scan that died mid-probe. Blacklist the culprit so the next scan
  // walks past it instead of crashing the app again. Persist at once:
  // the next scan erases the culprit from the pedal file when it skips
  // it, so an in-memory blacklist would not survive a second crash.
  juce::PluginDirectoryScanner::applyBlacklistingsFromDeadMansPedal(
      known_plugins_, pedalFile());
  if (pedalFile().loadFileAsString().trim().isNotEmpty()) saveKnownPlugins();
}

PluginHostService::~PluginHostService() {
  if (scan_thread_ != nullptr) scan_thread_->stopThread(5000);
}

juce::File PluginHostService::knownPluginsFile() const {
  return data_directory_.getChildFile(kKnownPluginsFileName);
}

juce::File PluginHostService::pedalFile() const {
  return data_directory_.getChildFile(kPedalFileName);
}

juce::AudioPluginFormat* PluginHostService::vst3Format() const {
  for (auto* format : format_manager_.getFormats())
    if (format->getName() == "VST3") return format;
  jassertfalse;  // registered in the constructor — cannot be missing
  return nullptr;
}

void PluginHostService::loadKnownPlugins() {
  if (auto xml = juce::parseXML(knownPluginsFile()))
    known_plugins_.recreateFromXml(*xml);
}

void PluginHostService::saveKnownPlugins() const {
  if (auto xml = known_plugins_.createXml()) {
    data_directory_.createDirectory();
    xml->writeTo(knownPluginsFile());
  }
}

juce::var PluginHostService::getKnownPluginsVar() const {
  auto types = known_plugins_.getTypes();
  // Name-sorted for the UI picker; the registry itself keeps scan order.
  std::sort(types.begin(), types.end(),
            [](const juce::PluginDescription& a,
               const juce::PluginDescription& b) {
              return a.name.compareIgnoreCase(b.name) < 0;
            });
  juce::Array<juce::var> list;
  for (const auto& type : types) {
    auto* entry = new juce::DynamicObject();
    entry->setProperty("name", type.name);
    entry->setProperty("uid", type.createIdentifierString());
    entry->setProperty("file", type.fileOrIdentifier);
    entry->setProperty("maker", type.manufacturerName);
    entry->setProperty("category", type.category);
    entry->setProperty("version", type.version);
    entry->setProperty("isInstrument", type.isInstrument);
    list.add(juce::var(entry));
  }
  return juce::var(list);
}

void PluginHostService::startScan(const juce::String& extra_path) {
  if (scanning_.load()) return;
  if (scan_thread_ != nullptr) scan_thread_->stopThread(5000);

  auto* format = vst3Format();
  if (format == nullptr) return;

  juce::FileSearchPath search_path = format->getDefaultLocationsToSearch();
  if (extra_path.isNotEmpty()) search_path.add(juce::File(extra_path));

  data_directory_.createDirectory();  // the pedal file needs a home
  scanner_ = std::make_unique<juce::PluginDirectoryScanner>(
      known_plugins_, *format, search_path, /*recursive=*/true, pedalFile(),
      /*allowAsync=*/false);

  {
    const juce::ScopedLock lock(current_name_lock_);
    current_name_.clear();
  }
  scan_progress_.store(0.0f);
  scanning_.store(true);
  scan_thread_ = std::make_unique<ScanThread>(*this);
  scan_thread_->startThread();
}

juce::var PluginHostService::getScanStatusVar() const {
  auto* status = new juce::DynamicObject();
  status->setProperty("scanning", scanning_.load());
  status->setProperty("progress", (double)scan_progress_.load());
  {
    const juce::ScopedLock lock(current_name_lock_);
    status->setProperty("current", current_name_);
  }
  status->setProperty("count", known_plugins_.getNumTypes());
  status->setProperty("blacklistCount",
                      known_plugins_.getBlacklistedFiles().size());
  return juce::var(status);
}

}  // namespace celestrian
