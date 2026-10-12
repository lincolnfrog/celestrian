/**
 * Q13 provisional-Q mutability: what the view model shows of the sole
 * Q-definer — the trim view, its one cursor, the lock — for a clip and
 * for a group. The mock's re-trim, lock-collapse and re-open are held
 * to the engine by the differential suite (ui/differential/ window/*);
 * the mock tests here are the sequences no journey drives.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { periodContribution } from '../period_law.js';
import { publishedLaw } from '../vm/published.js';
import { MOCK_Q, PERF as perf, near } from './helpers.mjs';
import { published as find, recordGroupTake } from './mock_scene.mjs';

test('view model: exposes the sole Q-definer while provisional', () => {
    loadScenario('single-clip');
    const vm1 = deriveViewModel(getState());
    assert.equal(vm1.soleQDefinerId, 'clip-1', 'sole committed clip is the definer');
    const lane = vm1.lanes.find(l => l.id === 'clip-1');
    assert.equal(lane.isQDefiner, true, 'its lane is flagged');
});

test('mock: deleting the sole clip reverts Q (derived → fallback)', async () => {
    loadScenario('single-clip');
    await callNative('deleteNode', 'clip-1');
    const vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, null, 'no definer once empty');
    assert.equal(vm.qEstablished, false, 'Q reverts to unestablished');
});

// Provisional display: the definer frames its FULL buffer with the loop
// as a selection overlay — so trimming never hides the rest of the clip.
const definerClip = () => ({
    id: 'c1', type: 'clip', name: 'A', duration: 200, effectiveQuantum: 100,
    loopStart: 20, loopEnd: 120, isRecording: false,
});

test('provisional definer frames the full buffer, loop as selection', () => {
    const vm = deriveViewModel({ nodes: [definerClip()], islandZero: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, true, 'provisional');
    // Frame = full buffer: cycleQ = duration/quantum = 200/100.
    assert.equal(vm.cycleQ, 2, 'frame spans the whole recorded buffer');
    const lane = vm.lanes.find(l => l.id === 'c1');
    assert.equal(lane.isQDefiner, true);
    assert.equal(lane.reps.length, 1, 'one full tile (no echoes)');
    assert.equal(lane.reps[0].startQ, 0);
    assert.equal(lane.reps[0].endQ, 2, 'tile spans the full buffer');
    assert.equal(lane.window.startQ, 0.2, 'selection start (loopStart/quantum)');
    assert.equal(lane.window.endQ, 1.2, 'selection end (loopEnd/quantum)');
});

test('provisional trim view: the ONE playhead maps into the selection', () => {
    // The transport publishes ISLAND time wrapped on the trimmed loop
    // ([0, Q)); the trim view frames BUFFER time. The one playhead (I8)
    // maps island phase into the selection: selStart + islandPos —
    // it sweeps the selected loop region and never the dead air.
    const vm = deriveViewModel({ nodes: [definerClip()], islandZero: 20,
                                 masterPos: 30, perf });
    // Q = 100 (loop [20, 120)); island pos = 30 → 0.3Q; the selection
    // starts 0.2Q into the buffer frame.
    assert.equal(vm.loopStartQ, 0.2, 'loop region origin in frame Q');
    assert.ok(Math.abs(vm.playheadQ - 0.5) < 1e-9, 'cursor = selStart + islandPos');
    assert.equal(vm.armAtQ, 1.2, 'next island boundary = the selection end');
    const lane = vm.lanes.find(l => l.id === 'c1');
    assert.equal(lane.windowPhase, 0, 'no second (amber) cursor on the definer');
});

test('a definer carrying a multi-segment map: the selection and the cursor come from the map', () => {
    // Kept [2000, 4000) + [5000, 6000) of an 8000 take: the loop is
    // 3000 long, and that is Q. A multi-segment map publishes
    // loopStart = loopEnd = 0 beside `segments`.
    const definer = { id: 'd', type: 'clip', name: 'D', duration: 8000, origin: 0,
                      loopStart: 0, loopEnd: 0, segments: [2000, 4000, 5000, 6000],
                      windowActive: true, loopBypassed: false, loopTop: 2000,
                      isRecording: false };
    const at = phase => deriveViewModel({
        id: 'root', quantum: 3000, islandZero: 2000, islandPos: phase,
        masterPos: phase, definerId: 'd', nodes: [definer], perf });

    const vm = at(500);
    assert.equal(vm.provisionalDefiner, true, 'the trim view');
    const lane = vm.lanes.find(l => l.id === 'd');
    near(lane.window.startQ, 2000 / 3000, 'the selection starts at the first run');
    near(lane.window.endQ, 6000 / 3000, 'and ends at the last');
    near(vm.loopStartQ, 2000 / 3000, 'the loop region\'s origin');
    assert.deepEqual(vm.loopRunsQ, [[2000 / 3000, 4000 / 3000], [5000 / 3000, 2]],
        'the loop\'s runs, for whoever sweeps a cursor through it');
    near(vm.playheadQ, 2500 / 3000, 'half a run in: buffer sample 2500');
    near(vm.armAtQ, 6000 / 3000, 'the next Q boundary is the loop\'s end');

    // Past the first run the cursor is in the second — never in the cut.
    near(at(2500).playheadQ, 5500 / 3000, '500 into the second run');
    near(at(2000).playheadQ, 5000 / 3000, 'on the seam: the second run\'s start');
    near(at(2500).armAtQ, 6000 / 3000, 'the boundary stays the loop\'s end');

    // The same loop as ONE window: the selection start + the phase.
    const one = { ...definer, segments: undefined, loopStart: 2000, loopEnd: 5000 };
    const vm1 = deriveViewModel({
        id: 'root', quantum: 3000, islandZero: 2000, islandPos: 500,
        masterPos: 500, definerId: 'd', nodes: [one], perf });
    const lane1 = vm1.lanes.find(l => l.id === 'd');
    assert.equal(lane1.window.startQ, 2000 / 3000);
    assert.equal(lane1.window.endQ, 5000 / 3000);
    assert.equal(vm1.loopRunsQ, null, 'one span: loopStartQ + loopCycleQ say it all');
    near(vm1.playheadQ, 2500 / 3000, 'one window: selection start + phase');
    near(vm1.armAtQ, 5000 / 3000, 'one window: its end');
});

test('a 2nd committed clip LOCKS: definer collapses to normal rendering', () => {
    const c2 = { id: 'c2', type: 'clip', name: 'B', duration: 100,
                 effectiveQuantum: 100, loopStart: 0, loopEnd: 0, isRecording: false };
    const vm = deriveViewModel({ nodes: [definerClip(), c2], islandZero: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, false, 'locked with 2 committed clips');
    assert.equal(vm.soleQDefinerId, null, 'no sole definer');
});

test('mock: arming take 2 LOCK-COLLAPSES the trimmed definer', async () => {
    // The trim is a pre-lock affordance — once you build on it, the
    // trimmed region BECOMES the take (as if performed exactly) and the
    // looper is normal again. Undo restores.
    loadScenario('single-clip');
    const dur0 = getState().nodes[0].duration;
    const ls = dur0 / 4, q = dur0 / 2;
    await callNative('setLoopPoints', 'clip-1', ls, ls + q);   // sub-Q trim
    await callNative('createNode', 'clip', '');
    const id2 = getState().nodes.find(n => n.id !== 'clip-1').id;
    await callNative('startRecordingInNode', id2);

    const c1 = getState().nodes.find(n => n.id === 'clip-1');
    assert.equal(c1.duration, q, 'the window IS the take now');
    assert.equal(c1.loopStart, 0, 'window consumed');
    assert.equal(c1.loopEnd, 0, '...no window: the take IS the window');
    assert.equal(getState().quantum, q, 'Q unchanged by the collapse');

    // The trim kept the sounding position, so the grid's lines lie off
    // the clock: the arm waits for the next one, then the take runs.
    advanceBy(q);
    await callNative('stopRecordingInNode', id2);
    // The stop pads take 2 forward to its boundary; while it finishes
    // the island is LIVE and undo is refused (the live-take gate). Let
    // it commit, then undo the take and the collapse: the pre-collapse
    // state returns.
    assert.equal(await callNative('undo'), false, 'undo refused while the take finishes');
    advanceBy(q + 1024);  // past the stop boundary: take 2 commits
    assert.ok(!getState().nodes.find(n => n.id === id2).isRecording, 'take 2 committed');
    await callNative('undo');   // strips take 2
    await callNative('undo');   // snapshot restores the pre-collapse state
    const c1b = getState().nodes.find(n => n.id === 'clip-1');
    assert.equal(c1b.duration, dur0, 'undo restores the full buffer');
    assert.equal(c1b.loopStart, ls, '…and the trim');
});

test('an ARMED 2nd take suspends the provisional trim view', () => {
    // The engine collapses at ARM and refuses re-trim while a take is
    // in flight — the VM's trim view must end at the same moment.
    const armed = { id: 'c2', type: 'clip', name: 'B', duration: 0,
                    isPendingStart: true, isRecording: false };
    const vm = deriveViewModel({ nodes: [definerClip(), armed],
                                 islandZero: 0, masterPos: 0, perf });
    assert.equal(vm.provisionalDefiner, false, 'suspended while armed');
});

test('locked trimmed definer: the frame stays whole-Q (no LCM explosion)', () => {
    // After a sub-Q trim the definer's BUFFER length is a multiple of
    // the OLD Q — incommensurate with the new grid. LCM-ing the raw
    // duration would explode the frame the moment take 2 armed and
    // trip the maxTiles guards. The clip's whole-Q contribution is its
    // WINDOW.
    const definer = { id: 'c1', type: 'clip', name: 'A', duration: 190,
                      loopStart: 20, loopEnd: 60, windowActive: true,
                      isRecording: false };
    const take2 = { id: 'c2', type: 'clip', name: 'B', duration: 160,
                    loopStart: 0, loopEnd: 160, isRecording: false };
    const vm = deriveViewModel({ nodes: [definer, take2], quantum: 40,
                                 islandZero: 20, masterPos: 0, perf });
    assert.equal(vm.cycleQ, 4, 'frame = lcm(window 1Q, take2 4Q), not lcm(190, 160)');
    assert.ok(vm.lanes.find(l => l.id === 'c1').reps.length > 0,
        'definer lane still tiles (maxTiles guard not tripped)');
    assert.ok(vm.lanes.find(l => l.id === 'c2').reps.length > 0,
        'take-2 lane still tiles');

    // The contribution rule itself: the period law over the published
    // shape, judged against Q.
    const law = publishedLaw(40);
    assert.equal(periodContribution(definer, law), 40,
        'an incommensurate take hands over its window');
    assert.equal(periodContribution(take2, law), 160, 'whole-Q duration unchanged');
    // Bypassed, the 190 take fits no whole number of Qs: it drifts and
    // folds into nothing, so the frame stays finite — take 2's 4Q.
    const bypassed = { ...definer, loopBypassed: true, windowActive: false };
    assert.equal(periodContribution(bypassed, law), 0,
        'a bypassed incommensurate take drifts');
    const vmB = deriveViewModel({ nodes: [bypassed, take2], quantum: 40,
                                  islandZero: 20, masterPos: 0, perf });
    assert.equal(vmB.cycleQ, 4, 'the frame is still take 2\'s 4Q');
    assert.equal(vmB.lanes.find(l => l.id === 'c1').drifting, true);
    assert.ok(vmB.lanes.find(l => l.id === 'c2').reps.length > 0,
        'take-2 lane still tiles');
});

test('a clip RECORDING (armed 2nd take) suspends the provisional view', () => {
    const rec = { id: 'c2', type: 'clip', name: 'B', duration: 0,
                  effectiveQuantum: 0, isRecording: true };
    const vm = deriveViewModel({ nodes: [definerClip(), rec], islandZero: 0, masterPos: 0, perf });
    // c1 is still the sole COMMITTED clip, but recording suspends the
    // full-buffer view (we're transitioning to locked).
    assert.equal(vm.soleQDefinerId, 'c1', 'c1 still the sole committed clip');
    assert.equal(vm.provisionalDefiner, false, 'suspended while recording');
});

/* ---------- Q13 FOR GROUPS ----------
 * The fractal twin of the sole-clip definer: a stack whose direct clip
 * children are the island's only committed content and were recorded as
 * ONE take (N mics) is the DEFINER STACK. Its window re-establishes (Q,
 * zero) like a sole clip's; the window stays on the stack (it IS the
 * part under the window law), the children stay whole, and the view
 * model renders the same trim view. The mock's side of the trim and of
 * the lock-collapse (origins, zero, phase, the multi-segment map) is
 * pinned in stack_origin.test.mjs; here, what the view model shows. */

