/**
 * THE SCOPE CYCLE (ui/js/period_law.js scopeCycle / scopeCycleOf — the
 * twin of period_law::scopeCycle in src/period_law.h): the cycle a stack
 * hands its children — what a one-shot child folds on.
 *
 *   authored (a map or a song sets own)  → own
 *   else own > 0                         → lcm(Q, own)
 *   else                                 → the cycle the stack received
 *
 * The value form runs against `scope_cycle_cases` in
 * shared/timing_golden.json, as tests/period_law_tests.cc runs its twin.
 * The shapes are the ones that file drives through the render ("the
 * scope cycle: the context a stack's children receive…"), with the
 * numbers worked by hand; then the view model's own use of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { scopeCycle, scopeCycleOf, ownPeriod } from '../period_law.js';
import { publishedLaw } from '../vm/published.js';
import { deriveViewModel } from '../view_model.js';
import { loadSharedJson } from './helpers.mjs';

const Q = 1000;
const RECEIVED = 7777777;

const golden = loadSharedJson('timing_golden.json');

/** Providers over the golden fixture shape ({window, sequenceLen,
 * children}) as the law reads it (lawNode). */
const fixtureLaw = quantum => ({
    mapPeriod: n => (n.window ? n.window[1] - n.window[0] : 0),
    seqLen: n => n.sequenceLen || 0,
    children: n => n.children || [],
    slotPeriod: n => n.slot || 0,
    quantum,
});

/** A golden fixture node as the law reads one: while a take is
 * `recording` into a clip its `duration` is the live count (`captured`)
 * and the fixture's committed `duration` is the `slot` being re-taken. */
function lawNode(n) {
    const o = { ...n, isRecording: !!n.recording,
                duration: n.recording ? n.captured : n.duration,
                slot: n.recording ? n.duration : 0 };
    if (n.children) o.children = n.children.map(lawNode);
    return o;
}

const loop = (id, duration, extra = {}) =>
    ({ id, type: 'clip', duration, ...extra });
const group = (children, extra = {}) =>
    ({ id: 'g', type: 'stack', children, ...extra });

test('golden: the scope cycle, from a stack\'s own period', () => {
    assert.ok(golden.scope_cycle_cases.length > 0, 'scope_cycle_cases present');
    for (const c of golden.scope_cycle_cases) {
        assert.equal(scopeCycle(c.own, c.authored, c.quantum, c.received),
            c.expected, c.name);
    }
});

test('the eight shapes the engine hands a probe child', () => {
    const cases = [
        ['looping content on the grid', Q, group([loop('a', 3 * Q)]), 3 * Q],
        ['a loop that divides Q folds up to Q', Q, group([loop('a', Q / 2)]), Q],
        ['no grid: the content\'s own period', 0, group([loop('a', 1500)]), 1500],
        ['a drifting loop extends nothing', 2 * Q, group([loop('a', 3 * Q)]), RECEIVED],
        ['a map: one map pass, whatever Q is', 3 * Q,
            group([loop('a', 8 * Q)], { window: [0, 2 * Q] }), 2 * Q],
        ['a song: the whole song', Q,
            group([loop('a', 2 * Q)], { sequenceLen: 5 * Q }), 5 * Q],
        ['only one-shots', Q,
            group([loop('shot', 2 * Q, { periodSource: 'context' })]), RECEIVED],
        ['empty', Q, group([]), RECEIVED],
    ];
    for (const [name, quantum, g, want] of cases) {
        assert.equal(scopeCycleOf(g, fixtureLaw(quantum), RECEIVED), want, name);
    }
});

test('golden fixtures: every stack\'s scope cycle follows from its own period', () => {
    let stacks = 0;
    for (const c of golden.period_law_cases) {
        const root = { id: 'root', type: 'stack', children: c.tree.map(lawNode) };
        const law = fixtureLaw(c.quantum);
        (function visit(n) {
            if (n.type !== 'stack') return;
            const want = c.expected[n.id];
            if (want) {
                const authored = !!n.window || n.sequenceLen > 0;
                assert.equal(ownPeriod(n, law), want.own, `${c.name}: own(${n.id})`);
                assert.equal(scopeCycleOf(n, law, RECEIVED),
                    scopeCycle(want.own, authored, c.quantum, RECEIVED),
                    `${c.name}: scope cycle(${n.id})`);
                stacks++;
            }
            (n.children || []).forEach(visit);
        })(root);
    }
    assert.ok(stacks >= 15, `the fixtures ran (${stacks} stacks)`);
});

