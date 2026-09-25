/**
 * THE EDIT HOLD AND THE SETTLE (docs/frame.md §1; loop_selection.md
 * P2.1; session_view/frame_hold.js + view_model resolveFrameZero).
 *
 * While a lane is selected its edits never re-seat the frame; when the
 * selection changes or clears, or a take arms, the frame settles once —
 * gliding the shortest way round the frame onto the seat. Each render
 * here is the app's (deriveFrame): frameHoldOptions → deriveViewModel →
 * noteFrameShown, with the clock injected.
 *
 * What this pins:
 *   (a) the settle's path: eased, the shortest way modulo the frame,
 *       landing exactly on the seat;
 *   (b) the precedence drag pin ?? settle ?? hold ?? seat, and the hold
 *       suspended while a take is live or armed, void across a Q change;
 *   (c) the hold: begun at the zero on screen, deaf to every edit,
 *       carried by a seek (it is relative to the island zero);
 *   (d) the releases — another lane, a clear, a take — each settle once,
 *       and a new hold captures the glide's TARGET;
 *   (e) never under a hand: a grab that selects re-keys the hold, a
 *       release waits for the hand, a glide in motion completes;
 *   (f) reduced motion jumps; a frame already seated does not glide; a
 *       new island starts clean; the arm marker stays on the island
 *       grid mid-glide;
 *   (g) the ruler and the gridlines ride the glide: every tick on an
 *       island Q line of the zero drawn, each named where it lands.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, settleZero, easeInOut, buildRulerTicks }
    from '../view_model.js';
import { posMod } from '../math_utils.js';
import { frameHoldOptions, noteFrameShown, settleInMotion, frameHoldState,
         resetFrameHold, SETTLE_MS } from '../session_view/frame_hold.js';
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

/** The field topology: a 1Q scratch loop, B (a 56Q take windowed to
 * 5Q, its top at 55Q) seats the frame, C 3Q in. `slideQ` slides B's
 * window; `zeroQ` is the island zero (a seek moves it and every origin
 * together, by `seekQ`). */
function island({ slideQ = 0, seekQ = 0, extra = {} } = {}) {
    const at = q => q - seekQ;
    return {
        id: 'root', type: 'stack', quantum: Q, islandZero: Math.round(at(0) * Q),
        definerId: '', isPlaying: true, masterPos: 0,
        islandPos: Math.round(55.3 * Q), perf: PERF,
        nodes: [
            clip('A', at(0), 1),
            windowed('B', at(11), 56, [44 + slideQ, 49 + slideQ]),
            clip('C', at(58), 5, extra.C || {}),
        ],
    };
}
const rootFrameOf = s => s.islandZero ?? s.origin ?? 0;
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

/** One app render (app.js deriveFrame) at `now`. */
function render(state, { key = null, takeActive = false, handDown = false,
                         now = 0, reducedMotion = false, opts = {} } = {}) {
    const { hold, settle } = frameHoldOptions({
        key, takeActive, handDown, now, reducedMotion, islandId: state.id });
    const vm = deriveViewModel(state, { hold, settle, ...opts });
    noteFrameShown(vm, rootFrameOf(state), now);
    return vm;
}

/* ---------- (a) the path ---------- */

test('(a) easeInOut is the cubic ease, symmetric about ½', () => {
    assert.equal(easeInOut(0), 0);
    assert.equal(easeInOut(1), 1);
    near(easeInOut(0.5), 0.5, 'half way');
    near(easeInOut(0.25) + easeInOut(0.75), 1, 'symmetric');
    assert.ok(easeInOut(0.1) < 0.1, 'slow start');
});

