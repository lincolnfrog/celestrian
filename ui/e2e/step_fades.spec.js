/**
 * PER-STEP FADES — e2e (docs/sequencer.md §15, S13; twins: the "S13"
 * section of sequencer_tests.cc + step_fades.test.mjs). The length
 * chip opens the fades popover; a fade-out on a step whose run ends
 * there shows as a gradient on the gated track's lane.
 */

import { test, expect } from '@playwright/test';

test('the length chip sets a fade-out; the lane shows the ramp; undo clears it', async ({ page }) => {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click('button:has-text("Stack with 3 Clips")');
    await page.waitForSelector('.lane[data-kind="clip"]');
    const group = page.locator('.lane[data-kind="group"]').first();
    const groupId = await group.getAttribute('data-id');
    await group.locator('.seq-btn').click();
    const grid = page.locator('.lane-seq');
    await grid.locator('.seq-start').click();
    await grid.locator('.seq-addstep').click();
    await grid.locator('.seq-addstep').click();
    await expect(grid.locator('.seq-hcell')).toHaveCount(3);
    const seqOf = () => page.evaluate(async id => {
        const st = await window.celestrian.callNative('getGraphState');
        const g = st.nodes.find(n => n.id === id);
        return g ? g.sequence || null : null;
    }, groupId);

    // Gate the first child OFF in step 3: its run is steps 1–2.
    const padRow = grid.locator('.seq-grid-row').nth(1);
    await padRow.locator('.seq-pad').nth(2).click();
    await expect(padRow.locator('.seq-pad').nth(2)).not.toHaveClass(/on/);
    const firstClip = page.locator('.lane[data-kind="clip"]').first();
    await expect(firstClip.locator('.seq-dim')).toHaveCount(1);
    await expect(firstClip.locator('.seq-fade')).toHaveCount(0);

    // Step 2's length chip → the fades popover → fade out 1Q.
    const cell2 = grid.locator('.seq-hcell').nth(1);
    await cell2.locator('.seq-hlen').click();
    const pop = grid.locator('.seq-fade-pop');
    await expect(pop).toHaveCount(1);
    const out = pop.locator('input[data-fade="fadeOut"]');
    await out.fill('1');
    await out.press('Enter');
    const Q = await page.evaluate(async () =>
        (await window.celestrian.callNative('getGraphState')).quantum);
    await expect.poll(async () => (await seqOf())?.steps[1].fadeOut).toBe(Q);
    // The chip marks the fade; the gated lane shows the ramp out.
    await expect(cell2.locator('.seq-hlen')).toHaveText(/◣/);
    await expect(firstClip.locator('.seq-fade.out')).toHaveCount(1);
    // A track gated ON everywhere shows no ramp (constant gain).
    await expect(page.locator('.lane[data-kind="clip"]').nth(1)
        .locator('.seq-fade')).toHaveCount(0);

    // Undo removes the fade (one edit).
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await seqOf())?.steps[1].fadeOut ?? null)
        .toBeNull();
    await expect(firstClip.locator('.seq-fade')).toHaveCount(0);
});
