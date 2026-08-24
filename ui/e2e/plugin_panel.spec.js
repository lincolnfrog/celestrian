/**
 * Plugin panel e2e (docs/vst3.md phase 1).
 *
 * Prior bug (2026-08-24): the panel had no height limit, so a machine
 * with a long plugin list pushed the popover past the top of the
 * window and the Scan button out of reach. The list must scroll
 * inside the panel instead.
 */

import { test, expect } from '@playwright/test';

test.describe('plugin panel', () => {
    test('a long plugin list scrolls inside the panel', async ({ page }) => {
        await page.addInitScript(() => {
            window.__celestrianMockPluginCount = 80;
        });
        await page.goto('/?mock=true');

        await page.click('#plugins-btn');
        await expect(page.locator('.plugin-row')).toHaveCount(82);

        // The panel must stay inside the window...
        const box = await page.locator('.audio-panel').boundingBox();
        const viewport = page.viewportSize();
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

        // ...with the Scan control still reachable below the list...
        await expect(page.locator('#plugin-scan-btn')).toBeInViewport();

        // ...because the list itself is the scroll container.
        const scrollable = await page.locator('.plugin-list').evaluate(
            el => el.scrollHeight > el.clientHeight);
        expect(scrollable).toBe(true);
    });
});