test('(a) the settle glides the shortest way and lands on the seat exactly', () => {
    const F = 5 * Q;
    // 1Q ahead: straight there.
    near(settleZero(55 * Q, 56 * Q, F, 0), 55 * Q, 't=0: where it was');
    near(settleZero(55 * Q, 56 * Q, F, 0.5), 55.5 * Q, 't=½: half way');
    assert.equal(settleZero(55 * Q, 56 * Q, F, 1), 56 * Q, 't=1: the seat');
    // 4Q ahead in a 5Q frame is 1Q BACK the short way: the glide heads
    // for 54Q (the same picture as 59Q) and lands on 59Q itself.
    near(settleZero(55 * Q, 59 * Q, F, 0.5), 54.5 * Q, 'back, not forward');
    assert.ok(settleZero(55 * Q, 59 * Q, F, 0.99) < 55 * Q, 'still the short way');
    assert.equal(settleZero(55 * Q, 59 * Q, F, 1), 59 * Q, 'lands on the seat');
    // A seat whole frames away is already the same picture: no motion.
    near(settleZero(55 * Q, 65 * Q, F, 0.5), 55 * Q, 'two frames on: nothing moves');
    assert.equal(settleZero(55 * Q, 65 * Q, F, 1), 65 * Q);
    // Past the end, and before the start.
    assert.equal(settleZero(55 * Q, 56 * Q, F, 7), 56 * Q);
    near(settleZero(55 * Q, 56 * Q, F, -1), 55 * Q, 't<0 clamps');
});

/* ---------- (b) precedence ---------- */

test('(b) drag pin ?? settle ?? hold ?? seat', () => {
    const s = island({ slideQ: -0.3 });  // seated alone: 54Q
    const seat = deriveViewModel(s);
    assert.equal(seat.frameZeroSource, 'seat');
    assert.equal(seat.frameZero, 54 * Q);
    const hold = { zeroRel: 55 * Q, quantum: Q };
    const settle = { fromRel: 56 * Q, t: 0.5 };
    const pin = { pinFrameQ: 5, pinFoldQ: 5, pinZero: 50 * Q };
    let vm = deriveViewModel(s, { hold });
    assert.equal(vm.frameZeroSource, 'hold');
    assert.equal(vm.frameZero, 55 * Q);
    assert.equal(vm.seatedZero, 54 * Q, 'the seat is still published');
    vm = deriveViewModel(s, { hold, settle });
    assert.equal(vm.frameZeroSource, 'settle');
    assert.equal(vm.frameSettling, true);
    near(vm.frameZero, 55 * Q, 'half way from 56Q to 54Q');
    vm = deriveViewModel(s, { hold, settle, ...pin });
    assert.equal(vm.frameZeroSource, 'pin');
    assert.equal(vm.frameZero, 50 * Q);
    assert.equal(vm.seatedZero, 54 * Q);
});

test('(b) a take suspends the hold; a Q change voids it', () => {
    const hold = { zeroRel: 55 * Q, quantum: Q };
    const armed = island({ slideQ: -0.3, extra: { C: { isPendingStart: true } } });
    assert.equal(deriveViewModel(armed, { hold }).frameZeroSource, 'seat',
        'an armed take: the seat');
    const rec = island({ slideQ: -0.3 });
    rec.nodes.push(clip('R', 60, 0.5, { isRecording: true }));
    const live = deriveViewModel(rec, { hold });
    assert.equal(live.frameZeroSource, 'seat', 'a live take: the seat');
    assert.equal(live.frameZero, live.seatedZero);
    const otherQ = deriveViewModel(island({ slideQ: -0.3 }),
        { hold: { zeroRel: 55 * Q, quantum: Q / 2 } });
    assert.equal(otherQ.frameZeroSource, 'seat', 'a hold from another grid is void');
    // A settle outlives a take (the glide is the take's own settle).
    const gliding = deriveViewModel(armed, { hold, settle: { fromRel: 55 * Q, t: 0.5 } });
    assert.equal(gliding.frameZeroSource, 'settle');
});

