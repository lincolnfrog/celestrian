/**
 * View Model tests (docs/session_view.md §5 phase 1).
 *
 * Everything asserts in Q units — the model's contract is that no pixel
 * exists below the patch layer. Includes the executable I2/I8 check:
 * every lane's reps tile the SAME cycle frame exactly (no gaps, no
 * overlaps, no out-of-frame values), and the model carries exactly one
 * playhead.
 *
 * Scenes use a masterPos well past t=0 (sustained playback), and a
 * quantum that is not the mock's rate, so absolute, cycle-relative and
 * Q-relative values never coincide by accident.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, unrollReps, windowDragTarget } from '../view_model.js';
import { SCENE_Q as Q, clip, stack, state, assertTilesCycle, makeLcg, near }
    from './helpers.mjs';

const groupLane = vm => vm.lanes.find(l => l.kind === 'group');

test('recording.md island: 1Q + 4Q + 3Q → cycle 12Q, correct rep counts, one playhead in frame (I8)', () => {
    const vm = deriveViewModel(state([clip(1), clip(4), clip(3)]));
    assert.equal(vm.cycleQ, 12);
    assert.equal(vm.quantum, Q);
    const [d, b, k] = vm.lanes;
    assert.equal(d.reps.length, 12);
    assert.equal(b.reps.length, 3);
    assert.equal(k.reps.length, 4);
    assert.equal(d.reps.filter(r => r.ghost).length, 11);
    vm.lanes.forEach(l => assertTilesCycle(l, vm.cycleQ));
    // Deep into playback: (25·12 + 5.25) mod 12.
    assert.equal(vm.playheadQ, 5.25);
    assert.ok(vm.playheadQ >= 0 && vm.playheadQ < vm.cycleQ);
});

test('arm target is the next Q boundary (Q11), wrapping at the cycle top', () => {
    const s = state([clip(1), clip(4), clip(3)]);
    assert.equal(deriveViewModel(s).armAtQ, 6); // playhead 5.25 → 6

    s.masterPos = 11.6 * Q; // final Q of the cycle
    assert.equal(deriveViewModel(s).armAtQ, 12); // ≡ 0 (↺): top is just the next boundary

    s.masterPos = 7 * Q; // exactly on a boundary: next means NEXT
    assert.equal(deriveViewModel(s).armAtQ, 8);
});

/* TAKE MARKING. A take's bright tile marks where it was PERFORMED: the
 * phase within the cycle is kept, whole cycles fold away (a 2Q loop
 * sounds at 0 AND at 2Q — the tile says which was played). A committed
 * take carries `contextCycle`, its heard frame, so its heard phase
 * survives a frame that grows later. A take from before the zero has no
 * performed position in this frame: its first full repetition.
 * Rows: the scene; per lane the take tile — [startQ, endQ], a bare
 * startQ, or null (unchecked); `tiles`, the lanes that must tile the
 * cycle exactly (I2). */
