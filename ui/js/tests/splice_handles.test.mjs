/**
 * THE SPLICE AND THE TOP — the heard lane's loop chrome, its pure
 * geometry (session_view/splice_handles.js; loop_selection.md §9,
 * P2.3–P2.6, 2026-09-24).
 *
 * What this pins:
 *   (a) WHERE: a splice handle on every heard repeat of the wrap (at the
 *       region start's heard position) and of each inner cut (the kept
 *       length before it later); the ↺ on every repeat of topHeardQ; a
 *       splice ON the left edge is the next repeat's, never a sliver past
 *       the right; a degenerate frame is capped;
 *   (b) GHOSTS: only handles in the take tile (a non-ghost rep) wear
 *       their tabs — a plain loop's ↺, in the take's pass, where the
 *       frame wraps the clipped tile;
 *   (c) THE SWAP PREVIEW'S TOP: the engine's reconcile predicted from
 *       the published effective top — one the new region plays stays
 *       (the old region start included: a fresh loop's left slide keeps
 *       its ↺), one it drops resets to the new region start;
 *   (d) THE GLIDE's easing lands exactly;
 *   (e) THE GRABBED HANDLE keeps its element and stands for the repeat
 *       nearest the hand — no repeat twice, none lost;
 *   (f) WHO WEARS WHAT, through the real deriveViewModel: a heard clip
 *       wears splices and the ↺; a group the splices only; a one-shot
 *       neither; a PLAIN loop (no map) the ↺ alone, a bypassed map none;
 *       under the recording gate the ↺ still draws (inert) where it
 *       would be live — a 1Q loop's too, a one-shot's never;
 *   (g) THE PANEL: the start marker over a plain loop's whole take too,
 *       never a bypassed map; the timing readout wherever something can
 *       act on it — a ↺, or a shift for "Timing as played" to put back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { spliceSpots, topSpots, inTakeTile, inTakePass, predictTop, glideOffset,
         pairHandles, wantsSpliceChrome, wantsTopHandle, wantsLaneTop,
         isPlainLoop, TOP_GLIDE_MS }
    from '../session_view/splice_handles.js';
import { panelOffersTop, showsTiming } from '../session_view/region_panel.js';
import { deriveViewModel } from '../view_model.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const xs = spots => spots.map(s => +s.x.toFixed(9));

/* ---------- (a) where ---------- */

test('(a) the wrap and each cut, on every repeat', () => {
    // A 4Q loop [6, 10) with its region start heard 1Q in, in a 12Q frame.
    let spots = spliceSpots([[6, 10]], 1, 4, 12);
    assert.deepEqual(spots.map(s => s.kind), ['wrap', 'wrap', 'wrap']);
    assert.deepEqual(xs(spots), [1, 5, 9]);
    assert.deepEqual(spots.map(s => s.k), [0, 1, 2]);
    // A cut map: [2, 5) ∪ [6, 10) — period 7, the cut 3Q after the wrap.
    spots = spliceSpots([[2, 5], [6, 10]], 0.5, 7, 7);
    assert.deepEqual(spots.map(s => [s.kind, s.j, +s.x.toFixed(9)]),
        [['wrap', 0, 0.5], ['cut', 1, 3.5]]);
    assert.deepEqual(spots[1].cut, [5, 6], 'the raw cut behind the splice');
    assert.equal(spots[0].cut, null);
    // The cut wraps into the period like everything else.
    spots = spliceSpots([[2, 5], [6, 10]], 5, 7, 7);
    assert.deepEqual(xs(spots), [5, 1]);
});

