/**
 * The preferences panel e2e (tasks.md B8), against the mock: the
 * transport's gear opens the one panel — device pickers, calibration,
 * the projects root read from getProjectInfo — "Change…" hands the
 * folder pick to chooseProjectsRoot and the line follows, and Escape
 * closes the panel (PANEL scope: the selection stays).
 */

import { test, expect } from '@playwright/test';

test.describe('Preferences (B8)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        await expect(page.locator('.lane[data-id="clip-1"]')).toBeVisible();
    });

    test('gear opens; root shown; Change… calls the mock; Escape closes', async ({ page }) => {
        // A selected lane first: PANEL-scope Escape must close the
        // panel and leave the selection alone.
        const rail = page.locator('.lane[data-id="clip-1"] .lane-rail');
        await rail.click();
        await expect(rail).toHaveClass(/selected/);

        const panel = page.locator('#prefs-panel');
        await expect(panel).toBeHidden();
        await page.click('#prefs-btn');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveClass(/open/);

        // The device pickers render into the panel (the mock's device).
        await expect(panel.locator('#audio-device-host select')).toHaveCount(4);
        await expect(panel.locator('#calibrate-btn')).toBeVisible();

        await expect(panel.locator('#projects-root'))
            .toHaveText('/Users/mock/Music/Celestrian/Projects');
        await panel.locator('#projects-root-change').click();
        await expect(panel.locator('#projects-root'))
            .toHaveText('/Volumes/Studio/Celestrian/Projects');
        await expect(page.locator('#log-line'))
            .toHaveText('Projects folder → /Volumes/Studio/Celestrian');

        // Escape closes the panel and does NOT clear the lane selection.
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(rail).toHaveClass(/selected/);
    });
});
