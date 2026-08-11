/**
 * JUCE native bridge (production backend).
 *
 * Thin wrapper over the WebView bridge object JUCE injects at
 * `window.__JUCE__`. The C++ side (src/main_component.cc) registers every
 * protocol method via juce::WebBrowserComponent's withNativeFunction —
 * see ui/js/protocol.js for the canonical method list and
 * ui/js/tests/protocol_contract.test.mjs for the enforcement.
 *
 * Only backend.js imports this module (the single backend facade); app
 * code never talks to it directly.
 */

const logArea = document.getElementById('debug-log');
const pendingCalls = new Map();
let resultIdCounter = 0;

const CALL_TIMEOUT_MS = 1000;  // event-path call: resolve null after this
const INIT_POLL_MS = 500;      // how often initBridge probes for __JUCE__
const LOG_CAP = 50;            // max lines kept in the on-page debug log

/**
 * Debug log fan-out: writes `m` to (1) the browser console, (2) the C++
 * terminal via the `nativeLog` bridge method, and (3) the on-page
 * #debug-log panel when present (pruned to LOG_CAP lines).
 *
 * The nativeLog leg is failure-safe: callNative's own error path calls
 * log(), so a throwing nativeLog must be swallowed here rather than
 * re-entering log() and recursing unboundedly.
 */
export function log(m) {
    console.log("[Celestrian] " + m);
    try {
        // Route to terminal as requested. callNative resolves null (never
        // rejects) on failure, but guard the synchronous part too.
        callNative('nativeLog', m);
    } catch (_) { /* never let logging recurse into logging */ }
    if (!logArea) return;
    const line = document.createElement('div');
    line.style.borderBottom = "1px solid #ffffff11";
    line.style.padding = "2px 0";
    line.textContent = `> ${m}`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;

    // Prune logs
    if (logArea.children.length > LOG_CAP) logArea.removeChild(logArea.firstChild);
}

/**
 * Invoke a native bridge method. Two transport paths, tried in order:
 *
 *   1. DIRECT: `window.__JUCE__.backend[name](...)` — the official JUCE 8
 *      native-function API. src/main_component.cc registers all protocol
 *      methods this way (withNativeFunction), so this is the path that
 *      runs in production.
 *   2. EVENT: emitEvent('__juce__invoke', …) — JUCE's low-level internal
 *      wire protocol, kept as a fallback for bridge builds where the
 *      direct functions are not exposed.
 *
 * CONTRACT: this function never rejects. Failures — no bridge object, a
 * throwing direct call with no event path, or an event call that gets no
 * completion within CALL_TIMEOUT_MS — all resolve to `null`. Callers
 * must treat `null` as "bridge unavailable / call lost", not as a
 * method's return value.
 */
export async function callNative(name, ...args) {
    const b = window.__JUCE__;

    // 1. Try Direct Function Call (Official JUCE 8 API)
    try {
        if (b && b.backend && typeof b.backend[name] === 'function') {
            const res = await b.backend[name](...args);
            console.log(`Direct call [${name}] result:`, res);
            return res;
        }
    } catch (e) {
        log(`Direct call failed for ${name}: ${e.message}`);
    }

    // 2. Try Event-Based Call (Low level)
    if (b && b.backend && typeof b.backend.emitEvent === 'function') {
        return new Promise((resolve) => {
            const resultId = resultIdCounter++;
            pendingCalls.set(resultId, resolve);
            // FIELD-NAME CONTRACT (JUCE 8 internals, deliberately
            // asymmetric): the invoke event carries the id as `resultId`;
            // JUCE's C++ side echoes it back on '__juce__complete' as
            // `promiseId` (matched in initBridge below). Our own C++
            // (main_component.cc) registers no custom event handlers —
            // this speaks to JUCE's framework plumbing, so the names must
            // stay exactly as JUCE defines them.
            b.backend.emitEvent('__juce__invoke', { name: name, params: args, resultId: resultId });

            // Timeout to prevent hanging the loop
            setTimeout(() => {
                if (pendingCalls.has(resultId)) {
                    pendingCalls.delete(resultId);
                    resolve(null);
                }
            }, CALL_TIMEOUT_MS);
        });
    }

    return null;
}

/**
 * One-shot bridge wiring, safe to call repeatedly: once `window.__JUCE__`
 * exists it registers the '__juce__complete' listener that settles
 * event-path calls (see the field-name contract in callNative — JUCE
 * sends the invoke's `resultId` back as `promiseId`), sets the
 * `window.bridgeInited` latch, invokes `onReady` if given, and fires the
 * 'bridge-ready' window event. Until the bridge appears it is a no-op —
 * the INIT_POLL_MS interval below keeps probing, since JUCE injects
 * __JUCE__ at its own pace during page load.
 */
export function initBridge(onReady) {
    const b = window.__JUCE__;
    if (b && b.backend && !window.bridgeInited) {
        if (typeof b.backend.addEventListener === 'function') {
            b.backend.addEventListener('__juce__complete', (res) => {
                if (pendingCalls.has(res.promiseId)) {
                    pendingCalls.get(res.promiseId)(res.result);
                    pendingCalls.delete(res.promiseId);
                }
            });
        }
        window.bridgeInited = true;
        log("Bridge Linked.");
        if (onReady) onReady();
        window.dispatchEvent(new CustomEvent('bridge-ready'));
    }
}

// Global hook for JUCE bridge initialization
setInterval(() => initBridge(), INIT_POLL_MS);

// Catch all errors
window.addEventListener('error', (e) => {
    log(`JS Error: ${e.message} at ${e.filename}:${e.lineno}`);
});
