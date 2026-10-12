/**
 * The harness's own checks — no engine needed: the differ reports what
 * it should, the ledger claims what it should and names stale claims,
 * and the known-drift list is well-formed. `npm run test:diff` runs
 * this before the suite, so a broken judge cannot pass a run.
 */

import assert from 'node:assert/strict';

import { FIELDS } from './fields.mjs';
import { KNOWN_DRIFT, KNOWN_KEYS, KNOWN_WALK } from './known_drift.mjs';
import { diff, normalise } from './normalize.mjs';
import { Ledger } from './verdict.mjs';

// ------------------------------------------------------------- the differ
const clip = (id, extra = {}) => ({ id, type: 'clip', name: 'n', duration: 100, origin: 5, ...extra });
const state = (nodes, extra = {}) => ({
    id: 'root', quantum: 100, islandZero: 0, islandPos: 7, masterPos: 7, nodes, ...extra,
});
const ctx = (labels, point = 'verb') => ({
    point, labelOf: id => labels[id], viewSettled: true, clockAligned: false, rate: 44100,
    settling: () => false,
});
const keysOf = (a, b) => diff(a, b).map(d => d.key);

const engine = normalise(state([clip('e1')]), ctx({ e1: '@A' }));
assert.deepEqual(keysOf(engine, normalise(state([clip('m1')]), ctx({ m1: '@A' }))), [],
    'ids differ, facts do not');
assert.deepEqual(keysOf(engine, normalise(state([clip('m1', { duration: 50 })]), ctx({ m1: '@A' }))),
    ['@A.duration'], 'one fact differs');
assert.deepEqual(keysOf(engine, normalise(state([clip('m1'), clip('m2')]), ctx({ m1: '@A', m2: '@B' }))),
    ['@B.exists'], 'a node one side lacks is one fact');
assert.deepEqual(
    keysOf(engine, normalise(state([{ id: 'm1', type: 'stack', name: 'n', nodes: [] }]), ctx({ m1: '@A' }))),
    ['@A.type'], 'a node of another kind is one fact');
// Absolute clocks cancel: the same placement from another zero.
assert.deepEqual(
    keysOf(engine, normalise(state([clip('m1', { origin: 905 })], { islandZero: 900 }), ctx({ m1: '@A' }))),
    [], 'an origin is read from the island zero');
// The take flags fold into `hot` at a verb point and are read apart at a block point.
const armed = normalise(state([clip('e1', { duration: 0, isPendingStart: true })]), ctx({ e1: '@A' }));
const capturing = normalise(state([clip('m1', { duration: 0, isRecording: true })]), ctx({ m1: '@A' }));
assert.deepEqual(diff(armed, capturing).map(d => d.key), [], 'armed and capturing are both a take up');
assert.deepEqual(
    keysOf(normalise(state([clip('e1', { duration: 0, isPendingStart: true })]), ctx({ e1: '@A' }, 'block')),
           normalise(state([clip('m1', { duration: 0, isRecording: true })]), ctx({ m1: '@A' }, 'block'))),
    ['@A.isPendingStart', '@A.isRecording'], 'at a block point the flags are compared one by one');
// A window phase within one block of the other is the same phase.
const windowed = (id, playhead) => clip(id, { loopStart: 0, loopEnd: 4000, duration: 8000, windowActive: true, playhead });
assert.deepEqual(
    keysOf(normalise(state([windowed('e1', 0.10)]), ctx({ e1: '@A' }, 'block')),
           normalise(state([windowed('m1', 0.20)]), ctx({ m1: '@A' }, 'block'))),
    [], 'phases 400 samples apart are within a block');
assert.deepEqual(
    keysOf(normalise(state([windowed('e1', 0.95)]), ctx({ e1: '@A' }, 'block')),
           normalise(state([windowed('m1', 0.05)]), ctx({ m1: '@A' }, 'block'))),
    [], 'across the loop\'s seam too');
assert.deepEqual(
    keysOf(normalise(state([windowed('e1', 0.10)]), ctx({ e1: '@A' }, 'block')),
           normalise(state([windowed('m1', 0.40)]), ctx({ m1: '@A' }, 'block'))),
    ['@A.playhead'], 'phases 1200 samples apart are not');

// ------------------------------------------------------------- the ledger
const family = {
    id: 'f',
    everywhere: [{ field: 'takes', engine: 0, mock: 1 }, { field: 'never' }],
    sites: [
        { journey: 'j', step: 's', key: '@A.name', engine: 'x', mock: 'y' },
        { journey: 'j', step: 's', key: '@A.gone', engine: 1, mock: undefined },
    ],
};
const ledger = new Ledger([family]);
const record = (key, e, m, extra = {}) => ({
    journey: 'j', step: 's', verb: 'v', key, scope: key.split('.')[0],
    field: key.split('.').slice(1).join('.'), engine: e, mock: m, ...extra,
});
assert.ok(ledger.judge(record('@A.name', 'x', 'y')), 'a site claims its diff');
assert.equal(ledger.judge(record('@A.name', 'x', 'z')), null, 'not another value');
assert.equal(ledger.judge(record('@A.name', 'x', 'y', { step: 't' })), null, 'not another step');
assert.equal(ledger.judge(record('@A.name', 'x', 'y', { journey: 'k' })), null, 'not another journey');
assert.ok(ledger.judge(record('@B.takes', 0, 1)), 'a pattern claims its field anywhere');
assert.equal(ledger.judge(record('@B.takes', 2, 1)), null, 'and is exact about the values it names');
assert.equal(ledger.stale().length, 2, 'the two claims that matched nothing are stale');

// ------------------------------------------------------ the known-drift list
const ids = new Set();
for (const f of KNOWN_DRIFT) {
    assert.ok(f.id && !ids.has(f.id), `family id unique: ${f.id}`);
    ids.add(f.id);
    for (const key of ['title', 'verb', 'why']) assert.ok(f[key], `${f.id}: ${key}`);
    assert.ok(['engine', 'mock', 'unclear'].includes(f.right), `${f.id}: right`);
    assert.ok((f.sites || []).length + (f.everywhere || []).length > 0, `${f.id}: claims something`);
    for (const p of f.everywhere || []) assert.ok(p.field, `${f.id}: a pattern names its field`);
    for (const s of f.sites) {
        assert.ok(s.journey && s.step && s.key, `${f.id}: a site names journey, step and key`);
        assert.notDeepEqual(s.engine, s.mock, `${f.id}: a site's two values differ (${s.key})`);
    }
}
for (const rule of KNOWN_WALK) {
    assert.ok(ids.has(rule.family), `walk rule names a family: ${rule.family}`);
    assert.ok(rule.field, 'walk rule names its field');
}
for (const sets of Object.values(KNOWN_KEYS)) {
    assert.ok(Array.isArray(sets.engineOnly) && Array.isArray(sets.mockOnly), 'key sets are two lists');
}
// Every field row either reads or says why not.
for (const row of FIELDS) assert.ok(row.field && row.on && row.note, `field row complete: ${row.field}`);

process.stdout.write(`differential selftest passed (${KNOWN_DRIFT.length} drift families, ` +
    `${KNOWN_DRIFT.reduce((n, f) => n + f.sites.length, 0)} sites, ${FIELDS.length} field rows)\n`);
