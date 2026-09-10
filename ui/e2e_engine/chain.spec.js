/**
 * THE OWNER'S CHAIN, end to end (docs/scenarios.md S3 + S7 + S24, on
 * the real UI and the real engine): 1Q, 5Q, 3Q; window the 3Q take to
 * [1Q, 2Q); a 12Q take; window it to [0, 6Q). At every stage the
 * spectral listener decodes the mix and every clip must sound exactly
 * the content the render law says AND the content its lane draws.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, verifyHeard, expectCaptureClocksSane,
         findNode } from './engine_helpers.mjs';

test('1Q, 5Q, 3Q → window → 12Q → window: heard == law == lanes at every stage', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 5 * Q);
    const c3 = await rec(page, 3 * Q);
    expect((await engine(page, 'status')).cycle).toBe(15 * Q);
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3);
    let L = await verifyHeard(page);
    // The listener's clip map reads every take right (each capture
    // clock inside the sweep span its recording consumed). No fold is
    // pinned sample-exact by the C++ scenarios (S3, S32).
    expectCaptureClocksSane(L);

    // "Edit it to be only 1Q": a loop window on the 3Q take.
    await call(page, 'setLoopPoints', c3, Q, 2 * Q);
    expect((await engine(page, 'status')).cycle).toBe(5 * Q);
    await expect(page.locator(`.lane[data-id="${c3}"] .win-bracket`).first()).toBeVisible();
    await verifyHeard(page);

    // A 12Q take under the 5Q heard cycle: its origin is its capture
    // boundary (no fold), the cycle grows to 60Q.
    const c4 = await rec(page, 12 * Q);
    expect((await engine(page, 'status')).cycle).toBe(60 * Q);
    L = await verifyHeard(page);
    expectCaptureClocksSane(L);
    expect(findNode(await state(page), c4).duration).toBe(12 * Q);

    // "Edit it to be 6Q": window c4 to [0, 6Q) → 30Q.
    await call(page, 'setLoopPoints', c4, 0, 6 * Q);
    expect((await engine(page, 'status')).cycle).toBe(30 * Q);
    await verifyHeard(page);
    // Q untouched by non-definer windows.
    expect((await state(page)).quantum).toBe(Q);
});

test('a window that is not Q-coherent is refused; Q/2 is accepted (S24)', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await call(page, 'setLoopPoints', c2, 0, 1.5 * Q);
    expect(findNode(await state(page), c2).windowActive).toBe(false);
    await call(page, 'setLoopPoints', c2, 0, Q / 2);
    expect(findNode(await state(page), c2).windowActive).toBe(true);
    expect((await engine(page, 'status')).cycle).toBe(Q);
    await verifyHeard(page);
});
