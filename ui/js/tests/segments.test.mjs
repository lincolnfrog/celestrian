/**
 * Multi-segment time-maps — MOCK parity (time_maps.md phase 3).
 * The engine is pinned in tests/time_map_record_tests.cc (storage,
 * validation, undo, the callback-path record-through-cells) and
 * tests/qtime_lock_tests.cc (multi-segment definer + splice collapse);
 * this replays the same contracts through the mock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, setMasterPos }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { nodeById as findNodeById, recordTake, PERF as perf }
    from './helpers.mjs';

const nodeById = (id, nodes = getState().nodes) => findNodeById(id, nodes);

// A committed 4Q group (Q = 1000): take A 1Q, take B 4Q (stop mid-Q,
// settle pads to the 4000 boundary).
async function buildGroup() {
    loadScenario('empty');
    const groupId = await callNative('createNode', 'stack');
    const aId = await recordTake(groupId, 1000, { stopEarly: 0, settle: 0 });
    const bId = await recordTake(groupId, 4000, { stopEarly: 100, settle: 200 });
    return { groupId, aId, bId };
}

test('setSegments: publish, validation, delegation, undo', async () => {
    const { groupId } = await buildGroup();

    // Cells {Q1, Q3} of the 4Q group → period 2000.
    await callNative('setSegments', groupId, [0, 1000, 2000, 3000]);
    assert.deepEqual(nodeById(groupId).segments, [0, 1000, 2000, 3000],
        'segments published flat (engine metadata contract)');
    assert.equal(nodeById(groupId).windowActive, true, 'map active');

    // Malformed lists refuse.
    await callNative('setSegments', groupId, [0, 1000, 500, 1500]);   // overlap
    await callNative('setSegments', groupId, [2000, 3000, 0, 1000]);  // unsorted
    await callNative('setSegments', groupId, [0, 1000, 2000, 9999]);  // > intrinsic
    assert.deepEqual(nodeById(groupId).segments, [0, 1000, 2000, 3000],
        'malformed lists all refused');

    // n==1 delegates to the single-window path and clears the map.
    await callNative('setSegments', groupId, [500, 1500]);
    assert.equal(nodeById(groupId).segments, undefined, 'override cleared');
    assert.equal(nodeById(groupId).loopStart, 500, 'delegated (start)');
    assert.equal(nodeById(groupId).loopEnd, 1500, 'delegated (end)');

    // Undo restores the cell map; undo again → pristine.
    await callNative('undo');
    assert.deepEqual(nodeById(groupId).segments, [0, 1000, 2000, 3000],
        'undo restores the multi-segment map');
    await callNative('undo');
    assert.equal(nodeById(groupId).segments, undefined, 'undo to pristine');
});

test('cell map shortens the audible cycle; record-through-cells parity', async () => {
    const { groupId } = await buildGroup();
    const epoch = getState().islandEpoch;

    await callNative('setSegments', groupId, [0, 1000, 2000, 3000]);
    // Q18 (engine parity attachMapEditRiders — "clips and stacks alike"):
    // the group's map anchors at the group's OWN origin (take A's, 0),
    // so its heard top is 0 and the CYCLE-TOP RULE moves the epoch
    // there (the 2Q map defines the cycle; 1000 → 0 is a whole Q).
    // Pre-Q18 the stack map anchored at the epoch and a stack edit
    // rode no riders.
    assert.equal(getState().islandEpoch, 0, 'cycle-top rule: epoch → the map\'s heard top');
    // Audible cycle = lcm(Q=1000, period 2000) = 2000: published
    // masterPos wraps on it, from the NEW epoch.
    setMasterPos(epoch + 4500);
    assert.equal(getState().masterPos, 1500, 'view wraps on the cell period');

    // Record C through the cells: heard pend, one-period cap, dense C.
    const cId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', cId);
    assert.equal(nodeById(cId).isPendingStart, true, 'pends in heard time');
    assert.equal(nodeById(cId).pendingStartAt, epoch + 5000,
        'heard target on the period grid');
    advanceBy(500);
    advanceBy(2000);  // one full period → cap commits
    const c = nodeById(cId);
    assert.equal(c.isRecording, false, 'cap auto-committed');
    assert.equal(c.duration, 4000, 'dense C = the group inner cycle');
    assert.equal(c.contextCycle, 2000, 'heard frame = the cell period');

    // Mid-take gate: segments refused while a take is live.
    const dId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', dId);
    await callNative('setSegments', groupId, [0, 1000]);
    assert.deepEqual(nodeById(groupId).segments, [0, 1000, 2000, 3000],
        'segments edit refused while a take is live');
    await callNative('stopRecordingInNode', dId);
});

// === Stage 5: view-model display generalization ===

test('view model: multi-segment group lane — dims data, chip, no brackets', () => {
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [{
            id: 'g', name: 'G', type: 'stack', isExpanded: true,
            windowActive: true, loopBypassed: false,
            loopStart: 0, loopEnd: 0,
            segments: [0, 1000, 2000, 3000],
            nodes: [
                { id: 'a', name: 'A', type: 'clip', duration: 4000, origin: 0,
                  loopStart: 0, loopEnd: 0, isRecording: false },
                { id: 'b', name: 'B', type: 'clip', duration: 2000, origin: 0,
                  loopStart: 0, loopEnd: 0, isRecording: false },
            ],
        }],
    };
    const vm = deriveViewModel(state);
    const g = vm.lanes.find(l => l.id === 'g');
    // An ACTIVE multi map on a group rests in HEARD time exactly like
    // a clip's (2026-08-21): srcSegs on every tile, seams for the cuts.
    assert.equal(g.window, null, 'no bracket window for a multi map');
    assert.equal(g.periodQ, 2, 'heard period = the map period');
    assert.equal(g.mapMulti, true, 'multi flag for the chip label');
    assert.equal(g.windowChipQ, 2, 'chip period = Σ cells');
    assert.deepEqual(g.bandSegs, [[0, 1], [2, 3]], 'segments in Q');
    assert.equal(g.bandHeard, true, 'cuts render as seams');
    assert.deepEqual(g.reps[0].srcSegs, [[0, 0.25], [0.5, 0.75]],
        'the tile draws the cells of the 4Q composite');
    // BYPASSED: the raw-framed lane with dims data + the bypass chip.
    state.nodes[0].windowActive = false;
    state.nodes[0].loopBypassed = true;
    const vmB = deriveViewModel(state);
    const gB = vmB.lanes.find(l => l.id === 'g');
    assert.equal(gB.window, null, 'no bracket window for a multi map');
    assert.deepEqual(gB.mapSegs, [[0, 1], [2, 3]], 'segments in Q');
    assert.equal(gB.mapChipQ, 2, 'chip period = Σ cells');
    assert.equal(gB.mapBypassed, true, 'bypass state exposed');
    assert.equal(gB.periodQ, 4, 'raw inner cycle');
});

test('view model: multi-segment CLIP lane rests in heard time (srcSegs)', () => {
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [
            { id: 'c', name: 'C', type: 'clip', duration: 4000, origin: 0,
              windowActive: true, loopBypassed: false,
              loopStart: 0, loopEnd: 0,
              segments: [0, 1000, 2000, 3000], isRecording: false },
            { id: 'd', name: 'D', type: 'clip', duration: 2000, origin: 0,
              loopStart: 0, loopEnd: 0, isRecording: false },
        ],
    };
    const vm = deriveViewModel(state);
    const c = vm.lanes.find(l => l.id === 'c');
    assert.equal(c.periodQ, 2, 'heard period = the map period');
    assert.equal(c.mapMulti, true, 'multi flag for the chip label');
    assert.ok(c.reps.length > 0, 'reps render');
    assert.deepEqual(c.reps[0].srcSegs, [[0, 0.25], [0.5, 0.75]],
        'reps carry the concatenated content slices');
    // Recording cue threads the map context from the segments too.
    const state2 = {
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [{
            id: 'g', name: 'G', type: 'stack', isExpanded: true,
            windowActive: true, loopBypassed: false,
            loopStart: 0, loopEnd: 0, segments: [0, 1000, 2000, 3000],
            nodes: [
                { id: 'a', name: 'A', type: 'clip', duration: 4000, origin: 0,
                  loopStart: 0, loopEnd: 0, isRecording: false },
                { id: 'r', name: 'R', type: 'clip', isRecording: true,
                  duration: 500 },
            ],
        }],
    };
    const vm2 = deriveViewModel(state2);
    const rec = vm2.lanes.find(l => l.id === 'r');
    assert.equal(rec.throughMap, true, 'recording lane sees the cell map');
    assert.equal(rec.mapPeriodQ, 2, 'cue period from the segments');
    const g2 = vm2.lanes.find(l => l.id === 'g');
    assert.equal(g2.mapRecording, true, 'group cue live');
});

test('view model: periodQ is EXACT for fractional-bound maps (fp)', () => {
    // Field 2026-07-25: a slid cut with fractional bounds whose sample
    // lengths sum to exactly 1Q displayed "0.9999…Q" — periodQ must be
    // ONE division of the sample sum, never a sum of per-segment
    // divisions. 18480 + (88200 − 62580) = 44100 exactly.
    // The literals stay literal ON PURPOSE: this is a pinned fp
    // regression case whose whole point is that these exact sample
    // lengths sum to exactly 1Q. It carries its own `quantum` and so
    // is independent of the mock's rate.
    const state = {
        quantum: 44100, islandEpoch: 0, masterPos: 0, perf,
        nodes: [
            { id: 'c', name: 'C', type: 'clip', duration: 132300, origin: 0,
              windowActive: true, loopBypassed: false,
              loopStart: 0, loopEnd: 0,
              segments: [0, 18480, 62580, 88200], isRecording: false },
            // A 1Q sibling (the owner's Track 1) — a lone clip would be
            // the Q-definer and rest in its raw take instead.
            { id: 'd', name: 'D', type: 'clip', duration: 44100, origin: 0,
              loopStart: 0, loopEnd: 0, isRecording: false },
        ],
    };
    const vm = deriveViewModel(state);
    const c = vm.lanes.find(l => l.id === 'c');
    assert.equal(c.periodQ, 1, 'exactly 1 — no fp residue');
    assert.equal(vm.cycleQ, 1, 'the frame trusts the same exact period');
});

test('view model: cut-band fields (design A, 2026-07-22)', () => {
    // Group with a cell map: bands editable in place over the intrinsic
    // cycle; the covered set rides bandSegs.
    const groupState = (extraKids = []) => ({
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [{
            id: 'g', name: 'G', type: 'stack', isExpanded: true,
            windowActive: true, loopBypassed: false,
            loopStart: 0, loopEnd: 0, segments: [0, 1000, 2000, 4000],
            nodes: [
                { id: 'a', name: 'A', type: 'clip', duration: 4000,
                  origin: 0, loopStart: 0, loopEnd: 0, isRecording: false },
                { id: 'b', name: 'B', type: 'clip', duration: 2000,
                  origin: 0, loopStart: 0, loopEnd: 0, isRecording: false },
                ...extraKids,
            ],
        }],
    });
    const vm = deriveViewModel(groupState());
    const g = vm.lanes.find(l => l.id === 'g');
    assert.deepEqual(g.bandSegs, [[0, 1], [2, 4]], 'covered set in Q');
    assert.equal(g.bandTotalQ, 4, 'bands span the intrinsic cycle');
    assert.equal(g.bandEditable, true, 'editable at rest');

    // A recording child freezes editing (the engine gate's mirror).
    const state2 = groupState([{ id: 'r', name: 'R', type: 'clip',
                                 isRecording: true, duration: 500 }]);
    assert.equal(deriveViewModel(state2).lanes.find(l => l.id === 'g')
        .bandEditable, false, 'not editable while a take is live');

    // A heard-view clip lane (active map) has NO in-place bands — its
    // raw truth lives in the edit view.
    const state3 = {
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [
            { id: 'c', name: 'C', type: 'clip', duration: 4000, origin: 0,
              windowActive: true, loopBypassed: false, loopStart: 0,
              loopEnd: 0, segments: [0, 1000, 2000, 3000], isRecording: false },
            { id: 'd', name: 'D', type: 'clip', duration: 2000, origin: 0,
              loopStart: 0, loopEnd: 0, isRecording: false },
        ],
    };
    // Heard-view lanes edit IN PLACE too (field 2026-07-23, modeless):
    // raw geometry rides bandSegs, rendered as SEAM handles (bandHeard)
    // rather than width-ful bands.
    const c = deriveViewModel(state3).lanes.find(l => l.id === 'c');
    assert.deepEqual(c.bandSegs, [[0, 1], [2, 3]], 'heard view: raw segs ride');
    assert.equal(c.bandHeard, true, 'flagged as heard-framed (seams)');
    assert.equal(c.bandPeriodQ, 2, 'heard period for the pointer hop');
    assert.equal(c.bandEditable, true, 'editable in place — no mode');
    // …but its edit view carries them over the raw take.
    const vmEdit = deriveViewModel(state3, { windowEdit: new Set(['c']) });
    const ce = vmEdit.lanes.find(l => l.id === 'c');
    assert.equal(ce.windowEditing, true, 'edit view open');
    assert.deepEqual(ce.bandSegs, [[0, 1], [2, 3]], 'bands over the raw take');
    assert.equal(ce.bandTotalQ, 4, 'raw-take frame');
});

test('view model: enclosing map projects excluded regions onto children', () => {
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 0, perf,
        nodes: [{
            id: 'g', name: 'G', type: 'stack', isExpanded: true,
            windowActive: true, loopBypassed: false,
            loopStart: 0, loopEnd: 0, segments: [0, 1000, 2000, 4000],
            nodes: [
                { id: 'a', name: 'A', type: 'clip', duration: 4000, origin: 0,
                  loopStart: 0, loopEnd: 0, isRecording: false },
                { id: 'b', name: 'B', type: 'clip', duration: 2000, origin: 0,
                  loopStart: 0, loopEnd: 0, isRecording: false },
            ],
        }],
    };
    const vm = deriveViewModel(state);
    // 2026-08-21: children under an ACTIVE map show the slice the map
    // selects of them (the child heard unroll) — no dims needed, the
    // lane IS what sounds. Parent period 3Q; A (4Q) reads [0,1)+[2,4);
    // B (2Q) reads [0,1), then [0,2) (its second pass under [2,4)).
    const a = vm.lanes.find(l => l.id === 'a');
    assert.equal(a.parentMapSegs, null, 'no projection dims on a heard child');
    assert.equal(a.periodQ, 3, 'the part under the map');
    assert.deepEqual(a.reps[0].srcSegs, [[0, 0.25], [0.5, 1]]);
    const b = vm.lanes.find(l => l.id === 'b');
    assert.deepEqual(b.reps[0].srcSegs, [[0, 0.5], [0, 1]],
        'every child, through its own period');
    // BYPASSED map: the raw-framed children carry the covered set as
    // dims data (the phase-3 projection, for the bypassed chip state).
    state.nodes[0].windowActive = false;
    state.nodes[0].loopBypassed = true;
    const vmB = deriveViewModel(state);
    const aB = vmB.lanes.find(l => l.id === 'a');
    assert.equal(aB.parentMapSegs, null, 'a bypassed map projects nothing');
    assert.equal(aB.periodQ, 4);
});

test('multi-segment definer re-trim: Q := period, epoch := origin\' + mapOffset(0)', async () => {
    loadScenario('empty');
    const aId = await recordTake('', 4000, { stopEarly: 0, settle: 0 });
    assert.equal(getState().quantum, 4000, 'Q established by the sole take');

    // Punch Q2 out: cells {[0,1000),[2000,4000)} → period 3000.
    await callNative('setSegments', aId, [0, 1000, 2000, 4000]);
    assert.equal(getState().quantum, 3000, 'Q := the map period');
    assert.equal(getState().islandEpoch, nodeById(aId).origin,
        'epoch = origin\' + mapOffset(0) (first cell at 0)');

    await callNative('undo');
    assert.equal(getState().quantum, 4000, 'undo restores the grid');
});
