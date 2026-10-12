/**
 * THE SEQUENCER (docs/sequencer.md) — the song as the mock publishes it
 * and the view model draws it:
 *
 *  - setSequence stores {steps, gates} on a stack (or the root),
 *    publishes engine-shaped metadata, and is UNDOABLE;
 *  - toggleSequence flips the bypass flag (the jam toggle) without
 *    touching geometry (I9);
 *  - THE PERIOD LAW: an active sequence is its holder's period — steps
 *    CONCATENATE, never LCM;
 *  - the grid row, the lane dims and the root's anchor in the frame.
 *
 * The verbs' refusals, the live-take gate and a take recorded over a
 * song are held to the engine by the differential suite
 * (ui/differential/ seq/*, take/live-gate).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, clip, state as sceneState, SCENE_Q } from './helpers.mjs';
import { recordIsland, seedTwoTracks } from './mock_scene.mjs';

test('setSequence on the root: stores, publishes, period law holds', async () => {
    const { a, Q } = await seedTwoTracks();
    assert.equal(Q, 1000, 'Q established');

    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'intro', len: 2 * Q }, { name: 'full', len: 4 * Q }],
        gates: { [a]: [true, false] },
    });
    const st = getState();
    assert.ok(st.sequence, 'root sequence published top-level');
    assert.equal(st.sequence.bypassed, false, 'born active');
    assert.deepEqual(st.sequence.steps.map(s => s.name), ['intro', 'full']);
    assert.deepEqual(st.sequence.gates[a], [true, false], 'gate row kept');

    // PERIOD LAW: the frame is the song (masterPos wraps on it; the VM
    // reads the effective cycle).
    const vm = deriveViewModel(st);
    assert.equal(vm.cycleQ, 6, 'frame = seq total (2Q + 4Q), not the LCM');

    // Undo removes it; redo restores it.
    await callNative('undo');
    assert.equal(getState().sequence, undefined, 'undo clears the sequence');
    await callNative('redo');
    assert.ok(getState().sequence, 'redo restores it');
});

test('toggleSequence: bypass flips, geometry survives (I9)', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 's', len: 3 * Q }], gates: {},
    });
    assert.equal(deriveViewModel(getState()).cycleQ, 3);
    await callNative('toggleSequence', 'mock-root');
    const st = getState();
    assert.equal(st.sequence.bypassed, true, 'bypassed');
    assert.equal(st.sequence.steps.length, 1, 'geometry survives bypass');
    assert.equal(deriveViewModel(st).cycleQ, 2,
        'bypassed: the jam frame comes back (lcm of takes)');
    await callNative('toggleSequence', 'mock-root');
    assert.equal(deriveViewModel(getState()).cycleQ, 3, 're-active');
});

test('sequences on GROUP stacks: fractal storage + period contribution',
    async () => {
    const [a, b] = await recordIsland(1000, 1000);
    await callNative('combineNodes', a, b);
    const group = getState().nodes.find(n => n.type === 'stack');
    assert.ok(group, 'group exists');
    const Q = getState().quantum;

    await callNative('setSequence', group.id, {
        steps: [{ name: 'p1', len: Q }, { name: 'p2', len: 2 * Q }],
        gates: { [a]: [true, false] },
    });
    const pub = getState().nodes.find(n => n.id === group.id);
    assert.ok(pub.sequence, 'group sequence published on the node');
    assert.deepEqual(pub.sequence.gates[a], [true, false]);
    // The group contributes seq total to the island frame (period law).
    assert.equal(deriveViewModel(getState()).cycleQ, 3,
        'group contributes 3Q (its song) to the frame');
});

test('the ROOT grid row: seqOpen on the root emits it FIRST, over the '
    + 'top-level tracks', async () => {
    const { a, b, Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'v', len: 2 * Q }, { name: 'c', len: 2 * Q }],
        gates: { [a]: [true, false] },
    });
    const vm = deriveViewModel(getState(),
        { seqOpen: new Set(['mock-root']) });
    const row = vm.lanes[0];
    assert.equal(row.kind, 'seq', 'root grid row is FIRST');
    assert.equal(row.ownerId, 'mock-root');
    assert.equal(row.steps.length, 2);
    assert.deepEqual(row.children.map(c => c.id), [a, b],
        'rows are the top-level tracks');
    assert.deepEqual(row.children[0].gates, [true, false]);
    assert.deepEqual(row.children[1].gates, [true, true],
        'absent uuid inherits ON');
    // The transport-chip facts ride the vm.
    assert.equal(vm.rootId, 'mock-root');
    assert.equal(vm.rootSeq.stepCount, 2);
    assert.equal(vm.rootSeq.bypassed, false);
    // The gated-off span projects onto track a's LANE as a dim.
    const laneA = vm.lanes.find(l => l.id === a);
    assert.deepEqual(laneA.seqDims[0].offSegsQ, [[2, 4]],
        'off step dims the lane');
    const laneB = vm.lanes.find(l => l.id === b);
    assert.equal(laneB.seqDims, undefined, 'inherit-ON lane undimmed');

    // The grid's one-cycle unit is the island's INTRINSIC cycle (lcm of
    // the takes: 2Q here), never the sequence-inflated frame — an append
    // adds one cycle, not one current song length.
    assert.equal(row.innerCycleQ, 2,
        'append unit = intrinsic cycle, not the song');
    assert.equal(vm.cycleQ, 4, 'while the frame IS the song');
});

test('malformed payloads refuse; null clears', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'ok', len: Q }], gates: {},
    });
    assert.ok(getState().sequence);
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'bad', len: 0 }], gates: {},
    });
    assert.equal(getState().sequence.steps[0].name, 'ok',
        'zero-length step refused, previous sequence kept');
    await callNative('setSequence', 'mock-root', null);
    assert.equal(getState().sequence, undefined, 'null clears');
});

test('STEP 3 (§12): nested sequences — period law on the group lane, layered dims, one-shot echoes', async () => {
    loadScenario('fractal-drums');
    const st = getState();
    const vm = deriveViewModel(st, { seqOpen: new Set(['drums']) });
    assert.equal(vm.cycleQ, 8, 'the root song frames everything');
    const drums = vm.lanes.find(l => l.id === 'drums');
    assert.equal(drums.periodQ, 4, 'the sequenced group tiles at its song length');
    assert.deepEqual(drums.reps.map(r => [r.startQ, r.endQ, r.ghost]),
        [[0, 4, false], [4, 8, true]], 'one pass per 4Q');
    assert.deepEqual(drums.seqDims,
        [{ periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null }],
        'the root gates Drums off in the intro');
    const kick = vm.lanes.find(l => l.id === 'kick');
    assert.deepEqual(kick.seqDims, [
        { periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null },
        { periodQ: 4, offSegsQ: [[1, 2], [3, 4]], cueSegsQ: null },
    ], 'layers compose: the root pass outermost, the kit pattern inside');
    assert.deepEqual(kick.reps.map(r => [r.startQ, r.endQ, r.ghost]),
        [[0, 1, false], [4, 5, true]], 'a one-shot echoes once per kit pass');
    const hat = vm.lanes.find(l => l.id === 'hat');
    assert.deepEqual(hat.seqDims,
        [{ periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null }],
        'an inherit-ON row gets only the outer layer');
    const grid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === 'drums');
    assert.equal(grid.innerCycleQ, 1, 'an all-one-shot kit appends 1Q steps (the drum-machine scale)');
    assert.deepEqual(grid.children.map(c => c.gates.map(Number).join('')),
        ['1010', '0101', '1111']);
    // Bypass the kit's pattern: the group lane falls back to its
    // intrinsic tiling and the inner layer disappears (I9).
    await callNative('toggleSequence', 'drums');
    const vm2 = deriveViewModel(getState());
    assert.equal(vm2.lanes.find(l => l.id === 'drums').periodQ, 1,
        'bypassed: intrinsic period again');
    assert.deepEqual(vm2.lanes.find(l => l.id === 'kick').seqDims,
        [{ periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null }],
        'only the root layer remains');
});

/* ---------- THE GRID YOU SEE IS THE GRID YOU HEAR: the engine folds a
 * group's song from the GROUP's origin (Q18 — StackNode::renderChildren),
 * so the gate dims and the grid's playing column carry the owner's
 * phase; the root (its frame IS the zero) carries none. Engine side:
 * tests/scenario_tests.cc S30/S31; the cross-layer seam is
 * tests/display_contract_tests.cc + display_contract.test.mjs. */
