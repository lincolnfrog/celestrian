/**
 * COHERENCE GUARD: a map's period must be a whole multiple OR an exact
 * divisor of Q; anything else is refused. The guard on a clip is held
 * to the engine by the differential suite (ui/differential/
 * window/coherence, cuts/refusals); here, its sole exception — the Q13
 * sole-definer re-trim, where the edit re-establishes Q itself — and
 * the FRACTAL surface (I5): the same edits apply to GROUPS (stacks),
 * the guard included, and the view model hands group lanes the same
 * band/window fields the handle UI (nav dock, [ ] teleport, cut bands)
 * is built from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callNative, getState, loadScenario } from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { recordTake } from './helpers.mjs';
import { published as nodeById } from './mock_scene.mjs';

test('Q13 sole definer may re-trim FREELY (the edit re-defines Q)', async () => {
    loadScenario('empty');
    const t1 = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    // Sole committed clip: a fractional window is a Q re-definition,
    // not an incoherence — the exception the guard carves out.
    await callNative('setLoopPoints', t1, 0, 650);
    assert.equal(nodeById(t1).loopEnd, 650, 'free definer trim lands');
    assert.equal(getState().quantum, 650, 'Q re-established to 0.65 old-Q');
});

/* ---------- the fractal surface (I5): groups ---------- */

async function groupSetup() {
    loadScenario('empty');
    const t1 = await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const g = await callNative('createNode', 'stack');
    const c = await recordTake(g, 4000, { stopEarly: 200, settle: 600 });
    assert.equal(nodeById(c).isRecording, false, 'group take committed');
    return { t1, g, c };
}

test('FRACTAL: a group takes the same cut edits, guard included', async () => {
    const { g } = await groupSetup();
    // Incoherent group map (1.5Q period): refused.
    await callNative('setSegments', g, [0, 1000, 2000, 2500]);
    assert.equal(nodeById(g).segments, undefined,
        'incoherent group map refused');
    // Coherent 2-seg cut on the group: lands (clips and groups alike;
    // flat protocol form in the published state).
    await callNative('setSegments', g, [0, 1000, 2000, 3000]);
    assert.deepEqual(nodeById(g).segments, [0, 1000, 2000, 3000],
        'coherent group cut lands');
});

test('FRACTAL: the view-model hands groups the same handle-UI fields', async () => {
    const { g } = await groupSetup();
    await callNative('setSegments', g, [0, 1000, 2000, 3000]);
    const vm = deriveViewModel(getState());
    const lane = vm.lanes.find(l => l.id === g);
    assert.equal(lane.kind, 'group');
    // The fields the cut bands / nav dock / [ ] teleport build from —
    // identical shape to a clip lane's (bandState reads these). An
    // active map on a group renders the HEARD view (groups exactly as
    // clips): seams over the heard period, the cut geometry indexed
    // over the raw inner cycle.
    assert.deepEqual(lane.bandSegs, [[0, 1], [2, 3]],
        'group lane carries the cut geometry in Q');
    assert.equal(lane.bandTotalQ, 4, 'over its inner cycle');
    assert.equal(lane.bandHeard, true, 'heard view: cuts are seams');
    assert.equal(lane.bandPeriodQ, 2, 'over the heard period');
    assert.equal(lane.bandEditable, true, 'editable in place');

    // Single-window form: the same heard-view chip/grip fields a
    // windowed clip grows — no brackets on the lane (the tile IS the
    // window), the chip reads the part length.
    await callNative('setSegments', g, [1000, 3000]);
    const vm2 = deriveViewModel(getState());
    const lane2 = vm2.lanes.find(l => l.id === g);
    assert.equal(lane2.window, null, 'heard view: no brackets');
    assert.equal(lane2.windowChipQ, 2, 'the chip reads the part length');
    assert.deepEqual(lane2.bandSegs, [[1, 3]], 'the grips edit this span');
});

/* ---------- THE PARITY PIN: a windowed group and a windowed clip of the
 * same shape are the SAME lane — chip, period, reps, seams, LCM
 * contribution. Two builders, one law; this test is what keeps them
 * from drifting apart. */

// (takeStartQ / srcTopFrac are deliberately NOT compared: they are the
// loop's heard-top ROTATION, and the two anchor differently by ENGINE
// law — a clip's map anchors at origin + loopStart (the anchoring law),
// a group's at the island zero. Same view, different phase; the
// published windowPhase follows the same anchors.)
const LANE_PARITY_FIELDS = [
    'periodQ', 'intrinsicQ', 'window', 'windowChipQ',
    'mapMulti', 'bandSegs', 'bandTotalQ', 'bandHeard', 'bandPeriodQ',
    'bandEditable', 'frameQ', 'windowEditing',
];

function laneShape(lane) {
    const o = {};
    for (const k of LANE_PARITY_FIELDS) o[k] = lane[k] ?? null;
    o.reps = lane.reps.map(r => [r.startQ, r.endQ, !!r.ghost,
        r.srcSegs || null]);
    return o;
}

test('PARITY: a windowed group IS a windowed clip to the view-model', async () => {
    // Two 4Q parts over a 1Q definer: a loose clip and a group holding
    // one 4Q clip. Window both to [1Q, 3Q).
    loadScenario('empty');
    await recordTake('', 1000, { stopEarly: 0, settle: 0 });
    const c = await recordTake('', 4000, { stopEarly: 200, settle: 600 });
    const g = await callNative('createNode', 'stack');
    const gc = await recordTake(g, 4000, { stopEarly: 200, settle: 4200 });
    assert.equal(nodeById(gc).isRecording, false, 'group take committed');
    await callNative('setLoopPoints', c, 1000, 3000);
    await callNative('setLoopPoints', g, 1000, 3000);

    const vm = deriveViewModel(getState());
    const clipLane = vm.lanes.find(l => l.id === c);
    const groupLane = vm.lanes.find(l => l.id === g);
    assert.equal(clipLane.kind, 'clip');
    assert.equal(groupLane.kind, 'group');
    assert.deepEqual(laneShape(groupLane), laneShape(clipLane),
        'heard view: identical lane shape');
    assert.equal(groupLane.periodQ, 2, 'the window sets the part length');
    assert.equal(vm.cycleQ, 2, 'the frame is the audible cycle (2Q parts over 1Q)');
    assert.equal(vm.loopCycleQ, vm.cycleQ, 'frame == audible loop');


    // Bypass both: both fall back to the raw-framed lane with brackets.
    await callNative('toggleLoopWindow', c);
    await callNative('toggleLoopWindow', g);
    const vmB = deriveViewModel(getState());
    const clipB = vmB.lanes.find(l => l.id === c);
    const groupB = vmB.lanes.find(l => l.id === g);
    assert.equal(vmB.cycleQ, 4, 'bypassed: the parts are 4Q again');
    assert.equal(groupB.periodQ, 4);
    assert.deepEqual([groupB.window.startQ, groupB.window.endQ, groupB.window.bypassed],
        [1, 3, true], 'bypassed brackets on the group');
    assert.deepEqual([clipB.window.startQ, clipB.window.endQ, clipB.window.bypassed],
        [1, 3, true], 'bypassed brackets on the clip');
});
