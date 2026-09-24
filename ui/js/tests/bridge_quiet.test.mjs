/**
 * THE HEARTBEAT STAYS QUIET (flash-chrome F12, 2026-09-22): bridge.js
 * console.logged every direct-call result — the whole getGraphState
 * object 20 times a second — and a WebView keeps every logged object
 * reachable from its console, so the production build grew memory and
 * GC pauses. The quiet polls are protocol.js QUIET_POLLS, the one list
 * the mock backend's trace uses too (the C++ bridge's twin: logCall in
 * src/bridge_dispatch.cc).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { QUIET_POLLS, BRIDGE_METHOD_NAMES } from '../protocol.js';

// bridge.js binds to the WebView at module load (a window error hook and
// an init poll): give it a stub window, and keep its poll off the node
// event loop.
const logged = [];
globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
    __JUCE__: { backend: {
        getGraphState: async () => ({ nodes: [], isPlaying: true }),
        getProjectInfo: async () => ({ id: 'p' }),
        ping: async () => 'pong',
        nativeLog: async () => null,
    } },
};
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { callNative } = await import('../bridge.js');
globalThis.setInterval = realSetInterval;

test('QUIET_POLLS names the two heartbeat polls, both real protocol methods', () => {
    assert.deepEqual([...QUIET_POLLS].sort(), ['getGraphState', 'getProjectInfo']);
    for (const m of QUIET_POLLS) assert.ok(BRIDGE_METHOD_NAMES.includes(m), m);
});

test('the direct path logs event calls but never the heartbeat polls', async () => {
    const realLog = console.log;
    console.log = (...a) => { logged.push(a.map(String).join(' ')); };
    try {
        assert.deepEqual(await callNative('getGraphState'), { nodes: [], isPlaying: true });
        assert.deepEqual(await callNative('getProjectInfo'), { id: 'p' });
        assert.equal(await callNative('ping'), 'pong');
    } finally {
        console.log = realLog;
    }
    assert.ok(!logged.some(l => l.includes('getGraphState')), 'graph poll silent');
    assert.ok(!logged.some(l => l.includes('getProjectInfo')), 'project poll silent');
    assert.ok(logged.some(l => l.includes('[ping]')), 'an event call still traces');
});
