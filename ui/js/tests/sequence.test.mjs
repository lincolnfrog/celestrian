/**
 * THE SEQUENCER — mock twin (docs/sequencer.md; C++ twin
 * tests/sequencer_tests.cc). Pins the mock's state contract:
 *
 *  - setSequence stores {steps, gates} on a stack (or the root),
 *    publishes engine-shaped metadata, and is UNDOABLE;
 *  - toggleSequence flips the bypass flag (the jam toggle) without
 *    touching geometry (I9);
 *  - THE PERIOD LAW: an active sequence sets the effective cycle to
 *    lcm(Q, seq total) — steps CONCATENATE (11Q + 12Q = 23Q, S10);
 *  - the mid-take gate refuses edits while a take is armed/recording,
 *    and a refused call records no undo step;
 *  - the heard frame: a take armed under an active sequence snapshots
 *    the song as its context (record-over-the-song, sequencer.md §4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario, advanceBy, setMasterPos }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake, clip, state as sceneState, SCENE_Q } from './helpers.mjs';

const opts = { fxOpen: new Set(),
               pinFrameQ: null, pinFoldQ: null };

async function seedTwoTracks() {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    if (getState().sequence) await callNative('toggleSequence', 'mock-root');
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 2000);
    return { a, b, Q: getState().quantum };
}

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
    const vm = deriveViewModel(st, opts);
    assert.equal(vm.cycleQ, 6, 'frame = seq total (2Q + 4Q), not the LCM');

    // Undo removes it; redo restores it.
    await callNative('undo');
    assert.equal(getState().sequence, undefined, 'undo clears the sequence');
    await callNative('redo');
    assert.ok(getState().sequence, 'redo restores it');
});

test('steps CONCATENATE: 11Q + 12Q = a 23Q song (S10)', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'a', len: 11 * Q }, { name: 'b', len: 12 * Q }],
        gates: {},
    });
    const vm = deriveViewModel(getState(), opts);
    assert.equal(vm.cycleQ, 23, 'steps sum, they never LCM');
});

test('toggleSequence: bypass flips, geometry survives (I9)', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 's', len: 3 * Q }], gates: {},
    });
    assert.equal(deriveViewModel(getState(), opts).cycleQ, 3);
    await callNative('toggleSequence', 'mock-root');
    const st = getState();
    assert.equal(st.sequence.bypassed, true, 'bypassed');
    assert.equal(st.sequence.steps.length, 1, 'geometry survives bypass');
    assert.equal(deriveViewModel(st, opts).cycleQ, 2,
        'bypassed: the jam frame comes back (lcm of takes)');
    await callNative('toggleSequence', 'mock-root');
    assert.equal(deriveViewModel(getState(), opts).cycleQ, 3, 're-active');
});

test('sequences on GROUP stacks: fractal storage + period contribution',
    async () => {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const b = await recordTake('', 1000);
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
    assert.equal(deriveViewModel(getState(), opts).cycleQ, 3,
        'group contributes 3Q (its song) to the frame');
});

test('mid-take gate: refused, and no undo step is recorded', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('createNode', 'clip', '');
    const st0 = getState();
    const fresh = st0.nodes[st0.nodes.length - 1].id;
    await callNative('startRecordingInNode', fresh);
    const undoBefore = getState().canUndo;
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'x', len: Q }], gates: {},
    });
    assert.equal(getState().sequence, undefined, 'refused mid-take');
    assert.equal(getState().canUndo, undoBefore,
        'a refused edit records nothing');
    await callNative('stopRecordingInNode', fresh);
    advanceBy(2 * Q);  // settle the awaiting-stop pad
});

test('record over the song: the heard frame IS the sequence', async () => {
    const { Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'one', len: 2 * Q }, { name: 'two', len: 4 * Q }],
        gates: {},
    });
    // A take armed now hears the 6Q song as its frame: its committed
    // contextCycle is the sequence total (sequencer.md §4, mode 1).
    const c = await recordTake('', 6 * Q);
    const node = getState().nodes.find(n => n.id === c);
    assert.equal(node.duration, 6 * Q, 'take committed over the song');
    assert.equal(node.contextCycle, 6 * Q,
        'heard frame = the sequence total');
});

test('the ROOT grid row: seqOpen on the root emits it FIRST, over the '
    + 'top-level tracks', async () => {
    const { a, b, Q } = await seedTwoTracks();
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'v', len: 2 * Q }, { name: 'c', len: 2 * Q }],
        gates: { [a]: [true, false] },
    });
    const vm = deriveViewModel(getState(),
        { ...opts, seqOpen: new Set(['mock-root']) });
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

    // THE DOUBLING REGRESSION (field 2026-08-20b): the grid's one-cycle
    // unit is the island's INTRINSIC cycle (lcm of the takes: 2Q here),
    // NEVER the sequence-inflated frame — appends were adding one
    // current song length each (2, 4, 8, 16...).
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
    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['drums']) });
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
    const vm2 = deriveViewModel(getState(), opts);
    assert.equal(vm2.lanes.find(l => l.id === 'drums').periodQ, 1,
        'bypassed: intrinsic period again');
    assert.deepEqual(vm2.lanes.find(l => l.id === 'kick').seqDims,
        [{ periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null }],
        'only the root layer remains');
});

/* ---------- THE FIELD BUG (owner, 2026-09-09): "the grid you see is the
 * grid you hear". The engine folds a group's song from the GROUP's
 * origin (Q18 — StackNode::renderChildren); the lanes used to tile the
 * gate dims from the lane frame's zero, and the grid's playing column
 * folded the raw playhead. A group anchored mid-cycle then dimmed the
 * wrong sections. The layer now carries the owner's phase; the root
 * (never anchored — its frame IS the zero) carries none. The engine
 * side is tests/scenario_tests.cc S30/S31; the cross-layer seam is
 * tests/display_contract_tests.cc + display_contract.test.mjs. */
