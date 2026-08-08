/**
 * The gain fader (unification_audit §2.4 — the fractal output stage's
 * missing primitive), mock/VM side:
 *  - setNodeGain clamps to [0, 1] (engine parity: AudioEngine::setNodeGain),
 *  - gain is NOT undoable (mixer knob — the effect-param ruling),
 *  - the view model surfaces `gain` per lane, defaulting ABSENT to
 *    unity (pre-gain states must not read as silent).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';

function findClip(nodes) {
    for (const n of nodes) {
        if (n.type === 'clip') return n;
        if (n.nodes) {
            const c = findClip(n.nodes);
            if (c) return c;
        }
    }
    return null;
}

test('setNodeGain stores and clamps to [0, 1]', async () => {
    loadScenario('stack-with-clips');
    const clip = findClip(getState().nodes);
    assert.equal(clip.gain, 1, 'nodes are born at unity');

    await callNative('setNodeGain', clip.id, 0.4);
    assert.equal(findClip(getState().nodes).gain, 0.4);

    await callNative('setNodeGain', clip.id, 7);
    assert.equal(findClip(getState().nodes).gain, 1, 'clamps high to unity');

    await callNative('setNodeGain', clip.id, -1);
    assert.equal(findClip(getState().nodes).gain, 0, 'clamps low to 0');
});

test('gain is not undoable (mixer knob)', async () => {
    loadScenario('stack-with-clips');
    const clip = findClip(getState().nodes);
    const couldUndo = getState().canUndo;
    await callNative('setNodeGain', clip.id, 0.5);
    assert.equal(getState().canUndo, couldUndo,
        'a fader tweak must not grow the undo log');
});

test('view model surfaces gain, defaulting absent to unity', () => {
    loadScenario('stack-with-clips');
    const state = getState();
    const clip = findClip(state.nodes);
    clip.gain = 0.25;
    const vm = deriveViewModel(state);
    const lane = vm.lanes.find(l => l.id === clip.id);
    assert.equal(lane.gain, 0.25, 'lane carries the fader value');

    delete clip.gain; // a pre-gain state dump (same state copy)
    const vm2 = deriveViewModel(state);
    const lane2 = vm2.lanes.find(l => l.id === clip.id);
    assert.equal(lane2.gain, 1, 'absent gain reads as unity, never 0');
});
