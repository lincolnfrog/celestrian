/**
 * Basic UI Tests
 * 
 * Tests fundamental UI elements and interactions.
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Basic UI', () => {

    test('empty canvas loads correctly', async ({ page }) => {
        await page.goto('/index_test.html');

        // Wait for test controls
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load empty scenario
        await page.click('button:has-text("Empty Canvas")');

        // Wait a moment for state to apply
        await page.waitForTimeout(200);

        // Verify test controls are visible
        await expect(page.locator('#test-controls')).toBeVisible();

        // Verify no nodes exist
        const nodeCount = await page.locator('.node').count();
        expect(nodeCount).toBe(0);

        // Verify stack container exists
        await expect(page.locator('#canvas-root')).toBeVisible();
    });

    test('single clip scenario displays correctly', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load single clip scenario
        await page.click('button:has-text("Single Clip")');
        await page.waitForSelector('.node', { timeout: 5000 });

        // Verify 1 clip exists
        const clipCount = await page.locator('.node.clip').count();
        expect(clipCount).toBe(1);

        // Verify clip has expected elements
        const clip = page.locator('.node.clip').first();
        await expect(clip.locator('.node-header')).toBeVisible();
        await expect(clip.locator('.node-content')).toBeVisible();
        await expect(clip.locator('.node-waveform')).toBeVisible();
    });

    test('stack with clips displays all children', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load stack with clips scenario
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.node', { timeout: 5000 });

        // Verify stack exists
        const stackWrapper = page.locator('.stack-wrapper');
        await expect(stackWrapper).toBeVisible();

        // Verify 3 clips inside stack
        const clipCount = await page.locator('.stack-children .node').count();
        expect(clipCount).toBe(3);
    });

    test('multiple stacks scenario loads correctly', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load multiple stacks scenario
        await page.click('button:has-text("Multiple Stacks")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        // Verify 2 stack wrappers exist
        const stackCount = await page.locator('.stack-wrapper').count();
        expect(stackCount).toBe(2);
    });
});
