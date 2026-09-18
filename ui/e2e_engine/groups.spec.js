/**
 * GROUPS, end to end — combine, group windows, recording through a
 * group's map, one-shot groups, members leaving and returning. The
 * listener judges every stage: heard == the render law composed down
 * the stack chain (receivedClock) and, for top-level lanes, == the
 * lane drawing.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, recThrough, verifyHeard, findNode,
         listenAtTop, expectSameSound, listen, mod, activeMapOf } from './engine_helpers.mjs';

const Q = 44100;

test('combine two clips: nothing moves; the group is anchored at the earliest member', async ({ page }) => {
    await openEngine(page);
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const c3 = await rec(page, 4 * Q, { atPhase: 2 * Q });
    const before = await listenAtTop(page);
    const g = await call(page, 'combineNodes', c3, c2);
    expect(typeof g).toBe('string');
    let st = await state(page);
    const gn = findNode(st, g);
    expect(gn && gn.type).toBe('stack');
    expect(gn.anchored).toBe(true);
    expect(gn.origin).toBe(Math.min(findNode(st, c2).origin, findNode(st, c3).origin));
    const after = await listenAtTop(page);
    expectSameSound(before, after, { label: 'combine' });
    await verifyHeard(page);
    await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(1);

    // Undo the combine: the clips are loose again, still in phase.
    await call(page, 'undo');
    st = await state(page);
    expect(findNode(st, g)).toBeNull();
    const undone = await listenAtTop(page);
    expectSameSound(before, undone, { label: 'explode' });
    void c1;
});

test('a windowed group maps its members\' clock (S8); bypass restores the composite', async ({ page }) => {
    await openEngine(page);
    const q1 = await rec(page, Q);
    const a = await rec(page, 4 * Q);
    await call(page, 'createNode', 'stack', '');
    const st0 = await state(page);
    const g = st0.nodes[st0.nodes.length - 1].id;
    const b = await rec(page, 2 * Q, { parent: g });
    const c = await rec(page, 3 * Q, { parent: g });
    expect((await engine(page, 'status')).cycle).toBe(12 * Q);
    await verifyHeard(page);

    await call(page, 'setLoopPoints', g, 2 * Q, 4 * Q);
    let st = await state(page);
    expect(findNode(st, g).anchored).toBe(true);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);

    // Move the group's window while it plays, then bypass, re-activate.
    await engine(page, 'advance', { samples: 3 * Q + 500 });
    await call(page, 'setLoopPoints', g, 1 * Q, 4 * Q);   // 3Q
    expect((await engine(page, 'status')).cycle).toBe(12 * Q);
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', g);
    expect((await engine(page, 'status')).cycle).toBe(12 * Q);
    st = await state(page);
    expect(activeMapOf(findNode(st, g))).toBeNull();
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', g);
    await verifyHeard(page);
    void q1; void a; void b; void c;
});

test('recording INTO a windowed group (S29): one pass, replayed through the map; bypassed = content where played', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    await call(page, 'createNode', 'stack', '');
    const st0 = await state(page);
    const g = st0.nodes[st0.nodes.length - 1].id;
    const a = await rec(page, 4 * Q, { parent: g });
    await call(page, 'setLoopPoints', g, Q, 3 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);

    const b = await recThrough(page, g);
    let st = await state(page);
    expect(findNode(st, b).duration).toBe(4 * Q);
    expect(findNode(st, b).contextCycle).toBe(2 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    // The members read the mapped clock (heard == law); the new take
    // sounds in EVERY frame through the map, its capture clock
    // advancing with the frames inside each pass (the performance
    // replayed in the order it was heard).
    await verifyHeard(page, { only: [a] });
    let L = await listen(page, { hop: 2048 });
    const bTake = L.clips[b][0];
    const clocks = L.frames.map(f => {
        const h = f.heard.find(x => x.id === b);
        return h ? bTake.captureClock + h.inner : null;
    });
    expect(clocks.every(c => c !== null), 'the take sounds in every frame').toBe(true);
    let advancing = 0, total = 0;
    for (let i = 1; i < clocks.length; i++) {
        total++;
        if (Math.abs(clocks[i] - clocks[i - 1] - L.hop) < 600) advancing++;
    }
    expect(advancing / total, 'replayed in heard order (seams excepted)').toBeGreaterThan(0.85);

    // Bypassed: the inner timeline honestly — content where the map
    // visited (2Q of 4Q), silence elsewhere.
    await call(page, 'toggleLoopWindow', g);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    L = await listen(page, { hop: 2048 });
    const sounding = L.frames.filter(f => f.heard.some(x => x.id === b)).length;
    expect(Math.abs(sounding / L.frames.length - 0.5)).toBeLessThan(0.08);
    await verifyHeard(page, { only: [a] });
    void st;
});

test('a one-shot GROUP fires from its origin and rests (S25)', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    await rec(page, 4 * Q);
    await call(page, 'createNode', 'stack', '');
    const st0 = await state(page);
    const g = st0.nodes[st0.nodes.length - 1].id;
    const k = await rec(page, 2 * Q, { atPhase: 2 * Q, parent: g });
    let st = await state(page);
    expect(mod(findNode(st, g).origin - st.islandZero, 4 * Q)).toBe(2 * Q);
    await verifyHeard(page);
    await call(page, 'setPeriodSource', g, 'context');
    st = await state(page);
    expect(findNode(st, g).periodSource).toBe('context');
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    await call(page, 'setPeriodSource', g, 'own');
    await verifyHeard(page);
    void k;
});

test('a member leaves and returns: delete, undo — the rest keep their phase', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    await call(page, 'createNode', 'stack', '');
    const st0 = await state(page);
    const g = st0.nodes[st0.nodes.length - 1].id;
    const b = await rec(page, 2 * Q, { parent: g });
    const c = await rec(page, 4 * Q, { atPhase: 1 * Q, parent: g });
    await call(page, 'setLoopPoints', g, 1 * Q, 3 * Q);
    await verifyHeard(page);
    const before = await listenAtTop(page);
    await call(page, 'deleteNode', b);
    expect(findNode(await state(page), b)).toBeNull();
    await verifyHeard(page);
    const without = await listenAtTop(page);
    expectSameSound(before, without, { ids: [c], label: 'delete b' });
    await call(page, 'undo');
    expect(findNode(await state(page), b)).not.toBeNull();
    const back = await listenAtTop(page);
    expectSameSound(before, back, { label: 'undo delete' });
    await verifyHeard(page);
});