test('a group song\'s dims and playing column fold from the GROUP origin (2026-09-09)', () => {
    loadScenario('fractal-drums');
    const st = getState();
    const Q = st.quantum;
    const drums = st.nodes.find(n => n.id === 'drums');
    drums.anchored = true;
    drums.origin = 2 * Q;  // anchored 2Q past the zero
    const vm = deriveViewModel(st, { ...opts, seqOpen: new Set(['drums']) });
    const kick = vm.lanes.find(l => l.id === 'kick');
    assert.deepEqual(kick.seqDims, [
        { periodQ: 8, offSegsQ: [[0, 4]], cueSegsQ: null },
        { periodQ: 4, offSegsQ: [[1, 2], [3, 4]], cueSegsQ: null, phaseQ: 2 },
    ], 'the root layer sits at the zero; the kit layer carries the group phase');
    const grid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === 'drums');
    assert.equal(grid.phaseQ, 2, 'the grid row folds the playhead from the group origin');
    const rootGrid = deriveViewModel(st, { ...opts, seqOpen: new Set([st.id]) })
        .lanes.find(l => l.kind === 'seq' && l.ownerId === st.id);
    assert.equal(rootGrid.phaseQ, 0, 'the root song is anchored at the zero');
    // A phase of a whole song is no phase (the layer stays bare).
    drums.origin = 4 * Q;
    const vm2 = deriveViewModel(st, { ...opts, seqOpen: new Set(['drums']) });
    assert.deepEqual(vm2.lanes.find(l => l.id === 'kick').seqDims[1],
        { periodQ: 4, offSegsQ: [[1, 2], [3, 4]], cueSegsQ: null },
        'whole-song offsets fold away');
});

/* ---------- THE FIELD BUG (owner, 2026-08-21): a 52Q group windowed to
 * a few Q kept a 52Q chip and a 52Q "+ step" — the root seeded 52Q steps
 * and the song ran 104Q around a 4Q groove. §11.7 says the append unit
 * counts "a windowed child as its window"; the ruling makes the window
 * the part's length everywhere (chip, frame, transport, + step). */
