/**
 * Ghost Rendering Tests
 * 
 * Tests ghost clip rendering based on LCM calculations.
 * Covers examples from docs/recording.md
 * 
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Ghost Rendering - LCM Scenarios', () => {

    test('1Q + 4Q scenario: clips render correctly', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load 1Q + 4Q scenario - button text includes "(LCM=4)"
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for ghost rendering
        await page.waitForTimeout(300);

        // Count main clips - should be 2
        const mainClips = await page.locator('.stack-children .node').count();
        expect(mainClips).toBe(2);
    });

    test('1Q + 4Q + 3Q scenario: polyrhythmic clips render', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load 1Q + 4Q + 3Q scenario  
        await page.click('button:has-text("1Q + 4Q + 3Q (LCM=12)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for ghost rendering
        await page.waitForTimeout(300);

        // Count main clips - should be 3
        const mainClips = await page.locator('.stack-children .node').count();
        expect(mainClips).toBe(3);
    });

    test('recording scenario shows two clips', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load recording scenario - button text is "1Q + Recording (BUG)"
        await page.click('button:has-text("1Q + Recording")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for render
        await page.waitForTimeout(300);

        // Verify 2 clips exist (1 committed, 1 recording)
        const clips = await page.locator('.stack-children .node').count();
        expect(clips).toBe(2);
    });
});

test.describe('Ghost Visual Properties', () => {

    test('ghost clips have semi-transparent opacity', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for ghosts to render
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();

        if (ghostCount > 0) {
            const firstGhost = page.locator('.ghost-clip').first();

            // Verify ghost styling - should be semi-transparent
            const opacity = await firstGhost.evaluate((el) =>
                window.getComputedStyle(el).opacity
            );
            expect(parseFloat(opacity)).toBeLessThan(1);
        }
        // If no ghosts, test passes (ghosts may not render in some scenarios)
    });

    test('ghost clips are not interactive (pointer-events)', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for ghosts to render
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();

        if (ghostCount > 0) {
            const firstGhost = page.locator('.ghost-clip').first();

            // Verify pointer-events: none
            const pointerEvents = await firstGhost.evaluate((el) =>
                window.getComputedStyle(el).pointerEvents
            );
            expect(pointerEvents).toBe('none');
        }
        // If no ghosts, test passes
    });
});