test('GROUPS: a first group take is the Q-definer — the trim view frames it; a second take locks it', async () => {
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 4);
    const D = find(ids[0]).duration;
    assert.equal(getState().quantum, D, 'the whole take is 1Q (first take)');
    assert.equal(find(ids[1]).duration, D, 'one take, both mics');

    // The VM offers the trim view on the GROUP lane, full take framed.
    let vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, stackId, 'the stack is the definer');
    const g = vm.lanes.find(l => l.id === stackId);
    assert.equal(g.kind, 'group');
    assert.equal(g.isQDefiner, true, 'trim view on the group lane');
    assert.equal(vm.cycleQ, 1, 'frame = the whole take (1Q before any trim)');
    assert.deepEqual([g.window.startQ, g.window.endQ, g.window.active], [0, 1, true]);
    // Children render whole beneath it — no map context, no chips.
    for (const id of ids) {
        const c = vm.lanes.find(l => l.id === id);
        assert.equal(c.underMap, undefined, 'no under-map slicing');
        assert.equal(c.reps.length, 1);
    }

    // Trim the GROUP to the middle half (a fractional-Q window: here it
    // re-establishes Q := D/2). The whole take is now 2Q; the selection
    // is the 1Q part [0.5Q, 1.5Q).
    await callNative('setLoopPoints', stackId, D / 4, (3 * D) / 4);
    vm = deriveViewModel(getState());
    assert.equal(vm.cycleQ, 2, 'trim view frames the whole take (2 new-Q)');
    const g2 = vm.lanes.find(l => l.id === stackId);
    assert.deepEqual([g2.window.startQ, g2.window.endQ], [0.5, 1.5]);
    assert.equal(g2.isQDefiner, true);

    // Take 2 on a new top-level track arms against Q = D/2: it locks Q
    // and collapses the group to its window.
    const t2 = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', t2);
    advanceBy(D / 2);
    await callNative('stopRecordingInNode', t2);
    advanceBy(D / 2);
    assert.equal(find(t2).isRecording, false, 'take 2 committed');
    vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, null, 'no definer once Q is locked');
    assert.equal(vm.cycleQ, 1, 'the group is a plain 1Q part');
});