const Z = 100 * Q;  // a nonzero island zero
const TAKE_MARKS = [
    { name: 'a 1Q take performed at heard 2Q of a 4Q cycle',
      nodes: [clip(4), clip(1, { origin: 2 * Q })],
      cycleQ: 4, takes: [null, [2, 3]], tiles: [1] },
    { name: 'a 4Q loop performed 2Q in keeps its grid ≡ 2 (mod 4): its head wraps',
      nodes: [clip(4), clip(4, { origin: 2 * Q })], takes: [null, 2],
      more: vm => assert.equal(vm.lanes[1].reps[0].ghost, true, 'wrapped head [0, 2)') },
    { name: 'a 2Q take performed at heard 2Q, two cycles past a nonzero zero, marks at 2Q, not 0',
      nodes: [clip(1, { origin: 0 }),                     // from before the zero
              clip(4, { origin: Z }),                     // the zero's own take
              clip(2, { origin: Z + (2 * 4 + 2) * Q })],
      extra: { islandZero: Z }, cycleQ: 4, takes: [0, 0, [2, 4]], tiles: 'all',
      more: vm => assert.equal(vm.lanes[2].reps.find(r => r.ghost).startQ, 0,
          'ghost fills 0–2Q') },
    // 1Q, 4Q, 2Q performed at heard 2Q, then 5Q performed at a heard
    // cycle TOP three cycles later: the frame grows to 20Q. The 4Q clip
    // — the first loop longer than Q — places the frame at its top
    // (1Q); every later loop slots in where it falls. Clip 3 stays at
    // [2, 4) though its origin now precedes the zero; clip 4 sits at
    // its performed top, 12Q into the frame.
    { name: 'heard phases survive a polyrhythmic frame explosion',
      nodes: [clip(1, { origin: 0 }),
              clip(4, { origin: 1 * Q, contextCycle: 1 * Q }),
              clip(2, { origin: 7 * Q, contextCycle: 4 * Q }),
              clip(5, { origin: 13 * Q, contextCycle: 4 * Q })],
      extra: { islandZero: 13 * Q, masterPos: 5.5 * Q },
      cycleQ: 20, takes: [0, 0, [2, 4], [12, 17]], tiles: 'all',
      more: vm => {
          assert.equal(vm.frameZero, 1 * Q, 'the 4Q clip places the frame');
          // takeStartQ: the lane's content-frame origin — window
          // brackets and dims anchor here.
          assert.equal(vm.lanes[2].takeStartQ, 2);
          assert.equal(vm.lanes[3].takeStartQ, 12);
          assert.equal(vm.lanes[0].takeStartQ, 0);
      } },
    // A 1Q loop + a 4Q take recorded from absolute 3Q: the view seats
    // the take at its own top (docs/frame.md) — the 1Q loop constrains
    // nothing. The tile draws the whole take from its top (a raw tile's
    // mapping: raw_tile_mapping.test.mjs).
    { name: 'a take recorded 3Q in is ONE solid tile, not 3Q of ghost',
      nodes: [clip(1, { origin: 0 }), clip(4, { origin: 3 * Q })],
      extra: { origin: 0, islandZero: 3 * Q, masterPos: 1.1 * Q }, cycleQ: 4, takes: [],
      more: vm => assert.deepEqual(vm.lanes[1].reps,
          [{ startQ: 0, endQ: 4, ghost: false, wrapped: false,
             srcSegs: [[0, 1]], srcTopFrac: 0 }]) },
    // masterPos arrives as the engine's zero-corrected VIEW.
    { name: 'tile origins are zero-relative under a nonzero island zero',
      nodes: [clip(4, { origin: 300000 }), clip(4, { origin: 300000 + 2 * Q })],
      extra: { origin: 300000, masterPos: 1.5 * Q }, takes: [null, 2],
      more: vm => assert.equal(vm.playheadQ, 1.5) },
];
for (const { name, nodes, extra, cycleQ, takes, tiles = [], more } of TAKE_MARKS) {
    test(`take marking: ${name}`, () => {
        const vm = deriveViewModel(state(nodes, extra));
        if (cycleQ) assert.equal(vm.cycleQ, cycleQ);
        takes.forEach((want, i) => {
            if (want === null) return;
            const take = vm.lanes[i].reps.find(r => !r.ghost);
            assert.equal(take.startQ, [].concat(want)[0], `lane ${i}: the take tile starts`);
            if (Array.isArray(want)) assert.equal(take.endQ, want[1], `lane ${i}: …and ends`);
        });
        vm.lanes.forEach((l, i) => {
            if (tiles === 'all' || tiles.includes(i)) assertTilesCycle(l, vm.cycleQ);
        });
        if (more) more(vm);
    });
}

/* ---------- THE WINDOW LANE ----------
 * An ACTIVE window is the part: the lane's period, the frame and the
 * audible loop follow it; the lane rests in the HEARD view (tiles carry
 * the window's slice — no brackets, no second cursor) and the chip
 * reads the part's length. BYPASSED, the raw take returns with its
 * brackets. A full-span window is no window. */
const win = (aQ, bQ, extra = {}) =>
    ({ loopStart: aQ * Q, loopEnd: bQ * Q, windowActive: true, loopBypassed: false, ...extra });
const bypassed = (aQ, bQ, extra = {}) =>
    ({ loopStart: aQ * Q, loopEnd: bQ * Q, windowActive: false, loopBypassed: true, ...extra });
/** The bracket descriptor of a one-segment window, bypassed. */
const bypassedBrackets = (aQ, bQ) => ({
    startQ: aQ, endQ: bQ, bypassed: true, active: false, suspended: false,
    segs: [[aQ, bQ]], periodQ: bQ - aQ, multi: false,
});

