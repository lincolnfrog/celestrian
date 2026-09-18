/**
 * ONE-SHOTS (docs/scenarios.md S6, S28), end to end: a 1Q take at
 * phase 3Q of a 4Q cycle, toggled to a one-shot with the lane's ↺/1×
 * chip. It fires at [3Q, 4Q) of every cycle and rests elsewhere; the
 * lane drops its ghosts; the listener hears silence in the rest.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, state, rec, verifyHeard, findNode, mod }
    from './engine_helpers.mjs';

test('a 1Q take at 3Q becomes a one-shot: fires once per cycle, rests, no ghosts', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    await rec(page, Q);
    await rec(page, 4 * Q);
    const c3 = await rec(page, Q, { atPhase: 3 * Q });
    const st = await state(page);
    expect(mod(findNode(st, c3).origin - st.islandZero, 4 * Q)).toBe(3 * Q);
    const lane = page.locator(`.lane[data-id="${c3}"]`);
    await expect(lane.locator('.rep')).toHaveCount(4);   // 1Q loop: 4 tiles in 4Q

    // The rail chip: ↺ → 1×.
    const chip = lane.locator('.oneshot-btn');
    await expect(chip).toHaveText('↺');
    await chip.click();
    await expect(chip).toHaveText('1×');
    await expect.poll(async () => findNode(await state(page), c3).periodSource).toBe('context');
    expect((await engine(page, 'status')).cycle).toBe(4 * Q);
    await expect(lane.locator('.rep')).toHaveCount(1);   // no ghosts

    // Sounds only in [3Q, 4Q) of every cycle: the law folds on the
    // context cycle (innerAt rests elsewhere).
    await verifyHeard(page, { foldOf: id => (id === c3 ? 4 * Q : 0) });

    // Back to a loop: every Q again.
    await chip.click();
    await expect(chip).toHaveText('↺');
    await expect(lane.locator('.rep')).toHaveCount(4);
    await verifyHeard(page);
});
