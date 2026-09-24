/**
 * THE ZERO SEATS ON THE NEAREST GRID TOP (docs/frame.md §1).
 *
 * A map drag pins the frame zero; on release the pin drops and the
 * view re-seats from the lanes. The seating reads each lane's top on
 * the grid line NEAREST it, so a slide within ½Q of a grid line
 * releases with exactly the picture the pin showed: the edited loop's
 * seam moves, and nothing else — not the frame, not the other lanes,
 * not the cursor.
 *
 * The topology is the field one: a 1Q scratch loop first (it constrains
 * nothing), then a 56Q take windowed to 5Q (it seats the frame), then a
 * 5Q loop 3Q into that frame. What this pins:
 *   (a) −0.15Q and +0.15Q slides of the seating loop leave frameZero,
 *       the third lane and the cursor where they were; the loop top
 *       sits at 4.85Q (the pickup before the bar) / 0.15Q;
 *   (b) the released picture equals the pinned one (the drag preview);
 *   (c) a slide past ½Q re-seats — the zero stays on the Q grid;
 *   (d) the frame.md §2 pictures (every top on the grid) are unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
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
const windowed = (id, originQ, durationQ, [aQ, bQ]) => clip(id, originQ, durationQ, {
    loopStart: Math.round(aQ * Q), loopEnd: Math.round(bQ * Q), windowActive: true,
});
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

const pinnedAt = vm => ({ pinFrameQ: vm.cycleQ, pinFoldQ: vm.loopCycleQ,
                          pinZero: vm.frameZero });

test('at rest: the windowed take seats the frame; C sits 3Q in', () => {
    const vm = deriveViewModel(videoTopology());
    assert.equal(zeroQ(vm), 55);
    assert.equal(vm.cycleQ, 5);
    near(laneOf(vm, 'B').takeStartQ, 0, 'B top at the left edge');
    near(laneOf(vm, 'C').takeStartQ, 3, 'C 3Q in');
    near(vm.playheadQ, 0.3, 'cursor');
});

for (const slideQ of [-0.15, +0.15, -0.49, +0.49]) {
    test(`a ${slideQ > 0 ? '+' : '−'}${Math.abs(slideQ)}Q slide releases in place`, () => {
        const rest = deriveViewModel(videoTopology());
        const released = deriveViewModel(videoTopology(slideQ));
        assert.equal(zeroQ(released), zeroQ(rest), 'the zero does not re-seat');
        near(laneOf(released, 'B').takeStartQ, slideQ < 0 ? 5 + slideQ : slideQ,
            'only B\'s seam moved');
        near(laneOf(released, 'C').takeStartQ, 3, 'the later lane stays put');
        near(released.playheadQ, rest.playheadQ, 'the cursor stays put');
        // THE PIN AGREES: the preview the drag showed (the zero pinned
        // at its drag-start value, the slid geometry live-committed) is
        // the picture the release settles on.
        const pinned = deriveViewModel(videoTopology(slideQ), pinnedAt(rest));
        assert.equal(pinned.frameZero, released.frameZero);
        for (const id of ['A', 'B', 'C']) {
            near(laneOf(pinned, id).takeStartQ, laneOf(released, id).takeStartQ,
                `${id}: pinned = released`);
        }
        near(pinned.playheadQ, released.playheadQ, 'cursor: pinned = released');
    });
}

test('a −0.6Q slide passes the half: the frame re-seats on the nearer line', () => {
    const vm = deriveViewModel(videoTopology(-0.6));
    assert.equal(zeroQ(vm), 54, 'the zero moved one Q, and stays on the grid');
    near(laneOf(vm, 'B').takeStartQ, 0.4, 'B shows its short wrap at the left');
    near(laneOf(vm, 'C').takeStartQ, 4, 'the later lane follows (frame.md §5)');
});

test('the zero stays on the Q grid whatever a slide does', () => {
    for (let k = -19; k <= 19; k++) {
        if (Math.abs(k) === 10) continue;  // exactly ½Q: the tie, not pinned
        const slideQ = k / 20;
        const vm = deriveViewModel(videoTopology(slideQ));
        near(zeroQ(vm), Math.round(zeroQ(vm)), `slide ${slideQ.toFixed(2)}: on the grid`);
        const topQ = 55 + slideQ;
        near(vm.frameZero / Q, Math.round(topQ),
            `slide ${slideQ.toFixed(2)}: seated on the grid line nearest B's top`);
    }
});

test('the first lane seats on its nearest grid line too', () => {
    // A lone windowed take, its top 0.3Q past a line: seated on that
    // line, the loop shows 0.3Q in. 0.7Q past: seated on the NEXT line,
    // the loop's first 0.3Q is the pickup at the right end.
    const at = offQ => deriveViewModel(island([windowed('B', 10, 20, [4 + offQ, 8 + offQ])]));
    let vm = at(0.3);
    assert.equal(zeroQ(vm), 14);
    near(laneOf(vm, 'B').takeStartQ, 0.3, 'top 0.3Q in');
    vm = at(0.7);
    assert.equal(zeroQ(vm), 15);
    near(laneOf(vm, 'B').takeStartQ, 3.7, 'top 0.3Q before the frame end');
});

test('frame.md §2 pictures are unchanged (every top on the grid)', () => {
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
