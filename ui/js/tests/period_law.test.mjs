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
        for (const [id, want] of Object.entries(c.expected)) {
            const node = byId.get(id);
            assert.ok(node, `${c.name}: fixture node ${id}`);
            assert.equal(ownPeriod(node, providers), want.own,
                `${c.name}: own(${id})`);
            assert.equal(periodContribution(node, providers), want.contribution,
                `${c.name}: contribution(${id})`);
        }
        assert.equal(islandCycle(root, providers, c.quantum, c.fallback),
            c.islandCycle, `${c.name}: island cycle`);
        if (c.skip) {
            assert.equal(ownPeriod(root, providers, byId.get(c.skip)),
                c.rootOwnSkipping, `${c.name}: own(root) skipping ${c.skip}`);
        }
    }
});

test('a recording clip contributes nothing (a live take is not a period yet)', () => {
    const rec = { type: 'clip', duration: 1234, isRecording: true };
    assert.equal(periodContribution(rec, providers), 0);
    assert.equal(ownPeriod(rec, providers), 1234, 'its own period is its length');
});