test('a group song\'s dims and playing column fold from the GROUP origin', () => {
    loadScenario('fractal-drums');
    const st = getState();
    const Q = st.quantum;
    const drums = st.nodes.find(n => n.id === 'drums');
    drums.anchored = true;
    drums.origin = 2 * Q;  // anchored 2Q past the zero
    const vm = deriveViewModel(st, { seqOpen: new Set(['drums']) });
    const kick = vm.lanes.find(l => l.id === 'kick');
    assert.deepEqual(kick.seqDims, [
        { periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null },
        { periodQ: 4, offSegsQ: [[1, 2], [3, 4]], cueSegsQ: null, phaseQ: 2 },
    ], 'the root layer sits at the zero; the kit layer carries the group phase');
    const grid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === 'drums');
    assert.equal(grid.phaseQ, 2, 'the grid row folds the playhead from the group origin');
    const rootGrid = deriveViewModel(st, { seqOpen: new Set([st.id]) })
        .lanes.find(l => l.kind === 'seq' && l.ownerId === st.id);
    assert.equal(rootGrid.phaseQ, 0, 'the root song is anchored at the zero');
    // A phase of a whole song is no phase (the layer stays bare).
    drums.origin = 4 * Q;
    const vm2 = deriveViewModel(st, { seqOpen: new Set(['drums']) });
    assert.deepEqual(vm2.lanes.find(l => l.id === 'kick').seqDims[1],
        { periodQ: 4, offSegsQ: [[1, 2], [3, 4]], cueSegsQ: null },
        'whole-song offsets fold away');
});

