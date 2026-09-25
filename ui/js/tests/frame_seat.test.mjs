/**
 * THE SEAT: THE TOP'S MOMENT, AT OR JUST BEFORE IT (docs/frame.md §1;
 * loop_selection.md §9.3–§9.4, P2.7). Phase 1's name for this file was
 * seat_nearest.test.mjs; the NEAREST rule it pinned is superseded
 * (2026-09-24).
 *
 * The frame's zero seats on the first lane's bar lines — the grid line
 * AT OR BEFORE a lane's top, a top up to ¼Q early a PICKUP to the next
 * line: [x]grid = gridPhase + ⌊(x − gridPhase)/Q + ¼⌋·Q. The top read
 * is the ↺'s MOMENT, origin + a0 + heardOffset(segs, loopTop); with no
 * `loopTop` (an old engine), or one the kept set does not play, it is
 * the region start — every picture of before Phase 2.
 *
 * What this pins:
 *   (a) the field topology (a 1Q scratch loop, a 56Q take windowed to
 *       5Q that seats the frame, a later 5Q loop 3Q in): slides inside
 *       [−¼Q, +¾Q) of the bar leave the zero, the later lane and the
 *       cursor where they were; past either end the frame re-seats on
 *       the neighbouring line, always on the grid;
 *   (b) the ¼Q pickup boundary exactly, and the first lane's seat;
 *   (c) the top's MOMENT: a stored top inside the kept set (single
 *       window, cuts, an unmapped take), a top in a cut or outside the
 *       set, and absent `loopTop` — and stacks keep the region start;
 *   (d) swap vs shift on the owner's drum example: a region swap never
 *       moves the frame, a re-time stays visibly shifted;
 *   (e) a free (sub-Q) re-time moves the lane continuously — no tile,
 *       mark or cursor snaps to the grid, and the zero stays on it;
 *   (f) the frame.md §2 pictures (every top on the grid) are unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, SEAT_PICKUP_Q } from '../view_model.js';
import { SCENE_Q as Q, PERF } from './helpers.mjs';

const EPS = 1e-9;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < EPS, `${msg}: ${a} ≉ ${b}`);

const clip = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: Math.round(originQ * Q),
    duration: Math.round(durationQ * Q), effectiveQuantum: Q,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false,
    periodSource: 'own', ...extra,
});
const windowed = (id, originQ, durationQ, [aQ, bQ], extra = {}) =>
    clip(id, originQ, durationQ, {
        loopStart: Math.round(aQ * Q), loopEnd: Math.round(bQ * Q),
        windowActive: true, ...extra,
    });
const mapped = (id, originQ, durationQ, segsQ, extra = {}) =>
    clip(id, originQ, durationQ, {
        segments: segsQ.flat().map(v => Math.round(v * Q)),
        windowActive: true, ...extra,
    });
const topAt = q => ({ loopTop: Math.round(q * Q) });
// The raw clock sits 0.3Q into the seated frame's current pass.
const island = (nodes, clockQ = 55.3) => ({
    id: 'root', type: 'stack', quantum: Q, islandZero: 0, definerId: '',
    isPlaying: true, masterPos: 0, islandPos: Math.round(clockQ * Q),
    perf: PERF, nodes,
});
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);
const zeroQ = vm => vm.frameZero / Q;

/** The field topology with B's window slid by `slideQ` from [44, 49). */
function videoTopology(slideQ = 0) {
    return island([
        clip('A', 0, 1),                                   // 1Q scratch loop
        windowed('B', 11, 56, [44 + slideQ, 49 + slideQ]), // top 55Q at rest
        clip('C', 58, 5),                                  // 3Q into B's frame
    ]);
}

test('the pickup is a quarter of a Q', () => {
    assert.equal(SEAT_PICKUP_Q, 0.25);
});

test('(a) at rest: the windowed take seats the frame; C sits 3Q in', () => {
    const vm = deriveViewModel(videoTopology());
    assert.equal(zeroQ(vm), 55);
    assert.equal(vm.seatedZero, vm.frameZero, 'nothing pins or holds it');
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.cycleQ, 5);
    near(laneOf(vm, 'B').takeStartQ, 0, 'B top at the left edge');
    near(laneOf(vm, 'C').takeStartQ, 3, 'C 3Q in');
    near(vm.playheadQ, 0.3, 'cursor');
});

