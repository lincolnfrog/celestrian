/**
 * A SLOT BEING RE-TAKEN IS STILL A PART (docs/takes.md §2: a slot's takes
 * share one origin and period). The engine keeps a committed slot's
 * period in every fold while its new take records (ClipNode::
 * prepareRetake keeps the slot's length; period_law::contribution reads
 * it) and publishes the take as `isRecording`, `duration` = the live
 * count, `periodQ` = the slot. The period law's recording rung is a
 * FIRST take: a clip with no committed period yet.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ownPeriod, periodContribution, islandCycle, nodeDrifts, scopeCycleOf }
    from '../period_law.js';
import { publishedLaw, frameLaw, scopeMembers } from '../vm/published.js';
import { deriveViewModel } from '../view_model.js';

const Q = 1000;

/* ---- the law, over a fixture shape ({duration, slot}) ---- */

/** Providers over a fixture clip: `slot` is the committed period of the
 * slot its live take is a new take of. */
const fixtureLaw = quantum => ({
    mapPeriod: () => 0,
    seqLen: () => 0,
    children: n => n.children || [],
    slotPeriod: n => n.slot || 0,
    quantum,
});
const loop = (id, duration) => ({ id, type: 'clip', duration });
const firstTake = (id, captured) =>
    ({ id, type: 'clip', duration: captured, isRecording: true });
const retake = (id, slot, captured) =>
    ({ id, type: 'clip', duration: captured, isRecording: true, slot });
const rootOf = children => ({ id: 'root', type: 'stack', children });

test('the law: a first take hands its parent nothing; a slot being re-taken, its period', () => {
    const law = fixtureLaw(Q);
    const fresh = firstTake('b', 500);
    assert.equal(ownPeriod(fresh, law), 0, 'a live count is no period');
    assert.equal(periodContribution(fresh, law), 0);
    assert.equal(islandCycle(rootOf([loop('a', 2 * Q), fresh]), law, Q, 44100), 2 * Q);

    const b = retake('b', 3 * Q, 500);
    assert.equal(ownPeriod(b, law), 3 * Q, 'what it plays is the slot, not the live count');
    assert.equal(periodContribution(b, law), 3 * Q);
    const root = rootOf([loop('a', 2 * Q), b]);
    assert.equal(ownPeriod(root, law), 6 * Q);
    assert.equal(islandCycle(root, law, Q, 44100), 6 * Q, 'the transport still wraps on 6Q');
    assert.equal(ownPeriod(root, law, b), 2 * Q, 'everyone else, judged against it');
    // The capture's first block: nothing captured yet, the slot stands.
    assert.equal(periodContribution(retake('b', 3 * Q, 0), law), 3 * Q);
});

test('the law: a re-taken slot that drifts still drifts; a first take never does', () => {
    const law = fixtureLaw(Q);
    const drifting = retake('k', 1300, 200);
    assert.equal(nodeDrifts(drifting, law), true);
    assert.equal(periodContribution(drifting, law), 0, 'and so widens no cycle');
    assert.equal(nodeDrifts(firstTake('n', 1300), law), false);
});

test('without a slotPeriod provider every recording clip is a first take', () => {
    const bare = { ...fixtureLaw(Q), slotPeriod: undefined };
    assert.equal(periodContribution(retake('b', 3 * Q, 500), bare), 0);
});

/* ---- the published shape: the slot rides `periodQ` ---- */

const clip = (id, durQ, extra = {}) => ({
    id, type: 'clip', name: id, origin: 0, duration: durQ * Q,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    isRecording: false, isPendingStart: false, periodSource: 'own', ...extra,
});
/** A committed `slotQ` slot whose new take has captured `captured`
 * samples, as AudioNode::getMetadata publishes it. */
const retaking = (id, slotQ, captured, extra = {}) =>
    clip(id, 0, { isRecording: true, duration: captured,
                  periodQ: { num: slotQ, den: 1 }, takes: 1, ...extra });
/** A first take: the slot has no committed period. */
const recordingFirst = (id, captured) =>
    clip(id, 0, { isRecording: true, duration: captured,
                  periodQ: { num: 0, den: 1 } });
const stack = (id, nodes, extra = {}) => ({
    id, type: 'stack', name: id, nodes, origin: 0, anchored: true,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    isRecording: false, periodSource: 'own', ...extra,
});
const island = (nodes, extra = {}) => ({
    id: 'root', quantum: Q, islandZero: 0, islandPos: 500, masterPos: 500,
    definerId: '', isPlaying: true, nodes, ...extra,
});

test('published: the law reads a re-taken slot from periodQ, as heard and as framed', () => {
    for (const law of [publishedLaw(Q), frameLaw(Q)]) {
        const b = retaking('b', 3, 500);
        assert.equal(ownPeriod(b, law), 3 * Q);
        assert.equal(periodContribution(b, law), 3 * Q);
        assert.equal(islandCycle({ type: 'stack', nodes: [clip('a', 2), b] }, law, Q, 44100),
            6 * Q);
        assert.equal(periodContribution(recordingFirst('n', 500), law), 0);
        assert.equal(periodContribution(clip('n', 0, { isRecording: true, duration: 500 }), law),
            0, 'a state with no periodQ: a first take');
    }
});

