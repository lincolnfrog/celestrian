/**
 * Loop Handle Visibility During Drag - E2E Test
 * 
 * This test verifies that loop handles (and all other child elements) remain
 * visible when a clip is being dragged. This is a browser integration test
 * that requires real CSS rendering to verify the overflow/visibility behavior.
 * 
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Loop Handle Visibility During Drag', () => {

    test.beforeEach(async ({ page }) => {
        // Load the test harness (uses baseURL from playwright.config.js)
        await page.goto('/index_test.html');

        // Wait for page to be ready (just wait for test controls)
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load the stack with 3 clips scenario
        await page.click('button:has-text("Stack with 3 Clips")');

        // Wait for clips to render - this confirms the app is fully loaded
        await page.waitForSelector('.node', { timeout: 10000 });
    });

    test('loop handle remains visible during drag', async ({ page }) => {
        // Find the first clip's loop handle
        const firstClip = page.locator('.node').first();
        const loopHandle = firstClip.locator('.loop-handle-start');

        // Verify loop handle is visible before drag
        await expect(loopHandle).toBeVisible();

        // Get initial computed style
        const beforeDragStyle = await loopHandle.evaluate((el) => {
            const style = window.getComputedStyle(el);
            return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                width: el.offsetWidth,
                height: el.offsetHeight
            };
        });

        expect(beforeDragStyle.display).not.toBe('none');
        expect(beforeDragStyle.visibility).not.toBe('hidden');
        expect(beforeDragStyle.width).toBeGreaterThan(0);
        expect(beforeDragStyle.height).toBeGreaterThan(0);

        // Get the grab handle for drag
        const grabHandle = firstClip.locator('.grab-handle');
        const handleBox = await grabHandle.boundingBox();
        if (!handleBox) throw new Error('Grab handle not found');

        // Start dragging - mousedown on grab handle, move down
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();

        // Move mouse down to simulate drag
        await page.mouse.move(
            handleBox.x + handleBox.width / 2,
            handleBox.y + handleBox.height / 2 + 100
        );

        // Wait a moment for drag state to apply
        await page.waitForTimeout(100);

        // Verify the clip now has dragging class
        await expect(firstClip).toHaveClass(/dragging/);

        // CRITICAL: Verify loop handle is STILL visible during drag
        await expect(loopHandle).toBeVisible();

        // Get computed style during drag
        const duringDragStyle = await loopHandle.evaluate((el) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return {
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                width: rect.width,
                height: rect.height,
                isInViewport: rect.width > 0 && rect.height > 0
            };
        });

        // Verify visibility is maintained during drag
        expect(duringDragStyle.display).not.toBe('none');
        expect(duringDragStyle.visibility).not.toBe('hidden');
        expect(duringDragStyle.isInViewport).toBe(true);

        // Release the drag
        await page.mouse.up();

        // Verify dragging class is removed
        await expect(firstClip).not.toHaveClass(/dragging/);

        // Verify loop handle is still visible after drag ends
        await expect(loopHandle).toBeVisible();
    });

    test('all loop handles remain visible for all clips during any drag', async ({ page }) => {
        const clips = page.locator('.node');
        const clipCount = await clips.count();

        expect(clipCount).toBeGreaterThanOrEqual(2);

        // Get the second clip to drag
        const secondClip = clips.nth(1);
        const grabHandle = secondClip.locator('.grab-handle');
        const handleBox = await grabHandle.boundingBox();
        if (!handleBox) throw new Error('Grab handle not found');

        // Collect all loop handles before drag
        const allLoopHandles = page.locator('.loop-handle-start');
        const loopHandleCount = await allLoopHandles.count();

        // Verify all handles are visible before drag
        for (let i = 0; i < loopHandleCount; i++) {
            await expect(allLoopHandles.nth(i)).toBeVisible();
        }

        // Start dragging second clip
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
            handleBox.x + handleBox.width / 2,
            handleBox.y + handleBox.height / 2 - 80  // Drag UP this time
        );
        await page.waitForTimeout(100);

        // Verify ALL loop handles remain visible during drag (not just the dragged one)
        for (let i = 0; i < loopHandleCount; i++) {
            await expect(allLoopHandles.nth(i)).toBeVisible();
        }

        await page.mouse.up();
    });

    test('node-content overflow is visible during drag', async ({ page }) => {
        const firstClip = page.locator('.node').first();
        const nodeContent = firstClip.locator('.node-content');
        const grabHandle = firstClip.locator('.grab-handle');

        // Check overflow before drag
        const beforeOverflow = await nodeContent.evaluate(
            (el) => window.getComputedStyle(el).overflow
        );
        expect(beforeOverflow).toBe('hidden'); // Normal state

        // Start drag
        const handleBox = await grabHandle.boundingBox();
        if (!handleBox) throw new Error('Grab handle not found');

        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(
            handleBox.x + handleBox.width / 2,
            handleBox.y + handleBox.height / 2 + 50
        );
        await page.waitForTimeout(100);

        // Check overflow during drag - should be visible due to CSS fix
        const duringOverflow = await nodeContent.evaluate(
            (el) => window.getComputedStyle(el).overflow
        );
        expect(duringOverflow).toBe('visible'); // During drag

        await page.mouse.up();

        // Check overflow returns to hidden after drag
        const afterOverflow = await nodeContent.evaluate(
            (el) => window.getComputedStyle(el).overflow
        );
        expect(afterOverflow).toBe('hidden'); // Back to normal
    });
});
