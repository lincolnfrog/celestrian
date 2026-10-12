/**
 * math_utils.js — the shared fold. `posMod` mirrors timing::posMod in
 * src/qtime.h: into [0, m) for a positive period, and TOTAL — a
 * non-positive period folds nothing and hands the value back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { posMod, foldShift } from '../math_utils.js';

test('posMod folds into [0, m), negatives included', () => {
    assert.equal(posMod(7, 3), 1);
    assert.equal(posMod(-1, 3), 2);
    assert.equal(posMod(-3, 3), 0);
    assert.equal(Object.is(posMod(-3, 3), 0), true, 'never −0');
    assert.equal(posMod(0.25, 1), 0.25);
});

test('posMod is total: a period that is not positive folds nothing', () => {
    assert.equal(posMod(7, 0), 7);
    assert.equal(posMod(-7, 0), -7);
    assert.equal(posMod(7, -3), 7);
    assert.equal(posMod(-7, -3), -7);
    assert.equal(posMod(2.5, NaN), 2.5);
});

test('posMod stays below its period: a negative residue lost in the ' +
     'period\'s float spacing folds to 0, never to the period itself', () => {
    assert.equal(posMod(-1e-17, 4), 0);
    assert.equal(posMod(-Number.MIN_VALUE, 1), 0);
    // A residue the period's spacing can hold keeps its place.
    assert.equal(posMod(-1e-9, 4), 4 - 1e-9);
    assert.ok(posMod(-1e-9, 4) < 4);
});

test('foldShift leaves a shift alone when the period is not positive', () => {
    assert.equal(foldShift(5, 0), 5);
    assert.equal(foldShift(13, 2), 1);
});
