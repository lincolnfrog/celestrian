/**
 * The by-hand harness (js/harness_sidebar.js): `/?mock=true&harness=1`
 * is the mock page with the scenario sidebar beside the app, and
 * `/index_test.html` is its old address.
 */

import { test, expect } from '@playwright/test';
import { laneOf, centreOf, consoleDrained } from './helpers.js';

test('the old harness address lands on the mock page with the sidebar beside the app; every button loads a scenario the mock knows', async ({ page }) => {
    const unknown = [];
    page.on('console', msg => {
        if (/Unknown scenario/.test(msg.text())) unknown.push(msg.text());
    });
    await page.goto('/index_test.html');
    await expect(page).toHaveURL(/\/\?mock=true&harness=1$/);
    const bar = page.locator('#test-controls');
    // The mock boots empty, and the sidebar says so.
    await expect(bar.locator('button.active')).toHaveText('Empty session');
    await expect(page.locator('.lane')).toHaveCount(0);

    // A real click loads the scenario and marks its button.
    const press = async button => {
        const at = await centreOf(button);
        await page.mouse.click(at.x, at.y);
    };
    await press(bar.locator('button', { hasText: 'Stack with 3 Clips' }));
    await expect(laneOf(page, 'clip-1')).toBeVisible();
    await expect(bar.locator('button.active')).toHaveText('Stack with 3 Clips');
    // In flow beside the app: it covers no lane.
    const lane = await laneOf(page, 'clip-1').boundingBox();
    const side = await bar.boundingBox();
    expect(lane.x + lane.width).toBeLessThanOrEqual(side.x);

    const buttons = bar.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(10);
    for (let i = 0; i < count; i++) {
        await buttons.nth(i).scrollIntoViewIfNeeded();
        await press(buttons.nth(i));
        await expect(buttons.nth(i)).toHaveClass(/\bactive\b/);
    }
    await consoleDrained(page);
    expect(unknown).toEqual([]);

    // Without the flag the mock page has no sidebar.
    await page.goto('/?mock=true');
    await page.waitForFunction(() => typeof window.__celestrianTest?.loadScenario === 'function');
    await expect(page.locator('#test-controls')).toHaveCount(0);
});
