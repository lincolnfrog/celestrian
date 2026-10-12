/**
 * Audio file import (docs/import.md). Where a file lands — a first take
 * on the nearest Q line to the origin the view names, a new take of a
 * committed slot, a clip child of a stack — is held to the engine by
 * the differential suite (ui/differential/ import/*). Here, the mock's
 * own: the recorder the page specs read (what was asked, the form it
 * took, the clip it landed on), the dialog verb, the refusals with no
 * journey. Plus the pure drop-gesture pieces (import_drop.js): Q
 * placement from the pointer and the path a File exposes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, loadScenario } from '../mock_backend.js';
import { getLastImport, resetLastImport, DIALOG_PATH } from '../mock/import.js';
import { state, findNode } from '../mock/state.js';
import { dragHasFiles, dropFrameQ, filePathOf } from '../import_drop.js';
import { MOCK_Q } from './helpers.mjs';
import { underLiveTake } from './mock_scene.mjs';

test('the import recorder: what was asked, the form it took, the clip it landed on', async () => {
    loadScenario('stack-with-clips');
    resetLastImport();
    // An empty clip: a first take, recorded as asked.
    const id = await callNative('createNode', 'clip', '');
    const path = '/audio/pad.wav#len=' + 2 * MOCK_Q;
    const origin = state.islandZero + 3 * MOCK_Q;
    assert.equal(await callNative('importAudio', id, path, origin), true);
    assert.deepEqual(getLastImport(),
        { uuid: id, path, origin, form: 'first', targetId: id });
    // A committed slot: a new take.
    assert.equal(await callNative('importAudio', 'clip-1', '/audio/alt.wav', 0), true);
    assert.equal(getLastImport().form, 'take');
    // A stack: the request names the stack, the target is the clip it
    // grew, named after the file.
    assert.equal(await callNative('importAudio', 'stack-1', '/audio/Vocal Take.wav', origin), true);
    const last = getLastImport();
    assert.equal(last.uuid, 'stack-1');
    const child = findNode(last.targetId);
    assert.equal(child.type, 'clip');
    assert.equal(child.name, 'Vocal Take');
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
    await underLiveTake(async () => {
        assert.equal(await callNative('importAudio', 'clip-1', '/audio/x.wav', 0), false);
        assert.equal(await callNative('importAudioWithDialog', 'clip-1', 0), false);
        assert.equal(getLastImport(), null);
    });
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
