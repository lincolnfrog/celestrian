/**
 * One-shots as a period-source knob (Q5 ruling), mock/VM side:
 *  - setPeriodSource round-trips, is clip-only, and IS undoable (a
 *    musical fact — unlike the mixer knobs),
 *  - one-shots are EXCLUDED from cycle composition (mock effectiveCycle
 *    parity + the VM frame): they adopt the scope cycle, never extend it,
 *  - the lane surfaces `oneShot` and drops ghost repetitions (dashed
 *    tile, no ghosts — recording.md Example 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { findByName } from './helpers.mjs';

test('setPeriodSource round-trips, clips AND stacks, undoable', async () => {
    loadScenario('stack-with-clips');
    const clip = findByName(getState().nodes, 'Clip A');
    assert.notEqual(findByName(getState().nodes, 'Clip A').periodSource,
        'context', 'clips are born loops');

    await callNative('setPeriodSource', clip.id, 'context');
    assert.equal(findByName(getState().nodes, 'Clip A').periodSource,
        'context', 'knob set');
    assert.equal(getState().canUndo, true, 'a musical fact is undoable');

    await callNative('undo');
    assert.equal(findByName(getState().nodes, 'Clip A').periodSource,
        'own', 'undo restores the loop');

    // Q18 (composition.md §0 — "a stack can be a one-shot"): stacks
    // take the knob too, undoably. (Pre-Q18 they refused: "a stack has
    // no origin to anchor a firing to".) An IDENTITY set records
    // nothing — it pops its pre-pushed undo snapshot (engine parity:
    // setPeriodSource returns before recording when unchanged).
    const stack = getState().nodes.find(n => n.type === 'stack');
    await callNative('setPeriodSource', stack.id, 'context');
    assert.equal(getState().nodes.find(n => n.type === 'stack').periodSource,
        'context', 'stacks accept the knob');
    await callNative('undo');
    assert.notEqual(getState().nodes.find(n => n.type === 'stack').periodSource,
        'context', 'undo restores the looping group');
    const undoBefore = getState().canUndo;
    await callNative('setPeriodSource', stack.id, 'own');  // identity
    assert.equal(getState().canUndo, undoBefore,
        'an identity set leaves the undo stack balanced');
});

test('one-shots are excluded from the cycle (mock + VM frame)', async () => {
    loadScenario('example-1q-4q-3q');
    let vm = deriveViewModel(getState());
    assert.equal(vm.lcmQ, 12, 'looping: lcm(1,4,3) = 12Q');

    // The 3Q clip becomes a one-shot: the cycle relaxes to lcm(1,4) = 4Q.
    const clip3 = findByName(getState().nodes, 'Clip 3Q')
        || findByName(getState().nodes, '3Q');
    assert.ok(clip3, 'scenario has the 3Q clip');
    await callNative('setPeriodSource', clip3.id, 'context');
    vm = deriveViewModel(getState());
    assert.equal(vm.lcmQ, 4, 'one-shot adopts the cycle, never extends it');
});

test('one-shot lane: oneShot fact, no ghost repetitions', async () => {
    loadScenario('example-1q-4q');
    const clip1 = findByName(getState().nodes, 'Clip 1Q')
        || findByName(getState().nodes, '1Q');
    assert.ok(clip1, 'scenario has the 1Q clip');

    let vm = deriveViewModel(getState());
    let lane = vm.lanes.find(l => l.id === clip1.id);
    assert.equal(lane.oneShot, false);
    assert.ok(lane.reps.filter(r => r.ghost).length > 0,
        'looping 1Q clip ghosts across the 4Q frame');

    await callNative('setPeriodSource', clip1.id, 'context');
    vm = deriveViewModel(getState());
    lane = vm.lanes.find(l => l.id === clip1.id);
    assert.equal(lane.oneShot, true);
    assert.equal(lane.reps.filter(r => r.ghost).length, 0,
        'no ghost repetitions (dashed tile alone)');
    assert.ok(lane.reps.some(r => !r.ghost), 'the take tile remains');
    assert.equal(vm.lcmQ, 4, 'frame still framed by the 4Q loop');
});
