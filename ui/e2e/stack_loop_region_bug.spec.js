/**
 * Stack Loop Region Bug E2E Tests
 * 
 * Reproduces bug: 1Q + 3Q clips in collapsed stack with loop region 0-2Q
 * causes alternating loop behavior (1Q/2Q) instead of consistent 2Q.
 * 
 * Run with: npm run test:playwright -- e2e/stack_loop_region_bug.spec.js
 */

import { test, expect } from '@playwright/test';

test.describe('Stack Loop Region Bug Reproduction', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
    });

    test('1Q+3Q stack with 0-2Q loop region should loop consistently', async ({ page }) => {
        // Add console log listener for debugging
        page.on('console', msg => {
            if (msg.text().includes('[MockBackend]') || msg.text().includes('[StackLoopHandle]') || msg.text().includes('[SyncUI]')) {
                console.log(`BROWSER: ${msg.text()}`);
            }
        });

        // Step 1: Load the 1Q + 3Q scenario
        await page.click('button:has-text("1Q + 3Q (Loop Bug)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        await expect(stackWrapper).toBeVisible();

        // Verify stack is initially expanded
        const isExpandedBefore = await stackWrapper.evaluate(el => !el.classList.contains('stack-collapsed'));
        expect(isExpandedBefore).toBe(true);
        console.log('Stack is expanded, has 1Q + 3Q clips');

        // Step 2: Collapse the stack by clicking expand handle
        const expandHandle = stackWrapper.locator('.stack-expand-handle');
        await expect(expandHandle).toBeVisible();
        await expandHandle.click({ force: true });

        // Wait for collapse AND syncUI to process
        await page.waitForTimeout(500);

        // Verify stack is now collapsed
        const isCollapsed = await stackWrapper.evaluate(el => el.classList.contains('stack-collapsed'));
        expect(isCollapsed).toBe(true);
        console.log('Stack collapsed successfully');

        // Step 3: Get loop handle positions
        const headerWaveform = stackWrapper.locator('.stack-header-waveform');
        await expect(headerWaveform).toBeVisible();

        const loopHandleEnd = headerWaveform.locator('.loop-handle-end');
        await expect(loopHandleEnd).toBeVisible();

        // Get initial loop end position (should be 100% = 3Q)
        const initialEndLeft = await loopHandleEnd.evaluate(el => el.style.left);
        console.log(`Initial loop end position: ${initialEndLeft}`);
        expect(initialEndLeft).toBe('100%');

        // Step 4: Drag loop end handle from 100% (3Q) to ~66% (2Q)
        const headerBox = await headerWaveform.boundingBox();
        const handleBox = await loopHandleEnd.boundingBox();
        expect(headerBox).not.toBeNull();
        expect(handleBox).not.toBeNull();

        // Calculate target position: 2Q/3Q = 66.67% of header width
        const startX = handleBox.x + handleBox.width / 2;
        const startY = handleBox.y + handleBox.height / 2;
        const targetX = headerBox.x + (headerBox.width * 0.667);

        console.log(`Header at x=${headerBox.x}, width=${headerBox.width}`);
        console.log(`Handle bounding box: x=${handleBox.x}, y=${handleBox.y}, w=${handleBox.width}, h=${handleBox.height}`);

        // Step 4: Set loop region to 0-2Q directly (bypassing drag)
        // 2Q = 88200 samples (44100 * 2), which is 66.67% of 3Q (132300)
        const newLoopEnd = 88200;  // 2Q in samples
        console.log(`Setting loop end to ${newLoopEnd} samples (2Q)`);

        await page.evaluate((loopEnd) => {
            window.celestrian.callNative('setLoopPoints', 'stack-1', 0, loopEnd);
        }, newLoopEnd);

        // Wait for setLoopPoints to be processed and syncUI to update
        await page.waitForTimeout(500);

        // Step 5: Verify loop end moved to approximately 2Q position
        // Due to quantum snapping, it should snap to exactly 66.67% (2Q/3Q)
        const newEndLeft = await loopHandleEnd.evaluate(el => el.style.left);
        console.log(`New loop end position: ${newEndLeft}`);

        // Should be around 66-67% (2Q of 3Q total)
        const endPct = parseFloat(newEndLeft);
        expect(endPct).toBeGreaterThan(60);
        expect(endPct).toBeLessThan(70);

        // Step 6: Observe playhead behavior over time
        // The bug manifests as alternating loop cycles (1Q then 2Q)
        // We simulate playback by advancing masterPos and collecting playhead positions
        const playhead = headerWaveform.locator('.stack-playhead');
        const playheadPositions = [];

        // Simulate playback by advancing masterPos in increments
        // 1Q = 44100 samples, 2Q = 88200 samples (loop end), 3Q = 132300 (LCM duration)
        const sampleRate = 44100;
        const samplesPerSecond = sampleRate;  // 1 second = 1Q
        const incrementPerInterval = Math.round(samplesPerSecond / 10);  // 10 samples per 100ms

        // Collect positions as we advance through 3 loop cycles (6Q worth)
        for (let i = 0; i < 60; i++) {  // 60 iterations = 6 seconds of simulated playback
            // Advance masterPos and ensure isPlaying is true using proper setters
            const newMasterPos = i * incrementPerInterval;
            await page.evaluate((pos) => {
                window.celestrian.setMasterPos(pos);
                window.celestrian.setIsPlaying(true);
            }, newMasterPos);

            await page.waitForTimeout(50);  // Let syncUI update

            // Get playhead style details for debugging
            const playheadInfo = await playhead.evaluate(el => ({
                left: el.style.left,
                display: el.style.display,
                visible: getComputedStyle(el).display !== 'none',
                opacity: getComputedStyle(el).opacity
            }));
            const pos = parseFloat(playheadInfo.left) || 0;

            // Log every 10th iteration
            if (i % 10 === 0) {
                console.log(`Iteration ${i}: masterPos=${newMasterPos}, playhead left=${playheadInfo.left}, display=${playheadInfo.display}, visible=${playheadInfo.visible}`);
            }

            playheadPositions.push(pos);
        }

        console.log('Playhead positions:', playheadPositions.map(p => p.toFixed(1)).join(', '));

        // Find the maximum playhead position - should be close to loop end (66.67%)
        const maxPos = Math.max(...playheadPositions);
        console.log(`Maximum playhead position: ${maxPos.toFixed(1)}%`);

        // Detect wrap points (where position drops significantly)
        const wrapPoints = [];
        for (let i = 1; i < playheadPositions.length; i++) {
            const prevPos = playheadPositions[i - 1];
            const currPos = playheadPositions[i];
            // Wrap = position drops by more than 20%
            if (prevPos - currPos > 20 && prevPos > 30) {
                wrapPoints.push({ index: i, from: prevPos, to: currPos });
            }
        }

        console.log(`Detected ${wrapPoints.length} loop wrap points:`, wrapPoints);

        // BUG DETECTION: If loop is working correctly, all wraps should occur
        // around 66% (2Q position). If bug is present, wraps will alternate
        // between ~33% (1Q) and ~66% (2Q).
        if (wrapPoints.length >= 2) {
            const wrapPositions = wrapPoints.map(w => w.from);
            const avgWrap = wrapPositions.reduce((a, b) => a + b, 0) / wrapPositions.length;
            const variance = wrapPositions.map(p => Math.abs(p - avgWrap));
            const maxVariance = Math.max(...variance);

            console.log(`Wrap positions: ${wrapPositions.map(p => p.toFixed(1)).join(', ')}`);
            console.log(`Average wrap: ${avgWrap.toFixed(1)}%, Max variance: ${maxVariance.toFixed(1)}%`);

            // If variance is high (>10%), the bug is likely present
            // (alternating between 1Q/2Q wraps would cause ~16% variance)
            if (maxVariance > 10) {
                console.error('BUG DETECTED: Loop wrap positions vary significantly!');
                console.error('This indicates the alternating 1Q/2Q loop bug is present.');
            }

            // Expected behavior: all wraps should be within 10% of the 66% target
            expect(maxVariance).toBeLessThan(15);  // Allow some tolerance
            expect(avgWrap).toBeGreaterThan(55);   // Should wrap near 66%, not 33%
        }
    });

    test('collapsed stack loop handles are interactive', async ({ page }) => {
        // Load scenario and collapse stack
        await page.click('button:has-text("1Q + 3Q (Loop Bug)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        await stackWrapper.locator('.stack-expand-handle').click({ force: true });
        await page.waitForTimeout(200);

        // Verify collapsed
        const isCollapsed = await stackWrapper.evaluate(el => el.classList.contains('stack-collapsed'));
        expect(isCollapsed).toBe(true);

        // Loop handles should be interactive when collapsed
        const loopHandleEnd = stackWrapper.locator('.stack-header-waveform .loop-handle-end');
        const pointerEvents = await loopHandleEnd.evaluate(el => getComputedStyle(el).pointerEvents);

        console.log(`Collapsed stack loop handle pointer-events: ${pointerEvents}`);
        expect(pointerEvents).not.toBe('none');
    });

    test('stack loop region updates dim layers correctly', async ({ page }) => {
        // Load scenario and collapse stack
        await page.click('button:has-text("1Q + 3Q (Loop Bug)")');
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });

        const stackWrapper = page.locator('.stack-wrapper').first();
        await stackWrapper.locator('.stack-expand-handle').click({ force: true });
        await page.waitForTimeout(200);

        const headerWaveform = stackWrapper.locator('.stack-header-waveform');
        const dimRight = headerWaveform.locator('.dim-right');

        // Initially dim-right should be 0% (loop covers full range)
        const initialDimWidth = await dimRight.evaluate(el => el.style.width);
        expect(initialDimWidth).toBe('0%');

        // Set loop region to 0-2Q directly (bypassing drag)
        const newLoopEnd = 88200;  // 2Q in samples
        await page.evaluate((loopEnd) => {
            window.celestrian.callNative('setLoopPoints', 'stack-1', 0, loopEnd);
        }, newLoopEnd);

        await page.waitForTimeout(500);
        await page.waitForTimeout(500);

        // After drag, dim-right should be ~33% (covering 2Q to 3Q region)
        const newDimWidth = await dimRight.evaluate(el => el.style.width);
        console.log(`Dim-right width after drag: ${newDimWidth}`);

        const dimPct = parseFloat(newDimWidth);
        expect(dimPct).toBeGreaterThan(25);
        expect(dimPct).toBeLessThan(40);
    });
});
