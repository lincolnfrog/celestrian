#pragma once

/**
 * THE BRIDGE TABLE — the UI protocol (ui/js/protocol.js) as data, GUI-free.
 *
 * Every protocol method the engine can answer WITHOUT a window lives in
 * engineMethods(): one name → one handler. Two hosts consume the table:
 *
 *   - the app shell (src/main_component.cc) registers each entry on the
 *     JUCE WebBrowserComponent (withNativeFunction) and adds the handful
 *     of window-bound verbs on top (file choosers, plugin editors, the
 *     pointer warp);
 *   - the HEADLESS ENGINE SERVER (src/headless/headless_main.cc) serves
 *     the same entries over HTTP so the REAL UI, in a real browser
 *     driven by Playwright, talks to the REAL engine — the end-to-end
 *     seam the mock can never be (docs/test_harness.md "Engine e2e").
 *
 * The protocol contract test (ui/js/tests/protocol_contract.test.mjs)
 * parses the `voidMethod("…"` / `valueMethod("…"` registrations here
 * together with main_component.cc's withNativeFunction ones: the union
 * must equal protocol.js exactly.
 */

#include <juce_core/juce_core.h>

#include <functional>
#include <utility>
#include <vector>

#include "audio_engine.h"
#include "plugin_host_service.h"
#include "project_manager.h"

namespace celestrian::bridge {

/** Completes a call with its result (JUCE's NativeFunctionCompletion
 * shape). Handlers may complete synchronously or later. */
using Completion = std::function<void(juce::var)>;
using Handler = std::function<void(const juce::Array<juce::var>&, Completion)>;

struct Method {
  juce::String name;
  Handler handler;
};

/** What the handlers reach: the engine and its two message-thread
 * services. Held by reference — the host outlives every call. */
struct Services {
  AudioEngine& engine;
  ProjectManager& projects;
  PluginHostService& plugins;
};

/** Traces a bridge invocation, DEBUG builds only (the polls are exempt —
 * getGraphState / getProjectInfo are the UI's heartbeat, not events). */
void logCall(const char* name);

/** A handler that traces, runs fn(args) only when at least `min_args`
 * arrived, and always completes with true. */
template <typename Fn>
Method voidMethod(const char* name, int min_args, Fn fn) {
  return {name, [name, min_args, fn = std::move(fn)](
                    const juce::Array<juce::var>& args, Completion done) {
            logCall(name);
            if (args.size() >= min_args) fn(args);
            done(true);
          }};
}

/** A handler that completes with fn(args), or with `missing` when fewer
 * than `min_args` arrived. */
template <typename Fn>
Method valueMethod(const char* name, int min_args, Fn fn,
                   juce::var missing = juce::var()) {
  return {name, [name, min_args, fn = std::move(fn), missing = std::move(missing)](
                    const juce::Array<juce::var>& args, Completion done) {
            logCall(name);
            if (args.size() >= min_args)
              done(fn(args));
            else
              done(missing);
          }};
}

/** The GUI-free protocol surface. */
std::vector<Method> engineMethods(Services s);

/** A QTime rational from a bridge argument: a [num, den] array, or a
 * bare number taken as whole Qs. */
std::pair<int64_t, int64_t> qtimeArg(const juce::var& v);

}  // namespace celestrian::bridge
