import { test, expect } from '@playwright/test';

test.describe('Stack Loop Region Bug', () => {
    test.beforeEach(async ({ page }) => {
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        page.on('pageerror', err => console.log(`[Browser Error] ${err.message}`));
        await page.goto('/?mock=true');
        // Wait for the mock backend to expose window.__celestrianTest
        // (backend.js attaches it during async module init — racing it flakes)
        await page.waitForFunction(() => typeof window.__celestrianTest?.loadScenario === 'function', {
            timeout: 5000
        });
        await page.evaluate(() => window.__celestrianTest.loadScenario('1q-3q-loop-bug'));
        // Wait for render
        await page.waitForSelector('.stack-wrapper');
    });

    test('reproduces 1Q/2Q alternating loop bug and verifies fix', async ({ page }) => {
        // 1. Setup: 1Q+3Q stack loaded (LCM = 3Q = 132300 samples)
        const stack = page.locator('#stack-wrapper-stack-1');
        await expect(stack).toBeVisible();

        // 2. Collapse the stack via direct handler invocation
        await page.evaluate(() => {
            const handle = document.querySelector('.stack-expand-handle');
            if (handle && handle.onclick) handle.onclick(new Event('click'));
        });
        await page.waitForTimeout(300);
        await expect(stack).toHaveClass(/collapsed/);

        // 3. Set Loop Region to 2Q (0 -> 88200) via backend API
        await page.evaluate(() => {
            window.__celestrianTest.callNative('setLoopPoints', 'stack-1', 0, 88200);
        });
        await page.waitForTimeout(200);

        // 4. Set masterPos to 2.5Q (110250) and verify playhead
        //
        // With loop region 0->2Q (88200):
        //   enrichNodes computes: internalTransport = 110250 % 88200 = 22050 (0.5Q)
        //   app.js playhead: masterPos = loopStart + internalTransport = 0 + 22050
        //   posInLoop = 0 + ((22050 - 0) % 88200) = 22050
        //   playheadPct = 22050 / 132300 = 16.6%
        //
        // Bug (without internalTransport):
        //   playheadPct = 110250 / 132300 = 83.3%

        await page.evaluate(() => {
            window.__celestrianTest.setMasterPos(110250);  // 2.5Q
            window.__celestrianTest.setIsPlaying(true);
        });

        // Allow UI to update (multiple sync cycles for enrichNodes)
        await page.waitForTimeout(500);

        // Check Playhead Position
        const playhead = stack.locator('.stack-playhead');
        await expect(playhead).toBeVisible();

        const style = await playhead.getAttribute('style');
        const match = style.match(/left:\s*([\d.]+)%/);
        expect(match).not.toBeNull();

        const leftPct = parseFloat(match[1]);
        console.log(`Playhead is at ${leftPct}%`);

        // Should be ~16.6% (correct wrapped position), NOT 83.3% (buggy)
        expect(leftPct).toBeLessThan(30);
        expect(leftPct).toBeGreaterThan(10);
    });
});
