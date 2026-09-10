/**
 * ENGINE E2E smoke: the real UI talks to the real engine. A take
 * recorded through the bridge with the clock advanced by exact counts
 * commits, establishes Q, and shows up as a lane whose readout the
 * engine's state agrees with.
 */

import { test, expect } from '@playwright/test';
import { openEngine, call, engine, state, rec, findNode } from './engine_helpers.mjs';

test('ping, a first take, Q, the lane', async ({ page }) => {
    await openEngine(page);
    expect(await call(page, 'ping')).toBe('pong');
    const s0 = await engine(page, 'status');
    expect(s0.paused).toBe(true);

    const Q = 44100;
    const c1 = await rec(page, Q);
    const st = await state(page);
    expect(st.quantum).toBe(Q);
    expect(findNode(st, c1).duration).toBe(Q);
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(1);
    await expect(page.locator(`.lane[data-id="${c1}"]`)).toBeVisible();

    // A second take pads to the grid the first established.
    const c2 = await rec(page, 4 * Q);
    const st2 = await state(page);
    expect(findNode(st2, c2).duration).toBe(4 * Q);
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
    // The island cycle the server computes (period law) is 4Q.
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
});

test('the transport readout follows the engine clock', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    await rec(page, 2 * Q);
    // Advance half a cycle: the published masterPos moves by exactly
    // that (wrapped on the 2Q cycle) and the ruler readout follows.
    const a = await state(page);
    await engine(page, 'advance', { samples: Q });
    const b = await state(page);
    expect(((b.masterPos - a.masterPos) % (2 * Q) + 2 * Q) % (2 * Q)).toBe(Q);
    await expect(page.locator('#position-readout')).not.toHaveText('—');
});
