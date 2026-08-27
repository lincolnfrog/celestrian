#include "plugin_host_service.h"

#include <string>

#include "plugin_scan_worker.h"

namespace celestrian {

/**
 * The scan coordinator. One-shot: constructed per scan with the search
 * path, joined in the service destructor (the poll loop checks the
 * exit flag every 100 ms and kills its worker on the way out, so
 * shutdown never waits on a probe).
 *
 * Enumeration (walking directories for .vst3 bundles) runs here, in
 * this process — no plugin code is involved. Probing runs in a worker
 * process per src/plugin_scan_worker.h; this thread tails the worker's
 * results file. The in-process path (`runInProcess`) is the legacy
 * pedal-protected loop, used only when no worker command is set.
 */
class PluginHostService::ScanThread : public juce::Thread {
 public:
  ScanThread(PluginHostService& owner, juce::FileSearchPath search_path)
      : juce::Thread("Celestrian plugin scan"),
        owner_(owner),
        search_path_(std::move(search_path)) {}

  void run() override {
    enumerate();
    if (owner_.scan_worker_command_.isEmpty())
      runInProcess();
    else
      runOutOfProcess();
    // Persist everything the scan learned, including the files it
    // blacklisted. Reached on the way out of a stopThread too — the
    // work done so far is worth keeping.
    owner_.saveKnownPlugins();
    owner_.scan_progress_.store(1.0f);
    owner_.scanning_.store(false);
  }

 private:
  // -- shared -----------------------------------------------------------

  /** Fills `pending_` with the files worth probing: everything the
   * formats find on the search path that is neither already listed
   * (with an unchanged modification time) nor blacklisted. */
  void enumerate() {
    for (auto* format : owner_.format_manager_.getFormats()) {
      const auto candidates = format->searchPathsForPlugins(
          search_path_, /*recursive=*/true, /*allowAsync=*/false);
      for (const auto& file : candidates) {
        if (owner_.known_plugins_.isListingUpToDate(file, *format)) continue;
        if (owner_.known_plugins_.getBlacklistedFiles().contains(file)) continue;
        pending_.addIfNotAlreadyThere(file);
      }
    }
    total_ = pending_.size();
    updateProgress();
  }

  void updateProgress() {
    owner_.scan_progress_.store(
        total_ == 0 ? 1.0f : (float)done_ / (float)total_);
  }

  void setCurrent(const juce::String& file) {
    juce::String name;
    for (auto* format : owner_.format_manager_.getFormats())
      if (format->fileMightContainThisPluginType(file))
        name = format->getNameOfPluginFromIdentifier(file);
    const juce::ScopedLock lock(owner_.status_lock_);
    owner_.current_name_ = name.isNotEmpty() ? name : file;
  }

  void setError(const juce::String& message) {
    const juce::ScopedLock lock(owner_.status_lock_);
    owner_.scan_error_ = message;
  }

  /** A probe that crashed or hung: out of the list for good. */
  void excludeCrashed(const juce::String& file, const juce::String& why) {
    owner_.known_plugins_.addToBlacklist(file);
    {
      const juce::ScopedLock lock(owner_.status_lock_);
      owner_.crashed_.add(juce::File(file).getFileName());
    }
    juce::Logger::writeToLog("plugin scan: " + why + " probing " + file +
                             " - excluded (blacklisted)");
    finishFile(file);
  }

  void finishFile(const juce::String& file) {
    pending_.removeString(file);
    ++done_;
    updateProgress();
  }

  // -- legacy: probe in this process, pedal-protected ----------------------

  void runInProcess() {
    auto* format = owner_.vst3Format();
    if (format == nullptr) return;
    while (!pending_.isEmpty() && !threadShouldExit()) {
      const auto file = pending_[0];
      setCurrent(file);
      // The dead-man's-pedal: a crash here leaves the file named for
      // the next launch to blacklist (constructor).
      owner_.pedalFile().replaceWithText(file + "\n");
      juce::OwnedArray<juce::PluginDescription> found;
      owner_.known_plugins_.scanAndAddFile(file, true, found, *format);
      owner_.pedalFile().deleteFile();
      finishFile(file);
    }
  }

  // -- out of process ------------------------------------------------------

