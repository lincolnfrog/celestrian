/**
 * Q18 — EVERY NODE HAS AN ORIGIN (docs/composition.md §0, §5, §9), the
 * mock/VM twins of the engine rules:
 *
 *  - a STACK stores an origin and is ANCHORED once committed content
 *    exists in its subtree (origin := the earliest committed descendant's
 *    origin, set once, never re-derived); the last content leaving
 *    un-anchors it; undo restores the exact stored values;
 *  - combine anchors the new stack at min(member origins);
 *  - re-anchoring a node re-anchors its SUBTREE (seek, the definer trim,
 *    lock-collapse) — no per-member origin riders;
 *  - the definer-stack trim is the sole-clip path applied to the stack:
 *    origin' = t0 − pT, epoch := origin' + start, Q := len;
 *  - a stack may be a ONE-SHOT (periodSource = context): it fires once
 *    per context cycle from its origin and contributes nothing to any
 *    period fold;
 *  - display: group lanes get a take mark exactly like clips; a
 *    one-shot group draws as a one-shot clip (dashed tile, no ghosts,
 *    members whole beneath).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    callNative, getState, loadScenario, advanceBy, setMasterPos,
} from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { armTarget } from '../timeline_model.js';
import { mapOffset } from '../time_map.js';
import {
    MOCK_Q as Q, nodeById, recordTake, clip, stack, state as scene, SCENE_Q,
} from './helpers.mjs';

const find = id => nodeById(id, getState().nodes);
const mod = (a, m) => ((a % m) + m) % m;

/** A group take: N mics under one stack, one performance of lenQ.
 * With a Q already established, stop just short and settle across the
 * boundary (the awaiting-stop pad — helpers.recordTake's shape). */
async function recordGroupTake(n, lenQ, parentId = '',
                               { stopEarly = 0, settle = 0 } = {}) {
    const stackId = await callNative('createNode', 'stack', parentId);
    const ids = [];
    for (let i = 0; i < n; ++i) ids.push(await callNative('createNode', 'clip', stackId));
    await callNative('startRecordingInNode', stackId);
    advanceBy(lenQ * Q - stopEarly);
    await callNative('stopRecordingInNode', stackId);
    if (settle > 0) advanceBy(settle);
    return { stackId, ids };
}

/* ------------------------------------------------------------------ */
/* Anchoring events (composition.md §5)                                */
/* ------------------------------------------------------------------ */

test('a stack is unanchored until its first take, then anchored at the take origin', async () => {
    loadScenario('empty');
    const outer = await callNative('createNode', 'stack', '');
    assert.equal(find(outer).anchored, false, 'empty: unanchored');
    assert.equal(find(outer).origin, 0);

    // Pre-Q authored geometry on the empty stack is legal (the
    // establishment scrub governs it); it does not anchor anything.
    await callNative('setLoopPoints', outer, 0, Q / 2);
    assert.equal(find(outer).anchored, false, 'geometry alone does not anchor');
    await callNative('setLoopPoints', outer, 0, 0);

    // A group take nested two deep anchors EVERY unanchored ancestor at
    // the take's origin (rides the take's undo entry).
    const { stackId, ids } = await recordGroupTake(2, 2, outer);
    const takeOrigin = find(ids[0]).origin;
    assert.equal(find(ids[1]).origin, takeOrigin, 'one take, one origin');
    assert.equal(find(stackId).anchored, true, 'the group anchored');
    assert.equal(find(stackId).origin, takeOrigin, 'at the take origin');
    assert.equal(find(outer).anchored, true, 'and its parent');
    assert.equal(find(outer).origin, takeOrigin);
    assert.equal(getState().islandEpoch, takeOrigin, 'first commit: epoch = origin');

    // UNTAKE (undo of the performance) un-anchors — the snapshot the
    // take undoes to predates the anchoring.
    await callNative('undo');
    assert.equal(find(stackId).anchored, false, 'undo of the take un-anchors');
    assert.equal(find(outer).anchored, false);
    await callNative('redo');
    assert.equal(find(stackId).anchored, true, 'redo re-anchors');
    assert.equal(find(stackId).origin, takeOrigin, 'at the exact stored origin');
});

