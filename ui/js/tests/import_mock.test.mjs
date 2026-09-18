/**
 * Audio file import (docs/import.md) — the mock twin of
 * tests/import_tests.cc, observably: the verbs record the request,
 * refuse under a live take, place a first take on the nearest Q
 * boundary to the absolute origin the view names (docs/frame.md), cut
 * a new take onto a committed slot, and grow a stack a clip child
 * named after the file. Plus the pure drop-gesture pieces
 * (import_drop.js): Q placement from the pointer and the path a File
 * exposes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, loadScenario } from '../mock_backend.js';
import { getLastImport, resetLastImport, DIALOG_PATH } from '../mock/import.js';
import { state, findNode } from '../mock/state.js';
import { dragHasFiles, dropFrameQ, filePathOf } from '../import_drop.js';
import { nodeById, MOCK_Q } from './helpers.mjs';

/** A fresh empty clip in the loaded scenario; answers its id. */
async function emptyClip() {
    await callNative('createNode', 'clip', '');
    const s = await callNative('getGraphState');
    return s.nodes[s.nodes.length - 1].id;
}

test('a first take lands on the nearest Q boundary to the named origin, hysteresis-snapped', async () => {
    loadScenario('single-clip');            // Q = 2 s (the sole clip defines it)
    resetLastImport();
    const Q = 2 * MOCK_Q;
    const id = await emptyClip();
    // The view names 1.5Q past the zero (a drop mid-lane, docs/frame.md);
    // that rounds to the 2Q boundary; the file is 2.1Q long → snaps to 2Q.
    const path = '/audio/pad.wav#len=' + Math.round(2.1 * Q);
    const origin = state.islandZero + 1.5 * Q;
    assert.equal(await callNative('importAudio', id, path, origin), true);
    const n = findNode(id);
    assert.equal(n.origin, state.islandZero + 2 * Q);
    assert.equal(n.duration, 2 * Q);
    assert.equal(n.takes.length, 1);
    assert.deepEqual(getLastImport(),
        { uuid: id, path, origin, form: 'first', targetId: id });
});

test('a pre-Q import defines Q from the file length; the clock is the origin', async () => {
    loadScenario('empty');
    resetLastImport();
    const id = await emptyClip();
    const len = 3 * MOCK_Q;
    assert.equal(await callNative('importAudio', id, '/audio/seed.wav#len=' + len, 0), true);
    assert.equal(state.islandQ, len);
    assert.equal(findNode(id).duration, len);
    assert.equal(findNode(id).origin, state.islandZero, 'the first take is the zero');
});

test('a committed slot takes a NEW TAKE, active on arrival', async () => {
    loadScenario('stack-with-clips');
    resetLastImport();
    const before = nodeById('clip-1', (await callNative('getGraphState')).nodes);
    assert.equal(await callNative('importAudio', 'clip-1', '/audio/alt.wav', 0), true);
    const after = nodeById('clip-1', (await callNative('getGraphState')).nodes);
    assert.equal(after.takes, 2);
    assert.equal(after.activeTake, 1);
    assert.equal(after.duration, before.duration, 'the slot period stands');
    assert.equal(getLastImport().form, 'take');
    // Undoable: ⌘Z removes the take.
    await callNative('undo');
    assert.equal(nodeById('clip-1', (await callNative('getGraphState')).nodes).takes, 1);
});

test('a stack target gains a clip child named after the file', async () => {
    loadScenario('stack-with-clips');
    resetLastImport();
    const origin = state.islandZero + state.islandQ;
    assert.equal(await callNative('importAudio', 'stack-1', '/audio/Vocal Take.wav', origin), true);
    const last = getLastImport();
    assert.equal(last.uuid, 'stack-1');
    assert.notEqual(last.targetId, 'stack-1');
    const child = findNode(last.targetId);
    assert.equal(child.type, 'clip');
    assert.equal(child.name, 'Vocal Take');
    assert.equal(child.origin, origin, 'placed where the view named');
    assert.equal(findNode('stack-1').nodes.some(n => n.id === child.id), true);
});

test('the dialog verb records the dialog placeholder path', async () => {
    loadScenario('single-clip');
    resetLastImport();
    assert.equal(await callNative('importAudioWithDialog', 'mock-root', state.islandZero), true);
    assert.equal(getLastImport().path, DIALOG_PATH);
    assert.equal(getLastImport().uuid, 'mock-root');
});

test('a live take refuses both verbs and records nothing', async () => {
    loadScenario('single-clip');
    resetLastImport();
    const id = await emptyClip();
    await callNative('startRecordingInNode', id);
    assert.ok(nodeById(id, (await callNative('getGraphState')).nodes).isRecording);
    assert.equal(await callNative('importAudio', 'clip-1', '/audio/x.wav', 0), false);
    assert.equal(await callNative('importAudioWithDialog', 'clip-1', 0), false);
    assert.equal(getLastImport(), null);
    await callNative('stopRecordingInNode', id);
});

test('a MIDI track and an unreadable file refuse', async () => {
    loadScenario('midi-clip');
    resetLastImport();
    assert.equal(await callNative('importAudio', 'midi-1', '/audio/x.wav', 0), false);
    assert.equal(await callNative('importAudio', 'seed', '/audio/x.missing', 0), false);
    assert.equal(getLastImport(), null);
});

test('dropFrameQ: pointer fraction × cycle, whole Q, clamped', () => {
    assert.equal(dropFrameQ(0.5, 4), 2);
    assert.equal(dropFrameQ(0.3, 4), 1);
    assert.equal(dropFrameQ(0.9, 4), 4);
    assert.equal(dropFrameQ(-0.2, 4), 0);
    assert.equal(dropFrameQ(1.5, 4), 4);
    assert.equal(dropFrameQ(0.5, 0), 0);    // no frame yet
    assert.equal(dropFrameQ(NaN, 4), 0);
});

test('dragHasFiles reads the Files type; filePathOf needs a real path', () => {
    assert.equal(dragHasFiles({ types: ['Files'] }), true);
    assert.equal(dragHasFiles({ types: ['text/plain'] }), false);
    assert.equal(dragHasFiles(null), false);
    assert.equal(filePathOf({ name: 'kick.wav' }), '');
    assert.equal(filePathOf({ name: 'kick.wav', path: 'kick.wav' }), '');
    assert.equal(filePathOf({ name: 'kick.wav', path: '/tmp/kick.wav' }), '/tmp/kick.wav');
    assert.equal(filePathOf(null), '');
});
