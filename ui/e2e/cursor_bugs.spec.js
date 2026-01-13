/**
 * Cursor and Loop Bug Tests
 * 
 * Tests to reproduce reported bugs:
 * 1. Cursor doesn't loop to 0% when first clip commits (~25% instead)
 * 2. No ghost cursors during recording
 * 3. Clips loop to 1Q instead of 0Q when recording finishes
 * 
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Cursor Bugs - Recording Scenario', () => {

    test('BUG: ghost cursors should be visible during recording', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load recording scenario (1Q committed + 2.5Q recording)
        await page.click('button:has-text("1Q + Recording")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });

        // Wait for render
        await page.waitForTimeout(500);

        // Find ghosts - they should exist for the committed 1Q clip
        const ghostClips = await page.locator('.ghost-clip').count();

        // During recording, there should be ghosts extending to show the context
        console.log(`Ghost clip count during recording: ${ghostClips}`);

        // Check if any ghost has a visible playhead
        const ghostPlayheads = await page.locator('.ghost-clip .playhead').evaluateAll(
            els => els.map(el => ({
                display: window.getComputedStyle(el).display,
                left: el.style.left
            }))
        );

        console.log('Ghost playhead states:', ghostPlayheads);

        // BUG: Ghost playheads should be visible during recording
        // This test documents the bug - if it fails, the bug is fixed!
        const visibleGhostPlayheads = ghostPlayheads.filter(p => p.display !== 'none');

        // EXPECTED: At least one ghost should have a visible playhead
        // If this fails, it confirms bug #2
        expect(visibleGhostPlayheads.length).toBeGreaterThan(0);
    });

    test('BUG: cursor position should be correct after recording commits', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load the 1Q + 4Q scenario (committed clips, not recording)
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        // Get the first clip's playhead position
        const firstClip = page.locator('.stack-children .node').first();
        const playhead = firstClip.locator('.playhead');

        // Get playhead position as percentage
        const playheadLeft = await playhead.evaluate(el => el.style.left);
        console.log(`Playhead position: ${playheadLeft}`);

        // For a committed clip at master position 0, playhead should be at 0%
        // BUG: It's at ~25% instead
        // This test will pass if playhead is at 0%, confirming the fix
        // For now we just log the value to observe the bug

        // Check main clip playhead visibility
        const playheadDisplay = await playhead.evaluate(el =>
            window.getComputedStyle(el).display
        );
        console.log(`Playhead display: ${playheadDisplay}`);
    });
});

test.describe('Loop Point Bugs', () => {

    test('BUG: clips should loop to 0Q not 1Q', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load 1Q + 4Q scenario
        await page.click('button:has-text("1Q + 4Q (LCM=4)")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
        await page.waitForTimeout(500);

        // Check the clips' loopStart values
        const clips = await page.locator('.stack-children .node').evaluateAll(
            nodes => nodes.map(n => {
                // Check for loop handles - their left position indicates loop bounds
                const loopStart = n.querySelector('.loop-handle-start');
                const loopEnd = n.querySelector('.loop-handle-end');
                return {
                    id: n.id,
                    loopStartLeft: loopStart ? loopStart.style.left : 'N/A',
                    loopEndLeft: loopEnd ? loopEnd.style.left : 'N/A'
                };
            })
        );

        console.log('Clip loop handles:', clips);

        // Loop start should be at 0% (which means 0Q)
        // BUG: If it's at some other percentage, loop is incorrect
        clips.forEach(clip => {
            // Loop start handle should be at 0% for clips that loop from the beginning
            expect(clip.loopStartLeft).toBe('0%');
        });
    });

    test('first clip establishes quantum at correct position', async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });

        // Load single clip scenario
        await page.click('button:has-text("Single Clip")');
        await page.waitForSelector('.node', { timeout: 5000 });
        await page.waitForTimeout(500);

        const clip = page.locator('.node').first();

        // Check loop handles
        const loopStartHandle = clip.locator('.loop-handle-start');
        const leftPos = await loopStartHandle.evaluate(el => el.style.left);

        console.log(`Single clip loop start: ${leftPos}`);

        // Single clip should have loop starting at 0%
        expect(leftPos).toBe('0%');
    });
});
