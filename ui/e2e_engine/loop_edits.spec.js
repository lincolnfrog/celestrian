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
         listenAtTop, expectSameSound, mod } from './engine_helpers.mjs';
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
    expect(st.islandEpoch).toBe(findNode(st, c1).origin + Q);
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
    // FRAME may re-base by whole Qs (the cycle-top rule, two-anchor
    // continuity) — and any re-base that is not a whole island cycle
    // shows as every other lane jumping. Pinned here from the user's
    // seat: A's bright tile stays where it was, at every edit.
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
        () => call(page, 'setLoopPoints', b, Q, 3 * Q),
        () => engine(page, 'advance', { samples: Q + 700 }),
        () => call(page, 'setLoopPoints', b, 2 * Q, 4 * Q),
        () => call(page, 'setSegments', b, [0, Q, 2 * Q, 3 * Q]),
        () => engine(page, 'advance', { samples: 2 * Q + 100 }),
        () => call(page, 'setSegments', b, [Q, 2 * Q, 3 * Q, 4 * Q]),
        () => call(page, 'toggleLoopWindow', b),
        () => call(page, 'setLoopPoints', b, 0, 0),
    ];
    for (const [i, edit] of edits.entries()) {
        await edit();
        const a1 = await tileOf(a);
        expect(a1.takeStartQ, `after edit ${i}: lane A's tile moved`).toBe(a0.takeStartQ);
        expect(a1.firstBright, `after edit ${i}: lane A's bright tile moved`).toBe(a0.firstBright);
        await verifyHeard(page);
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
