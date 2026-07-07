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

test.describe('Ghost Count Verification (docs/recording.md spec)', () => {

    // recording.md: "Clip 1 (1Q) should have 3 ghosts, Clip 2 (4Q) should have 0 ghosts"
    // LCM(1,4) = 4 → 1Q clip tiles 4 times → 3 ghosts (main + 3 = 4 repetitions)
    test('1Q + 4Q: exactly 3 ghosts for 1Q clip', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();
        console.log(`1Q+4Q scenario: ${ghostCount} ghosts`);

        // 1Q clip: 3 ghosts (fills 4Q timeline)
        // 4Q clip: 0 ghosts (already fills timeline)
        expect(ghostCount).toBe(3);
    });

    // recording.md: "Clip 1: 12 repetitions (11 ghosts), Clip 2: 3 repetitions (2 ghosts), Clip 3: 4 repetitions (3 ghosts)"
    // Total = 11 + 2 + 3 = 16 ghosts
    test('1Q + 4Q + 3Q: 16 total ghosts (polyrhythmic)', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + 4Q + 3Q (LCM=12)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();
        console.log(`1Q+4Q+3Q scenario: ${ghostCount} ghosts`);

        // LCM(1,4,3) = 12
        // 1Q clip: 11 ghosts, 4Q clip: 2 ghosts, 3Q clip: 3 ghosts = 16 total
        expect(ghostCount).toBe(16);
    });

    // Clip 3 anchored at x=400 (2Q offset) should still tile correctly
    // with wrap-around ghosts appearing before the anchor position
    test('anchor offset clip: ghosts fill LCM including positions before anchor', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + 4Q + 1Q@2Q")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();
        console.log(`Anchor offset scenario: ${ghostCount} ghosts`);

        // 3 clips in this scenario:
        // Clip 1 (1Q at 0): 3 ghosts (to fill 4Q)
        // Clip 2 (4Q at 0): 0 ghosts
        // Clip 3 (1Q at 2Q): 3 ghosts (0Q, 1Q, 3Q — skips 2Q where main clip sits)
        // Total = 3 + 0 + 3 = 6
        expect(ghostCount).toBe(6);
    });

    // During recording, committed clip (1Q) should have ghosts extending based on recording progress
    // Recording at 2.5Q: committed LCM = 1Q, recording crossed 2 LCM boundaries
    // So timeline extends to at least 3Q → 1Q clip gets 2 ghosts
    test('recording: committed clip ghosts extend with recording progress', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        await page.click('button:has-text("1Q + Recording")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        const ghostCount = await page.locator('.ghost-clip').count();
        console.log(`Recording scenario: ${ghostCount} ghosts`);

        // 1Q committed clip should have ghosts extending based on recording (2.5Q)
        // Committed LCM = 1Q, recording crosses 2 boundaries → timeline = 3Q
        // So 1Q clip tiles 3 times → 2 ghosts minimum
        // Recording clip gets NO ghosts (isRecording = true)
        expect(ghostCount).toBeGreaterThanOrEqual(2);
    });
});
