/**
 * JUCE native bridge (production backend).
 *
 * JUCE injects `window.__JUCE__.backend` at document start. It is an
 * event bus — addEventListener / removeEventListener / emitEvent /
 * emitByBackend — and carries no native functions of its own: a native
 * function is INVOKED by emitting '__juce__invoke' and ANSWERS with a
 * '__juce__complete' event. The functions those names reach are the C++
 * table in src/bridge_dispatch.cc plus the window verbs bound in
 * src/main_component.cc; ui/js/protocol.js is the canonical list and
 * ui/js/tests/protocol_contract.test.mjs enforces it.
 *
 * Only backend.js imports this module (the single backend facade); app
 * code never talks to it directly.
 */

import { QUIET_POLLS } from './protocol.js';

// FIELD-NAME CONTRACT (JUCE's own wire protocol, asymmetric): the invoke
// event carries the call's id as `resultId`; the completion event echoes
// it back as `promiseId`.
const INVOKE_EVENT = '__juce__invoke';
const COMPLETE_EVENT = '__juce__complete';

// A heartbeat poll whose answer never comes resolves null after this,
// so the poll loop asks again instead of waiting forever. No other verb
// has a deadline: a chooser verb answers when the user closes its
// dialog, and a slow verb answers when it is done.
const HEARTBEAT_TIMEOUT_MS = 1000;

const pendingCalls = new Map();  // resultId → { resolve, timer }
let nextResultId = 0;
let linkedBackend = null;        // the backend whose completions are heard

/**
 * Debug log fan-out: writes `m` to the browser console and, through the
 * `nativeLog` bridge method, to the C++ log. (The status strip's log
 * line in app.js is the user-facing surface; this is developer output.)
 */
export function log(m) {
    console.log("[Celestrian] " + m);
    callNative('nativeLog', m);
}

function settle(resultId, value) {
    const call = pendingCalls.get(resultId);
    if (!call) return;
    pendingCalls.delete(resultId);
    clearTimeout(call.timer);
    call.resolve(value);
}

/**
 * The injected backend with its completion listener attached, or null
 * while JUCE has injected none. The listener is attached once per
 * backend, the first time this sees it — at module load when JUCE is
 * already there, otherwise by the first call that finds it — so no call
 * is ever sent before its answer can be heard.
 */
function linkBridge() {
    const juce = window.__JUCE__;
    const backend = juce && juce.backend;
    if (!backend || typeof backend.emitEvent !== 'function' ||
        typeof backend.addEventListener !== 'function') return null;
    if (backend !== linkedBackend) {
        backend.addEventListener(COMPLETE_EVENT,
            done => settle(done.promiseId, done.result));
        linkedBackend = backend;
        log('Bridge linked.');
    }
    return backend;
}

/**
 * Invoke a native bridge method; resolves with its answer.
 *
 * CONTRACT: this function never rejects. With no bridge object, or one
 * that cannot send, it resolves `null`; so does a heartbeat poll
 * (protocol.js QUIET_POLLS) left unanswered for HEARTBEAT_TIMEOUT_MS.
 * Callers must treat `null` as "bridge unavailable / call lost", not as
 * a method's return value.
 */
export function callNative(name, ...args) {
    return new Promise(resolve => {
        const resultId = nextResultId++;
        pendingCalls.set(resultId, { resolve, timer: null });
        try {
            const backend = linkBridge();
            if (!backend) { settle(resultId, null); return; }
            backend.emitEvent(INVOKE_EVENT, { name, params: args, resultId });
        } catch (err) {
            // console, not log(): log() is itself a bridge call.
            console.warn(`[Bridge] ${name} was not sent: ${err.message}`);
            settle(resultId, null);
            return;
        }
        const call = pendingCalls.get(resultId);
        if (call && QUIET_POLLS.has(name)) {
            call.timer = setTimeout(() => settle(resultId, null),
                                    HEARTBEAT_TIMEOUT_MS);
        }
    });
}

linkBridge();

// Catch all errors
window.addEventListener('error', (e) => {
    log(`JS Error: ${e.message} at ${e.filename}:${e.lineno}`);
});