test('(a) a splice ON the left edge is the next repeat\'s; the frame bounds', () => {
    // anchor ≈ S − ε (fp noise): the splice sits at 0, not a sliver at S.
    const spots = spliceSpots([[6, 10]], 4 - 1e-12, 4, 8);
    assert.ok(Math.abs(spots[0].x) < 1e-9, String(spots[0].x));
    assert.equal(spots.length, 2);
    // Nothing at or past the frame's right edge.
    assert.deepEqual(xs(spliceSpots([[0, 2]], 0, 2, 4)), [0, 2]);
    // Degenerate input: nothing, never a runaway loop.
    assert.deepEqual(spliceSpots([[0, 1]], 0, 0, 8), []);
    assert.deepEqual(spliceSpots([], 0, 4, 8), []);
    assert.ok(spliceSpots([[0, 1]], 0, 1e-6, 8).length <= 256, 'capped');
});

test('(a) the ↺ on every repeat of its first heard position', () => {
    assert.deepEqual(xs(topSpots(0.4, 3, 12)), [0.4, 3.4, 6.4, 9.4]);
    assert.deepEqual(xs(topSpots(0, 4, 4)), [0]);
    assert.deepEqual(topSpots(NaN, 4, 4), []);
    assert.deepEqual(topSpots(1, 0, 4), []);
});

/* ---------- (b) ghosts ---------- */

test('(b) tabs only in the take tile; no tiles, every handle is the take\'s', () => {
    const reps = [
        { startQ: 0, endQ: 3, ghost: false },
        { startQ: 3, endQ: 6, ghost: true },
        { startQ: 6, endQ: 9, ghost: true },
        { startQ: 9, endQ: 12, ghost: true },
    ];
    assert.equal(inTakeTile(reps, 0), true);
    assert.equal(inTakeTile(reps, 2.99), true);
    assert.equal(inTakeTile(reps, 3), false, 'the next repeat\'s wrap');
    assert.equal(inTakeTile(reps, 9.4), false);
    // A loop that fills the frame: every tile is material.
    assert.equal(inTakeTile([{ startQ: 0, endQ: 4, ghost: false }], 3.9), true);
    assert.equal(inTakeTile([], 5), true);
    // A live recording bar is not the take tile.
    assert.equal(inTakeTile([{ startQ: 0, endQ: 4, ghost: false, bar: true },
                             { startQ: 4, endQ: 8, ghost: true }], 1), true);
});

test('(b) a PLAIN loop\'s ↺ wears its tab in the take\'s pass — the part past the frame\'s end too', () => {
    // A 4Q plain loop filling a 4Q frame, its take performed 1Q before
    // the left edge: the take tile is the clipped [3, 4), the wrapped
    // [0, 3) its own pass, one frame on. A top moved 1Q into the take
    // sounds at 0 — inside the pass, though inTakeTile calls it a ghost.
    const filling = [{ startQ: 0, endQ: 3, ghost: true }, { startQ: 3, endQ: 4, ghost: false }];
    assert.equal(inTakeTile(filling, 0), false);
    assert.equal(inTakePass(filling, 0, 4, 4), true);
    assert.equal(inTakePass(filling, 2.5, 4, 4), true);
    assert.equal(inTakePass(filling, 3.2, 4, 4), true, 'the tile itself');
    // A 2Q loop in a 4Q frame, the take the clipped last tile [3, 4):
    // its pass runs on into [0, 1) — not into the ghost repeat after.
    const short = [{ startQ: 0, endQ: 1, ghost: true }, { startQ: 1, endQ: 3, ghost: true },
                   { startQ: 3, endQ: 4, ghost: false }];
    assert.equal(inTakePass(short, 0.5, 2, 4), true);
    assert.equal(inTakePass(short, 1, 2, 4), false, 'the next repeat');
    assert.equal(inTakePass(short, 2, 2, 4), false);
    // Exactly one ↺ of every placement lands in the pass.
    for (const top of [0, 0.25, 1, 1.5, 1.99]) {
        const inPass = topSpots(top, 2, 4).filter(s => inTakePass(short, s.x, 2, 4));
        assert.equal(inPass.length, 1, 'top ' + top);
    }
    // An unclipped take tile: its pass is the tile.
    const whole = [{ startQ: 0, endQ: 2, ghost: false }, { startQ: 2, endQ: 4, ghost: true }];
    assert.equal(inTakePass(whole, 1, 2, 4), true);
    assert.equal(inTakePass(whole, 3, 2, 4), false);
});

