/**
 * LOOP REGION EDITS, end to end — the family the owner keeps meeting
 * subtle bugs in. Every edit is followed by the spectral listener's
 * verdict: what sounds == the render law == what the lanes draw.
 *
 *  - a window set, MOVED, bypassed, re-activated and cleared while the
 *    transport plays (audio continuity re-anchors the origin);
 *  - the same edits while STOPPED (the origin stays put);
 *  - the definer's trim (Q13: Q := the window; the second arm
 *    lock-collapses, audio-neutral by FINGERPRINT — the very capture
 *    moments sound at the very phases; delete re-opens; undo);
 *  - undo/redo through a chain of window edits.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, verifyHeard, findNode,
         listenAtTop, expectSameSound, mod, driveToPhase } from './engine_helpers.mjs';
import { deriveViewModel } from '../js/view_model.js';

const Q = 44100;

test('window set, moved, bypassed, re-activated, cleared — playing', async ({ page }) => {
    await openEngine(page);
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await verifyHeard(page);

    await call(page, 'setLoopPoints', c2, Q, 3 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);

    // Move the window while it plays: [2Q, 4Q). Continuity re-anchors
    // the origin (continuityOrigin) — the law reads the new origin.
    await engine(page, 'advance', { samples: 3 * Q + 777 });
    await call(page, 'setLoopPoints', c2, 2 * Q, 4 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);

    // Shrink to [3Q, 4Q): 1Q period.
    await engine(page, 'advance', { samples: Q + 333 });
    await call(page, 'setLoopPoints', c2, 3 * Q, 4 * Q);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);

    // Bypass: the whole take again; re-activate; clear (0, 0 = whole).
    await call(page, 'toggleLoopWindow', c2);
    expect(findNode(await state(page), c2).loopBypassed).toBe(true);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', c2);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);
    await call(page, 'setLoopPoints', c2, 0, 0);
    expect(findNode(await state(page), c2).windowActive).toBe(false);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    // The trap S34 found: bypass, clear, then draw a NEW region — it
    // must sound (a clear drops the stale bypass).
    await call(page, 'setLoopPoints', c2, Q, 3 * Q);
    await call(page, 'toggleLoopWindow', c2);            // bypass
    await call(page, 'setLoopPoints', c2, 0, 0);          // whole
    expect(findNode(await state(page), c2).loopBypassed).toBe(false);
    await call(page, 'setLoopPoints', c2, 2 * Q, 4 * Q);  // a new region
    const n = findNode(await state(page), c2);
    expect(n.windowActive).toBe(true);
    expect(n.loopBypassed).toBe(false);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);
    void c1;
});

test('window edits while STOPPED keep the origin; play resumes in phase', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await engine(page, 'advance', { samples: 2 * Q + 1000 });
    const o0 = findNode(await state(page), c2).origin;
    await call(page, 'togglePlayback');
    expect((await state(page)).isPlaying).toBe(false);
    await call(page, 'setLoopPoints', c2, Q, 2 * Q);
    expect(findNode(await state(page), c2).origin).toBe(o0);
    await call(page, 'setLoopPoints', c2, 2 * Q, 4 * Q);
    expect(findNode(await state(page), c2).origin).toBe(o0);
    await call(page, 'togglePlayback');
    expect((await state(page)).isPlaying).toBe(true);
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', c2);
    await verifyHeard(page);
});

test('the definer trim (Q13): Q := the window; lock-collapse is audio-neutral; delete re-opens; undo', async ({ page }) => {
    await openEngine(page);
    const c1 = await rec(page, 4 * Q);
    expect((await state(page)).quantum).toBe(4 * Q);
    await engine(page, 'advance', { samples: Q / 2 });
    await call(page, 'setLoopPoints', c1, Q, 2 * Q);
    let st = await state(page);
    expect(st.quantum).toBe(Q);
    expect(st.islandZero).toBe(findNode(st, c1).origin + Q);
    expect(findNode(st, c1).duration).toBe(4 * Q);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);
    const before = await listenAtTop(page);

    // Second arm: the trim becomes the take. The buffer is spliced, so
    // content indices change — the FINGERPRINT (capture moments per
    // phase) must not.
    const c2 = await rec(page, Q);
    st = await state(page);
    expect(findNode(st, c1).duration).toBe(Q);
    expect(findNode(st, c1).windowActive).toBe(false);
    expect(st.quantum).toBe(Q);
    const after = await listenAtTop(page);
    expectSameSound(before, after, { ids: [c1], label: 'lock-collapse' });
    await verifyHeard(page);

    // Delete the second take: the definer re-opens with its trim.
    await call(page, 'deleteNode', c2);
    st = await state(page);
    expect(findNode(st, c1).duration).toBe(4 * Q);
    expect(findNode(st, c1).loopStart).toBe(Q);
    expect(findNode(st, c1).loopEnd).toBe(2 * Q);
    expect(findNode(st, c1).windowActive).toBe(true);
    const reopened = await listenAtTop(page);
    expectSameSound(before, reopened, { ids: [c1], label: 're-open' });
    await verifyHeard(page);

    // Undo the delete: collapsed again; undo the take: trimmed again.
    await call(page, 'undo');
    expect(findNode(await state(page), c1).duration).toBe(Q);
    await verifyHeard(page);
});

test('editing one lane\'s loop region never moves the OTHER lanes\' tiles', async ({ page }) => {
    // The subtle one: a window or cut on lane B must not rotate lane A's
    // material on screen. Audio never moves (origins are absolute); the
    // view SEATS the frame from the lanes (docs/frame.md), and a lane
    // before B is never moved by an edit on B — any other move would
    // show as that lane jumping. Pinned here from the user's seat:
    // A's bright tile stays where it was, at every edit, whatever phase
    // the edit lands at (which phases trigger a move depends on where
    // the playhead sits when the edit lands; this test tries several).
    await openEngine(page);
    await rec(page, Q);
    const a = await rec(page, 4 * Q, { atPhase: 2 * Q });
    const b = await rec(page, 4 * Q, { atPhase: 1 * Q });
    const tileOf = async id => {
        const st = await state(page);
        const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
        const lane = vm.lanes.find(l => l.id === id);
        return { takeStartQ: lane.takeStartQ, cycleQ: vm.cycleQ,
                 firstBright: (lane.reps.find(r => !r.ghost) || {}).startQ };
    };
    const a0 = await tileOf(a);
    const edits = [
        [Q + 700, () => call(page, 'setLoopPoints', b, Q, 3 * Q)],
        [2 * Q + 100, () => call(page, 'setLoopPoints', b, 2 * Q, 4 * Q)],
        [3 * Q + 300, () => call(page, 'setSegments', b, [0, Q, 2 * Q, 3 * Q])],
        [500, () => call(page, 'setSegments', b, [Q, 2 * Q, 3 * Q, 4 * Q])],
        [Q + 900, () => call(page, 'toggleLoopWindow', b)],
        [2 * Q + 200, () => call(page, 'setLoopPoints', b, 0, 0)],
    ];
    for (const startPhase of [0, Q + 100, 2 * Q + 100, 3 * Q + 100]) {
        for (const [i, [phase, edit]] of edits.entries()) {
            await driveToPhase(page, mod(startPhase + phase, 4 * Q));
            await engine(page, 'advance', { samples: 100 });
            await edit();
            const a1 = await tileOf(a);
            expect(a1.takeStartQ, `start ${startPhase / Q}Q, edit ${i}: lane A's tile moved`).toBe(a0.takeStartQ);
            expect(a1.firstBright, `start ${startPhase / Q}Q, edit ${i}: lane A's bright tile moved`).toBe(a0.firstBright);
            await verifyHeard(page);
        }
    }
});

test('undo / redo through a chain of window edits', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const cycleAt = async () => (await engine(page, 'status')).cycle;
    await call(page, 'setLoopPoints', c2, 0, 2 * Q);
    await engine(page, 'advance', { samples: Q + 100 });
    await call(page, 'setLoopPoints', c2, 1 * Q, 4 * Q);   // 3Q
    await engine(page, 'advance', { samples: 2 * Q + 100 });
    await call(page, 'toggleLoopWindow', c2);               // bypass
    expect(await cycleAt()).toBe(4 * Q);
    await verifyHeard(page);
    await call(page, 'undo');                               // active [1Q,4Q)
    expect(await cycleAt()).toBe(3 * Q);
    await verifyHeard(page);
    await call(page, 'undo');                               // [0,2Q)
    expect(await cycleAt()).toBe(2 * Q);
    await verifyHeard(page);
    await call(page, 'undo');                               // whole
    expect(await cycleAt()).toBe(4 * Q);
    expect(findNode(await state(page), c2).windowActive).toBe(false);
    await verifyHeard(page);
    await call(page, 'redo');
    expect(await cycleAt()).toBe(2 * Q);
    await verifyHeard(page);
    await call(page, 'redo');
    expect(await cycleAt()).toBe(3 * Q);
    await verifyHeard(page);
    void mod;
});

test('a cancelled drag (cancelGesture) leaves the log as it found it: its step dropped, redo back', async ({ page }) => {
    // Escape mid-drag used to restore by one more commit: a no-op undo
    // step stayed on the stack and the redo branch was gone. The engine
    // cancels the gesture instead (AudioEngine::cancelGesture) — this
    // drives the verb through the real bridge.
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const win = async () => {
        const n = findNode(await state(page), c2);
        return [n.loopStart / Q, n.loopEnd / Q];
    };
    await call(page, 'setLoopPoints', c2, 0, 2 * Q);
    // A redo branch to interrupt: an edit, undone.
    await call(page, 'setLoopPoints', c2, 2 * Q, 4 * Q);
    await call(page, 'undo');
    expect(await win()).toEqual([0, 2]);
    expect((await state(page)).canRedo).toBe(true);
    await verifyHeard(page);
    // THE DRAG: the first commit opens the gesture (redo is invalidated
    // — for now), the live ones coalesce into its one step.
    await call(page, 'setLoopPoints', c2, 1 * Q, 3 * Q);
    expect((await state(page)).canRedo).toBe(false);
    await engine(page, 'advance', { samples: Q / 2 + 77 });
    await call(page, 'setLoopPoints', c2, 2 * Q, 4 * Q, true);
    expect(await win()).toEqual([2, 4]);
    // ESCAPE.
    await call(page, 'cancelGesture', c2);
    expect(await win()).toEqual([0, 2]);
    expect((await state(page)).canRedo).toBe(true);
    await verifyHeard(page);
    // The branch that comes back is the one that was interrupted…
    await call(page, 'redo');
    expect(await win()).toEqual([2, 4]);
    await verifyHeard(page);
    // …and no step is the cancelled drag's: two undos reach the whole
    // take.
    await call(page, 'undo');
    expect(await win()).toEqual([0, 2]);
    await call(page, 'undo');
    expect(findNode(await state(page), c2).windowActive).toBe(false);
    await verifyHeard(page);
});

test('a shaped loop never moves the frame or an untouched lane, even when it owns the cycle', async ({ page }) => {
    // ONE LOOP PLACES THE FRAME (frame.md §1, owner 2026-09-29): the
    // first loop longer than Q — here A, a 2Q loop. Every other loop
    // SLOTS IN where it falls, so shaping B never moves the frame's
    // zero, A, or the play start. B is an 8Q take recorded 1Q into A's
    // cycle, shaped into a 4Q loop that owns the cycle's LENGTH; its
    // origin lands an ODD number of Qs into the frame. Wherever its
    // window starts — an odd number of Qs off the frame, or a whole
    // cycle of A (2Q) — A holds still and B's tile starts where its
    // region start sounds, its offset mod its own 4Q.
    // (Until 2026-09-29 a later loop pulled the zero forward by whole
    // cycles-so-far whenever that was "free" — a start 2Q off moved the
    // frame to B — which read as editing one track moving another.)
    await openEngine(page);
    await rec(page, Q);
    const a = await rec(page, 4 * Q, { atPhase: 0 });
    await call(page, 'setLoopPoints', a, 0, 2 * Q);  // A: a 2Q loop
    const b = await rec(page, 8 * Q, { atPhase: 1 * Q });
    await call(page, 'togglePlayback');  // stopped: no continuity re-anchor
    expect((await state(page)).isPlaying).toBe(false);
    const laneOf = async id => {
        const st = await state(page);
        const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
        const lane = vm.lanes.find(l => l.id === id);
        // The frame zero is the view model's seat (docs/frame.md), not
        // an engine field: the engine publishes origins, the view seats.
        return { takeStartQ: lane.takeStartQ,
                 firstBright: (lane.reps.find(r => !r.ghost) || {}).startQ,
                 zero: vm.frameZero };
    };
    const a0 = await laneOf(a);
    const zero0 = a0.zero;
    const originB = findNode(await state(page), b).origin;
    const inQ = mod(originB - zero0, 4 * Q) / Q;  // B's origin, Qs into the frame
    expect(inQ % 2, 'setup: B lands an odd number of Qs in').toBe(1);
    const odd = 2 * Q;                    // start (inQ + 2) Qs off the frame: odd
    const even = inQ === 1 ? Q : 3 * Q;   // start (inQ + 1 or 3) Qs off: 2Q or 6Q — whole cycles of A

    await call(page, 'setLoopPoints', b, odd, odd + 4 * Q);
    const a1 = await laneOf(a);
    expect(a1.zero, 'the frame stays on A').toBe(zero0);
    expect([a1.takeStartQ, a1.firstBright], 'A holds still').toEqual([a0.takeStartQ, a0.firstBright]);
    // B slots in where its region start sounds: its offset in A's
    // frame, mod its own 4Q period.
    expect((await laneOf(b)).takeStartQ, 'B\'s loop starts mid-frame').toBe((inQ + odd / Q) % 4);

    await call(page, 'setLoopPoints', b, even, even + 4 * Q);
    const a2 = await laneOf(a);
    expect(a2.zero, 'a whole cycle of A off: the frame still stays on A').toBe(zero0);
    expect([a2.takeStartQ, a2.firstBright], 'A reads as before').toEqual([a0.takeStartQ, a0.firstBright]);
    expect((await laneOf(b)).takeStartQ, 'B slots in 2Q in').toBe((inQ + even / Q) % 4);
    expect((inQ + even / Q) % 4, '(setup: that is mid-frame, not the edge)').toBe(2);

    await call(page, 'togglePlayback');
    await verifyHeard(page);
});
