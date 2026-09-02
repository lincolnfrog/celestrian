/**
 * View Model tests (docs/ui_overhaul.md §5 phase 1).
 *
 * Everything asserts in Q units — the model's contract is that no pixel
 * exists below the patch layer. Includes the first executable I2/I8
 * check: every lane's reps tile the SAME cycle frame exactly (no gaps,
 * no overlaps, no out-of-frame values), and the model carries exactly
 * one playhead.
 *
 * Coverage lesson from the kernel arc applies here too: scenes use a
 * masterPos well past t=0 (sustained playback) so absolute and
 * cycle-relative values never coincide by accident.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveViewModel, unrollReps, windowDragTarget } from '../view_model.js';
// SCENE_Q (a quantum deliberately ≠ the mock's own rate, so absolute
// and Q-relative values never coincide) + minimal engine-shaped
// builders + the tiling invariant — shared in helpers.mjs (this file
// was their birthplace).
import { SCENE_Q as Q, clip, stack, state, assertTilesCycle, makeLcg }
    from './helpers.mjs';

test('recording.md island: 1Q + 4Q + 3Q → cycle 12Q, correct rep counts', () => {
    const vm = deriveViewModel(state([clip(1), clip(4), clip(3)]));
    assert.equal(vm.cycleQ, 12);
    assert.equal(vm.quantum, Q);
    const [d, b, k] = vm.lanes;
    assert.equal(d.reps.length, 12);
    assert.equal(b.reps.length, 3);
    assert.equal(k.reps.length, 4);
    assert.equal(d.reps.filter(r => r.ghost).length, 11);
    vm.lanes.forEach(l => assertTilesCycle(l, vm.cycleQ));
});

test('one playhead, in-frame, deep into playback (I8)', () => {
    const vm = deriveViewModel(state([clip(1), clip(4), clip(3)]));
    assert.equal(vm.playheadQ, 5.25); // (25·12 + 5.25) mod 12
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

test('take marking: performed PHASE is kept; whole cycles fold away', () => {
    // Owner ruling 2026-07-10 ("it doesn't matter how many times I let
    // clip 1 loop before recording clip 2") + refinement 2026-07-16
    // ("clip 3 recorded at 2Q must anchor 2Q→4Q, not jump to 0Q"):
    // whole CYCLES never matter, but the performed phase WITHIN the
    // cycle does. A take performed at heard 2Q marks its bright tile at
    // 2Q — folding by the clip's own period erased it.
    const vm = deriveViewModel(state([clip(4), clip(1, { origin: 2 * Q })]));
    assert.equal(vm.cycleQ, 4);
    const lane = vm.lanes[1];
    const take = lane.reps.find(r => !r.ghost);
    assert.equal(take.startQ, 2); // where it was performed
    assert.equal(take.endQ, 3);
    assertTilesCycle(lane, 4);

    // A clip whose phase is offset (origin ≢ 0 mod period) keeps its
    // grid: the performed-position tile is the main one, the head wraps
    const shifted = deriveViewModel(
        state([clip(4), clip(4, { origin: 2 * Q })])).lanes[1];
    const t2 = shifted.reps.find(r => !r.ghost);
    assert.equal(t2.startQ, 2); // grid ≡ 2 (mod 4)
    assert.equal(shifted.reps[0].ghost, true); // wrapped head [0,2)
});

test('FIELD 2026-07-16b: heard phases survive a polyrhythmic frame explosion', () => {
    // The 4-clip flow: 1Q, 4Q (epoch definer), 2Q performed at heard 2Q,
    // then 5Q performed at a heard cycle TOP three old cycles later. The
    // frame explodes to 20Q and the engine re-bases the epoch to clip
    // 4's heard top (whole old cycles — phase-neutral). Each committed
    // take carries `contextCycle` (its heard frame): the bright tile
    // marks at the heard PHASE — clip 4 at [0,5), clip 3 STILL at
    // [2,4) even though its rel is now negative.
    const E = 13 * Q; // epoch after clip 4's commit (= clip 4's origin)
    const vm = deriveViewModel(state([
        clip(1, { origin: 0 }),                          // pre-epoch, ctx 0
        clip(4, { origin: 1 * Q, contextCycle: 1 * Q }), // rel −12
        clip(2, { origin: 7 * Q, contextCycle: 4 * Q }), // rel −6, heard 2Q
        clip(5, { origin: 13 * Q, contextCycle: 4 * Q }),// rel 0, heard top
    ], { islandEpoch: E, masterPos: 5.5 * Q }));
    assert.equal(vm.cycleQ, 20);
    const [c1, c2, c3, c4] = vm.lanes;

    const take4 = c4.reps.find(r => !r.ghost);
    assert.equal(take4.startQ, 0, 'clip 4 reads from the top it was performed at');
    assert.equal(take4.endQ, 5);

    const take3 = c3.reps.find(r => !r.ghost);
    assert.equal(take3.startQ, 2, 'clip 3 keeps its heard 2Q anchor (rel −6, ctx 4)');
    assert.equal(take3.endQ, 4);

    assert.equal(c2.reps.find(r => !r.ghost).startQ, 0,
        'clip 2 (heard frame 1Q) marks at the top');
    assert.equal(c1.reps.find(r => !r.ghost).startQ, 0,
        'pre-epoch, no ctx: first full repetition');
    vm.lanes.forEach(l => assertTilesCycle(l, vm.cycleQ));

    // takeStartQ: the lane's content-frame origin — window brackets/dims
    // anchor here (field 2026-07-16c: they drew a phase off otherwise)
    assert.equal(c3.takeStartQ, 2);
    assert.equal(c4.takeStartQ, 0);
    assert.equal(c1.takeStartQ, 0);
});

test('HEARD VIEW (law 13 amended): a windowed lane shows what sounds', () => {
    // 2026-07-19k: the window's CONTENT is the lane's material, tiled
    // where it audibly sounds (period = window length, anchored at
    // origin + start). Every tile carries the segment src; no brackets
    // in the resting view (the edit view holds the raw take).
    const vm = deriveViewModel(state([
        clip(4),
        clip(2, {
            origin: 2 * Q, contextCycle: 4 * Q,
            loopStart: 1 * Q, loopEnd: 2 * Q,
            windowActive: true, loopBypassed: false,
        }),
    ]));
    assert.equal(vm.cycleQ, 4);
    const lane = vm.lanes[1];
    assert.equal(lane.periodQ, 1, 'displayed period = window length');
    assert.equal(lane.reps.length, 4, 'window content tiles the frame');
    // Phase 3 (2026-07-23c): reps carry the content SLICES (srcSegs)
    // plus the phase rotation (srcTopFrac) — tiles sit on the frame
    // grid, phase baked as rotation, no wrap slivers.
    assert.ok(lane.reps.every(r => r.srcSegs && r.srcSegs.length === 1 &&
        r.srcSegs[0][0] === 0.5 && r.srcSegs[0][1] === 1),
        'every tile draws the window SEGMENT (second half of the take)');
    assert.ok(lane.reps.every(r => r.srcTopFrac === 0),
        'window at a period-aligned phase: no rotation');
    assert.equal(lane.window, null, 'no brackets at rest');
    assert.equal(lane.windowChipQ, 1, 'the chip advertises the edit view');
    assertTilesCycle(lane, vm.cycleQ);

    // EDIT VIEW: the lane expands to its full raw duration on its own
    // scale, with the selection brackets — the seed track's trim view.
    const editState = state([
        clip(4),
        clip(2, {
            origin: 2 * Q, contextCycle: 4 * Q,
            loopStart: 1 * Q, loopEnd: 2 * Q,
            windowActive: true, loopBypassed: false,
        }),
    ]);
    const editId = editState.nodes[1].id;
    const vmE = deriveViewModel(editState, { windowEdit: new Set([editId]) });
    const editing = vmE.lanes[1];
    assert.equal(editing.windowEditing, true, 'lane enters the edit view');
    assert.equal(editing.frameQ, 2, 'per-lane scale = the full take');
    assert.deepEqual([editing.window.startQ, editing.window.endQ], [1, 2],
        'brackets select over the raw material');

    // Bypassed window: plain raw-take ghosts return (nothing baked, I9)
    const byp = deriveViewModel(state([
        clip(4),
        clip(2, {
            origin: 2 * Q, contextCycle: 4 * Q,
            loopStart: 1 * Q, loopEnd: 2 * Q,
            windowActive: false, loopBypassed: true,
        }),
    ])).lanes[1];
    assert.ok(byp.reps.every(r => !r.echo), 'bypassed: no echoes');
    assert.equal(byp.reps.filter(r => r.ghost).length, 1, 'raw ghost at [0,2)');
});

test('FIELD 2026-07-16: a 2Q take performed at heard 2Q marks at 2Q, not 0', () => {
    // The report: 1Q clip, 4Q clip, then a 2Q take armed just before the
    // heard 2Q — it displayed at 2Q while recording, then JUMPED to
    // 0Q–2Q at commit (its origin mod its own 2Q period is 0). The audio
    // is identical either way (a 2Q loop sounds at 0 AND 2Q); the take
    // tile must mark where it was PERFORMED.
    const E = 100 * Q; // nonzero epoch (re-based to clip 2's origin)
    const vm = deriveViewModel(state([
        clip(1, { origin: 0 }),                    // pre-epoch take
        clip(4, { origin: E }),                    // the epoch definer
        clip(2, { origin: E + (2 * 4 + 2) * Q }),  // heard 2Q, 2 cycles later
    ], { islandEpoch: E }));
    assert.equal(vm.cycleQ, 4);
    const [c1, c2, c3] = vm.lanes;

    const take3 = c3.reps.find(r => !r.ghost);
    assert.equal(take3.startQ, 2, 'take drawn where it was performed (2Q)');
    assert.equal(take3.endQ, 4);
    assert.equal(c3.reps.find(r => r.ghost).startQ, 0, 'ghost fills 0–2Q');

    // Whole-cycle counts still fold away (the 2 extra cycles above)
    assert.equal(c2.reps.find(r => !r.ghost).startQ, 0);
    // Pre-epoch takes have no honest performed position in this frame:
    // first full repetition (the 2026-07-10 behavior survives for them)
    assert.equal(c1.reps.find(r => !r.ghost).startQ, 0);
    vm.lanes.forEach(l => assertTilesCycle(l, vm.cycleQ));
});

test('epoch re-base: the take is ONE solid tile, not 3Q of ghost (field bug)', () => {
    // Screenshot 2026-07-09: 1Q loop + a 4Q take recorded from absolute
    // 3Q. Commit re-based the island epoch to 3Q (simple extension), but
    // the root node's `origin` stays 0 — the epoch must come from the
    // published islandEpoch, or the 4Q take marks as [0,3) ghost + [3,4) take.
    const s = state(
        [clip(1, { origin: 0 }), clip(4, { origin: 3 * Q })],
        { origin: 0, islandEpoch: 3 * Q, masterPos: 1.1 * Q },
    );
    const vm = deriveViewModel(s);
    assert.equal(vm.cycleQ, 4);
    const lane4Q = vm.lanes[1];
    // One tile, whole take, solid — anchored at the re-based cycle top
    assert.deepEqual(lane4Q.reps, [{ startQ: 0, endQ: 4, ghost: false, wrapped: false }]);
});

test('nonzero island epoch: tile origins are epoch-relative', () => {
    // Island re-based: epoch at 300000 samples; clip origin 2Q after
    // epoch. masterPos arrives as the engine's epoch-corrected VIEW.
    const epoch = 300000;
    const s = state(
        [clip(4, { origin: epoch }), clip(4, { origin: epoch + 2 * Q })],
        { origin: epoch, masterPos: 1.5 * Q },
    );
    const vm = deriveViewModel(s);
    assert.equal(vm.playheadQ, 1.5);
    // The phase-shifted 4Q clip's grid runs ≡ 2 (mod 4) — epoch-relative
    const take = vm.lanes[1].reps.find(r => !r.ghost);
    assert.equal(take.startQ, 2);
});

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

test('a window SETS THE PART\'S LENGTH: group period and frame follow it (2026-08-21)', () => {
    // E-C ("a windowed composite behaves as a 2Q clip in its parent's
    // LCM") is the engine's fact AND the display's (owner ruling
    // 2026-08-21, reversing 2026-07-11): the group lane's period is
    // the window, the frame is the audible cycle, and the lane shows
    // the HEARD view — no brackets, the chip reads the part length.
    const grp = stack([clip(2), clip(3)], {
        loopStart: 2 * Q, loopEnd: 4 * Q, windowActive: true,
    });
    const vm = deriveViewModel(state([clip(4), grp]));
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.equal(g.periodQ, 2);           // the window IS the part
    assert.equal(vm.cycleQ, 4);           // LCM(4Q, 2Q) — the audible cycle
    assert.equal(g.window, null);         // heard view: no brackets
    assert.equal(g.windowChipQ, 2);       // the chip reads the part length
    assert.equal(g.bandTotalQ, 6);        // the grips edit over the inner cycle
    assert.deepEqual(g.bandSegs, [[2, 4]]);
    assert.deepEqual(g.reps.map(r => [r.startQ, r.endQ, r.ghost]),
        [[0, 2, false], [2, 4, true]], 'window content tiled at its period');
    assert.deepEqual(g.reps[0].srcSegs, [[2 / 6, 4 / 6]],
        'every tile draws the window slice of the composite');
});

test('a window reframes the timeline honestly (reverses field bug 2026-07-11)', () => {
    // A lone 2Q stack windowed to 1Q IS a 1Q part: the frame follows
    // (the engine wraps the transport there) and the lane shows the
    // heard 1Q — the raw 2Q is one grab away (the edit view), which is
    // what the 2026-07-11 "hidden content" concern actually needed.
    // (Two DIFFERENT children: a sole committed clip — or one group
    // take, same origin + duration — is the Q13 provisional definer,
    // whose trim view frames the raw buffer by design.)
    const active = stack([clip(2), clip(1)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: true,
    });
    const vmA = deriveViewModel(state([active]));
    assert.equal(vmA.cycleQ, 1);
    assert.equal(vmA.lanes.find(l => l.kind === 'group').periodQ, 1);
    // The edit view frames the raw inner cycle on its own scale.
    const vmE = deriveViewModel(state([active]),
        { windowEdit: new Set([active.id]) });
    const gE = vmE.lanes.find(l => l.kind === 'group');
    assert.equal(gE.windowEditing, true);
    assert.equal(gE.frameQ, 2);
    assert.deepEqual([gE.window.startQ, gE.window.endQ], [0, 1]);

    const bypassed = stack([clip(2), clip(1)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: false, loopBypassed: true,
    });
    const vmB = deriveViewModel(state([bypassed]));
    assert.equal(vmB.cycleQ, 2); // bypass: the part is its raw length again
    assert.deepEqual([vmB.lanes[0].window.startQ, vmB.lanes[0].window.endQ,
        vmB.lanes[0].window.bypassed], [0, 1, true], 'bypassed brackets stay');
});

test('a default full-span window is a no-op and is not shown', () => {
    // Commit sets loopEnd = duration on every clip; [0, period) restricts
    // nothing and must not render brackets (it reads as misalignment)
    const c = clip(4, { loopStart: 0, loopEnd: 4 * Q });
    const vm = deriveViewModel(state([c, clip(1)]));
    assert.equal(vm.lanes[0].window, null);
    assert.equal(vm.lanes[0].periodQ, 4);

    // A full-span ACTIVE window on a stack is equally a no-op
    const grp = stack([clip(2), clip(3)], {
        loopStart: 0, loopEnd: 6 * Q, windowActive: true,
    });
    const vm2 = deriveViewModel(state([clip(4), grp]));
    const g = vm2.lanes.find(l => l.kind === 'group');
    assert.equal(g.window, null);
    assert.equal(g.periodQ, 6);
    assert.equal(vm2.cycleQ, 12);
});

test('intrinsicQ / bandTotalQ: the brackets\' clamp bound rides every lane', () => {
    const grp = stack([clip(2), clip(3)], {
        loopStart: 2 * Q, loopEnd: 4 * Q, windowActive: true,
    });
    const vm = deriveViewModel(state([clip(4), grp]));
    const g = vm.lanes.find(l => l.kind === 'group');
    // Heard view: the lane's extent is its material (the window);
    // the raw inner cycle the grips clamp to rides bandTotalQ.
    assert.equal(g.intrinsicQ, 2);
    assert.equal(g.bandTotalQ, 6);
    // Clips carry it too (their intrinsic period is the duration)
    assert.equal(vm.lanes[0].intrinsicQ, 4);
    // Bypassed: the raw-framed lane, intrinsicQ = the inner cycle.
    const byp = stack([clip(2), clip(3)], {
        loopStart: 2 * Q, loopEnd: 4 * Q, windowActive: false, loopBypassed: true,
    });
    const vmB = deriveViewModel(state([clip(4), byp]));
    assert.equal(vmB.lanes.find(l => l.kind === 'group').intrinsicQ, 6);
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

test('heard view is fractal: a windowed clip collapses to its audible loop', () => {
    // 2026-07-19k (supersedes the intrinsic-period assertion of law 13):
    // the displayed period is the WINDOW length; the window's frame
    // position is an edit fact, not a playback fact — brackets and the
    // amber cursor live in the edit view.
    const c = clip(4, {
        loopStart: 1 * Q, loopEnd: 2 * Q, windowActive: true, playhead: 0.25,
    });
    const vm = deriveViewModel(state([c, clip(1)]));
    const lane = vm.lanes[0];
    assert.equal(lane.window, null, 'no brackets at rest');
    assert.equal(lane.periodQ, 1, 'displayed period = the audible loop');
    assert.equal(lane.windowPhase, 0, 'no second cursor — the white one is honest');
    assert.equal(vm.cycleQ, 1, 'the frame IS the audible loop');
});

test('windowPhase: heard view has no second cursor; the edit view carries it', () => {
    const grp = stack([clip(2)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: true, playhead: 0.75,
    });
    // Heard view (groups as clips, 2026-08-21): the white cursor is
    // honest on the lane — no amber cursor.
    const vmA = deriveViewModel(state([grp]));
    assert.equal(vmA.lanes.find(l => l.kind === 'group').windowPhase, 0);
    // The edit view shows the raw extent, so the amber cursor returns.
    const vmE = deriveViewModel(state([grp]), { windowEdit: new Set([grp.id]) });
    assert.equal(vmE.lanes.find(l => l.kind === 'group').windowPhase, 0.75);

    const bypassed = stack([clip(2)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: false,
        loopBypassed: true, playhead: 0.75,
    });
    const vmB = deriveViewModel(state([bypassed]));
    assert.equal(vmB.lanes.find(l => l.kind === 'group').windowPhase, 0);
});

test('loopCycleQ: the audible cycle IS the frame (windows are part lengths)', () => {
    // Lone 2Q stack windowed to 1Q: the transport wraps at 1Q (the
    // playhead must never sail past the window — field 2026-07-11),
    // and since 2026-08-21 the display frame agrees: one cycle.
    const grp = stack([clip(2), clip(1)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: true,
    });
    const vm = deriveViewModel(state([grp], { masterPos: 0.5 * Q }));
    assert.equal(vm.cycleQ, 1);
    assert.equal(vm.loopCycleQ, 1);

    // Bypassed: back to the raw length, frame and loop alike
    const byp = stack([clip(2), clip(1)], {
        loopStart: 0, loopEnd: 1 * Q, windowActive: false, loopBypassed: true,
    });
    const vmB = deriveViewModel(state([byp]));
    assert.equal(vmB.cycleQ, 2);
    assert.equal(vmB.loopCycleQ, 2);

    // Multi-lane: LCM(4Q clip, 2Q window) = 4Q, frame and loop alike
    const grp2 = stack([clip(2), clip(3)], {
        loopStart: 0, loopEnd: 2 * Q, windowActive: true,
    });
    const vm2 = deriveViewModel(state([clip(4), grp2]));
    assert.equal(vm2.cycleQ, 4);
    assert.equal(vm2.loopCycleQ, 4);

    // NESTED: a windowed group inside a group shortens the parent's
    // inner cycle too (fractal, all the way up).
    const inner = stack([clip(2), clip(3)], {
        loopStart: 0, loopEnd: 2 * Q, windowActive: true,
    });
    const outer = stack([inner, clip(4)]);
    const vm3 = deriveViewModel(state([outer]));
    assert.equal(vm3.lanes.find(l => l.id === outer.id).periodQ, 4);
    assert.equal(vm3.cycleQ, 4);
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
    // 4Q song; recording started at view 2Q (a mid-cycle Q boundary),
    // take has grown 5.5Q — the view cursor is at 7.5Q (past the cycle)
    const rec = clip(0, { isRecording: true, duration: 5.5 * Q, name: 'take' });
    const vm = deriveViewModel(state([clip(4), rec], { masterPos: 7.5 * Q }));

    assert.equal(vm.lcmQ, 4);            // the committed cycle is untouched (I4)
    // Shift is whole CYCLES only: anchor 2Q is inside cycle 0 → shift 0.
    // The frame extends to hold the cursor; nothing rotates.
    assert.equal(vm.cycleQ, 8);
    assert.equal(vm.frameExtended, true);
    assert.equal(vm.playheadQ, 7.5);     // never re-wrapped
    const lane = vm.lanes.find(l => l.recording);
    assert.equal(lane.recordingLengthQ, 5.5); // bar = [2, 7.5] in this frame
    // The committed 4Q lane's tiles stay PUT — phase never rotates
    const committed = vm.lanes.find(l => !l.recording);
    assert.deepEqual(committed.reps.map(r => [r.startQ, r.endQ]), [[0, 4], [4, 8]]);
    assert.equal(committed.reps.filter(r => !r.ghost).length, 1);

    // A take starting cycles deep shifts by WHOLE cycles: anchor 9Q in a
    // 4Q song → shift 8Q, bar lands at its in-cycle phase 1Q
    const deep = clip(0, { isRecording: true, duration: 0.5 * Q });
    const vm2 = deriveViewModel(state([clip(4), deep], { masterPos: 9.5 * Q }));
    assert.equal(vm2.playheadQ, 1.5); // 9.5 − 8
    assert.equal(vm2.cycleQ, 4);
    const committed2 = vm2.lanes.find(l => !l.recording);
    assert.deepEqual(committed2.reps.map(r => [r.startQ, r.endQ]), [[0, 4]]);
});

test('PENDING must not stretch the frame (record-start stretch/squish)', () => {
    // Armed, waiting for the boundary: the unwrapped view crosses the
    // cycle top with duration still 0 — the frame must stay settled and
    // the playhead wraps (old ceil(playhead) stretched +1Q for a beat)
    const pending = clip(0, { isRecording: true, duration: 0 });
    const vm = deriveViewModel(state([clip(4), pending], { masterPos: 4.3 * Q }));
    assert.equal(vm.cycleQ, 4);
    assert.equal(vm.frameExtended, false);
    assert.ok(Math.abs(vm.playheadQ - 0.3) < 1e-9); // wrapped, in frame
});

test('FINISHING settles the frame at the known boundary (no layout snap)', () => {
    // Field before/after 2026-07-10: stop requested at 1.8Q (target 2Q);
    // the cursor ran past 2.0Q during the finishing wait and the frame
    // stretched to 3Q, then snapped back to 2Q at commit. Once stop is
    // requested the commit boundary is KNOWN: the frame settles NOW.
    const mk = (lenQ, viewQ, awaiting) => deriveViewModel(state(
        [clip(1), clip(0, {
            isRecording: true, duration: lenQ * Q, isAwaitingStop: awaiting,
        })],
        { masterPos: viewQ * Q }));

    // Finishing, cursor past the 2Q target: frame HOLDS at 2Q, playhead clamps
    const vm = mk(1.98, 2.04, true);
    assert.equal(vm.cycleQ, 2);
    assert.equal(vm.playheadQ, 2);
    // Same overshoot while actively recording (no stop): frame extends
    assert.equal(mk(2.04, 2.04, false).cycleQ, 3);
    // Early in the finishing window the settle equals the ceil — no
    // discontinuity at the stop click itself
    assert.equal(mk(1.6, 1.6, true).cycleQ, 2);
});

test('frame extends AT the boundary — the take is never off-screen', () => {
    // Delaying extension by the stop hysteresis recorded ~0.15Q blind at
    // every crossing (field regression). Extension is immediate; a stop
    // that hysteresis-snaps back down settles via one animated morph.
    const mk = lenQ => deriveViewModel(state(
        [clip(1), clip(0, { isRecording: true, duration: lenQ * Q })],
        { masterPos: lenQ * Q }));
    assert.equal(mk(0.95).cycleQ, 1);
    assert.equal(mk(1.05).cycleQ, 2); // crossed: extend immediately
    assert.equal(mk(2.01).cycleQ, 3);
    // The playhead is never past the frame edge (nothing to record blind)
    const vm = mk(1.05);
    assert.ok(vm.playheadQ <= vm.cycleQ);
});

test('take anchor snaps to the Q boundary, cancelling latency wobble', () => {
    // Field dump 2026-07-09: Q=131584 @48k, take origin at a clean 3Q,
    // but view start = playhead − duration ≈ 1.0507Q — the 0.05Q is the
    // calibrated 139ms pre-record compensation baked into live duration.
    // The anchor must snap to 1Q so the bar sits on the downbeat.
    const Qd = 131584;
    const rec = clip(0, { isRecording: true, duration: 673772, effectiveQuantum: Qd });
    const committed = clip(0, {
        duration: Qd, effectiveQuantum: Qd, loopEnd: Qd, name: 'loop',
    });
    const vm = deriveViewModel(state([committed, rec], { masterPos: 812032 }));

    assert.equal(vm.quantum, Qd);
    assert.equal(vm.lcmQ, 1);
    // shift snapped to 1Q (not 1.0507): playhead = 6.171 − 1 ≈ 5.17
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

test('pending start (armed, duration 0) is flagged, not a zero-length bar', () => {
    const rec = clip(0, { isRecording: true, duration: 0 });
    const vm = deriveViewModel(state([clip(4), rec], { masterPos: 2.5 * Q }));
    const lane = vm.lanes.find(l => l.recording);
    assert.equal(lane.pendingStart, true);
    assert.equal(lane.recordingLengthQ, 0);

    const writing = clip(0, { isRecording: true, duration: 0.5 * Q });
    const vm2 = deriveViewModel(state([clip(4), writing], { masterPos: 2.5 * Q }));
    assert.equal(vm2.lanes.find(l => l.recording).pendingStart, false);
});

test('a BYPASSED window changes nothing about the cycle', () => {
    const keys = clip(3, { loopStart: 1 * Q, loopEnd: 2 * Q, loopBypassed: true });
    const vm = deriveViewModel(state([clip(4), keys]));
    assert.equal(vm.cycleQ, 12);
    const k = vm.lanes[1];
    assert.equal(k.periodQ, 3);
    // Phase 3: the window descriptor is the map superset (segs/periodQ/
    // multi ride along; single windows carry their one segment).
    assert.deepEqual(k.window, {
        startQ: 1, endQ: 2, bypassed: true, active: false, suspended: false,
        segs: [[1, 2]], periodQ: 1, multi: false,
    });
});

test('group arm aggregates ARMABLE (empty) descendants: none/some/all (Q7)', () => {
    // A fresh drum kit: five empty tracks awaiting their first take
    const kit = ['Kick', 'Snare', 'HatL', 'HatR', 'OH'].map(name => clip(0, { name }));
    const drums = stack(kit, { name: 'Drums' });
    // Keep the island's cycle established by a content lane
    const scene = () => state([clip(4), drums]);

    let g = deriveViewModel(scene()).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'none', armable: 5 });

    kit[0].isPendingStart = true;
    g = deriveViewModel(scene()).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'some', armable: 5 });

    kit.forEach(c => { c.isPendingStart = true; });
    const vm = deriveViewModel(scene());
    g = vm.lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'all', armable: 5 });
    vm.lanes.filter(l => l.kind === 'clip' && l.depth === 1)
        .forEach(l => assert.equal(l.armed, true));
});

test('arm targets emptiness: content clips are not armable (Q7 refinement)', () => {
    // Snare and Kick already have takes; three tracks still empty
    const kit = [
        clip(4, { name: 'Kick' }), clip(4, { name: 'Snare' }),
        clip(0, { name: 'HatL' }), clip(0, { name: 'HatR' }), clip(0, { name: 'OH' }),
    ];
    const drums = stack(kit, { name: 'Drums' });

    // "Arm the stack" = arm only the empty clips (engine behavior);
    // the VM must report full arm over the 3 armable ones
    kit.filter(c => !(c.duration > 0)).forEach(c => { c.isPendingStart = true; });
    const vm = deriveViewModel(state([drums]));
    const g = vm.lanes.find(l => l.kind === 'group');
    assert.deepEqual(g.groupArm, { state: 'all', armable: 3 });

    const byName = Object.fromEntries(vm.lanes.map(l => [l.name, l]));
    assert.equal(byName.Kick.armable, false);   // has content: just plays
    assert.equal(byName.Snare.armable, false);
    assert.equal(byName.Kick.armed, false);
    assert.equal(byName.HatL.armable, true);
    assert.equal(byName.HatL.armed, true);

    // Nothing armable at all → the group-arm control disables
    kit.forEach(c => { c.isPendingStart = false; c.duration = 4 * Q; });
    const g2 = deriveViewModel(state([drums])).lanes.find(l => l.kind === 'group');
    assert.deepEqual(g2.groupArm, { state: 'none', armable: 0 });
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

test('recording lane: excluded from cycle, exposes growing length', () => {
    const rec = clip(0, { isRecording: true, duration: 2.5 * Q, name: 'take' });
    const vm = deriveViewModel(state([clip(4), rec], { masterPos: 2.5 * Q }));
    assert.equal(vm.cycleQ, 4); // recording never changes the LCM (I4)
    assert.equal(vm.lcmQ, 4);
    const r = vm.lanes[1];
    assert.equal(r.recording, true);
    assert.equal(r.recordingLengthQ, 2.5);
    assert.deepEqual(r.reps, []);
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
