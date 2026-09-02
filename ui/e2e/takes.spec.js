/**
 * Takes and comping e2e (docs/takes.md §6), against the mock: the
 * three flows the UI half owes —
 *  (i)   ● on a committed clip is a NEW TAKE: the mock shows the retake
 *        lifecycle (silent tiles under a live take) and the lane ends
 *        with `T2/2`;
 *  (ii)  the take list: open, select take 1, delete take 2 (the last
 *        take's × is disabled), ⌘Z brings the take back;
 *  (iii) the comp editor: comp mode, two cell clicks land ONE setComp
 *        each on the mock's `comp`, badges follow, ⌘Z reverts one
 *        click, Escape leaves the tint at rest.
 */

import { test, expect } from '@playwright/test';

/** The mock's quantum (1 s of audio at its published rate). */
async function mockQ(page) {
    return page.evaluate(async () =>
        (await window.__celestrianTest.callNative('getGraphState')).perf.sampleRate);
}

/** The published state of one clip (depth-first by id). */
const clipState = (page, id) => page.evaluate(async id => {
    const state = await window.__celestrianTest.callNative('getGraphState');
    const find = nodes => {
        for (const n of nodes || []) {
            if (n.id === id) return n;
            const hit = find(n.nodes);
            if (hit) return hit;
        }
        return null;
    };
    return find(state.nodes);
}, id);

/** Clip A (2Q at origin 0, Q = 1 s) with a second take committed
 *  through the backend: newTake arms at the slot top (the transport
 *  sits at 0 ≡ origin), one period of "audio" auto-finishes it. */
async function twoTakes(page) {
    await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
    await expect(page.locator('.lane[data-id="clip-1"]')).toBeVisible();
    await page.evaluate(async Q => {
        const t = window.__celestrianTest;
        await t.callNative('newTake', 'clip-1');
        t.advanceBy(2 * Q);
    }, await mockQ(page));
    await expect.poll(async () => (await clipState(page, 'clip-1')).takes).toBe(2);
    await expect(page.locator('.lane[data-id="clip-1"] .take-btn')).toHaveText('T2/2');
}

