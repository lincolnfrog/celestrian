/**
 * findNodeInTree — the ONE tree walker the post-commit verdict
 * (edit_verdict.js), the structure verbs and the view model's definer
 * lookup share. The published tree carries children under `nodes`
 * (src/stack_node.cc getMetadata, mock/publish.js): a clip inside a
 * group must be found, or a grouped edit gets no success/refusal
 * verdict.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { findNodeInTree } from '../view_model.js';
import { callNative, getState, loadScenario } from '../mock_backend.js';

const Q = 1000;

/** An engine-shaped state: a stack holding a clip and a nested stack. */
const state = {
    nodes: [
        { id: 'top-clip', type: 'clip', duration: Q },
        {
            id: 'group', type: 'stack', nodes: [
                { id: 'inner-clip', type: 'clip', duration: 2 * Q },
                {
                    id: 'nested', type: 'stack', nodes: [
                        { id: 'deep-clip', type: 'clip', duration: 3 * Q },
                    ],
                },
            ],
        },
    ],
};

test('finds a node at any depth (children ride `nodes`); a missing id is null', () => {
    for (const [id, field, want] of [
        ['top-clip', 'duration', Q], ['group', 'type', 'stack'],
        ['inner-clip', 'duration', 2 * Q],   // inside a stack
        ['deep-clip', 'duration', 3 * Q],    // two stacks deep
    ]) assert.equal(findNodeInTree(state.nodes, id)[field], want, id);
    // Node gone: no verdict, never a throw.
    assert.equal(findNodeInTree(state.nodes, 'nope'), null);
    assert.equal(findNodeInTree(undefined, 'top-clip'), null);
});

test('the published mock tree: a grouped clip is reachable by id', async () => {
    // The shape the verdict reads: getState() after a window edit on a
    // clip that lives INSIDE a group.
    loadScenario('stack-with-clips');
    const q = getState().quantum;
    await callNative('setLoopPoints', 'clip-2', 0, q);
    const n = findNodeInTree(getState().nodes, 'clip-2');
    assert.ok(n, 'grouped clip found in the published tree');
    assert.equal(Math.round(n.loopEnd), q, 'the landed window is readable');
});
