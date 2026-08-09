/**
 * TWO-ANCHOR CONTINUITY (owner ruling 2026-08-09): a map edit on a
 * playing clip keeps the sounding sample sounding (origin re-anchor,
 * unless the edit REMOVED that region), while the island epoch rides
 * the SAME whole-Q delta — so the edited clip's frame position (the
 * timeline the user drew) never changes. "There is no such thing as
 * island 3.5 — that is 0.5Q. The master transport is an
 * implementation detail": the fold, not the clip, absorbs the delta.
 *
 * The field repro this pins: record a 3Q clip over a 1Q definer,
 * dblclick the middle Q while the transport plays. Under the old
 * origin-only law the heard lane rotated and the "split handle"
 * rendered at the far LEFT; under brief anchor-stability the audio
 * jumped even though the sounding Q survived the cut. Now: no jump
 * AND the seam mid-lane. C++ twin: time_map_record_tests.cc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceBy, callNative, getState, loadScenario }
    from '../mock_backend.js';
import { deriveViewModel } from '../view_model.js';
import { mapOffset } from '../time_map.js';

function nodeById(id, nodes = getState().nodes) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const found = n.nodes && nodeById(id, n.nodes);
        if (found) return found;
    }
    return null;
}

test('cutting the middle Q of a playing 3Q clip: no audio jump AND ' +
     'the seam renders mid-lane (two-anchor continuity)', async () => {
    loadScenario('empty');

    // Track 1 establishes Q.
    const t1 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', t1);
    advanceBy(1000);
    await callNative('stopRecordingInNode', t1);
    assert.equal(getState().quantum, 1000, 'Q established');

    // Clip 2: a 3Q take.
    const c2 = await callNative('createNode', 'clip');
    await callNative('startRecordingInNode', c2);
    advanceBy(3000);
    await callNative('stopRecordingInNode', c2);

    // The field repro clicked while the transport PLAYED (recording
    // auto-plays) — continuity only applies then.
    await callNative('togglePlayback');
    assert.equal(getState().isPlaying, true);
    advanceBy(1700);   // park mid-cycle, mid-Q — rotation-prone under
                       // the old origin-only law

    const orgBefore = nodeById(c2).origin || 0;
    const epochBefore = getState().islandEpoch || 0;
    const t0 = getState().masterPos || 0;
    // The raw sample sounding at the click (identity map pre-cut).
    const dur = nodeById(c2).duration;
    const p0 = (((t0 - orgBefore) % dur) + dur) % dur;

    // Double-click the middle Q → cut [1Q, 2Q).
    await callNative('setSegments', c2, [0, 1000, 2000, 3000]);
    const orgAfter = nodeById(c2).origin || 0;
    const epochAfter = getState().islandEpoch || 0;

    // LAW, part 1 — audio continuity: the same raw sample sounds at t0
    // through the new map (when the cut kept it; 1700 parks p0 in a
    // kept Q on every fold of this scenario's timing).
    const newMap = { segs: [[0, 1000], [2000, 3000]] };
    const period = 2000;
    if (p0 < 1000 || p0 >= 2000) {   // sounding sample survived
        const hAfter = ((t0 - orgAfter - mapOffset(newMap, 0)) % period
            + period) % period;
        assert.equal(mapOffset(newMap, hAfter), p0,
            'the sounding sample keeps sounding across the cut');
    } else {
        assert.equal(orgAfter, orgBefore,
            'sounding region removed: origin stays put');
    }

    // LAW, part 2 — the epoch rides the same delta: the clip's frame
    // position (org − epoch) is invariant, so the timeline reads
    // exactly as drawn.
    assert.equal(orgAfter - epochAfter, orgBefore - epochBefore,
        'frame position (org − epoch) invariant: the fold absorbs it');
    assert.equal((((orgAfter - orgBefore) % 1000) + 1000) % 1000, 0,
        'the delta is a whole number of Qs (grid untouched)');

    // And the render consequence the user actually sees: the seam
    // (heard 1Q into a 2Q period) lands mid-lane — NOT wrapped onto
    // the frame edge.
    const vm = deriveViewModel(getState());
    const lane = vm.lanes.find(l => l.id === c2);
    assert.equal(lane.takeStartQ, 0, 'heard anchor stays at the top');
    const seamLaneQ = (((lane.takeStartQ + 1) % vm.cycleQ) + vm.cycleQ)
        % vm.cycleQ;
    assert.ok(Math.abs(seamLaneQ - 1) < 1e-9 && vm.cycleQ === 2,
        `seam renders at 1Q of a 2Q frame (mid-lane), got ${seamLaneQ}` +
        `Q of ${vm.cycleQ}Q`);

    // Healing is a map edit too: both anchors move together (or not at
    // all) — frame position stays invariant either way.
    const org2 = nodeById(c2).origin || 0;
    const epoch2 = getState().islandEpoch || 0;
    await callNative('setSegments', c2, []);
    assert.equal((nodeById(c2).origin || 0) - (getState().islandEpoch || 0),
        org2 - epoch2, 'heal: frame position invariant too');
});