/* ---------- (c) the swap preview's top ---------- */

test('(c) the top a swap lands on: kept stays, dropped resets to the new start', () => {
    const q = 100;
    // A top at raw 7Q; the region slides +1Q to [7, 11): kept.
    assert.equal(predictTop([[7, 11]], 700, q), 700);
    // …slides +2Q to [8, 12): dropped → the new region start.
    assert.equal(predictTop([[8, 12]], 700, q), 800);
    // A top AT the region start (a fresh loop's, [6, 10)) is a top like
    // any other: a slide left to [5, 9) still plays raw 6 — the ↺ stays
    // and the splice comes apart (the engine stores it: P2) …
    assert.equal(predictTop([[5, 9]], 600, q), 600);
    // …a slide right to [7, 11) drops it: the new start.
    assert.equal(predictTop([[7, 11]], 600, q), 700);
    // A cut map: the top in the gap is dropped.
    assert.equal(predictTop([[2, 5], [6, 10]], 550, q), 200);
    assert.equal(predictTop([[2, 5], [6, 10]], 650, q), 650);
    assert.equal(predictTop([], 650, q), undefined);
});

/* ---------- (d) the glide ---------- */

test('(d) the glide eases from where the ↺ was to where it is, and lands', () => {
    const g = { from: 3, to: 1, t0: 1000 };
    assert.equal(glideOffset(g, 1000), 2, 'starts where it was');
    assert.equal(glideOffset(g, 1000 + TOP_GLIDE_MS), 0, 'lands exactly');
    assert.equal(glideOffset(g, 5000), 0);
    const mid = glideOffset(g, 1000 + TOP_GLIDE_MS / 2);
    assert.ok(near(mid, 1), 'halfway at half time (ease-in-out)');
    assert.ok(glideOffset(g, 1000 + TOP_GLIDE_MS / 4) > 1.5, 'eases in');
    assert.equal(glideOffset(null, 0), 0);
});

/* ---------- (e) the grabbed handle ---------- */

test('(e) the grabbed handle keeps its element and takes the nearest repeat', () => {
    const [a, b, c] = ['a', 'b', 'c'];
    const spots = [{ x: 1 }, { x: 5 }, { x: 9 }];
    // At rest: in order; a missing element is made (null), none spare.
    let r = pairHandles([a, b], spots);
    assert.deepEqual(r.pairs.map(([e, s]) => [e, s.x]), [[a, 1], [b, 5], [null, 9]]);
    assert.deepEqual(r.surplus, []);
    // `c` is held at 5.3 (the hand): it stands for the repeat at 5, and
    // the others fill the rest in order — every repeat exactly once.
    r = pairHandles([a, b, c], spots, c, 5.3);
    assert.deepEqual(r.pairs.map(([e, s]) => [e, s.x]), [[c, 5], [a, 1], [b, 9]]);
    // Fewer repeats than elements: the spare ones are surplus — never
    // the grabbed one.
    r = pairHandles([a, b, c], [{ x: 2 }], a, 0);
    assert.deepEqual(r.pairs.map(([e, s]) => [e, s && s.x]), [[a, 2]]);
    assert.deepEqual(r.surplus, [b, c]);
    // No repeat at all: the grabbed one stays paired (with none).
    r = pairHandles([a], [], a, 3);
    assert.deepEqual(r.pairs, [[a, null]]);
    assert.deepEqual(r.surplus, []);
});

/* ---------- (f) who wears what ---------- */

const Q = 1000;
const clip = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: Math.round(originQ * Q),
    duration: Math.round(durationQ * Q), effectiveQuantum: Q,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false,
    periodSource: 'own', ...extra,
});
const windowed = (id, originQ, durationQ, [a, b], extra = {}) =>
    clip(id, originQ, durationQ, { loopStart: a * Q, loopEnd: b * Q,
                                   windowActive: true, ...extra });
