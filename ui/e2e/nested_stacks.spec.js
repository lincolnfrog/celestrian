/**
 * Nested Stacks Playwright Tests
 * 
 * Tests the rendering of stacks within stacks to verify:
 * 1. Nested stack wrappers are created with correct classes
 * 2. Clips inside nested stacks are rendered
 * 3. Expand/collapse works for nested stacks
 * 4. Visual distinction (purple border) is applied
 */
import { test, expect } from '@playwright/test';

test.describe('Nested Stacks Rendering', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
    });

    test('nested stack wrapper should be created with .nested-stack class', async ({ page }) => {
        // Load nested stacks scenario
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        // Check parent stack exists
        const parentStack = await page.locator('#stack-wrapper-parent-stack');
        await expect(parentStack).toBeVisible();

        // Check nested stack wrapper exists with correct class
        const nestedStack = await page.locator('#stack-wrapper-child-stack');
        await expect(nestedStack).toBeVisible();
        await expect(nestedStack).toHaveClass(/nested-stack/);
    });

    test('clips inside nested stack should be rendered', async ({ page }) => {
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        // Check top-level clip exists
        const topLevelClip = await page.locator('#clip-1');
        await expect(topLevelClip).toBeVisible();

        // Check nested clips exist
        const nestedClip1 = await page.locator('#nested-clip-1');
        const nestedClip2 = await page.locator('#nested-clip-2');
        await expect(nestedClip1).toBeVisible();
        await expect(nestedClip2).toBeVisible();

        console.log('All clips rendered: top-level and nested');
    });

    test('nested stack should have purple border styling', async ({ page }) => {
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        const nestedStack = await page.locator('#stack-wrapper-child-stack');

        // Get computed border color
        const borderColor = await nestedStack.evaluate(el => {
            return getComputedStyle(el).borderColor;
        });

        console.log('Nested stack border color:', borderColor);

        // Purple should have higher R and B than G values
        // rgb(168, 85, 247) is the expected purple
        const rgbMatch = borderColor.match(/rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/);
        if (rgbMatch) {
            const [_, r, g, b] = rgbMatch.map(Number);
            // Check it's purple-ish (R > G, B > G)
            expect(parseInt(r)).toBeGreaterThan(parseInt(g));
            expect(parseInt(b)).toBeGreaterThan(parseInt(g));
        }
    });

    test('nested stack hierarchy is correct (parent contains child)', async ({ page }) => {
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        // Check that nested stack is inside parent stack's children container
        const nestedInsideParent = await page.locator(
            '#stack-wrapper-parent-stack .stack-children #stack-wrapper-child-stack'
        );
        await expect(nestedInsideParent).toBeVisible();

        // Check that nested clips are inside nested stack's children container
        const nestedClipInsideNestedStack = await page.locator(
            '#stack-wrapper-child-stack .stack-children #nested-clip-1'
        );
        await expect(nestedClipInsideNestedStack).toBeVisible();

        console.log('Hierarchy verified: parent > child-stack > nested-clips');
    });

    test('collapsing nested stack should hide its children', async ({ page }) => {
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        // Verify nested clips are visible when expanded
        const nestedClip1 = await page.locator('#nested-clip-1');
        await expect(nestedClip1).toBeVisible();

        // Click the nested stack's expand handle to collapse it
        await page.click('#stack-wrapper-child-stack .stack-expand-handle');
        await page.waitForTimeout(300);

        // Check that nested stack has collapsed class
        const nestedStack = await page.locator('#stack-wrapper-child-stack');
        await expect(nestedStack).toHaveClass(/stack-collapsed/);

        console.log('Nested stack collapse verified');
    });

    test('expanded stack should show header waveform', async ({ page }) => {
        await page.click('button:has-text("Nested Stacks")');
        await page.waitForTimeout(500);

        // Check parent stack has header waveform element (use direct child selector)
        const parentHeaderWaveform = await page.locator('#stack-wrapper-parent-stack > .stack-header-waveform');
        await expect(parentHeaderWaveform).toBeVisible();

        // Check nested stack (when expanded) also has header waveform
        const nestedHeaderWaveform = await page.locator('#stack-wrapper-child-stack > .stack-header-waveform');
        await expect(nestedHeaderWaveform).toBeVisible();

        // Check canvas is present inside header waveform
        const canvas = await page.locator('#stack-wrapper-parent-stack > .stack-header-waveform .stack-waveform-canvas');
        await expect(canvas).toBeVisible();

        console.log('Stack header waveforms verified');
    });
});
