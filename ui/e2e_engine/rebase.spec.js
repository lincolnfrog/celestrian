/**
 * GROWTH AND THE FRAME (docs/scenarios.md S2, S5, S4; docs/frame.md), end
 * to end: an 8Q take armed at phase 2Q of a 4Q cycle. The engine moves
 * no island fact at the commit; the VIEW seats the take 2Q into the
 * cycle it started in — on the LANES — and it plays content[0] exactly
 * at its origin.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, state, rec, verifyHeard, findNode, mod }
    from './engine_helpers.mjs';
import { deriveViewModel } from '../js/view_model.js';

test('an 8Q take at 2Q of a 4Q cycle: the zero stays, the view seats the tile at 2Q, content[0] at its origin', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const st0 = await state(page);
    const zero0 = st0.islandZero;
    // "Phase 2Q of the 4Q cycle" is measured from the 4Q loop's top —
    // the frame the view seats — while driveToPhase counts from the
    // island zero (the 1Q take's origin, a Q earlier).
    const shift = mod(findNode(st0, c2).origin - zero0, 4 * Q);
    await engine(page, 'advance', { samples: 4 * Q });
    const c3 = await rec(page, 8 * Q, { atPhase: mod(2 * Q + shift, 4 * Q) });
    const st = await state(page);
    const n3 = findNode(st, c3);
    expect(n3.duration).toBe(8 * Q);
    const rel = n3.origin - findNode(st, c2).origin;
    expect(mod(rel, 4 * Q)).toBe(2 * Q);
    expect(st.islandZero, 'no commit moves the island zero').toBe(zero0);
    expect((await engine(page, 'status')).cycle).toBe(8 * Q);

    // The lane: the view seats the take in the 4Q cycle it started in —
    // the tile starts at 2Q of the 8Q frame, and c2's picture is unmoved.
    const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
    expect(vm.cycleQ).toBe(8);
    expect(vm.lanes.find(l => l.id === c3).takeStartQ).toBe(2);
    expect(vm.lanes.find(l => l.id === c2).takeStartQ).toBe(0);
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

test('the pickup (S5): an arm a block before the top lands ON the top; a simple extension moves no island fact', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    const st0 = await state(page);
    const zero0 = st0.islandZero;
    // The 4Q loop's top, in driveToPhase's island-zero frame.
    const shift = mod(findNode(st0, c2).origin - zero0, 4 * Q);
    const c3 = await rec(page, 8 * Q, { atPhase: shift });
    const st = await state(page);
    const rel = findNode(st, c3).origin - findNode(st, c2).origin;
    expect(mod(rel, 4 * Q)).toBe(0);
    expect(st.islandZero, 'no commit moves the island zero').toBe(zero0);
    // The view seats the take at the top of the cycle it started in.
    const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
    expect(vm.lanes.find(l => l.id === c3).takeStartQ).toBe(0);
    await verifyHeard(page);
});
