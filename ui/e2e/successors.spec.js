/**
 * THE ROOT SEQUENCER, SUCCESSOR GRAPHS + THE SEED — e2e (docs/
 * sequencer.md §9, §14; twins: the "SUCCESSORS" section of
 * sequencer_tests.cc + successors.test.mjs). Real pointer input on the
 * root's grid — loose top-level tracks, no group anywhere — where a
 * radio may live, and on a nested group's, which refuses one.
 */

import { test, expect } from '@playwright/test';
import {
    boot, seqOf, quantum, laneOf, undo, recordDefinerAndTake,
} from './helpers.js';

/** Resolve once the page's next `verb` call has reached the mock (it
 * logs every call), whatever it answers. */
const nextCall = (page, verb) => page.waitForEvent('console',
    msg => msg.text().includes(`[MockBackend] callNative: ${verb}`));

test.describe('Successors + the seed (docs/sequencer.md §14)', () => {
    test('the root grid over loose tracks; its → popover branches the song into a radio; re-roll; undo', async ({ page }) => {
        // Two loose takes: a 1Q loop and a 2Q take.
        await boot(page);
        await recordDefinerAndTake(page, await quantum(page), 2);
        const clips = page.locator('.lane[data-kind="clip"]');
        await expect(clips).toHaveCount(2);
        const chip = page.locator('#root-seq-btn');
        const grid = page.locator('.lane-seq');
        const song = () => seqOf(page);

        await test.step('the session\'s own song: its chip is by the ruler, its grid the first row over the top-level tracks', async () => {
            await expect(chip).toBeVisible();
            await expect(chip).toHaveText('seq');
            await chip.click();
            await expect(grid).toHaveCount(1);
            await expect(page.locator('#lanes > .lane').first()).toHaveClass(/lane-seq/);
            await grid.locator('.seq-start').click();
            await expect(grid.locator('.seq-pad')).toHaveCount(2);
            await expect(chip).toHaveClass(/\bon\b/);
            await expect(chip).toHaveText(/seq·\d/);
            await grid.locator('.seq-addstep').click();
            await grid.locator('.seq-addstep').click();
            await expect(grid.locator('.seq-hcell')).toHaveCount(3);
            // The first track gated off in step 2: its lane dims.
            await grid.locator('.seq-grid-row').nth(1).locator('.seq-pad').nth(1).click();
            await expect(clips.first().locator('.seq-dim')).toHaveCount(1);
            // Bypassed from the grid's footer the chip strikes; with the
            // grid closed it still reports the song.
            await grid.locator('.seq-bypass').click();
            await expect(chip).toHaveClass(/bypassed/);
            await chip.click();
            await expect(grid).toHaveCount(0);
            await expect(chip).toHaveText(/seq·\d/);
            await chip.click();
            await grid.locator('.seq-bypass').click();
            await expect(chip).not.toHaveClass(/bypassed/);
        });

        await test.step('a second successor on the last step is a branch with chance: a radio', async () => {
            await expect(grid.locator('.seq-radio')).toHaveCount(0);
            // The last step's default successor is the first step (the
            // loop); the second step joins it as a candidate.
            const last = grid.locator('.seq-hcell').nth(2);
            await last.hover();
            await last.locator('.seq-next').click();
            const pop = grid.locator('.seq-next-pop');
            await expect(pop).toHaveCount(1);
            await expect(pop.locator('.seq-next-opt.on')).toHaveCount(1);
            await pop.locator('.seq-next-add[data-to="1"]').click();
            await expect.poll(async () => (await song()).radio).toBe(true);
            await expect.poll(async () => (await song()).steps[2].next?.length).toBe(2);
            // A radio's grid shows the GRAPH — one column per step (its
            // run would be hundreds of slivers) — with the radio badge
            // and the last step's pip lit; the frame is the whole run.
            await expect(grid.locator('.seq-radio')).toHaveCount(1);
            await expect(grid.locator('.seq-hcell')).toHaveCount(3);
            await expect(grid.locator('.seq-next.on')).toHaveCount(1);
            await expect(chip).toHaveText(/seq·\d{3,}/);
        });

        await test.step('re-roll: a new seed, a new run, one undo step; a second undo takes the branch back', async () => {
            const { seed, program } = await song();
            const run = program.join(',');
            await grid.locator('.seq-reroll').click();
            await expect.poll(async () => (await song()).seed).not.toBe(seed);
            await expect.poll(async () => (await song()).program.join(',')).not.toBe(run);
            await undo(page);
            await expect.poll(async () => (await song()).seed).toBe(seed);
            await expect.poll(async () => (await song()).program.join(',')).toBe(run);
            await undo(page);
            await expect.poll(async () => (await song()).radio).toBe(false);
            await expect(grid.locator('.seq-hcell')).toHaveCount(3);
            await expect(grid.locator('.seq-radio')).toHaveCount(0);
        });
    });

    test('a nested group refuses a radio; an orphan step waits in the footer', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        await laneOf(page, 'stack-1').locator('.seq-btn').click();
        const grid = page.locator('.lane-seq');
        await grid.locator('.seq-start').click();
        await grid.locator('.seq-addstep').click();
        await grid.locator('.seq-addstep').click();
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        const song = () => seqOf(page, 'stack-1');
        const first = grid.locator('.seq-hcell').nth(0);
        const last = grid.locator('.seq-hcell').nth(2);
        const pop = grid.locator('.seq-next-pop');
        /** Open `cell`'s → popover and click `option` in it; resolves
         * once the edit has reached the backend. */
        const choose = async (cell, option) => {
            await cell.hover();
            await cell.locator('.seq-next').click();
            const sent = nextCall(page, 'setSequence');
            await pop.locator(option).click();
            await sent;
        };

        // Step 3 → ONLY step 2 (never back to the top) is an intro: a
        // radio, refused nested. The song stays the plain loop, and the
        // grid settles back on three columns with no radio badge.
        await choose(last, '.seq-next-opt[data-to="1"]');
        expect((await song()).steps[2].next ?? null).toBeNull();
        await expect(grid.locator('.seq-radio')).toHaveCount(0);
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        // A branch (step 1 → 2 or 3) is a radio too: refused nested.
        await choose(first, '.seq-next-add[data-to="2"]');
        expect((await song()).steps[0].next ?? null).toBeNull();
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);

        // A periodic jump (step 1 → ONLY 3, 3 → 1) leaves step 2 an
        // ORPHAN: no column, a footer chip; a right-click deletes it.
        await choose(first, '.seq-next-opt[data-to="2"]');
        await expect.poll(async () => (await song()).program.join(',')).toBe('0,2');
        await expect(grid.locator('.seq-hcell')).toHaveCount(2);
        await expect(grid.locator('.seq-orphan')).toHaveCount(1);
        await grid.locator('.seq-orphan').click({ button: 'right' });
        await expect.poll(async () => (await song()).steps.length).toBe(2);
        await expect(grid.locator('.seq-orphan')).toHaveCount(0);
        // The edge that pointed past the deleted step re-indexed: the
        // first step still names the (now second) step.
        await expect.poll(async () => (await song()).program.join(',')).toBe('0,1');
    });
});
