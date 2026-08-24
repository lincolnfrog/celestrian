#include "plugin_scan_worker.h"

namespace celestrian {

PluginScanWorker::PluginScanWorker() {
  format_manager_.addFormat(new juce::VST3PluginFormat());
}

PluginScanWorker::~PluginScanWorker() { cancelPendingUpdate(); }

void PluginScanWorker::handleMessageFromCoordinator(
    const juce::MemoryBlock& block) {
  if (block.isEmpty()) return;

  const std::lock_guard<std::mutex> lock(mutex_);
  if (auto results = doScan(block); !results.isEmpty()) {
    sendResults(results);
  } else {
    pending_blocks_.emplace(block);
    triggerAsyncUpdate();
  }
}

void PluginScanWorker::handleConnectionLost() {
  juce::JUCEApplicationBase::quit();
}

void PluginScanWorker::handleAsyncUpdate() {
  for (;;) {
    const std::lock_guard<std::mutex> lock(mutex_);
    if (pending_blocks_.empty()) return;
    sendResults(doScan(pending_blocks_.front()));
    pending_blocks_.pop();
  }
}

juce::OwnedArray<juce::PluginDescription> PluginScanWorker::doScan(
    const juce::MemoryBlock& block) {
  juce::MemoryInputStream stream{block, false};
  const auto format_name = stream.readString();
  const auto identifier = stream.readString();

  juce::PluginDescription description;
  description.fileOrIdentifier = identifier;
  description.uniqueId = description.deprecatedUid = 0;

  juce::AudioPluginFormat* matching_format = nullptr;
  for (auto* format : format_manager_.getFormats())
    if (format->getName() == format_name) matching_format = format;

  juce::OwnedArray<juce::PluginDescription> results;
  if (matching_format != nullptr &&
      (juce::MessageManager::getInstance()->isThisTheMessageThread() ||
       matching_format->requiresUnblockedMessageThreadDuringCreation(
           description)))
    matching_format->findAllTypesForFile(results, identifier);

  return results;
}

void PluginScanWorker::sendResults(
    const juce::OwnedArray<juce::PluginDescription>& results) {
  juce::XmlElement xml("LIST");
  for (const auto& description : results)
    xml.addChildElement(description->createXml().release());

  const auto text = xml.toString();
  sendMessageToCoordinator({text.toRawUTF8(), text.getNumBytesAsUTF8()});
}

std::unique_ptr<PluginScanWorker> maybeStartScanWorker(
    const juce::String& command_line) {
  auto worker = std::make_unique<PluginScanWorker>();
  if (worker->initialiseFromCommandLine(command_line, kScanWorkerUid))
    return worker;
  return nullptr;
}

}  // namespace celestrian
