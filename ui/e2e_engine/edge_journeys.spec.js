/**
 * EDGE JOURNEYS — the corners where loop regions and groups meet:
 * nested maps (a member's own window inside a windowed group), members
 * recorded off the group's zero, a window authored on an EMPTY group
 * that then anchors, a seek, and a save/load round trip after a chain
 * of edits. Every stage: heard == law == lanes; audio-neutral steps by
 * fingerprint.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, verifyHeard, findNode,
         listenAtTop, expectSameSound, mod } from './engine_helpers.mjs';

const Q = 44100;

async function newGroup(page) {
    await call(page, 'createNode', 'stack', '');
    const st = await state(page);
    return st.nodes[st.nodes.length - 1].id;
}

test('nested maps: a member\'s own window inside a windowed group, each moved and bypassed', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const g = await newGroup(page);
    const a = await rec(page, 4 * Q, { parent: g });
    const b = await rec(page, 2 * Q, { atPhase: 1 * Q, parent: g });
    await verifyHeard(page);
    // The member's own window first: a keeps [1Q, 3Q).
    await call(page, 'setLoopPoints', a, Q, 3 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);
    // Then the group's window over the mapped composite: [0, 1Q).
    await call(page, 'setLoopPoints', g, 0, Q);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);
    // Move the inner window under the outer one; then the outer.
    await engine(page, 'advance', { samples: Q + 321 });
    await call(page, 'setLoopPoints', a, 2 * Q, 4 * Q);
    await verifyHeard(page);
    await call(page, 'setLoopPoints', g, Q, 2 * Q);
    await verifyHeard(page);
    // Bypass the outer: the inner alone; bypass the inner: nothing.
    await call(page, 'toggleLoopWindow', g);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', a);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    void b;
});

test('a window authored on an EMPTY group is re-expressed when the group anchors', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    await rec(page, 4 * Q);
    await engine(page, 'advance', { samples: 4 * Q });
    const g = await newGroup(page);
    expect(findNode(await state(page), g).anchored).toBe(false);
    // Authored while empty: measured from the received cycle top.
    await call(page, 'setLoopPoints', g, Q, 3 * Q);
    // Record a member at phase 2Q: the group anchors there and the
    // window is re-expressed from the new origin so nothing audible
    // moves (settleAnchors) — and the lanes agree.
    const m = await rec(page, 4 * Q, { atPhase: 2 * Q, parent: g });
    const st = await state(page);
    expect(findNode(st, g).anchored).toBe(true);
    await verifyHeard(page);
    void m;
});

test('seek: the phase jumps, every origin rides the delta, the render is invariant', async ({ page }) => {
    await openEngine(page);
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const c3 = await rec(page, 8 * Q, { atPhase: 2 * Q });
    await call(page, 'setLoopPoints', c2, Q, 3 * Q);
    const before = await listenAtTop(page);
    const st0 = await state(page);
    const ok = await call(page, 'seekTransport', 5 * Q);
    expect(ok).toBe(true);
    const st1 = await state(page);
    expect(Math.round(st1.masterPos / Q)).toBe(5);
    const delta = findNode(st1, c1).origin - findNode(st0, c1).origin;
    for (const id of [c2, c3]) {
        expect(findNode(st1, id).origin - findNode(st0, id).origin).toBe(delta);
    }
    expect(st1.islandEpoch - st0.islandEpoch).toBe(delta);
    await verifyHeard(page);
    const after = await listenAtTop(page);
    expectSameSound(before, after, { label: 'seek' });
});

test('save / load round trip after a chain of edits: same facts, same sound, same lanes', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 5 * Q);
    const c3 = await rec(page, 3 * Q);
    await call(page, 'setLoopPoints', c3, Q, 2 * Q);
    const g = await newGroup(page);
    const m = await rec(page, 4 * Q, { atPhase: 3 * Q, parent: g });
    await call(page, 'setLoopPoints', g, Q, 3 * Q);
    await call(page, 'setSegments', c2, [0, Q, 2 * Q, 3 * Q, 4 * Q, 5 * Q]);
    await verifyHeard(page);
    const before = await listenAtTop(page);
    const st0 = await state(page);
    const path = `/tmp/celestrian-e2e-${Date.now()}`;
    expect(await call(page, 'saveSession', path)).toBe(true);
    expect(await call(page, 'loadSession', path)).toBe(true);
    const st1 = await state(page);
    expect(st1.quantum).toBe(st0.quantum);
    for (const id of [c2, c3, m]) {
        const a = findNode(st0, id), b = findNode(st1, id);
        expect(b, `${id} survives the round trip`).toBeTruthy();
        expect(b.duration).toBe(a.duration);
        expect(b.origin - st1.islandEpoch).toBe(a.origin - st0.islandEpoch);
        expect([b.loopStart, b.loopEnd, b.windowActive]).toEqual([a.loopStart, a.loopEnd, a.windowActive]);
        expect(b.segments || null).toEqual(a.segments || null);
    }
    const gb = findNode(st1, g);
    expect(gb.anchored).toBe(true);
    expect(gb.origin - st1.islandEpoch).toBe(findNode(st0, g).origin - st0.islandEpoch);
    await verifyHeard(page);
    const after = await listenAtTop(page);
    expectSameSound(before, after, { label: 'save/load' });
    void mod;
});
