#include "plugin_scan_worker.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <csignal>
#include <cstdlib>
#include <memory>

namespace celestrian {
namespace scan_worker {

namespace {

/** A crashing probe must end this process abruptly — the results file
 * keeps its BEGIN without an END, which is the crash fingerprint the
 * coordinator reads. The handler only swaps the OS's crash bookkeeping
 * (a "quit unexpectedly" dialog per bad plugin on macOS, core dumps on
 * Linux) for a plain non-zero exit; nothing between the fault and
 * process death runs. _Exit is async-signal-safe. */
[[noreturn]] void dieLikeACrash(int signal_number) {
  std::_Exit(128 + signal_number);
}

void installCrashHandlers() {
  std::signal(SIGSEGV, dieLikeACrash);
  std::signal(SIGABRT, dieLikeACrash);
  std::signal(SIGILL, dieLikeACrash);
  std::signal(SIGFPE, dieLikeACrash);
#ifdef SIGBUS
  std::signal(SIGBUS, dieLikeACrash);
#endif
}

/** Appends one protocol line and flushes it to the OS: a line the
 * coordinator can see even if the very next instruction kills us. */
void emit(juce::FileOutputStream& out, const juce::String& line) {
  out.writeText(line + "\n", false, false, "\n");
  out.flush();
}

}  // namespace

bool isWorkerInvocation(const juce::StringArray& args) {
  return args.size() > 0 && args[0] == kFlag;
}

int probeFiles(const juce::StringArray& files, const juce::File& results) {
  juce::AudioPluginFormatManager formats;
  formats.addFormat(new juce::VST3PluginFormat());

  juce::FileOutputStream out(results);
  if (out.failedToOpen()) return kUnreadableList;

  const juce::String hang_on =
      juce::SystemStats::getEnvironmentVariable(kHangOnEnvVar, {});

  for (const auto& file : files) {
    if (file.trim().isEmpty()) continue;
    emit(out, kBegin + file);

    if (hang_on.isNotEmpty() && file.contains(hang_on))
      for (;;) juce::Thread::sleep(1000);  // the test's hung plugin

    juce::OwnedArray<juce::PluginDescription> found;
    for (auto* format : formats.getFormats())
      if (format->fileMightContainThisPluginType(file))
        format->findAllTypesForFile(found, file);  // <- a bad plugin dies here

    for (const auto* description : found)
      if (auto xml = description->createXml())
        emit(out, kFound + juce::Base64::toBase64(xml->toString(
                               juce::XmlElement::TextFormat().singleLine())));
    emit(out, kEnd + file);
  }
  emit(out, kDone);
  return kOk;
}

int run(const juce::StringArray& args) {
  if (args.size() < 3 || !isWorkerInvocation(args)) return kBadArgs;
  installCrashHandlers();

  // VST3 instantiation is a message-thread affair: make sure a
  // MessageManager exists (the app already has one; a console runner
  // does not).
  std::unique_ptr<juce::ScopedJuceInitialiser_GUI> runtime;
  if (juce::MessageManager::getInstanceWithoutCreating() == nullptr)
    runtime = std::make_unique<juce::ScopedJuceInitialiser_GUI>();

  const juce::File list_file{args[1]};
  const juce::File results_file{args[2]};
  if (!list_file.existsAsFile()) return kUnreadableList;

  juce::StringArray files;
  list_file.readLines(files);
  files.removeEmptyStrings();
  return probeFiles(files, results_file);
}

}  // namespace scan_worker
}  // namespace celestrian
