/**
 * HOW A `next` ENTRY IS READ (docs/sequencer.md §14) — the JS side of
 * Sequence::readSuccessors in src/sequence.h: `to` and `w` are ints
 * (a fraction truncates), and an entry with NO `w` weighs 1. The walk
 * and these readings are pinned on both sides by
 * `sequence_program_cases`; here each reading is worked by hand through
 * successorOf, and followed into the grid row the view model builds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { programOf, successorOf, visitBounds } from '../sequence_program.js';
import { deriveViewModel } from '../view_model.js';
import { loadSharedJson } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');
const caseNamed = part => {
    const c = golden.sequence_program_cases.find(x => x.name.includes(part));
    assert.ok(c, 'the golden file holds "' + part + '"');
    return c;
};

test('an entry with no weight weighs 1: a sole successor stands', () => {
    // 0 → 2 → 0, each named without a weight: step 1 is never played.
    const steps = [{ len: 1000, next: [{ to: 2 }] }, { len: 1000 },
                   { len: 1000, next: [{ to: 0 }] }];
    assert.deepEqual(successorOf(steps, 0, 0, 0), { to: 2, branched: false });
    const p = programOf(steps, 0);
    assert.deepEqual(p.visits, [0, 2]);
    assert.equal(p.radio, false);
    assert.deepEqual(p.reachable, [true, false, true]);
    const b = visitBounds(p.visits, steps.map(s => s.len));
    assert.equal(b[b.length - 1], 2000);
});

test('an entry with no weight weighs 1: it is drawn against the others', () => {
    // The golden 3:1 branch with the weight-1 entry's `w` left out (and
    // the two returns' too): the same walk, visit for visit.
    const c = caseNamed('weighted 3:1 toward step 2');
    const steps = [
        { len: 1000, next: [{ to: 1 }, { to: 2, w: 3 }] },
        { len: 1000, next: [{ to: 0 }] },
        { len: 1000, next: [{ to: 0 }] },
    ];
    const p = programOf(steps, c.seed);
    assert.equal(p.radio, true);
    assert.equal(p.visits.length, c.visitCount);
    assert.deepEqual(p.visits.slice(0, c.visits.length), c.visits);
    assert.ok(p.visits.includes(1), 'the unweighted branch is taken');
});

test('the grid row reads an unweighted entry as weight 1, and walks it', () => {
    const Q = 1000;
    const state = {
        id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
        definerId: '',
        nodes: [{ id: 'a', type: 'clip', duration: Q, origin: 0 }],
        sequence: { seed: 0, bypassed: false, gates: {}, steps: [
            { len: Q, next: [{ to: 2 }] }, { len: Q },
            { len: 2 * Q, next: [{ to: 0 }] }] },
    };
    const vm = deriveViewModel(state, { seqOpen: new Set(['root']) });
    const row = vm.lanes.find(l => l.kind === 'seq');
    assert.deepEqual(row.steps.map(s => s.next),
        [[{ to: 2, w: 1 }], [], [{ to: 0, w: 1 }]]);
    assert.deepEqual(row.visits.map(v => v.step), [0, 2]);
    assert.deepEqual(row.reachable, [true, false, true]);
    assert.equal(row.totalQ, 3, 'the song is the two visits played');
    assert.equal(vm.cycleQ, 3, 'and so is the frame');
});

test('a weight that is there but is no number names nothing', () => {
    // Only an ABSENT weight defaults: null and a word read as 0.
    for (const w of [null, 'loud', 0, -2]) {
        const steps = [{ len: 1, next: [{ to: 2, w }] }, { len: 1 }, { len: 1 }];
        assert.deepEqual(successorOf(steps, 0, 0, 0), { to: 1, branched: false },
            'w = ' + String(w));
    }
});

test('a target is a whole number: a fraction truncates toward zero', () => {
    const steps = [{ len: 1, next: [{ to: 2.9 }] }, { len: 1 },
                   { len: 1, next: [{ to: -0.5 }] }];
    assert.deepEqual(successorOf(steps, 0, 0, 0), { to: 2, branched: false });
    assert.deepEqual(successorOf(steps, 0, 2, 1), { to: 0, branched: false });
    assert.deepEqual(programOf(steps, 0).visits, [0, 2]);
    // Out of range after truncation, or no target at all: no successor.
    for (const to of [3, 3.2, -1, undefined, null]) {
        const s = [{ len: 1, next: [{ to, w: 1 }] }, { len: 1 }, { len: 1 }];
        const want = to === null ? 0 : 1;  // null reads as 0, a real step
        assert.equal(successorOf(s, 0, 0, 0).to, want, 'to = ' + String(to));
    }
});