/* ---------- A WINDOW IS THE PART'S LENGTH EVERYWHERE (sequencer.md
 * §11.7: the append unit counts "a windowed child as its window"): the
 * chip, the frame, the transport and "+ step" all read it. */
test('"+ step" unit and the group chip follow a windowed group', async () => {
    await recordIsland(1000);
    const g = await callNative('createNode', 'stack');
    await recordTake(g, 8000, { stopEarly: 200, settle: 8200 });
    assert.equal(getState().nodes.find(n => n.id === g).nodes[0].isRecording,
        false, 'group take committed');
    const Q = getState().quantum;
    assert.equal(Q, 1000);

    // Before the window: the 8Q group IS 8Q, the unit is 8Q.
    let vm = deriveViewModel(getState(),
        { seqOpen: new Set(['mock-root']) });
    assert.equal(vm.cycleQ, 8);
    assert.equal(vm.lanes[0].kind, 'seq');
    assert.equal(vm.lanes[0].innerCycleQ, 8, 'unit = lcm(1Q, 8Q)');

    // Window the group to [4Q, 6Q): it is a 2Q part now — everywhere.
    await callNative('setLoopPoints', g, 4 * Q, 6 * Q);
    vm = deriveViewModel(getState(),
        { seqOpen: new Set(['mock-root']) });
    const lane = vm.lanes.find(l => l.id === g);
    assert.equal(lane.periodQ, 2, 'the group lane IS the window');
    assert.equal(lane.windowChipQ, 2, 'the chip reads 2Q');
    assert.equal(vm.cycleQ, 2, 'the frame = lcm(1Q, 2Q)');
    assert.equal(vm.loopCycleQ, 2, 'the transport wraps there too');
    assert.equal(vm.lanes[0].innerCycleQ, 2, '"+ step" appends a 2Q step');

    // The nested grid's unit is the group's INNER cycle (its own
    // children's parts) — the window selects over it.
    const vmG = deriveViewModel(getState(),
        { seqOpen: new Set([g]) });
    const grid = vmG.lanes.find(l => l.kind === 'seq' && l.ownerId === g);
    assert.equal(grid.innerCycleQ, 8, 'inside the group: the 8Q take');
    // And once the root sequence exists, the frame is the song built
    // from 2Q parts, not 8Q ones.
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q }, { name: 'B', len: 2 * Q }], gates: {},
    });
    vm = deriveViewModel(getState());
    assert.equal(vm.cycleQ, 4, 'the song: two 2Q steps');
});

/* ---------- THE ROOT'S ANCHOR RIDES ITS SONG (docs/frame.md §4): a
 * song authored on the root anchors the root at the frame zero the
 * view had seated (Q18 at depth 0), so the song's top is where the
 * picture already started and authoring moves nothing. The anchor
 * itself — where it lands, a seek, its undo, a re-authoring, a clear —
 * is held to the engine by ui/differential/ seq/root-anchor. */

