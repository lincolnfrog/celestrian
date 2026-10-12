#pragma once

/**
 * THE BRIDGE TABLE — the UI protocol (ui/js/protocol.js) as data, GUI-free.
 *
 * Every protocol method the engine can answer WITHOUT a window lives in
 * engineMethods(): one name → one handler. Two hosts consume the table:
 *
 *   - the app shell (src/main_component.cc) registers each entry on the
 *     JUCE WebBrowserComponent and binds the window verbs on top (file
 *     choosers, plugin editors, the pointer warp);
 *   - the HEADLESS ENGINE SERVER (src/headless/headless_main.cc) serves
 *     the same entries over HTTP, so the real UI in a real browser
 *     talks to the real engine (docs/test_harness.md "Engine e2e").
 *
 * ADDING A METHOD takes the C++ logic, an entry in bridge_dispatch.cc (a
 * `bindWindowVerb` in main_component.cc when it needs a window), its row
 * in protocol.js and a mock handler. A name with no registration leaves
 * the page's promise hanging forever; the protocol contract test
 * (ui/js/tests/protocol_contract.test.mjs) parses the registrations of
 * both C++ files — their union must equal protocol.js exactly.
 *
 * THE ENTRY'S KIND IS ITS ANSWER, and protocol.js declares the same one:
 *   boolMethod   a verb that can be refused answers whether it applied —
 *                false: refused, nothing changed (the status line says
 *                so instead of announcing the verb);
 *   valueMethod  the value the page reads;
 *   voidMethod   a knob or a notification nothing can refuse: answered
 *                `true` once it ran.
 *
 * AN ANSWER MAY COME LATER: a handler completes its call at once or from
 * a later message-thread callback (boolMethod's DeferredFn form — a
 * plugin still instantiating). A host keeps the completion it handed
 * over valid until it is called.
 */

#include <juce_core/juce_core.h>

#include <cstdint>
#include <functional>
#include <optional>
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

/** A handler for a verb that can be refused: completes with whether
 * fn(args) applied it, and with false when fewer than `min_args`
 * arrived. */
template <typename Fn>
Method boolMethod(const char* name, int min_args, Fn fn) {
  return valueMethod(
      name, min_args,
      [fn = std::move(fn)](const juce::Array<juce::var>& args) {
        return juce::var((bool)fn(args));
      },
      juce::var(false));
}

/** What a verb whose outcome arrives later answers with: called exactly
 * once, with whether the verb applied. */
using Answer = std::function<void(bool)>;
/** The body of such a verb: fn(args, answer) owes one answer(applied),
 * at once or from a later message-thread callback. */
using DeferredFn =
    std::function<void(const juce::Array<juce::var>&, Answer)>;

/** boolMethod for a verb that answers later (pass the body as a
 * DeferredFn). Completes with false at once when fewer than `min_args`
 * arrived. */
inline Method boolMethod(const char* name, int min_args, DeferredFn fn) {
  return {name, [name, min_args, fn = std::move(fn)](
                    const juce::Array<juce::var>& args, Completion done) {
            logCall(name);
            if (args.size() < min_args) {
              done(false);
              return;
            }
            fn(args, [done = std::move(done)](bool applied) { done(applied); });
          }};
}

// --- Optional arguments (those past a method's `min_args`) ---

/** Argument `i` as text; empty when the page sent none. */
inline juce::String strArg(const juce::Array<juce::var>& args, int i) {
  return i < args.size() ? args[i].toString() : juce::String();
}

/** Argument `i` as a sample count; nullopt when absent or void. */
inline std::optional<int64_t> optSamples(const juce::Array<juce::var>& args,
                                         int i) {
  if (i >= args.size() || args[i].isVoid()) return std::nullopt;
  return (int64_t)(double)args[i];
}

/** Argument `i` as a flag; false when absent. */
inline bool flagArg(const juce::Array<juce::var>& args, int i) {
  return i < args.size() && (bool)args[i];
}

/** The GUI-free protocol surface. */
std::vector<Method> engineMethods(Services s);

// --- What a host needs beside the table ---

/** The load-time revival sweep (docs/vst3.md §6): every placeholder
 * slot in the graph whose plugin the registry knows gets a live
 * instance, swapped in as it arrives; the others stay placeholders. A
 * host hands this to AudioEngine::setOnSessionLoaded. Message thread. */
void revivePlaceholders(Services s);

/** Node `uuid`'s record in a getGraphState tree; void when absent. */
juce::var findNodeVar(const juce::var& tree, const juce::String& uuid);

/** The content type a host serves a UI file under, by its extension. */
juce::String mimeFor(const juce::File& file);

}  // namespace celestrian::bridge