for (const slideQ of [-0.25, -0.15, +0.15, +0.49, +0.74]) {
    test(`(a) a ${slideQ > 0 ? '+' : '−'}${Math.abs(slideQ)}Q slide stays on the bar`, () => {
        const rest = deriveViewModel(videoTopology());
        const slid = deriveViewModel(videoTopology(slideQ));
        assert.equal(zeroQ(slid), zeroQ(rest), 'the zero does not re-seat');
        near(laneOf(slid, 'B').takeStartQ, slideQ < 0 ? 5 + slideQ : slideQ,
            'only B\'s seam moved (early: a pickup at the right end)');
        near(laneOf(slid, 'C').takeStartQ, 3, 'the later lane stays put');
        near(slid.playheadQ, rest.playheadQ, 'the cursor stays put');
    });
}

test('(a) past the pickup, a slide seats the frame on the line before', () => {
    const vm = deriveViewModel(videoTopology(-0.3));
    assert.equal(zeroQ(vm), 54, 'the zero moved one Q, and stays on the grid');
    near(laneOf(vm, 'B').takeStartQ, 0.7, 'B\'s top just after the left edge');
    near(laneOf(vm, 'C').takeStartQ, 4, 'the later lane follows (frame.md §5)');
});

test('(a) more than ¾Q late, the top is a pickup to the next line', () => {
    const vm = deriveViewModel(videoTopology(+0.8));
    assert.equal(zeroQ(vm), 56);
    near(laneOf(vm, 'B').takeStartQ, 4.8, 'B\'s top 0.2Q before the frame end');
    near(laneOf(vm, 'C').takeStartQ, 2, 'the later lane follows');
});

test('(a) the zero is the grid line at or before the top, ¼Q pickup', () => {
    for (let k = -39; k <= 39; k++) {
        const slideQ = k / 40;
        const vm = deriveViewModel(videoTopology(slideQ));
        const topQ = 55 + slideQ;
        near(zeroQ(vm), Math.round(zeroQ(vm)), `slide ${slideQ}: on the grid`);
        near(zeroQ(vm), Math.floor(topQ + 0.25 + EPS),
            `slide ${slideQ}: seated at or before B's top, ¼Q pickup`);
    }
});

test('(b) exactly ¼Q early is a pickup; a sample more is not', () => {
    // A lone windowed take performed at 10Q (the first lane seats
    // alone), its window placing the top at `topSamples`.
    const at = topSamples => island([clip('B', 10, 20, {
        loopStart: topSamples - 10 * Q, loopEnd: topSamples - 6 * Q,
        windowActive: true })]);
    assert.equal(deriveViewModel(at(14 * Q - Q / 4)).frameZero, 14 * Q,
        '¼Q early: the next line');
    assert.equal(deriveViewModel(at(14 * Q - Q / 4 - 1)).frameZero, 13 * Q,
        'a sample more: the line before');
    assert.equal(deriveViewModel(at(14 * Q + Math.round(0.74 * Q))).frameZero, 14 * Q,
        '¾Q late: still that line');
});

test('(b) the first lane seats on the line at or before its top', () => {
    // A lone windowed take, its top 0.3Q past a line: seated on that
    // line, the loop shows 0.3Q in. 0.8Q past: a pickup to the NEXT
    // line — its first 0.2Q at the right end.
    const at = offQ => deriveViewModel(island([windowed('B', 10, 20, [4 + offQ, 8 + offQ])]));
    let vm = at(0.3);
    assert.equal(zeroQ(vm), 14);
    near(laneOf(vm, 'B').takeStartQ, 0.3, 'top 0.3Q in');
    vm = at(0.6);
    assert.equal(zeroQ(vm), 14, 'nearest would have taken the next line');
    near(laneOf(vm, 'B').takeStartQ, 0.6, 'top 0.6Q in');
    vm = at(0.8);
    assert.equal(zeroQ(vm), 15);
    near(laneOf(vm, 'B').takeStartQ, 3.8, 'top 0.2Q before the frame end');
});

test('(c) a stored top seats the frame from its MOMENT', () => {
    // Map [4, 8) of a take performed at 10Q; the top on raw 6Q sounds
    // at 10 + 4 + (6 − 4) = 16Q. The splice (the region start) is 2Q
    // before it: the wrap sits 2Q into the 4Q frame.
    const vm = deriveViewModel(island([windowed('B', 10, 20, [4, 8], topAt(6))]));
    assert.equal(zeroQ(vm), 16);
    const b = laneOf(vm, 'B');
    near(b.topQ, 6, 'topQ: the raw top');
    near(b.topHeardQ, 0, 'the ↺ at the left edge');
    near(b.takeStartQ, 2, 'the splice 2Q in');
});

