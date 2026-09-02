/**
 * Takes and comping, the UI half (docs/takes.md §6):
 *  - clip lanes carry takes / activeTake / comp / compCells / compMode
 *    (view state, opts.compMode); group lanes carry none of it; a
 *    windowed lane in comp mode opens its raw inspector;
 *  - the ● verb (armMode): a committed clip is armable as a RETAKE, an
 *    empty one records, a live one stops, a one-shot has no slot top;
 *    the group aggregate records empties first, else new-takes its
 *    committed direct clips;
 *  - a retaking lane (opts.retakes) keeps its tiles, silent, and runs
 *    its bar from the slot top;
 *  - the comp model: the cell cycle rule a click applies, the all-−1
 *    normalization, and the per-take tint mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, isArmable, armMode } from '../view_model.js';
import { cycleCell, cycleComp, compCellTints, takeHue, compBadge,
         TAKE_PALETTE } from '../comp_model.js';
import { SCENE_Q as Q, clip, stack, state } from './helpers.mjs';

const laneOf = (vm, id) => vm.lanes.find(l => l.id === id);

test('clip lanes carry the take facts; groups nothing; compMode is view state', () => {
    const c = clip(4, { takes: 3, activeTake: 1, comp: [0, -1, 2, -1] });
    const bare = clip(2);
    const g = stack([clip(2)]);
    let vm = deriveViewModel(state([c, bare, g]));
    const lane = laneOf(vm, c.id);
    assert.equal(lane.takes, 3);
    assert.equal(lane.activeTake, 1);
    assert.deepEqual(lane.comp, [0, -1, 2, -1]);
    assert.equal(lane.compCells, 4, 'cells = ceil(period / Q)');
    assert.equal(lane.compMode, false);
    // Absent keys (hand-built scenes, pre-takes states) = one take, no comp.
    const b = laneOf(vm, bare.id);
    assert.equal(b.takes, 1);
    assert.equal(b.activeTake, 0);
    assert.deepEqual(b.comp, []);
    assert.equal(b.compCells, 2);
    const grp = laneOf(vm, g.id);
    assert.equal('takes' in grp, false, 'group lanes show nothing new');
    assert.equal('comp' in grp, false);

    vm = deriveViewModel(state([c, bare, g]), { compMode: new Set([c.id]) });
    assert.equal(laneOf(vm, c.id).compMode, true);
    assert.equal(laneOf(vm, bare.id).compMode, false);
});

test('comp mode on a windowed lane opens its raw inspector (cells live on the slot period)', () => {
    const w = clip(4, { loopStart: 0, loopEnd: 2 * Q, windowActive: true });
    let lane = laneOf(deriveViewModel(state([w, clip(4)])), w.id);
    assert.ok(lane.windowChipQ > 0, 'the heard view at rest');
    assert.ok(!lane.windowEditing);
    lane = laneOf(deriveViewModel(state([w, clip(4)]),
        { compMode: new Set([w.id]) }), w.id);
    assert.equal(lane.windowEditing, true, 'comp mode expands the lane');
    assert.equal(lane.compMode, true);
    assert.equal(lane.compCells, 4);
});

test('armMode: stop / record / retake / one-shot; a committed clip is armable as a retake', () => {
    assert.equal(armMode(clip(4)), 'retake');
    assert.equal(isArmable(clip(4)), true, 'content ⟹ new take (docs/takes.md §2)');
    assert.equal(armMode(clip(0)), 'record');
    assert.equal(isArmable(clip(0)), true);
    assert.equal(armMode(clip(0, { isPendingStart: true })), 'stop');
    assert.equal(armMode(clip(4, { isRecording: true })), 'stop');
    assert.equal(armMode(clip(4, { periodSource: 'context' })), null,
        'a one-shot\'s slot top is never heard: refused');
    assert.equal(isArmable(clip(4, { periodSource: 'context' })), false);

    // Two committed clips: neither is the provisional Q-definer (whose
    // trim view has no ● verb).
    const vm = deriveViewModel(state([clip(4, { name: 'full' }), clip(2),
                                      clip(0, { name: 'empty' })]));
    const by = Object.fromEntries(vm.lanes.map(l => [l.name, l]));
    assert.equal(by.full.armMode, 'retake');
    assert.equal(by.full.armable, true);
    assert.equal(by.empty.armMode, 'record');
});

test('group ●: empties record first (Q7); all full ⟹ new take of the committed direct clips', () => {
    const mixed = stack([clip(4), clip(0), clip(0)], { name: 'mixed' });
    let g = laneOf(deriveViewModel(state([mixed])), mixed.id);
    assert.deepEqual(g.groupArm, { state: 'none', armable: 2, mode: 'record' });

    // Every track full: the DIRECT clips retake as one performance; a
    // nested group's clips are its own ● (newTake takes direct children).
    const full = stack([clip(4), clip(2), stack([clip(4)])], { name: 'full' });
    g = laneOf(deriveViewModel(state([full])), full.id);
    assert.deepEqual(g.groupArm, { state: 'none', armable: 2, mode: 'retake' });

    // A group of committed one-shots has nothing to take.
    const shots = stack([clip(4, { periodSource: 'context' })], { name: 'shots' });
    g = laneOf(deriveViewModel(state([shots, clip(4)])), shots.id);
    assert.deepEqual(g.groupArm, { state: 'none', armable: 0, mode: 'none' });

    // During a group retake the direct clips are hot: the aggregate is
    // the live-take one (● = stop).
    const live = stack([clip(4, { isRecording: true }), clip(4, { isRecording: true })]);
    g = laneOf(deriveViewModel(state([live, clip(4)]), { retakes: new Set() }), live.id);
    assert.deepEqual(g.groupArm, { state: 'all', armable: 2, mode: 'record' });
});

test('a retaking lane keeps its tiles silent; its bar runs from the slot top', () => {
    const slot = clip(2, { isRecording: true, takes: 1, activeTake: 0 });
    const scene = () => state([clip(4), slot]);
    // Without the inference the lane is a plain recording lane.
    let lane = laneOf(deriveViewModel(scene()), slot.id);
    assert.equal(lane.retake, false);
    assert.deepEqual(lane.reps, []);

    lane = laneOf(deriveViewModel(scene(), { retakes: new Set([slot.id]) }), slot.id);
    assert.equal(lane.retake, true);
    assert.ok(lane.reps.length > 0, 'the resting tiles stay');
    assert.ok(lane.reps.every(r => r.silent), '…silent');
    assert.equal(lane.pendingStart, false);
    assert.ok(lane.recordingLengthQ >= 0 && lane.recordingLengthQ < 2,
        'the captured length is the distance from the slot top, < one period');
    assert.equal(lane.takes, 1, 'the take facts ride the recording lane');

    // Pending: no bar yet; the arm marker waits for the slot's next top.
    slot.isPendingStart = true;
    const vm = deriveViewModel(scene(), { retakes: new Set([slot.id]) });
    lane = laneOf(vm, slot.id);
    assert.equal(lane.pendingStart, true);
    assert.equal(lane.recordingLengthQ, 0);
    assert.ok(lane.armAtQ > vm.playheadQ, 'the slot top ahead of now');
    assert.ok(lane.armAtQ - vm.playheadQ <= 2 + 1e-9, 'within one period');
});

test('the cell cycle rule: −1 → 0 → … → n−1 → −1', () => {
    assert.equal(cycleCell(-1, 3), 0);
    assert.equal(cycleCell(0, 3), 1);
    assert.equal(cycleCell(1, 3), 2);
    assert.equal(cycleCell(2, 3), -1);
    assert.equal(cycleCell(-1, 1), 0, 'one take: the only one, then active');
    assert.equal(cycleCell(0, 1), -1);
});

test('a click commits the whole cell array; all-active normalizes to [] (no comp)', () => {
    assert.deepEqual(cycleComp([], 4, 2, 3), [-1, -1, 0, -1], 'no comp: absent cells are −1');
    assert.deepEqual(cycleComp([-1, -1, 0, -1], 4, 2, 3), [-1, -1, 1, -1]);
    assert.deepEqual(cycleComp([-1, -1, 2, -1], 4, 2, 3), [], 'back to the active take: cleared');
    assert.deepEqual(cycleComp([0, -1], 2, 1, 2), [0, 0]);
    assert.deepEqual(cycleComp([0], 2, 1, 2), [0, 0], 'a short comp widens to the cell count');
    assert.deepEqual(cycleComp([0, 0], 2, 7, 2), [0, 0], 'an out-of-range cell is a no-op');
});

test('the tint mapping: cells naming another take carry that take\'s hue', () => {
    const tints = compCellTints([0, -1, 1, 1], 4, 1);
    assert.deepEqual(tints[0], { take: 0, hue: takeHue(0) });
    assert.equal(tints[1], null, '−1 = the active take: no tint');
    assert.equal(tints[2], null, 'naming the active take explicitly: no tint');
    assert.equal(tints[3], null);
    assert.deepEqual(compCellTints([], 3, 0), [null, null, null]);
    // Distinct hues across the palette, wrapping past it.
    const hues = new Set(TAKE_PALETTE.map((_, k) => takeHue(k)));
    assert.equal(hues.size, TAKE_PALETTE.length);
    assert.equal(takeHue(TAKE_PALETTE.length), takeHue(0));
    assert.equal(compBadge(-1), '·');
    assert.equal(compBadge(2), 'T3');
});