/** Two tracks under a two-step root song authored at the zero the view
 * had seated: a cycle past the island zero, off the grid by a third of
 * a Q (the engine snaps it). */
async function seatedRootSong() {
    const { a, b, Q } = await seedTwoTracks();
    const before = deriveViewModel(getState());
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'a', len: 2 * Q }, { name: 'b', len: 2 * Q }],
        gates: { [b]: [true, false] },
    }, before.frameZero + 4 * Q + Math.floor(Q / 3));
    return { a, b, Q, before };
}

test('a root song authored at the seated zero moves no tile (frame.md §4)', async () => {
    const { a, b, Q, before } = await seatedRootSong();
    const st = getState();
    assert.equal(st.origin, before.frameZero + 4 * Q, 'the root sits at the seated zero, on the Q grid');
    // The root seats first, from its origin; the lanes then pull the
    // zero only by whole cycles-so-far, which the song divides — so
    // every tile stays where it was and the song's phase in the frame
    // is 0 (grid row and lane dims alike).
    const picture = vm => [a, b].map(id => vm.lanes.find(l => l.id === id).takeStartQ);
    const vm = deriveViewModel(st, { seqOpen: new Set([st.id]) });
    assert.deepEqual(picture(vm), picture(before), 'authoring the song moved no tile');
    assert.equal((st.origin - vm.frameZero) % (4 * Q), 0,
        'the frame\'s zero is a whole song from the root\'s origin');
    const rootGrid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === st.id);
    assert.equal(rootGrid.phaseQ, 0, 'the root song sits at the frame\'s zero');
    assert.deepEqual(vm.lanes.find(l => l.id === b).seqDims,
        [{ periodQ: 4, offSegsQ: [[2, 4]], cueSegsQ: null }],
        'the gated lane dims in step 2 of the frame, no phase');
});

test('the island revert un-anchors the root with its song; undo brings both back', async () => {
    // The last content deleted clears every song: the anchor goes with
    // the song and comes back with it.
    const { a, b } = await seatedRootSong();
    const O = getState().origin;
    await callNative('deleteNode', b);
    await callNative('deleteNode', a);
    let st = getState();
    assert.equal(st.quantum, 0, 'the island reverted');
    assert.equal(st.anchored, false, 'the revert un-anchors the root');
    await callNative('undo');
    await callNative('undo');
    st = getState();
    assert.equal(st.anchored, true, 'undo restores the song and its anchor');
    assert.equal(st.origin, O, 'at its stored origin');
});

test('the root seats first at its origin under a song; unanchored it seats at the island zero', () => {
    const Q = SCENE_Q;
    const E = 100 * Q;
    const c1 = clip(1, { origin: E });
    const c2 = clip(4, { origin: E });
    const song = { steps: [{ name: 'a', len: 2 * Q }, { name: 'b', len: 2 * Q }],
                   gates: { [c2.id]: [true, false] } };
    // Anchored (as the engine publishes a root song): the song's top is
    // the root's origin, a cycle past the island zero — the frame follows.
    const anchored = sceneState([c1, c2], {
        id: 'root', quantum: Q, islandZero: E, anchored: true, origin: E + 4 * Q,
        sequence: song, masterPos: 0,
    });
    const vm = deriveViewModel(anchored, { seqOpen: new Set(['root']) });
    assert.equal(Math.abs(vm.frameZero - (E + 4 * Q)) % (4 * Q), 0,
        'the frame\'s zero is a whole song from the root\'s origin');
    assert.equal(vm.lanes.find(l => l.kind === 'seq').phaseQ, 0);
    assert.equal(vm.lanes.find(l => l.id === c2.id).takeStartQ, 0,
        'a whole cycle off: the 4Q take still starts at the left edge');
    // Unanchored (a fixture): the root's frame is the island zero.
    const unanchored = sceneState([c1, c2], {
        id: 'root', quantum: Q, islandZero: E, anchored: false, origin: 0,
        sequence: song, masterPos: 0,
    });
    assert.equal(deriveViewModel(unanchored).frameZero, E,
        'unanchored: the song folds from the island zero');
});