test('HEARD VIEW: a windowed lane shows what sounds; comp mode shows the raw take; a bypass the raw ghosts', () => {
    // The window's CONTENT is the lane's material, tiled where it
    // audibly sounds (period = window length, anchored at origin +
    // start).
    const scene = window => state([clip(4),
        clip(2, { origin: 2 * Q, contextCycle: 4 * Q, ...window })]);
    const vm = deriveViewModel(scene(win(1, 2)));
    assert.equal(vm.cycleQ, 4);
    const lane = vm.lanes[1];
    assert.equal(lane.periodQ, 1, 'displayed period = window length');
    assert.equal(lane.reps.length, 4, 'window content tiles the frame');
    // Reps carry the content SLICES (srcSegs) plus the phase rotation
    // (srcTopFrac): tiles sit on the frame grid, no wrap slivers.
    assert.ok(lane.reps.every(r => r.srcSegs && r.srcSegs.length === 1 &&
        r.srcSegs[0][0] === 0.5 && r.srcSegs[0][1] === 1),
        'every tile draws the window SEGMENT (second half of the take)');
    assert.ok(lane.reps.every(r => r.srcTopFrac === 0),
        'window at a period-aligned phase: no rotation');
    assert.equal(lane.window, null, 'no brackets at rest');
    assert.equal(lane.windowChipQ, 1, 'the chip reads the part length');
    assertTilesCycle(lane, vm.cycleQ);

    // COMP MODE, the raw-lane view: the lane expands to its full raw
    // duration on its own scale, with the selection brackets.
    const editState = scene(win(1, 2));
    const editing = deriveViewModel(editState,
        { compMode: new Set([editState.nodes[1].id]) }).lanes[1];
    assert.equal(editing.windowEditing, true, 'lane enters the raw view');
    assert.equal(editing.frameQ, 2, 'per-lane scale = the full take');
    assert.deepEqual([editing.window.startQ, editing.window.endQ], [1, 2],
        'brackets select over the raw material');

    // Bypassed window: plain raw-take ghosts return (nothing baked, I9)
    const byp = deriveViewModel(scene(bypassed(1, 2))).lanes[1];
    assert.ok(byp.reps.every(r => !r.echo), 'bypassed: no echoes');
    assert.equal(byp.reps.filter(r => r.ghost).length, 1, 'raw ghost at [0,2)');
});

/* One row per window state × lane kind: the nodes, the lane under test
 * (an index, or the first group), the frame's facts and the lane's. */
const WINDOW_LANES = [
    { name: 'a windowed clip collapses to its audible loop — the frame IS that loop',
      nodes: [clip(4, win(1, 2, { playhead: 0.25 })), clip(1)], lane: 0,
      frame: { cycleQ: 1 }, fields: { window: null, periodQ: 1, windowPhase: 0 } },
    { name: 'a windowed group has no second cursor',
      nodes: [stack([clip(2)], win(0, 1, { playhead: 0.75 }))],
      fields: { windowPhase: 0 } },
    { name: '…nor does a bypassed one',
      nodes: [stack([clip(2)], bypassed(0, 1, { playhead: 0.75 }))],
      fields: { windowPhase: 0 } },
    // Two DIFFERENT children: a sole committed clip — or one group take
    // — is the Q13 provisional definer, whose trim view frames the raw
    // buffer by design.
    { name: 'a lone 2Q stack windowed to 1Q IS a 1Q part: frame and audible loop',
      nodes: [stack([clip(2), clip(1)], win(0, 1))], extra: { masterPos: 0.5 * Q },
      frame: { cycleQ: 1, loopCycleQ: 1 }, fields: { periodQ: 1 } },
    { name: '…bypassed, it is its raw length again and the brackets stay',
      nodes: [stack([clip(2), clip(1)], bypassed(0, 1))],
      frame: { cycleQ: 2, loopCycleQ: 2 }, fields: { window: bypassedBrackets(0, 1) } },
    { name: 'beside a 4Q clip a 2Q window folds in: LCM(4Q, 2Q), frame and loop alike',
      nodes: [clip(4), stack([clip(2), clip(3)], win(0, 2))],
      frame: { cycleQ: 4, loopCycleQ: 4 }, fields: {} },
    { name: 'a windowed group inside a group shortens the parent\'s cycle too (fractal)',
      nodes: [stack([stack([clip(2), clip(3)], win(0, 2)), clip(4)])],
      frame: { cycleQ: 4 }, fields: { periodQ: 4 } },
    // Commit sets loopEnd = duration on every clip; [0, period)
    // restricts nothing and draws no brackets.
    { name: 'a full-span window on a clip is a no-op and is not shown',
      nodes: [clip(4, { loopStart: 0, loopEnd: 4 * Q }), clip(1)], lane: 0,
      fields: { window: null, periodQ: 4 } },
    { name: 'a full-span ACTIVE window on a stack is equally a no-op',
      nodes: [clip(4), stack([clip(2), clip(3)], win(0, 6))],
      frame: { cycleQ: 12 }, fields: { window: null, periodQ: 6 } },
    { name: 'a BYPASSED window on a clip changes nothing about the cycle',
      nodes: [clip(4), clip(3, bypassed(1, 2))], lane: 1,
      frame: { cycleQ: 12 }, fields: { periodQ: 3, window: bypassedBrackets(1, 2) } },
    // "A windowed composite behaves as a 2Q clip in its parent's LCM" is
    // the engine's fact AND the display's. The lane's extent is its
    // material (the window); the grips edit over the raw inner cycle.
    { name: 'a window SETS THE PART\'S LENGTH: the group\'s period, chip and frame follow it',
      nodes: [clip(4), stack([clip(2), clip(3)], win(2, 4))],
      frame: { cycleQ: 4 },
      fields: { periodQ: 2, window: null, windowChipQ: 2, intrinsicQ: 2, bandTotalQ: 6,
                bandSegs: [[2, 4]] },
      more: (vm, g) => {
          assert.deepEqual(g.reps.map(r => [r.startQ, r.endQ, r.ghost]),
              [[0, 2, false], [2, 4, true]], 'window content tiled at its period');
          assert.deepEqual(g.reps[0].srcSegs, [[2 / 6, 4 / 6]],
              'every tile draws the window slice of the composite');
          assert.equal(vm.lanes[0].intrinsicQ, 4, 'a clip\'s intrinsic period is its duration');
      } },
    { name: '…bypassed, the group\'s extent is its inner cycle',
      nodes: [clip(4), stack([clip(2), clip(3)], bypassed(2, 4))],
      fields: { intrinsicQ: 6 } },
];
for (const { name, nodes, extra, lane, frame = {}, fields, more } of WINDOW_LANES) {
    test(`window lane: ${name}`, () => {
        const vm = deriveViewModel(state(nodes, extra));
        const l = lane === undefined ? groupLane(vm) : vm.lanes[lane];
        for (const [k, want] of Object.entries(frame)) assert.equal(vm[k], want, `vm.${k}`);
        for (const [k, want] of Object.entries(fields)) assert.deepEqual(l[k], want, `lane.${k}`);
        if (more) more(vm, l);
    });
}

