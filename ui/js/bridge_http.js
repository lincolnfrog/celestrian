/**
 * HTTP bridge — the REAL engine over the wire (docs/test_harness.md
 * "Engine e2e").
 *
 * src/headless/headless_main.cc serves the same bridge table the JUCE
 * WebView registers (src/bridge_dispatch.cc) as `POST /call`, plus a
 * `POST /control` surface for the test clock (pause / advance / input /
 * the audible-truth probe). This module is bridge.js's twin for that
 * server: `?engine=true` selects it in backend.js, and Playwright talks
 * to the engine through `window.__celestrianTest.engine`.
 *
 * Same contract as bridge.js: callNative never rejects — any transport
 * failure resolves to `null`.
 */

async function post(path, body) {
    const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
}

export async function callNative(name, ...args) {
    try {
        const res = await post('/call', { name, args });
        return res && res.result !== undefined ? res.result : null;
    } catch (e) {
        console.warn(`[EngineBridge] ${name} failed: ${e.message}`);
        return null;
    }
}

export function log(m) {
    console.log('[Celestrian] ' + m);
    try { callNative('nativeLog', m); } catch (_) { /* never recurse */ }
}

/** The headless server's test surface: `control('advance', {samples})`,
 * `control('pause')`, `control('resume')`, `control('input', {kind,
 * freq})`, `control('status')`, `control('truth')`, `control('reset')`. */
export async function control(op, params = {}) {
    return post('/control', { op, ...params });
}
