/**
 * bridge.js — the production transport, driven through a fake of the
 * object JUCE injects. JUCE's `window.__JUCE__.backend` is an event bus
 * and nothing else (juce_WebBrowserComponent.cpp, `class Backend`): a
 * native function is invoked by emitting '__juce__invoke' {name, params,
 * resultId} and answers with a '__juce__complete' event {promiseId,
 * result}. The laws pinned here:
 *   - a call resolves with its completion's result;
 *   - a verb that waits on the user (a native dialog) has no deadline;
 *   - the completion listener exists before any call can be answered;
 *   - the heartbeat polls (protocol.js QUIET_POLLS) print nothing and
 *     are the only calls with a deadline;
 *   - callNative never rejects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { QUIET_POLLS, BRIDGE_METHOD_NAMES } from '../protocol.js';

const INVOKE = '__juce__invoke';
const COMPLETE = '__juce__complete';

/** JUCE's injected `Backend`: these four methods, no native functions. */
class FakeBackend {
    constructor() {
        this.listeners = new Map();  // eventId → Map(listener id → fn)
        this.nextListenerId = 0;
    }

    addEventListener(eventId, fn) {
        if (!this.listeners.has(eventId)) this.listeners.set(eventId, new Map());
        const id = this.nextListenerId++;
        this.listeners.get(eventId).set(id, fn);
        return [eventId, id];
    }

    removeEventListener([eventId, id]) {
        if (this.listeners.has(eventId)) this.listeners.get(eventId).delete(id);
    }

    emitEvent(eventId, object) {
        window.__JUCE__.postMessage(JSON.stringify({ eventId, payload: object }));
    }

    emitByBackend(eventId, object) {
        const heard = this.listeners.get(eventId);
        if (!heard) return;
        for (const fn of heard.values()) fn(JSON.parse(object));
    }

    listenerCount(eventId) {
        return this.listeners.has(eventId) ? this.listeners.get(eventId).size : 0;
    }
}

/**
 * Install a fake JUCE on `window`. `natives` maps a function name to
 * `(...params) => result | Promise<result>` — the native side, which
 * completes whenever that settles. A name with no entry is invoked and
 * never completed. Returns the backend and the invocations it received.
 */
function installJuce(natives = {}) {
    const backend = new FakeBackend();
    const invoked = [];
    window.__JUCE__ = {
        backend,
        postMessage(text) {
            const { eventId, payload } = JSON.parse(text);
            if (eventId !== INVOKE) return;
            invoked.push(payload);
            const fn = natives[payload.name];
            if (!fn) return;
            Promise.resolve(fn(...payload.params)).then(result =>
                backend.emitByBackend(COMPLETE, JSON.stringify(
                    { promiseId: payload.resultId, result })));
        },
    };
    return { backend, invoked };
}

/** Run `fn` with console.log captured; answers the printed lines. */
async function capturingLog(fn) {
    const lines = [];
    const real = console.log;
    console.log = (...a) => { lines.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.log = real; }
    return lines;
}

/** A turn of the event loop: every settled promise has run its chain. */
const settled = () => new Promise(resolve => setImmediate(resolve));

globalThis.window = { addEventListener() {} };

// One module instance per boot order: JUCE there before the page's
// modules run (the app), and JUCE arriving after them.
const atLoad = installJuce({ nativeLog: () => true });
const early = await import('../bridge.js?juce-at-load');
const listenersAtLoad = atLoad.backend.listenerCount(COMPLETE);
delete window.__JUCE__;
const late = await import('../bridge.js?juce-after-load');

test('QUIET_POLLS names the two heartbeat polls, both real protocol methods', () => {
    assert.deepEqual([...QUIET_POLLS].sort(), ['getGraphState', 'getProjectInfo']);
    for (const m of QUIET_POLLS) assert.ok(BRIDGE_METHOD_NAMES.includes(m), m);
});

test('the completion listener is registered when the module loads', () => {
    assert.equal(listenersAtLoad, 1);
});