test('nested group: composite period = children LCM; fold hides children', () => {
    const grp = stack([clip(2), clip(3)], { name: 'Perc' });
    const vm = deriveViewModel(state([clip(4), grp]));
    assert.equal(vm.cycleQ, 12); // LCM(4, 6)
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.periodQ, 6);
    assert.equal(g.reps.length, 2);
    // 4Q clip, group, 2 children, + the add-track affordance row
    assert.equal(vm.lanes.length, 5);
    assert.deepEqual(vm.lanes.map(l => l.kind), ['clip', 'group', 'clip', 'clip', 'add']);
    assert.deepEqual(vm.lanes.map(l => l.depth), [0, 0, 1, 1, 1]);
    assert.equal(vm.lanes[4].groupId, grp.id);

    // Fold is UI-local (I6b): the app shell's folded set, not a node
    // field — the state is untouched.
    const folded = deriveViewModel(state([clip(4), grp]),
                                   { folded: new Set([grp.id]) });
    assert.equal(folded.lanes.length, 2); // folded: no children, no add row
    assert.equal(folded.lanes[1].folded, true);
    // The VM's share of I6b: folding changes lane visibility only —
    // cycle and geometry are identical.
    assert.equal(folded.cycleQ, vm.cycleQ);
    assert.deepEqual(folded.lanes[1].reps, g.reps);
});

test('windowDragTarget: Q-snap, clamps, and the 1Q minimum', () => {
    const win = { startQ: 1, endQ: 4, maxQ: 6 };
    // Nearest-Q snapping on both edges
    assert.deepEqual(windowDragTarget({ edge: 'start', rawQ: 2.4, ...win }),
        { startQ: 2, endQ: 4 });
    assert.deepEqual(windowDragTarget({ edge: 'end', rawQ: 4.6, ...win }),
        { startQ: 1, endQ: 5 });
    // Clamped to the lane: start never below 0, end never past maxQ
    assert.deepEqual(windowDragTarget({ edge: 'start', rawQ: -3, ...win }),
        { startQ: 0, endQ: 4 });
    assert.deepEqual(windowDragTarget({ edge: 'end', rawQ: 99, ...win }),
        { startQ: 1, endQ: 6 });
    // Windows keep at least 1Q: edges cannot cross or collapse
    assert.deepEqual(windowDragTarget({ edge: 'start', rawQ: 5.9, ...win }),
        { startQ: 3, endQ: 4 });
    assert.deepEqual(windowDragTarget({ edge: 'end', rawQ: 0, ...win }),
        { startQ: 1, endQ: 2 });
});

test('effects: fx rows from view state, fxCount on lanes', () => {
    // Chain shape (docs/vst3.md phase 2): {chain: [{slot, type, ...}]}
    const effects = {
        chain: [
            { slot: 's-eq', type: 'eq', enabled: true, low: 3, mid: 0, high: 0 },
            { slot: 's-comp', type: 'compressor', enabled: false, threshold: -18, ratio: 4, attack: 10, release: 100, makeup: 0 },
            { slot: 's-echo', type: 'echo', enabled: true, time: 0.35, feedback: 0.35, mix: 0.35 },
            { slot: 's-verb', type: 'reverb', enabled: false, size: 0.5, damp: 0.5, mix: 0.3 },
        ],
    };
    const c = clip(2, { effects });
    // No fxOpen: no synthetic rows, but the chip count rides the lane
    const closed = deriveViewModel(state([c, clip(1)]));
    assert.equal(closed.lanes[0].fxCount, 2);
    assert.ok(!closed.lanes.some(l => l.kind === 'fx'));

    // fxOpen: the panel row follows its owner lane, effects passthrough
    const open = deriveViewModel(state([c, clip(1)]), { fxOpen: new Set([c.id]) });
    assert.equal(open.lanes[1].kind, 'fx');
    assert.equal(open.lanes[1].ownerId, c.id);
    assert.equal(open.lanes[1].effects.chain.find(s => s.type === 'echo').mix, 0.35);
    assert.equal(open.lanes[2].kind, 'clip'); // the 1Q lane, un-shifted
});

