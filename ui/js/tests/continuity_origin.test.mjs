/**
 * THE CONTINUITY RE-ANCHOR PICKS THE NEAREST REPRESENTATIVE (seam-model
 * SM-4 / release-jump F4, 2026-09-23; docs/time_maps.md §5).
 *
 * A map edit while playing re-anchors the origin so the sounding sample
 * keeps sounding. The solve (originForHeard) answers the MOST RECENT
 * pass: for a pure slide that was O + m·P — audibly the same, but the
 * view seats the frame from absolute tops, so the seat flipped with the
 * parity of m (the "sometimes it jumps on release" field report), a
 * group's composite re-keyed (a 240 ms cross-fade), and bypass played
 * the take away from where it was performed. The origin is now the
 * representative nearest the old one modulo the fold: a slide keeps O.
 *
 * The algebra is golden-pinned against the engine
 * (shared/timing_golden.json `continuity_origin_cases`,
 * `nearest_representative_cases` — tests/timing_golden_tests.cc runs the
 * same vectors against heard_index.h); the mock journeys below pin the
 * rider as the dispatch runs it. Engine twin: the scenario S40 and
 * tests/time_map_record_tests.cc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, pauseTransport }
    from '../mock_backend.js';
import { state, findNode } from '../mock/state.js';
import { continuityOriginFor, nearestRepresentative } from '../mock/maps.js';
import { innerAt, heardOffsetOf } from '../time_map.js';
import { deriveViewModel } from '../view_model.js';
import { loadSharedJson, recordTake } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

test('golden: nearestRepresentative (engine heard::nearestRepresentative)', () => {
    for (const c of golden.nearest_representative_cases) {
        assert.equal(nearestRepresentative(c.x, c.ref, c.m), c.expected,
            `nearestRepresentative(${c.x}, ${c.ref}, ${c.m})`);
    }
});

test('golden: continuityOriginFor (engine heard::continuityOriginFor)', () => {
    for (const c of golden.continuity_origin_cases) {
        const oldMap = { segs: c.oldSegments }, newMap = { segs: c.newSegments };
        const got = continuityOriginFor(oldMap, newMap, c.origin, c.t0,
            c.oldFold, c.newFold);
        assert.equal(got, c.expected, c.name);
        const before = innerAt(c.t0, c.origin, oldMap, c.oldFold);
        const after = innerAt(c.t0, got, newMap, c.newFold);
        if (!before.rest && heardOffsetOf(newMap, before.inner) >= 0) {
            assert.equal(after.inner, before.inner,
                `${c.name}: the sounding sample keeps sounding`);
        }
    }
});

/** The F4 layout: 1Q, a 2Q loop, then a 10Q take windowed to 5Q — the
 * earlier lanes' cycle (2Q) does not divide the edited loop's 5Q, so a
 * whole-pass origin shift of odd m would re-seat the frame. Parked
 * `passes` whole 5Q passes of the window past its first, `hQ` into the
 * pass; transport held still (isPlaying, no auto-advance) so every
 * read is exact. */
async function f4Layout(passes, hQ) {
    loadScenario('empty');
    const Q = 1000;
    await recordTake('', Q, { stopEarly: 0, settle: 0 });
    await recordTake('', 2 * Q);
    const c3 = await recordTake('', 10 * Q);
    pauseTransport();
    state.isPlaying = true;
    await callNative('setLoopPoints', c3, 0, 5 * Q);
    const node = findNode(c3);
    const O = node.origin;
    // Park: t − O − a0 = hQ·Q + passes·5Q (a0 = 0), past the present.
    const target = O + Math.round(hQ * Q) + passes * 5 * Q;
    let t = target;
    while (t < state.masterPos) t += 10 * 5 * Q;  // keep the parity
    advanceBy(t - state.masterPos);
    return { Q, c3, O, node };
}

test('a playing slide keeps the origin — whatever the pass count', async () => {
    const seats = [];
    for (const passes of [7, 8]) {
        const { Q, c3, O, node } = await f4Layout(passes, 2.5);
        // Before the fix: the solve came back O + (passes')·5Q.
        await callNative('setLoopPoints', c3, Q, 6 * Q);  // slide +1Q
        assert.equal(node.origin, O,
            `a whole-Q slide after ${passes} passes keeps the origin`);
        await callNative('setLoopPoints', c3, Q + 300, 6 * Q + 300);  // ⌥ free
        assert.equal(node.origin, O,
            `a free slide after ${passes} passes keeps the origin`);
        // Audio continuity is unaffected: the sample sounding at the
        // edit instant still sounds (the node equation, mod 5Q).
        const t0 = state.masterPos;
        const p = innerAt(t0, node.origin, { segs: [[Q + 300, 6 * Q + 300]] }, 5 * Q);
        assert.equal(p.inner, 2.5 * Q, 'the sounding sample is kept');
        // THE SEAT: read off the lanes, it no longer depends on parity.
        seats.push(deriveViewModel(getState()).frameZero);
        // THE DEGRADATION CONTRACT: bypassed, the take plays where it
        // was performed — its origin is still the capture boundary.
        await callNative('toggleLoopWindow', c3);
        assert.equal(node.origin, O, 'bypass: the performed alignment');
    }
    assert.equal(seats[0], seats[1],
        'the frame seats identically after an odd and an even pass count');
});

test('a trim before the playing point moves the origin by the least ' +
     'whole-Q amount', async () => {
    const { Q, c3, O, node } = await f4Layout(7, 3.5);
    // Trim the head [0,5Q) → [1Q,5Q): the sounding 3.5Q is 1Q earlier in
    // the heard pass; the solve is O + m·5Q (m ≥ 7), whose nearest
    // representative modulo the new 4Q period is within ±2Q of O.
    await callNative('setLoopPoints', c3, Q, 5 * Q);
    const d = node.origin - O;
    assert.equal(((d % Q) + Q) % Q, 0, 'a whole number of Qs (I4)');
    assert.ok(Math.abs(d) <= 2 * Q, `the least move (got ${d / Q}Q)`);
    const p = innerAt(state.masterPos, node.origin, { segs: [[Q, 5 * Q]] }, 4 * Q);
    assert.equal(p.inner, 3.5 * Q, 'the sounding sample is kept');
});

test('a sub-Q loop slide keeps the origin (mod its own period, not Q)', async () => {
    const { Q, c3, node } = await f4Layout(0, 0);
    const P = Q / 2;
    await callNative('setLoopPoints', c3, Q, Q + P);  // a Q/2 loop
    const O1 = node.origin;
    // Park an ODD number of Q/2 passes since the origin, 0.3Q into the
    // pass (p0 = 1.3Q): reduced modulo lcm(P, Q) = Q instead of P, the
    // solve O1 + m·P would come back O1 ± Q/2 — a sub-Q re-seat.
    let m = Math.ceil((state.masterPos - O1 - Q - 0.3 * Q) / P);
    if (m % 2 === 0) m += 1;
    advanceBy(O1 + Q + 0.3 * Q + m * P - state.masterPos);
    await callNative('setLoopPoints', c3, Q + 100, Q + P + 100);
    assert.equal(node.origin, O1, 'a sub-Q slide never re-anchors');
});
