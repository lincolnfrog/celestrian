/**
 * bridge_http.js — the engine e2e's bridge: a request whose connection
 * drops is sent again only when sending it twice changes nothing. A
 * QUERY (protocol.js `read`) is asked again; a VERB is sent once — the
 * first send may have reached the engine before its answer was lost, and
 * a second would apply it twice — and answers null.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, control } from '../bridge_http.js';
import { READ_METHODS, BOOL_METHODS, VOID_METHODS } from '../protocol.js';

/** A server that drops the first `drops` requests of each call, then
 * answers `result`. Records every request it was sent. */
function server({ drops = 0, result = true } = {}) {
    const sent = [];
    let left = drops;
    globalThis.fetch = async (path, init) => {
        sent.push({ path, ...JSON.parse(init.body) });
        if (left > 0) {
            left--;
            throw new TypeError('connection dropped');
        }
        return { ok: true, json: async () => ({ result }) };
    };
    return sent;
}

const quietly = async run => {
    const warn = console.warn;
    console.warn = () => {};
    try { return await run(); } finally { console.warn = warn; }
};

test('a query whose connection drops is asked again, and answers', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const sent = server({ drops: 1, result: { nodes: [] } });
    const answer = callNative('getGraphState');
    for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(200);
    }
    assert.deepEqual(await answer, { nodes: [] });
    assert.deepEqual(sent.map(r => r.name), ['getGraphState', 'getGraphState']);
});

test('a verb whose connection drops is NOT sent again: it answers null, sent once', async () => {
    for (const verb of ['deleteNode', 'undo', 'startRecordingInNode', 'toggleMute',
                        'togglePlayback', 'setNodeGain', 'createNode', 'nativeLog']) {
        const sent = server({ drops: 1 });
        assert.equal(await quietly(() => callNative(verb, 'a')), null, verb);
        assert.equal(sent.length, 1, `${verb} was sent once`);
    }
});

test('only queries are marked read: no verb that answers whether it applied, none nothing can refuse', () => {
    for (const name of READ_METHODS) {
        assert.ok(!BOOL_METHODS.has(name) && !VOID_METHODS.has(name), name);
    }
});

test('an answered call is its result; a server with no result answers null', async () => {
    server({ result: false });
    assert.equal(await callNative('deleteNode', 'a'), false, 'a refusal is an answer');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    assert.equal(await callNative('deleteNode', 'a'), null);
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    assert.equal(await quietly(() => callNative('deleteNode', 'a')), null);
});

test('the test clock: an op that moves the engine is sent once; one that leaves it the same is sent again', async t => {
    const moved = server({ drops: 1 });
    await assert.rejects(control('advance', { samples: 512 }), /connection dropped/);
    assert.equal(moved.length, 1, 'a second advance would run the clock twice');

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const read = server({ drops: 1, result: undefined });
    const status = control('status');
    for (let i = 0; i < 3; i++) {
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(200);
    }
    await status;
    assert.deepEqual(read.map(r => r.op), ['status', 'status']);
});
