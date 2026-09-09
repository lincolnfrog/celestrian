/**
 * Structural-edit refusals — the mock twins of the engine's applier
 * guards (src/engine/edit_log.cc, pinned by tests/undo_tests.cc):
 *
 *  - Move refuses a destination inside the moved subtree (a stack into
 *    its own descendant would be a self-owning cycle);
 *  - a HOT clip (armed or capturing) is neither movable nor combinable
 *    — cancel is the verb; a stack is hot iff a member is.
 *
 * A refused verb records nothing and leaves the graph untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { nodeById } from './helpers.mjs';

const find = id => nodeById(id, getState().nodes);
const topIds = () => getState().nodes.map(n => n.id);

test('Move refuses a destination inside the moved subtree', async () => {
    loadScenario('empty');
    const outer = await callNative('createNode', 'stack', '');
    const inner = await callNative('createNode', 'stack', outer);
    const before = JSON.stringify(topIds());

    await callNative('reorderNode', outer, inner, 0);  // into its own child
    assert.equal(JSON.stringify(topIds()), before, 'graph untouched');
    assert.equal(find(outer).nodes[0].id, inner, 'inner still inside outer');

    await callNative('reorderNode', outer, outer, 0);  // into itself
    assert.equal(JSON.stringify(topIds()), before, 'self-parent refused');
    assert.equal(find(outer).nodes[0].id, inner, 'inner still inside outer');

    // The legal direction still works: inner out to the top level.
    await callNative('reorderNode', inner, '', 0);
    assert.equal(topIds()[0], inner, 'inner moved to the top level');
});

test('a hot clip refuses Move and Combine; cancel then both work', async () => {
    loadScenario('empty');
    const stack = await callNative('createNode', 'stack', '');
    const hot = await callNative('createNode', 'clip', stack);
    const peer = await callNative('createNode', 'clip', stack);
    const outside = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', hot);
    assert.ok(find(hot).isRecording || find(hot).isPendingStart, 'hot');

    await callNative('reorderNode', hot, stack, 1);
    assert.equal(find(stack).nodes[0].id, hot, 'armed clip not moved');
    await callNative('reorderNode', hot, '', 0);
    assert.equal(find(stack).nodes[0].id, hot, 'armed clip not moved out');

    assert.equal(await callNative('combineNodes', hot, outside), null,
                 'combine of an armed clip refused');
    assert.equal(await callNative('combineNodes', outside, hot), null,
                 'combine INTO an armed clip refused');
    assert.deepEqual(topIds(), [stack, outside], 'graph untouched');

    // A stack is hot iff a member is: the whole stack refuses too.
    assert.equal(await callNative('combineNodes', stack, outside), null,
                 'combine of a stack with a hot member refused');

    await callNative('stopRecordingInNode', hot);  // cancel
    await callNative('reorderNode', hot, stack, 1);
    assert.equal(find(stack).nodes[1].id, hot, 'idle again: moved');
    const combined = await callNative('combineNodes', peer, outside);
    assert.ok(combined, 'idle again: combined');
});