  /** Appends whatever `file` has grown by since `consumed` to `bytes`
   * (raw, so a UTF-8 sequence split across polls stays intact). */
  static void readNewBytes(const juce::File& file, juce::int64& consumed,
                           std::string& bytes) {
    juce::FileInputStream in(file);
    if (in.failedToOpen()) return;
    const juce::int64 size = in.getTotalLength();
    if (size <= consumed) return;
    in.setPosition(consumed);
    juce::MemoryBlock block;
    in.readIntoMemoryBlock(block, (ssize_t)(size - consumed));
    bytes.append((const char*)block.getData(), block.getSize());
    consumed = size;
  }

  /** One worker's tail state. */
  struct WorkerSession {
    juce::String in_flight;
    juce::OwnedArray<juce::PluginDescription> found;
    bool done = false;
    bool made_progress = false;
  };

  void handleLine(const juce::String& line, WorkerSession& session) {
    using namespace scan_worker;
    if (line.startsWith(kBegin)) {
      session.in_flight = line.fromFirstOccurrenceOf(kBegin, false, false);
      session.found.clear();
      setCurrent(session.in_flight);
    } else if (line.startsWith(kFound)) {
      juce::MemoryOutputStream decoded;
      if (juce::Base64::convertFromBase64(
              decoded, line.fromFirstOccurrenceOf(kFound, false, false)))
        if (auto xml = juce::parseXML(decoded.toString())) {
          auto description = std::make_unique<juce::PluginDescription>();
          if (description->loadFromXml(*xml))
            session.found.add(description.release());
        }
    } else if (line.startsWith(kEnd)) {
      const auto file = line.fromFirstOccurrenceOf(kEnd, false, false);
      for (const auto* description : session.found)
        owner_.known_plugins_.addType(*description);
      if (session.found.isEmpty())
        juce::Logger::writeToLog("plugin scan: no plugins in " + file);
      session.found.clear();
      session.in_flight.clear();
      session.made_progress = true;
      finishFile(file);
    } else if (line == kDone) {
      session.done = true;
    }
  }

  /** Splits complete lines off `bytes` and handles them. */
  void drain(std::string& bytes, WorkerSession& session) {
    for (;;) {
      const auto newline = bytes.find('\n');
      if (newline == std::string::npos) return;
      const auto line = juce::String::fromUTF8(bytes.data(), (int)newline);
      bytes.erase(0, newline + 1);
      handleLine(line.trimEnd(), session);
    }
  }

  void runOutOfProcess() {
    const auto work_dir = owner_.scanWorkDirectory();
    work_dir.deleteRecursively();
    work_dir.createDirectory();

    for (int spawn = 1; !pending_.isEmpty() && !threadShouldExit(); ++spawn) {
      const auto list_file =
          work_dir.getChildFile("list_" + juce::String(spawn) + ".txt");
      const auto results_file =
          work_dir.getChildFile("results_" + juce::String(spawn) + ".txt");
      list_file.replaceWithText(pending_.joinIntoString("\n") + "\n", false,
                                false, "\n");
      results_file.deleteFile();
      results_file.create();

      auto command = owner_.scan_worker_command_;
      command.add(list_file.getFullPathName());
      command.add(results_file.getFullPathName());

      // No stream flags: the worker's stdout/stderr (JUCE's version
      // banner, plugin chatter) go nowhere; results come via the file.
      juce::ChildProcess worker;
      if (!juce::File::isAbsolutePath(command[0]) ||
          !juce::File(command[0]).existsAsFile()) {
        setError("scan worker executable is missing: " + command[0]);
        return;
      }
      if (!worker.start(command, 0)) {
        setError("scan worker could not be launched: " + command[0]);
        return;
      }

      WorkerSession session;
      std::string bytes;
      juce::int64 consumed = 0;
      juce::uint32 last_activity = juce::Time::getMillisecondCounter();
      bool hung = false;

      while (!threadShouldExit()) {
        // Liveness first, then read: anything written before a death
        // is drained on this same pass.
        const bool alive = worker.isRunning();
        const auto before = bytes.size();
        readNewBytes(results_file, consumed, bytes);
        if (bytes.size() != before) last_activity = juce::Time::getMillisecondCounter();
        drain(bytes, session);
        if (session.done || !alive) break;
        if (session.in_flight.isNotEmpty() &&
            (int)(juce::Time::getMillisecondCounter() - last_activity) >
                owner_.probe_timeout_ms_) {
          hung = true;
          worker.kill();
          break;
        }
        wait(100);
      }

      if (threadShouldExit()) {
        worker.kill();
        return;
      }
      worker.waitForProcessToFinish(2000);

      if (session.in_flight.isNotEmpty()) {
        // BEGIN without END: the probe took the worker down (or hung
        // and we took it down). Exclude, then a fresh worker resumes.
        excludeCrashed(session.in_flight, hung ? "hung" : "crashed");
        continue;
      }
      if (session.done) return;  // list exhausted; pending_ is empty
      if (!session.made_progress) {
        // Exited before probing anything and without DONE: the worker
        // binary is broken. Stop rather than respawn forever.
        setError("scan worker exited without scanning (code " +
                 juce::String((int)worker.getExitCode()) + ")");
        return;
      }
      // Died between files without DONE (odd but survivable): respawn
      // on the remainder.
    }
  }

