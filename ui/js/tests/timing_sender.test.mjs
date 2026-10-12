/**
 * A RE-TIME DRAG'S SENDER (session_view/map_core.js timingSender) — the
 * one bookkeeping the lane's ↺ shift and the panel's start marker share:
 * setTiming is RELATIVE, so every live commit sends only the shift its
 * predecessor had not, under one undo step; a commit that would change
 * nothing returns the last one's promise; a cancel restores through the
 * engine (cancelGesture) — or, with nothing sent, only puts the preview
 * back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ctx } from '../session_view/context.js';
import { timingSender, newGesture } from '../session_view/map_core.js';

function bridge() {
    const calls = [];
    ctx.cb = {
        onSetTiming: (id, shift, top, live) => {
            const p = Promise.resolve(true);
            calls.push({ shift, top, live, p });
            return p;
        },
        onCancelGesture: id => {
            const p = Promise.resolve(true);
            calls.push({ cancel: id, p });
            return p;
        },
    };
    return calls;
}
const previewLog = () => {
    const log = [];
    return { log, restore: held => log.push(held) };
};
const st = { laneId: 'c' };

test('the lane\'s ↺: each commit sends what the last had not, as one undo step', () => {
    const calls = bridge();
    newGesture();
    const s = timingSender(st, previewLog());
    const p1 = s.commit(1000);
    assert.deepEqual(calls.map(c => [c.shift, c.top, c.live]), [[1000, null, false]],
        'the first commit opens the undo step');
    assert.equal(s.commit(1000), p1, 'nothing new: the last commit\'s promise');
    assert.equal(calls.length, 1);
    s.commit(3000);
    s.commit(0);
    assert.deepEqual(calls.slice(1).map(c => [c.shift, c.live]),
        [[2000, true], [-3000, true]], 'relative, coalesced into the step');
});

test('the start marker: a top rides each commit; the same top and shift sends nothing', () => {
    const calls = bridge();
    newGesture();
    const s = timingSender(st, previewLog(), 4000);
    assert.equal(s.commit(0, 4000), undefined, 'at rest: the top it started on');
    assert.equal(calls.length, 0);
    s.commit(-1000, 5000);
    s.commit(-1000, 5000);
    s.commit(0, 4000);   // back where it began: still a commit — the top moved
    assert.deepEqual(calls.map(c => [c.shift, c.top]), [[-1000, 5000], [1000, 4000]]);
});

test('a cancel with nothing sent only puts the preview back', () => {
    const calls = bridge();
    newGesture();
    const pv = previewLog();
    const s = timingSender(st, pv);
    assert.equal(s.restore({ originShift: 0 }), undefined);
    assert.deepEqual(pv.log, [null], 'the preview the gesture found');
    assert.equal(calls.length, 0, 'nothing to undo');
});

test('a cancel after a commit is the engine\'s, with the held picture; the sender starts over', () => {
    const calls = bridge();
    newGesture();
    const pv = previewLog();
    const s = timingSender(st, pv, 4000);
    s.commit(-1000, 5000);
    const held = { top: 4000, originShift: 0 };
    const p = s.restore(held);
    assert.equal(calls[1].cancel, 'c', 'cancelGesture, not a counter-commit');
    assert.equal(p, calls[1].p, 'its promise: the caller holds the picture on it');
    assert.deepEqual(pv.log, [held]);
    // A net shift of nothing still had a step to drop.
    newGesture();
    const s2 = timingSender(st, previewLog());
    s2.commit(500);
    s2.commit(0);
    assert.ok(s2.restore({ originShift: 0 }), 'whatever was sent, its step goes');
    assert.equal(calls[calls.length - 1].cancel, 'c');
});
