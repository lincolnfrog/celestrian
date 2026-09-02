/**
 * Shared helpers for the js/tests suite — the fixtures and assertions
 * that used to be copy-pasted per file (nodeById ×4, record-a-take
 * builders ×5, golden-fixture loaders ×4, LCG ×3, `near`, engine-shaped
 * state builders). Pure module: importing it has NO side effects — in
 * particular it never imports the mock backend statically, so golden /
 * pure-math tests stay singleton-free. (mock/rate.js IS imported
 * statically — it is a bare rate variable with no graph state and no
 * side effects beyond reading CELESTRIAN_MOCK_RATE.) Helpers that drive
 * the mock (recordTake) import it lazily; mock state is module-global
 * per test process, which is safe because node runs each test file in
 * its own process — do not build cross-file fixtures that assume
 * otherwise.
 *
 * SAMPLE RATE: nothing here spells 44100. MOCK_Q follows the mock's
 * rate and PERF republishes it live, so `CELESTRIAN_MOCK_RATE=48000
 * npm test` re-rates the whole suite (see mock/rate.js).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { getSampleRate, quantumSamples } from '../mock/rate.js';

// The production math, so tests never re-implement it (the old local
// lcm copies drifted into the overflow-prone (a*b)/gcd form).
export { gcd, lcm } from '../math_utils.js';
// Rate control for tests that want to assert at a specific rate. Call
// setSampleRate BEFORE loadScenario/recordTake — fixture lengths and
// MOCK_Q are read when the scenario loads / this module evaluates.
export { getSampleRate, setSampleRate } from '../mock/rate.js';

/** The mock backend's quantum in most scenarios: 1 s of audio at its
 *  rate (the literal 44100 before the rate became a variable). */
export const MOCK_Q = quantumSamples();
/** The `perf` blob deriveViewModel expects on engine-shaped states.
 *  A live getter, so a mid-test setSampleRate is reflected. */
export const PERF = { get sampleRate() { return getSampleRate(); } };

/** Repo root (…/celestrian) — the ui test suite's sanctioned reach to
 *  shared/ fixtures and C++ sources (a documented layout dependency). */
export const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Parse a JSON fixture from <repo>/shared/ (timing_golden.json etc.). */
export function loadSharedJson(name) {
    return JSON.parse(readFileSync(path.join(repoRoot, 'shared', name), 'utf8'));
}

/** Depth-first search of an engine-shaped node tree by id. */
export function nodeById(id, nodes) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const found = n.nodes && nodeById(id, n.nodes);
        if (found) return found;
    }
    return null;
}

/** Depth-first search by predicate (first match wins). */
export function findFirst(nodes, pred) {
    for (const n of nodes || []) {
        if (pred(n)) return n;
        const found = n.nodes && findFirst(n.nodes, pred);
        if (found) return found;
    }
    return null;
}

/** Depth-first search by node name. */
export function findByName(nodes, name) {
    return findFirst(nodes, n => n.name === name);
}

/**
 * Record a take of `lengthSamples` through the mock: create a clip in
 * `parentId`, arm it, drive most of the take, request the stop
 * `stopEarly` samples before the length (a stop exactly ON a boundary
 * pads a whole extra Q — nextStopBoundary), then advance `settle`
 * samples so the transport crosses the boundary and the take commits at
 * exactly `lengthSamples` (the engine's AWAITING-STOP: stops always pad
 * forward, owner ruling 2026-07-10). Pass stopEarly 0 / settle 0 for a
 * first take with no prior Q (raw commit, no boundary wait).
 * Lazily imports the mock so pure tests importing helpers stay clean.
 */
export async function recordTake(parentId, lengthSamples,
    { stopEarly = 100, settle = stopEarly } = {}) {
    const { callNative, advanceBy } = await import('../mock_backend.js');
    const id = await callNative('createNode', 'clip', parentId);
    await callNative('startRecordingInNode', id);
    advanceBy(lengthSamples - stopEarly);
    await callNative('stopRecordingInNode', id);
    if (settle > 0) advanceBy(settle);
    return id;
}

/** assert |a − b| < eps — the float near-equality every suite inlined. */
export const near = (a, b, eps = 1e-9) =>
    assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

/** Deterministic Park–Miller LCG → () ⇒ [0, 1). Same generator the
 *  property tests seeded (live peaks, random-scene I2/I8). */
export function makeLcg(seed) {
    return () => (seed = (seed * 48271) % 2147483647) / 2147483647;
}

/* ------- engine-shaped state builders (view-model test scenes) ------- */

/** Quantum the view-model scenes run at — deliberately NOT the mock's
 *  own rate, so absolute and Q-relative values never coincide (that
 *  coincidence hid two field bugs). Follows the mock rate away rather
 *  than pinning 48000, so a 48 kHz sweep keeps the property. */
export const SCENE_Q = getSampleRate() === 48000 ? 96000 : 48000;

let nextId = 1;
/** A committed clip of `periodQ` quantums (engine-published shape). */
export function clip(periodQ, extra = {}) {
    return Object.assign({
        id: `clip-${nextId++}`, name: `clip ${periodQ}Q`, type: 'clip',
        duration: periodQ * SCENE_Q, origin: 0, effectiveQuantum: SCENE_Q,
        loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
        isMuted: false, isRecording: false, isPendingStart: false,
    }, extra);
}

/** A stack (group) holding `children`, expanded by default. */
export function stack(children, extra = {}) {
    return Object.assign({
        id: `stack-${nextId++}`, name: 'stack', type: 'stack',
        nodes: children, origin: 0, effectiveQuantum: SCENE_Q,
        loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
        isMuted: false, isRecording: false,
    }, extra);
}

/** A getGraphState-shaped state. masterPos defaults deep into playback
 *  (25 cycles of 12Q + 5.25Q) so cycle-relative math is exercised. */
export function state(nodes, extra = {}) {
    return Object.assign({
        masterPos: (25 * 12 + 5.25) * SCENE_Q, isPlaying: true, origin: 0,
        soloedId: '', nodes,
    }, extra);
}

/** Assert one lane's reps exactly tile [0, cycleQ): start at 0, abut
 *  without gaps or overlaps, end at the cycle, with exactly ONE take
 *  (non-ghost) tile — the executable I2 invariant. */
export function assertTilesCycle(lane, cycleQ) {
    const reps = lane.reps;
    assert.ok(reps.length > 0, `${lane.name}: has reps`);
    assert.equal(reps[0].startQ, 0, `${lane.name}: tiles start at 0`);
    for (let i = 0; i < reps.length; i++) {
        assert.ok(reps[i].endQ > reps[i].startQ, `${lane.name}: tile ${i} non-empty`);
        if (i > 0) assert.equal(reps[i].startQ, reps[i - 1].endQ,
            `${lane.name}: tile ${i} abuts tile ${i - 1}`);
    }
    assert.equal(reps[reps.length - 1].endQ, cycleQ, `${lane.name}: tiles end at cycle`);
    assert.equal(reps.filter(r => !r.ghost).length, 1,
        `${lane.name}: exactly one take tile`);
}
