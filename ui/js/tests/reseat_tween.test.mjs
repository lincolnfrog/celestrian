/**
 * THE RE-SEAT TWEEN (docs/frame.md §1; loop_selection.md §13.2; owner
 * 2026-10-01; session_view/reseat_tween.js + view_model
 * resolveFrameZero).
 *
 * When the frame's zero moves, the frame is DRAWN moving onto the new
 * seat — every lane, the ruler and the cursor together, ~200 ms — and
 * never jumps sideways. Nothing is held and nothing waits: the move
 * begins on the render that would have jumped. Each render here is the
 * app's (app.js deriveFrame): reseatOptions → deriveViewModel →
 * noteReseat, derived once more when noteReseat says so, with the clock
 * injected.
 *
 * What this pins:
 *   (a) the path: eased, the shortest way modulo the frame, landing
 *       exactly on the seat;
 *   (b) the precedence drag pin ?? tween ?? seat; no tween under a take
 *       (live or armed) or in the Q13 trim view;
 *   (c) the move: the render that would have jumped draws the zero on
 *       screen, the next ones carry the whole picture across, the last
 *       lands on the seat and the tween is over;
 *   (d) what JUMPS, as it always has: the first frame, a seat a whole
 *       number of frames away (the same picture), a re-layout (the
 *       frame's length or Q changed in the same step), a take live or
 *       armed, another island, reduced motion, a hidden page;
 *   (e) never under a hand: no move begins, and one in motion completes
 *       at once;
 *   (f) the seat moving again mid-move carries on from the zero on
 *       screen; a re-layout mid-move gives way;
 *   (g) the zero is relative to the island zero: a seek carries a move;
 *   (h) the ruler and the gridlines ride it, each line named where it
 *       lands; the arm marker stays on the island grid;
 *   (i) the frame facts a placement lands on (seek.js seekApplied)
 *       carry the zero at rest through a seek.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, reseatZero, reseatLanding, easeInOut }
    from '../view_model.js';
import { posMod } from '../math_utils.js';
import { reseatOptions, noteReseat, reseatInMotion, reseatState,
         resetReseat, RESEAT_MS } from '../session_view/reseat_tween.js';
import { seekApplied } from '../seek.js';
import { SCENE_Q as Q, PERF } from './helpers.mjs';

const EPS = 1e-9;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≉ ${b}`);

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

/** A 1Q loop; B — a 56Q take from 11Q looped to `lenQ` Qs from raw
 * (44 + slideQ): the first loop longer than Q, so it PLACES the frame,
 * its ↺ (the region start) at (55 + slideQ)Q; and C, 5Q from 58Q, which
 * slots in. A 5Q frame. `slideQ` swaps B's region; `seekQ` is a seek
 * (the island zero and every origin move together). */
function island({ slideQ = 0, lenQ = 5, seekQ = 0, extra = {} } = {}) {
    const at = q => q - seekQ;
    return {
        id: 'root', type: 'stack', quantum: Q, islandZero: Math.round(at(0) * Q),
        definerId: '', isPlaying: true, masterPos: 0,
        islandPos: Math.round(55.3 * Q), perf: PERF,
        nodes: [
            clip('A', at(0), 1),
            windowed('B', at(11), 56, [44 + slideQ, 44 + slideQ + lenQ]),
            clip('C', at(58), 5, extra.C || {}),
        ],
    };
}
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

/** One app render (app.js deriveFrame) at `now`. */
function render(state, { now = 0, handDown = false, reducedMotion = false,
                         hidden = false, opts = {} } = {}) {
    const motion = { now, islandId: state.id, handDown, reducedMotion, hidden };
    const derive = () => deriveViewModel(state,
        { reseat: reseatOptions(motion), ...opts });
    let vm = derive();
    if (noteReseat(vm, motion)) {
        vm = derive();
        noteReseat(vm, motion);
    }
    return vm;
}

/* ---------- (a) the path ---------- */

test('(a) easeInOut runs 0 → 1, symmetric about ½, slow at both ends', () => {
    near(easeInOut(0), 0, 'starts at 0');
    near(easeInOut(1), 1, 'ends at 1');
    near(easeInOut(0.5), 0.5, 'half way');
    near(easeInOut(0.25) + easeInOut(0.75), 1, 'symmetric');
    assert.ok(easeInOut(0.1) < 0.1, 'slow start');
    assert.ok(easeInOut(0.9) > 0.9, 'slow end');
    // No frame of a 12-frame move covers more than a seventh of it.
    let worst = 0;
    for (let k = 0; k < 12; k++) {
        worst = Math.max(worst, easeInOut((k + 1) / 12) - easeInOut(k / 12));
    }
    assert.ok(worst < 1 / 7, 'never the jump it replaces: ' + worst);
});