test('(c) absent loopTop, or one the kept set does not play, is the region start', () => {
    const base = deriveViewModel(island([windowed('B', 10, 20, [4, 8])]));
    assert.equal(zeroQ(base), 14, 'absent: origin + a0');
    near(laneOf(base, 'B').topQ, 4, 'topQ = the region start');
    near(laneOf(base, 'B').topHeardQ, 0);
    const atStart = deriveViewModel(island([windowed('B', 10, 20, [4, 8], topAt(4))]));
    assert.equal(atStart.frameZero, base.frameZero, 'loopTop = a0 derives alike');
    assert.deepEqual(laneOf(atStart, 'B').reps, laneOf(base, 'B').reps);
    for (const outside of [2, 8, 9]) {
        const vm = deriveViewModel(island([windowed('B', 10, 20, [4, 8], topAt(outside))]));
        assert.equal(vm.frameZero, base.frameZero, `top ${outside}Q (unplayed): the region start`);
        near(laneOf(vm, 'B').topQ, 4, `top ${outside}Q reads as the region start`);
    }
});

test('(c) a top after a cut sounds earlier by the cut; a top IN the cut is unplayed', () => {
    // Kept [4,6) + [7,9): raw 7.5 is heard 2.5Q after the top of the
    // map (the cut [6,7) removed) — at 10 + 4 + 2.5 = 16.5Q, seated on
    // 16 (0.5Q late), the ↺ 0.5Q in.
    const vm = deriveViewModel(island([mapped('B', 10, 20, [[4, 6], [7, 9]], topAt(7.5))]));
    assert.equal(zeroQ(vm), 16);
    near(laneOf(vm, 'B').topHeardQ, 0.5, 'the ↺ 0.5Q in');
    near(laneOf(vm, 'B').topQ, 7.5);
    const inCut = deriveViewModel(island([mapped('B', 10, 20, [[4, 6], [7, 9]], topAt(6.5))]));
    assert.equal(zeroQ(inCut), 14, 'a top in the cut: the region start');
    near(laneOf(inCut, 'B').topQ, 4);
});

test('(c) an unmapped take plays whole — its top is any raw sample', () => {
    // No window: the kept set is the whole 8Q take, so a stored top on
    // raw 3Q sounds at origin + 3Q (the panel start marker's case).
    const vm = deriveViewModel(island([clip('B', 10, 8, topAt(3))]));
    assert.equal(zeroQ(vm), 13);
    near(laneOf(vm, 'B').topHeardQ, 0, 'the ↺ at the left edge');
    near(laneOf(vm, 'B').takeStartQ, 5, 'raw 0 sounds 5Q in');
});

test('(c) stacks keep the region start', () => {
    const member = clip('m', 10, 8);
    const group = {
        id: 'G', name: 'G', type: 'stack', anchored: true,
        origin: 10 * Q, effectiveQuantum: Q, nodes: [member],
        loopStart: 4 * Q, loopEnd: 8 * Q, windowActive: true,
        loopBypassed: false, loopTop: 6 * Q,  // ignored: stacks store none
    };
    const vm = deriveViewModel(island([group]));
    assert.equal(zeroQ(vm), 14, 'the group seats from origin + a0');
    const g = laneOf(vm, 'G');
    near(g.topQ, 4, 'the group\'s top is its region start');
    near(g.topHeardQ, 0);
    assert.equal(g.canRetime, false, 'groups are never re-timed');
});

/* The owner's drum example (loop_selection.md §9.2, prototype v10): a
 * 4-bar bass (the first lane — its bar lines are every 4Q) and an
 * 8-bar drum take played ~40 ms (0.025Q) late from bar 4, looped to
 * bars 1–4. */
const drums = (segsQ, extra = {}) => island([
    clip('bass', 0, 4),
    mapped('drums', 4.025, 8, segsQ, extra),
], 4.3);

test('(d) the drums settle on the bass\'s bar lines, the late top just in', () => {
    const vm = deriveViewModel(drums([[0, 2], [2, 4]]));
    assert.equal(zeroQ(vm), 4, 'on the bass\'s bar line at or before 4.025');
    near(laneOf(vm, 'drums').topHeardQ, 0.025, '40 ms late shows 40 ms in');
});

test('(d) a swap never moves the frame; the top the swap keeps stays put', () => {
    const rest = deriveViewModel(drums([[0, 2], [2, 4]]));
    // Swap +1 bar: the region → bars 2–5, raw [1, 5). The reconcile
    // resets a dropped top to the region start (the engine publishes
    // loopTop = 1Q), which sounds where it was performed: 5.025Q.
    const swapped = deriveViewModel(drums([[1, 3], [3, 5]], topAt(1)));
    assert.equal(swapped.frameZero, rest.frameZero, 'the frame never moves');
    near(laneOf(swapped, 'drums').topHeardQ, 1.025, 'the ↺ on bar 2, where it was played');
    // A top the swapped region still plays keeps its sample and its
    // moment: raw 2 at 4.025 + 1 + 1.
    const kept = deriveViewModel(drums([[1, 3], [3, 5]], topAt(2)));
    assert.equal(kept.frameZero, rest.frameZero);
    near(laneOf(kept, 'drums').topHeardQ, 2.025);
});