test('clip lanes carry inputChannel; unset reads as −1 (device default)', () => {
    const vm = deriveViewModel(state([clip(1, { inputChannel: 2 }), clip(4)]));
    assert.equal(vm.lanes[0].inputChannel, 2);
    assert.equal(vm.lanes[1].inputChannel, -1);
    // Groups have no input of their own (Q7: children record from theirs)
    const vm2 = deriveViewModel(state([stack([clip(1)])]));
    const g = vm2.lanes.find(l => l.kind === 'group');
    assert.equal(g.inputChannel, undefined);
});

// masterPos CONTRACT (AudioEngine::getGraphState): the state's masterPos
// is the DERIVED DISPLAY POSITION — wrapped when idle, growing linearly
// past the LCM while recording. Tests pass view values, as the engine
// (and the mirroring mock) publish them.

test('GROWING FRAME is PHASE-PRESERVING: no rotation for mid-cycle takes', () => {
    // 4Q song; recording started at 2Q (a mid-cycle Q boundary), the
    // take has grown 5.5Q — the clock is at 7.5Q (past the cycle). The
    // raw clock rides islandPos (measured from the root's frame, 0 here).
    const rec = clip(0, { isRecording: true, duration: 5.5 * Q, name: 'take',
                          origin: 2 * Q });
    const vm = deriveViewModel(state([clip(4), rec],
                                     { masterPos: 7.5 * Q, islandPos: 7.5 * Q }));

    assert.equal(vm.lcmQ, 4);            // the committed cycle is untouched (I4)
    // The take seats in the cycle it started in (docs/frame.md): its
    // start 2Q is inside cycle 0. The frame extends to hold the cursor;
    // nothing rotates.
    assert.equal(vm.cycleQ, 8);
    assert.equal(vm.frameExtended, true);
    assert.equal(vm.playheadQ, 7.5);     // never re-wrapped
    const lane = vm.lanes.find(l => l.recording);
    assert.equal(lane.recordingLengthQ, 5.5); // bar = [2, 7.5] in this frame
    // The committed 4Q lane's tiles stay PUT — phase never rotates
    const committed = vm.lanes.find(l => !l.recording);
    assert.deepEqual(committed.reps.map(r => [r.startQ, r.endQ]), [[0, 4], [4, 8]]);
    assert.equal(committed.reps.filter(r => !r.ghost).length, 1);

    // A take starting cycles deep seats by WHOLE cycles: a start at 9Q in
    // a 4Q song is 2 whole cycles on, so its bar lands at its in-cycle
    // phase 1Q and the 4Q lane reads exactly as before.
    const deep = clip(0, { isRecording: true, duration: 0.5 * Q, origin: 9 * Q });
    const vm2 = deriveViewModel(state([clip(4), deep],
                                      { masterPos: 9.5 * Q, islandPos: 9.5 * Q }));
    assert.equal(vm2.playheadQ, 1.5); // 9.5 − 8
    assert.equal(vm2.cycleQ, 4);
    const committed2 = vm2.lanes.find(l => !l.recording);
    assert.deepEqual(committed2.reps.map(r => [r.startQ, r.endQ]), [[0, 4]]);
});

/* THE FRAME UNDER A TAKE. [what, the committed loop (Q), the take
 * ({lenQ, isAwaitingStop}), masterPos (Q), the frame's facts, the take
 * lane's facts]. Armed and waiting (length 0) the frame stays settled
 * and the cursor wraps. Recording, the frame extends AT the boundary —
 * the take is never off-screen, the cursor never past the frame's edge.
 * Once a stop is requested the commit boundary is KNOWN: the frame
 * settles there at once and the cursor clamps to it (no stretch, then
 * snap, at commit). A recording lane never changes the cycle (I4). */
