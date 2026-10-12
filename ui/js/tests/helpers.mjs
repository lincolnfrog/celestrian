/**
 * Shared fixtures and assertions for the js/tests suite. Pure module:
 * importing it has NO side effects, and it never imports the mock
 * backend statically, so golden and pure-math tests stay singleton-free
 * (mock/rate.js is a bare rate variable with no graph state). recordTake
 * imports the mock lazily; prologues that drive the mock live in
 * mock_scene.mjs, DOM stand-ins in dom_stub.mjs. Mock state is
 * module-global per test process — node runs each test file in its own
 * process — so no fixture may assume state shared across files.
 *
 * SAMPLE RATE: nothing here spells 44100. MOCK_Q follows the mock's
 * rate and PERF republishes it live, so `CELESTRIAN_MOCK_RATE=48000
 * npm test` re-rates the whole suite (see mock/rate.js).
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { getSampleRate, quantumSamples } from '../mock/rate.js';

/** The mock backend's quantum in most scenarios: 1 s of audio at its
 *  rate. */
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

/** A capture the C++ suite writes to <repo>/shared/ (gitignored), with
 *  the `skip` option for the tests that replay it: until the
 *  CelestrianTests Debug binary has run they skip, saying how to make
 *  it (the runner's summary counts them under `skipped`). */
export function loadCapture(name) {
    const found = existsSync(path.join(repoRoot, 'shared', name));
    return {
        fixture: found ? loadSharedJson(name) : null,
        skip: found ? false
            : `shared/${name} not found — the C++ suite writes it: build the CelestrianTests ` +
              'target and run build/CelestrianTests_artefacts/Debug/CelestrianTests',
    };
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
 * exactly `lengthSamples` (the engine's AWAITING-STOP: a stop always
 * pads forward). Pass stopEarly 0 / settle 0 for a first take with no
 * prior Q: it has no boundary to wait for and commits raw, at the audio
 * callback after its stop — which the settle is, even over no samples.
 */
export async function recordTake(parentId, lengthSamples,
    { stopEarly = 100, settle = stopEarly } = {}) {
    const { callNative, advanceBy } = await import('../mock_backend.js');
    const id = await callNative('createNode', 'clip', parentId);
    await callNative('startRecordingInNode', id);
    advanceBy(lengthSamples - stopEarly);
    await callNative('stopRecordingInNode', id);
    advanceBy(settle);
    return id;
}

/** assert |a − b| < eps, `msg` naming what was compared. */
export const near = (a, b, msg = '', eps = 1e-9) =>
    assert.ok(Math.abs(a - b) < eps, `${msg && msg + ': '}${a} ≉ ${b}`);

/** Deterministic Park–Miller LCG → () ⇒ the next integer state. */
export function makeLcgInt(seed) {
    return () => (seed = (seed * 48271) % 2147483647);
}
/** The same generator as () ⇒ [0, 1). */
export function makeLcg(seed) {
    const next = makeLcgInt(seed);
    return () => next() / 2147483647;
}

/* ------- engine-shaped scenes (view-model tests) -------
 * One family: node builders in Q at SCENE_Q, and two roots — `island`,
 * the published island (quantum, zero, raw clock), and `state`, a bare
 * poll deep into playback whose Q the view model reads off its nodes. */

/** Quantum of the view-model scenes: never the mock's own rate, so an
 *  absolute value and a Q-relative one cannot coincide. */
export const SCENE_Q = getSampleRate() === 48000 ? 96000 : 48000;
const atQ = q => Math.round(q * SCENE_Q);

/** A committed clip `id` performed at `originQ`, `durationQ` long. */
export const clipAt = (id, originQ, durationQ, extra = {}) => ({
    id, name: id, type: 'clip', origin: atQ(originQ),
    duration: atQ(durationQ), effectiveQuantum: SCENE_Q,
    loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
    isMuted: false, isRecording: false, isPendingStart: false,
    periodSource: 'own', ...extra,
});
/** clipAt looped to the window [aQ, bQ) of its take. */
export const windowed = (id, originQ, durationQ, [aQ, bQ], extra = {}) =>
    clipAt(id, originQ, durationQ, {
        loopStart: atQ(aQ), loopEnd: atQ(bQ), windowActive: true, ...extra,
    });
/** clipAt under a multi-segment map, `segsQ` = [[a, b], …]. */
export const mapped = (id, originQ, durationQ, segsQ, extra = {}) =>
    clipAt(id, originQ, durationQ, {
        segments: segsQ.flat().map(atQ), windowActive: true, ...extra,
    });
/** An anchored group `id` at `originQ` over `nodes`. */
export const groupAt = (id, originQ, nodes, extra = {}) => ({
    id, name: id, type: 'stack', anchored: true, origin: atQ(originQ),
    effectiveQuantum: SCENE_Q, nodes, ...extra,
});
/** The published island over `nodes`, its raw clock at `clockQ`. */
export const island = (nodes, { clockQ = 0, ...extra } = {}) => ({
    id: 'root', type: 'stack', quantum: SCENE_Q, islandZero: 0, definerId: '',
    isPlaying: true, masterPos: 0, islandPos: atQ(clockQ), perf: PERF,
    nodes, ...extra,
});

let nextId = 1;
/** An anonymous committed clip of `periodQ` quantums at origin 0. */
export const clip = (periodQ, extra = {}) =>
    clipAt(`clip-${nextId++}`, 0, periodQ, { name: `clip ${periodQ}Q`, ...extra });

/** A stack (group) holding `children`, expanded by default. */
export function stack(children, extra = {}) {
    return Object.assign({
        id: `stack-${nextId++}`, name: 'stack', type: 'stack',
        nodes: children, origin: 0, effectiveQuantum: SCENE_Q,
        loopStart: 0, loopEnd: 0, loopBypassed: false, windowActive: false,
        isMuted: false, isRecording: false,
    }, extra);
}

/** A bare getGraphState poll. masterPos defaults deep into playback
 *  (25 cycles of 12Q + 5.25Q) so cycle-relative math is exercised. */
export function state(nodes, extra = {}) {
    return Object.assign({
        masterPos: (25 * 12 + 5.25) * SCENE_Q, isPlaying: true, origin: 0,
        soloedId: '', nodes,
    }, extra);
}

/** The view model's lane for node `id`. */
export const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

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
