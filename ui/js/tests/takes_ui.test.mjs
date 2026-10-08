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

test('a retaking lane reads the SLOT\'s length off the engine\'s shape too ' +
     '(duration = the live captured length; periodQ = the slot)', () => {
    // The engine publishes the LIVE captured length on `duration` while
    // a new take captures (AudioNode::getMetadata) and the slot's own on
    // `periodQ`; a state that keeps `duration` the slot's and carries no
    // `periodQ` (a fixture, an older engine — the mock itself until
    // 2026-10-01; called "mock" below) must draw the same picture: the
    // slot's resting tiles, silent, at the slot's period — never
    // re-tiled at the captured length (engine probe 2026-10-01: thirty
    // 0.26Q tiles a quarter Q into a new take of a 4Q slot), the bar
    // measured from the slot top. (The mock's own published state runs
    // through the view in takes_mock.test.mjs (h).)
    const base = { isRecording: true, takes: 2, activeTake: 1,
                   comp: [0, -1, 0, -1] };
    const id = 'retaking-slot';
    // An 8Q loop beside the 4Q slot (both from 0): an 8Q frame. The new
    // take began at the slot's top 20Q into the clock and has captured
    // `capturedQ` of its 4Q period.
    const picture = (slot, capturedQ) => {
        const vm = deriveViewModel(state([clip(8), slot], {
            quantum: Q, islandZero: 0, definerId: '',
            islandPos: Math.round((20 + capturedQ) * Q),
        }), { retakes: new Set([slot.id]) });
        const lane = laneOf(vm, slot.id);
        return { retake: lane.retake, reps: lane.reps, intrinsicQ: lane.intrinsicQ,
                 recordingLengthQ: lane.recordingLengthQ, pendingStart: lane.pendingStart,
                 compCells: lane.compCells, takeStartQ: lane.takeStartQ,
                 cycleQ: vm.cycleQ, playheadQ: vm.playheadQ, frameZero: vm.frameZero };
    };
    for (const capturedQ of [0, 0.012, 0.26, 1.76, 3.76]) {
        const mock = picture(clip(4, { ...base, id }), capturedQ);
        assert.equal(mock.retake, true);
        assert.equal(mock.cycleQ, 8, 'the frame holds');
        assert.equal(mock.intrinsicQ, 4);
        assert.equal(mock.compCells, 4);
        assert.deepEqual(mock.reps.map(r => [r.startQ, r.endQ, !!r.silent]),
            [[0, 4, true], [4, 8, true]], 'two silent tiles of the 4Q slot in the 8Q frame');
        assert.ok(Math.abs(mock.recordingLengthQ - capturedQ) < 1e-6,
            `the bar runs from the slot top: ${mock.recordingLengthQ} ≈ ${capturedQ}`);
        const engine = picture(clip(capturedQ, { ...base, id, periodQ: { num: 4, den: 1 } }),
                               capturedQ);
        assert.deepEqual(engine, mock, `engine shape, ${capturedQ}Q captured`);
    }
    // A fractional slot (a divisor of Q) reads through num/den.
    const half = picture(clip(0.1, { ...base, id, comp: [], periodQ: { num: 1, den: 2 } }), 0.1);
    assert.equal(half.intrinsicQ, 0.5);
    // No `periodQ` and nothing captured yet (an engine that publishes
    // none): a plain pending lane, as before.
    const bare = picture(clip(0, { ...base, id }), 0);
    assert.equal(bare.retake, false);
    assert.equal(bare.pendingStart, true);
});

