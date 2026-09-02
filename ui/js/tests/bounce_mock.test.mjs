/**
 * Bounce mock (design_language.md Q19) — mock twin of
 * tests/bounce_tests.cc, observably: the verbs record the request and
 * answer like the engine (refused under a live take), and the dialog
 * verb records the dialog placeholder path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, loadScenario } from '../mock_backend.js';
import { getLastBounce, resetLastBounce, DIALOG_PATH } from '../mock/bounce.js';
import { nodeById } from './helpers.mjs';

test('bounce records {uuid, path} and answers true', async () => {
    loadScenario('single-clip');
    resetLastBounce();
    assert.equal(getLastBounce(), null);
    assert.equal(await callNative('bounce', 'clip-1', '/tmp/song.wav'), true);
    assert.deepEqual(getLastBounce(), { uuid: 'clip-1', path: '/tmp/song.wav' });
});

test('bounceWithDialog records the dialog placeholder path', async () => {
    loadScenario('single-clip');
    resetLastBounce();
    assert.equal(await callNative('bounceWithDialog', 'clip-1'), true);
    assert.deepEqual(getLastBounce(), { uuid: 'clip-1', path: DIALOG_PATH });
});

test('a live take refuses both verbs and records nothing', async () => {
    loadScenario('single-clip');
    resetLastBounce();
    await callNative('createNode', 'clip', '');
    const state = await callNative('getGraphState');
    const armed = state.nodes[state.nodes.length - 1];
    await callNative('startRecordingInNode', armed.id);
    assert.ok(nodeById(armed.id, (await callNative('getGraphState')).nodes)
        .isRecording, 'the take is live');
    assert.equal(await callNative('bounce', 'clip-1', '/tmp/song.wav'), false);
    assert.equal(await callNative('bounceWithDialog', 'clip-1'), false);
    assert.equal(getLastBounce(), null);
    await callNative('stopRecordingInNode', armed.id);
});
