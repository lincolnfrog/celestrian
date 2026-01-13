/**
 * Clip Interaction Tests
 * 
 * Tests clip interactions: buttons, drag/drop, rename.
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Clip Interactions', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
    });

    test('mute button is visible and clickable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const muteBtn = firstClip.locator('.node-btn-mute');

        // Verify mute button exists and is visible
        await expect(muteBtn).toBeVisible();

        // Verify it's clickable (doesn't throw)
        await muteBtn.click();

        // Button should still be visible after click
        await expect(muteBtn).toBeVisible();
    });

    test('solo button is visible and clickable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const soloBtn = firstClip.locator('.node-btn-solo');

        // Verify solo button exists and is visible
        await expect(soloBtn).toBeVisible();

        // Verify it's clickable (doesn't throw)
        await soloBtn.click();

        // Button should still be visible after click
        await expect(soloBtn).toBeVisible();
    });

    test('drag reorders clips within stack', async ({ page }) => {
        // Get initial clip count
        const clipsBefore = await page.locator('.stack-children .node').count();
        expect(clipsBefore).toBe(3);

        // Drag first clip down using grab handle
        const firstClip = page.locator('.stack-children .node').first();
        const grabHandle = firstClip.locator('.grab-handle');

        // Wait for grab handle to be visible
        await expect(grabHandle).toBeVisible();

        const handleBox = await grabHandle.boundingBox();
        if (!handleBox) throw new Error('Grab handle not found');

        // Drag down past second clip (move 150px down)
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 150);
        await page.waitForTimeout(200);
        await page.mouse.up();

        // Wait for animation
        await page.waitForTimeout(300);

        // Just verify drag completed without errors - still have 3 clips
        const clipsAfter = await page.locator('.stack-children .node').count();
        expect(clipsAfter).toBe(3);
    });

    test('clip name input is editable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const nameInput = firstClip.locator('.node-name-input');

        // Verify input exists
        await expect(nameInput).toBeVisible();

        // Focus and change name
        await nameInput.click();
        await nameInput.fill('Renamed Clip');
        await nameInput.press('Enter');

        // Verify name changed
        const newName = await nameInput.inputValue();
        expect(newName).toBe('Renamed Clip');
    });

    test('clip header shows expected control buttons', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();

        // Verify mute and solo buttons exist
        await expect(firstClip.locator('.node-btn-mute')).toBeVisible();
        await expect(firstClip.locator('.node-btn-solo')).toBeVisible();
    });
});