test.describe('Takes and comping (B4)', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
    });

    test('(i) ● on a committed clip records a NEW TAKE; the lane ends with T2/2', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        const lane = page.locator('.lane[data-id="clip-1"]');
        const arm = lane.locator('.arm-btn');
        // A committed clip's ● is enabled and means NEW TAKE (Q7:
        // "new take on the record button") — the take chip is quiet
        // with one take.
        await expect(arm).toBeEnabled();
        await expect(arm).toHaveAttribute('title', /new take/i);
        await expect(arm).toHaveClass(/\bretake\b/);
        await expect(lane.locator('.take-btn')).toHaveClass(/\bquiet\b/);

        await arm.click();
        // The retake lifecycle: the slot is live (the sub-line pulses),
        // its resting tiles stay beneath, SILENT (dimmed), and the
        // one undo-able performance is the new take.
        await expect(lane.locator('.rail-sub')).toHaveClass(/\brecording\b/);
        await expect.poll(async () => (await clipState(page, 'clip-1')).isRecording).toBe(true);
        await expect.poll(() => lane.locator('.rep.silent').count()).toBeGreaterThan(0);
        await expect(page.locator('#log-line')).toHaveText(/new take/i);
        await expect(arm).toHaveAttribute('title', /cancel/i);

        // One period of audio: the take auto-finishes and becomes active.
        await page.evaluate(Q => window.__celestrianTest.advanceBy(2 * Q), await mockQ(page));
        await expect.poll(async () => {
            const c = await clipState(page, 'clip-1');
            return c.isRecording + ':' + c.takes + ':' + c.activeTake;
        }).toBe('false:2:1');
        await expect(lane.locator('.take-btn')).toHaveText('T2/2');
        await expect(lane.locator('.take-btn')).not.toHaveClass(/\bquiet\b/);
        await expect(lane.locator('.rep.silent')).toHaveCount(0);
        await expect(lane.locator('.rep:not(.ghost)')).toHaveCount(1);
        // The slot's facts stand: same period on the rail.
        await expect(lane.locator('.rail-sub')).toHaveText('2Q');
        await expect(arm).toBeEnabled();
    });

    test('(ii) the take list: select, delete (never the last), ⌘Z', async ({ page }) => {
        await twoTakes(page);
        const lane = page.locator('.lane[data-id="clip-1"]');
        const chip = lane.locator('.take-btn');

        await chip.click();
        const menu = lane.locator('.take-menu');
        await expect(menu).toBeVisible();
        await expect(menu.locator('.take-item')).toHaveCount(2);
        await expect(menu.locator('.take-item[data-take="1"]')).toHaveClass(/\bcurrent\b/);
        await expect(menu.locator('.take-item .take-wave')).toHaveCount(2);

        // Select take 1 (index 0): the chip and the mock follow.
        await menu.locator('.take-item[data-take="0"] .take-pick').click();
        await expect(menu).toHaveCount(0);
        await expect.poll(async () => (await clipState(page, 'clip-1')).activeTake).toBe(0);
        await expect(chip).toHaveText('T1/2');

        // Delete take 2 (index 1): one take left, the chip goes quiet.
        await chip.click();
        await lane.locator('.take-menu .take-item[data-take="1"] .take-delete').click();
        await expect.poll(async () => (await clipState(page, 'clip-1')).takes).toBe(1);
        await expect(chip).toHaveText('T1');
        await expect(chip).toHaveClass(/\bquiet\b/);

        // The last take never deletes: its × is disabled; Escape closes
        // the list (the PANEL-scope binding) without clearing the rest.
        await chip.click();
        await expect(lane.locator('.take-menu .take-item')).toHaveCount(1);
        await expect(lane.locator('.take-menu .take-delete')).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(lane.locator('.take-menu')).toHaveCount(0);

        // ⌘Z brings the take back (the deletion was one undo step).
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(async () => (await clipState(page, 'clip-1')).takes).toBe(2);
        await expect(chip).toHaveText('T1/2');
    });

    test('(iii) the comp editor: cells cycle, one setComp per click, ⌘Z reverts one', async ({ page }) => {
        await twoTakes(page);
        const lane = page.locator('.lane[data-id="clip-1"]');
        const body = lane.locator('.lane-body');
        const compOf = async () => (await clipState(page, 'clip-1')).comp;
        expect(await compOf()).toEqual([]);

        // Enter comp mode from the list: a 2Q slot has two Q cells,
        // both the active take.
        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-comp-row').click();
        await expect(body.locator('.comp-cell.editing')).toHaveCount(2);
        await expect(body.locator('.comp-badge')).toHaveText(['·', '·']);
        await expect(lane.locator('.take-btn')).toHaveClass(/\bon\b/);
        await expect(body.locator('.comp-done-chip')).toBeVisible();

        // Cell 0: −1 → 0 (take 1 sounds there) — tinted, badged, ONE commit.
        await body.locator('.comp-cell[data-cell="0"]').click();
        await expect.poll(compOf).toEqual([0, -1]);
        await expect(body.locator('.comp-cell[data-cell="0"]')).toHaveClass(/\btint\b/);
        await expect(body.locator('.comp-badge')).toHaveText(['T1', '·']);
        // Cell 1: −1 → 0.
        await body.locator('.comp-cell[data-cell="1"]').click();
        await expect.poll(compOf).toEqual([0, 0]);
        await expect(body.locator('.comp-badge')).toHaveText(['T1', 'T1']);
        await expect(body.locator('.comp-cell.tint')).toHaveCount(2);

        // ⌘Z reverts exactly one click.
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(compOf).toEqual([0, -1]);
        await expect(body.locator('.comp-badge')).toHaveText(['T1', '·']);

        // Escape leaves comp mode; the comp stays and the tint shows at
        // rest (only the cell naming the other take).
        await page.keyboard.press('Escape');
        await expect(body.locator('.comp-cell.editing')).toHaveCount(0);
        await expect(body.locator('.comp-cell.tint')).toHaveCount(1);
        await expect(lane.locator('.take-btn')).not.toHaveClass(/\bon\b/);
        await expect(lane.locator('.take-btn')).toHaveClass(/\bcomped\b/);
        expect(await compOf()).toEqual([0, -1]);
    });
});