const TAKE_FRAMES = [
    ['armed, waiting for its boundary: the frame stays settled, the cursor wraps',
     4, { lenQ: 0 }, 4.3, { cycleQ: 4, frameExtended: false, playheadQ: 0.3 }, {}],
    ['a pending start (armed, length 0) is flagged, not a zero-length bar',
     4, { lenQ: 0 }, 2.5, {}, { pendingStart: true, recordingLengthQ: 0 }],
    ['a take that is writing is no pending start',
     4, { lenQ: 0.5 }, 2.5, {}, { pendingStart: false }],
    ['the recording lane is excluded from the cycle and exposes its growing length',
     4, { lenQ: 2.5 }, 2.5, { cycleQ: 4, lcmQ: 4 },
     { recording: true, recordingLengthQ: 2.5, reps: [] }],
    ['short of the boundary the frame holds', 1, { lenQ: 0.95 }, 0.95, { cycleQ: 1 }, {}],
    ['crossed, it extends at once', 1, { lenQ: 1.05 }, 1.05, { cycleQ: 2 }, {}],
    ['…and at every boundary after', 1, { lenQ: 2.01 }, 2.01, { cycleQ: 3 }, {}],
    ['finishing, the cursor past its 2Q target: the frame HOLDS at 2Q, the cursor clamps',
     1, { lenQ: 1.98, isAwaitingStop: true }, 2.04, { cycleQ: 2, playheadQ: 2 }, {}],
    ['the same overshoot with no stop requested: the frame extends',
     1, { lenQ: 2.04, isAwaitingStop: false }, 2.04, { cycleQ: 3 }, {}],
    ['early in the finishing window the settle equals the ceil: no jump at the stop click',
     1, { lenQ: 1.6, isAwaitingStop: true }, 1.6, { cycleQ: 2 }, {}],
];
for (const [name, loopQ, { lenQ, ...take }, posQ, frame, fields] of TAKE_FRAMES) {
    test(`frame under a take: ${name}`, () => {
        const rec = clip(0, { isRecording: true, duration: lenQ * Q, ...take });
        const vm = deriveViewModel(state([clip(loopQ), rec], { masterPos: posQ * Q }));
        for (const [k, want] of Object.entries(frame)) {
            if (Number.isInteger(want) || typeof want !== 'number') assert.equal(vm[k], want, `vm.${k}`);
            else near(vm[k], want, `vm.${k}`);
        }
        assert.ok(vm.playheadQ <= vm.cycleQ, 'the cursor is never past the frame\'s edge');
        const lane = vm.lanes[1];
        for (const [k, want] of Object.entries(fields)) assert.deepEqual(lane[k], want, `lane.${k}`);
    });
}

test('take anchor snaps to the Q boundary, cancelling latency wobble', () => {
    // Q=131584 @48k, take origin at a clean 3Q, but view start =
    // playhead − duration ≈ 1.0507Q — the 0.05Q is the calibrated 139 ms
    // pre-record compensation baked into the live duration. The anchor
    // snaps to 1Q so the bar sits on the downbeat.
    const Qd = 131584;
    const rec = clip(0, { isRecording: true, duration: 673772, effectiveQuantum: Qd,
                          origin: Qd });
    const committed = clip(0, {
        duration: Qd, effectiveQuantum: Qd, loopEnd: Qd, name: 'loop',
    });
    const vm = deriveViewModel(state([committed, rec],
                                     { masterPos: 812032, islandPos: 812032 }));

    assert.equal(vm.quantum, Qd);
    assert.equal(vm.lcmQ, 1);
    // The take seats at its origin's whole Q (1Q), not at the 1.0507Q
    // its live duration implies: playhead = 6.171 − 1 ≈ 5.17
    assert.ok(Math.abs(vm.playheadQ - 5.1707) < 0.001);
    assert.equal(vm.cycleQ, 6);
    const lane = vm.lanes.find(l => l.recording);
    // Bar [playhead − len, playhead] ≈ [0.05, 5.17]: it TRAILS the
    // playhead by the compensation — truthful monitoring delay
    assert.ok(Math.abs((vm.playheadQ - lane.recordingLengthQ) - 0.0508) < 0.001);
});

test('idle masterPos is trusted but defensively wrapped into the frame', () => {
    // Contract says idle positions arrive pre-wrapped; a violating value
    // must fold into the frame instead of drawing off the timeline
    const vm = deriveViewModel(state([clip(4)], { masterPos: 305.25 * Q }));
    assert.ok(vm.playheadQ >= 0 && vm.playheadQ < vm.cycleQ);
    assert.equal(vm.playheadQ, 1.25); // 305.25 mod 4
});

test('group arm aggregates ARMABLE (empty) descendants: none/some/all (Q7)', () => {
    // A fresh drum kit: five empty tracks awaiting their first take
    const kit = ['Kick', 'Snare', 'HatL', 'HatR', 'OH'].map(name => clip(0, { name }));
    const drums = stack(kit, { name: 'Drums' });
    // Keep the island's cycle established by a content lane
    const scene = () => state([clip(4), drums]);

    let g = deriveViewModel(scene()).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'none', armable: 5, mode: 'record' });

    kit[0].isPendingStart = true;
    g = deriveViewModel(scene()).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'some', armable: 5, mode: 'record' });

    kit.forEach(c => { c.isPendingStart = true; });
    const vm = deriveViewModel(scene());
    g = vm.lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'all', armable: 5, mode: 'record' });
    vm.lanes.filter(l => l.kind === 'clip' && l.depth === 1)
        .forEach(l => assert.equal(l.armed, true));
});

