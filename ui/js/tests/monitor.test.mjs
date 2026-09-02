/**
 * Software input monitoring (Q20), mock/VM side:
 *  - setMonitor round-trips on a clip, is born OFF, is refused on a
 *    stack, and is NOT undoable (a monitoring gesture like solo),
 *  - the lane exposes `monitor`, and the VM carries the calibrated
 *    round trip (monitorLatencyMs) or null for the chip's tooltip,
 *  - a track template carries it as input setup (like the channels).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { findByName, near } from './helpers.mjs';

const clipA = () => findByName(getState().nodes, 'Clip A');

test('setMonitor round-trips on a clip, born off, not undoable', async () => {
    loadScenario('stack-with-clips');
    assert.equal(clipA().monitor, false, 'born OFF (Q20: opt-in)');

    const undoBefore = getState().canUndo;
    await callNative('setMonitor', clipA().id, true);
    assert.equal(clipA().monitor, true, 'on');
    assert.equal(getState().canUndo, undoBefore,
        'a monitoring gesture records nothing on the undo log');
    await callNative('setMonitor', clipA().id, false);
    assert.equal(clipA().monitor, false, 'off again');

    // A group has no input of its own (Q7): the verb is clip-only.
    const stack = getState().nodes.find(n => n.type === 'stack');
    await callNative('setMonitor', stack.id, true);
    assert.ok(!getState().nodes.find(n => n.type === 'stack').monitor,
        'stacks have no input to monitor');
});

test('the lane exposes monitor; the VM carries the calibrated round trip', async () => {
    loadScenario('stack-with-clips');
    let vm = deriveViewModel(getState());
    assert.equal(vm.lanes.find(l => l.id === clipA().id).monitor, false);
    assert.equal(vm.monitorLatencyMs, null, 'uncalibrated: no figure');

    await callNative('setMonitor', clipA().id, true);
    vm = deriveViewModel(getState());
    assert.equal(vm.lanes.find(l => l.id === clipA().id).monitor, true);

    // A calibrated perf blob: samples -> ms at the DEVICE rate.
    const state = getState();
    state.perf = Object.assign({}, state.perf, {
        calibrated: true,
        latencyCompensationSamples: state.perf.sampleRate / 100,
    });
    vm = deriveViewModel(state);
    near(vm.monitorLatencyMs, 10, 1e-9);
});

test('a track template carries monitoring as input setup', async () => {
    loadScenario('stack-with-clips');
    const src = clipA();
    await callNative('setMonitor', src.id, true);
    assert.equal(await callNative('saveTrackTemplate', src.id, 'Mon'), true);
    assert.equal(await callNative('createFromTrackTemplate', 'Mon', ''), true);
    const made = getState().nodes.find(n => n.type === 'clip' && n.id !== src.id);
    assert.ok(made, 'the template stamped a top-level clip');
    assert.equal(made.monitor, true, 'monitoring arrived with the wiring');
    assert.equal(made.duration, 0, 'still empty => armable');
});