test('a call is one __juce__invoke and resolves with its __juce__complete result', async () => {
    const { invoked } = installJuce({
        nativeLog: () => true,
        ping: () => 'pong',
        combineNodes: (dragged, target) => `${dragged}+${target}`,
        getInputList: () => ({ inputs: ['In 1', 'In 2'] }),
    });
    assert.equal(await early.callNative('ping'), 'pong');
    assert.equal(await early.callNative('combineNodes', 'a', 'b'), 'a+b');
    assert.deepEqual(await early.callNative('getInputList'),
        { inputs: ['In 1', 'In 2'] });
    const calls = invoked.filter(i => i.name !== 'nativeLog');
    assert.deepEqual(calls.map(i => [i.name, i.params]),
        [['ping', []], ['combineNodes', ['a', 'b']], ['getInputList', []]]);
    assert.equal(new Set(calls.map(i => i.resultId)).size, 3,
        'each call carries its own resultId');
});

test('calls in flight together each get their own answer, in any order', async () => {
    const release = {};
    installJuce({
        nativeLog: () => true,
        slow: () => new Promise(r => { release.slow = r; }),
        fast: () => 'fast',
    });
    const slow = early.callNative('slow');
    assert.equal(await early.callNative('fast'), 'fast');
    release.slow('slow');
    assert.equal(await slow, 'slow');
});

test('a verb that waits on the user resolves with its real answer, however long that takes', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const DIALOG_OPEN_MS = 60000;
    installJuce({
        nativeLog: () => true,
        loadSession: () => new Promise(r => setTimeout(() => r(true), DIALOG_OPEN_MS)),
    });
    let answer = 'pending';
    early.callNative('loadSession', '').then(v => { answer = v; });
    t.mock.timers.tick(DIALOG_OPEN_MS - 1);
    await settled();
    assert.equal(answer, 'pending', 'no answer while the dialog is open');
    t.mock.timers.tick(1);
    await settled();
    assert.equal(answer, true);
});

test('a call made the moment JUCE appears is answered (no wait for a listener)', async () => {
    installJuce({ nativeLog: () => true, ping: () => 'pong' });
    const lines = await capturingLog(async () => {
        assert.equal(await late.callNative('ping'), 'pong');
    });
    assert.ok(lines.some(l => l.includes('Bridge linked')), 'the link is announced once');
    assert.equal(window.__JUCE__.backend.listenerCount(COMPLETE), 1);
    await late.callNative('ping');
    assert.equal(window.__JUCE__.backend.listenerCount(COMPLETE), 1,
        'one listener per backend, however many calls');
});

test('the heartbeat polls print nothing', async () => {
    installJuce({
        nativeLog: () => true,
        getGraphState: () => ({ nodes: [], isPlaying: true }),
        getProjectInfo: () => ({ id: 'p', born: true }),
    });
    await early.callNative('nativeLog', 'link');  // the link line, out of the way
    const lines = await capturingLog(async () => {
        assert.deepEqual(await early.callNative('getGraphState'),
            { nodes: [], isPlaying: true });
        assert.deepEqual(await early.callNative('getProjectInfo'), { id: 'p', born: true });
    });
    assert.deepEqual(lines, []);
});

test('a heartbeat poll that is never answered resolves null; its late answer is dropped', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { backend, invoked } = installJuce({ nativeLog: () => true });
    let answer = 'pending';
    early.callNative('getGraphState').then(v => { answer = v; });
    await settled();
    assert.equal(answer, 'pending');
    t.mock.timers.tick(60000);
    await settled();
    assert.equal(answer, null);
    const poll = invoked.find(i => i.name === 'getGraphState');
    backend.emitByBackend(COMPLETE, JSON.stringify(
        { promiseId: poll.resultId, result: { nodes: [] } }));
    assert.equal(answer, null);
});

test('callNative never rejects: no bridge, or a bridge that cannot send, answers null', async () => {
    delete window.__JUCE__;
    assert.equal(await early.callNative('ping'), null);
    installJuce();
    window.__JUCE__.postMessage = () => { throw new Error('webview gone'); };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
        assert.equal(await early.callNative('ping'), null);
    } finally {
        console.warn = realWarn;
    }
});
