/**
 * Solo canon (Q16) — mock backend + view-model twin of
 * tests/solo_tests.cc. The engine twin pins the AUDIBILITY law
 * (island-wide, additive, fractal, mute-beats-solo at render); this
 * side pins the STATE contract the UI reads:
 *
 *  - toggleSolo flips a PER-NODE flag — additive (two lanes lit at
 *    once), never radio-button, never a single top-level soloedId;
 *  - the view model exposes it per lane (`soloed`), including on
 *    groups (fractal: the group's S button lights for the subtree);
 *  - solo is NOT undoable (a monitoring gesture — the log itself is
 *    pinned in gain.test.mjs): undo steps over it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { nodeById } from './helpers.mjs';

const findN = id => nodeById(id, getState().nodes);
const laneOf = id =>
    deriveViewModel(getState()).lanes.find(l => l.id === id);

test('solo is per-node and ADDITIVE — two lanes lit at once', async () => {
    loadScenario('empty');
    const a = await callNative('createNode', 'clip', '');
    const b = await callNative('createNode', 'clip', '');

    await callNative('toggleSolo', a);
    assert.equal(findN(a).isSoloed, true, 'a lit');
    assert.equal(findN(b).isSoloed, false, 'b dark');

    await callNative('toggleSolo', b);   // additive: b JOINS a
    assert.equal(findN(a).isSoloed, true, 'a still lit — no radio button');
    assert.equal(findN(b).isSoloed, true, 'b lit too');

    await callNative('toggleSolo', a);   // per-node un-solo
    assert.equal(findN(a).isSoloed, false, 'a dark again');
    assert.equal(findN(b).isSoloed, true, 'b unaffected');

    // Solo is no edit: undo steps over it straight to the structural one.
    await callNative('undo');
    assert.deepEqual(getState().nodes.map(n => n.id), [a],
        'undo removed b — it was not blocked or consumed by a solo');
});

test('view model reads the per-node flag — clips AND groups', async () => {
    loadScenario('empty');
    const stackId = await callNative('createNode', 'stack', '');
    const c = await callNative('createNode', 'clip', stackId);
    const d = await callNative('createNode', 'clip', '');

    await callNative('toggleSolo', stackId);  // fractal: solo the GROUP
    await callNative('toggleSolo', d);
    assert.equal(laneOf(stackId).soloed, true, 'group lane lit');
    assert.equal(laneOf(d).soloed, true, 'clip lane lit (additive)');
    assert.equal(laneOf(c).soloed, false,
        'member lane not lit by its parent — the flag is the node\'s own');
});
