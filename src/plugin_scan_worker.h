#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <memory>
#include <mutex>
#include <queue>

namespace celestrian {

/** The command-line handshake ID shared by the coordinator and the
 * scanner subprocess (both the app and the test runner can host the
 * worker end). */
inline constexpr const char* kScanWorkerUid = "celestrianscanworker";

/**
 * The scanner subprocess (docs/vst3.md §4): probes one plugin file per
 * request from the coordinator, so a plugin that crashes during load
 * kills this process instead of the app. Follows JUCE's
 * AudioPluginHost reference (HostStartup.cpp): a probe that needs the
 * message thread is queued and re-run there via AsyncUpdater — which
 * also satisfies plugins that call main-thread-only macOS APIs while
 * they load (the 2026-08-19 field crashes).
 *
 * Protocol per request: MemoryBlock of two juce strings
 * {format name, file-or-identifier}; reply: an XML "LIST" of
 * PluginDescription elements (empty list = clean probe, no plugins).
 * The process quits when the coordinator disconnects.
 *
 * The host process must call maybeStartScanWorker() first thing at
 * startup and, when it returns a worker, run only the message loop.
 */
class PluginScanWorker : private juce::ChildProcessWorker,
                         private juce::AsyncUpdater {
 public:
  PluginScanWorker();
  ~PluginScanWorker() override;

  using juce::ChildProcessWorker::initialiseFromCommandLine;

 private:
  void handleMessageFromCoordinator(const juce::MemoryBlock& block) override;
  void handleConnectionLost() override;
  void handleAsyncUpdate() override;

  juce::OwnedArray<juce::PluginDescription> doScan(
      const juce::MemoryBlock& block);
  void sendResults(const juce::OwnedArray<juce::PluginDescription>& results);

  std::mutex mutex_;
  std::queue<juce::MemoryBlock> pending_blocks_;
  juce::AudioPluginFormatManager format_manager_;
};

/** Non-null when `command_line` is a scanner-subprocess launch: the
 * connected worker, which the caller keeps alive while the message
 * loop runs. Null means normal startup. */
std::unique_ptr<PluginScanWorker> maybeStartScanWorker(
    const juce::String& command_line);

}  // namespace celestrian