test('(a) the move takes the shortest way and lands on the seat exactly', () => {
    const F = 5 * Q;
    // 1Q ahead: straight there.
    near(reseatZero(55 * Q, 56 * Q, F, 0), 55 * Q, 't=0: where it was');
    near(reseatZero(55 * Q, 56 * Q, F, 0.5), 55.5 * Q, 't=½: half way');
    assert.equal(reseatZero(55 * Q, 56 * Q, F, 1), 56 * Q, 't=1: the seat');
    // 4Q ahead in a 5Q frame is 1Q BACK the short way: the move heads
    // for 54Q (the same picture as 59Q) and lands on 59Q itself.
    near(reseatZero(55 * Q, 59 * Q, F, 0.5), 54.5 * Q, 'back, not forward');
    assert.ok(reseatZero(55 * Q, 59 * Q, F, 0.99) < 55 * Q, 'still the short way');
    assert.equal(reseatZero(55 * Q, 59 * Q, F, 1), 59 * Q, 'lands on the seat');
    near(reseatLanding(55 * Q, 59 * Q, F), 54 * Q, 'the landing: the near one');
    // A seat whole frames away is already the same picture: no motion.
    near(reseatZero(55 * Q, 65 * Q, F, 0.5), 55 * Q, 'two frames on: nothing moves');
    assert.equal(reseatZero(55 * Q, 65 * Q, F, 1), 65 * Q);
    // Past the end, and before the start.
    assert.equal(reseatZero(55 * Q, 56 * Q, F, 7), 56 * Q);
    near(reseatZero(55 * Q, 56 * Q, F, -1), 55 * Q, 't<0 clamps');
});

/* ---------- (b) precedence ---------- */

test('(b) drag pin ?? tween ?? seat', () => {
    const s = island({ slideQ: -1 });  // the seat: 54Q
    const seat = deriveViewModel(s);
    assert.equal(seat.frameZeroSource, 'seat');
    assert.equal(seat.frameZero, 54 * Q);
    assert.equal(seat.frameTweening, false);
    const reseat = { fromRel: 56 * Q, t: 0.5 };
    const pin = { pinFrameQ: 5, pinFoldQ: 5, pinZero: 50 * Q };
    assert.equal(seat.restZero, 54 * Q, 'at rest: the zero drawn');
    let vm = deriveViewModel(s, { reseat });
    assert.equal(vm.frameZeroSource, 'tween');
    assert.equal(vm.frameTweening, true);
    near(vm.frameZero, 55 * Q, 'half way from 56Q to 54Q');
    assert.equal(vm.seatedZero, 54 * Q, 'the seat is still published');
    // WHERE THE FRAME RESTS mid-move is the seat it is moving to: what
    // a drag pins and a placement lands on — never the passing zero.
    assert.equal(vm.restZero, 54 * Q);
    vm = deriveViewModel(s, { reseat, ...pin });
    assert.equal(vm.frameZeroSource, 'pin');
    assert.equal(vm.frameZero, 50 * Q);
    assert.equal(vm.frameTweening, false);
    assert.equal(vm.restZero, 50 * Q, 'pinned: the pin');
    // Landed: the seat itself, and no longer moving.
    vm = deriveViewModel(s, { reseat: { fromRel: 56 * Q, t: 1 } });
    assert.equal(vm.frameZero, 54 * Q);
    assert.equal(vm.frameTweening, false);
    assert.equal(vm.restZero, 54 * Q);
});

