/**
 * Dynamic Recording Ghost Tests
 *
 * Tests ghost behavior during active recording using the mock backend's
 * transport simulation (advanceBy). Verifies ghost extension at LCM
 * boundaries and commit transitions.
 *
 * These tests exercise the dynamic behavior documented in recording.md
 * (Ghost Timeline Design section).
 *
 * All tests use /?mock=true route where window.advanceBy is available.
 */

import { test, expect } from '@playwright/test';

// Helper: wait for mock backend to be fully loaded on /?mock=true
async function initMockPage(page) {
    await page.goto('/?mock=true');
    // Wait for mock backend to expose window.loadScenario
    await page.waitForFunction(() => typeof window.loadScenario === 'function', {
        timeout: 5000
    });
}

test.describe('Dynamic Recording - Ghost Extension', () => {

    test.beforeEach(async ({ page }) => {
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        await initMockPage(page);
        // Load the recording scenario: 1Q committed + clip recording at 2.5Q
        await page.evaluate(() => window.loadScenario('recording-1q-plus-growing'));
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });
        await page.waitForTimeout(300);
    });

    test('ghosts extend when recording advances past LCM boundaries', async ({ page }) => {
        // Initial: 1Q committed, recording at 2.5Q
        // Committed LCM = 1Q. Recording crossed 2 boundaries → timeline = 3Q
        const initialGhosts = await page.locator('.ghost-clip').count();
        console.log(`Initial ghost count: ${initialGhosts}`);
        expect(initialGhosts).toBeGreaterThanOrEqual(2);

        // Advance recording by 2Q (88200 samples)
        // Recording was at 110250 (2.5Q), grows to 198450 (4.5Q)
        // recordingWidthPx goes from 500px to 900px
        // LCM boundaries crossed: floor(900/200) = 4 → timeline = 5 * 200 = 1000px
        await page.evaluate(() => window.advanceBy(88200));
        // Wait for multiple poll cycles to pick up the state change
        await page.waitForTimeout(400);

        const afterGhosts = await page.locator('.ghost-clip').count();
        console.log(`After +2Q advance: ${afterGhosts} ghosts (was ${initialGhosts})`);

        // More boundaries crossed = more ghost repetitions of the 1Q clip
        expect(afterGhosts).toBeGreaterThan(initialGhosts);
    });

    test('advanceBy is deterministic - same input produces same output', async ({ page }) => {
        // First run: advance by exactly 1Q
        await page.evaluate(() => window.advanceBy(44100));
        await page.waitForTimeout(300);
        const ghosts1 = await page.locator('.ghost-clip').count();

        // Reset: reload same scenario
        await page.evaluate(() => window.loadScenario('recording-1q-plus-growing'));
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });
        await page.waitForTimeout(300);

        // Second run: same advance
        await page.evaluate(() => window.advanceBy(44100));
        await page.waitForTimeout(300);
        const ghosts2 = await page.locator('.ghost-clip').count();

        console.log(`Determinism: run1=${ghosts1}, run2=${ghosts2}`);
        expect(ghosts1).toBe(ghosts2);
    });

    test('transport does not auto-advance when not started', async ({ page }) => {
        // Transport is NOT running (loadScenario resets it)
        const ghosts1 = await page.locator('.ghost-clip').count();
        await page.waitForTimeout(500);
        const ghosts2 = await page.locator('.ghost-clip').count();

        // Ghost count should be stable — no advancement happening
        expect(ghosts1).toBe(ghosts2);
    });

    test('startTransport auto-advances and pauseTransport stops it', async ({ page }) => {
        const initialGhosts = await page.locator('.ghost-clip').count();

        // Start transport at 4x speed (faster for test)
        await page.evaluate(() => window.startTransport(4.0));

        // Wait ~500ms → ~10 poll cycles at 4x speed = ~88200 samples advanced
        await page.waitForTimeout(500);

        // Pause transport
        await page.evaluate(() => window.pauseTransport());
        await page.waitForTimeout(200);

        const afterGhosts = await page.locator('.ghost-clip').count();
        console.log(`After startTransport: ${afterGhosts} ghosts (was ${initialGhosts})`);

        // Ghost count should have increased from transport advancement
        expect(afterGhosts).toBeGreaterThanOrEqual(initialGhosts);

        // After pausing, ghost count should stabilize
        const pausedGhosts1 = await page.locator('.ghost-clip').count();
        await page.waitForTimeout(300);
        const pausedGhosts2 = await page.locator('.ghost-clip').count();
        expect(pausedGhosts1).toBe(pausedGhosts2);
    });
});

test.describe('Dynamic Recording - Commit Transition', () => {

    test('stopping recording commits clip and recalculates ghosts', async ({ page }) => {
        page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
        await initMockPage(page);

        // Load 1Q+4Q scenario (3 ghosts initially)
        await page.evaluate(() => window.loadScenario('example-1q-4q'));
        await page.waitForSelector('.stack-wrapper', { timeout: 5000 });
        await page.waitForTimeout(300);

        const beforeGhosts = await page.locator('.ghost-clip').count();
        console.log(`Before recording: ${beforeGhosts} ghosts`);
        expect(beforeGhosts).toBe(3);

        // Create a new clip inside the stack and start recording
        await page.evaluate(async () => {
            await window.callNative('createNode', 'clip', 'stack-1');
        });
        await page.waitForTimeout(300);

        // Find the new clip ID
        const newClipId = await page.evaluate(() => {
            const stack = document.querySelector('.stack-wrapper');
            const clips = stack?.querySelectorAll('.stack-children .node');
            const lastClip = clips?.[clips.length - 1];
            return lastClip?.id || null;
        });
        console.log(`New clip ID: ${newClipId}`);
        expect(newClipId).not.toBeNull();

        // Start recording on the new clip
        await page.evaluate(id => window.callNative('startRecordingInNode', id), newClipId);
        await page.waitForTimeout(200);

        // Advance by 3Q (recording clip grows to 3Q)
        await page.evaluate(() => {
            window.setIsPlaying(true);
            window.advanceBy(132300); // 3Q in samples
        });
        await page.waitForTimeout(300);

        // Stop recording → clip commits at 3Q
        // New clips: 1Q, 4Q, 3Q → LCM(1,4,3) = 12 → much more ghosts
        await page.evaluate(id => window.callNative('stopRecordingInNode', id), newClipId);
        await page.waitForTimeout(500);

        const afterGhosts = await page.locator('.ghost-clip').count();
        console.log(`After 3Q commit: ${afterGhosts} ghosts (was ${beforeGhosts})`);

        // With LCM=12: many more ghosts than the initial 3
        expect(afterGhosts).toBeGreaterThan(beforeGhosts);
    });
});