test('the origin is set ONCE: later content never re-derives it', async () => {
    loadScenario('empty');
    const { stackId } = await recordGroupTake(2, 1);
    const O = find(stackId).origin;
    // A later take in the same group (a new mic, one cycle later):
    // committed content ARRIVES, the stack is already anchored — its
    // origin holds at the first take's moment.
    advanceBy(Q);
    await recordTake(stackId, Q);
    assert.equal(find(stackId).anchored, true);
    assert.equal(find(stackId).origin, O, 'anchored origin never re-derived');
});

test('the last content leaving un-anchors; undo restores the stored origin', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 2);
    const O = find(stackId).origin;

    await callNative('deleteNode', ids[0]);
    assert.equal(find(stackId).anchored, true, 'content remains: still anchored');
    assert.equal(find(stackId).origin, O);
    await callNative('deleteNode', ids[1]);
    assert.equal(find(stackId).anchored, false, 'last content left: un-anchored');
    assert.equal(find(stackId).origin, 0);

    await callNative('undo');
    assert.equal(find(stackId).anchored, true, 'undo re-anchors');
    assert.equal(find(stackId).origin, O, 'the exact value, not a re-derivation');
    await callNative('undo');
    assert.equal(find(stackId).origin, O);
});

test('a MOVE anchors the receiving stack and un-anchors the emptied one', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 1);
    const O = find(stackId).origin;
    const other = await callNative('createNode', 'stack', '');
    assert.equal(find(other).anchored, false);
    await callNative('reorderNode', ids[0], other, 0);
    assert.equal(find(other).anchored, true, 'content entered: anchored');
    assert.equal(find(other).origin, O, 'at the child\'s origin');
    await callNative('reorderNode', ids[1], other, 1);
    assert.equal(find(stackId).anchored, false, 'emptied: un-anchored');
    assert.equal(find(other).origin, O, 'still the first content\'s origin');
});

test('combine anchors the new stack at the EARLIEST member origin', async () => {
    loadScenario('empty');
    const a = await recordTake('', Q, { stopEarly: 0, settle: 0 });  // origin 0
    advanceBy(3 * Q);
    const b = await recordTake('', Q);                                 // later
    const oa = find(a).origin, ob = find(b).origin;
    assert.ok(ob > oa, 'b was performed after a');

    const g = await callNative('combineNodes', b, a);  // drag b onto a
    assert.equal(find(g).anchored, true, 'a post-hoc group is anchored');
    assert.equal(find(g).origin, Math.min(oa, ob), 'min(member origins)');
    assert.equal(find(g).origin, oa);

    // Two EMPTY clips make an unanchored group.
    const e1 = await callNative('createNode', 'clip', '');
    const e2 = await callNative('createNode', 'clip', '');
    const g2 = await callNative('combineNodes', e1, e2);
    assert.equal(find(g2).anchored, false, 'no content: unanchored');
});

test('scenario fixtures anchor their stacks from content on load (session-load parity)', () => {
    loadScenario('clip-3-anchor-at-2q');
    const s = getState().nodes.find(n => n.type === 'stack');
    assert.equal(s.anchored, true);
    assert.equal(s.origin, 0, 'the earliest committed member (the 1Q/4Q clips at 0)');
    loadScenario('empty');
    const empty = getState();
    assert.equal(empty.nodes.length, 0);
});

/* ------------------------------------------------------------------ */
/* Subtree re-anchoring (I11)                                          */
/* ------------------------------------------------------------------ */

test('seek shifts stack origins with the epoch (placement invariant)', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 2);
    advanceBy(Q / 3);
    const before = getState();
    const O = find(stackId).origin;
    const placement = O - before.islandEpoch;

    assert.equal(await callNative('seekTransport', Math.round(1.5 * Q)), true);
    const after = getState();
    const delta = after.islandEpoch - before.islandEpoch;
    assert.notEqual(delta, 0, 'the seek moved the epoch');
    assert.equal(find(stackId).origin, O + delta, 'stack origin rode the delta');
    assert.equal(find(stackId).origin - after.islandEpoch, placement,
        'placement (origin − epoch) invariant');
    for (const id of ids) {
        assert.equal(find(id).origin, O + delta, 'members rode too (one shift)');
    }
    assert.equal(after.masterPos, Math.round(1.5 * Q), 'landed at the requested phase');
});