test('(b) the Q13 trim view takes neither: its zero is the island\'s', () => {
    // The sole committed clip, provisional: the trim view maps the one
    // cursor into its selection from the island zero the re-trim sets.
    const trim = {
        id: 'root', type: 'stack', quantum: Q, islandZero: 3 * Q, definerId: 'D',
        isPlaying: true, masterPos: 0, islandPos: Math.round(0.3 * Q), perf: PERF,
        nodes: [clip('D', 2, 3, { loopStart: Q, loopEnd: 2 * Q, windowActive: true })],
    };
    const vm = deriveViewModel(trim, { hold: { zeroRel: 7 * Q, quantum: Q },
                                       settle: { fromRel: 9 * Q, t: 0.5 } });
    assert.equal(vm.provisionalDefiner, true);
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 3 * Q, 'the definer\'s top: the island zero');
});

/* ---------- (c) the hold ---------- */

test('(c) the hold begins at the zero on screen and no edit re-seats it', () => {
    resetFrameHold();
    let vm = render(island(), { key: 'B', now: 0 });
    assert.equal(vm.frameZero, 55 * Q, 'the seat, the first time');
    assert.equal(frameHoldState().held.rel, 55 * Q, 'captured');
    // B slid past the pickup: seated alone it would re-seat on 54Q.
    for (const slideQ of [-0.3, -1, -2.6, 0.9]) {
        vm = render(island({ slideQ }), { key: 'B', now: 10 });
        assert.equal(vm.frameZeroSource, 'hold');
        assert.equal(vm.frameZero, 55 * Q, `slide ${slideQ}: held`);
        near(laneOf(vm, 'C').takeStartQ, 3, `slide ${slideQ}: C stays put`);
        near(vm.playheadQ, 0.3, `slide ${slideQ}: the cursor stays put`);
    }
    assert.equal(settleInMotion(), false, 'edits never start a glide');
});

test('(c) the hold is relative to the island zero: a seek carries it', () => {
    resetFrameHold();
    const before = render(island({ slideQ: -0.3 }), { key: 'B', now: 0 });
    render(island({ slideQ: -0.6 }), { key: 'B', now: 5 });  // an edit: held
    const held = render(island({ slideQ: -0.6 }), { key: 'B', now: 6 });
    // A seek moves the island zero and every origin back by 7.25Q.
    const sought = render(island({ slideQ: -0.6, seekQ: 7.25 }), { key: 'B', now: 7 });
    assert.equal(sought.frameZeroSource, 'hold');
    assert.equal(sought.frameZero - (-7.25 * Q), held.frameZero,
        'the zero moved with the island zero');
    for (const id of ['A', 'B', 'C']) {
        near(laneOf(sought, id).takeStartQ, laneOf(held, id).takeStartQ,
             `${id}: the picture is unchanged`);
    }
    assert.equal(before.frameZero, held.frameZero);
});

/* ---------- (d) the releases ---------- */

test('(d) another lane: the frame settles once, and the new hold rests on the seat', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });                  // held at 55Q
    render(island({ slideQ: -0.3 }), { key: 'B', now: 100 }); // B edited: held
    // The selection moves to C: the frame glides from 55Q to 54Q.
    let vm = render(island({ slideQ: -0.3 }), { key: 'C', now: 200 });
    assert.equal(vm.frameZeroSource, 'settle');
    assert.equal(vm.frameZero, 55 * Q, 'the glide starts where the frame was');
    assert.equal(settleInMotion(), true);
    assert.equal(frameHoldState().held.key, 'C');
    assert.equal(frameHoldState().held.rel, 54 * Q, 'the new hold: the TARGET');
    vm = render(island({ slideQ: -0.3 }), { key: 'C', now: 200 + SETTLE_MS / 2 });
    near(vm.frameZero, 54.5 * Q, 'half way at half time (easeInOut)');
    assert.equal(vm.frameSettling, true);
    vm = render(island({ slideQ: -0.3 }), { key: 'C', now: 200 + SETTLE_MS });
    assert.equal(vm.frameZero, 54 * Q, 'landed exactly on the seat');
    assert.equal(settleInMotion(), false);
    // Now C's hold keeps it — even when an edit moves the seat.
    vm = render(island({ slideQ: -1.3 }), { key: 'C', now: 2000 });
    assert.equal(vm.frameZeroSource, 'hold');
    assert.equal(vm.frameZero, 54 * Q);
});

