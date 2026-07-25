/**
 * Timeline Model Golden Vector Test (JS side)
 *
 * Runs ui/js/timeline_model.js against shared/timing_golden.json — the same
 * vectors tests/timing_golden_tests.cc runs against src/timing.h. If both
 * suites pass, the JS and C++ timing math agree.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
    timelineLcm, launchPointFor, playheadPercent,
    nextStopBoundary, snapCommittedDuration, computeGhostTiles,
    armTarget, originQ, throughMapDest
} from '../timeline_model.js';
import { toSamples } from '../qtime.js';
import { mapPeriod, mapOffset, seamDistance, heardOffsetOf } from '../time_map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/timing_golden.json'), 'utf8'));

let failures = 0;
function check(actual, expected, name) {
    const ok = typeof expected === 'number' && !Number.isInteger(expected)
        ? Math.abs(actual - expected) < 1e-9
        : actual === expected;
    if (!ok) {
        failures++;
        console.error(`  FAIL: ${name} — expected ${expected}, got ${actual}`);
    }
}

console.log('Golden: timelineLcm');
for (const c of golden.lcm_cases) {
    check(timelineLcm(c.durations, c.quantum), c.expected, c.name);
}

console.log('Golden: launchPointFor');
for (const c of golden.launch_point_cases) {
    check(launchPointFor(c.startPhase, c.duration), c.expected, c.name);
}

console.log('Golden: playheadPercent');
for (const c of golden.playhead_cases) {
    const actual = playheadPercent(c.masterPos, c.launchPoint, c.duration);
    if (Math.abs(actual - c.expected) > 1e-9) {
        failures++;
        console.error(`  FAIL: ${c.name} — expected ${c.expected}, got ${actual}`);
    }
}

console.log('Golden: armTarget');
for (const c of golden.arm_target_cases) {
    check(armTarget(c.rel, c.quantum, c.contextLoop), c.expected, c.name);
}

console.log('Golden: nextStopBoundary');
for (const c of golden.stop_boundary_cases) {
    check(nextStopBoundary(c.recordedLength, c.quantum), c.expected, c.name);
}

console.log('Golden: snapCommittedDuration');
for (const c of golden.snap_cases) {
    const r = snapCommittedDuration(c.recordedLength, c.quantum);
    check(r.duration, c.expectedDuration, `${c.name} (duration)`);
    check(r.loopEnd, c.expectedLoopEnd, `${c.name} (loopEnd)`);
    check(r.snapped, c.expectedSnapped, `${c.name} (snapped)`);
}

console.log('Golden: originQ (D-T3 physical/musical boundary projection)');
for (const c of golden.qtime_origin_cases) {
    const q = originQ(c.origin, c.epoch, c.qSamples);
    check(q.num, c.expectedNum, `originQ num: ${c.name}`);
    check(q.den, c.expectedDen, `originQ den: ${c.name}`);
    // Lossless at the same exchange rate: Q → samples lands exactly (I1).
    check(toSamples(q, c.qSamples), c.origin - c.epoch, `originQ round-trip: ${c.name}`);
}

console.log('Golden: through-map arm (heard armTarget on the map-period grid)');
for (const c of golden.through_map_arm_cases) {
    const map = { segs: c.segments };
    const tRel = armTarget(c.relHeard, c.quantum, mapPeriod(map));
    check(tRel, c.expectedHeardTargetRel, `${c.name} (heard target)`);
    check(mapOffset(map, tRel), c.expectedInnerOffset, `${c.name} (inner offset)`);
}

console.log('Golden: through-map capture fold (throughMapDest)');
for (const c of golden.through_map_dest_cases) {
    const map = { segs: c.segments };
    for (const p of c.probes) {
        check(throughMapDest(p.i, c.anchorOff, map, c.commitCycle), p.dest,
            `${c.name} dest(i=${p.i})`);
    }
}

console.log('Golden: TimeMap inverse (heardOffsetOf)');
for (const c of golden.map_inverse_cases) {
    const map = { segs: c.segments };
    for (const p of c.probes) {
        check(heardOffsetOf(map, p.inner), p.heard, `${c.name} heardOffsetOf(${p.inner})`);
    }
}

console.log('Golden: TimeMap (reified map: period / mapOffset / seamDistance)');
for (const c of golden.time_map_cases) {
    const map = { segs: c.segments };
    check(mapPeriod(map), c.expectedPeriod, `${c.name} (period)`);
    for (const p of c.probes) {
        check(mapOffset(map, p.h), p.inner, `${c.name} mapOffset(h=${p.h})`);
        check(seamDistance(map, p.h), p.seam, `${c.name} seamDistance(h=${p.h})`);
    }
}

// --- Ghost tiling (JS-only; the C++ engine does not render ghosts) ---
console.log('Ghost tiles: 1Q clip at 0 in 4Q timeline -> 3 ghosts');
{
    const tiles = computeGhostTiles({ clipStartPx: 0, clipWidthPx: 200, timelineWidthPx: 800 });
    check(tiles.length, 3, '1Q+4Q ghost count (recording.md: 3 ghosts)');
    check(tiles.map(t => t.x).join(','), '200,400,600', '1Q+4Q ghost positions');
}

console.log('Ghost tiles: 1Q clip anchored at 2Q in 4Q timeline -> wrap-around ghosts');
{
    const tiles = computeGhostTiles({ clipStartPx: 400, clipWidthPx: 200, timelineWidthPx: 800 });
    check(tiles.map(t => t.x).join(','), '0,200,600', 'anchored clip left-wrap + right ghosts');
}

console.log('Ghost tiles: clip fills timeline -> no ghosts');
{
    const tiles = computeGhostTiles({ clipStartPx: 0, clipWidthPx: 800, timelineWidthPx: 800 });
    check(tiles.length, 0, '4Q clip in 4Q timeline has no ghosts');
}

if (failures === 0) {
    console.log('PASS: all golden vectors match timeline_model.js');
} else {
    console.error(`FAIL: ${failures} golden vector mismatch(es)`);
    process.exitCode = 1;
}
