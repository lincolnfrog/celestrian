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

import { callNative, getState } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { near } from './helpers.mjs';
import { seedTwoTracks } from './mock_scene.mjs';

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
    const vm = deriveViewModel(st, { seqOpen: new Set(['mock-root']) });
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
    const vm = deriveViewModel(getState());
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
    const vm = deriveViewModel(getState());
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
    const vm2 = deriveViewModel(getState());
    const segs2 = vm2.lanes.find(l => l.id === a).seqDims[0].fadeSegsQ;
    assert.deepEqual(segs2, [[2, 2.5, 'in'], [3.5, 4, 'out']],
        'a cued step\'s ramps at its seams; the C→A run has no musical fade');
});

/* ---- ramps over a PROGRAM that is not the plain loop (§14) ----
 * A run's length is the sum of its VISITS' lengths. Hand-built states:
 * the view model alone, no mock. */

const SQ = 1000;
const plainClip = (id) => ({ id, type: 'clip', duration: SQ, origin: 0,
                             loopStart: 0, loopEnd: 0, windowActive: false });
const songState = sequence => ({
    id: 'root', quantum: SQ, islandZero: 0, islandPos: 0, masterPos: 0,
    definerId: '', nodes: [plainClip('a'), plainClip('b')], sequence,
});
const fadesOf = (st, id) =>
    deriveViewModel(st).lanes.find(l => l.id === id).seqDims[0].fadeSegsQ;

test('a successor program: the ramp sits at the end of the VISIT, not of the step slot', () => {
    // A (1Q) → C (4Q) → A: the walk skips B, so the program is [A, C],
    // 5Q. `a` plays in C only — visit 1, which starts at 1Q — and C
    // fades out over its last half Q: [4.5Q, 5Q).
    const st = songState({
        steps: [{ name: 'A', len: SQ, next: [{ to: 2, w: 1 }] },
                { name: 'B', len: 2 * SQ },
                { name: 'C', len: 4 * SQ, fadeOut: SQ / 2 }],
        gates: { a: [false, false, true] },
    });
    assert.deepEqual(fadesOf(st, 'a'), [[4.5, 5, 'out']]);
});

test('more visits than steps: a step played twice lends each visit its own length', () => {
    // The published program A B A C (1 + 2 + 1 + 4 = 8Q). `a` plays in
    // C only: visit 3, [4Q, 8Q); its fade-out is the last half Q.
    const steps = [{ name: 'A', len: SQ, fadeIn: SQ / 4 },
                   { name: 'B', len: 2 * SQ, fadeOut: SQ / 2 },
                   { name: 'C', len: 4 * SQ, fadeOut: SQ / 2 }];
    const st = songState({ steps, program: [0, 1, 0, 2],
                           gates: { a: [false, false, true] } });
    assert.deepEqual(fadesOf(st, 'a'), [[7.5, 8, 'out']]);
    // `b` plays in A only — visits 0 and 2, each its own 1Q run with
    // A's quarter-Q fade-in at its start.
    const st2 = songState({ steps, program: [0, 1, 0, 2],
                            gates: { b: [true, false, false] } });
    assert.deepEqual(fadesOf(st2, 'b'), [[0, 0.25, 'in'], [3, 3.25, 'in']]);
    // `b` on in A and B: the runs are A→B→A (visits 0–2, 4Q: A's
    // fade-in, then A's own fade-out — none) and nothing else.
    const st3 = songState({ steps, program: [0, 1, 0, 2],
                            gates: { b: [true, true, false] } });
    assert.deepEqual(fadesOf(st3, 'b'), [[0, 0.25, 'in']]);
});