const island = nodes => ({
    id: 'root', type: 'stack', quantum: Q, islandZero: 0, definerId: '',
    isPlaying: false, masterPos: 0, islandPos: 0,
    perf: { sampleRate: Q }, nodes,
});
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

test('(f) a heard clip wears splices and the ↺; a group only splices; a one-shot neither; a raw lane no splice', () => {
    const vm = deriveViewModel(island([
        clip('A', 0, 1),
        windowed('B', 1, 12, [6, 10], { loopTop: 7 * Q }),
        windowed('O', 0, 8, [2, 4], { periodSource: 'context' }),
        clip('R', 0, 8),
        {
            id: 'G', name: 'G', type: 'stack', anchored: true, origin: 0,
            windowActive: true, loopStart: 0, loopEnd: 2 * Q,
            loopBypassed: false, effectiveQuantum: Q, duration: 0,
            nodes: [clip('g1', 0, 4)],
        },
    ]));
    const B = laneOf(vm, 'B');
    assert.equal(wantsSpliceChrome(B), true);
    assert.equal(wantsTopHandle(B), true);
    assert.equal(B.canRetime, true);
    // Its ↺ is the stored top (7Q) — 1Q after the region start.
    assert.ok(near(posModQ(B.topHeardQ - B.takeStartQ, B.periodQ), 1));
    const G = laneOf(vm, 'G');
    assert.equal(wantsSpliceChrome(G), true, 'a group\'s map swaps too');
    assert.equal(wantsTopHandle(G), false, 'a group is never re-timed');
    assert.equal(wantsLaneTop(G), false);
    const O = laneOf(vm, 'O');
    assert.equal(wantsSpliceChrome(O), false, 'a one-shot keeps its edge grips');
    assert.equal(wantsLaneTop(O), false, '…and has no ↺: its offset IS its placement');
    assert.equal(wantsSpliceChrome(laneOf(vm, 'R')), false, 'raw: brackets');
    assert.equal(wantsLaneTop(laneOf(vm, 'R')), true, '…and its ↺ (a plain loop)');
    assert.equal(wantsSpliceChrome(laneOf(vm, 'A')), false);
});

test('(f) a PLAIN loop wears the ↺ alone; a bypassed map wears none', () => {
    // A 1Q loop and a plain 4Q take from 1Q: a 4Q frame whose zero seats
    // on the take's top.
    const vm = deriveViewModel(island([clip('A', 0, 1), clip('P', 1, 4)]));
    const P = laneOf(vm, 'P');
    assert.equal(isPlainLoop(P), true);
    assert.equal(P.canRetime, true);
    assert.equal(wantsSpliceChrome(P), false, 'nothing to swap: no splice');
    assert.equal(wantsLaneTop(P), true, 'the ↺ alone');
    // Its top (never edited: raw 0) on the take tile's start, once per
    // period — the whole take.
    assert.equal(P.topQ, 0);
    assert.equal(P.periodQ, 4);
    assert.deepEqual(xs(topSpots(P.topHeardQ, P.periodQ, vm.cycleQ)), [P.takeStartQ]);
    // A 1Q loop is a plain loop too: a ↺ on every Q of the frame.
    const A = laneOf(vm, 'A');
    assert.equal(wantsLaneTop(A), true);
    assert.equal(topSpots(A.topHeardQ, A.periodQ, vm.cycleQ).length, 4);
    // BYPASSED: the whole take sounds under the raw-framed brackets — no
    // ↺ on the lane, though the clip stays re-timeable (the panel's
    // "Timing as played" still reaches it).
    const byp = deriveViewModel(island([clip('A', 0, 1),
        windowed('Y', 1, 8, [2, 6], { loopBypassed: true, windowActive: false })]));
    const Y = laneOf(byp, 'Y');
    assert.equal(Y.canRetime, true);
    assert.equal(isPlainLoop(Y), false);
    assert.equal(wantsLaneTop(Y), false);
    // COMP MODE on a plain lane: the cells own the take tile — no ↺.
    const comp = deriveViewModel(island([clip('A', 0, 1), clip('P', 1, 4)]),
        { compMode: new Set(['P']) });
    assert.equal(laneOf(comp, 'P').canRetime, false);
    assert.equal(wantsLaneTop(laneOf(comp, 'P')), false);
});

