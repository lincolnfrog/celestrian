/**
 * GROWTH AND THE EPOCH (docs/scenarios.md S2, S5, S4), end to end: an
 * 8Q take armed at phase 2Q of a 4Q cycle. The engine re-bases the
 * epoch to the take's heard top, the take sits at 2Q of the new frame
 * — on the LANES too — and it plays content[0] exactly at its origin.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, state, rec, verifyHeard, findNode, mod }
    from './engine_helpers.mjs';
import { deriveViewModel } from '../js/view_model.js';

test('an 8Q take at 2Q of a 4Q cycle: epoch re-base, tile at 2Q, content[0] at its origin', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const epoch0 = (await state(page)).islandEpoch;
    await engine(page, 'advance', { samples: 4 * Q });
    const c3 = await rec(page, 8 * Q, { atPhase: 2 * Q });
    const st = await state(page);
    const n3 = findNode(st, c3);
    expect(n3.duration).toBe(8 * Q);
    const rel = n3.origin - epoch0;
    expect(mod(rel, 4 * Q)).toBe(2 * Q);
    expect(st.islandEpoch).toBe(epoch0 + Math.floor(rel / (4 * Q)) * 4 * Q);
    expect(n3.origin - st.islandEpoch).toBe(2 * Q);
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);

    // The lane: the take tile starts at 2Q of the 8Q frame.
    const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
    expect(vm.cycleQ).toBe(8);
    expect(vm.lanes.find(l => l.id === c3).takeStartQ).toBe(2);
    // …and the DOM agrees: the bright tile's left edge sits at 2/8 of
    // its layer (the reps layer spans the frame).
    // (Polled: a reused tile div MORPHS to its new place over 180 ms.)
    await expect.poll(() => page.locator(`.lane[data-id="${c3}"] .rep:not(.ghost)`).first()
        .evaluate(el => el.offsetLeft / el.offsetParent.clientWidth), { timeout: 3000 })
        .toBeCloseTo(2 / 8, 1);

    await verifyHeard(page);
    // A 2Q take does not shrink the cycle (S4).
    await rec(page, 2 * Q);
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);
    await verifyHeard(page);
    void c1; void c2;
});

test('the pickup (S5): an arm a block before the top lands ON the top; a simple extension re-bases epoch := origin', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    await rec(page, 4 * Q);
    const epoch0 = (await state(page)).islandEpoch;
    const c3 = await rec(page, 8 * Q, { atPhase: 0 });
    const st = await state(page);
    const rel = findNode(st, c3).origin - epoch0;
    expect(mod(rel, 4 * Q)).toBe(0);
    expect(st.islandEpoch).toBe(findNode(st, c3).origin);
    await verifyHeard(page);
});
