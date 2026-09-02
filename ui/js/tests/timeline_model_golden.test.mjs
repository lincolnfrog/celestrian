/**
 * Timeline Model Golden Vector Test (JS side)
 *
 * Runs ui/js/timeline_model.js against shared/timing_golden.json — the same
 * vectors tests/timing_golden_tests.cc runs against src/timing.h. If both
 * suites pass, the JS and C++ timing math agree. Ghost tiling is JS-only
 * (the engine does not render ghosts) and is pinned here directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    timelineLcm, launchPointFor, playheadPercent,
    nextStopBoundary, snapCommittedDuration,
    armTarget, originQ, throughMapDest
} from '../timeline_model.js';
import { toSamples } from '../qtime.js';
import { mapPeriod, mapOffset, seamDistance, heardOffsetOf } from '../time_map.js';
import { loadSharedJson, near } from './helpers.mjs';

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

test('golden: timelineLcm', () => {
    for (const c of golden.lcm_cases) {
        check(timelineLcm(c.durations, c.quantum), c.expected, c.name);
    }
});

test('golden: launchPointFor', () => {
    for (const c of golden.launch_point_cases) {
        check(launchPointFor(c.startPhase, c.duration), c.expected, c.name);
    }
});

test('golden: playheadPercent', () => {
    for (const c of golden.playhead_cases) {
        near(playheadPercent(c.masterPos, c.launchPoint, c.duration), c.expected);
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
        const q = originQ(c.origin, c.epoch, c.qSamples);
        check(q.num, c.expectedNum, `originQ num: ${c.name}`);
        check(q.den, c.expectedDen, `originQ den: ${c.name}`);
        // Lossless at the same exchange rate: Q → samples lands exactly (I1).
        check(toSamples(q, c.qSamples), c.origin - c.epoch,
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
