/**
 * SUCCESSOR GRAPHS + THE SEED — mock + view-model twin (docs/sequencer.md
 * §6, §14; C++ twin: the "SUCCESSORS" section of tests/sequencer_tests.cc).
 * Pins:
 *
 *  - setSequence carries `next` per step and `seed`; the mock publishes
 *    the derived PROGRAM (`program`, `radio`) exactly as the engine does;
 *  - THE PROGRAM IS THE TIMELINE: the period law reads the program's
 *    total (a jump graph 0 -> 2 -> 0 is a 2-step song; the orphan never
 *    sounds), the grid's columns are the visits, the lanes tile over it;
 *  - a RADIO (a branch with chance, or an intro that never returns) is
 *    ROOT-ONLY (S12): a nested target refuses it and records no undo step;
 *  - the seed is data: the same seed replays the same run; re-roll is one
 *    undoable setSequence; the run survives the mock's session round trip;
 *  - the step audition of a revisited step loops its FIRST visit; an
 *    orphan cannot be auditioned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { programOf } from '../sequence_program.js';
import { recordTake } from './helpers.mjs';

const opts = { fxOpen: new Set(), windowEdit: new Set(),
               pinFrameQ: null, pinFoldQ: null };

async function seedTwoTracks() {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 2000);
    return { a, b, Q: getState().quantum };
}

const threeSteps = (Q, nexts, seed = 0) => ({
    steps: nexts.map((next, i) => ({
        name: 'ABC'[i], len: 2 * Q, ...(next ? { next } : {}) })),
    gates: {},
    ...(seed ? { seed } : {}),
});

test('a jump graph: the program is the timeline (period law, grid, lanes)', async () => {
    const { a, Q } = await seedTwoTracks();
    // A -> C -> A; B is an orphan.
    await callNative('setSequence', 'mock-root', {
        ...threeSteps(Q, [[{ to: 2, w: 1 }], null, [{ to: 0, w: 1 }]]),
        gates: { [a]: [true, true, false] },
    });
    const st = getState();
    assert.deepEqual(st.sequence.program, [0, 2], 'program published');
    assert.equal(st.sequence.radio, false, 'a returning loop is periodic');
    assert.equal(st.sequence.seed, 0);
    assert.deepEqual(st.sequence.steps[0].next, [{ to: 2, w: 1 }],
        'successors publish per step');
    assert.equal(st.sequence.steps[1].next, undefined,
        'the default successor stores as no list');

    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['mock-root']) });
    assert.equal(vm.cycleQ, 4, 'the frame is the PROGRAM (2 visits × 2Q)');
    const grid = vm.lanes.find(l => l.kind === 'seq');
    assert.equal(grid.steps.length, 3, 'three authored steps');
    assert.deepEqual(grid.visits.map(v => v.step), [0, 2], 'two columns');
    assert.deepEqual(grid.visits.map(v => v.startQ), [0, 2]);
    assert.equal(grid.totalQ, 4);
    assert.deepEqual(grid.reachable, [true, false, true]);
    assert.equal(grid.radio, false);
    // The lane of track `a` (gated OFF in C) dims [2, 4) of the 4Q program.
    const laneA = vm.lanes.find(l => l.id === a);
    assert.ok(laneA.seqDims, 'the lane carries seq dims');
    assert.equal(laneA.seqDims[0].periodQ, 4, 'dims tile over the program');
    assert.deepEqual(laneA.seqDims[0].offSegsQ, [[2, 4]]);
});

test('a radio is ROOT-ONLY (S12): nested refuses, records no undo; the root takes it', async () => {
    loadScenario('stack-with-clips');
    const Q = getState().quantum;
    const group = getState().nodes.find(n => n.type === 'stack');
    assert.ok(group, 'a nested stack');
    const canUndoBefore = getState().canUndo;
    const branch = threeSteps(Q, [[{ to: 1, w: 1 }, { to: 2, w: 1 }], null, null], 5);
    await callNative('setSequence', group.id, branch);
    const g = getState().nodes.find(n => n.id === group.id);
    assert.equal(g.sequence, undefined, 'the nested radio is refused');
    assert.equal(getState().canUndo, canUndoBefore, 'no undo step recorded');
    // An intro that never returns is a radio too.
    await callNative('setSequence', group.id,
        threeSteps(Q, [null, null, [{ to: 1, w: 1 }]]));
    assert.equal(getState().nodes.find(n => n.id === group.id).sequence,
        undefined, 'a non-returning walk is refused nested');
    // A periodic jump graph is fine nested.
    await callNative('setSequence', group.id,
        threeSteps(Q, [[{ to: 2, w: 1 }], null, [{ to: 0, w: 1 }]]));
    const g2 = getState().nodes.find(n => n.id === group.id);
    assert.deepEqual(g2.sequence.program, [0, 2], 'periodic graph accepted');

    // The root takes the branch; the program fills the horizon.
    await callNative('setSequence', 'mock-root', branch);
    const st = getState();
    assert.equal(st.sequence.radio, true);
    assert.equal(st.sequence.seed, 5);
    assert.equal(st.sequence.program.length, 256, 'the horizon');
    assert.deepEqual(st.sequence.program, programOf(branch.steps, 5).visits,
        'the published program IS the mirror\'s unroll');
    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['mock-root']) });
    const grid = vm.lanes.find(l => l.kind === 'seq');
    assert.equal(grid.radio, true);
    assert.equal(grid.seed, 5);
    assert.equal(grid.visits.length, 256);
    assert.equal(vm.cycleQ, grid.totalQ, 'the frame is the whole program');
});

test('the seed is data: re-roll is one undoable edit; another seed, another run', async () => {
    const { Q } = await seedTwoTracks();
    const branch = seed => threeSteps(
        Q, [[{ to: 1, w: 1 }, { to: 2, w: 1 }], [{ to: 0, w: 1 }], [{ to: 0, w: 1 }]],
        seed);
    await callNative('setSequence', 'mock-root', branch(1));
    const run1 = getState().sequence.program.slice();
    await callNative('setSequence', 'mock-root', branch(2));
    const run2 = getState().sequence.program.slice();
    assert.notDeepEqual(run1, run2, 'another seed is another performance');
    await callNative('undo');
    assert.equal(getState().sequence.seed, 1, 'undo restores the seed');
    assert.deepEqual(getState().sequence.program, run1, '…and its run');
    await callNative('setSequence', 'mock-root', branch(1));
    assert.deepEqual(getState().sequence.program, run1,
        'the same seed replays the same run');
});

test('malformed successors refuse: out of range, non-positive weight', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', threeSteps(Q, [null, null, null]));
    const before = getState().sequence;
    const canUndoBefore = getState().canUndo;
    await callNative('setSequence', 'mock-root',
        threeSteps(Q, [[{ to: 9, w: 1 }], null, null]));
    assert.deepEqual(getState().sequence, before, 'out-of-range refused');
    await callNative('setSequence', 'mock-root',
        threeSteps(Q, [[{ to: 1, w: 0 }], null, null]));
    assert.deepEqual(getState().sequence, before, 'zero weight refused');
    assert.equal(getState().canUndo, canUndoBefore, 'no undo steps recorded');
});

test('audition of a revisited step loops its FIRST visit; an orphan refuses', async () => {
    const { Q } = await seedTwoTracks();
    // intro | A | B -> A: A at visits 1, 3, 5, …
    await callNative('setSequence', 'mock-root',
        threeSteps(Q, [null, null, [{ to: 1, w: 1 }]]));
    assert.equal(getState().sequence.radio, true);
    await callNative('auditionStep', 'mock-root', 1);
    assert.equal(getState().windowActive, true);
    assert.equal(getState().loopStart, 2 * Q, 'the first visit of A');
    assert.equal(getState().loopEnd, 4 * Q);
    await callNative('auditionStep', 'mock-root', -1);
    // A -> C -> A: B is an orphan.
    await callNative('setSequence', 'mock-root',
        threeSteps(Q, [[{ to: 2, w: 1 }], null, [{ to: 0, w: 1 }]]));
    await callNative('auditionStep', 'mock-root', 1);
    assert.equal(getState().windowActive, false, 'an orphan has no span');
    assert.equal(getState().sequence.auditionStep, -1);
    await callNative('auditionStep', 'mock-root', 2);
    assert.equal(getState().loopStart, 2 * Q, 'C is the second visit');
    await callNative('auditionStep', 'mock-root', -1);
});
