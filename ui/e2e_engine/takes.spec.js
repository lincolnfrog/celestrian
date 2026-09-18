/**
 * TAKES AND COMPING (docs/scenarios.md S15, S16), end to end: a new
 * take of a 4Q slot captures one period at the slot top; selecting a
 * take swaps what sounds (the listener tells the takes apart by their
 * capture clocks); a comp alternates takes per Q cell; a retake stopped
 * short cancels.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, listen, advanceUntil, findNode, mod }
    from './engine_helpers.mjs';

const hot = n => !!(n && (n.isRecording || n.isPendingStart || n.isAwaitingStop));

/** The take index heard for clip `id` in each Q cell of one listen.
 * Cells are the SLOT's: counted from its origin (docs/takes.md), not
 * from the island zero. */
function takePerCell(L, id, cells, origin) {
    const out = new Array(cells).fill(null);
    for (const f of L.frames) {
        const rel = mod(L.zero + f.pos - origin, cells * L.quantum);
        const cell = Math.floor(rel / L.quantum);
        const h = f.heard.find(x => x.id === id);
        if (h && out[cell] === null && rel % L.quantum > L.frame && rel % L.quantum < L.quantum - L.frame)
            out[cell] = h.take;
    }
    return out;
}

test('new take, select, comp, cancel', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);

    // A NEW TAKE: arms at the slot's next top, captures one period,
    // auto-finishes.
    await call(page, 'newTake', c2);
    await advanceUntil(page, s => findNode(s, c2).isRecording);
    await advanceUntil(page, s => !hot(findNode(s, c2)), 6 * Q);
    let n = findNode(await state(page), c2);
    expect(n.takes).toBe(2);
    expect(n.activeTake).toBe(1);
    expect(n.duration).toBe(4 * Q);
    await expect(page.locator(`.lane[data-id="${c2}"] .take-btn`)).toHaveText('T2/2');

    // The listener hears take 1 everywhere; select take 0 → take 0.
    const slotOrigin = n.origin;
    let L = await listen(page);
    expect(L.clips[c2].length).toBe(2);
    expect(takePerCell(L, c2, 4, slotOrigin)).toEqual([1, 1, 1, 1]);
    await call(page, 'selectTake', c2, 0);
    L = await listen(page);
    expect(takePerCell(L, c2, 4, slotOrigin)).toEqual([0, 0, 0, 0]);

    // The comp: cells [0, 1, 0, 1] → the takes alternate per Q.
    await call(page, 'setComp', c2, [0, 1, 0, 1]);
    L = await listen(page);
    expect(takePerCell(L, c2, 4, slotOrigin)).toEqual([0, 1, 0, 1]);
    await call(page, 'setComp', c2, []);

    // A retake stopped short of its period CANCELS: still two takes.
    await call(page, 'newTake', c2);
    await advanceUntil(page, s => findNode(s, c2).isRecording);
    await engine(page, 'advance', { samples: Q });
    await call(page, 'stopRecordingInNode', c2);
    await advanceUntil(page, s => !hot(findNode(s, c2)), 6 * Q);
    n = findNode(await state(page), c2);
    expect(n.takes).toBe(2);
    expect(n.duration).toBe(4 * Q);
    await expect(page.locator(`.lane[data-id="${c2}"] .take-btn`)).toHaveText('T1/2');
    // The standing take still sounds its loop law.
    L = await listen(page);
    expect(takePerCell(L, c2, 4, slotOrigin)).toEqual([0, 0, 0, 0]);
    void mod;
});
