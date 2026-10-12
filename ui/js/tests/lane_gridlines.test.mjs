/**
 * The Q lines a lane's grid draws (session_view/lane_body.js
 * laneGridTicks): the ruler's on a lane in the shared frame; on a
 * raw-framed lane (comp mode's inspector) the whole Qs of the lane's
 * OWN frame — a take longer than the shared frame keeps its lines to
 * its end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {
    addEventListener() {}, removeEventListener() {},
};
globalThis.document = globalThis.document || {
    activeElement: null, getElementById() { return null; },
    querySelectorAll() { return []; },
};

const { laneGridTicks } = await import('../session_view/lane_body.js');
const { buildRulerTicks } = await import('../view_model.js');

/** The lines patchGridlines places: every tick but the frame's edges. */
const linesOf = (lane, vm) => laneGridTicks(lane, vm)
    .map(t => t.q)
    .filter(q => q > 1e-6 && Math.abs(q - (lane.frameQ || vm.cycleQ)) > 1e-6);

const vm4 = { qEstablished: true, cycleQ: 4,
              ruler: { ticks: buildRulerTicks(true, 4) } };

test('a lane in the shared frame draws the ruler\'s own ticks', () => {
    assert.equal(laneGridTicks({ frameQ: 0 }, vm4), vm4.ruler.ticks);
    assert.deepEqual(linesOf({}, vm4), [1, 2, 3]);
});

test('a raw-framed lane draws every whole Q of its own frame', () => {
    // A 12Q take inspected inside a 4Q frame: lines to its end.
    assert.deepEqual(linesOf({ frameQ: 12 }, vm4),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // Shorter than the shared frame: none past its end.
    const vm12 = { qEstablished: true, cycleQ: 12,
                   ruler: { ticks: buildRulerTicks(true, 12) } };
    assert.deepEqual(linesOf({ frameQ: 3 }, vm12), [1, 2]);
    // A fractional take: every whole Q inside it, the last one too.
    assert.deepEqual(linesOf({ frameQ: 5.5 }, vm4), [1, 2, 3, 4, 5]);
    // Every fourth line is a major one.
    assert.deepEqual(laneGridTicks({ frameQ: 12 }, vm4)
        .filter(t => t.major && t.q > 0 && t.q < 12).map(t => t.q), [4, 8]);
});

test('before Q exists a raw-framed lane has no lines', () => {
    assert.deepEqual(laneGridTicks({ frameQ: 12 },
        { qEstablished: false, cycleQ: 0, ruler: { ticks: [] } }), []);
});
