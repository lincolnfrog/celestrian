/**
 * Structural verbs the mock refuses, as the engine's applier does
 * (src/engine/edit_structure.cc): a refused verb changes nothing, answers as
 * a refusal, logs no undo step and leaves the redo branch standing.
 *
 *  - Combine: neither node may hold the other, and the two must differ;
 *  - Move: the destination is a stack or the root;
 *  - Insert: the parent is a stack or the root;
 *  - Rename, Mute, Input: the node exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { nodeById } from './helpers.mjs';

const ROOT = 'mock-root';

/** The graph as ids, names and the flags these verbs write. */
const picture = (nodes = getState().nodes) => nodes.map(n => ({
    id: n.id, name: n.name, muted: !!n.isMuted,
    input: [n.inputChannel, n.inputChannelR],
    nodes: n.nodes ? picture(n.nodes) : undefined,
}));
const idsOf = nodes => nodes.map(n => n.id);
const find = id => nodeById(id, getState().nodes);

/**
 * 'nested-stacks' (parent-stack ▸ clip-1, child-stack ▸ nested-clip-1,
 * nested-clip-2) with an empty undo log and one redo step standing: a
 * refusal that kept its snapshot would show as an undo step and would
 * drop the redo.
 */
async function nestedWithRedo() {
    loadScenario('nested-stacks');
    await callNative('renameNode', 'clip-1', 'renamed');
    await callNative('undo');
    assert.equal(getState().canUndo, false, 'fixture: an empty undo log');
    assert.equal(getState().canRedo, true, 'fixture: one redo step');
}

/** Run `verb` on the fixture: nothing may change. Answers its result. */
async function refused(verb) {
    await nestedWithRedo();
    const before = picture();
    const answer = await verb();
    assert.deepEqual(picture(), before, 'the graph is untouched');
    assert.equal(getState().canUndo, false, 'no undo step');
    assert.equal(getState().canRedo, true, 'the redo branch stands');
    return answer;
}

test('combine refuses a group with its own member, either way round', async () => {
    assert.equal(await refused(() =>
        callNative('combineNodes', 'child-stack', 'nested-clip-1')), '',
        'the group dragged onto its member');
    assert.equal(await refused(() =>
        callNative('combineNodes', 'nested-clip-1', 'child-stack')), '',
        'the member dragged onto its group');
    assert.equal(await refused(() =>
        callNative('combineNodes', 'parent-stack', 'nested-clip-2')), '',
        'a group and a track two levels inside it');
});

test('combine refuses a node with itself, and an unknown node', async () => {
    assert.equal(await refused(() =>
        callNative('combineNodes', 'clip-1', 'clip-1')), '');
    assert.equal(await refused(() =>
        callNative('combineNodes', 'clip-1', 'nobody')), '');
    assert.equal(await refused(() =>
        callNative('combineNodes', 'nobody', 'clip-1')), '');
});

test('combine still wraps two tracks that do not hold each other', async () => {
    loadScenario('nested-stacks');
    const group = await callNative('combineNodes', 'nested-clip-2', 'clip-1');
    assert.ok(group, 'answers the new group');
    assert.deepEqual(idsOf(find(group).nodes), ['clip-1', 'nested-clip-2'],
        'target first, then the dragged track');
    assert.deepEqual(idsOf(find('parent-stack').nodes), [group, 'child-stack'],
        'in the target\'s slot');
    assert.equal(getState().canUndo, true, 'one undo step');
});

test('move refuses a parent that is neither a stack nor the root', async () => {
    for (const [node, parent] of [
        ['nested-clip-1', 'clip-1'], ['nested-clip-1', 'nobody'], ['nobody', 'parent-stack'],
    ]) {
        assert.equal(await refused(() => callNative('reorderNode', node, parent, 0)), false,
            `${node} into ${parent} answers false`);
    }
});

test('move to the root lands at the top level, at the index asked', async () => {
    loadScenario('nested-stacks');
    await callNative('reorderNode', 'nested-clip-1', ROOT, 0);
    assert.deepEqual(idsOf(getState().nodes), ['nested-clip-1', 'parent-stack']);
    await callNative('reorderNode', 'nested-clip-2', ROOT, 5);
    assert.deepEqual(idsOf(getState().nodes),
        ['nested-clip-1', 'parent-stack', 'nested-clip-2'], 'the index clamps');
    assert.deepEqual(idsOf(find('child-stack').nodes), []);
});

test('create refuses a parent that is neither a stack nor the root', async () => {
    assert.equal(await refused(() =>
        callNative('createNode', 'clip', 'clip-1')), '', 'a clip as parent');
    assert.equal(await refused(() =>
        callNative('createNode', 'clip', 'nobody')), '', 'an unknown parent');
});

test('create under the root, named or not, appends to the top level', async () => {
    loadScenario('nested-stacks');
    const a = await callNative('createNode', 'clip', ROOT);
    const b = await callNative('createNode', 'clip', '');
    assert.deepEqual(idsOf(getState().nodes), ['parent-stack', a, b]);
});

test('rename, mute and input on an unknown node log nothing', async () => {
    await refused(() => callNative('renameNode', 'nobody', 'x'));
    await refused(() => callNative('toggleMute', 'nobody'));
    await refused(() => callNative('setNodeInput', 'nobody', 1));
    await refused(() => callNative('setNodeInputRight', 'nobody', 1));
});