test('(d) a shift stays visibly shifted against the bar lines', () => {
    // A +1 bar re-time moves the origin: the top now sounds at 5.025Q,
    // still on the bass's bar at 4 — one bar in, as it sounds.
    const vm = deriveViewModel(drums([[0, 2], [2, 4]], { origin: Math.round(5.025 * Q),
                                                         retime: Q }));
    assert.equal(zeroQ(vm), 4);
    const d = laneOf(vm, 'drums');
    near(d.topHeardQ, 1.025, 'the ↺ a bar in');
    near(d.retimeQ, 1, 'retimeQ reads the shift');
});

test('(e) a free re-time moves the lane continuously; the zero stays on the grid', () => {
    // B (a lone 4Q window from a 20Q take at 10Q) re-timed by 0.37Q:
    // the zero stays on 14 (within the band), and every heard position
    // moves by exactly 0.37Q — rotation, not snapping.
    const base = deriveViewModel(island([windowed('B', 10, 20, [4, 8])]));
    const shifted = deriveViewModel(island([windowed('B', 10.37, 20, [4, 8],
        { retime: Math.round(0.37 * Q) })]));
    assert.equal(shifted.frameZero, base.frameZero, 'the zero stays on the grid');
    const b0 = laneOf(base, 'B');
    const b1 = laneOf(shifted, 'B');
    near(b1.takeStartQ - b0.takeStartQ, 0.37, 'the splice moved 0.37Q');
    near(b1.topHeardQ - b0.topHeardQ, 0.37, 'the ↺ moved 0.37Q');
    near(b1.reps[0].srcTopFrac * 4 - b0.reps[0].srcTopFrac * 4, 0.37,
        'the heard tiles rotate by 0.37Q');
    near(b1.retimeQ, 0.37, 'retimeQ');
    // An unwindowed sub-Q take tiles at its exact phase too.
    const plain = deriveViewModel(island([clip('A', 0, 4), clip('P', 1.37, 4)], 0.1));
    near(laneOf(plain, 'P').takeStartQ, 1.37, 'the tile starts 1.37Q in');
    near(laneOf(plain, 'P').reps[0].endQ, 1.37, 'its wrapped predecessor ends there');
});

test('(f) frame.md §2 pictures are unchanged (every top on the grid)', () => {
    const cases = [
        // A is 1Q; B recorded, then shortened to 6Q..10Q → B |6|7|8|9|.
        { nodes: [clip('A', 0, 1), windowed('B', 1, 10, [6, 10])],
          cycleQ: 4, tops: { A: 0, B: 0 } },
        // A is a 4Q loop; B an 8Q take recorded on A's third Q.
        { nodes: [clip('A', 0, 4), clip('B', 2, 8)],
          cycleQ: 8, tops: { A: 0, B: 2 } },
        // B shortened to its first 4Q: still 2Q off.
        { nodes: [clip('A', 0, 4), windowed('B', 2, 8, [0, 4])],
          cycleQ: 4, tops: { A: 0, B: 2 } },
        // A is a 2Q loop; B a 4Q loop whose top falls 1Q after A's.
        { nodes: [clip('A', 0, 2), clip('B', 1, 4)],
          cycleQ: 4, tops: { A: 0, B: 1 } },
        // A is a 4Q loop; C a 6Q take recorded 2Q in (cycle 12Q).
        { nodes: [clip('A', 0, 4), clip('C', 2, 6)],
          cycleQ: 12, tops: { A: 0, C: 2 } },
        // A is a 2Q loop; B an 8Q take recorded 1Q late, windowed to
        // 1Q..5Q: B's top is a whole cycle of A off → the zero moves 2Q,
        // B lands at 0, A's picture is unchanged.
        { nodes: [clip('A', 0, 2), windowed('B', 1, 8, [1, 5])],
          cycleQ: 4, tops: { A: 0, B: 0 } },
    ];
    cases.forEach(({ nodes, cycleQ, tops }, i) => {
        const vm = deriveViewModel(island(nodes, 0.3));
        assert.equal(vm.cycleQ, cycleQ, `picture ${i + 1}: cycle`);
        for (const [id, q] of Object.entries(tops)) {
            near(laneOf(vm, id).takeStartQ, q, `picture ${i + 1}: ${id}`);
        }
    });
    // Unwindowed, the last picture's B sits 1Q in.
    const vm = deriveViewModel(island([clip('A', 0, 2), clip('B', 1, 8)], 0.3));
    near(laneOf(vm, 'B').takeStartQ, 1, 'unwindowed B at 1Q');
});
