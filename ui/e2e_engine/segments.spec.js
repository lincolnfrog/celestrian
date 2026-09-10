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
    // OWNER RULING 2026-09-10: two separate cut gestures are two undo
    // steps (only LIVE mid-gesture commits coalesce): the third undo
    // removes the slide alone, back to the first cut.
    await call(page, 'undo');
    st = await state(page);
    expect(findNode(st, c2).segments).toEqual([0, Q, 2 * Q, 3 * Q]);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    await verifyHeard(page);
    await call(page, 'undo');   // the first cut: the whole take
    expect(findNode(await state(page), c2).segments).toBeUndefined();
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await call(page, 'redo');
    await call(page, 'redo');   // the slide again
    st = await state(page);
    expect(findNode(st, c2).segments).toEqual([Q, 2 * Q, 3 * Q, 4 * Q]);
    const again = await listenAtTop(page);
    expectSameSound(slid, again, { label: 'redo the slide' });
    // A LIVE stream (a drag): the first commit opens the gesture's
    // entry, the live ones fold into it — one undo restores the slide.
    await call(page, 'setSegments', c2, [0, Q, 2 * Q, 3 * Q]);
    await call(page, 'setSegments', c2, [0, Q, 2.5 * Q, 3.5 * Q], true);
    await call(page, 'setSegments', c2, [0, Q, 3 * Q, 4 * Q], true);
    expect(findNode(await state(page), c2).segments).toEqual([0, Q, 3 * Q, 4 * Q]);
    await call(page, 'undo');
    expect(findNode(await state(page), c2).segments).toEqual([Q, 2 * Q, 3 * Q, 4 * Q]);
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