test('arm targets emptiness: the group records its empty clips; content clips retake (Q7 + takes)', () => {
    // Snare and Kick already have takes; three tracks still empty
    const kit = [
        clip(4, { name: 'Kick' }), clip(4, { name: 'Snare' }),
        clip(0, { name: 'HatL' }), clip(0, { name: 'HatR' }), clip(0, { name: 'OH' }),
    ];
    const drums = stack(kit, { name: 'Drums' });

    // "Arm the stack" = arm only the empty clips (engine behavior);
    // the VM must report full arm over the 3 empty ones
    kit.filter(c => !(c.duration > 0)).forEach(c => { c.isPendingStart = true; });
    const vm = deriveViewModel(state([drums]));
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'all', armable: 3, mode: 'record' });

    const byName = Object.fromEntries(vm.lanes.map(l => [l.name, l]));
    // Content clips just play under the group arm; their own ● is a
    // NEW TAKE (docs/takes.md §2).
    assert.equal(byName.Kick.armMode, 'retake');
    assert.equal(byName.Kick.armable, true);
    assert.equal(byName.Snare.armMode, 'retake');
    assert.equal(byName.Kick.armed, false);
    assert.equal(byName.HatL.armMode, 'stop');   // armed: ● stops it
    assert.equal(byName.HatL.armable, true);
    assert.equal(byName.HatL.armed, true);

    // Nothing empty at all → the group ● is a new take of every
    // committed direct clip (one performance)
    kit.forEach(c => { c.isPendingStart = false; c.duration = 4 * Q; });
    const g2 = deriveViewModel(state([drums])).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g2.groupArm, { state: 'none', armable: 5, mode: 'retake' });
});

test('FIRST TAKE frame: no Q yet → the growing take is the timeline', () => {
    // A brand-new session: one empty stack, one clip recording its first
    // take. No node declares a quantum (Q is established on commit).
    const rec = clip(0, {
        isRecording: true, duration: 2.5 * Q, effectiveQuantum: 0, name: 'first',
    });
    const grp = stack([rec], { effectiveQuantum: 0 });
    const vm = deriveViewModel(state([grp], {
        masterPos: 2.5 * Q, perf: { sampleRate: Q }, // Q = 1 s for clean math
    }));

    assert.equal(vm.qEstablished, false);
    assert.equal(vm.ruler.ticks.length, 0); // no fake Q grid before Q exists
    // The frame grows in WHOLE-SECOND steps (4s minimum): constant px
    // scale between steps — a continuously growing frame rescaled the
    // waveform every poll ("stuttery" first take)
    assert.equal(vm.cycleQ, 4 * Q); // 2.5s take → still the 4s floor
    assert.equal(vm.playheadQ, 2.5 * Q);
    const lane = vm.lanes.find(l => l.recording);
    assert.equal(lane.recordingLengthQ, 2.5 * Q);

    const longer = deriveViewModel(state([grp], {
        masterPos: 4.5 * Q, perf: { sampleRate: Q },
    }, ));
    // (duration still 2.5s in the node — frame steps track the RECORDING)
    assert.equal(longer.cycleQ, 4 * Q);

    // Q established afterwards: the grid returns
    const committed = deriveViewModel(state([clip(4)]));
    assert.equal(committed.qEstablished, true);
    assert.equal(committed.ruler.ticks.length, 5);
});

test('solo and mute pass through (Q16: per-node additive flags)', () => {
    const a = clip(4, { isSoloed: true }),
        b = clip(3, { isMuted: true, isSoloed: true });
    const vm = deriveViewModel(state([a, b]));
    assert.equal(vm.lanes[0].soloed, true);
    assert.equal(vm.lanes[1].soloed, true); // additive — both lit at once
    assert.equal(vm.lanes[1].muted, true);
});

test('I2/I8 property: random scenes — every lane tiles one shared frame', () => {
    const rnd = makeLcg(0xC0FFEE);
    for (let i = 0; i < 200; i++) {
        const periods = [1, 2, 3, 4, 6];
        const laneCount = 1 + Math.floor(rnd() * 4);
        const nodes = [];
        for (let l = 0; l < laneCount; l++) {
            const p = periods[Math.floor(rnd() * periods.length)];
            nodes.push(clip(p, { origin: Math.floor(rnd() * p * 4) * Q }));
        }
        const s = state(nodes, { masterPos: Math.floor(rnd() * 1e7) });
        const vm = deriveViewModel(s);

        assert.ok(vm.playheadQ >= 0 && vm.playheadQ < vm.cycleQ, 'playhead in frame');
        assert.equal(vm.armAtQ, Math.floor(vm.playheadQ) + 1, 'arm = next boundary');
        vm.lanes.forEach(lane => assertTilesCycle(lane, vm.cycleQ));
        // No pixels below the patch layer: the VM must not carry px fields
        vm.lanes.forEach(lane =>
            ['x', 'y', 'w', 'h', 'px', 'widthPx'].forEach(k =>
                assert.ok(!(k in lane), `no pixel field ${k}`)));
    }
});

