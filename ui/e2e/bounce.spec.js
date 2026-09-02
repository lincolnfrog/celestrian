/**
 * Bounce e2e (design_language.md Q19, docs/bounce.md): the project
 * menu offers "Bounce song…" once the island has committed content,
 * and clicking it hands the island root to the dialog verb — the mock
 * records the request as its lastBounce and the status line says so.
 */

import { test, expect } from '@playwright/test';

test.describe('Bounce (Q19)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
    });

    test('an empty island offers the verb disabled', async ({ page }) => {
        await page.click('#project-menu-btn');
        await expect(page.locator(
            '#project-menu .pm-item:has-text("Bounce song…")')).toBeDisabled();
    });

    test('with content, "Bounce song…" bounces the island root', async ({ page }) => {
        await page.evaluate(() =>
            window.__celestrianTest.loadScenario('single-clip'));
        // The poll paints the lane before the menu reads its content.
        await expect(page.locator('.lane')).toHaveCount(1);
        await page.click('#project-menu-btn');
        const item = page.locator('#project-menu .pm-item:has-text("Bounce song…")');
        await expect(item).toBeEnabled();
        await item.click();
        await expect.poll(() => page.evaluate(
            () => window.__celestrianTest.getLastBounce())).toEqual({
                uuid: 'mock-root', path: '<dialog>' });
        await expect(page.locator('#log-line')).toHaveText('Bounced');
    });
});