test('(d) a clear settles onto the seat, and the seat then follows the lanes', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    let vm = render(island({ slideQ: -0.3 }), { key: null, now: 20 });
    assert.equal(vm.frameZeroSource, 'settle');
    assert.equal(frameHoldState().held, null, 'no hold without a selection');
    vm = render(island({ slideQ: -0.3 }), { key: null, now: 20 + SETTLE_MS });
    assert.equal(vm.frameZero, 54 * Q);
    vm = render(island({ slideQ: +0.9 }), { key: null, now: 2000 });
    assert.equal(vm.frameZeroSource, 'seat');
    assert.equal(vm.frameZero, 56 * Q, 'unheld: an edit re-seats at once');
});

test('(d) a take arming settles, the hold stays suspended, and resumes after', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    const armed = island({ slideQ: -0.3, extra: { C: { isPendingStart: true } } });
    let vm = render(armed, { key: 'B', takeActive: true, now: 20 });
    assert.equal(vm.frameZeroSource, 'settle', 'the take arms: the frame settles');
    assert.equal(frameHoldState().held, null, 'no hold during a take');
    vm = render(armed, { key: 'B', takeActive: true, now: 20 + SETTLE_MS });
    assert.equal(vm.frameZero, 54 * Q, 'the recording frame is the seat');
    // The take done, the hold begins again at the zero on screen.
    vm = render(island({ slideQ: -0.3 }), { key: 'B', now: 5000 });
    assert.equal(frameHoldState().held.rel, 54 * Q);
    vm = render(island({ slideQ: -2.3 }), { key: 'B', now: 5010 });
    assert.equal(vm.frameZero, 54 * Q, 'held again');
});

test('(d) a hold begun mid-glide follows the glide to its landing', () => {
    // Seats by B's slide (C at 58Q pulls by whole 5Q cycles): −0.3 →
    // 54Q, +0.9 → 56Q, +1.9 → 57Q.
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });   // held; seat 54Q
    render(island({ slideQ: -0.3 }), { key: null, now: 20 });  // clear: glide
    // A new selection mid-glide; then the seat moves once more (a poll).
    render(island({ slideQ: -0.3 }), { key: 'C', now: 20 + SETTLE_MS / 3 });
    assert.equal(frameHoldState().held.rel, 54 * Q, 'the new hold: the target');
    let vm = render(island({ slideQ: +0.9 }), { key: 'C', now: 20 + SETTLE_MS / 2 });
    assert.equal(frameHoldState().held.rel, 56 * Q, '…while the glide runs, the latest');
    assert.equal(vm.frameZeroSource, 'settle', 'the glide retargets');
    vm = render(island({ slideQ: +0.9 }), { key: 'C', now: 20 + SETTLE_MS });
    assert.equal(vm.frameZero, 56 * Q, 'landed');
    vm = render(island({ slideQ: +1.9 }), { key: 'C', now: 2000 });
    assert.equal(vm.frameZero, 56 * Q, 'and held there');
});

/* ---------- (e) never under a hand ---------- */

test('(e) a grab that selects another lane keeps the picture it grabbed', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    // Grabbing C's handle selects C with a hand on the frame.
    let vm = render(island({ slideQ: -0.3 }), { key: 'C', handDown: true, now: 20 });
    assert.equal(vm.frameZeroSource, 'hold', 'no glide under the hand');
    assert.equal(vm.frameZero, 55 * Q);
    assert.equal(frameHoldState().held.key, 'C', 're-keyed');
    // The hand lifts: C is selected, its hold keeps the grabbed zero.
    vm = render(island({ slideQ: -0.3 }), { key: 'C', now: 2000 });
    assert.equal(vm.frameZero, 55 * Q);
    assert.equal(settleInMotion(), false);
    // The next release settles it.
    render(island({ slideQ: -0.3 }), { key: null, now: 3000 });
    vm = render(island({ slideQ: -0.3 }), { key: null, now: 3000 + SETTLE_MS });
    assert.equal(vm.frameZero, 54 * Q);
});

