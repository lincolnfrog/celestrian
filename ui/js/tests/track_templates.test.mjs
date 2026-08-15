/**
 * Track templates (Q17 — the Q7 companion) — mock twin of
 * tests/track_template_tests.cc. Pins the library + insert contract
 * the creation menu drives:
 *
 *  - saveTrackTemplate captures structure + names + inputs from a live
 *    node (clip or group) into the library — a LIBRARY write, not a
 *    graph edit (never undoable);
 *  - listTrackTemplates publishes {name, kind, tracks} name-sorted;
 *  - createFromTrackTemplate stamps a fresh EMPTY armable copy (new
 *    ids), into a group or at top level, as ONE undoable step — a
 *    5-track group arrives and departs the undo log whole;
 *  - unknown template / bad parent refuse and record nothing;
 *  - re-saving a name overwrites (the rig-update gesture).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { clearTrackTemplates } from '../mock/track_templates.js';
import { nodeById } from './helpers.mjs';

const findN = id => nodeById(id, getState().nodes);

/** Build the 3-mic drum group live: [stackId, memberIds]. */
async function buildKit() {
    const stackId = await callNative('createNode', 'stack', '');
    await callNative('renameNode', stackId, 'Drums');
    const ids = [];
    for (let i = 0; i < 3; ++i) {
        const id = await callNative('createNode', 'clip', stackId);
        await callNative('renameNode', id, `Mic ${i + 1}`);
        await callNative('setNodeInput', id, i);
        ids.push(id);
    }
    return [stackId, ids];
}

test('save → list: structure + names + inputs, name-sorted metadata', async () => {
    loadScenario('empty');
    clearTrackTemplates();
    const [stackId] = await buildKit();
    const solo = await callNative('createNode', 'clip', '');
    await callNative('renameNode', solo, 'Guitar');
    await callNative('setNodeInput', solo, 5);

    assert.equal(await callNative('saveTrackTemplate', stackId, 'Drums'), true);
    assert.equal(await callNative('saveTrackTemplate', solo, 'Guitar'), true);
    assert.equal(await callNative('saveTrackTemplate', 'nope', 'X'), false,
        'unknown node refused');
    assert.equal(await callNative('saveTrackTemplate', solo, '   '), false,
        'blank name refused');

    const list = await callNative('listTrackTemplates');
    assert.deepEqual(list, [
        { name: 'Drums', kind: 'group', tracks: 3 },
        { name: 'Guitar', kind: 'clip', tracks: 1 },
    ], 'name-sorted, kind + leaf-count metadata');
});

test('create stamps fresh empty armable copies — named and routed', async () => {
    loadScenario('empty');
    clearTrackTemplates();
    const [stackId, memberIds] = await buildKit();
    await callNative('saveTrackTemplate', stackId, 'Drums');

    assert.equal(
        await callNative('createFromTrackTemplate', 'Drums', ''), true);
    const top = getState().nodes;
    assert.equal(top.length, 2, 'the stamped group landed at top level');
    const kit = top[1];
    assert.equal(kit.name, 'Drums', 'named on arrival');
    assert.equal(kit.nodes.length, 3, 'all mics inside');
    assert.equal(kit.nodes[2].inputChannel, 2, 'inputs routed');
    assert.equal(kit.nodes[0].duration, 0,
        'empty ⟹ armable (Q7: arm targets emptiness)');
    assert.notEqual(kit.id, stackId, 'fresh ids — a template stamps copies');
    assert.ok(!memberIds.includes(kit.nodes[0].id), 'children too');
});

test('insert into a group; ONE undo removes the whole arrival', async () => {
    loadScenario('empty');
    clearTrackTemplates();
    const solo = await callNative('createNode', 'clip', '');
    await callNative('renameNode', solo, 'Guitar');
    await callNative('setNodeInput', solo, 3);
    await callNative('saveTrackTemplate', solo, 'Guitar');
    const host = await callNative('createNode', 'stack', '');

    assert.equal(
        await callNative('createFromTrackTemplate', 'Guitar', host), true);
    assert.equal(findN(host).nodes.length, 1, 'stamped INTO the group');
    assert.equal(findN(host).nodes[0].name, 'Guitar', 'named inside');

    await callNative('undo');
    assert.equal(findN(host).nodes.length, 0,
        'ONE undo removes the whole insert');

    // Group template: the whole kit departs as one undo step too.
    const [stackId] = await buildKit();
    await callNative('saveTrackTemplate', stackId, 'Drums');
    const before = getState().nodes.length;
    await callNative('createFromTrackTemplate', 'Drums', '');
    assert.equal(getState().nodes.length, before + 1, 'kit landed');
    await callNative('undo');
    assert.equal(getState().nodes.length, before,
        'ONE undo, whole group gone (engine: single Insert edit)');
});

test('refusals record nothing on the undo log', async () => {
    loadScenario('empty');
    clearTrackTemplates();
    await callNative('createNode', 'clip', '');
    const canUndoBefore = getState().canUndo;
    const nodesBefore = getState().nodes.length;

    assert.equal(
        await callNative('createFromTrackTemplate', 'Missing', ''), false,
        'unknown template refused');
    assert.equal(getState().nodes.length, nodesBefore, 'graph untouched');
    assert.equal(getState().canUndo, canUndoBefore,
        'refused edit recorded nothing');

    // A refused edit must not have eaten the redo branch either: undo
    // still steps back over the REAL last edit.
    await callNative('undo');
    assert.equal(getState().nodes.length, nodesBefore - 1,
        'undo still targets the last real edit');
});

test('re-saving a name overwrites — the rig-update gesture', async () => {
    loadScenario('empty');
    clearTrackTemplates();
    const solo = await callNative('createNode', 'clip', '');
    await callNative('renameNode', solo, 'Guitar');
    await callNative('setNodeInput', solo, 2);
    await callNative('saveTrackTemplate', solo, 'Guitar');
    await callNative('setNodeInput', solo, 5);
    await callNative('saveTrackTemplate', solo, 'Guitar');

    const list = await callNative('listTrackTemplates');
    assert.equal(list.length, 1, 'still one entry');
    await callNative('createFromTrackTemplate', 'Guitar', '');
    const stamped = getState().nodes[1];
    assert.equal(stamped.inputChannel, 5, 'the updated input stamps');
});
