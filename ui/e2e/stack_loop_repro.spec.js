import { test, expect } from '@playwright/test';

test.describe('Stack Loop Region Bug', () => {
    test.beforeEach(async ({ page }) => {
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        page.on('pageerror', err => console.log(`[Browser Error] ${err.message}`));
        await page.goto('/?mock=true');
        await page.evaluate(() => window.loadScenario('1q-3q-loop-bug'));
        // Wait for render
        await page.waitForSelector('.stack-wrapper');
    });

    test('reproduces 1Q/2Q alternating loop bug and verifies fix', async ({ page }) => {
        // 1. Setup: 1Q+3Q stack loaded.
        // Use ID from mock_backend.js scenario '1q-3q-loop-bug' (stack-1)
        const stack = page.locator('#stack-wrapper-stack-1');
        await expect(stack).toBeVisible();
        const stackId = 'stack-1';

        // verify initial LCM state (3Q = 132300 samples)
        // stack width should be proportional, but we care about duration

        // 2. Collapse the stack
        const expandHandle = stack.locator('.stack-expand-handle');
        await expandHandle.click();
        await expect(stack).toHaveClass(/collapsed/);

        // 3. Set Loop Region to 2Q (0 -> 88200)
        // We simulate dragging the end handle from 100% (3Q) to ~66.6% (2Q)
        const loopEndHandle = stack.locator('.loop-handle-end');
        await expect(loopEndHandle).toBeVisible();

        const handleBox = await loopEndHandle.boundingBox();
        console.log('Handle Box:', handleBox);

        const waveform = stack.locator('.stack-header-waveform');
        const box = await waveform.boundingBox();
        console.log('Waveform Box:', box);

        // Start drag at center of handle
        const startX = handleBox.x + handleBox.width / 2;
        const startY = handleBox.y + handleBox.height / 2;

        // Target x = 2/3 of waveform width (2Q / 3Q)
        // 2Q = 88200, 3Q = 132300. Ratio = 0.666
        const targetX = box.x + (box.width * 0.6666);

        console.log(`Dragging from ${startX},${startY} to ${targetX},${startY}`);

        await page.mouse.move(startX, startY);
        await page.mouse.down();
        // Move in steps to ensure events fire
        await page.mouse.move(targetX, startY, { steps: 20 });
        await page.mouse.up();

        // Wait for loop point update (mock backend log)
        await page.waitForTimeout(500); // Allow async update

        // 4. Advance time and verify Playhead Logic
        // We set masterPos to 2.5Q (110250 samples)
        // Global LCM is 3Q (132300). 
        // Loop is 2Q (88200).

        // Scenario:
        // Global Transport: 2.5Q
        // 
        // OLD BUGGY BEHAVIOR: 
        // Playhead used global transport wrapped at 3Q.
        // Position = 2.5Q % 3Q = 2.5Q.
        // Visual % = 2.5 / 3 = 83.3%.
        //
        // CORRECT FIXED BEHAVIOR:
        // Playhead uses stack internal transport wrapped at 2Q.
        // Internal = 2.5Q % 2Q = 0.5Q.
        // Visual % = 0.5 / 3 = 16.6%.

        // Set backend time to 2.5Q (110250)
        // 1Q = 44100. 2.5Q = 110250.
        await page.evaluate(() => {
            window.setMasterPos(110250);
            window.setIsPlaying(true); // Ensure playhead renders
        });

        // Allow UI to update
        await page.waitForTimeout(100);

        // Check Playhead Position
        const playhead = stack.locator('.stack-playhead');
        await expect(playhead).toBeVisible();

        // Get 'left' style percentage
        const style = await playhead.getAttribute('style');
        const match = style.match(/left:\s*([\d.]+)%/);
        expect(match).not.toBeNull();

        const leftPct = parseFloat(match[1]);
        console.log(`Playhead is at ${leftPct}%`);

        // Check if it matches 16.6% (Correct) vs 83.3% (Buggy)
        // Allow some tolerance for pixel rounding
        expect(leftPct).toBeLessThan(30); // Should be roughly 16.6%
        expect(leftPct).toBeGreaterThan(10);
    });
});