test('(b) no tween under a take, live or armed, nor in the Q13 trim view', () => {
    const reseat = { fromRel: 56 * Q, t: 0.5 };
    const armed = island({ slideQ: -1, extra: { C: { isPendingStart: true } } });
    let vm = deriveViewModel(armed, { reseat });
    assert.equal(vm.frameZeroSource, 'seat', 'an armed take: the seat');
    assert.equal(vm.frameTweening, false);
    const rec = island({ slideQ: -1 });
    rec.nodes.push(clip('R', 60, 0.5, { isRecording: true }));
    vm = deriveViewModel(rec, { reseat });
    assert.equal(vm.frameZeroSource, 'seat', 'a live take: the seat');
    assert.equal(vm.frameZero, vm.seatedZero);
    // The sole committed clip, provisional: the trim view maps the one
    // cursor into its selection from the island zero the re-trim sets.
    const trim = {
        id: 'root', type: 'stack', quantum: Q, islandZero: 3 * Q, definerId: 'D',
        isPlaying: true, masterPos: 0, islandPos: Math.round(0.3 * Q), perf: PERF,
        nodes: [clip('D', 2, 3, { loopStart: Q, loopEnd: 2 * Q, windowActive: true })],
    };
    vm = deriveViewModel(trim, { reseat: { fromRel: 9 * Q, t: 0.5 } });
    assert.equal(vm.provisionalDefiner, true);
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 3 * Q, 'the definer\'s top: the island zero');
});

/* ---------- (c) the move ---------- */

test('(c) the render that would have jumped starts the move; the whole ' +
     'picture crosses; it lands on the seat and is over', () => {
    resetReseat();
    let vm = render(island(), { now: 0 });
    assert.equal(vm.frameZeroSource, 'seat', 'the first frame: the seat');
    assert.equal(vm.frameZero, 55 * Q);
    assert.equal(reseatInMotion(), false);
    near(laneOf(vm, 'C').takeStartQ, 3, 'C slots in 3Q along');
    near(vm.playheadQ, 0.3, 'the cursor');
    // B's region is swapped 1Q on: its ↺ resets to the new start, the
    // seat is 56Q. The render that would have jumped draws 55Q still.
    const swapped = island({ slideQ: 1 });
    vm = render(swapped, { now: 1000 });
    assert.equal(vm.frameZeroSource, 'tween');
    assert.equal(vm.frameTweening, true);
    assert.equal(vm.frameZero, 55 * Q, 'the zero on screen: no jump');
    assert.equal(vm.seatedZero, 56 * Q, 'on its way to the seat');
    assert.equal(reseatInMotion(), true);
    near(laneOf(vm, 'C').takeStartQ, 3, 'C has not moved yet');
    // Half time, half way: every lane and the cursor ½Q along.
    vm = render(swapped, { now: 1000 + RESEAT_MS / 2 });
    near(vm.frameZero, 55.5 * Q, 'half way at half time');
    assert.equal(vm.frameTweening, true);
    near(laneOf(vm, 'C').takeStartQ, 2.5, 'C rides the move');
    near(laneOf(vm, 'B').topHeardQ, 0.5, 'the ↺ that moved the seat rides it in');
    near(vm.playheadQ, 4.8, 'the cursor rides it (through the frame\'s edge)');
    // Landed: the seat exactly, and the tween is over.
    vm = render(swapped, { now: 1000 + RESEAT_MS });
    assert.equal(vm.frameZero, 56 * Q, 'landed exactly on the seat');
    assert.equal(vm.frameTweening, false);
    assert.equal(reseatInMotion(), false);
    near(laneOf(vm, 'C').takeStartQ, 2, 'C, 2Q along the new frame');
    near(laneOf(vm, 'B').topHeardQ, 0, 'the ↺ at the left edge');
    vm = render(swapped, { now: 5000 });
    assert.equal(vm.frameZeroSource, 'seat', 'at rest again');
    assert.equal(vm.frameZero, 56 * Q);
});

test('(c) a late frame lands: progress is wall-clock time', () => {
    // Animation frames throttled (a background tab, the app's own
    // browser pane): the next render, whenever it comes, is on the seat.
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 1000 });
    const vm = render(island({ slideQ: 1 }), { now: 1000 + 40 * RESEAT_MS });
    assert.equal(vm.frameZero, 56 * Q);
    assert.equal(reseatInMotion(), false);
});

/* ---------- (d) what jumps ---------- */

test('(d) a seat that did not move, or moved whole frames, starts nothing', () => {
    resetReseat();
    render(island(), { now: 0 });
    let vm = render(island(), { now: 50 });
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(reseatInMotion(), false);
    // B's region swapped a whole frame on (5Q): the same picture.
    vm = render(island({ slideQ: 5 }), { now: 100 });
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 60 * Q, 'the seat, at once');
    assert.equal(reseatInMotion(), false);
    // A sub-Q slide inside the pickup: the seat stays on its line.
    vm = render(island({ slideQ: 5.2 }), { now: 150 });
    assert.equal(vm.frameZero, 60 * Q);
    assert.equal(reseatInMotion(), false);
});

