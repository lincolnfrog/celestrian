/**
 * PER-STEP FADES — e2e (docs/sequencer.md §15; twins: the "S13" section
 * of sequencer_tests.cc + step_fades.test.mjs). The length chip opens
 * the fades popover; a fade-out on a step whose run ends there shows as
 * a gradient on the gated track's lane.
 */

import { test, expect } from '@playwright/test';
import { boot, call, root, seqOf, laneOf, centreOf, undo } from './helpers.js';

const STACK = 'stack-1';

/** 'stack-with-clips' with a three-step song on its group, the grid
 * open. `step(i)` reads a step from the backend; `Q` is the island's. */
async function threeStepGrid(page) {
    await boot(page, { scenario: 'stack-with-clips' });
    await laneOf(page, STACK).locator('.seq-btn').click();
    const grid = page.locator('.lane-seq');
    await grid.locator('.seq-start').click();
    await grid.locator('.seq-addstep').click();
    await grid.locator('.seq-addstep').click();
    await expect(grid.locator('.seq-hcell')).toHaveCount(3);
    const step = async i => (await seqOf(page, STACK)).steps[i];
    return { grid, step, Q: (await root(page)).quantum };
}

test('the length chip sets a fade-out; the lane shows the ramp; undo clears it', async ({ page }) => {
    const { grid, step, Q } = await threeStepGrid(page);
    const clips = page.locator('.lane[data-kind="clip"]');

    // The first child gated OFF in step 3: its run is steps 1–2.
    const pad = grid.locator('.seq-grid-row').nth(1).locator('.seq-pad').nth(2);
    await pad.click();
    await expect(pad).not.toHaveClass(/\bon\b/);
    await expect(clips.first().locator('.seq-dim')).toHaveCount(1);
    await expect(clips.first().locator('.seq-fade')).toHaveCount(0);

    // Step 2's length chip → the fades popover → fade out 1Q.
    const chip = grid.locator('.seq-hcell').nth(1).locator('.seq-hlen');
    await chip.click();
    const out = grid.locator('.seq-fade-pop input[data-fade="fadeOut"]');
    await out.fill('1');
    await out.press('Enter');
    await expect.poll(async () => (await step(1)).fadeOut).toBe(Q);
    // The chip marks the fade; the gated lane shows the ramp out, and a
    // track gated ON everywhere (a constant gain) shows none.
    await expect(chip).toHaveText(/◣/);
    await expect(clips.first().locator('.seq-fade.out')).toHaveCount(1);
    await expect(clips.nth(1).locator('.seq-fade')).toHaveCount(0);

    // One edit: undo removes the fade.
    await undo(page);
    await expect.poll(async () => (await step(1)).fadeOut ?? null).toBeNull();
    await expect(clips.first().locator('.seq-fade')).toHaveCount(0);
});

test('both fades in one visit: the popover stays open through its own commits', async ({ page }) => {
    const { grid, step, Q } = await threeStepGrid(page);
    const chip = grid.locator('.seq-hcell').nth(1).locator('.seq-hlen');
    await chip.click();
    const pop = grid.locator('.seq-fade-pop');
    await expect(pop).toHaveCount(1);
    // Fade in, then Tab to the next field: the first one commits…
    await pop.locator('input[data-fade="fadeIn"]').fill('0.5');
    await page.keyboard.press('Tab');
    await expect.poll(async () => (await step(1)).fadeIn).toBe(Q / 2);
    // …the grid redraws with its marker, and the popover is still up,
    // on the same step, the next field ready to type in.
    await expect(chip).toHaveText(/◢/);
    await expect(pop).toHaveCount(1);
    await expect(pop).toHaveAttribute('data-step', '1');
    await expect(pop.locator('input[data-fade="fadeIn"]')).toHaveValue('0.5');
    await expect(pop.locator('input[data-fade="fadeOut"]')).toBeFocused();
    await page.keyboard.type('1');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await step(1)).fadeOut).toBe(Q);
    expect((await step(1)).fadeIn).toBe(Q / 2);
    await expect(chip).toHaveText(/◢.*◣/);
    await expect(pop).toHaveCount(1);
    // A press outside closes it.
    await page.locator('#ruler').click({ position: { x: 5, y: 5 } });
    await expect(pop).toHaveCount(0);
});

test('a grip press that resizes nothing leaves the step\'s fade markers on its chip', async ({ page }) => {
    const { grid, step, Q } = await threeStepGrid(page);
    const { steps, gates, seed } = await seqOf(page, STACK);
    steps[1].fadeOut = Q;
    await call(page, 'setSequence', STACK, { steps, gates: gates || {}, seed: seed || 0 });
    const cell = grid.locator('.seq-hcell').nth(1);
    const chip = cell.locator('.seq-hlen');
    await expect(chip).toHaveText(/◣/);
    const text = await chip.textContent();
    const len = (await step(1)).len;
    // Press the grip, wobble a few px, let go where it started.
    const at = await centreOf(cell.locator('.seq-grip'));
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 3, at.y);
    await page.mouse.move(at.x, at.y);
    await page.mouse.up();
    expect((await step(1)).len).toBe(len);
    await expect(chip).toHaveText(text);
});
