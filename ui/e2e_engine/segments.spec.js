/**
 * MULTI-SEGMENT MAPS (cut bands, docs/time_maps.md phase 3), end to
 * end: a 4Q take keeps [0,1Q) + [2Q,3Q) — a 2Q part — then the cut
 * slides, the map is bypassed, undone. The listener judges the law
 * through the JS twin of innerAt over the segments (lane geometry of a
 * multi-segment tile is not judged here).
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, verifyHeard, findNode,
         listenAtTop, expectSameSound } from './engine_helpers.mjs';

const Q = 44100;

test('cut bands: [0,1Q)+[2Q,3Q), slide, bypass, undo', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await engine(page, 'advance', { samples: Q + 200 });
    await call(page, 'setSegments', c2, [0, Q, 2 * Q, 3 * Q]);
    let st = await state(page);
    expect(findNode(st, c2).segments).toEqual([0, Q, 2 * Q, 3 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);

    // Slide the cut by 1Q: keep [1Q,2Q)+[3Q,4Q).
    await engine(page, 'advance', { samples: 3 * Q + 100 });
    await call(page, 'setSegments', c2, [Q, 2 * Q, 3 * Q, 4 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);

    // Bypass the map: the whole take; back; undo the slide.
    await call(page, 'toggleLoopWindow', c2);
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    await call(page, 'toggleLoopWindow', c2);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    const slid = await listenAtTop(page);
    await call(page, 'undo');   // un-bypass
    await call(page, 'undo');   // bypass
    // Consecutive setSegments on one node COALESCE into one undo entry
    // (the live-drag precedent, 2026-07-23d) — even minutes apart: the
    // third undo removes BOTH segment edits, back to the whole take.
    await call(page, 'undo');
    st = await state(page);
    expect(findNode(st, c2).segments).toBeUndefined();
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await verifyHeard(page);
    await call(page, 'redo');   // the coalesced entry: the SLID map
    st = await state(page);
    expect(findNode(st, c2).segments).toEqual([Q, 2 * Q, 3 * Q, 4 * Q]);
    const again = await listenAtTop(page);
    expectSameSound(slid, again, { label: 'redo the slide' });
});

test('a single segment delegates to loop points; three segments; an incoherent set is refused', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await call(page, 'setSegments', c2, [Q, 3 * Q]);
    let n = findNode(await state(page), c2);
    expect(n.segments).toBeUndefined();
    expect([n.loopStart, n.loopEnd]).toEqual([Q, 3 * Q]);
    await verifyHeard(page);
    // Three segments summing to 3Q (Q-coherent).
    await call(page, 'setSegments', c2, [0, Q, 1.5 * Q, 2 * Q, 2.5 * Q, 4 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(3 * Q);
    await verifyHeard(page);
    n = findNode(await state(page), c2);
    expect(n.segments.length).toBe(6);
    // 2.5Q is not on the grid: refused, the 3Q map stands (S24).
    await call(page, 'setSegments', c2, [0, Q, 2 * Q, 3 * Q, 3.5 * Q, 4 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(3 * Q);
    await verifyHeard(page);
});
