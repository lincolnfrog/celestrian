/**
 * THE SEQUENCE PROGRAM — golden twin (docs/sequencer.md §14; C++ twin:
 * the "sequence program" section of tests/timing_golden_tests.cc).
 * ui/js/sequence_program.js and src/sequence.h must unroll (steps,
 * seed) to the same visits, radio verdict and total.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { programOf, visitBounds, mix32, draw, MAX_VISITS }
    from '../sequence_program.js';
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

test('the walk is pure: the same (steps, seed) unrolls identically', () => {
    const steps = [{ len: 10, next: [{ to: 1, w: 1 }, { to: 2, w: 2 }] },
                   { len: 10, next: [{ to: 0, w: 1 }] },
                   { len: 10, next: [{ to: 0, w: 1 }] }];
    const a = programOf(steps, 42), b = programOf(steps, 42);
    assert.deepEqual(a.visits, b.visits);
    assert.equal(a.visits.length, MAX_VISITS, 'a radio fills the horizon');
    const other = programOf(steps, 43);
    assert.notDeepEqual(other.visits, a.visits, 'another seed, another run');
    // Weights bias the draw: the 2:1 branch lands on step 2 more often.
    const twos = a.visits.filter(v => v === 2).length;
    const ones = a.visits.filter(v => v === 1).length;
    assert.ok(twos > ones, `2:1 weighting: ${twos} vs ${ones}`);
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

test('mix32 / draw are uint32 and stable', () => {
    assert.equal(mix32(0), 0);
    assert.equal(mix32(1) >>> 0, mix32(1));
    assert.notEqual(draw(0, 0), draw(0, 1));
    assert.notEqual(draw(0, 0), draw(1, 0));
});