test('a new take of the loop that alone makes the frame keeps the frame — ' +
     'nothing grows (view_model settledForFrame)', () => {
    // A 1Q loop and a 4Q slot: the slot alone makes the frame 4Q. Read
    // as a fresh take it left the cycle and drove the growing frame —
    // the engine's shape collapsed the frame to 1Q and regrew it 2Q,
    // 3Q, 4Q; the mock's read 5Q (engine probe 2026-10-01).
    const id = 'the-4q-slot';
    const frame = (slot, capturedQ, opts = { retakes: new Set([id]) }) => {
        const vm = deriveViewModel(state([clip(1), slot], {
            quantum: Q, islandZero: 0, definerId: '',
            islandPos: Math.round((20 + capturedQ) * Q),
        }), opts);
        return { cycleQ: vm.cycleQ, lcmQ: vm.lcmQ, loopCycleQ: vm.loopCycleQ,
                 frameExtended: vm.frameExtended, playheadQ: +vm.playheadQ.toFixed(6),
                 locked: vm.mapEditsLocked };
    };
    for (const capturedQ of [0, 0.012, 0.26, 1.2, 2.5, 3.76]) {
        const want = { cycleQ: 4, lcmQ: 4, loopCycleQ: 4, frameExtended: false,
                       playheadQ: +capturedQ.toFixed(6), locked: true };
        assert.deepEqual(frame(clip(4, { id, isRecording: true }), capturedQ), want,
            `mock shape, ${capturedQ}Q in`);
        assert.deepEqual(frame(clip(capturedQ, { id, isRecording: true,
            periodQ: { num: 4, den: 1 } }), capturedQ), want,
            `engine shape, ${capturedQ}Q in`);
    }
    // Armed and waiting for its top: the engine's shape (pending alone,
    // the slot's length standing), and recording AND pending.
    assert.equal(frame(clip(4, { id, isPendingStart: true,
        periodQ: { num: 4, den: 1 } }), 0).cycleQ, 4);
    assert.equal(frame(clip(4, { id, isRecording: true, isPendingStart: true }), 0).cycleQ, 4);
    // A FRESH take (not in `retakes`) still grows the frame as it runs.
    const fresh = frame(clip(1.2, { id, isRecording: true }), 1.2, {});
    assert.equal(fresh.lcmQ, 1, 'a fresh take has no settled period');
    assert.equal(fresh.frameExtended, true);
    assert.equal(fresh.cycleQ, 2, 'the frame holds the growing take');
});

test('a GROUP whose mics take a new take keeps its lane: the slot\'s period, ' +
     'one tile — never re-tiled at Q', () => {
    // A 1Q loop and a 4Q kit of two mics (one take). ● on the group is a
    // new take of both. Its own lane read the mics AS PUBLISHED: on the
    // engine's shape a capturing mic's `duration` is the live captured
    // length, the kit's inner cycle read Q, and the group lane re-tiled
    // as four 1Q tiles for as long as the take ran (audit 2026-10-01).
    const mics = ['mic-1', 'mic-2'];
    const lane = (members, capturedQ, opts = { retakes: new Set(mics) }) => {
        const vm = deriveViewModel(state([clip(1),
            stack(members, { id: 'kit', anchored: true, origin: 0 })], {
            quantum: Q, islandZero: 0, definerId: '',
            islandPos: Math.round((20 + capturedQ) * Q),
        }), opts);
        const g = laneOf(vm, 'kit');
        return { cycleQ: vm.cycleQ, periodQ: g.periodQ, intrinsicQ: g.intrinsicQ,
                 reps: g.reps.map(r => [r.startQ, r.endQ, !!r.ghost]) };
    };
    const rest = lane(mics.map(id => clip(4, { id })), 0, {});
    assert.deepEqual(rest, { cycleQ: 4, periodQ: 4, intrinsicQ: 4,
                             reps: [[0, 4, false]] });
    for (const capturedQ of [0, 0.3, 2.5, 3.9]) {
        assert.deepEqual(lane(mics.map(id => clip(capturedQ, { id, isRecording: true,
            periodQ: { num: 4, den: 1 } })), capturedQ), rest,
            `engine shape, ${capturedQ}Q captured`);
        assert.deepEqual(lane(mics.map(id => clip(4, { id, isRecording: true })),
            capturedQ), rest, `slot kept on duration, ${capturedQ}Q captured`);
    }
    // Armed (the engine: pending alone): as at rest.
    assert.deepEqual(lane(mics.map(id => clip(4, { id, isPendingStart: true,
        periodQ: { num: 4, den: 1 } })), 0), rest);
    // A FRESH group take is no slot: the kit has no settled period yet.
    const fresh = lane(mics.map(id => clip(1.2, { id, isRecording: true })), 1.2, {});
    assert.notDeepEqual(fresh, rest);
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
