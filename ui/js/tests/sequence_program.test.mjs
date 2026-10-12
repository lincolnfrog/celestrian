/**
 * THE SEQUENCE PROGRAM — golden twin (docs/sequencer.md §14; C++ twin:
 * the "sequence program" section of tests/timing_golden_tests.cc).
 * ui/js/sequence_program.js and src/sequence.h must unroll (steps,
 * seed) to the same visits, radio verdict and total.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { programOf, successorOf, visitBounds, publishedSequence, sequenceProgram, sequenceVisits,
         sequenceTotalSamples, activeSequenceSamples, auditionStepOf,
         isAuditionWindow } from '../sequence_program.js';
import { loadSharedJson } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

test('golden: sequence program (successor graphs + the seed)', () => {
    for (const c of golden.sequence_program_cases) {
        const p = programOf(c.steps, c.seed);
        assert.equal(p.radio, c.radio, c.name + ' - radio');
        assert.equal(p.visits.length, c.visitCount, c.name + ' - visit count');
        assert.deepEqual(p.visits.slice(0, c.visits.length), c.visits,
            c.name + ' - visits');
        const b = visitBounds(p.visits, c.steps.map(s => s.len));
        assert.equal(b[b.length - 1], c.total, c.name + ' - total');
    }
});

test('reachability and first visits follow the program', () => {
    const p = programOf([{ len: 1, next: [{ to: 2, w: 1 }] }, { len: 1 },
                         { len: 1, next: [{ to: 0, w: 1 }] }], 0);
    assert.deepEqual(p.reachable, [true, false, true]);
    assert.deepEqual(p.firstVisit, [0, -1, 1]);
    assert.equal(p.radio, false);
    // An intro (a deterministic return to a non-zero step) is a radio.
    const intro = programOf([{ len: 1 }, { len: 1 },
                             { len: 1, next: [{ to: 1, w: 1 }] }], 0);
    assert.equal(intro.radio, true);
    assert.deepEqual(intro.firstVisit, [0, 1, 2]);
});

test('a weight is a whole number: a fraction truncates, and below 1 it is no successor', () => {
    // src/sequence.h reads `w` as an int and drops a non-positive one,
    // so 0.5 names nothing and the step falls back to the loop successor.
    const half = [{ len: 1, next: [{ to: 2, w: 0.5 }] }, { len: 1 }, { len: 1 }];
    assert.deepEqual(successorOf(half, 0, 0, 0), { to: 1, branched: false });
    assert.deepEqual(programOf(half, 0).visits, [0, 1, 2]);
    // Two fractional candidates: neither stands, so no draw is made.
    const both = [{ len: 1, next: [{ to: 1, w: 0.4 }, { to: 2, w: 0.3 }] },
                  { len: 1 }, { len: 1 }];
    assert.deepEqual(successorOf(both, 7, 0, 0), { to: 1, branched: false });
    assert.equal(programOf(both, 7).radio, false, 'a plain loop, not a radio');
    // One whole weight beside a fraction: the whole one is the only
    // candidate — a fixed successor, not a branch.
    const mixed = [{ len: 1, next: [{ to: 2, w: 2.7 }, { to: 1, w: 0.9 }] },
                   { len: 1 }, { len: 1 }];
    assert.deepEqual(successorOf(mixed, 7, 0, 0), { to: 2, branched: false });
});

test('a published sequence: its program is the published one, else the ' +
     'unroll; the visits alone agree with it', () => {
    for (const c of golden.sequence_program_cases) {
        const s = { steps: c.steps, seed: c.seed };
        assert.deepEqual(sequenceProgram(s), programOf(c.steps, c.seed), c.name);
        assert.deepEqual(sequenceVisits(s), sequenceProgram(s).visits, c.name);
        assert.equal(sequenceTotalSamples(s), c.total, c.name + ' - total');
    }
    // A published `program` wins over the walk; entries naming no step
    // are dropped.
    const steps = [{ len: 10 }, { len: 20 }, { len: 40 }];
    const s = { steps, seed: 0, program: [0, 2, 7, -1, 0.5, 2], radio: true };
    assert.deepEqual(sequenceVisits(s), [0, 2, 2]);
    assert.deepEqual(sequenceProgram(s), { visits: [0, 2, 2], radio: true,
        reachable: [true, false, true], firstVisit: [0, -1, 1] });
    assert.equal(sequenceTotalSamples(s), 90, 'visits concatenate');
    // No steps: no sequence, no program, no length.
    for (const none of [null, {}, { steps: [] }]) {
        assert.deepEqual(sequenceVisits(none), []);
        assert.deepEqual(sequenceProgram(none).visits, []);
        assert.equal(publishedSequence({ sequence: none }), null);
        assert.equal(activeSequenceSamples({ sequence: none }), 0);
    }
    assert.equal(publishedSequence({ sequence: s }), s);
    assert.equal(activeSequenceSamples({ sequence: s }), 90);
    assert.equal(activeSequenceSamples({ sequence: { ...s, bypassed: true } }), 0,
        'a bypassed song is no part length');
});

test('the audition step is a step of the sequence; an audition window ' +
     'needs the song on', () => {
    const steps = [{ len: 10 }, { len: 20 }];
    assert.equal(auditionStepOf({ steps, auditionStep: 1 }), 1);
    for (const bad of [2, -1, 0.5, undefined, '1']) {
        assert.equal(auditionStepOf({ steps, auditionStep: bad }), -1, String(bad));
    }
    assert.equal(auditionStepOf(null), -1);
    assert.equal(isAuditionWindow({ sequence: { steps, auditionStep: 1 } }), true);
    assert.equal(isAuditionWindow({ sequence: { steps, auditionStep: 1,
                                                bypassed: true } }), false);
    assert.equal(isAuditionWindow({ sequence: { steps, auditionStep: -1 } }), false);
    assert.equal(isAuditionWindow({}), false);
    assert.equal(isAuditionWindow(null), false);
});
