/**
 * One-shots as a period-source knob (Q5; Q18 — a stack can be one too).
 * The knob itself — who takes it, who refuses, its undo — is held to
 * the engine by the differential suite (ui/differential/
 * graph/one-shots); here, what follows from it:
 *  - one-shots are EXCLUDED from cycle composition (the mock's fold +
 *    the VM frame): they adopt the scope cycle, never extend it,
 *  - the lane surfaces `oneShot` and drops ghost repetitions (dashed
 *    tile, no ghosts — recording.md Example 3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, setMasterPos } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { MOCK_Q as Q, findByName } from './helpers.mjs';
import { published } from './mock_scene.mjs';

/* A one-shot contributes nothing to any fold — [what, scenario, the node
 * that becomes a one-shot, the cycle while it loops, the cycle without
 * it]: the 3Q clip beside 1Q + 4Q loops, and the 2Q beat stack beside a
 * 3Q melody stack. */
for (const [what, scenario, pick, loopingQ, shotQ] of [
    ['clip', 'example-1q-4q-3q',
     nodes => findByName(nodes, 'Clip 3Q') || findByName(nodes, '3Q'), 12, 4],
    ['stack', 'multiple-stacks', nodes => nodes[0], 6, 3],
]) {
    test(`a one-shot ${what} is excluded from the cycle (mock + VM frame); undo restores the loop`, async () => {
        loadScenario(scenario);
        const node = pick(getState().nodes);
        assert.ok(node, 'the scenario has the node');
        if (what === 'stack') assert.equal(node.anchored, true, 'fixture stacks anchor on load');
        assert.equal(node.periodSource, 'own');
        assert.equal(deriveViewModel(getState()).lcmQ, loopingQ, 'looping');

        await callNative('setPeriodSource', node.id, 'context');
        assert.equal(published(node.id).periodSource, 'context', 'published');
        assert.equal(getState().canUndo, true, 'a musical fact — undoable');
        assert.equal(deriveViewModel(getState()).lcmQ, shotQ,
            'the one-shot adopts the cycle, never extends it');
        // The mock's transport wraps on the same fold.
        setMasterPos((shotQ + 1) * Q);
        assert.equal(getState().masterPos, Q, `view wraps on ${shotQ}Q`);

        await callNative('undo');
        assert.equal(published(node.id).periodSource, 'own');
        assert.equal(deriveViewModel(getState()).lcmQ, loopingQ);
    });
}

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
