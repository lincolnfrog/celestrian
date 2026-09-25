/**
 * THE PERIOD LAW (ui/js/timeline_model.js ownPeriod / periodContribution
 * / islandCycle) against the `period_law_cases` tree fixtures in
 * shared/timing_golden.json — the same fixtures tests/period_law_tests.cc
 * runs through src/period_law.h's two providers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ownPeriod, periodContribution, islandCycle } from '../timeline_model.js';
import { loadSharedJson } from './helpers.mjs';

const golden = loadSharedJson('timing_golden.json');

/** Providers over the FIXTURE shape ({window, sequenceLen, children}). */
const providers = {
    mapPeriod: n => (n.window ? n.window[1] - n.window[0] : 0),
    seqLen: n => n.sequenceLen || 0,
    children: n => n.children || [],
};

function index(nodes, into) {
    for (const n of nodes) {
        into.set(n.id, n);
        if (n.children) index(n.children, into);
    }
    return into;
}

test('golden: the period law over tree fixtures', () => {
    for (const c of golden.period_law_cases) {
        const root = { id: 'root', type: 'stack', children: c.tree };
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

test('the drift clause: a period that fits no whole number of Qs contributes nothing (Q22)', () => {
    const q = { ...providers, quantum: 1000 };
    const keys = { id: 'k', type: 'clip', duration: 1300 };
    const half = { id: 'h', type: 'clip', duration: 500 };
    const drums = { id: 'd', type: 'clip', duration: 2000 };
    assert.equal(ownPeriod(keys, q), 1300, 'it still PLAYS its own length');
    assert.equal(periodContribution(keys, q), 0, 'but folds into nothing');
    assert.equal(periodContribution(half, q), 500, 'an exact divisor coheres');
    assert.equal(periodContribution(drums, q), 2000, 'a whole multiple coheres');
    const root = { id: 'root', type: 'stack', children: [keys, half, drums] };
    assert.equal(islandCycle(root, q, 1000, 44100), 2000,
        'the island cycles on the coherent loops, never lcm(1300, …)');
    assert.equal(periodContribution(keys, providers), 1300,
        'no quantum on the providers: no drift clause');
    const song = { id: 's', type: 'stack', sequenceLen: 1300,
                   children: [drums] };
    assert.equal(periodContribution(song, q), 1300,
        'a song holder is exempt (S10: its drift is the song\'s own)');
});

test('a recording clip contributes nothing (a live take is not a period yet)', () => {
    const rec = { type: 'clip', duration: 1234, isRecording: true };
    assert.equal(periodContribution(rec, providers), 0);
    assert.equal(ownPeriod(rec, providers), 1234, 'its own period is its length');
});
