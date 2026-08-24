#include "plugin_host_service.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <mutex>

#include "plugin_scan_worker.h"

namespace celestrian {

namespace {

/**
 * The coordinator end of the scanner subprocess (the worker end is
 * PluginScanWorker; the pattern follows AudioPluginHost's
 * Superprocess). Lives for one scan, lazily; a probe that kills the
 * subprocess surfaces as State::connectionLost.
 */
class ScanCoordinator final : private juce::ChildProcessCoordinator {
 public:
  ScanCoordinator() {
    launched_ = launchWorkerProcess(
        juce::File::getSpecialLocation(juce::File::currentExecutableFile),
        kScanWorkerUid, /*timeoutMs=*/0, /*streamFlags=*/0);
  }

  bool launched() const { return launched_; }

  enum class State { timeout, gotResult, connectionLost };
  struct Response {
    State state;
    std::unique_ptr<juce::XmlElement> xml;
  };

  /** Waits up to 50 ms so the caller can poll its abort flag. */
  Response getResponse() {
    std::unique_lock<std::mutex> lock{mutex_};
    if (!condition_.wait_for(lock, std::chrono::milliseconds{50},
                             [&] { return got_result_ || connection_lost_; }))
      return {State::timeout, nullptr};
    const auto state =
        connection_lost_ ? State::connectionLost : State::gotResult;
    connection_lost_ = false;
    got_result_ = false;
    return {state, std::move(xml_)};
  }

  using juce::ChildProcessCoordinator::sendMessageToWorker;

 private:
  void handleMessageFromWorker(const juce::MemoryBlock& block) override {
    const std::lock_guard<std::mutex> lock{mutex_};
    xml_ = juce::parseXML(block.toString());
    got_result_ = true;
    condition_.notify_one();
  }

  void handleConnectionLost() override {
    const std::lock_guard<std::mutex> lock{mutex_};
    connection_lost_ = true;
    condition_.notify_one();
  }

  std::mutex mutex_;
  std::condition_variable condition_;
  std::unique_ptr<juce::XmlElement> xml_;
  bool got_result_ = false;
  bool connection_lost_ = false;
  bool launched_ = false;

  JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(ScanCoordinator)
};

}  // namespace

/**
 * KnownPluginList::CustomScanner that probes every file in the scanner
 * subprocess. Returning false is the "this file killed the subprocess"
 * signal: scanAndAddFile blacklists the file and the scan walks on.
 * All calls run on the scan thread; requestAbort() is the one
 * cross-thread entry (service destructor).
 */
class PluginHostService::OutOfProcessScanner
    : public juce::KnownPluginList::CustomScanner {
 public:
  bool findPluginTypesFor(juce::AudioPluginFormat& format,
                          juce::OwnedArray<juce::PluginDescription>& result,
                          const juce::String& file_or_identifier) override {
    if (coordinator_ == nullptr)
      coordinator_ = std::make_unique<ScanCoordinator>();
    if (!coordinator_->launched()) {
      // No subprocess (relocated executable?): skipping the file is
      // safer than probing in-process or blacklisting everything.
      juce::Logger::writeToLog(
          "Plugin scan: could not launch the scanner subprocess; skipping " +
          file_or_identifier);
      coordinator_ = nullptr;
      return true;
    }

    juce::MemoryBlock request;
    juce::MemoryOutputStream stream{request, true};
    stream.writeString(format.getName());
    stream.writeString(file_or_identifier);

    if (!coordinator_->sendMessageToWorker(request)) {
      coordinator_ = nullptr;
      return false;
    }

    for (;;) {
      if (abort_requested_.load()) return true;  // abort must not blacklist

      auto response = coordinator_->getResponse();
      if (response.state == ScanCoordinator::State::timeout) continue;

      if (response.xml != nullptr) {
        for (const auto* item : response.xml->getChildIterator()) {
          auto description = std::make_unique<juce::PluginDescription>();
          if (description->loadFromXml(*item))
            result.add(std::move(description));
        }
      }

      if (response.state == ScanCoordinator::State::gotResult) return true;
      coordinator_ = nullptr;  // the probe killed the subprocess
      return false;
    }
  }

  void scanFinished() override { coordinator_ = nullptr; }

  /** Unblocks a waiting probe without blacklisting the in-flight file;
   * the scan thread then sees threadShouldExit and stops. */
  void requestAbort() { abort_requested_.store(true); }

 private:
  std::unique_ptr<ScanCoordinator> coordinator_;
  std::atomic<bool> abort_requested_{false};
};

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
    // Retires the scanner subprocess (CustomScanner::scanFinished).
    owner_.known_plugins_.scanFinished();
    owner_.scan_progress_.store(1.0f);
    owner_.scanning_.store(false);
  }

 private:
  PluginHostService& owner_;
};

PluginHostService::PluginHostService(const juce::File& data_directory)
    : data_directory_(data_directory) {
  format_manager_.addFormat(new juce::VST3PluginFormat());
  auto oop_scanner = std::make_unique<OutOfProcessScanner>();
  oop_scanner_ = oop_scanner.get();
  known_plugins_.setCustomScanner(std::move(oop_scanner));
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
  oop_scanner_->requestAbort();
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

void PluginHostService::startScan(const juce::String& extra_path,
                                  bool include_defaults) {
  if (scanning_.load()) return;
  if (scan_thread_ != nullptr) scan_thread_->stopThread(5000);

  auto* format = vst3Format();
  if (format == nullptr) return;

  juce::FileSearchPath search_path;
  if (include_defaults) search_path = format->getDefaultLocationsToSearch();
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
