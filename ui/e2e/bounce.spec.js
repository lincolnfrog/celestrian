/**
 * Bounce e2e (design_language.md Q19, docs/bounce.md): the project
 * menu offers "Bounce song…" once the island has committed content,
 * and clicking it hands the island root to the dialog verb — the mock
 * records the request as its lastBounce and the status line says so.
 * "Bounce selected…" names the lane's start: its ↺ as shown (owner
 * 2026-10-01; view_model bounceStartOf).
 */

import { test, expect } from '@playwright/test';
import { deriveViewModel } from '../js/view_model.js';
import { slottedTopology, selectLane, laneMarks } from './region_panel_helpers.js';

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
        // The song bounces from the frame zero the view has seated
        // (docs/frame.md), so the file starts where the picture starts.
        const st = await page.evaluate(() => window.__celestrianTest.callNative('getGraphState'));
        const start = deriveViewModel(st).frameZero;
        await item.click();
        await expect.poll(() => page.evaluate(
            () => window.__celestrianTest.getLastBounce())).toEqual({
                uuid: 'mock-root', path: '<dialog>', start });
        await expect(page.locator('#log-line')).toHaveText('Bounced');
    });

    test('"Bounce selected…" starts at the ↺ AS SHOWN — a loop that slots in opens on the frame\'s top, where the song bounce does', async ({ page }) => {
        // B places the frame (its ↺ sounds at 5Q); C slots in — its own
        // stored top, the region start, sounds at 20Q, a moment nothing
        // on screen marks. Its ↺ as shown is the frame's top.
        const { Q, b, c } = await slottedTopology(page);
        const lastBounce = () => page.evaluate(
            () => window.__celestrianTest.getLastBounce());
        const bounce = async label => {
            await page.click('#project-menu-btn');
            const item = page.locator(`#project-menu .pm-item:has-text("${label}")`);
            await expect(item).toBeEnabled();
            await item.click();
        };
        await selectLane(page, c);
        await bounce('Bounce selected…');
        await expect.poll(lastBounce).toEqual({ uuid: c, path: '<dialog>', start: 5 * Q });
        // The song opens on the same sample: the stem lines up with it.
        await bounce('Bounce song…');
        await expect.poll(lastBounce).toEqual(
            { uuid: 'mock-root', path: '<dialog>', start: 5 * Q });
        // The placing loop opens on its own ↺ — moved 1Q into its
        // region, the frame follows it (6Q), and so does every stem.
        await page.evaluate(({ id, Q }) =>
            window.__celestrianTest.callNative('setTiming', id, 0, 5 * Q), { id: b, Q });
        await expect.poll(() => laneMarks(page, c)).toEqual(['top@0', 'wrap@2']);
        await selectLane(page, b);
        await bounce('Bounce selected…');
        await expect.poll(lastBounce).toEqual({ uuid: b, path: '<dialog>', start: 6 * Q });
        await selectLane(page, c);
        await bounce('Bounce selected…');
        await expect.poll(lastBounce).toEqual({ uuid: c, path: '<dialog>', start: 6 * Q });
    });
});