test('(d) a re-layout jumps: the frame\'s length, or Q, changed in the same step', () => {
    resetReseat();
    render(island(), { now: 0 });
    // B trimmed to 4Q from 1Q on: the frame is lcm(4, 5) = 20Q now, and
    // the seat moved — a re-layout, not a move.
    let vm = render(island({ slideQ: 1, lenQ: 4 }), { now: 100 });
    assert.equal(vm.cycleQ, 20);
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 56 * Q, 'the seat, at once');
    assert.equal(reseatInMotion(), false);
    // The same frame, another seat: THAT moves.
    vm = render(island({ slideQ: 2, lenQ: 4 }), { now: 200 });
    assert.equal(vm.frameZeroSource, 'tween');
    render(island({ slideQ: 2, lenQ: 4 }), { now: 200 + RESEAT_MS });
    // A Q change re-lays everything out.
    resetReseat();
    render(island(), { now: 0 });
    const halved = island({ slideQ: 1 });
    halved.quantum = Q / 2;
    vm = render(halved, { now: 100 });
    assert.equal(vm.frameZeroSource, 'seat', 'another grid: the seat, at once');
    assert.equal(reseatInMotion(), false);
});

test('(d) under a take, live or armed, the frame jumps', () => {
    resetReseat();
    render(island(), { now: 0 });
    const armed = island({ slideQ: 1, extra: { C: { isPendingStart: true } } });
    let vm = render(armed, { now: 100 });
    assert.equal(vm.mapEditsLocked, true);
    assert.equal(vm.frameZeroSource, 'seat', 'armed: the seat, at once');
    assert.equal(vm.frameZero, 56 * Q);
    assert.equal(reseatInMotion(), false);
    resetReseat();
    render(island(), { now: 0 });
    const rec = island({ slideQ: 1 });
    rec.nodes.push(clip('R', 60, 0.5, { isRecording: true }));
    vm = render(rec, { now: 100 });
    assert.equal(vm.frameZeroSource, 'seat', 'recording: the seat, at once');
    assert.equal(reseatInMotion(), false);
});

test('(d) another island, reduced motion and a hidden page jump', () => {
    resetReseat();
    render(island(), { now: 0 });
    const other = { ...island({ slideQ: 1 }), id: 'another-root' };
    let vm = render(other, { now: 100 });
    assert.equal(vm.frameZeroSource, 'seat', 'nothing carried over');
    assert.equal(vm.frameZero, 56 * Q);
    assert.equal(reseatInMotion(), false);
    for (const env of [{ reducedMotion: true }, { hidden: true }]) {
        resetReseat();
        render(island(), { now: 0, ...env });
        vm = render(island({ slideQ: 1 }), { now: 100, ...env });
        assert.equal(vm.frameZeroSource, 'seat', JSON.stringify(env));
        assert.equal(vm.frameZero, 56 * Q);
        assert.equal(reseatInMotion(), false);
    }
});

/* ---------- (e) never under a hand ---------- */

test('(e) no move begins under a hand; the next render at rest moves', () => {
    resetReseat();
    render(island(), { now: 0 });
    // A drag's pin holds 55Q while its live commits move the seat.
    const pin = { pinFrameQ: 5, pinFoldQ: 5, pinZero: 55 * Q };
    let vm = render(island({ slideQ: 1 }), { now: 100, handDown: true, opts: pin });
    assert.equal(vm.frameZeroSource, 'pin');
    assert.equal(vm.frameZero, 55 * Q);
    assert.equal(reseatInMotion(), false, 'nothing moves under the hand');
    // A hand with no pin (a gesture that commits on release): the seat.
    resetReseat();
    render(island(), { now: 0 });
    vm = render(island({ slideQ: 1 }), { now: 100, handDown: true });
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(reseatInMotion(), false);
    // The pin lets go: the frame moves from the pinned zero to the seat.
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 100, handDown: true, opts: pin });
    vm = render(island({ slideQ: 1 }), { now: 200 });
    assert.equal(vm.frameZeroSource, 'tween', 'the release: a move, not a jump');
    assert.equal(vm.frameZero, 55 * Q);
    vm = render(island({ slideQ: 1 }), { now: 200 + RESEAT_MS });
    assert.equal(vm.frameZero, 56 * Q);
});