/* ---- the view model: where a one-shot child's firings fall ---- */

const island = nodes => ({
    id: 'root', quantum: Q, islandZero: 0, islandPos: 0, masterPos: 0,
    definerId: '', nodes,
});
const clip = (id, durQ, extra = {}) => ({
    id, type: 'clip', name: id, duration: durQ * Q, origin: 0,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    isRecording: false, ...extra,
});
const stack = (id, nodes, extra = {}) => ({
    id, type: 'stack', name: id, nodes, origin: 0, anchored: true,
    loopStart: 0, loopEnd: 0, windowActive: false, loopBypassed: false,
    isRecording: false, ...extra,
});
const firings = (vm, id) =>
    vm.lanes.find(l => l.id === id).reps.map(r => [r.startQ, r.endQ]);

test('a windowed group: its one-shot child fires once per MAP PASS', () => {
    // An 8Q loop and a 1Q hit in a group windowed to its first 2Q, beside
    // a 4Q loop: the children hear the 2Q map pass, so the hit sounds at
    // 0 and 2 of the 4Q frame — not once per the 8Q the members fold to.
    const g = stack('g', [clip('long', 8), clip('hit', 1, { periodSource: 'context' })],
        { loopStart: 0, loopEnd: 2 * Q, windowActive: true });
    assert.equal(scopeCycleOf(g, publishedLaw(Q), 4 * Q), 2 * Q);
    const vm = deriveViewModel(island([g, clip('bed', 4)]));
    assert.equal(vm.cycleQ, 4);
    assert.deepEqual(firings(vm, 'hit'), [[0, 1], [2, 3]]);
});

test('a plain group: its one-shot child fires once per fold of its loops', () => {
    // 2Q and 3Q loops fold to 6Q; the frame is 12Q beside a 4Q loop.
    const g = stack('g', [clip('two', 2), clip('three', 3),
                          clip('hit', 1, { periodSource: 'context', origin: Q })]);
    const vm = deriveViewModel(island([g, clip('bed', 4)]));
    assert.equal(vm.cycleQ, 12);
    assert.deepEqual(firings(vm, 'hit'), [[1, 2], [7, 8]]);
});

test('a group of one-shots only: they fire once per the cycle the group received', () => {
    // Nothing in the group loops, so it hands on the 4Q it was handed.
    const g = stack('g', [clip('kick', 1, { periodSource: 'context' }),
                          clip('snare', 1, { periodSource: 'context', origin: 2 * Q })]);
    assert.equal(scopeCycleOf(g, publishedLaw(Q), 4 * Q), 4 * Q);
    const vm = deriveViewModel(island([g, clip('bed', 4)]));
    assert.equal(vm.cycleQ, 4);
    assert.deepEqual(firings(vm, 'kick'), [[0, 1]]);
    assert.deepEqual(firings(vm, 'snare'), [[2, 3]]);
});

test('the root\'s step audition: a top-level one-shot fires once per step pass', () => {
    // An 8Q song of two 4Q steps, auditioning the second: the transport
    // loops [4Q, 8Q) and the hit, anchored 1Q into the song, sounds at 5Q.
    const state = {
        ...island([clip('bed', 4), clip('hit', 1, { periodSource: 'context', origin: Q })]),
        sequence: { steps: [{ len: 4 * Q }, { len: 4 * Q }], auditionStep: 1,
                    bypassed: false, gates: {} },
        windowActive: true, loopStart: 4 * Q, loopEnd: 8 * Q,
    };
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 8, 'the frame stays the song');
    assert.equal(vm.loopCycleQ, 4, 'the cursor loops the step');
    assert.deepEqual(firings(vm, 'hit'), [[1, 2], [5, 6]]);
});
