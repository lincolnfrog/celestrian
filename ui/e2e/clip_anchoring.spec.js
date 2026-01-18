/**
 * Clip Anchoring E2E Test
 * 
 * Verifies that clips recorded at specific quantum positions are correctly
 * anchored and have proper ghost wrapping.
 * 
 * Bug scenario: Clip 3 starts at 2Q but gets anchored at 0Q instead of 2Q.
 * Expected: Clip 3 at x=400 (2Q slot), ghosts wrap from 0Q to 2Q.
 */

import { test, expect } from '@playwright/test';

test.describe('Clip Anchoring at Quantum Positions', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
    });

    test('Clip 3 recorded at 2Q should be anchored at x=400', async ({ page }) => {
        // Load the anchor bug test scenario
        await page.click('button:has-text("1Q + 4Q + 1Q@2Q")');

        // Wait for nodes to render
        await page.waitForSelector('.node-content', { timeout: 5000 });

        // Find Clip 3 (the one anchored at 2Q)
        const clip3 = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q@2Q"]') });
        const clipContent = clip3.locator('.node-content');

        await expect(clipContent).toBeVisible();

        const clipBox = await clipContent.boundingBox();
        if (!clipBox) throw new Error('Clip 1Q@2Q content not found');

        // Find Clip 1 (anchored at 0Q) as reference
        const clip1 = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q"]') });
        const clip1Content = clip1.locator('.node-content');
        const clip1Box = await clip1Content.boundingBox();
        if (!clip1Box) throw new Error('Clip 1Q content not found');

        // Clip 3 should be 400px (2 quantums * 200px) to the right of Clip 1
        // Account for scaling
        const getScale = async (p) => {
            return await p.evaluate(() => {
                const viewport = document.getElementById('viewport');
                if (!viewport) return 1;
                const style = window.getComputedStyle(viewport);
                const matrix = new DOMMatrix(style.transform);
                return matrix.a; // scaleX
            });
        };

        const scale = await getScale(page);
        const expectedOffset = 400 * scale;  // 2Q * 200px * scale
        const actualOffset = clipBox.x - clip1Box.x;

        console.log(`Scale: ${scale}, Expected offset: ${expectedOffset}, Actual offset: ${actualOffset}`);

        // Verify horizontal offset (Clip 3 is 2Q to the right of Clip 1)
        expect(Math.abs(actualOffset - expectedOffset)).toBeLessThan(10 * scale);
    });

    test('Clip 3 at 2Q should have left-wrap ghost from 0Q to 2Q', async ({ page }) => {
        // Load the anchor bug test scenario
        await page.click('button:has-text("1Q + 4Q + 1Q@2Q")');

        // Wait for ghosts to render
        await page.waitForSelector('.ghost-clip', { timeout: 5000 });

        // Find Clip 3 (anchored at 2Q)
        const clip3 = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q@2Q"]') });
        const clipContent = clip3.locator('.node-content');
        const clipBox = await clipContent.boundingBox();
        if (!clipBox) throw new Error('Clip 1Q@2Q content not found');

        // Find ghosts for Clip 3
        // Ghosts should fill 0Q→2Q (left of main clip at 2Q)
        // With LCM=4Q and clip duration=1Q at position 2Q:
        // - Main clip: 2Q→3Q
        // - Ghost 1: 3Q→4Q (right ghost)
        // - Ghost 2: 0Q→1Q (left wrap)
        // - Ghost 3: 1Q→2Q (left wrap)
        const allGhosts = page.locator('.ghost-clip');
        const ghostCount = await allGhosts.count();

        // Should have at least 2 ghosts for left-wrap (0Q→1Q and 1Q→2Q)
        // Plus potentially right ghost (3Q→4Q)
        expect(ghostCount).toBeGreaterThanOrEqual(2);

        // Check that at least one ghost is to the LEFT of the main clip
        // (This would be the left-wrap ghost at 0Q→2Q)
        let hasLeftGhost = false;
        for (let i = 0; i < ghostCount; i++) {
            const ghostBox = await allGhosts.nth(i).boundingBox();
            if (ghostBox && ghostBox.x < clipBox.x) {
                hasLeftGhost = true;
                break;
            }
        }

        expect(hasLeftGhost).toBe(true);
    });

    test('Stack child clip with x=400 should have translateX(400px) on content', async ({ page }) => {
        // Load the anchor bug test scenario
        await page.click('button:has-text("1Q + 4Q + 1Q@2Q")');

        // Wait for nodes to render
        await page.waitForSelector('.node-content', { timeout: 5000 });

        // Find Clip 3 (the one with x=400)
        const clip3 = page.locator('.node').filter({ has: page.locator('input[value="Clip 1Q@2Q"]') });
        const clipContent = clip3.locator('.node-content');

        await expect(clipContent).toBeVisible();

        // Verify the content has translateX transform applied
        // This is the key fix - stack children use translateX to offset the content
        const transform = await clipContent.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style.transform;
        });

        console.log(`Content transform: ${transform}`);

        // Should have a translateX of 400px (or equivalent matrix)
        // matrix(1, 0, 0, 1, 400, 0) is translateX(400px) in matrix form
        const hasCorrectOffset = transform.includes('400') ||
            transform.includes('matrix(1, 0, 0, 1, 400');

        expect(hasCorrectOffset).toBe(true);
    });
});