test('(f) under the recording gate the chrome draws inert — the ↺ too', () => {
    const vm = deriveViewModel(island([
        clip('A', 0, 1),
        windowed('B', 1, 12, [6, 10]),
        clip('T', 0, 0, { isRecording: true }),
    ]));
    const B = laneOf(vm, 'B');
    assert.equal(vm.mapEditsLocked, true);
    assert.equal(B.bandEditable, false);
    assert.equal(B.bandLocked, true);
    assert.equal(wantsSpliceChrome(B), true, 'drawn');
    assert.equal(B.canRetime, false, 'not re-timeable under the gate');
    assert.equal(wantsTopHandle(B), true, 'the ↺ still draws, inert');
    assert.equal(wantsLaneTop(B), true);
});

test('(f) the gate holds a plain loop\'s ↺ inert — a 1Q loop\'s too; a one-shot never has one', () => {
    const vm = deriveViewModel(island([
        clip('A', 0, 1),
        clip('P', 1, 4),
        windowed('O', 0, 8, [2, 4], { periodSource: 'context' }),
        clip('T', 0, 0, { isRecording: true }),
    ]));
    assert.equal(vm.mapEditsLocked, true);
    for (const id of ['A', 'P']) {
        const l = laneOf(vm, id);
        assert.equal(l.canRetime, false, id + ': not now');
        assert.equal(l.retimeLocked, true, id + ': but for the gate');
        assert.equal(wantsLaneTop(l), true, id + ': drawn, inert');
    }
    // The map chrome's own gate verdict (bandLocked) needs a ≥ 2Q take:
    // read for the ↺, the 1Q loop's would vanish under the gate.
    assert.equal(laneOf(vm, 'A').bandLocked, false);
    // …and it holds a one-shot's map chrome, which never had a ↺.
    const O = laneOf(vm, 'O');
    assert.equal(O.bandLocked, true);
    assert.equal(wantsTopHandle(O), false);
});

/* ---------- (g) the panel ---------- */

test('(g) the start marker walks a plain loop\'s whole take; the timing shows where something can act on it', () => {
    const vm = deriveViewModel(island([
        clip('A', 0, 1),
        clip('P', 1, 4),
        windowed('B', 1, 12, [6, 10]),
        windowed('Y', 1, 8, [2, 6], { loopBypassed: true, windowActive: false }),
        windowed('Z', 1, 8, [2, 6], { loopBypassed: true, windowActive: false,
                                      retime: Q / 4 }),
        clip('S', 1, 1, { periodSource: 'context', retime: Q }),
    ]));
    const [P, B, Y, Z, S] = ['P', 'B', 'Y', 'Z', 'S'].map(id => laneOf(vm, id));
    // The start marker: over an active map's kept set, and over a plain
    // loop's whole take — never a bypassed map's (a top must lie in its
    // STORED region, which is not what plays).
    assert.equal(panelOffersTop(B), true);
    assert.equal(panelOffersTop(P), true);
    assert.equal(panelOffersTop(Y), false);
    // The timing: wherever a ↺ is offered (as played: the reset idle) …
    assert.equal(showsTiming(B, Q), true);
    assert.equal(showsTiming(P, Q), true);
    // … and, with no ↺, only on a SHIFTED take: "Timing as played" is
    // the one thing that can act there.
    assert.equal(showsTiming(Y, Q), false, 'bypassed, as played: nothing to act');
    assert.equal(showsTiming(Z, Q), true, 'bypassed, shifted: the reset puts it back');
    // Never where no re-time can reach: a one-shot, however shifted.
    assert.equal(showsTiming(S, Q), false);
});

function posModQ(a, m) {
    return ((a % m) + m) % m;
}
