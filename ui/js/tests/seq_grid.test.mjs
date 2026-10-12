/**
 * The sequencer grid's pure parts (session_view/seq_grid.js).
 * snapStep: which step a frame-health "snap to NQ" resizes — the last
 * step the program plays that stays a step after the change; no step,
 * no offer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { snapStep } from '../session_view/seq_grid.js';

/** A periodic lane: every step visited once, in list order. */
const lane = (lensQ, visitSteps = lensQ.map((_, i) => i)) => ({
    steps: lensQ.map(lenQ => ({ lenQ })),
    visits: visitSteps.map(step => ({ step })),
});

test('growing lands on the last step played', () => {
    assert.equal(snapStep(lane([4, 1]), 3), 1);
    assert.equal(snapStep(lane([3]), 1), 0);
});

test('shrinking skips a step too short to give', () => {
    // 4Q + 1Q, one Q off: the 1Q step cannot give it; the 4Q step can.
    assert.equal(snapStep(lane([4, 1]), -1), 0);
    // A step may shrink to exactly 1Q, never below.
    assert.equal(snapStep(lane([4, 2]), -1), 1);
    assert.equal(snapStep(lane([4, 2]), -2), 0);
});

test('no step can take it: no offer', () => {
    assert.equal(snapStep(lane([1, 1, 1, 1, 1]), -1), -1);
    assert.equal(snapStep(lane([2, 2]), -2), -1);
    assert.equal(snapStep(lane([]), 1), -1);
});

test('a step the program never plays moves nothing: it is skipped', () => {
    // Three steps, the last an orphan (the walk is 0 → 1 → 0).
    assert.equal(snapStep(lane([4, 2, 8], [0, 1]), 2), 1);
    assert.equal(snapStep(lane([4, 1, 8], [0, 1]), -1), 0);
});

test('a step played more than once per pass is not the one to resize', () => {
    // 0 → 1 → 0 → 2: step 0's length counts twice in the song.
    assert.equal(snapStep(lane([2, 3, 4], [0, 1, 0, 2]), 1), 2);
    assert.equal(snapStep(lane([2, 3, 1], [0, 1, 0, 2]), -1), 1);
});
