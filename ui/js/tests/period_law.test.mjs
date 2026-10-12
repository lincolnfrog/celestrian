/**
 * THE PERIOD LAW (ui/js/period_law.js ownPeriod / periodContribution
 * / islandCycle) against the `period_law_cases` tree fixtures in
 * shared/timing_golden.json — the same fixtures tests/period_law_tests.cc
 * runs through src/period_law.h's two providers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ownPeriod, periodContribution, islandCycle } from '../period_law.js';
import { publishedLaw, frameLaw } from '../vm/published.js';
import { deriveViewModel } from '../view_model.js';
import { fromSamples } from '../qtime.js';
import { loadSharedJson } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

/** Providers over the law's reading of a fixture node (lawNode). */
const providers = {
    mapPeriod: n => (n.window ? n.window[1] - n.window[0] : 0),
    seqLen: n => n.sequenceLen || 0,
    children: n => n.children || [],
    slotPeriod: n => n.slot || 0,
};

/** A fixture node as the law reads one. The fixture's `duration` is the
 * COMMITTED length; while a take is `recording` into the clip the law's
 * `duration` is the live count (`captured`), and the committed length is
 * the `slot` the take is a new take of (0 = a first take). */
function lawNode(n) {
    const o = { ...n, isRecording: !!n.recording,
                duration: n.recording ? n.captured : n.duration,
                slot: n.recording ? n.duration : 0 };
    if (n.children) o.children = n.children.map(lawNode);
    return o;
}

function index(nodes, into) {
    for (const n of nodes) {
        into.set(n.id, n);
        if (n.children) index(n.children, into);
    }
    return into;
}

test('golden: the period law over tree fixtures', () => {
    for (const c of golden.period_law_cases) {
        const root = { id: 'root', type: 'stack', children: c.tree.map(lawNode) };
        const byId = index([root], new Map());
        // The case's island Q rides the providers (the drift clause, Q22)
        // exactly as src/period_law.h's providers carry it.
        const withQ = { ...providers, quantum: c.quantum };
        for (const [id, want] of Object.entries(c.expected)) {
            const node = byId.get(id);
            assert.ok(node, `${c.name}: fixture node ${id}`);
            assert.equal(ownPeriod(node, withQ), want.own,
                `${c.name}: own(${id})`);
            assert.equal(periodContribution(node, withQ), want.contribution,
                `${c.name}: contribution(${id})`);
        }
        assert.equal(islandCycle(root, withQ, c.quantum, c.fallback),
            c.islandCycle, `${c.name}: island cycle`);
        if (c.skip) {
            assert.equal(ownPeriod(root, withQ, byId.get(c.skip)),
                c.rootOwnSkipping, `${c.name}: own(root) skipping ${c.skip}`);
        }
    }
});

/* ---- THE FRAME IS THE LAW'S CYCLE ----
 * The same fixtures in the PUBLISHED node shape (what the engine and the
 * mock hand the page), through deriveViewModel: the frame it draws and
 * the loop its cursor folds on are the island cycle the transport wraps
 * on. */

/** A fixture node as published metadata under the island Q `quantum`. A
 * step audition publishes its derived window — the step — over the
 * holder's own. A clip a take is `recording` into publishes the live
 * count as `duration`; its committed length rides `periodQ`, as every
 * clip's does. */
function published(n, quantum) {
    const o = { id: n.id, type: n.type, name: n.id, duration: n.duration || 0,
                origin: 0, periodSource: n.periodSource || 'own',
                loopStart: 0, loopEnd: 0, windowActive: false,
                loopBypassed: false, isRecording: false };
    if (n.type === 'clip') o.periodQ = fromSamples(n.duration || 0, quantum);
    if (n.recording) {
        o.isRecording = true;
        o.duration = n.captured;
    }
    if (n.window) {
        o.loopStart = n.window[0];
        o.loopEnd = n.window[1];
        o.windowActive = true;
    }
    if (n.sequenceLen) o.sequence = { steps: [{ name: 'A', len: n.sequenceLen }] };
    if (Number.isInteger(n.audition)) {
        o.sequence.auditionStep = n.audition;
        o.loopStart = 0;
        o.loopEnd = n.sequenceLen;
        o.windowActive = true;
    }
    if (n.type === 'stack') {
        o.nodes = (n.children || []).map(k => published(k, quantum));
        o.anchored = true;
    }
    return o;
}

