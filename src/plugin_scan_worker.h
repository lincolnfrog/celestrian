#pragma once

#include <juce_core/juce_core.h>

namespace celestrian {

/**
 * OUT-OF-PROCESS PLUGIN SCANNING (docs/vst3.md §4): the
 * worker half. A scan never loads plugin code in the app process:
 * PluginHostService (the coordinator) enumerates candidate files
 * itself, then re-launches its own executable as
 *
 *     <exe> --scan-worker <list file> <results file>
 *
 * which probes each listed file and appends protocol lines to the
 * results file, flushing after every line:
 *
 *     BEGIN\t<file>            about to probe this file
 *     FOUND\t<base64 xml>      one PluginDescription (repeat per plugin)
 *     END\t<file>              probe finished cleanly
 *     DONE                     list exhausted
 *
 * A plugin that crashes the worker leaves a BEGIN with no END: the
 * coordinator blacklists that file and starts a fresh worker on the
 * remainder. A plugin that hangs leaves the file quiet: the
 * coordinator kills the worker after a timeout and treats it the same.
 * Neither can take the app down. Results go through a file rather than
 * a pipe so the coordinator can poll with a timeout instead of sitting
 * in a blocking read.
 *
 * Both the app (main.cc) and CelestrianTests (test_runner.cc) carry the
 * flag, so tests exercise the real machinery on their own binary.
 */
namespace scan_worker {

inline constexpr const char* kFlag = "--scan-worker";

inline constexpr const char* kBegin = "BEGIN\t";
inline constexpr const char* kFound = "FOUND\t";
inline constexpr const char* kEnd = "END\t";
inline constexpr const char* kDone = "DONE";

/** Worker exit codes chosen by the worker itself. A crash yields
 * 128 + signal (the worker's handler) or a platform fault code —
 * never one of these. */
enum ExitCode {
  kOk = 0,
  kBadArgs = 64,
  kUnreadableList = 65,
};

/** TEST HOOK: when this environment variable is set, the worker sleeps
 * forever instead of probing any file whose path contains its value —
 * the stand-in for a plugin that hangs during instantiation. */
inline constexpr const char* kHangOnEnvVar = "CELESTRIAN_SCAN_WORKER_HANG_ON";

/** True when `args` (the process's parameters, program name excluded)
 * asks for worker mode. */
bool isWorkerInvocation(const juce::StringArray& args);

/** Runs the worker for `--scan-worker <list> <results>` (args exclude
 * the program name). Installs crash-signal handlers that end the
 * process with 128 + signal (no crash-reporter dialog per bad plugin),
 * probes every file in the list, returns an ExitCode. Needs a
 * MessageManager to exist (callers create one). */
int run(const juce::StringArray& args);

/** The probe itself, exposed for the protocol unit test: appends the
 * lines for `files` to `results` and returns kOk. */
int probeFiles(const juce::StringArray& files, const juce::File& results);

}  // namespace scan_worker
}  // namespace celestrian