test('"+ step" unit and the group chip follow a windowed group (2026-08-21)', async () => {
    loadScenario('empty');
    await callNative('setSequence', 'mock-root', null);
    const a = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const g = await callNative('createNode', 'stack');
    const take = await recordTake(g, 8000, { stopEarly: 200, settle: 8200 });
    assert.equal(getState().nodes.find(n => n.id === g).nodes[0].isRecording,
        false, 'group take committed');
    const Q = getState().quantum;
    assert.equal(Q, 1000);

    // Before the window: the 8Q group IS 8Q, the unit is 8Q.
    let vm = deriveViewModel(getState(),
        { ...opts, seqOpen: new Set(['mock-root']) });
    assert.equal(vm.cycleQ, 8);
    assert.equal(vm.lanes[0].kind, 'seq');
    assert.equal(vm.lanes[0].innerCycleQ, 8, 'unit = lcm(1Q, 8Q)');

    // Window the group to [4Q, 6Q): it is a 2Q part now — everywhere.
    await callNative('setLoopPoints', g, 4 * Q, 6 * Q);
    vm = deriveViewModel(getState(),
        { ...opts, seqOpen: new Set(['mock-root']) });
    const lane = vm.lanes.find(l => l.id === g);
    assert.equal(lane.periodQ, 2, 'the group lane IS the window');
    assert.equal(lane.windowChipQ, 2, 'the chip reads 2Q');
    assert.equal(vm.cycleQ, 2, 'the frame = lcm(1Q, 2Q)');
    assert.equal(vm.loopCycleQ, 2, 'the transport wraps there too');
    assert.equal(vm.lanes[0].innerCycleQ, 2, '"+ step" appends a 2Q step');

    // The nested grid's unit is the group's INNER cycle (its own
    // children's parts) — the window selects over it.
    const vmG = deriveViewModel(getState(),
        { ...opts, seqOpen: new Set([g]) });
    const grid = vmG.lanes.find(l => l.kind === 'seq' && l.ownerId === g);
    assert.equal(grid.innerCycleQ, 8, 'inside the group: the 8Q take');
    // And once the root sequence exists, the frame is the song built
    // from 2Q parts, not 8Q ones.
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * Q }, { name: 'B', len: 2 * Q }], gates: {},
    });
    vm = deriveViewModel(getState(), opts);
    assert.equal(vm.cycleQ, 4, 'the song: two 2Q steps');
    void a; void take;
});

/* ---------- THE ROOT'S ANCHOR RIDES ITS SONG (docs/frame.md §4,
 * 2026-09-17): a song authored on the root anchors the root at the
 * frame zero the view had seated (Q18 at depth 0), so the song's top
 * is where the picture already started and authoring moves nothing.
 * Mock twin of AudioEngine::setSequence; pinned end to end by scenario
 * S39 in tests/scenario_tests.cc. */