test('definer-stack trim: ONE shift for the subtree, epoch = origin\' + start, phase-preserving', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 4);
    const D = getState().quantum;
    const O0 = find(stackId).origin;
    assert.equal(find(ids[0]).origin, O0, 'members and stack share the take origin');

    const t0 = O0 + Math.round(D * 0.65);
    setMasterPos(t0);
    // The inner position sounding now (the node equation, no map:
    // (t − O) mod D), folded into the new window.
    const p0 = mod(t0 - O0, D);
    const start = D / 4, len = D / 2;
    const pT = start + mod(p0 - start, len);

    await callNative('setLoopPoints', stackId, start, start + len);
    const s = find(stackId);
    assert.equal(s.origin, t0 - pT, 'origin\' = t0 − pT (the sole-clip law on the stack)');
    for (const id of ids) {
        assert.equal(find(id).origin, s.origin,
            'members moved WITH the stack — no per-member riders');
    }
    assert.equal(getState().quantum, len, 'Q := len');
    assert.equal(getState().islandEpoch, s.origin + start, 'epoch := origin\' + start');
    // Render check (composition.md G-1): the sample that was sounding
    // keeps sounding — inner(t0) under the new window equals pT.
    const innerNow = start + mod(t0 - s.origin - start, len);
    assert.equal(innerNow, pT, 'phase preserved through the trim');

    // Undo restores every origin exactly (the snapshot = the riders).
    await callNative('undo');
    assert.equal(find(stackId).origin, O0);
    for (const id of ids) assert.equal(find(id).origin, O0);
    assert.equal(find(stackId).anchored, true);

    // The multi-segment twin: epoch := origin' + mapOffset(0).
    await callNative('setSegments', stackId, [D / 8, 3 * D / 8, D / 2, 3 * D / 4]);
    const s2 = find(stackId);
    for (const id of ids) assert.equal(find(id).origin, s2.origin, 'subtree shift');
    assert.equal(getState().islandEpoch, s2.origin + D / 8, 'epoch = origin\' + a0');
});

test('trim view: brackets are INNER positions == buffer positions (stack origin == members\')', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 4);
    const D = getState().quantum;
    await callNative('setLoopPoints', stackId, D / 4, (3 * D) / 4);
    const vm = deriveViewModel(getState());
    const g = vm.lanes.find(l => l.id === stackId);
    assert.equal(g.isQDefiner, true);
    assert.equal(g.takeStartQ, 0, 'the trim view frames the raw buffer from 0');
    // What a bracket release commits (window_edit: round(startQ · Q)) is
    // exactly the stored inner window — and since the stack's origin is
    // the members' origin, inner == buffer position for the one take.
    assert.equal(Math.round(g.window.startQ * vm.quantum), find(stackId).loopStart);
    assert.equal(Math.round(g.window.endQ * vm.quantum), find(stackId).loopEnd);
    for (const id of ids) assert.equal(find(id).origin, find(stackId).origin);
});

test('group lock-collapse shifts the stack + members by the window start; re-open unwinds it', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 4);
    const D = getState().quantum;
    const start = D / 4;
    await callNative('setLoopPoints', stackId, start, (3 * D) / 4);
    const O1 = find(stackId).origin;
    const epoch1 = getState().islandEpoch;
    assert.equal(epoch1, O1 + start);

    // Take 2 on a new top-level track: its ARM lock-collapses the group.
    const t2 = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', t2);
    assert.equal(find(stackId).origin, O1 + start, 'stack origin += window start');
    for (const id of ids) {
        assert.equal(find(id).origin, O1 + start, 'members shifted with it (one delta)');
        assert.equal(find(id).duration, D / 2, 'collapsed to the window');
    }
    assert.equal(find(stackId).origin, epoch1,
        'the collapsed take sits at the epoch — an ordinary whole-Q looper (G-1)');
    assert.ok(!(find(stackId).loopEnd > find(stackId).loopStart), 'window consumed');
    advanceBy(D / 2);
    await callNative('stopRecordingInNode', t2);
    advanceBy(D / 2);
    assert.equal(find(t2).isRecording, false, 'take 2 committed');

    // RE-OPEN ⟹ UNCOLLAPSE: origins unwind by the same shift.
    await callNative('deleteNode', t2);
    assert.equal(find(stackId).origin, O1, 'stack origin unwound');
    for (const id of ids) {
        assert.equal(find(id).origin, O1, 'members unwound');
        assert.equal(find(id).duration, D, 'full take back');
    }
    assert.deepEqual([find(stackId).loopStart, find(stackId).loopEnd],
        [start, (3 * D) / 4], 'the trim is the stack window again');
});

