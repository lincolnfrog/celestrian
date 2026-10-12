/**
 * The master strip e2e (docs/session_view.md §2): the transport's
 * master fader is the root stack's gain (setNodeGain on the root's id);
 * a double-click restores unity. (Its fx chip opens the root's rack as
 * the first row: session_view.spec.js, the fx-chip case.)
 */

import { test, expect } from '@playwright/test';
import { boot, root, laneOf, centreOf, dragBy } from './helpers.js';

test('dragging the master fader lowers the root gain; a double-click restores unity', async ({ page }) => {
    await boot(page, { scenario: 'stack-with-clips' });
    await expect(laneOf(page, 'clip-1')).toBeVisible();
    const fader = page.locator('#master-fader');
    await expect(fader).toBeVisible();
    expect((await root(page)).gain).toBe(1);

    // REAL input, hit-tested: press the fader and pull it down half its
    // travel (the grip tracks the pointer 1:1).
    await dragBy(page, await centreOf(fader), 0, { dy: 16, steps: 4 });
    await expect.poll(async () => (await root(page)).gain).toBeLessThan(0.8);
    const dragged = await root(page);
    expect(dragged.id).toBe('mock-root');
    expect(dragged.gain).toBeGreaterThan(0.1);

    // Unity is the ceiling (no boost).
    await fader.dblclick();
    await expect.poll(async () => (await root(page)).gain).toBe(1);
});
