/**
 * TRIM DRAG on a long take (owner repro 2026-08-18): record a 1Q
 * definer, then a 10Q take; drag its LEFT handle to 6Q; then its RIGHT
 * handle to 9Q. The field symptom — "the right handle is gone and
 * there is a weird thing in the middle that looks like a split but I
 * never split" — is the heard view of a window whose loop top rests
 * MID-PHASE: [6Q, 10Q) on a take that began at 1Q loops 4Q with its
 * top at cycle phase 2Q (the anchoring law: window content sounds at
 * its performed moment), so the end grip and the start grip meet
 * mid-lane and the waveform wraps there. That geometry is right; what
 * this pins is (a) the model facts behind it, (b) that both trims
 * commit exactly what the drag math proposes, and (c) the ⌥ free-slide
 * algebra. The realistic pointer version lives in e2e/session_view
 * ("trim a long take: left to 6Q, right to 9Q").
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { trimBoundTo, trimBoundForPeriod, segsPeriod, slideSegs }
    from '../map_edit.js';
import { nodeById as findNodeById, recordTake } from './helpers.mjs';

const nodeById = (id, nodes = getState().nodes) => findNodeById(id, nodes);
const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);
const opts = { fxOpen: new Set(), windowEdit: new Set(),
               pinFrameQ: null, pinFoldQ: null };

test('10Q take: left handle → 6Q, then right handle → 9Q (the recipe)', async () => {
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const Q = getState().quantum;
    assert.equal(Q, 1000, 'Q established by the 1Q definer');
    const c2 = await recordTake('', 10 * Q, { stopEarly: 0, settle: 0 });
    assert.equal(nodeById(c2).duration, 10 * Q, 'a 10Q take');
    assert.equal((nodeById(c2).origin || 0) / Q, 1, 'performed from 1Q');

    // Untrimmed: full span, brackets latent at 0% / 100%.
    let lane = laneOf(deriveViewModel(getState(), opts), c2);
    assert.equal(lane.bandTotalQ, 10);
    assert.equal(lane.windowChipQ || 0, 0, 'no window yet');

    // STEP 1 — the left handle to 6Q. What the drag proposes (whole-Q
    // snap of the PERIOD, bound derived) and commits:
    const segs0 = [[0, 10]];
    const p1 = segsPeriod(trimBoundTo(segs0, 'start', 6, 10), 10);
    assert.equal(p1, 4, 'proposed period 4Q');
    const b1 = trimBoundForPeriod(segs0, 'start', Math.round(p1), 10);
    assert.equal(b1, 6, 'bound lands at 6Q');
    const segs1 = trimBoundTo(segs0, 'start', b1, 10);
    assert.deepEqual(segs1, [[6, 10]]);
    await callNative('setSegments', c2, [6 * Q, 10 * Q]);
    let n = nodeById(c2);
    assert.equal(n.loopStart / Q, 6);
    assert.equal(n.loopEnd / Q, 10);
    assert.equal(n.windowActive, true);

    // The heard view after step 1: a 4Q loop in a 4Q cycle whose TOP
    // rests mid-lane (phase 2Q) — the "split-looking" wrap. Both grips
    // are legitimately at that spot; nothing was cut.
    let vm = deriveViewModel(getState(), opts);
    lane = laneOf(vm, c2);
    assert.equal(vm.cycleQ, 4, 'island cycle = lcm(1, 4)');
    assert.deepEqual(lane.bandSegs, [[6, 10]]);
    assert.equal(lane.windowChipQ, 4);
    assert.equal(lane.takeStartQ, 2, 'loop top at cycle phase 2Q');
    assert.equal(lane.reps.length, 1);
    assert.equal(lane.reps[0].srcTopFrac, 0.5, 'the wrap sits mid-lane');
    assert.equal(lane.mapMulti, false, 'single window — no inner cuts');

    // STEP 2 — the right handle to 9Q (from the raw 10Q bound).
    const p2 = segsPeriod(trimBoundTo(segs1, 'end', 9, 10), 10);
    assert.equal(p2, 3);
    const b2 = trimBoundForPeriod(segs1, 'end', Math.round(p2), 10);
    assert.equal(b2, 9);
    const segs2 = trimBoundTo(segs1, 'end', b2, 10);
    assert.deepEqual(segs2, [[6, 9]]);
    await callNative('setSegments', c2, [6 * Q, 9 * Q]);
    n = nodeById(c2);
    assert.equal(n.loopStart / Q, 6);
    assert.equal(n.loopEnd / Q, 9);

    // A 3Q loop performed from 7Q: cycle 3Q, top back at phase 0.
    vm = deriveViewModel(getState(), opts);
    lane = laneOf(vm, c2);
    assert.equal(vm.cycleQ, 3);
    assert.deepEqual(lane.bandSegs, [[6, 9]]);
    assert.equal(lane.windowChipQ, 3);
    assert.equal(lane.takeStartQ, 0, 'loop top at the frame edge again');
});

test('⌥ free slide: any fractional delta, period held, clamped to the take', () => {
    // A 3Q window slid by +0.4Q: fractional bounds, still a 3Q period.
    let r = slideSegs([[6, 9]], 0.4, 10);
    assert.deepEqual(r.segs, [[6.4, 9.4]]);
    assert.equal(r.deltaQ, 0.4);
    assert.equal(segsPeriod(r.segs, 10), 3);
    // Clamps at the take's end / start — a slide never trims.
    r = slideSegs([[6, 9]], 2, 10);
    assert.deepEqual(r.segs, [[7, 10]]);
    assert.equal(r.deltaQ, 1);
    r = slideSegs([[6, 9]], -10, 10);
    assert.deepEqual(r.segs, [[0, 3]]);
    assert.equal(r.deltaQ, -6);
    // Multi-segment maps slide as one body (inner cut geometry held).
    r = slideSegs([[1, 2], [4, 6]], 0.5, 10);
    assert.deepEqual(r.segs, [[1.5, 2.5], [4.5, 6.5]]);
    assert.equal(segsPeriod(r.segs, 10), 3);
    // Full span: nothing to slide against.
    r = slideSegs(null, 3, 10);
    assert.deepEqual(r.segs, [[0, 10]]);
    assert.equal(r.deltaQ, 0);
});
