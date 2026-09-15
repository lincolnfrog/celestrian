/**
 * PER-STEP FADES — mock + view-model twin (docs/sequencer.md §15, S13;
 * C++ twin: the "S13" section of tests/sequencer_tests.cc). Pins:
 *
 *  - setSequence carries `fadeIn` / `fadeOut` per step (samples); the
 *    mock stores, publishes and undoes them; negatives clamp away;
 *  - the VM grid row exposes fadeInQ / fadeOutQ per step;
 *  - the lanes project the ramps (`seqDims[].fadeSegsQ`): a run ramps
 *    in over its FIRST step's fade-in and out over its LAST step's
 *    fade-out, runs merge across the wrap, and ramps that do not fit
 *    the run shrink proportionally (engine parity Sequence::rampsOf).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake } from './helpers.mjs';

const opts = { fxOpen: new Set(),
               pinFrameQ: null, pinFoldQ: null };

async function seedTwoTracks() {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 2000);
    return { a, b, Q: getState().quantum };
}

const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 1e-9, `${msg}: ${x} vs ${y}`);

test('fades store, publish, clamp and undo; the VM exposes them in Q', async () => {
    const { a, Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q, fadeOut: -5 },
                { name: 'B', len: 4 * Q, fadeIn: Q, fadeOut: Q / 2 },
                { name: 'C', len: 2 * Q }],
        gates: { [a]: [false, true, false] },
    });
    const st = getState();
    assert.equal(st.sequence.steps[0].fadeOut, undefined, 'negative clamps away');
    assert.equal(st.sequence.steps[1].fadeIn, Q);
    assert.equal(st.sequence.steps[1].fadeOut, Q / 2);
    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['mock-root']) });
    const grid = vm.lanes.find(l => l.kind === 'seq');
    assert.deepEqual(grid.steps.map(s => [s.fadeInQ, s.fadeOutQ]),
        [[0, 0], [1, 0.5], [0, 0]], 'grid steps carry the fades in Q');
    // The lane of `a` (on in B only): ramps at B's edges.
    const laneA = vm.lanes.find(l => l.id === a);
    assert.deepEqual(laneA.seqDims[0].fadeSegsQ, [[2, 3, 'in'], [5.5, 6, 'out']]);
    await callNative('undo');
    assert.equal(getState().sequence, undefined, 'one undo step');
});

test('runs merge across the wrap: the ramps come from the run\'s first and last steps', async () => {
    const { a, Q } = await seedTwoTracks();
    // a on in C and A (wrapping): the run is C → A; C's fade-in and
    // A's fade-out apply; nothing ramps at 0 or at the song's end.
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q, fadeIn: Q, fadeOut: Q },
                { name: 'B', len: 4 * Q },
                { name: 'C', len: 2 * Q, fadeIn: Q, fadeOut: Q }],
        gates: { [a]: [true, false, true] },
    });
    const vm = deriveViewModel(getState(), opts);
    const laneA = vm.lanes.find(l => l.id === a);
    assert.deepEqual(laneA.seqDims[0].fadeSegsQ, [[6, 7, 'in'], [1, 2, 'out']]);
});

test('ramps that do not fit the run shrink proportionally and meet', async () => {
    const { a, Q } = await seedTwoTracks();
    // B is 2Q with a 3Q fade-in and a 1Q fade-out: 3:1 over 2Q →
    // 1.5Q in, 0.5Q out, meeting at 1.5Q into the run.
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q },
                { name: 'B', len: 2 * Q, fadeIn: 3 * Q, fadeOut: Q },
                { name: 'C', len: 2 * Q }],
        gates: { [a]: [false, true, false] },
    });
    const vm = deriveViewModel(getState(), opts);
    const segs = vm.lanes.find(l => l.id === a).seqDims[0].fadeSegsQ;
    assert.equal(segs.length, 2);
    near(segs[0][0], 2, 'in start'); near(segs[0][1], 3.5, 'in end');
    near(segs[1][0], 3.5, 'out start'); near(segs[1][1], 4, 'out end');
    // A cue seam breaks the run: with B cued and a on everywhere, B's
    // fades apply at B's own edges.
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q },
                { name: 'B', len: 2 * Q, cue: true, fadeIn: Q / 2, fadeOut: Q / 2 },
                { name: 'C', len: 2 * Q }],
        gates: {},
    });
    const vm2 = deriveViewModel(getState(), opts);
    const segs2 = vm2.lanes.find(l => l.id === a).seqDims[0].fadeSegsQ;
    assert.deepEqual(segs2, [[2, 2.5, 'in'], [3.5, 4, 'out']],
        'a cued step\'s ramps at its seams; the C→A run has no musical fade');
});
