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

import { READ_METHODS } from './protocol.js';

/** How many times a request that may be sent again is sent again. */
const READ_RETRIES = 2;
const RETRY_BACKOFF_MS = 50;

/**
 * POST `body` and answer the response's JSON. A dropped connection (the
 * server busy with a long render) is sent again up to `retries` times —
 * which is safe only for a request that changes nothing: a request that
 * reached the server before its answer was lost would apply twice.
 */
async function post(path, body, retries = 0) {
    for (let attempt = 0; ; attempt++) {
        try {
            const r = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
            return r.json();
        } catch (e) {
            if (attempt >= retries) throw e;
            await new Promise(res => setTimeout(res, RETRY_BACKOFF_MS * (attempt + 1)));
        }
    }
}

/** A query (protocol.js `read`) is asked again when its answer is lost;
 * a verb is sent ONCE, and a lost one answers `null` — the caller's
 * "the engine did not answer". */
export async function callNative(name, ...args) {
    try {
        const res = await post('/call', { name, args },
            READ_METHODS.has(name) ? READ_RETRIES : 0);
        return res && res.result !== undefined ? res.result : null;
    } catch (e) {
        console.warn(`[EngineBridge] ${name} failed: ${e.message}`);
        return null;
    }
}

export function log(m) {
    console.log('[Celestrian] ' + m);
    callNative('nativeLog', m);
}

/** The control ops that leave the engine the same when sent twice. The
 * others move the clock (`advance`, `listen`, `truth`). */
const REPEATABLE_CONTROL = new Set(['status', 'pause', 'resume', 'input', 'reset']);

/** The headless server's test surface: `control('advance', {samples})`,
 * `control('pause')`, `control('resume')`, `control('input', {kind,
 * freq})`, `control('status')`, `control('truth')`, `control('reset')`.
 * Unlike callNative it rejects when the server cannot be reached. */
export async function control(op, params = {}) {
    return post('/control', { op, ...params },
        REPEATABLE_CONTROL.has(op) ? READ_RETRIES : 0);
}