test('through-map arm: heard anchor = stack origin + a0; inner origin = stack origin + mapOffset', async () => {
    loadScenario('empty');
    await recordTake('', Q, { stopEarly: 0, settle: 0 });   // Q, epoch 0; clock at 1Q
    advanceBy(3 * Q);                                        // clock at 4Q
    // A 1Q group take cycles later: the group anchors at 4Q while the
    // epoch stays at 0 (no cycle growth) — origin ≠ epoch.
    const { stackId } = await recordGroupTake(2, 1, '', { stopEarly: 100, settle: 100 });
    const O = find(stackId).origin;
    assert.equal(O, 4 * Q, 'group anchored at its own take');
    assert.equal(getState().islandEpoch, 0, 'epoch unchanged');
    // Window the group to its second half: a0 = Q/2, period Q/2.
    await callNative('setLoopPoints', stackId, Q / 2, Q);
    const map = { segs: [[Q / 2, Q]] };
    const raw = O + Math.round(4.2 * Q);
    setMasterPos(raw);
    const c = await callNative('createNode', 'clip', stackId);
    await callNative('startRecordingInNode', c);
    const heardAnchor = find(stackId).origin + Q / 2;   // origin + a0
    const tRel = armTarget(raw - heardAnchor, Q, Q / 2);
    assert.equal(find(c).isPendingStart, true);
    assert.equal(find(c).pendingStartAt, heardAnchor + tRel,
        'the arm grid runs from the stack\'s origin + a0, not the epoch');
    advanceBy(find(c).pendingStartAt - raw);
    advanceBy(Q / 2);   // one full map pass: the cap commits
    assert.equal(find(c).isRecording, false);
    assert.equal(find(c).origin, find(stackId).origin + mapOffset(map, tRel),
        'inner origin = stack origin + mapOffset(heard offset)');
});

/* ------------------------------------------------------------------ */
/* One-shot stacks (Q5 generalized)                                    */
/* ------------------------------------------------------------------ */

test('a one-shot stack contributes nothing to any fold and publishes periodSource', async () => {
    loadScenario('multiple-stacks');   // Stack 1: 2Q beat; Stack 2: 3Q melody
    const s1 = getState().nodes[0];
    assert.equal(s1.anchored, true, 'fixture stacks anchor on load');
    assert.equal(s1.periodSource, 'own');
    let vm = deriveViewModel(getState());
    assert.equal(vm.lcmQ, 6, 'looping: lcm(2, 3)');

    await callNative('setPeriodSource', s1.id, 'context');
    assert.equal(getState().nodes[0].periodSource, 'context', 'published');
    assert.equal(getState().canUndo, true, 'a musical fact — undoable');
    vm = deriveViewModel(getState());
    assert.equal(vm.lcmQ, 3, 'the one-shot group adopts the cycle, never extends it');
    // The mock's transport wraps on the same fold.
    setMasterPos(4 * Q);
    assert.equal(getState().masterPos, Q, 'view wraps on 3Q');

    await callNative('undo');
    assert.equal(getState().nodes[0].periodSource, 'own');
    assert.equal(deriveViewModel(getState()).lcmQ, 6);
});

/* ------------------------------------------------------------------ */
/* Display twins (composition.md §9)                                   */
/* ------------------------------------------------------------------ */

const PERF = { sampleRate: SCENE_Q };