  PluginHostService& owner_;
  juce::FileSearchPath search_path_;
  juce::StringArray pending_;
  int total_ = 0;
  int done_ = 0;
};

PluginHostService::PluginHostService(const juce::File& data_directory)
    : data_directory_(data_directory) {
  format_manager_.addFormat(new juce::VST3PluginFormat());
  loadKnownPlugins();
  // Crash recovery for the in-process path: a pedal file with content
  // is the fingerprint of a scan that died mid-probe. Blacklist the
  // culprit so the next scan walks past it instead of crashing again.
  const int blacklisted_before = known_plugins_.getBlacklistedFiles().size();
  juce::PluginDirectoryScanner::applyBlacklistingsFromDeadMansPedal(
      known_plugins_, pedalFile());
  // Persist the blacklisting NOW, not at the end of the next clean
  // scan: with two bad plugins, the next scan dies on the second one
  // before it ever saves, and an unsaved first culprit comes back to
  // crash the launch after that (an endless crash loop; fixed
  // 2026-08-26, pinned by plugin_host_tests).
  if (known_plugins_.getBlacklistedFiles().size() > blacklisted_before)
    saveKnownPlugins();

  // The default worker is this very executable in --scan-worker mode
  // (the app and CelestrianTests both carry the flag).
  scan_worker_command_ = {
      juce::File::getSpecialLocation(juce::File::currentExecutableFile)
          .getFullPathName(),
      scan_worker::kFlag};
}

PluginHostService::~PluginHostService() {
  if (scan_thread_ != nullptr) scan_thread_->stopThread(5000);
}

void PluginHostService::setScanWorkerCommand(const juce::StringArray& command) {
  jassert(!scanning_.load());
  scan_worker_command_ = command;
}

juce::File PluginHostService::knownPluginsFile() const {
  return data_directory_.getChildFile(kKnownPluginsFileName);
}

juce::File PluginHostService::pedalFile() const {
  return data_directory_.getChildFile(kPedalFileName);
}

juce::File PluginHostService::scanWorkDirectory() const {
  return data_directory_.getChildFile(kScanWorkDirectoryName);
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
                                  bool include_default_locations) {
  if (scanning_.load()) return;
  if (scan_thread_ != nullptr) scan_thread_->stopThread(5000);

  auto* format = vst3Format();
  if (format == nullptr) return;

  juce::FileSearchPath search_path;
  if (include_default_locations)
    search_path = format->getDefaultLocationsToSearch();
  if (extra_path.isNotEmpty()) search_path.add(juce::File(extra_path));

  data_directory_.createDirectory();  // pedal + work files need a home
  {
    const juce::ScopedLock lock(status_lock_);
    current_name_.clear();
    crashed_.clear();
    scan_error_.clear();
  }
  scan_progress_.store(0.0f);
  scanning_.store(true);
  scan_thread_ = std::make_unique<ScanThread>(*this, search_path);
  scan_thread_->startThread();
}

juce::var PluginHostService::getScanStatusVar() const {
  auto* status = new juce::DynamicObject();
  status->setProperty("scanning", scanning_.load());
  status->setProperty("progress", (double)scan_progress_.load());
  {
    const juce::ScopedLock lock(status_lock_);
    status->setProperty("current", current_name_);
    juce::Array<juce::var> crashed;
    for (const auto& name : crashed_) crashed.add(name);
    status->setProperty("crashed", juce::var(crashed));
    status->setProperty("crashedCount", crashed_.size());
    status->setProperty("error", scan_error_);
  }
  status->setProperty("count", known_plugins_.getNumTypes());
  status->setProperty("blacklistCount",
                      known_plugins_.getBlacklistedFiles().size());
  status->setProperty("outOfProcess", !scan_worker_command_.isEmpty());
  return juce::var(status);
}

}  // namespace celestrian