test('(e) a release under a hand waits for the hand to lift', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    const armed = island({ slideQ: -0.3, extra: { C: { isPendingStart: true } } });
    let vm = render(armed, { key: 'B', takeActive: true, handDown: true, now: 20 });
    assert.equal(vm.frameZero, 55 * Q, 'armed, not moving');
    assert.equal(settleInMotion(), false);
    vm = render(armed, { key: 'B', takeActive: true, handDown: true, now: 5000 });
    assert.equal(vm.frameZero, 55 * Q, 'still waiting');
    vm = render(armed, { key: 'B', takeActive: true, now: 6000 });
    assert.equal(settleInMotion(), true, 'the hand lifted: the glide starts');
    assert.equal(vm.frameZero, 55 * Q, 'from the zero the hand held');
    vm = render(armed, { key: 'B', takeActive: true, now: 6000 + SETTLE_MS });
    assert.equal(vm.frameZero, 54 * Q);
});

test('(e) a glide in motion completes when a hand comes down', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    render(island({ slideQ: -0.3 }), { key: 'C', now: 20 });   // glide 55 → 54
    render(island({ slideQ: -0.3 }), { key: 'C', now: 20 + SETTLE_MS / 4 });
    assert.equal(settleInMotion(), true);
    const vm = render(island({ slideQ: -0.3 }), { key: 'C', handDown: true,
                                                   now: 20 + SETTLE_MS / 3 });
    assert.equal(settleInMotion(), false, 'no glide under the hand');
    assert.equal(vm.frameZeroSource, 'hold');
    assert.equal(vm.frameZero, 54 * Q, 'on the target, grid-true');
});

/* ---------- (f) the edges ---------- */

test('(f) reduced motion jumps; a seated frame does not glide', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    let vm = render(island({ slideQ: -0.3 }), { key: 'C', reducedMotion: true, now: 20 });
    assert.equal(settleInMotion(), false);
    assert.equal(vm.frameZero, 54 * Q, 'straight to the seat');
    assert.equal(vm.frameZeroSource, 'seat');
    // C's hold, on the seat; a selection change there has nothing to do.
    render(island({ slideQ: -0.3 }), { key: 'C', now: 30 });
    vm = render(island({ slideQ: -0.3 }), { key: 'A', now: 40 });
    assert.equal(settleInMotion(), false, 'already seated: no glide');
    assert.equal(vm.frameZero, 54 * Q);
});

test('(f) a new island starts with nothing held', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    const other = { ...island({ slideQ: -0.3 }), id: 'another-root' };
    const vm = render(other, { key: 'B', now: 20 });
    assert.equal(vm.frameZeroSource, 'seat', 'nothing carried over');
    assert.equal(vm.frameZero, 54 * Q);
    assert.equal(settleInMotion(), false);
});

test('(f) a Q change re-captures the hold on the new grid', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    const s = island();
    s.quantum = Q / 2;
    const vm = render(s, { key: 'B', now: 10 });
    assert.equal(vm.frameZeroSource, 'seat', 'the old hold is void');
    assert.equal(frameHoldState().held.quantum, Q / 2);
    assert.equal(frameHoldState().held.rel, vm.frameZero - s.islandZero);
});

test('(f) mid-glide the arm marker stays on the island grid', () => {
    resetFrameHold();
    render(island(), { key: 'B', now: 0 });
    render(island({ slideQ: -0.3 }), { key: 'B', now: 10 });
    render(island({ slideQ: -0.3 }), { key: null, now: 20 });
    const vm = render(island({ slideQ: -0.3 }), { key: null, now: 20 + SETTLE_MS / 2 });
    const zQ = vm.frameZero / Q;
    assert.ok(Math.abs(zQ - Math.round(zQ)) > 0.1, 'the zero is mid-glide');
    const armIsland = zQ + vm.armAtQ;
    near(armIsland, Math.round(armIsland), 'the marker sits on an island grid line');
    assert.ok(vm.armAtQ > vm.playheadQ - EPS, 'ahead of the cursor');
    assert.ok(vm.armAtQ - vm.playheadQ <= 1 + EPS, 'the next line');
});

