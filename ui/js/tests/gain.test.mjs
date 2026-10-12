/**
 * The gain fader — every node's, and the root's (the master fader) —
 * and the mixer verbs' one rule, mock/VM side:
 *  - setNodeGain clamps to [0, 1] (engine parity: AudioEngine::setNodeGain;
 *    the root is findByUuid's self match),
 *  - a mixer or monitoring gesture is NOT undoable (gain, solo, monitor:
 *    absent from the UNDOABLE set, like the effect params),
 *  - the view model surfaces `gain` per lane, defaulting ABSENT to
 *    unity (a state without the field must not read as silent).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { findFirst, laneOf } from './helpers.mjs';

const ROOT = 'mock-root';
const findClip = nodes => findFirst(nodes, n => n.type === 'clip');
/** The published gain of node `id`, and the gain the view model shows. */
const gainOf = id => (id === ROOT ? getState() : findFirst(getState().nodes, n => n.id === id)).gain;
const shownGain = id => {
    const vm = deriveViewModel(getState());
    return id === ROOT ? vm.rootGain : laneOf(vm, id).gain;
};

for (const who of ['a clip', 'the root (the master fader)']) {
    test(`setNodeGain on ${who} stores and clamps to [0, 1]`, async () => {
        loadScenario('stack-with-clips');
        const id = who === 'a clip' ? findClip(getState().nodes).id : ROOT;
        assert.equal(gainOf(id), 1, 'born at unity');

        await callNative('setNodeGain', id, 0.4);
        assert.equal(gainOf(id), 0.4);
        assert.equal(shownGain(id), 0.4, 'the view model shows it');

        await callNative('setNodeGain', id, 7);
        assert.equal(gainOf(id), 1, 'clamps high to unity (no boost)');

        await callNative('setNodeGain', id, -1);
        assert.equal(gainOf(id), 0, 'clamps low to silence');
    });
}

test('mixer verbs record no undo step: gain, the master fader, solo, monitor', async () => {
    loadScenario('stack-with-clips');
    const clip = findClip(getState().nodes).id;
    assert.equal(getState().canUndo, false, 'a fresh session: an empty log');
    for (const [verb, ...args] of [
        ['setNodeGain', clip, 0.5], ['setNodeGain', ROOT, 0.5],
        ['toggleSolo', clip], ['setMonitor', clip, true],
    ]) {
        await callNative(verb, ...args);
        assert.equal(getState().canUndo, false, `${verb} must not grow the undo log`);
    }
    const c = findClip(getState().nodes);
    assert.deepEqual([c.gain, getState().gain, c.isSoloed, c.monitor], [0.5, 0.5, true, true],
        'and each one took');
});

test('view model surfaces gain, defaulting absent to unity', () => {
    loadScenario('stack-with-clips');
    const state = getState();
    const clip = findClip(state.nodes);
    clip.gain = 0.25;
    assert.equal(laneOf(deriveViewModel(state), clip.id).gain, 0.25,
        'lane carries the fader value');

    delete clip.gain; // a state without the field (same state copy)
    assert.equal(laneOf(deriveViewModel(state), clip.id).gain, 1,
        'absent gain reads as unity, never 0');
});
