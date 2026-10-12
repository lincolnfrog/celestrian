/**
 * Timeline Model Golden Vector Test (JS side)
 *
 * Runs ui/js/timeline_model.js, time_map.js and math_utils.js against
 * shared/timing_golden.json — the same vectors tests/timing_golden_tests.cc
 * runs against src/timing.h and the headers it gathers (time_map.h,
 * qtime.h). If both suites pass, the JS and C++ timing math agree.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    timelineLcm, launchPointFor,
    nextStopBoundary, snapCommittedDuration,
    armTarget, originQ, throughMapDest
} from '../timeline_model.js';
import { toSamples } from '../qtime.js';
import {
    mapPeriod, mapOffset, seamDistance, heardOffsetOf, innerAt, stackFold,
} from '../time_map.js';
import { posMod } from '../math_utils.js';
import { loadSharedJson, MOCK_Q as Q } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

/** Exact for integers, 1e-9-near for fractional expectations. */
function check(actual, expected, name) {
    if (typeof expected === 'number' && !Number.isInteger(expected)) {
        assert.ok(Math.abs(actual - expected) < 1e-9,
            `${name}: expected ${expected}, got ${actual}`);
    } else {
        assert.equal(actual, expected, name);
    }
}

test('golden: posMod (the fold; the identity with no modulus)', () => {
    assert.ok(golden.pos_mod_cases.length > 0, 'pos_mod_cases present');
    for (const c of golden.pos_mod_cases) {
        // Strict: a folded multiple of the modulus is 0, never −0.
        assert.equal(posMod(c.x, c.m), c.expected, `posMod(${c.x}, ${c.m})`);
    }
});

test('golden: timelineLcm', () => {
    for (const c of golden.lcm_cases) {
        check(timelineLcm(c.durations, c.quantum), c.expected, c.name);
    }
});

test('timelineLcm rounds float jitter before LCM-ing (no cycle explosion)', () => {
    // A committed duration can arrive with float residue. 1Q + 4Q +
    // (3Q ± ε): the ε is ignored — 12Q, not astronomical.
    assert.equal(timelineLcm([Q, 4 * Q, 3 * Q + 0.00001], Q), 12 * Q);
    assert.equal(timelineLcm([Q, 4 * Q, 3 * Q - 0.00001], Q), 12 * Q);
    // A jittered QUANTUM is rounded the same way.
    assert.equal(timelineLcm([Q, 3 * Q], Q + 0.4), 3 * Q);
});

test('golden: launchPointFor', () => {
    for (const c of golden.launch_point_cases) {
        check(launchPointFor(c.startPhase, c.duration), c.expected, c.name);
    }
});

test('golden: armTarget', () => {
    for (const c of golden.arm_target_cases) {
        check(armTarget(c.rel, c.quantum, c.contextLoop), c.expected, c.name);
    }
});

test('golden: nextStopBoundary', () => {
    for (const c of golden.stop_boundary_cases) {
        check(nextStopBoundary(c.recordedLength, c.quantum), c.expected, c.name);
    }
});

test('golden: snapCommittedDuration', () => {
    for (const c of golden.snap_cases) {
        const r = snapCommittedDuration(c.recordedLength, c.quantum);
        check(r.duration, c.expectedDuration, `${c.name} (duration)`);
        check(r.loopEnd, c.expectedLoopEnd, `${c.name} (loopEnd)`);
        check(r.snapped, c.expectedSnapped, `${c.name} (snapped)`);
    }
});

test('golden: originQ (D-T3 physical/musical boundary projection)', () => {
    for (const c of golden.qtime_origin_cases) {
        const q = originQ(c.origin, c.zero, c.qSamples);
        check(q.num, c.expectedNum, `originQ num: ${c.name}`);
        check(q.den, c.expectedDen, `originQ den: ${c.name}`);
        // Lossless at the same exchange rate: Q → samples lands exactly (I1).
        check(toSamples(q, c.qSamples), c.origin - c.zero,
            `originQ round-trip: ${c.name}`);
    }
});

test('golden: through-map arm (heard armTarget on the map-period grid)', () => {
    for (const c of golden.through_map_arm_cases) {
        const map = { segs: c.segments };
        const tRel = armTarget(c.relHeard, c.quantum, mapPeriod(map));
        check(tRel, c.expectedHeardTargetRel, `${c.name} (heard target)`);
        check(mapOffset(map, tRel), c.expectedInnerOffset, `${c.name} (inner offset)`);
    }
});

test('golden: through-map capture fold (throughMapDest)', () => {
    for (const c of golden.through_map_dest_cases) {
        const map = { segs: c.segments };
        for (const p of c.probes) {
            check(throughMapDest(p.i, c.anchorOff, map, c.commitCycle), p.dest,
                `${c.name} dest(i=${p.i})`);
        }
    }
});

test('golden: TimeMap inverse (heardOffsetOf)', () => {
    for (const c of golden.map_inverse_cases) {
        const map = { segs: c.segments };
        for (const p of c.probes) {
            check(heardOffsetOf(map, p.inner), p.heard,
                `${c.name} heardOffsetOf(${p.inner})`);
        }
    }
});

test('golden: innerAt (THE RENDER EQUATION, stated once)', () => {
    for (const c of golden.inner_at_cases) {
        const map = { segs: c.segments };
        for (const p of c.probes) {
            const at = innerAt(p.t, c.origin, map, c.fold);
            check(at.h, p.h, `${c.name} h(t=${p.t})`);
            check(at.inner, p.inner, `${c.name} inner(t=${p.t})`);
            check(at.run, p.run, `${c.name} run(t=${p.t})`);
            assert.equal(at.rest, p.rest, `${c.name} rest(t=${p.t})`);
        }
    }
});

test('golden: stackFold (the map and fold a stack\'s children hear through)', () => {
    assert.ok(golden.stack_fold_cases.length > 0, 'stack_fold_cases present');
    for (const c of golden.stack_fold_cases) {
        const f = stackFold({ segs: c.map }, c.periodFromContext, c.ownPeriod,
                            c.contextCycle);
        const want = c.expected;
        assert.deepEqual(f.eff.segs, want.eff, `${c.name} (eff)`);
        assert.equal(f.fold, want.fold, `${c.name} (fold)`);
        assert.equal(f.oneShot, want.oneShot, `${c.name} (one-shot)`);
        assert.equal(f.folds, want.eff.length > 0, `${c.name} (folds)`);
    }
});

test('golden: TimeMap (reified map: period / mapOffset / seamDistance)', () => {
    for (const c of golden.time_map_cases) {
        const map = { segs: c.segments };
        check(mapPeriod(map), c.expectedPeriod, `${c.name} (period)`);
        for (const p of c.probes) {
            check(mapOffset(map, p.h), p.inner, `${c.name} mapOffset(h=${p.h})`);
            check(seamDistance(map, p.h), p.seam, `${c.name} seamDistance(h=${p.h})`);
        }
    }
});