test('a root song anchors the root at the seated zero (mock parity; frame.md §4)', async () => {
    const { a, b, Q } = await seedTwoTracks();
    const st0 = getState();
    const E = st0.islandZero;
    assert.equal(st0.anchored, false, 'no song: the root is unanchored');
    const picture = vm => [a, b].map(id => vm.lanes.find(l => l.id === id).takeStartQ);
    const before = deriveViewModel(st0, opts);
    // The view passes the zero it has seated (here: a cycle past the
    // island zero, off-grid by a third of a Q — the engine snaps it).
    const zero = before.frameZero + 4 * Q + Math.floor(Q / 3);
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'a', len: 2 * Q }, { name: 'b', len: 2 * Q }],
        gates: { [b]: [true, false] },
    }, zero);
    let st = getState();
    assert.equal(st.anchored, true, 'the song anchors the root');
    assert.equal(st.origin, before.frameZero + 4 * Q, 'at the seated zero, on the Q grid');
    assert.equal(st.islandZero, E, 'the island zero itself never moves');

    // THE PICTURE: the root seats first, from its origin; the lanes
    // then pull the zero only by whole cycles-so-far, which the song
    // divides — so every tile stays where it was and the song's phase
    // in the frame is 0 (grid row and lane dims alike).
    let vm = deriveViewModel(st, { ...opts, seqOpen: new Set([st.id]) });
    assert.deepEqual(picture(vm), picture(before), 'authoring the song moved no tile');
    assert.equal((st.origin - vm.frameZero) % (4 * Q), 0,
        'the frame\'s zero is a whole song from the root\'s origin');
    const rootGrid = vm.lanes.find(l => l.kind === 'seq' && l.ownerId === st.id);
    assert.equal(rootGrid.phaseQ, 0, 'the root song sits at the frame\'s zero');
    assert.deepEqual(vm.lanes.find(l => l.id === b).seqDims,
        [{ periodQ: 4, offSegsQ: [[2, 4]], cueSegsQ: null }],
        'the gated lane dims in step 2 of the frame, no phase');

    // THE CURSOR folds from the root's frame top (engine parity:
    // masterPos = (t − rootFrameTop) mod cycle).
    setMasterPos(st.origin + 3);
    assert.equal(getState().masterPos, 3, 'masterPos measured from the root\'s origin');

    // A SEEK moves every origin with the zero — the root's included —
    // and lands the requested phase against the root's frame top.
    const placement = st.origin - st.islandZero;
    // (The engine takes a phase ADVANCE: back to 0 from 3.)
    assert.ok(await callNative('seekTransport', -getState().masterPos));
    st = getState();
    assert.equal(st.masterPos, 0, 'phase 0 after the seek');
    assert.equal(st.origin - st.islandZero, placement, 'the root\'s placement survives the seek');

    // UNDO of the authoring un-anchors; redo re-anchors at the stored origin.
    const O = st.origin;
    await callNative('undo');
    assert.equal(getState().anchored, false, 'undo un-anchors the root');
    await callNative('redo');
    st = getState();
    assert.equal(st.anchored, true, 'redo re-anchors');
    assert.equal(st.origin, O, 'at the same origin');

    // A re-authoring keeps the origin (the song owns the frame).
    await callNative('setSequence', 'mock-root',
        { steps: [{ name: 'a', len: 4 * Q }], gates: {} }, O + 4 * Q);
    assert.equal(getState().origin, O, 'a root already anchored keeps its origin');

    // CLEARING the song un-anchors; undo brings the anchor back.
    await callNative('setSequence', 'mock-root', null);
    assert.equal(getState().anchored, false, 'no song, no anchor');
    await callNative('undo');
    assert.equal(getState().anchored, true, 'undo of the clear re-anchors');
    assert.equal(getState().origin, O, 'where it was');

    // THE ISLAND REVERT (the last content deleted clears every song):
    // the anchor goes with the song and comes back with it.
    await callNative('deleteNode', b);
    await callNative('deleteNode', a);
    st = getState();
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
    // Anchored (the engine after 2026-09-17): the song's top is the
    // root's origin, a cycle past the island zero — the frame follows.
    const anchored = sceneState([c1, c2], {
        id: 'root', quantum: Q, islandZero: E, anchored: true, origin: E + 4 * Q,
        sequence: song, masterPos: 0,
    });
    const vm = deriveViewModel(anchored, { ...opts, seqOpen: new Set(['root']) });
    assert.equal(Math.abs(vm.frameZero - (E + 4 * Q)) % (4 * Q), 0,
        'the frame\'s zero is a whole song from the root\'s origin');
    assert.equal(vm.lanes.find(l => l.kind === 'seq').phaseQ, 0);
    assert.equal(vm.lanes.find(l => l.id === c2.id).takeStartQ, 0,
        'a whole cycle off: the 4Q take still starts at the left edge');
    // Unanchored (a state from before the rule, or a fixture): the
    // root's frame is the island zero.
    const legacy = sceneState([c1, c2], {
        id: 'root', quantum: Q, islandZero: E, anchored: false, origin: 0,
        sequence: song, masterPos: 0,
    });
    assert.equal(deriveViewModel(legacy, opts).frameZero, E,
        'unanchored: the song folds from the island zero');
});
