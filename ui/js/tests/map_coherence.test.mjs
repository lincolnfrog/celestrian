/**
 * COHERENCE GUARD (owner ruling 2026-08-09, mock side — C++ twin
 * guards live in AudioEngine::setSegments / setLoopPoints): a map's
 * period must be a whole multiple OR an exact divisor of Q; anything
 * else is refused, categorically. Sole exception: the Q13 sole-definer
 * re-trim, where the edit re-establishes Q itself. Also pins the
 * FRACTAL surface (I5): the same setSegments/window edits apply to
 * GROUPS (stacks), the guard included, and the view-model hands group
 * lanes the same band/window fields the handle UI (nav dock, [ ]
 * teleport, cut bands) is built from.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario }
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

/** 1Q definer + a committed clip of exactly `nQ` on its own track.
 * Stop requests land MID-Q (a stop exactly ON a boundary pads a whole
 * extra Q — nextStopBoundary), then advance across the boundary so
 * the take commits before any edit (the mid-take gate refuses edits
 * under a live take). */
async function setup(nQ) {
    loadScenario('empty');
    const t1 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', t1);
    advanceBy(1000);
    await callNative('stopRecordingInNode', t1);
    const c2 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', c2);
    advanceBy(nQ * 1000 - 200);
    await callNative('stopRecordingInNode', c2);
    advanceBy(600);   // cross the boundary: commit at exactly nQ
    assert.equal(nodeById(c2).isRecording, false, 'take committed');
    assert.equal(nodeById(c2).duration, nQ * 1000, `committed at ${nQ}Q`);
    return { t1, c2 };
}

test('setSegments refuses an incoherent period, keeps the old map', async () => {
    const { c2 } = await setup(3);
    // A 1.5Q period (neither multiple nor divisor of Q=1000): refused.
    await callNative('setSegments', c2, [0, 1000, 2000, 2500]);
    assert.equal(nodeById(c2).segments, undefined,
        'incoherent map must not land');
    // The same shape with a whole 2Q period: lands. (The published
    // state carries segments FLAT — protocol form.)
    await callNative('setSegments', c2, [0, 1000, 2000, 3000]);
    assert.deepEqual(nodeById(c2).segments, [0, 1000, 2000, 3000],
        'coherent map lands');
});

test('setLoopPoints: divisor windows are first-class, others refused', async () => {
    const { c2 } = await setup(4);
    // Q/2 window: lcm(Q, Q/2) = Q — allowed (SUBDIVISIONS parity).
    await callNative('setLoopPoints', c2, 0, 500);
    assert.equal(nodeById(c2).loopEnd, 500, 'Q/2 window allowed');
    // 1.5Q window: refused, previous window survives.
    await callNative('setLoopPoints', c2, 0, 1500);
    assert.equal(nodeById(c2).loopEnd, 500,
        '1.5Q window refused — previous stands');
    // Whole-multiple window: allowed.
    await callNative('setLoopPoints', c2, 0, 2000);
    assert.equal(nodeById(c2).loopEnd, 2000, '2Q window allowed');
});

test('Q13 sole definer may re-trim FREELY (the edit re-defines Q)', async () => {
    loadScenario('empty');
    const t1 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', t1);
    advanceBy(1000);
    await callNative('stopRecordingInNode', t1);
    // Sole committed clip: a fractional window is a Q re-definition,
    // not an incoherence — the exception the guard carves out.
    await callNative('setLoopPoints', t1, 0, 650);
    assert.equal(nodeById(t1).loopEnd, 650, 'free definer trim lands');
    assert.equal(getState().quantum, 650, 'Q re-established to 0.65 old-Q');
});

/* ---------- the fractal surface (I5): groups ---------- */

async function groupSetup() {
    loadScenario('empty');
    const t1 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', t1);
    advanceBy(1000);
    await callNative('stopRecordingInNode', t1);
    const g = await callNative('createNode', 'stack');
    const c = await callNative('createNode', 'clip', g);
    await callNative('startRecordingInNode', c);
    advanceBy(4000 - 200);   // stop mid-Q (see setup)
    await callNative('stopRecordingInNode', c);
    advanceBy(600);          // cross the boundary: commit at exactly 4Q
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
    // identical shape to a clip lane's (bandState reads these).
    assert.deepEqual(lane.bandSegs, [[0, 1], [2, 3]],
        'group lane carries the cut geometry in Q');
    assert.equal(lane.bandTotalQ, 4, 'over its intrinsic period');
    assert.equal(lane.bandEditable, true, 'editable in place');

    // Single-window form: the group grows bracket geometry, same as a
    // clip's window — the dock's outer ticks and ⇤ ⇥ jumps feed here.
    await callNative('setSegments', g, [1000, 3000]);
    const vm2 = deriveViewModel(getState());
    const lane2 = vm2.lanes.find(l => l.id === g);
    assert.ok(lane2.window && lane2.window.startQ === 1 &&
        lane2.window.endQ === 3,
        'group single-window brackets present for the dock/teleport');
});
