/**
 * SUCCESSOR GRAPHS + THE SEED — e2e (docs/sequencer.md §14; twins:
 * the "SUCCESSORS" section of sequencer_tests.cc + successors.test.mjs).
 * Drives the → popover and the re-roll through real pointer input on
 * the ROOT sequencer (a radio is root-only), and checks that a nested
 * group refuses one.
 */

import { test, expect } from '@playwright/test';

/** Two loose takes on an empty session (the root-grid idiom). */
async function looseTakes(page) {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click('button:has-text("Empty session")');
    await page.evaluate(async () => {
        const t = window.celestrian;
        const rec = async (len, first) => {
            const id = await t.callNative('createNode', 'clip', '');
            await t.callNative('startRecordingInNode', id);
            t.advanceBy(first ? len : len - 100);
            await t.callNative('stopRecordingInNode', id);
            if (!first) t.advanceBy(200);
        };
        await rec(44100, true);
        await rec(2 * 44100, false);
    });
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
}

const rootSeq = page => page.evaluate(async () => {
    const st = await window.celestrian.callNative('getGraphState');
    return st.sequence || null;
});

test.describe('Successors + the seed (docs/sequencer.md §14)', () => {
    test('→ popover branches the root song into a radio; re-roll; undo', async ({ page }) => {
        await looseTakes(page);
        const chip = page.locator('#root-seq-btn');
        await chip.click();
        const grid = page.locator('.lane-seq');
        await grid.locator('.seq-start').click();
        await grid.locator('.seq-addstep').click();
        await grid.locator('.seq-addstep').click();
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        await expect(grid.locator('.seq-radio')).toHaveCount(0);

        // Open the successors popover on the LAST step: its default
        // successor is the first step (the loop). Add the second step
        // as another candidate: a branch with chance = a radio.
        const last = grid.locator('.seq-hcell').nth(2);
        await last.hover();
        await last.locator('.seq-next').click();
        const pop = grid.locator('.seq-next-pop');
        await expect(pop).toHaveCount(1);
        await expect(pop.locator('.seq-next-opt.on')).toHaveCount(1);
        await pop.locator('.seq-next-add[data-to="1"]').click();  // + B
        await expect.poll(async () => (await rootSeq(page))?.radio).toBe(true);
        await expect.poll(async () => (await rootSeq(page))?.steps[2].next?.length)
            .toBe(2);
        // A radio's grid shows the GRAPH (one column per step — the
        // horizon would be hundreds of slivers), the radio badge, and
        // the last step's pip lit; the FRAME is the whole program.
        await expect(grid.locator('.seq-radio')).toHaveCount(1);
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        await expect(grid.locator('.seq-next.on')).toHaveCount(1);
        await expect(page.locator('#root-seq-btn')).toHaveText(/seq·\d{3,}/);

        // Re-roll: a new seed, a new run, one undo step.
        const seedBefore = (await rootSeq(page)).seed;
        const runBefore = (await rootSeq(page)).program.join(',');
        await grid.locator('.seq-reroll').click();
        await expect.poll(async () => (await rootSeq(page))?.seed).not.toBe(seedBefore);
        await expect.poll(async () => (await rootSeq(page))?.program.join(','))
            .not.toBe(runBefore);
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(async () => (await rootSeq(page))?.seed).toBe(seedBefore);
        await expect.poll(async () => (await rootSeq(page))?.program.join(','))
            .toBe(runBefore);

        // Undo the branch: the song is a plain loop again.
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(async () => (await rootSeq(page))?.radio).toBe(false);
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        await expect(grid.locator('.seq-radio')).toHaveCount(0);
    });

    test('a nested group refuses a radio; an orphan step waits in the footer', async ({ page }) => {
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

        // Step 3 -> ONLY step 2 (never back to the top): an intro, a
        // radio — refused nested. The state keeps the plain loop, and
        // the grid settles back to three columns with no radio badge.
        const last = grid.locator('.seq-hcell').nth(2);
        await last.hover();
        await last.locator('.seq-next').click();
        const pop = grid.locator('.seq-next-pop');
        await pop.locator('.seq-next-opt[data-to="1"]').click();  // only B
        await page.waitForTimeout(200);
        expect((await seqOf())?.steps[2].next ?? null).toBeNull();
        await expect(grid.locator('.seq-radio')).toHaveCount(0);
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);
        // A branch (A -> B or C) is a radio too: refused nested.
        const first = grid.locator('.seq-hcell').nth(0);
        await first.hover();
        await first.locator('.seq-next').click();
        await pop.locator('.seq-next-add[data-to="2"]').click();  // + C
        await page.waitForTimeout(200);
        expect((await seqOf())?.steps[0].next ?? null).toBeNull();
        await expect(grid.locator('.seq-hcell')).toHaveCount(3);

        // A periodic jump (A -> ONLY C, C -> A) leaves B an ORPHAN: no
        // column, a footer chip; right-click deletes it.
        await first.hover();
        await first.locator('.seq-next').click();
        await pop.locator('.seq-next-opt[data-to="2"]').click();  // only C
        await expect.poll(async () => (await seqOf())?.program.join(','))
            .toBe('0,2');
        await expect(grid.locator('.seq-hcell')).toHaveCount(2);
        await expect(grid.locator('.seq-orphan')).toHaveCount(1);
        await grid.locator('.seq-orphan').click({ button: 'right' });
        await expect.poll(async () => (await seqOf())?.steps.length).toBe(2);
        await expect(grid.locator('.seq-orphan')).toHaveCount(0);
        // The edge that pointed past the deleted step re-indexed: the
        // first step still names the (now second) step.
        await expect.poll(async () => (await seqOf())?.program.join(','))
            .toBe('0,1');
    });
});
