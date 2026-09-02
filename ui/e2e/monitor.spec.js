/**
 * Input monitoring e2e (design_language.md Q20): the clip rail carries
 * a "mon" chip beside the input picker; clicking it toggles software
 * monitoring through the backend and the chip lights from the
 * published state. Uncalibrated, the tooltip says so.
 */

import { test, expect } from '@playwright/test';

test.describe('Input monitoring (Q20)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
    });

    test('the mon chip toggles monitoring and the mock state reflects it', async ({ page }) => {
        await page.evaluate(() =>
            window.__celestrianTest.loadScenario('single-clip'));
        const lane = page.locator('.lane[data-kind="clip"]').first();
        const mon = lane.locator('.mon-btn');
        await expect(mon).toBeVisible();
        await expect(mon).toHaveText('mon');
        await expect(mon).not.toHaveClass(/\bon\b/);
        await expect(mon).toHaveAttribute('title', 'monitor input · not calibrated');

        const monitorFlag = () => page.evaluate(async () => {
            const state = await window.__celestrianTest.callNative('getGraphState');
            const find = nodes => {
                for (const n of nodes || []) {
                    if (n.type === 'clip') return n;
                    const hit = find(n.nodes);
                    if (hit) return hit;
                }
                return null;
            };
            return find(state.nodes).monitor;
        });
        expect(await monitorFlag()).toBe(false);

        await mon.click();
        await expect(mon).toHaveClass(/\bon\b/);
        await expect.poll(monitorFlag).toBe(true);
        await expect(page.locator('#log-line'))
            .toHaveText('Monitoring input through the track');

        await mon.click();
        await expect(mon).not.toHaveClass(/\bon\b/);
        await expect.poll(monitorFlag).toBe(false);
    });
});
