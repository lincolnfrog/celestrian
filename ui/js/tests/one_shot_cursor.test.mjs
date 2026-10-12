/**
 * A RESTING ONE-SHOT HAS NO SOUND CURSOR (Q5; composition.md §9).
 *
 * The engine publishes a one-shot's `playhead` as the phase of its shot
 * while it sounds and 0 through its rest (ClipNode::publishPlayhead; a
 * stack's the same) — so 0 is the shot's top OR the rest. The lane's own
 * firing says which: it sounds `periodQ` from takeStartQ + k·shotEveryQ
 * and rests between (vm/lane_common.js).
 *
 * The cursors that read a lane's `playhead`:
 *   - the raw-coordinate cursor of the region panel and the reveal
 *     (session_view/map_core.js rawCursorQ): drawn inside a firing only;
 *   - a raw-framed lane's own `.win-cursor` (lane.windowPhase): a
 *     one-shot's resting lane is a heard lane or a bare take, with no
 *     window of its own to carry one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { innerAt, stackFold, singleSegment, mapPeriod, publishedMap,
         nodeWindowActive } from '../time_map.js';
import { deriveViewModel } from '../view_model.js';
import { rawCursorQ } from '../session_view/map_core.js';

const Q = 1000;
const CYCLE_Q = 8;

const clip = (id, originQ, durQ, extra = {}) => ({
    id, type: 'clip', name: id, origin: Math.round(originQ * Q),
    duration: Math.round(durQ * Q), loopStart: 0, loopEnd: 0,
    windowActive: false, loopBypassed: false, isRecording: false,
    isPendingStart: false, periodSource: 'own', playhead: 0, ...extra,
});
const windowed = (id, originQ, durQ, [a, b], extra = {}) =>
    clip(id, originQ, durQ, { loopStart: a * Q, loopEnd: b * Q,
                              windowActive: true, ...extra });
const ONE_SHOT = { periodSource: 'context' };

/** What the engine publishes as clip `n`'s `playhead` at clock `t`
 * (samples) in a scope cycle of CYCLE_Q: the phase of the pass that
 * sounds, 0 in a one-shot's rest (ClipNode::publishPlayhead). */
function publishedPhase(n, t) {
    const map = nodeWindowActive(n) ? publishedMap(n) : { segs: [] };
    const eff = map.segs.length ? map : singleSegment(0, n.duration);
    const shot = mapPeriod(eff);
    const fold = stackFold(map, n.periodSource === 'context', n.duration,
                           CYCLE_Q * Q);
    const at = innerAt(t, n.origin, eff, fold.oneShot ? fold.fold : shot);
    return at.rest ? 0 : at.h / shot;
}

/** The view of an island holding an 8Q bed and `node`, playing, with the
 * frame's playhead at `atQ`: the node's lane, the view model, and the
 * node as published at that moment. */
function viewAt(node, atQ) {
    const t = Math.round(atQ * Q);
    const published = { ...node, playhead: publishedPhase(node, t) };
    const state = { id: 'root', quantum: Q, islandZero: 0, islandPos: t,
                    masterPos: t, isPlaying: true, definerId: '',
                    nodes: [clip('bed', 0, CYCLE_Q), published] };
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, CYCLE_Q);
    assert.ok(Math.abs(vm.playheadQ - atQ) < 1e-9, 'the frame playhead');
    return { lane: vm.lanes.find(l => l.id === node.id), vm, node: published };
}

const cursorAt = (node, atQ) => {
    const v = viewAt(node, atQ);
    return rawCursorQ(v.lane, v.vm, v.node);
};
const near = (got, want, what) =>
    assert.ok(got !== null && Math.abs(got - want) < 1e-9,
        `${what}: the cursor is at raw ${got}Q, the sound at ${want}Q`);

test('a windowed one-shot: the raw cursor follows its shot and is gone in its rest', () => {
    // A 12Q take windowed to [2Q, 6Q), anchored at 4Q: its shot sounds
    // from 6Q of the 8Q frame, wraps, and ends at 2Q.
    const hit = windowed('hit', 4, 12, [2, 6], ONE_SHOT);
    const { lane } = viewAt(hit, 7);
    assert.deepEqual([lane.takeStartQ, lane.shotEveryQ, lane.periodQ], [6, 8, 4]);

    near(cursorAt(hit, 7), 3, '1Q into the shot');
    near(cursorAt(hit, 1), 5, 'its tail, wrapped to the frame\'s start');
    for (const restQ of [2.5, 4, 5.9]) {
        assert.equal(publishedPhase(hit, restQ * Q), 0,
            'the engine publishes 0 through the rest');
        assert.equal(cursorAt(hit, restQ), null,
            `resting at ${restQ}Q: no cursor — not one parked at the window's start`);
    }
});

test('a one-shot with no window: the raw cursor is its take from the firing\'s top, and is gone in its rest', () => {
    // A 3Q take anchored at 7Q: it sounds [7Q, 8Q) and [0, 2Q).
    const hit = clip('hit', 7, 3, ONE_SHOT);
    const { lane } = viewAt(hit, 7.5);
    assert.deepEqual([lane.takeStartQ, lane.shotEveryQ, lane.periodQ], [7, 8, 3]);

    near(cursorAt(hit, 7.5), 0.5, 'half a Q into the take');
    near(cursorAt(hit, 1), 2, 'its tail, wrapped: 2Q into the take');
    for (const restQ of [2.5, 4, 6.9]) {
        assert.equal(cursorAt(hit, restQ), null,
            `resting at ${restQ}Q: no cursor — the take is not playing a second pass`);
    }
});

test('a loop is never at rest: phase 0 is its top, and the cursor is there', () => {
    // A window's content starts sounding at origin + a0: 2Q here.
    const loop = windowed('loop', 0, 12, [2, 6]);
    assert.equal(publishedPhase(loop, 2 * Q), 0, 'the same 0 a rest publishes');
    near(cursorAt(loop, 2), 2, 'the top of the window');
    near(cursorAt(loop, 7), 3, '1Q into the second pass');
    // A one-shot in a cycle no longer than its shot is that loop.
    const whole = clip('whole', 1, CYCLE_Q, ONE_SHOT);
    for (const atQ of [0.5, 1, 4, 7.5]) {
        assert.notEqual(cursorAt(whole, atQ), null, `sounding at ${atQ}Q`);
    }
});

test('a one-shot\'s resting lane carries no cursor of its own', () => {
    // The lane cursor (`.win-cursor`, lane_body.js patchWinCursor) is
    // drawn over a raw-framed lane's window or map at lane.windowPhase.
    for (const hit of [windowed('hit', 4, 12, [2, 6], ONE_SHOT),
                       clip('hit', 7, 3, ONE_SHOT)]) {
        for (const atQ of [1, 4, 7]) {
            const { lane } = viewAt(hit, atQ);
            assert.ok(!lane.window && !lane.mapSegs,
                'no window and no map on the lane: nothing to carry a cursor');
            assert.equal(lane.windowPhase, 0);
        }
    }
});
