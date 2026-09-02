/**
 * MIDI lane rendering e2e (docs/vst3.md §11), against the mock: the
 * midi-clip scenario's Keys lane fetches its notes (getMidiNotes) and
 * paints note-bar tiles — every resting tile of the lane carries the
 * take's note count, ghosts included (the same tiling as audio).
 */

import { test, expect } from '@playwright/test';

test.describe('MIDI lane rendering (B7)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('midi-clip'));
        await expect(page.locator('.lane[data-id="midi-1"]')).toBeVisible();
    });

    test('the Keys lane shows note-bar tiles carrying four notes', async ({ page }) => {
        const tiles = page.locator('.lane[data-id="midi-1"] .rep.midi');
        await expect(tiles.first()).toBeVisible();
        const count = await tiles.count();
        expect(count).toBeGreaterThanOrEqual(1);
        for (let i = 0; i < count; i++) {
            await expect(tiles.nth(i)).toHaveAttribute('data-notes', '4');
            await expect(tiles.nth(i).locator('canvas')).toHaveCount(1);
        }
        // The audio seed beside it paints the envelope, not notes.
        await expect(page.locator('.lane[data-id="seed"] .rep.midi')).toHaveCount(0);
    });
});