test('(f) a take growing through a glide that wraps keeps the frame', () => {
    // A 4Q loop seats the zero at 0 (mod 4); R, recording since island
    // 8Q, pulls it to 8Q. A glide from 5Q takes the short way round —
    // to 4Q, the seat less a frame. Folded on the seat instead of that
    // landing, the growing take sat a whole frame off: the frame grew
    // to 5Q mid-glide, every lane rescaled, then snapped back.
    resetFrameHold();
    const s = {
        id: 'root', type: 'stack', quantum: Q, islandZero: 0, definerId: '',
        isPlaying: true, masterPos: 0, islandPos: Math.round(8.3 * Q),
        perf: PERF,
        nodes: [clip('A', 0, 4), clip('R', 8, 0.3, { isRecording: true })],
    };
    const rest = deriveViewModel(s);
    assert.equal(rest.frameZero, 8 * Q, 'the seat');
    for (const t of [0.3, 0.6, 0.9]) {
        const vm = deriveViewModel(s, { settle: { fromRel: 5 * Q, t } });
        assert.equal(vm.cycleQ, rest.cycleQ, `t=${t}: the frame keeps its length`);
        // The bar slides with the lanes from the LANDING's picture (the
        // take's start at the left edge of the frame from 4Q): never
        // re-wrapped, so it waits at 0 while that start is off-screen.
        near(vm.playheadQ, Math.max(0, 0.3 - (vm.frameZero / Q - 4)),
             `t=${t}: the bar slides with the frame`);
    }
});

/* ---------- (g) the grid rides the glide ---------- */

test('(g) the ruler and gridlines ride the glide: every tick on an island ' +
     'Q line of the zero drawn, each named where it lands', () => {
    const s = island({ slideQ: -0.3 });  // seated alone: 54Q; a 5Q frame
    const at = t => deriveViewModel(s, { settle: { fromRel: 56 * Q, t } });
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
        assert.ok(vm.frameSettling, `t=${t}: settling`);
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
    // t = 0.3 and 0.7 put the zero ~0.22Q off its grid: every line of
    // both frames sits between the frame's whole Qs.
    assert.ok(moved >= 10, 'mid-glide the lines sit between the frame\'s whole Qs');
});

test('(g) buildRulerTicks: whole Qs at rest; mid-glide the lines shift by ' +
     'the zero\'s offset and keep their landing names; no Q, no grid', () => {
    const row = tk => [+tk.q.toFixed(9), tk.at, tk.major, tk.end];
    // A 6Q frame at rest: the frame end is not a major (6 is no 4th Q),
    // exactly the pre-glide set.
    assert.deepEqual(buildRulerTicks(true, 6).map(row),
        [[0, 0, true, false], [1, 1, false, false], [2, 2, false, false],
         [3, 3, false, false], [4, 4, true, false], [5, 5, false, false],
         [6, 6, false, true]]);
    // The zero drawn ¼Q past a line, landing 1¼Q back: the lines sit ¾Q
    // on from each whole Q, each named one Q on (where it lands).
    assert.deepEqual(buildRulerTicks(true, 4, 0.25, -1.25).map(row),
        [[0.75, 2, false, false], [1.75, 3, false, false],
         [2.75, 4, true, true], [3.75, 1, false, false]]);
    assert.deepEqual(buildRulerTicks(false, 4), [], 'no Q: no grid');
    assert.deepEqual(buildRulerTicks(true, 4.5), [], 'a fractional frame: none');
    assert.deepEqual(buildRulerTicks(true, 65), [], 'too dense to draw: none');
});
