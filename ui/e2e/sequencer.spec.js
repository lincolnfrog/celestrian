/**
 * THE SEQUENCER — e2e (docs/sequencer.md §9; twins: sequencer_tests.cc
 * + sequence.test.mjs). Drives the pad grid through real pointer input:
 * chip → grid → create → append → gate → lane dims → bypass → undo.
 */

import { test, expect } from '@playwright/test';

async function loadHarness(page, scenario) {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click(`button:has-text("${scenario}")`);
    await page.waitForSelector('.lane[data-kind="clip"]');
}

test.describe('Sequencer (docs/sequencer.md)', () => {
    test('grid lifecycle: create, append, gate, dims, bypass, undo', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        const chip = group.locator('.seq-btn');
        await expect(chip).toHaveText('seq');

        // Open the grid: no sequence yet — the creation affordance.
        await chip.click();
        const grid = page.locator('.lane-seq');
        await expect(grid).toHaveCount(1);
        await grid.locator('.seq-start').click();

        // One step, one pad row per child, everything gated ON.
        await expect(grid.locator('.seq-hcell')).toHaveCount(1);
        await expect(grid.locator('.seq-pad')).toHaveCount(3);
        await expect(grid.locator('.seq-pad.on')).toHaveCount(3);
        await expect(chip).toHaveClass(/on/);
        await expect(chip).toHaveText(/seq·\d/);

        // The engine-shaped state carries the sequence on the group.
        const groupId = await group.getAttribute('data-id');
        const seqOf = () => page.evaluate(async id => {
            const st = await window.celestrian.callNative('getGraphState');
            const g = st.nodes.find(n => n.id === id);
            return g ? g.sequence || null : null;
        }, groupId);
        await expect.poll(async () => (await seqOf())?.steps.length).toBe(1);

        // Append a step: pads double; the total chip grows.
        await grid.locator('.seq-addstep').click();
        await expect(grid.locator('.seq-hcell')).toHaveCount(2);
        await expect(grid.locator('.seq-pad')).toHaveCount(6);
        await expect.poll(async () => (await seqOf())?.steps.length).toBe(2);

        // Gate the FIRST child off in step 2: its pad dims, the state
        // records the row, and the child's LANE shows the dim overlay
        // (the display side — you read the song on the lanes).
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        const firstClipId = await firstClip.getAttribute('data-id');
        const padRow = grid.locator('.seq-grid-row').nth(1);  // first child
        await padRow.locator('.seq-pad').nth(1).click();
        await expect(padRow.locator('.seq-pad').nth(1)).not.toHaveClass(/on/);
        await expect.poll(async () => {
            const s = await seqOf();
            return s && s.gates[firstClipId]
                ? s.gates[firstClipId].join(',') : null;
        }).toBe('true,false');
        await expect(firstClip.locator('.seq-dim')).toHaveCount(1);
        // Other children stay undimmed (absent uuid inherits ON).
        await expect(
            page.locator('.lane[data-kind="clip"]').nth(1)
                .locator('.seq-dim')).toHaveCount(0);

        // Whole-row toggle via the row name (in the RAIL column — the
        // time-honest layout): a mixed row goes all-ON first, then a
        // second click takes it all-OFF, a third restores.
        const rowName = grid.locator('.seq-rowname').nth(0);
        await rowName.click();
        await expect(padRow.locator('.seq-pad.on')).toHaveCount(2);
        await rowName.click();
        await expect(padRow.locator('.seq-pad.on')).toHaveCount(0);
        await rowName.click();
        await expect(padRow.locator('.seq-pad.on')).toHaveCount(2);

        // Bypass: the jam comes back — dims drop, geometry survives.
        await grid.locator('.seq-bypass').click();
        await expect(chip).toHaveClass(/bypassed/);
        await expect(firstClip.locator('.seq-dim')).toHaveCount(0);
        await expect(grid.locator('.seq-hcell')).toHaveCount(2);
        await expect.poll(async () => (await seqOf())?.bypassed).toBe(true);

        // Undo re-activates (toggle is undoable).
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(async () => (await seqOf())?.bypassed).toBe(false);
        await expect(chip).toHaveClass(/on/);
    });

    test('period law in the frame: the song IS the readout cycle', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        const groupId = await group.getAttribute('data-id');
        // Two 3Q steps = a 6Q song; the group contributes 6Q to the
        // frame (docs/sequencer.md §2 — the period law).
        await page.evaluate(async id => {
            const c = window.celestrian;
            const st = await c.callNative('getGraphState');
            // Scenario fixtures predate the stored-Q field (state.quantum
            // is 0 there) — the per-node declaration carries the rate.
            const g = st.nodes.find(n => n.id === id);
            const Q = st.quantum ||
                (g.nodes && g.nodes[0] && g.nodes[0].effectiveQuantum) ||
                44100;
            await c.callNative('setSequence', id, {
                steps: [{ name: 'a', len: 3 * Q }, { name: 'b', len: 3 * Q }],
                gates: {},
            });
        }, groupId);
        await expect(page.locator('#position-readout'))
            .toContainText('6Q', { timeout: 3000 });
    });

    test('ROOT sequencer: loose top-level tracks get the transport chip', async ({ page }) => {
        // The owner's field report (2026-08-20): two loose clips, no
        // group anywhere — the sequencer must still be reachable. The
        // session root's chip lives in the transport; its grid opens
        // as the first row over the top-level tracks. Record two LOOSE
        // takes (every scenario fixture wraps clips in a stack).
        await page.goto('/index_test.html');
        await page.waitForSelector('#test-controls', { timeout: 5000 });
        await page.click('button:has-text("Empty Canvas")');
        await page.evaluate(async () => {
            const t = window.celestrian;
            const rec = async (len, first) => {
                const id = await t.callNative('createNode', 'clip', '');
                await t.callNative('startRecordingInNode', id);
                t.advanceBy(first ? len : len - 100);
                await t.callNative('stopRecordingInNode', id);
                if (!first) t.advanceBy(200);
            };
            await rec(44100, true);      // the 1Q definer
            await rec(2 * 44100, false); // a 2Q take
        });
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
        const chip = page.locator('#root-seq-btn');
        await expect(chip).toBeVisible();
        await expect(chip).toHaveText('seq');

        await chip.click();
        const grid = page.locator('.lane-seq');
        await expect(grid).toHaveCount(1);
        // The grid is the FIRST row, and its rows are the top-level
        // tracks (2 clips in this scenario).
        await expect(page.locator('#lanes > .lane').first())
            .toHaveClass(/lane-seq/);
        await grid.locator('.seq-start').click();
        await expect(grid.locator('.seq-pad')).toHaveCount(2);
        await expect(chip).toHaveClass(/on/);
        await expect(chip).toHaveText(/seq·\d/);

        // Append + gate the first track off in step 2: its lane dims.
        await grid.locator('.seq-addstep').click();
        await grid.locator('.seq-grid-row').nth(1).locator('.seq-pad')
            .nth(1).click();
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await expect(firstClip.locator('.seq-dim')).toHaveCount(1);

        // Bypass from the grid footer: the transport chip strikes.
        await grid.locator('.seq-bypass').click();
        await expect(chip).toHaveClass(/bypassed/);
        // Close the grid: the chip keeps reporting the sequence.
        await chip.click();
        await expect(page.locator('.lane-seq')).toHaveCount(0);
        await expect(chip).toHaveText(/seq·\d/);
    });

    test('rename a step inline; delete via right-click; last delete clears', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        await group.locator('.seq-btn').click();
        const grid = page.locator('.lane-seq');
        await grid.locator('.seq-start').click();
        await grid.locator('.seq-addstep').click();
        await expect(grid.locator('.seq-hcell')).toHaveCount(2);

        // Rename step 2.
        await grid.locator('.seq-hcell').nth(1).locator('.seq-hname')
            .dblclick();
        const input = grid.locator('.seq-hname-input');
        await input.fill('chorus');
        await input.press('Enter');
        await expect(grid.locator('.seq-hcell').nth(1)).toContainText('chorus');

        // Right-click deletes a step.
        await grid.locator('.seq-hcell').nth(1)
            .click({ button: 'right' });
        await expect(grid.locator('.seq-hcell')).toHaveCount(1);

        // Deleting the last step clears the sequence: the creation
        // affordance returns and the chip goes ghost.
        await grid.locator('.seq-hcell').first().click({ button: 'right' });
        await expect(grid.locator('.seq-start')).toHaveCount(1);
        await expect(group.locator('.seq-btn')).toHaveText('seq');
    });
});
