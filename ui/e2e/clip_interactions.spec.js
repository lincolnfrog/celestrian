/**
 * Clip Interaction Tests
 * 
 * Tests clip interactions: buttons, drag/drop, rename.
 * Run with: npm run test:playwright
 */

import { test, expect } from '@playwright/test';

test.describe('Clip Interactions', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Stack with 3 Clips")');
        await page.waitForSelector('.stack-children .node', { timeout: 5000 });
    });

    test('mute button is visible and clickable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const muteBtn = firstClip.locator('.node-btn-mute');

        // Verify mute button exists and is visible
        await expect(muteBtn).toBeVisible();

        // Verify it's clickable (doesn't throw)
        await muteBtn.click();

        // Button should still be visible after click
        await expect(muteBtn).toBeVisible();
    });

    test('solo button is visible and clickable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const soloBtn = firstClip.locator('.node-btn-solo');

        // Verify solo button exists and is visible
        await expect(soloBtn).toBeVisible();

        // Verify it's clickable (doesn't throw)
        await soloBtn.click();

        // Button should still be visible after click
        await expect(soloBtn).toBeVisible();
    });

    // Drops now reach the real mock handlers through the backend facade
    // (P2-9), so these tests assert actual persistence, not just "no crash".
    // Drop-zone semantics (drag_drop.js getDropZone): top/bottom thirds of a
    // clip reorder around it; the center third combines into a nested stack.

    test('drag reorders clips within stack', async ({ page }) => {
        const clipIds = () => page.locator('.stack-children .node')
            .evaluateAll(els => els.map(e => e.id));
        expect(await clipIds()).toEqual(['clip-1', 'clip-2', 'clip-3']);

        const grabHandle = page.locator('#clip-1 .grab-handle');
        await expect(grabHandle).toBeVisible();
        const handleBox = await grabHandle.boundingBox();
        const clip2Box = await page.locator('#clip-2').boundingBox();

        // Drop in the BOTTOM third of clip-2 → insert after it
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(clip2Box.x + clip2Box.width / 2,
            clip2Box.y + clip2Box.height * 0.85, { steps: 5 });
        await page.waitForTimeout(200);
        await page.mouse.up();

        // Backend state is the source of truth: order persisted as 2,1,3
        await expect.poll(() => page.evaluate(() =>
            window.celestrian.getState().nodes
                .find(n => n.id === 'stack-1').nodes.map(n => n.id)
        ), { timeout: 3000 }).toEqual(['clip-2', 'clip-1', 'clip-3']);

        // And the DOM shows all 3 clips in the new order
        await expect.poll(clipIds, { timeout: 3000 })
            .toEqual(['clip-2', 'clip-1', 'clip-3']);
    });

    test('drag onto a clip center combines into a nested stack', async ({ page }) => {
        const grabHandle = page.locator('#clip-1 .grab-handle');
        await expect(grabHandle).toBeVisible();
        const handleBox = await grabHandle.boundingBox();
        const clip2Box = await page.locator('#clip-2').boundingBox();

        // Drop in the CENTER third of clip-2 → combine into a nested stack
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(clip2Box.x + clip2Box.width / 2,
            clip2Box.y + clip2Box.height * 0.5, { steps: 5 });
        await page.waitForTimeout(200);
        await page.mouse.up();

        // Backend state: stack-1 now holds [nested stack, clip-3], and the
        // nested stack holds [clip-2, clip-1] (target first, then dragged)
        await expect.poll(() => page.evaluate(() => {
            const stack = window.celestrian.getState().nodes
                .find(n => n.id === 'stack-1');
            return stack.nodes.map(n =>
                n.type === 'stack' ? `stack[${(n.nodes || []).map(c => c.id).join(',')}]` : n.id);
        }), { timeout: 3000 }).toEqual(['stack[clip-2,clip-1]', 'clip-3']);
    });

    test('clip name input is editable', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();
        const nameInput = firstClip.locator('.node-name-input');

        // Verify input exists
        await expect(nameInput).toBeVisible();

        // Focus and change name
        await nameInput.click();
        await nameInput.fill('Renamed Clip');
        await nameInput.press('Enter');

        // Verify name changed
        const newName = await nameInput.inputValue();
        expect(newName).toBe('Renamed Clip');
    });

    test('clip header shows expected control buttons', async ({ page }) => {
        const firstClip = page.locator('.stack-children .node').first();

        // Verify mute and solo buttons exist
        await expect(firstClip.locator('.node-btn-mute')).toBeVisible();
        await expect(firstClip.locator('.node-btn-solo')).toBeVisible();
    });

    test('center-zone drag shows combine highlight', async ({ page }) => {
        // Get clips
        const clips = page.locator('.stack-children .node');
        const firstClip = clips.nth(0);
        const secondClip = clips.nth(1);
        const grabHandle = firstClip.locator('.grab-handle');

        await expect(grabHandle).toBeVisible();

        const handleBox = await grabHandle.boundingBox();
        const secondClipBox = await secondClip.boundingBox();
        if (!handleBox || !secondClipBox) throw new Error('Elements not found');

        // Drag first clip to center of second clip (center zone = combine)
        const centerY = secondClipBox.y + secondClipBox.height / 2;

        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, centerY);
        await page.waitForTimeout(100);

        // Check that second clip has combine highlight class
        const hasHighlight = await secondClip.evaluate(el => el.classList.contains('drop-zone-center'));
        expect(hasHighlight).toBe(true);

        // Release without completing the drop
        await page.mouse.up();
    });
});
