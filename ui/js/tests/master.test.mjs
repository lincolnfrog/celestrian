/**
 * THE MASTER STRIP (B5), mock/VM side:
 *  - the view model exposes `rootGain` (the root stack's output-stage
 *    fader), defaulting ABSENT to unity (pre-gain states must not read
 *    as silent), and `rootFxCount` (the master fx chip's count),
 *  - setNodeGain on the root ('mock-root') round-trips through the mock
 *    and clamps to [0, 1] like every node (engine parity:
 *    AudioEngine::setNodeGain — the root is findByUuid's self match),
 *  - the master fader is NOT undoable (a mixer knob, like pan/gain on
 *    every rail),
 *  - the root publishes its rack; fxOpen on rootId renders the master fx
 *    row FIRST and slot edits address the root's chain,
 *  - the meter memory (vu_meter.js meterStep): the peak-hold tick parks
 *    then falls, and the clip lamp latches only on full scale.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { meterStep, freshMeterMemory, levelToDial } from '../vu_meter.js';
import { MOCK_Q } from './helpers.mjs';

const ROOT = 'mock-root';

test('view model exposes rootGain, defaulting absent to unity', () => {
    loadScenario('stack-with-clips');
    const state = getState();
    assert.equal(state.id, ROOT, 'the root publishes its id');
    assert.equal(deriveViewModel(state).rootGain, 1, 'born at unity');

    state.gain = 0.4;
    assert.equal(deriveViewModel(state).rootGain, 0.4);

    delete state.gain;  // a pre-gain state dump
    assert.equal(deriveViewModel(state).rootGain, 1,
        'absent gain reads as unity, never 0');
});

test('setNodeGain on the root round-trips and clamps to [0, 1]', async () => {
    loadScenario('stack-with-clips');
    await callNative('setNodeGain', ROOT, 0.3);
    assert.equal(getState().gain, 0.3);
    assert.equal(deriveViewModel(getState()).rootGain, 0.3);

    await callNative('setNodeGain', ROOT, 3);
    assert.equal(getState().gain, 1, 'clamps high to unity (no boost)');

    await callNative('setNodeGain', ROOT, -2);
    assert.equal(getState().gain, 0, 'clamps low to silence');
});

test('the master fader is not undoable (mixer knob)', async () => {
    loadScenario('stack-with-clips');
    const couldUndo = getState().canUndo;
    await callNative('setNodeGain', ROOT, 0.5);
    assert.equal(getState().canUndo, couldUndo,
        'a master fader tweak must not grow the undo log');
});

test('a scenario load resets the master fader to unity', async () => {
    loadScenario('stack-with-clips');
    await callNative('setNodeGain', ROOT, 0.2);
    loadScenario('single-clip');
    assert.equal(getState().gain, 1);
});

test('the root publishes its rack; fxOpen on rootId renders the master fx row first', async () => {
    loadScenario('stack-with-clips');
    const state = getState();
    assert.ok(Array.isArray(state.effects && state.effects.chain),
        'the root carries `effects` like every node');
    assert.equal(state.effects.chain.length, 4, 'the fixed four-slot rack');

    const fxOpen = new Set([ROOT]);
    const vm = deriveViewModel(state, { fxOpen });
    assert.equal(vm.lanes[0].kind, 'fx', 'the master rack is the first row');
    assert.equal(vm.lanes[0].ownerId, ROOT);
    assert.equal(vm.lanes[0].id, 'fx:' + ROOT);
    assert.equal(vm.rootFxCount, 0, 'everything off at load');

    // A slot edit addresses the root's chain.
    const reverb = state.effects.chain.find(s => s.type === 'reverb');
    await callNative('setSlotEnabled', ROOT, reverb.slot, true);
    const vm2 = deriveViewModel(getState(), { fxOpen });
    assert.equal(vm2.rootFxCount, 1);
    assert.equal(
        vm2.lanes[0].effects.chain.find(s => s.type === 'reverb').enabled,
        true, 'the row renders the root chain');

    // Closed: no synthetic row anywhere.
    const vm3 = deriveViewModel(getState());
    assert.ok(!vm3.lanes.some(l => l.kind === 'fx'));
});

test('the root fx row sits above the root sequencer grid', () => {
    loadScenario('stack-with-clips');
    const state = getState();
    state.sequence = { bypassed: false, steps: [{ name: 'A', len: MOCK_Q }],
                       gates: {} };
    const vm = deriveViewModel(state,
        { fxOpen: new Set([ROOT]), seqOpen: new Set([ROOT]) });
    assert.equal(vm.lanes[0].kind, 'fx');
    assert.equal(vm.lanes[1].kind, 'seq');
    assert.equal(vm.lanes[1].ownerId, ROOT);
});

test('meter memory: the peak tick parks, then falls toward the live level', () => {
    let m = freshMeterMemory();
    m = meterStep(m, 0.5, 1000);
    assert.equal(m.hold, levelToDial(0.5), 'a rise parks the tick');
    assert.equal(m.clipped, false);

    m = meterStep(m, 0.1, 1050);
    assert.equal(m.hold, levelToDial(0.5), 'parked within the hold');

    m = meterStep(m, 0.1, 2600);  // 100 ms past the park
    assert.ok(m.hold < levelToDial(0.5), 'falls once the park ends');
    assert.ok(m.hold > levelToDial(0.1), 'a long park is not one big drop');

    m = meterStep(m, 0.1, 9000);
    assert.equal(m.hold, levelToDial(0.1), 'never below the live level');

    m = meterStep(m, 0.7, 9050);
    assert.equal(m.hold, levelToDial(0.7), 'a new peak re-parks');
});

test('meter memory: the clip lamp latches on full scale only', () => {
    let m = meterStep(freshMeterMemory(), 0.99, 0);
    assert.equal(m.clipped, false, 'hot but under full scale: no latch');

    m = meterStep(m, 1.0, 50);
    assert.equal(m.clipped, true, 'full scale latches');
    m = meterStep(m, 0, 100);
    assert.equal(m.clipped, true, 'and stays latched through silence');

    const over = meterStep(freshMeterMemory(), 1.3, 0);
    assert.equal(over.clipped, true, 'an over (unclamped float) latches');
});