test('GROUPS: members carrying their own windows — the trim view selects their common window; a re-trim makes them whole', async () => {
    // A group take committed against a LOCKED Q (a clip elsewhere held
    // Q) gets the commit-time loop region on each member; deleting that
    // clip then leaves a definer stack whose window lives on its
    // members. The trim view must select what the ear hears —
    // the members' common window — and a re-trim moves the window onto
    // the stack with the members whole (engine parity: the window
    // riders on the stack-definer LoopPoints edit).
    loadScenario('empty');
    const { stackId, ids } = await recordGroupTake(2, 4);
    const D = getState().quantum;
    const { findNode: rawNode } = await import('../mock/state.js');
    for (const id of ids) { const c = rawNode(id); c.loopStart = 0; c.loopEnd = D / 2; }

    let vm = deriveViewModel(getState());
    const g = vm.lanes.find(l => l.id === stackId);
    assert.equal(g.isQDefiner, true, 'still the definer stack');
    assert.deepEqual([g.window.startQ, g.window.endQ], [0, 0.5],
        'the selection is the members\' common window, not the whole take');
    for (const id of ids) {
        const c = vm.lanes.find(l => l.id === id);
        assert.equal(c.definerMember, true);
        assert.equal(c.window, null, 'members draw whole beneath (no brackets)');
    }

    await callNative('setLoopPoints', stackId, D / 4, (3 * D) / 4);
    assert.equal(getState().quantum, D / 2, 'Q := window length');
    assert.deepEqual([find(stackId).loopStart, find(stackId).loopEnd], [D / 4, (3 * D) / 4],
        'window on the stack');
    for (const id of ids) {
        assert.deepEqual([find(id).loopStart, find(id).loopEnd], [0, 0],
            'members made whole by the re-trim: whole is no window');
    }
    vm = deriveViewModel(getState());
    const g2 = vm.lanes.find(l => l.id === stackId);
    assert.deepEqual([g2.window.startQ, g2.window.endQ], [0.5, 1.5]);

    await callNative('undo');
    for (const id of ids) {
        assert.deepEqual([find(id).loopStart, find(id).loopEnd], [0, D / 2],
            'undo restores the members\' windows');
    }
    assert.ok(!(find(stackId).loopEnd > find(stackId).loopStart), 'and clears the stack window');
});

