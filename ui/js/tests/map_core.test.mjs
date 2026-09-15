/**
 * THE THREE MOVE LAWS (session_view/map_core.js) — the edit functions
 * both editing surfaces (the lane's same-scale reveal, the region
 * panel) run their gestures through. Pure: raw Q in, pending segments
 * + follow + badge out. What this pins: (a) TRIM snaps the PERIOD to
 * whole Qs and lands the bound where that period lives, ⌥ slides the
 * whole region by any amount; (b) SLIDE moves the region by whole Qs
 * (⌥ any amount), length held, clamped to the take; (c) SEAM slides a
 * cut freely and ⌥-resizes its end on the whole-Q grid; (d) the
 * at-rest render (rawQ === null) proposes exactly the geometry it
 * started from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { trimMoveFn, slideMoveFn, seamMoveFn, viewPct }
    from '../session_view/map_core.js';
import { cutBounds } from '../map_edit.js';

const st = { laneId: 'c', segs: [[6, 10]], totalQ: 12, anchorQ: 0,
             editable: true, heard: true, periodQ: 4, quantum: 1000, cycleQ: 4 };

test('trim: the period snaps to whole Qs; the bound follows the period', () => {
    const move = trimMoveFn(st, [[6, 10]], 'end', 10);
    // At rest: the bound as it is, no snap, no ghost.
    let r = move(null, false);
    assert.deepEqual(r.segs, [[6, 10]]);
    assert.equal(r.follow.q, 10);
    assert.equal(r.active.ghost, false);
    // 8.8Q proposes a 2.8Q period → 3Q → the bound lands at 9Q; the
    // follow bracket stays under the hand (8.8) with the ghost at 9.
    r = move(8.8, false);
    assert.deepEqual(r.segs, [[6, 9]]);
    assert.equal(r.follow.q, 8.8);
    assert.equal(r.active.q, 9);
    assert.equal(r.active.ghost, true);
    assert.match(r.active.text, /loop end · 3Q/);
    // Outward past the take clamps to it.
    r = move(14, false);
    assert.deepEqual(r.segs, [[6, 12]]);
    // The START edge, mirrored.
    const ms = trimMoveFn(st, [[6, 10]], 'start', 6);
    r = ms(7.3, false);
    assert.deepEqual(r.segs, [[7, 10]]);
    assert.equal(r.follow.edge, 'start');
});

test('trim + ⌥: the whole region slides by any amount, length held', () => {
    const move = trimMoveFn(st, [[6, 10]], 'end', 10);
    let r = move(10.4, true);
    assert.deepEqual(r.segs, [[6.4, 10.4]]);
    assert.equal(r.follow.q, 10.4);
    assert.equal(r.active.ghost, false);
    assert.match(r.active.text, /slide \+0\.4Q · 4Q/);
    // Clamped at the take's end — a slide never trims.
    r = move(13, true);
    assert.deepEqual(r.segs, [[8, 12]]);
});

test('trim: ⌥ released mid-drag re-lands the slide on whole Qs, then trims from there (U2)', () => {
    // A 1Q window [1, 2) on a 3Q take (the alt_mix_drag recipe): ⌥
    // slide +0.6Q, release ⌥, nudge to +0.65Q in plain mode.
    const s3 = { ...st, segs: [[1, 2]], totalQ: 3, periodQ: 1 };
    const move = trimMoveFn(s3, [[1, 2]], 'start', 1);
    let r = move(1.6, true);
    assert.deepEqual(r.segs, [[1.6, 2.6]]);
    // Plain: the slide lands at +1Q ([2, 3)) FIRST; 1.65Q then proposes
    // a 1.35Q period → 1Q → the bound stays at 2. The gesture LANDS
    // whole-Q on both length and position — never a silent no-op.
    r = move(1.65, false);
    assert.deepEqual(r.segs, [[2, 3]]);
    assert.equal(r.follow.q, 1.65);
    assert.equal(r.active.q, 2);
    // Trimming on from the re-landed base: 2.4 → period 0.6 → 1Q → 2.
    r = move(2.4, false);
    assert.deepEqual(r.segs, [[2, 3]]);
});

test('slide: whole-Q steps from the grab point; ⌥ frees the grid', () => {
    const move = slideMoveFn(st, [[6, 10]], 8);
    let r = move(null, false);
    assert.deepEqual(r.segs, [[6, 10]]);
    assert.equal(r.follow.kind, 'span');
    r = move(8.4, false);                     // +0.4 → rounds to 0
    assert.deepEqual(r.segs, [[6, 10]]);
    r = move(9.3, false);                     // +1.3 → +1Q
    assert.deepEqual(r.segs, [[7, 11]]);
    assert.deepEqual([r.follow.a, r.follow.b], [7, 11]);
    assert.match(r.active.text, /slide \+1Q · 4Q/);
    r = move(0, false);                       // −8 → clamps at 0
    assert.deepEqual(r.segs, [[0, 4]]);
    r = move(9.3, true);                      // ⌥: +1.3 exactly (fp)
    assert.ok(Math.abs(r.segs[0][0] - 7.3) < 1e-9 &&
              Math.abs(r.segs[0][1] - 11.3) < 1e-9, JSON.stringify(r.segs));
    // Multi-segment maps slide as one body.
    const mm = slideMoveFn(st, [[1, 3], [5, 7]], 2);
    r = mm(3.2, false);
    assert.deepEqual(r.segs, [[2, 4], [6, 8]]);
});

test('seam: slide keeps the cut length; ⌥ resizes the end on the grid', () => {
    const segs = [[2, 5], [6, 10]];         // a 1Q cut at [5, 6)
    const s2 = { ...st, segs, periodQ: 7 };
    const [lo, hi] = cutBounds(segs, [5, 6], 12);
    const move = seamMoveFn(s2, [5, 6], lo, hi);
    let r = move(null, false);
    assert.deepEqual(r.segs, segs);
    assert.deepEqual([r.follow.a, r.follow.b], [5, 6]);
    r = move(7.5, false);                     // slide the cut's start to 7.5
    assert.deepEqual(r.segs, [[2, 7.5], [8.5, 10]]);
    assert.match(r.active.text, /1Q cut/);
    r = move(7.7, true);                      // ⌥: the END proposes 2.7 → 3Q
    assert.deepEqual(r.segs, [[2, 5], [8, 10]]);
    assert.equal(r.follow.b, 7.7);            // raw edge under the hand
    assert.equal(r.active.q, 8);              // the whole-Q landing
    assert.equal(r.active.ghost, true);
});

test('viewPct: a view maps raw Q into its span', () => {
    assert.equal(viewPct(6, { q0: 0, spanQ: 12 }), '50%');
    assert.equal(viewPct(6, { q0: 4, spanQ: 4 }), '50%');
    assert.equal(viewPct(3, { q0: 4, spanQ: 4 }), '-25%');
});
