/**
 * THE MOVE LAWS (session_view/map_core.js) — the edit functions both
 * editing surfaces (the lane's same-scale reveal, the region panel)
 * run their raw-time gestures through. Pure: raw Q in, pending segments
 * + follow + badge out. What this pins: (a) TRIM snaps the PERIOD to
 * whole Qs and lands the bound where that period lives, ⌥ slides the
 * whole region by any amount; (b) SLIDE moves the region by whole Qs
 * (⌥ any amount), length held, clamped to the take; (c) SEAM slides a
 * cut freely and ⌥-resizes its end on the whole-Q grid; (d) the
 * at-rest render (rawQ === null) proposes exactly the geometry it
 * started from; (e) LENGTH (⇧ at a splice, 2026-09-24) moves the end
 * of the material before the splice by whole Qs — a cut closes to a
 * heal; (f) the timing readout's words.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { trimMoveFn, slideMoveFn, seamMoveFn, lengthMoveFn, viewPct,
         timingText, fmtSignedQ, fmtFineQ }
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

/* THE LENGTH LAW (⇧ at a splice, loop_selection.md P2.4) — run through
 * the same-scale reveal, anchored at the bound it moves. */
test('length at the wrap: the loop end rides the hand and lands on whole Qs', () => {
    const move = lengthMoveFn(st, [[6, 10]], 0);
    let r = move(null, false);
    assert.deepEqual(r.segs, [[6, 10]], 'at rest: the loop as it is');
    assert.deepEqual(r.follow, { kind: 'bracket', edge: 'end', q: 10 });
    assert.equal(r.active.ghost, false);
    // 11.3: one more Q (right = more material); the bracket under the
    // hand, the ghost at the landing.
    r = move(11.3, false);
    assert.deepEqual(r.segs, [[6, 11]]);
    assert.equal(r.follow.q, 11.3);
    assert.equal(r.active.q, 11);
    assert.equal(r.active.ghost, true);
    assert.match(r.active.text, /loop 5Q \(\+1\)/);
    // Left = less, never under 1Q; the follow keeps near a real stop.
    r = move(2, false);
    assert.deepEqual(r.segs, [[6, 7]]);
    assert.ok(r.follow.q >= 7 - 0.5, 'the leash: ' + r.follow.q);
    assert.match(r.active.text, /loop 1Q \(−3\)/);
});

test('length at a cut: the material before it; the band closes to a heal', () => {
    const segs = [[2, 5], [7, 10]];  // a 2Q cut at [5, 7)
    const s2 = { ...st, segs, periodQ: 6 };
    const move = lengthMoveFn(s2, segs, 1);
    let r = move(null, false);
    assert.deepEqual(r.follow, { kind: 'band', a: 5, b: 7 }, 'the cut as a band');
    r = move(6.2, false);                    // +1Q of material: a 1Q cut
    assert.deepEqual(r.segs, [[2, 6], [7, 10]]);
    assert.deepEqual([r.follow.a, r.follow.b], [6.2, 7]);
    assert.match(r.active.text, /cut 1Q · loop 7Q/);
    r = move(7.4, false);                    // the cut closes: healed
    assert.deepEqual(r.segs, [[2, 10]]);
    assert.match(r.active.text, /cut healed · loop 8Q/);
    assert.equal(r.follow.b, 7);
    assert.ok(r.follow.a <= 7, 'the band never inverts');
    r = move(3.6, false);                    // −1Q: a 3Q cut
    assert.deepEqual(r.segs, [[2, 4], [7, 10]]);
});

test('the timing readout: as played, whole Q, or a fine shift in ms', () => {
    assert.equal(timingText(0, 1000), 'timing: as played');
    assert.equal(timingText(1, 1000), 'timing: shifted +1Q');
    assert.equal(timingText(-2, 1000), 'timing: shifted −2Q');
    assert.equal(timingText(-0.025, 1600), 'timing: shifted −0.025Q (40 ms earlier)');
    assert.equal(timingText(0.04, 1000), 'timing: shifted +0.04Q (40 ms later)');
    assert.equal(timingText(0.0002, 1000), 'timing: shifted +0Q (<1 ms later)');
    assert.equal(timingText(undefined, 1000), 'timing: as played');
    assert.equal(fmtSignedQ(1), '+1');
    assert.equal(fmtSignedQ(-0.25), '−0.25');
    assert.equal(fmtSignedQ(0), '+0');
    assert.equal(fmtFineQ(1.0000000001), '1');
});