test('(e) a move in motion completes when a hand comes down', () => {
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 100 });
    render(island({ slideQ: 1 }), { now: 100 + RESEAT_MS / 4 });
    assert.equal(reseatInMotion(), true);
    // The pin captured the move's TARGET (patch.js noteFrame).
    const pin = { pinFrameQ: 5, pinFoldQ: 5, pinZero: 56 * Q };
    const vm = render(island({ slideQ: 1 }),
        { now: 100 + RESEAT_MS / 3, handDown: true, opts: pin });
    assert.equal(reseatInMotion(), false, 'no move under the hand');
    assert.equal(vm.frameZeroSource, 'pin');
    assert.equal(vm.frameZero, 56 * Q, 'on the target, grid-true');
    assert.equal(vm.frameTweening, false);
});

/* ---------- (f) the seat moves again ---------- */

test('(f) the seat moving again mid-move carries on from the zero on screen', () => {
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 1000 });                    // 55 → 56
    const mid = render(island({ slideQ: 1 }), { now: 1000 + RESEAT_MS / 2 });
    near(mid.frameZero, 55.5 * Q, 'half way');
    // An undo of the swap, then a swap the other way: the seat is 54Q.
    let vm = render(island({ slideQ: -1 }), { now: 1000 + RESEAT_MS / 2 + 5 });
    assert.equal(vm.frameZeroSource, 'tween');
    near(vm.frameZero, mid.frameZero, 'from the zero on screen: no jump');
    assert.equal(vm.seatedZero, 54 * Q);
    near(reseatState().tween.fromRel, 55.5 * Q, 'a new move, from here');
    vm = render(island({ slideQ: -1 }), { now: 1000 + RESEAT_MS / 2 + 5 + RESEAT_MS / 2 });
    near(vm.frameZero, 54.75 * Q, 'half way again');
    vm = render(island({ slideQ: -1 }), { now: 1000 + RESEAT_MS / 2 + 5 + RESEAT_MS });
    assert.equal(vm.frameZero, 54 * Q, 'landed on the new seat');
    assert.equal(reseatInMotion(), false);
});

test('(f) the seat moving back to the zero on screen ends the move there', () => {
    resetReseat();
    render(island(), { now: 0 });
    let vm = render(island({ slideQ: 1 }), { now: 1000 });   // begins: 55Q drawn
    assert.equal(vm.frameZero, 55 * Q);
    vm = render(island(), { now: 1010 });                    // undone at once
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 55 * Q, 'already there');
    assert.equal(reseatInMotion(), false);
});

test('(f) a re-layout mid-move gives way: the seat, at once', () => {
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 1000 });
    render(island({ slideQ: 1 }), { now: 1000 + RESEAT_MS / 4 });
    const vm = render(island({ slideQ: 1, lenQ: 4 }), { now: 1000 + RESEAT_MS / 2 });
    assert.equal(vm.cycleQ, 20);
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 56 * Q);
    assert.equal(reseatInMotion(), false);
    // …and a take coming up mid-move.
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 1000 });
    const armed = island({ slideQ: 1, extra: { C: { isPendingStart: true } } });
    const live = render(armed, { now: 1000 + RESEAT_MS / 2 });
    assert.equal(live.frameZeroSource, 'seat');
    assert.equal(live.frameZero, 56 * Q, 'the take\'s frame is the seat');
    assert.equal(reseatInMotion(), false);
});

/* ---------- (g) a seek ---------- */

test('(g) the zero is relative to the island zero: a seek carries the move, ' +
     'and starts none', () => {
    resetReseat();
    render(island(), { now: 0 });
    // A seek alone: the island zero and every origin move back 7.25Q.
    let vm = render(island({ seekQ: 7.25 }), { now: 100 });
    assert.equal(vm.frameZeroSource, 'seat', 'the transport moved, not the frame');
    assert.equal(reseatInMotion(), false);
    near(vm.frameZero, (55 - 7.25) * Q, 'the zero rode the seek');
    // A move, and a seek half way through it.
    resetReseat();
    render(island(), { now: 0 });
    render(island({ slideQ: 1 }), { now: 1000 });
    vm = render(island({ slideQ: 1, seekQ: 7.25 }), { now: 1000 + RESEAT_MS / 2 });
    assert.equal(vm.frameZeroSource, 'tween');
    near(vm.frameZero, (55.5 - 7.25) * Q, 'half way, carried by the seek');
    near(laneOf(vm, 'C').takeStartQ, 2.5, 'the picture is the move\'s own');
    vm = render(island({ slideQ: 1, seekQ: 7.25 }), { now: 1000 + RESEAT_MS });
    near(vm.frameZero, (56 - 7.25) * Q, 'landed on the seat');
    assert.equal(reseatInMotion(), false);
});

