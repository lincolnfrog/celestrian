const logArea = document.getElementById('debug-log');
const pendingCalls = new Map();
let resultIdCounter = 0;

export function log(m) {
    console.log("[Celestrian] " + m);
    callNative('native_log', m); // Route to terminal as requested
    if (!logArea) return;
    const line = document.createElement('div');
    line.style.borderBottom = "1px solid #ffffff11";
    line.style.padding = "2px 0";
    line.textContent = `> ${m}`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;

    // Prune logs
    if (logArea.children.length > 50) logArea.removeChild(logArea.firstChild);
}

export async function callNative(name, ...args) {
    const b = window.__JUCE__;

    // 1. Try Direct Function Call (Official JUCE 8 API)
    try {
        if (b && b.backend && typeof b.backend[name] === 'function') {
            return await b.backend[name](...args);
        }
    } catch (e) {
        log(`Direct call failed for ${name}: ${e.message}`);
    }

    // 2. Try Event-Based Call (Low level)
    if (b && b.backend && typeof b.backend.emitEvent === 'function') {
        return new Promise((resolve) => {
            const resultId = resultIdCounter++;
            pendingCalls.set(resultId, resolve);
            b.backend.emitEvent('__juce__invoke', { name: name, params: args, resultId: resultId });

            // Timeout to prevent hanging the loop
            setTimeout(() => {
                if (pendingCalls.has(resultId)) {
                    pendingCalls.delete(resultId);
                    resolve(null);
                }
            }, 1000);
        });
    }

    return null;
}

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
    }
}

// Global hook for JUCE bridge initialization
setInterval(() => initBridge(), 500);

// Catch all errors
window.addEventListener('error', (e) => {
    log(`JS Error: ${e.message} at ${e.filename}:${e.lineno}`);
});
