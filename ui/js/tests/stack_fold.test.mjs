/**
 * THE STACK FOLD (ui/js/time_map.js stackFold — the twin of
 * timing::stackFold in src/timing.h): how a stack turns the clock it
 * receives into the clock its children hear — the (map, fold) pair of
 * the render equation.
 *
 * The verdicts — transparent, mapped, the one-shot's shot — are the
 * golden `stack_fold_cases` (timeline_model_golden.test.mjs runs them);
 * here, the positions a fold hands the children, the ones
 * tests/one_shot_tests.cc ("G-2b: a one-shot GROUP folds its child
 * clock on the CONTEXT cycle…") and tests/content_frame_tests.cc
 * ("…one-shot group, windowed member") read off the render, worked by
 * hand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { stackFold, innerAt, singleSegment, mapPeriod } from '../time_map.js';

const Q = 1000;
const NONE = { segs: [] };
const WINDOW = singleSegment(Q, 4 * Q);  // 3Q

/** What the stack's children hear at clock `t`: the offset of their
 * clock from the stack's origin, or 'rest'. */
const childClock = (f, t, origin) => {
    if (!f.folds) return t - origin;
    const at = innerAt(t, origin, f.eff, f.fold);
    return at.rest ? 'rest' : at.inner;
};

test('a 3Q one-shot kit over a 4Q bass fires from its top every time', () => {
    // Unmapped: the shot is the kit's own 3Q, fired at its origin (0)
    // once per 4Q.
    const f = stackFold(NONE, true, 3 * Q, 4 * Q);
    assert.deepEqual([0, Q, 3 * Q, 4 * Q, 5 * Q, 7 * Q].map(t => childClock(f, t, 0)),
        [0, Q, 'rest', 0, Q, 'rest']);
    // Folded on its own 3Q instead, the second firing would hand the
    // mic 4Q mod 3Q = Q: one Q late on every other bar.
    assert.notEqual(childClock(f, 4 * Q, 0), (4 * Q) % (3 * Q));
});

test('a windowed one-shot kit: the shot is the window, fired at origin + a0', () => {
    // A 3Q window [Q, 4Q) on a 5Q mic, in a 4Q cycle.
    const f = stackFold(WINDOW, true, 3 * Q, 4 * Q);
    assert.deepEqual(
        [0, Q, 3 * Q, 4 * Q, 5 * Q, 6 * Q].map(t => childClock(f, t, 0)),
        ['rest', Q, 3 * Q, 'rest', Q, 2 * Q]);
    // The window phase the group publishes while it sounds: h over the
    // map period — a third of the way through at 6Q.
    const at = innerAt(6 * Q, 0, f.eff, f.fold);
    assert.equal(at.h / mapPeriod(f.eff), 1 / 3);
});

test('a one-shot kit whose member is windowed: the shot is the member\'s window', () => {
    // An 8Q mic windowed [Q, 3Q) in a one-shot kit beside a 3Q bass: the
    // kit's own period is the 2Q the mic plays, fired once per 3Q.
    const kit = stackFold(NONE, true, 2 * Q, 3 * Q);
    const mic = singleSegment(Q, 3 * Q);
    const micAt = t => {
        const c = childClock(kit, t, 0);
        return c === 'rest' ? c : innerAt(c, 0, mic, mapPeriod(mic)).inner;
    };
    // The mic folds the kit's clock on its own window from its own
    // origin: clock 0 is one Q before its window's moment.
    assert.deepEqual([0, 500, Q, 1999, 2 * Q, 2999, 3 * Q, 4 * Q].map(micAt),
        [2 * Q, 2500, Q, 1999, 'rest', 'rest', 2 * Q, Q]);
});