test('VM: an anchored group lane gets a take mark; brackets/bands are inner positions offset by it', () => {
    const O = 2 * SCENE_Q;   // performed at 2Q of a 4Q frame
    const mics = () => [clip(2, { origin: O }), clip(2, { origin: O })];
    // Bypassed window: the raw branch (brackets drawn over the tiles).
    const grp = stack(mics(), {
        anchored: true, origin: O,
        loopStart: 0.5 * SCENE_Q, loopEnd: 1.5 * SCENE_Q,
        windowActive: false, loopBypassed: true,
    });
    const vm = deriveViewModel(scene([clip(4), grp], { islandEpoch: 0, perf: PERF }));
    assert.equal(vm.cycleQ, 4);
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.anchored, true);
    assert.equal(g.takeStartQ, 2, '(origin − epoch) mod frame, in Q');
    assert.deepEqual(g.reps.map(r => [r.startQ, r.endQ, r.ghost]),
        [[0, 2, true], [2, 4, false]], 'the take tile sits at the mark');
    assert.deepEqual([g.window.startQ, g.window.endQ], [0.5, 1.5],
        'window = INNER positions (the lane offsets them by takeStartQ)');
    assert.deepEqual(g.bandSegs, [[0.5, 1.5]]);
    // The members share the mark (one take, one origin).
    const m = vm.lanes.filter(l => l.kind === 'clip' && l.depth === 1);
    assert.equal(m.length, 2);
    m.forEach(l => assert.equal(l.takeStartQ, 2));

    // An UNANCHORED stack measures from the frame top: mark 0.
    const empty = stack(mics(), { origin: O,
        loopStart: 0.5 * SCENE_Q, loopEnd: 1.5 * SCENE_Q,
        windowActive: false, loopBypassed: true });
    const vm2 = deriveViewModel(scene([clip(4), empty], { islandEpoch: 0, perf: PERF }));
    const g2 = vm2.lanes.find(l => l.kind === 'group');
    assert.equal(g2.anchored, false);
    assert.equal(g2.takeStartQ, 0, 'unanchored: the empty case, mark 0');
});

test('VM: the heard view of a windowed group anchors at origin + a0', () => {
    const O = 2 * SCENE_Q;
    const grp = stack([clip(2, { origin: O }), clip(2, { origin: O })], {
        anchored: true, origin: O,
        loopStart: 0.5 * SCENE_Q, loopEnd: 1.5 * SCENE_Q, windowActive: true,
    });
    const vm = deriveViewModel(scene([clip(4), grp], { islandEpoch: 0, perf: PERF }));
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.periodQ, 1, 'the window is the part');
    // Window content start sounds at origin + a0 = 2.5Q → heard top
    // within the 1Q period = 0.5.
    assert.equal(g.takeStartQ, 0.5, 'heard top = (offset + a0) mod period');
    assert.equal(g.reps[0].srcTopFrac, 0.5, 'content rotation = the heard top');
    assert.equal(g.window, null, 'heard view: no brackets');
    assert.deepEqual(g.bandSegs, [[0.5, 1.5]], 'seams are inner positions');
});

test('VM: a one-shot group renders like a one-shot clip — dashed tile at its mark, no ghosts, members whole', () => {
    const O = 2 * SCENE_Q;
    const mics = () => [clip(2, { origin: O }), clip(2, { origin: O })];
    const loop = stack(mics(), { anchored: true, origin: O });
    let vm = deriveViewModel(scene([clip(4), loop], { islandEpoch: 0, perf: PERF }));
    let g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.oneShot, false);
    assert.equal(g.reps.filter(r => r.ghost).length, 1, 'looping: a ghost repetition');

    const shot = stack(mics(), { anchored: true, origin: O, periodSource: 'context' });
    vm = deriveViewModel(scene([clip(4), shot], { islandEpoch: 0, perf: PERF }));
    g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.oneShot, true, 'the dashed styling rides lane.oneShot');
    assert.deepEqual(g.reps.map(r => [r.startQ, r.endQ, r.ghost]), [[2, 4, false]],
        'the one firing at its take mark, no ghosts');
    assert.equal(g.takeStartQ, 2);
    const m = vm.lanes.filter(l => l.kind === 'clip' && l.depth === 1);
    assert.equal(m.length, 2);
    m.forEach(l => assert.deepEqual(l.reps.map(r => [r.startQ, r.endQ]), [[2, 4]],
        'members drawn whole beneath — one tile inside the shot'));
    assert.equal(vm.cycleQ, 4, 'the frame is the 4Q clip\'s');

    // Excluded from every fold: a 3Q one-shot group beside a 4Q clip
    // leaves the frame at 4Q (looping it would be 12Q).
    const three = stack([clip(3)], { anchored: true, origin: 0, periodSource: 'context' });
    assert.equal(deriveViewModel(scene([clip(4), three], { perf: PERF })).lcmQ, 4);
    three.periodSource = 'own';
    assert.equal(deriveViewModel(scene([clip(4), three], { perf: PERF })).lcmQ, 12);
});
