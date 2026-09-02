/**
 * Recording through an active time-map — MOCK parity (time_maps.md
 * phase 2). The engine is pinned in tests/time_map_record_tests.cc;
 * this replays the same shapes through the mock: heard-time arm on the
 * map-period grid, the one-period cap, dense commit at the mapping
 * group's full inner cycle C, the nested-map refusal, and the mid-take
 * map-edit gate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario, setMasterPos }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { nodeById as findNodeById, recordTake, PERF as perf }
    from './helpers.mjs';

const nodeById = (id, nodes = getState().nodes) => findNodeById(id, nodes);

test('through-map record: heard arm, one-period cap, dense C commit', async () => {
    loadScenario('empty');
    const groupId = await callNative('createNode', 'stack');

    // Take A establishes Q = 1000 (first clip records immediately).
    await recordTake(groupId, 1000, { stopEarly: 0, settle: 0 });
    assert.equal(getState().quantum, 1000, 'Q established by take A');

    // Take B = 4Q → group inner cycle 4000; its commit grows the cycle
    // and re-bases the epoch to B's heard top (1000). Stop mid-Q, then
    // settle pads forward to the 4000 boundary and commits.
    const bId = await recordTake(groupId, 4000, { stopEarly: 100, settle: 200 });
    assert.equal(nodeById(bId).duration, 4000, 'take B committed at 4Q');
    const epoch = getState().islandEpoch;
    assert.equal(epoch, 1000, 'epoch re-based to B\'s heard top');

    // Window the group: [1Q, 3Q) → map period 2000, C = 4000.
    await callNative('setLoopPoints', groupId, 1000, 3000);

    // Arm C through the map at heard rel 4500 → heard target 5000
    // (next Q on the period grid). Q18 (composition.md §2, engine
    // clip_node.cc through-map arm): the map's inner positions are
    // offsets from the mapping STACK's origin (anchored at take A's
    // origin, 0 — not the epoch, 1000): the heard grid anchor is
    // origin + a0 = 1000 (≡ the epoch here), and the anchor's inner
    // position is origin + mapOffset(1000) = 0 + 2000 = 2000.
    // (Pre-Q18 the stack map anchored at the epoch, giving 3000.)
    const stackOrigin = nodeById(groupId).origin;
    assert.equal(stackOrigin, 0, 'the group anchored at take A\'s origin');
    assert.equal(nodeById(groupId).anchored, true);
    setMasterPos(epoch + 4500);
    const cId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', cId);
    assert.equal(nodeById(cId).isPendingStart, true, 'pends in heard time');
    assert.equal(nodeById(cId).pendingStartAt, epoch + 5000,
        'heard target on the map-period grid');

    // MID-TAKE MAP-EDIT GATE (owner-ruled): the mapping group refuses
    // window edits while the take is live; a sibling stays editable.
    await callNative('setLoopPoints', groupId, 0, 2000);
    await callNative('toggleLoopWindow', groupId);
    assert.equal(nodeById(groupId).loopStart, 1000, 'edit refused (start)');
    assert.equal(nodeById(groupId).loopEnd, 3000, 'edit refused (end)');
    assert.ok(!nodeById(groupId).loopBypassed, 'bypass toggle refused');
    const sibId = await callNative('createNode', 'stack');
    await callNative('setLoopPoints', sibId, 0, 500);
    assert.equal(nodeById(sibId).loopEnd, 500, 'sibling stays editable');
    await callNative('setLoopPoints', sibId, 0, 0); // tidy: no stray map

    // Trigger, then run one full map pass — the cap auto-commits.
    advanceBy(500);   // reaches the heard target
    assert.equal(nodeById(cId).isPendingStart, false, 'capture began');
    advanceBy(2000);  // one full period
    const c = nodeById(cId);
    assert.equal(c.isRecording, false, 'one-period cap auto-committed');
    assert.equal(c.duration, 4000, 'commit duration = C (dense inner cycle)');
    assert.equal(c.origin, stackOrigin + 2000,
        'origin = stack origin + mapOffset(heard offset) (Q18)');
    assert.equal(c.contextCycle, 2000, 'heard frame = the map period cycle');
    assert.equal(getState().islandEpoch, epoch,
        'no epoch re-base (C divides the island cycle)');

    // Gate lifts after commit.
    await callNative('setLoopPoints', groupId, 1000, 3000); // no-op restore
    assert.equal(nodeById(groupId).loopEnd, 3000, 'gate lifted');

    // A short stopped take still commits dense C: arm at heard rel
    // 8500 → target 9000; stop at heard 600 → boundary 1000 (clamped
    // ≤ period), duration still C.
    setMasterPos(epoch + 8500);
    const dId = await callNative('createNode', 'clip', groupId);
    await callNative('startRecordingInNode', dId);
    assert.equal(nodeById(dId).pendingStartAt, epoch + 9000,
        'target on the period grid, second pass');
    advanceBy(500);  // trigger
    advanceBy(600);
    await callNative('stopRecordingInNode', dId);
    assert.equal(nodeById(dId).awaitingStopAt, 1000,
        'stop boundary on the heard grid, clamped to the period');
    advanceBy(400);
    assert.equal(nodeById(dId).duration, 4000, 'short take commits dense C');
    assert.equal(nodeById(dId).origin, stackOrigin + 2000,
        'second-pass anchor folds to the same inner position (Q18)');
});

test('nested active maps refuse the arm (phase-2 scope)', async () => {
    loadScenario('empty');
    const groupId = await callNative('createNode', 'stack');
    await recordTake(groupId, 1000, { stopEarly: 0, settle: 0 });

    await callNative('setLoopPoints', groupId, 0, 500);
    const innerId = await callNative('createNode', 'stack', groupId);
    await callNative('setLoopPoints', innerId, 0, 250);

    const eId = await callNative('createNode', 'clip', innerId);
    await callNative('startRecordingInNode', eId);
    assert.ok(!nodeById(eId).isRecording, 'composed maps: arm refused');

    // Bypass one → single active map → the arm proceeds.
    await callNative('toggleLoopWindow', innerId);
    await callNative('startRecordingInNode', eId);
    assert.ok(nodeById(eId).isRecording, 'single map: arm proceeds');
});

// === View model: the ruling-5 cue + heard-cursor honesty ===

const mappedGroup = (extra = {}) => ({
    id: 'g', name: 'G', type: 'stack',
    windowActive: true, loopStart: 1000, loopEnd: 3000, loopBypassed: false,
    nodes: [
        { id: 'a', name: 'A', type: 'clip', duration: 4000, origin: 0,
          loopStart: 0, loopEnd: 0, isRecording: false },
        ...(extra.children || []),
    ],
    ...extra.group,
});

test('view model: recording lane under an active map carries the cue', () => {
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 5500, perf,
        nodes: [mappedGroup({ children: [
            { id: 'c', name: 'C', type: 'clip', isRecording: true, duration: 500 },
        ] })],
    };
    const vm = deriveViewModel(state);
    const rec = vm.lanes.find(l => l.id === 'c');
    assert.equal(rec.throughMap, true, 'throughMap flag set');
    assert.equal(rec.mapPeriodQ, 2, 'map period in Q');
    assert.equal(rec.mapStartQ, 1, 'map start in Q');
    const g = vm.lanes.find(l => l.id === 'g');
    assert.equal(g.mapRecording, true, 'mapping group carries the live cue');
});

test('view model: bypassed map → no cue', () => {
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 5500, perf,
        nodes: [mappedGroup({
            group: { windowActive: false, loopBypassed: true },
            children: [
                { id: 'c', name: 'C', type: 'clip', isRecording: true, duration: 500 },
            ],
        })],
    };
    const vm = deriveViewModel(state);
    const rec = vm.lanes.find(l => l.id === 'c');
    assert.equal(rec.throughMap, false, 'no map, no cue');
    const g = vm.lanes.find(l => l.id === 'g');
    assert.equal(g.mapRecording, false, 'group cue off');
});

test('view model: a windowed group is the frame; the ONE playhead sweeps it', () => {
    // 2026-08-21 (a window sets the part's length): the audible cycle
    // = the window pass (2000) IS the display frame; the group lane
    // shows the window's content from 0, so island phase IS lane
    // position — no remap, no second cursor.
    // (Two committed clips so the Q13 provisional view stays out.)
    const state = {
        quantum: 1000, islandEpoch: 0, masterPos: 500, isPlaying: true, perf,
        nodes: [mappedGroup({ children: [
            { id: 'b', name: 'B', type: 'clip', duration: 2000, origin: 0,
              loopStart: 0, loopEnd: 0, isRecording: false },
        ] })],
    };
    const vm = deriveViewModel(state);
    assert.equal(vm.cycleQ, 2, 'the frame is the window');
    assert.equal(vm.loopStartQ, 0, 'no remap');
    assert.ok(Math.abs(vm.playheadQ - 0.5) < 1e-9, 'cursor = island phase');
    const g = vm.lanes.find(l => l.id === 'g');
    assert.equal(g.periodQ, 2);
    assert.equal(g.windowPhase, 0, 'no amber cursor on the heard lane');
    assert.deepEqual(g.reps[0].srcSegs, [[0.25, 0.75]],
        'the group tile draws the [1Q, 3Q) slice of its 4Q composite');
    // THE CHILD HEARD UNROLL: the children show the same slice — A
    // (4Q, at 0) its [1Q, 3Q); B (2Q, at 0) its [1Q, 2Q) then [0, 1Q).
    const a = vm.lanes.find(l => l.id === 'a');
    const b = vm.lanes.find(l => l.id === 'b');
    assert.equal(a.periodQ, 2, 'child period = the part under the map');
    assert.deepEqual(a.reps[0].srcSegs, [[0.25, 0.75]]);
    assert.deepEqual(b.reps[0].srcSegs, [[0.5, 1], [0, 0.5]]);
    assert.equal(a.parentMapSegs, null, 'no dims: the lane shows only what sounds');
});

test('view model: committed through-map take tiles at its inner anchor', () => {
    // The stage-4 engine shape: C committed duration 4000 (= the inner
    // cycle), origin 3000 with epoch 1000 → tile offset 2Q in a 4Q lane.
    const state = {
        quantum: 1000, islandEpoch: 1000, masterPos: 0, perf,
        nodes: [{
            id: 'g', name: 'G', type: 'stack',
            windowActive: true, loopStart: 1000, loopEnd: 3000, loopBypassed: false,
            nodes: [
                { id: 'a', name: 'A', type: 'clip', duration: 4000, origin: 1000,
                  loopStart: 0, loopEnd: 0, isRecording: false },
                { id: 'c', name: 'C', type: 'clip', duration: 4000, origin: 3000,
                  contextCycle: 2000, loopStart: 0, loopEnd: 0, isRecording: false },
            ],
        }],
    };
    const vm = deriveViewModel(state);
    const c = vm.lanes.find(l => l.id === 'c');
    // Under the group's active [1Q, 3Q) map the lane shows the slice
    // the map selects of C (2026-08-21): C tiles at 4Q from its inner
    // anchor 2Q, so inner [1Q, 3Q) reads C's content [3Q, 4Q) + [0, 1Q).
    assert.equal(c.periodQ, 2, 'lane period = the part under the map');
    assert.ok(c.reps.length > 0, 'take tiles render');
    assert.deepEqual(c.reps[0].srcSegs, [[0.75, 1], [0, 0.25]],
        'the take is read through its inner anchor (2Q)');
    // The raw-framed truth survives with the map bypassed.
    state.nodes[0].windowActive = false;
    state.nodes[0].loopBypassed = true;
    const vmB = deriveViewModel(state);
    const cB = vmB.lanes.find(l => l.id === 'c');
    assert.equal(cB.periodQ, 4, 'lane period = the dense inner cycle');
    assert.equal(cB.takeStartQ, 2, 'take marks at its inner anchor (2Q)');
});