test('GROUPS: two takes in one stack are NOT a definer (different origins)', async () => {
    loadScenario('empty');
    const { stackId } = await recordGroupTake(2, 2);
    const D = getState().quantum;
    // A third mic recorded later inside the same stack: a second take.
    const c3 = await callNative('createNode', 'clip', stackId);
    await callNative('startRecordingInNode', c3);
    advanceBy(D);
    await callNative('stopRecordingInNode', c3);
    advanceBy(D);
    assert.equal(find(c3).isRecording, false);
    const vm = deriveViewModel(getState());
    assert.equal(vm.soleQDefinerId, null, 'three clips, two takes: locked');
    await callNative('setLoopPoints', stackId, 0, D * 1.5);
    assert.notEqual(find(stackId).loopEnd, D * 1.5, 'incoherent window refused');
});

/* ---------- SEQUENCES TRACK Q ---------- */

test('SEQUENCES TRACK Q: a definer re-trim rescales steps; an empty island clears them', async () => {
    loadScenario('empty');
    const c1 = await callNative('createNode', 'clip', '');
    await callNative('startRecordingInNode', c1);
    advanceBy(MOCK_Q);
    await callNative('stopRecordingInNode', c1);
    const q0 = getState().quantum;
    assert.ok(q0 > 0);
    await callNative('setSequence', 'mock-root', {
        steps: [{ name: 'A', len: 2 * q0 }, { name: 'B', len: 3 * q0 }], gates: {},
    });
    const lens = () => (getState().sequence ? getState().sequence.steps.map(s => s.len) : []);
    assert.deepEqual(lens(), [2 * q0, 3 * q0]);

    await callNative('setLoopPoints', c1, 0, q0 / 2);   // Q := q0/2
    assert.equal(getState().quantum, q0 / 2);
    assert.deepEqual(lens(), [q0, 1.5 * q0], 'A stays 2Q, B stays 3Q');
    await callNative('undo');
    assert.equal(getState().quantum, q0);
    assert.deepEqual(lens(), [2 * q0, 3 * q0], 'undo scales back');

    await callNative('deleteNode', c1);
    assert.equal(getState().quantum, 0, 'island reverted');
    assert.deepEqual(lens(), [], 'sequence cleared on an empty island');
    await callNative('undo');
    assert.deepEqual(lens(), [2 * q0, 3 * q0], 'undo restores the sequence with the clip');
});

test('GROUPS: a sub-Q trim never grows the trim view (one take = raw extent, not commensurate)', async () => {
    // Dragging the start to 25% re-defines Q = 0.75·D; the frame is NOT
    // ceil(D/Q)·Q = 1.5·D: the definer stack's extent is its one take,
    // exactly.
    loadScenario('empty');
    const { stackId } = await recordGroupTake(2, 4);
    const D = getState().quantum;
    await callNative('setLoopPoints', stackId, D / 4, D);
    const vm = deriveViewModel(getState());
    assert.equal(getState().quantum, (3 * D) / 4);
    assert.ok(Math.abs(vm.cycleQ - 4 / 3) < 1e-9, 'frame = the whole take = 4/3 new-Q');
    const g = vm.lanes.find(l => l.id === stackId);
    assert.ok(Math.abs(g.intrinsicQ - 4 / 3) < 1e-9);
    assert.ok(Math.abs(g.window.startQ - 1 / 3) < 1e-9, 'bracket at D/4 of the take');
    assert.ok(Math.abs(g.window.endQ - 4 / 3) < 1e-9, 'end untouched');
});
