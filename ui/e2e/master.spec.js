/**
 * The master strip e2e (docs/ui_overhaul.md §2, B5): the transport's
 * master fader drives the root stack's gain through the mock backend
 * (setNodeGain on rootId), double-click restores unity, and the master
 * fx chip opens the root's rack as the first row — the same fx row a
 * group rail's chip opens.
 */

import { test, expect } from '@playwright/test';

test.describe('Master strip (B5)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() =>
            window.__celestrianTest.loadScenario('stack-with-clips'));
        await page.waitForFunction(
            () => document.querySelectorAll('.lane').length > 0,
            { timeout: 5000 });
    });

    /** The published root state (the master's gain and rack). */
    const rootState = page => page.evaluate(async () => {
        const s = await window.__celestrianTest.callNative('getGraphState');
        return { id: s.id, gain: s.gain, effects: s.effects };
    });

    test('dragging the master fader lowers the root gain; double-click restores unity', async ({ page }) => {
        const fader = page.locator('#master-fader');
        await expect(fader).toBeVisible();
        expect((await rootState(page)).gain).toBe(1);

        // REAL input, hit-tested: press the fader and pull it down half
        // its travel (the grip tracks the pointer 1:1).
        const b = await fader.boundingBox();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx, cy + 16, { steps: 4 });
        await page.mouse.up();

        const dragged = await rootState(page);
        expect(dragged.id).toBe('mock-root');
        expect(dragged.gain).toBeLessThan(0.8);
        expect(dragged.gain).toBeGreaterThan(0.1);

        // Double-click restores unity (the ceiling — no boost).
        await fader.dblclick();
        await expect.poll(async () => (await rootState(page)).gain).toBe(1);
    });

    test('the master fx chip opens the root rack as the first row', async ({ page }) => {
        const chip = page.locator('#master-fx-btn');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText('fx');
        await expect(chip).not.toHaveClass(/\bopen\b/);

        await chip.click();
        const row = page.locator('.lane.lane-fx[data-id="fx:mock-root"]');
        await expect(row).toBeVisible();
        await expect(page.locator('#lanes .lane').first())
            .toHaveAttribute('data-id', 'fx:mock-root');
        await expect(chip).toHaveClass(/\bopen\b/);
        await expect(row.locator('.fx-card')).toHaveCount(4);

        // A power switch in the row edits the ROOT's chain; the chip
        // shows the enabled count.
        await row.locator('.fx-card[data-fx="reverb"] .fx-power').click();
        await expect.poll(async () => {
            const s = await rootState(page);
            return s.effects.chain.find(e => e.type === 'reverb').enabled;
        }).toBe(true);
        await expect(chip).toHaveText('fx·1');
        await expect(chip).toHaveClass(/\bon\b/);

        // Click again: the row folds away, the count stays.
        await chip.click();
        await expect(row).toHaveCount(0);
        await expect(chip).not.toHaveClass(/\bopen\b/);
        await expect(chip).toHaveText('fx·1');
    });
});