/* ---------- (h) the grid rides the move ---------- */

test('(h) the ruler and gridlines ride the move: every tick on an island ' +
     'Q line of the zero drawn, each named where it lands', () => {
    const s = island({ slideQ: -1 });  // the seat: 54Q; a 5Q frame
    const at = t => deriveViewModel(s, { reseat: { fromRel: 56 * Q, t } });
    const row = tk => [+tk.q.toFixed(9), tk.at, tk.major, tk.end];
    const landed = at(1);
    assert.equal(landed.frameZero, 54 * Q);
    assert.deepEqual(landed.ruler.ticks.map(row),
        [[0, 0, true, false], [1, 1, false, false], [2, 2, false, false],
         [3, 3, false, false], [4, 4, true, false], [5, 5, false, true]],
        'at rest: whole Qs from the left edge, named in place');
    const names = new Map();  // island line (Q) → where it lands
    let moved = 0;
    for (const t of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
        const vm = at(t);
        const zQ = vm.frameZero / Q;
        assert.ok(vm.frameTweening, `t=${t}: moving`);
        assert.ok(vm.ruler.ticks.length >= 5, `t=${t}: the frame keeps its lines`);
        for (const tk of vm.ruler.ticks) {
            // THE ZERO DRAWN: the tick sits on the island grid — the same
            // (line − zero) / Q the tiles and the cursor are drawn at.
            const line = zQ + tk.q;
            near(line, Math.round(line), `t=${t}: tick ${tk.q} on an island line`);
            assert.ok(tk.q > -EPS && tk.q < 5 + EPS, `t=${t}: inside the frame`);
            if (Math.abs(tk.q - Math.round(tk.q)) > 0.1) moved++;
            // NAMED WHERE IT LANDS: its place in the frame from the seat,
            // 54Q — the landing frame's wrap wears the cycle-end label.
            const lands = posMod(Math.round(line) - 54, 5);
            assert.equal(tk.end ? 0 : tk.at, lands, `t=${t}: line ${Math.round(line)}Q`);
            assert.equal(tk.end, lands === 0 && tk.q > EPS);
            assert.equal(tk.major, tk.at % 4 === 0);
            const k = Math.round(line);
            if (names.has(k)) assert.equal(names.get(k), lands, 'a line keeps its name');
            names.set(k, lands);
        }
    }
    assert.ok(moved >= 10, 'mid-move the lines sit between the frame\'s whole Qs');
});

test('(h) mid-move the arm marker stays on the island grid', () => {
    const s = island({ slideQ: -1 });
    const vm = deriveViewModel(s, { reseat: { fromRel: 56 * Q, t: 0.4 } });
    const zQ = vm.frameZero / Q;
    assert.ok(Math.abs(zQ - Math.round(zQ)) > 0.1, 'the zero is mid-move');
    const armIsland = zQ + vm.armAtQ;
    near(armIsland, Math.round(armIsland), 'the marker sits on an island grid line');
    assert.ok(vm.armAtQ > vm.playheadQ - EPS, 'ahead of the cursor');
    assert.ok(vm.armAtQ - vm.playheadQ <= 1 + EPS, 'the next line');
});

/* ---------- (i) the frame facts ---------- */

test('(i) a seek moves every zero the frame facts carry — the rest one too', () => {
    const frame = { zero: 55.5 * Q, rest: 56 * Q, seat: 56 * Q,
                    rawClock: 60 * Q, loopSamples: 5 * Q, quantum: Q };
    const out = seekApplied(frame, { advance: 2 * Q, clock: 61 * Q });
    assert.equal(out.zero, 53.5 * Q);
    assert.equal(out.rest, 54 * Q, 'a placement lands on the moved frame');
    assert.equal(out.seat, 54 * Q);
    assert.equal(out.rawClock, 61 * Q);
    // Facts without one (older callers) are left as they are.
    const bare = seekApplied({ zero: 5 * Q, rawClock: 0, loopSamples: Q },
                             { advance: Q, clock: 1 });
    assert.equal('rest' in bare, false);
});
