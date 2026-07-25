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

function nodeById(id, nodes = getState().nodes) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const found = n.nodes && nodeById(id, n.nodes);
        if (found) return found;
    }
    return null;
}

// A committed 4Q group (Q = 1000): take A 1Q, take B 4Q.
async function buildGroup() {
    loadScenario('empty');
    const groupId = await callNative('createNode', 'stack');
    const aId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', aId);
    advanceBy(1000);
    await callNative('stopRecordingInNode', aId);
    const bId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', bId);
    advanceBy(3900);
    await callNative('stopRecordingInNode', bId);
    advanceBy(200);
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
    // Audible cycle = lcm(Q=1000, period 2000) = 2000: published
    // masterPos wraps on it.
    setMasterPos(epoch + 4500);
    assert.equal(getState().masterPos, 500, 'view wraps on the cell period');

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

const perf = { sampleRate: 44100 };

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
    assert.equal(g.window, null, 'no bracket window for a multi map');
    assert.deepEqual(g.mapSegs, [[0, 1], [2, 3]], 'segments in Q');
    assert.equal(g.mapChipQ, 2, 'chip period = Σ cells');
    assert.equal(g.mapBypassed, false, 'bypass state exposed');
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
    const a = vm.lanes.find(l => l.id === 'a');
    assert.deepEqual(a.parentMapSegs, [[0, 1], [2, 4]],
        'child carries the enclosing map\'s covered set');
    assert.equal(a.parentMapPeriodQ, 4, 'tiled per the group cycle');
    const b = vm.lanes.find(l => l.id === 'b');
    assert.deepEqual(b.parentMapSegs, [[0, 1], [2, 4]],
        'every child, regardless of its own period');
});

test('multi-segment definer re-trim: Q := period, epoch := origin\' + mapOffset(0)', async () => {
    loadScenario('empty');
    const aId = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', aId);
    advanceBy(4000);
    await callNative('stopRecordingInNode', aId);
    assert.equal(getState().quantum, 4000, 'Q established by the sole take');

    // Punch Q2 out: cells {[0,1000),[2000,4000)} → period 3000.
    await callNative('setSegments', aId, [0, 1000, 2000, 4000]);
    assert.equal(getState().quantum, 3000, 'Q := the map period');
    assert.equal(getState().islandEpoch, nodeById(aId).origin,
        'epoch = origin\' + mapOffset(0) (first cell at 0)');

    await callNative('undo');
    assert.equal(getState().quantum, 4000, 'undo restores the grid');
});