test('unrollReps: main tile is the first full tile, grid wraps exactly', () => {
    const reps = unrollReps({ periodQ: 3, offsetQ: 7, cycleQ: 12 }); // grid ≡ 1 (mod 3)
    assert.deepEqual(reps.map(r => [r.startQ, r.endQ, r.ghost, r.wrapped]), [
        [0, 1, true, true],    // tail of the wrapped predecessor
        [1, 4, false, false],  // the main tile: first full repetition
        [4, 7, true, false],
        [7, 10, true, false],
        [10, 12, true, true],  // clipped at the cycle end
    ]);
});

test('unrollReps: a sliver of float noise at a frame edge is no tile', () => {
    // A period one ulp short of the frame: one whole tile, nothing after.
    assert.deepEqual(
        unrollReps({ periodQ: 3.9999999999999996, offsetQ: 0, cycleQ: 4, takeQ: 0 })
            .map(r => [r.startQ, r.endQ, r.ghost, r.wrapped]),
        [[0, 4, false, false]]);
    // A phase a hair past the frame's left edge: two whole tiles that
    // start at 0, abut and end at the cycle — no sliver before them,
    // and neither is a wrap.
    const reps = unrollReps({ periodQ: 2, offsetQ: 1e-12, cycleQ: 4 });
    assert.equal(reps.length, 2);
    assert.equal(reps[0].startQ, 0);
    assert.equal(reps[0].endQ, reps[1].startQ);
    assert.equal(reps[1].endQ, 4);
    assert.deepEqual(reps.map(r => [r.ghost, r.wrapped]),
        [[false, false], [true, false]]);
});

test('a window\'s period is ONE division of its sample length, wherever it starts', () => {
    // A 4Q window slid off the grid by a few samples is still exactly
    // 4Q long: the lane is one whole tile of a 4Q frame.
    const q = 44100;
    const windowed = ls => ({
        id: 'root', quantum: q, islandZero: 0, islandPos: 0, masterPos: 0,
        definerId: '',
        nodes: [
            { id: 'w', type: 'clip', duration: 8 * q, origin: 0, loopStart: ls,
              loopEnd: ls + 4 * q, windowActive: true, loopTop: ls },
            { id: 'x', type: 'clip', duration: 4 * q, origin: 0,
              loopStart: 0, loopEnd: 0, windowActive: false },
        ],
    });
    for (let ls = 1; ls < q; ls += 97) {
        const vm = deriveViewModel(windowed(ls));
        const w = vm.lanes.find(l => l.id === 'w');
        assert.equal(vm.cycleQ, 4, `start ${ls}: the frame`);
        assert.equal(w.periodQ, 4, `start ${ls}: the lane period`);
        assert.equal(w.windowChipQ, 4, `start ${ls}: the chip`);
        assert.equal(w.bandPeriodQ, 4, `start ${ls}: the heard period`);
        assert.deepEqual(w.reps.map(r => [r.startQ, r.endQ, r.ghost]),
            [[0, 4, false]], `start ${ls}: one whole tile`);
    }
});

test('a song\'s length in Q is ONE division of its sample sum', () => {
    // Ten steps of a tenth of a Q: ten float tenths sum short of 1; the
    // sample lengths sum to exactly Q.
    const q = 44100;
    const steps = Array.from({ length: 10 }, (_, i) => ({ name: 's' + i, len: q / 10 }));
    const plain = id => ({ id, type: 'clip', duration: q, origin: 0,
                           loopStart: 0, loopEnd: 0, windowActive: false });
    const vm = deriveViewModel({
        id: 'root', quantum: q, islandZero: 0, islandPos: 0, masterPos: 0,
        definerId: '', nodes: [plain('a'), plain('b')],
        // `a` rests in the last step only.
        sequence: { steps, gates: { a: steps.map((_, i) => i !== 9) } },
    }, { seqOpen: new Set(['root']) });
    const grid = vm.lanes.find(l => l.kind === 'seq');
    assert.equal(grid.totalQ, 1, 'the grid row');
    assert.equal(vm.rootSeq.totalQ, 1, 'the transport chip');
    assert.equal(grid.visits[9].startQ, 0.9, 'each visit starts at its sample bound');
    const dims = vm.lanes.find(l => l.id === 'a').seqDims[0];
    assert.equal(dims.periodQ, 1, 'the lane overlay tiles at the same length');
    assert.deepEqual(dims.offSegsQ, [[0.9, 1]], 'and its spans end on the song\'s end');
});