test('published: the frame of [2Q loop, 3Q slot mid-retake] is 6Q, told or not', () => {
    const state = island([clip('a', 2), retaking('b', 3, 500)]);
    for (const opts of [{}, { retakes: new Set(['b']) }]) {
        const vm = deriveViewModel(state, opts);
        assert.equal(vm.lcmQ, 6, 'the committed cycle');
        assert.equal(vm.loopCycleQ, 6, 'the audible loop');
    }
});

test('published: a new take is drawn as the slot it will be without being told', () => {
    // A 2Q bed and a 4Q slot whose new take has run 2.5Q: the frame
    // stays the 4Q cycle and the slot keeps its tiles, silent.
    const state = island([clip('bed', 2), retaking('b', 4, 2.5 * Q)],
        { islandPos: 2.5 * Q, masterPos: 2.5 * Q });
    const bare = deriveViewModel(state);
    const lane = bare.lanes.find(l => l.id === 'b');
    assert.equal(bare.cycleQ, 4, 'no growing frame');
    assert.equal(lane.retake, true);
    assert.deepEqual(lane.reps.map(r => [r.startQ, r.endQ, !!r.silent]), [[0, 4, true]]);
    assert.equal(lane.recordingLengthQ, 2.5);
    assert.deepEqual(bare, deriveViewModel(state, { retakes: new Set(['b']) }),
        'the app naming it changes nothing');
    // A first take still grows the frame as it runs.
    const fresh = deriveViewModel(island([clip('bed', 2), recordingFirst('n', 2.5 * Q)],
        { islandPos: 2.5 * Q, masterPos: 2.5 * Q }));
    assert.equal(fresh.cycleQ, 3);
    assert.equal(fresh.lanes.find(l => l.id === 'n').retake, false);
});

/* ---- the two paths that read the tree as published ---- */

const firings = (vm, id) =>
    vm.lanes.find(l => l.id === id).reps.map(r => [r.startQ, r.endQ]);

test('a group\'s one-shot fires once per the group\'s fold while a member is re-taken', () => {
    // g [2Q loop, 3Q slot, 1Q hit] beside a 6Q bed: the members fold to
    // 6Q, so the hit sounds once per frame — before, during and after a
    // new take of the 3Q slot.
    const hit = () => clip('hit', 1, { periodSource: 'context' });
    const scene = b => island([stack('g', [clip('a', 2), b, hit()]), clip('bed', 6)]);
    const idle = deriveViewModel(scene(clip('b', 3)));
    assert.equal(idle.cycleQ, 6);
    assert.deepEqual(firings(idle, 'hit'), [[0, 1]]);
    for (const captured of [0, 500, 2900]) {
        const state = scene(retaking('b', 3, captured));
        const g = state.nodes[0];
        assert.equal(scopeCycleOf(g, publishedLaw(Q), 6 * Q), 6 * Q,
            `the scope cycle, ${captured} captured`);
        for (const opts of [{}, { retakes: new Set(['b']) }]) {
            assert.deepEqual(firings(deriveViewModel(state, opts), 'hit'), [[0, 1]],
                `${captured} captured`);
        }
    }
});

test('frame health: a re-taken member stays a member of its scope', () => {
    const members = nodes => scopeMembers(nodes, Q).map(m => [m.id, m.periodQ]);
    assert.deepEqual(members([clip('a', 2), retaking('b', 3, 500)]), [['a', 2], ['b', 3]]);
    assert.deepEqual(members([clip('a', 2), recordingFirst('n', 500)]), [['a', 2]]);
});

test('frame health: a blow-up badge holds through a new take of the member it blames', () => {
    // 7Q beside 5Q: 35Q, five times the largest. The 7Q loop is blamed.
    const badge = vm => vm.lanes.find(l => l.id === 'seven').health;
    const idle = badge(deriveViewModel(island([clip('seven', 7), clip('five', 5)])));
    assert.ok(idle, 'the scope blows up at rest');
    assert.equal(idle.cycleQ, 35);
    for (const [who, slotQ] of [['seven', 7], ['five', 5]]) {
        const nodes = [clip('seven', 7), clip('five', 5)]
            .map(n => (n.id === who ? retaking(who, slotQ, 500) : n));
        const during = badge(deriveViewModel(island(nodes), { retakes: new Set([who]) }));
        assert.deepEqual(during, idle, `a new take of the ${slotQ}Q slot`);
    }
});

test('frame health: a song\'s drift verdict holds through a new take beneath it', () => {
    // A 4Q song over [2Q, 3Q]: the inner cycle is 6Q, so the passes drift.
    const song = { steps: [{ name: 'A', len: 4 * Q }], bypassed: false, gates: {} };
    const drift = b => deriveViewModel(
        island([clip('a', 2), b], { sequence: song, anchored: true, origin: 0 }),
        { retakes: new Set(['b']) }).rootSeq.drift;
    const idle = drift(clip('b', 3));
    assert.deepEqual(idle && [idle.innerQ, idle.phaseQ], [6, 4]);
    assert.deepEqual(drift(retaking('b', 3, 500)), idle);
});
