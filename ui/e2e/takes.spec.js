/**
 * Takes and comping e2e (docs/takes.md §6), against the mock:
 *  - ● on a committed clip is a NEW TAKE: the retake lifecycle (silent
 *    tiles under a live take), and the lane ends with `T2/2`;
 *  - the take list selects and deletes (never the last take); the comp
 *    editor lands ONE setComp per cell click; ⌘Z steps back through each;
 *  - the comp editor's sound cursor.
 */

import { test, expect } from '@playwright/test';
import { boot, mock, call, node, quantum, laneOf, undo } from './helpers.js';

const CLIP = 'clip-1';   // Clip A: 2Q at origin 0

/** Clip A with a second take committed through the backend: newTake arms
 * at the slot top (the transport sits there), and one period of "audio"
 * finishes it. Answers Q. */
async function twoTakes(page) {
    const Q = await quantum(page);
    await call(page, 'newTake', CLIP);
    await mock(page, 'advanceBy', 2 * Q);
    await expect.poll(async () => (await node(page, CLIP)).takes).toBe(2);
    await expect(laneOf(page, CLIP).locator('.take-btn')).toHaveText('T2/2');
    return Q;
}

test.describe('Takes and comping', () => {

    test.beforeEach(async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
    });

    test('● on a committed clip records a NEW TAKE; the lane ends with T2/2', async ({ page }) => {
        const lane = laneOf(page, CLIP);
        const arm = lane.locator('.arm-btn');
        // A committed clip's ● is enabled and means NEW TAKE; with one
        // take the take chip is quiet.
        await expect(arm).toBeEnabled();
        await expect(arm).toHaveAttribute('title', /new take/i);
        await expect(arm).toHaveClass(/\bretake\b/);
        await expect(lane.locator('.take-btn')).toHaveClass(/\bquiet\b/);

        await arm.click();
        // The retake: the slot is live (the sub-line pulses) and its
        // resting tiles stay beneath, SILENT (dimmed). The clock is held
        // there: the take's one period is advanced by hand below.
        await expect(lane.locator('.rail-sub')).toHaveClass(/\brecording\b/);
        await mock(page, 'pauseTransport');
        await expect.poll(async () => (await node(page, CLIP)).isRecording).toBe(true);
        await expect.poll(() => lane.locator('.rep.silent').count()).toBeGreaterThan(0);
        await expect(page.locator('#log-line')).toHaveText(/new take/i);
        await expect(arm).toHaveAttribute('title', /cancel/i);

        // One period of audio: the take finishes itself and is active.
        await mock(page, 'advanceBy', 2 * await quantum(page));
        await expect.poll(async () => {
            const c = await node(page, CLIP);
            return c.isRecording + ':' + c.takes + ':' + c.activeTake;
        }).toBe('false:2:1');
        await expect(lane.locator('.take-btn')).toHaveText('T2/2');
        await expect(lane.locator('.take-btn')).not.toHaveClass(/\bquiet\b/);
        await expect(lane.locator('.rep.silent')).toHaveCount(0);
        await expect(lane.locator('.rep:not(.ghost)')).toHaveCount(1);
        // The slot's facts stand: the same period on the rail.
        await expect(lane.locator('.rail-sub')).toHaveText('2Q');
        await expect(arm).toBeEnabled();
    });

    test('the take list selects and deletes (never the last); the comp editor cycles cells, one setComp a click; ⌘Z steps back through each', async ({ page }) => {
        await twoTakes(page);
        const lane = laneOf(page, CLIP);
        const body = lane.locator('.lane-body');
        const chip = lane.locator('.take-btn');
        const menu = lane.locator('.take-menu');
        const clip = () => node(page, CLIP);

        await test.step('the list: select take 1, delete take 2, ⌘Z', async () => {
            await chip.click();
            await expect(menu).toBeVisible();
            await expect(menu.locator('.take-item')).toHaveCount(2);
            await expect(menu.locator('.take-item[data-take="1"]')).toHaveClass(/\bcurrent\b/);
            await expect(menu.locator('.take-item .take-wave')).toHaveCount(2);
            // Take 1 (index 0) picked: the chip and the backend follow.
            await menu.locator('.take-item[data-take="0"] .take-pick').click();
            await expect(menu).toHaveCount(0);
            await expect.poll(async () => (await clip()).activeTake).toBe(0);
            await expect(chip).toHaveText('T1/2');
            // Take 2 deleted: one take left, the chip goes quiet.
            await chip.click();
            await menu.locator('.take-item[data-take="1"] .take-delete').click();
            await expect.poll(async () => (await clip()).takes).toBe(1);
            await expect(chip).toHaveText('T1');
            await expect(chip).toHaveClass(/\bquiet\b/);
            // The last take never deletes: its × is disabled. Escape
            // closes the list.
            await chip.click();
            await expect(menu.locator('.take-item')).toHaveCount(1);
            await expect(menu.locator('.take-delete')).toBeDisabled();
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            // The deletion was one undo step, the selection another.
            await undo(page);
            await expect.poll(async () => (await clip()).takes).toBe(2);
            await expect(chip).toHaveText('T1/2');
            await undo(page);
            await expect.poll(async () => (await clip()).activeTake).toBe(1);
            await expect(chip).toHaveText('T2/2');
        });

        await test.step('comp mode: a 2Q slot is two Q cells; a click cycles one, tints and badges it', async () => {
            const comp = async () => (await clip()).comp;
            expect(await comp()).toEqual([]);
            await chip.click();
            await menu.locator('.take-comp-row').click();
            await expect(body.locator('.comp-cell.editing')).toHaveCount(2);
            await expect(body.locator('.comp-badge')).toHaveText(['·', '·']);
            await expect(chip).toHaveClass(/\bon\b/);
            await expect(body.locator('.comp-done-chip')).toBeVisible();
            // Both cells sound the active take (take 2). Cell 0: −1 → 0,
            // take 1 sounds there — tinted, badged, ONE commit.
            await body.locator('.comp-cell[data-cell="0"]').click();
            await expect.poll(comp).toEqual([0, -1]);
            await expect(body.locator('.comp-cell[data-cell="0"]')).toHaveClass(/\btint\b/);
            await expect(body.locator('.comp-badge')).toHaveText(['T1', '·']);
            await body.locator('.comp-cell[data-cell="1"]').click();
            await expect.poll(comp).toEqual([0, 0]);
            await expect(body.locator('.comp-badge')).toHaveText(['T1', 'T1']);
            await expect(body.locator('.comp-cell.tint')).toHaveCount(2);
            // ⌘Z reverts exactly one click.
            await undo(page);
            await expect.poll(comp).toEqual([0, -1]);
            await expect(body.locator('.comp-badge')).toHaveText(['T1', '·']);
            // Escape leaves comp mode; the comp stays, and at rest only
            // the cell that names the other take is tinted.
            await page.keyboard.press('Escape');
            await expect(body.locator('.comp-cell.editing')).toHaveCount(0);
            await expect(body.locator('.comp-cell.tint')).toHaveCount(1);
            await expect(chip).not.toHaveClass(/\bon\b/);
            await expect(chip).toHaveClass(/\bcomped\b/);
            expect(await comp()).toEqual([0, -1]);
        });

        await test.step('a comped cell\'s slice sits exactly over the take tile\'s waveform', async () => {
            const slice = body.locator('.comp-cell.tint .comp-slice');
            // Drawn — and sized to its cell — once the other take's
            // peaks have arrived.
            await expect.poll(() => slice.evaluate(c => c.style.width)).not.toBe('');
            const s = await slice.boundingBox();
            const tile = await body.locator('.rep:not(.ghost) canvas').first().boundingBox();
            expect(Math.abs(s.y - tile.y), 'same top').toBeLessThan(0.6);
            expect(Math.abs(s.height - tile.height), 'same height').toBeLessThan(0.6);
        });
    });

    test('the comp editor\'s sound cursor is placed in the patch that builds it', async ({ page }) => {
        const Q = await twoTakes(page);
        await call(page, 'setLoopPoints', CLIP, 0, Q);
        const lane = laneOf(page, CLIP);
        const body = lane.locator('.lane-body');
        await expect(body.locator('.win-heard-chip')).toHaveText(/window 1Q/);
        // Every sound cursor the overlay gains, as it stands when the
        // patch that built it has finished (the transport is stopped: a
        // placed cursor is hidden).
        await body.evaluate(b => {
            window.__cursors = [];
            new MutationObserver(records => {
                for (const r of records) {
                    for (const n of r.addedNodes) {
                        if (n.classList && n.classList.contains('win-cursor')) {
                            window.__cursors.push(
                                { left: n.style.left, display: n.style.display });
                        }
                    }
                }
            }).observe(b.querySelector('.overlay-layer'), { childList: true });
        });
        // Comp mode frames the raw take with its active window: brackets,
        // dims and the window's sound cursor.
        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-comp-row').click();
        await expect(body.locator('.comp-cell.editing')).toHaveCount(2);
        await expect(body.locator('.win-cursor')).toHaveCount(1);
        const seen = await page.evaluate(() => window.__cursors);
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.filter(c => c.display !== 'none' && c.left === ''),
            'never shown before it is placed').toEqual([]);
    });
});
