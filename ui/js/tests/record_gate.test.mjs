/**
 * THE RECORDING GATE (docs/time_maps.md §7 "Gates and refusals";
 * vm/lane_common.js bandGate).
 *
 * While any take records — or is armed, waiting for its boundary —
 * every loop region is display-only: the engine refuses every map edit
 * under a live take, so a grip that grabbed would preview geometry
 * that never lands. The gate is global (not per subtree): one fact,
 * `anyTakeActive`, locks every lane. What this pins:
 *   (a) at rest every editable lane is editable and unlocked;
 *   (b) a recording take, or a pending one, sets vm.mapEditsLocked and
 *       turns bandEditable off on EVERY lane — clips, heard windows,
 *       groups with a map, multi-segment maps, lanes nowhere near the
 *       take — with bandLocked marking exactly the lanes whose chrome
 *       would be live (it draws inert, not gone);
 *   (c) the band state every map surface reads (map_core bandState)
 *       says editable false / locked true — the one fact the grips,
 *       seams, bands, the panel, dblclick cuts and ←/→ nudges check;
 *   (d) a lane that is not editable for its own reasons (a 1Q loop)
 *       is never "locked" — the gate adds no chrome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel } from '../view_model.js';
import { bandState } from '../session_view/map_core.js';
import { SCENE_Q as Q, clipAt as clip, windowed, mapped, groupAt, island as scene,
         laneOf } from './helpers.mjs';

/** A 1Q scratch loop, a heard window, a raw 8Q take, a multi-segment
 * map, and a windowed group — plus whatever `extra` nodes. */
const island = (extra = []) => scene([
    clip('A', 0, 1),
    windowed('B', 0, 12, [4, 8]),
    clip('R', 0, 8),
    mapped('M', 0, 8, [[0, 2], [3, 5]]),
    groupAt('G', 0, [clip('g1', 0, 4)], {
        windowActive: true, loopStart: 0, loopEnd: 2 * Q, loopBypassed: false,
        duration: 0 }),
    ...extra,
], { clockQ: 0.3 });
const EDITABLE = ['B', 'R', 'M', 'G'];
const lanesOf = vm => vm.lanes.filter(l => l.kind === 'clip' || l.kind === 'group');

test('at rest: the map lanes are editable, nothing is locked', () => {
    const vm = deriveViewModel(island());
    assert.equal(vm.mapEditsLocked, false);
    for (const id of EDITABLE) {
        const l = laneOf(vm, id);
        assert.equal(l.bandEditable, true, `${id} editable`);
        assert.equal(!!l.bandLocked, false, `${id} not locked`);
    }
    assert.equal(laneOf(vm, 'B').bandHeard, true, 'B is a heard window');
});

for (const [what, take] of [
    ['a recording take', clip('T', 0, 3, { isRecording: true })],
    ['a pending take (armed, waiting for its boundary)',
     clip('T', 0, 0, { isRecording: true, isPendingStart: true })],
    ['a pending retake on a committed slot',
     clip('T', 0, 4, { isPendingStart: true })],
]) {
    test(`${what} locks every loop region`, () => {
        const vm = deriveViewModel(island([take]));
        assert.equal(vm.mapEditsLocked, true, 'the gate is on');
        for (const l of lanesOf(vm)) {
            assert.equal(!!l.bandEditable, false, `${l.id}: not editable`);
        }
        for (const id of EDITABLE) {
            assert.equal(laneOf(vm, id).bandLocked, true,
                `${id}: locked (its chrome draws inert)`);
            const st = bandState(laneOf(vm, id), vm, vm.cycleQ);
            assert.equal(st.editable, false, `${id}: the surfaces read not-editable`);
            assert.equal(st.locked, true, `${id}: …and locked`);
        }
        // The gate adds nothing to a lane that was never editable.
        assert.equal(!!laneOf(vm, 'A').bandLocked, false, '1Q loop: not locked');
        assert.equal(!!laneOf(vm, 'A').bandEditable, false);
    });
}

test('the gate lifts with the take: commit, and every lane is editable again', () => {
    const recording = deriveViewModel(island([clip('T', 0, 3, { isRecording: true })]));
    assert.equal(recording.mapEditsLocked, true);
    const committed = deriveViewModel(island([clip('T', 0, 3)]));
    assert.equal(committed.mapEditsLocked, false);
    for (const id of [...EDITABLE, 'T']) {
        assert.equal(laneOf(committed, id).bandEditable, true, `${id} editable again`);
        assert.equal(!!laneOf(committed, id).bandLocked, false);
    }
});