/** A case's tree as published nodes under its own Q. */
const publishedTree = c => c.tree.map(n => published(n, c.quantum));

/** A published island at rest: Q established, no definer designated. */
const islandOf = (nodes, quantum) => ({
    id: 'root', quantum, islandZero: 0, islandPos: 0, masterPos: 0,
    definerId: '', nodes,
});

test('golden: the law over the PUBLISHED shape (publishedLaw / frameLaw)', () => {
    for (const c of golden.period_law_cases) {
        const root = { id: 'root', type: 'stack', nodes: publishedTree(c) };
        const byId = new Map();
        (function index(n) {
            byId.set(n.id, n);
            (n.nodes || []).forEach(index);
        })(root);
        for (const law of [publishedLaw(c.quantum), frameLaw(c.quantum)]) {
            for (const [id, want] of Object.entries(c.expected)) {
                assert.equal(ownPeriod(byId.get(id), law), want.own,
                    `${c.name}: own(${id})`);
                assert.equal(periodContribution(byId.get(id), law),
                    want.contribution, `${c.name}: contribution(${id})`);
            }
            assert.equal(islandCycle(root, law, c.quantum, c.fallback),
                c.islandCycle, `${c.name}: island cycle`);
        }
    }
});

test('an audition is its holder\'s map as HEARD, and no part length to the FRAME', () => {
    // A 4Q song of two 2Q steps, auditioning the second: the transport
    // loops the step; the frame keeps the song.
    const g = { id: 'g', type: 'stack', anchored: true, origin: 0,
                loopStart: 2000, loopEnd: 4000, windowActive: true,
                sequence: { steps: [{ len: 2000 }, { len: 2000 }], auditionStep: 1 },
                nodes: [published({ id: 'c', type: 'clip', duration: 1000 }, 1000)] };
    assert.equal(ownPeriod(g, publishedLaw(1000)), 2000, 'heard: the step');
    assert.equal(ownPeriod(g, frameLaw(1000)), 4000, 'the frame: the song');
    const vm = deriveViewModel(islandOf([g], 1000));
    assert.equal(vm.lcmQ, 4, 'the frame stays the song');
    assert.equal(vm.loopCycleQ, 2, 'the cursor loops the step');
});

test('golden: every Q-established fixture frames at its island cycle', () => {
    let ran = 0;
    for (const c of golden.period_law_cases) {
        if (!(c.quantum > 1)) continue;
        const vm = deriveViewModel(islandOf(publishedTree(c), c.quantum));
        assert.equal(Math.round(vm.lcmQ * c.quantum), c.islandCycle,
            `${c.name}: the frame`);
        assert.equal(Math.round(vm.loopCycleQ * c.quantum), c.islandCycle,
            `${c.name}: the audible loop`);
        ran++;
    }
    assert.ok(ran >= 15, `the fixtures ran (${ran})`);
});

test('a window that divides Q sets its part\'s length at any depth', () => {
    const Q = 1000;
    const half = published({ id: 'c', type: 'clip', duration: 2000, window: [0, 500] }, Q);
    const beat = published({ id: 'b', type: 'clip', duration: 1000 }, Q);
    // Loose at the top, or inside a plain group: the 2Q take plays its
    // half-Q window, so the island cycles on Q.
    assert.equal(deriveViewModel(islandOf([half, beat], Q)).lcmQ, 1, 'top-level');
    const group = (children, window) =>
        published({ id: 'g', type: 'stack', children, window }, Q);
    const halfTake = { id: 'c', type: 'clip', duration: 2000, window: [0, 500] };
    assert.equal(deriveViewModel(islandOf([group([halfTake]), beat], Q)).lcmQ, 1,
        'nested');
    // A group whose OWN window is half a Q over 2Q of content.
    const whole = { id: 'd', type: 'clip', duration: 2000 };
    assert.equal(
        deriveViewModel(islandOf([group([whole], [0, 500]), beat], Q)).lcmQ, 1,
        'a windowed group');
});
