/**
 * THE REGION PANEL + THE SAME-SCALE REVEAL (owner-ruled 2026-09-11 —
 * docs/time_maps.md "The same-scale reveal + the region panel").
 *
 * Field report: a 1Q definer, a long drum take, a 4Q window — "when I
 * grab a handle and the track blows up to its full length I am very
 * confused about where the current selection is." The fix is two
 * surfaces under one law: the SELECTED lane grows a panel showing the
 * whole raw take with the kept region as a box (slide / trim / cut),
 * and a lane handle drags at the lane's OWN scale, the grip glued to
 * the pointer, panning at the edges. Real mouse input throughout —
 * synthetic dispatch bypasses hit-testing (the 2026-07-23c law).
 */

import { test, expect } from '@playwright/test';

async function boot(page) {
    // `/?mock=true` — the static server's redirect drops the query on
    // `/index.html` (test_harness.md gotcha 10).
    await page.goto('/?mock=true');
    await page.waitForFunction(() => !!window.__celestrianTest, null,
        { timeout: 5000 });
    await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
}

const quantum = page => page.evaluate(async () =>
    (await window.__celestrianTest.callNative('getGraphState')).perf.sampleRate);

const node = (page, id) => page.evaluate(async id =>
    (await window.__celestrianTest.callNative('getGraphState'))
        .nodes.find(n => n.id === id), id);

const loopOf = async (page, id, Q) => {
    const n = await node(page, id);
    return [n.loopStart / Q, n.loopEnd / Q].join(',');
};

/** A 1Q definer, then a `lenQ` take from 1Q (the owner's topology). */
async function recordDefinerAndTake(page, Q, lenQ) {
    const ids = await page.evaluate(async ({ Q, lenQ }) => {
        const c = window.__celestrianTest.callNative;
        const adv = window.__celestrianTest.advanceBy;
        const id1 = await c('createNode', 'clip', '');
        await c('startRecordingInNode', id1);
        adv(Q);
        await c('stopRecordingInNode', id1);
        const id2 = await c('createNode', 'clip', '');
        await c('startRecordingInNode', id2);
        adv(lenQ * Q - 10);
        await c('stopRecordingInNode', id2);
        adv(20);
        return { id1, id2 };
    }, { Q, lenQ });
    await expect.poll(async () => (await node(page, ids.id2)).duration).toBe(lenQ * Q);
    return ids;
}

const setLoop = (page, id, a, b) => page.evaluate(
    ({ id, a, b }) => window.__celestrianTest.callNative('setLoopPoints', id, a, b),
    { id, a, b });

const laneOf = (page, id) => page.locator(`.lane[data-id="${id}"]`);
const panelOf = (page, id) => laneOf(page, id).locator('.lane-region');

/** Raw Q → page x on the panel's strip. */
async function stripX(page, id, q, totalQ) {
    const s = await laneOf(page, id).locator('.region-strip').boundingBox();
    return s.x + s.width * (q / totalQ);
}

test.describe('Region panel', () => {
    test('follows selection: rail click shows it; top-bar click and Escape hide it', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id1, id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        // The default selection is the FIRST lane (1Q — nothing to
        // show); the long take's panel is hidden.
        await expect(panelOf(page, id1)).toBeHidden();
        await expect(panelOf(page, id2)).toBeHidden();
        await laneOf(page, id2).locator('.rail-name').click();
        await expect(panelOf(page, id2)).toBeVisible();
        await expect(laneOf(page, id2).locator('.region-label'))
            .toHaveText(/loop 4Q · 12Q take/);
        // The kept box spans [6Q, 10Q) of the 12Q strip.
        const strip = await laneOf(page, id2).locator('.region-strip').boundingBox();
        const kept = await laneOf(page, id2).locator('.region-kept').boundingBox();
        expect((kept.x - strip.x) / strip.width).toBeCloseTo(6 / 12, 2);
        expect(kept.width / strip.width).toBeCloseTo(4 / 12, 2);
        // DESELECT from the top bar: a click on the transport's empty
        // space clears the selection and the panel goes with it.
        const tb = await page.locator('#transport').boundingBox();
        const sp = await page.locator('#transport .spacer').boundingBox();
        await page.mouse.click(sp.x + sp.width / 2, tb.y + tb.height / 2);
        await expect(page.locator('.lane.sel')).toHaveCount(0);
        await expect(panelOf(page, id2)).toBeHidden();
        // Escape does the same.
        await laneOf(page, id2).locator('.rail-name').click();
        await expect(panelOf(page, id2)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
    });

    test('panel gestures: a bracket trims, the box slides, double-click cuts, right-click heals', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        await laneOf(page, id2).locator('.rail-name').click();
        const lane = laneOf(page, id2);
        await expect(panelOf(page, id2)).toBeVisible();
        const strip = await lane.locator('.region-strip').boundingBox();
        const y = strip.y + strip.height / 2;
        // TRIM: the start bracket to 7.3Q — [7.3, 10) proposes a 2.7Q
        // period → 3Q → the bound lands at 7Q.
        const sb = await lane.locator('.region-bracket.start').boundingBox();
        await page.mouse.move(sb.x + sb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(await stripX(page, id2, 7.3, 12), y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,10');
        // The panel rebuilds once the commit settles: wait for the box
        // to show [7, 10) before grabbing it.
        await expect.poll(async () => {
            // (null for a tick while the overlay rebuilds — keep polling)
            const k = await lane.locator('.region-kept').boundingBox();
            return k ? (k.x - strip.x) / strip.width : -1;
        }).toBeCloseTo(7 / 12, 2);
        // SLIDE: grab the box and move it +1.3Q → whole-Q step +1.
        const kept = await lane.locator('.region-kept').boundingBox();
        await page.mouse.move(kept.x + kept.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(kept.x + kept.width / 2 + strip.width * (1.3 / 12), y,
            { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,11');
        // The lane above re-tiled to the slid loop (overview → detail).
        await expect(lane.locator('.lane-body .win-chip')).toHaveText(/3Q/);
        await expect.poll(async () => {
            // (null for a tick while the overlay rebuilds — keep polling)
            const k = await lane.locator('.region-kept').boundingBox();
            return k ? (k.x - strip.x) / strip.width : -1;
        }).toBeCloseTo(8 / 12, 2);
        // CUT: double-click the kept material at 9.5Q → a 1Q cell cut
        // at [9, 10): the map is [8, 9) ∪ [10, 11).
        await page.mouse.dblclick(await stripX(page, id2, 9.5, 12), y);
        await expect.poll(async () => {
            const n = await node(page, id2);
            return (n.segments || []).map(s => s / Q).join(',');
        }).toBe('8,9,10,11');
        await expect(lane.locator('.region-overlay .cut-band')).toHaveCount(1);
        await expect(lane.locator('.region-label')).toHaveText(/cuts/);
        // HEAL: right-click the cut (its chip rides the band's center).
        await lane.locator('.region-overlay .cut-chip').click({ button: 'right' });
        await expect.poll(async () => {
            const n = await node(page, id2);
            return (n.segments || []).length;
        }).toBeLessThan(4);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,11');
    });

    test('a whole-take lane: dragging a latent bracket in creates the loop', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 4);
        await laneOf(page, id2).locator('.rail-name').click();
        const lane = laneOf(page, id2);
        await expect(panelOf(page, id2)).toBeVisible();
        await expect(lane.locator('.region-label')).toHaveText(/whole take · 4Q take/);
        const strip = await lane.locator('.region-strip').boundingBox();
        const y = strip.y + strip.height / 2;
        const eb = await lane.locator('.region-bracket.end').boundingBox();
        await page.mouse.move(eb.x + eb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(await stripX(page, id2, 3.2, 4), y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,3');
        await expect.poll(async () => (await node(page, id2)).windowActive).toBe(true);
        await expect(lane.locator('.region-label')).toHaveText(/loop 3Q · 4Q take/);
    });

    test('← / → nudge the selected region: 1Q, ⇧ 4Q, ⌥ ⅛Q; clamped to the take', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 8 * Q, 11 * Q);
        await laneOf(page, id2).locator('.rail-name').click();
        await expect(panelOf(page, id2)).toBeVisible();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('9,12');
        await page.keyboard.press('ArrowRight');           // at the end: no-op
        await page.waitForTimeout(150);
        expect(await loopOf(page, id2, Q)).toBe('9,12');
        await page.keyboard.press('Shift+ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,8');
        // ⌥: an eighth of a Q (sample-rounded by the engine).
        await page.keyboard.press('Alt+ArrowRight');
        await expect.poll(async () => (await node(page, id2)).loopStart / Q)
            .toBeCloseTo(5.125, 3);
        await page.keyboard.press('Alt+ArrowLeft');
        await expect.poll(async () => (await node(page, id2)).loopStart / Q)
            .toBeCloseTo(5, 3);
        // KEY REPEAT: presses faster than the poll chain off the last
        // target — five quick lefts move five Qs, not one.
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,3');
    });
});

test.describe('Same-scale reveal', () => {
    test('a lane grip drags at the lane\'s own scale, glued to the pointer, and pans at the edge', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);            // 4Q frame
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        await expect(body.locator('.trim-grip.end')).toHaveCount(1);
        const box = await body.boundingBox();
        await body.hover();
        // THE END GRIP, left by 1.2 frame-Q (= 1.2 raw Q: same scale).
        const eb = await body.locator('.trim-grip.end').boundingBox();
        const gx = eb.x + eb.width / 2;
        const gy = eb.y + eb.height / 2;
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        await page.waitForTimeout(220);                    // engage (hold)
        await page.mouse.move(gx - 6, gy);
        await expect(body).toHaveClass(/revealing/);
        await expect(body).not.toHaveClass(/inspecting/);  // never rescaled
        await expect(body.locator('.reveal-layer canvas')).toHaveCount(1);
        // The follow bracket rides the pointer. (Polled: the preview
        // re-renders on every pointermove, and a single box read can
        // land between the page's event and the runner's query.)
        const followNear = x => expect.poll(async () => {
            const fb = await body.locator('.drag-preview-layer .win-bracket.dragging')
                .boundingBox();
            return fb ? Math.abs((fb.x + fb.width) - x) < 12 : false;
        }).toBe(true);
        await followNear(gx - 6);
        await page.mouse.move(gx - box.width * (1.2 / 4), gy, { steps: 10 });
        await followNear(gx - box.width * (1.2 / 4));
        await page.screenshot({ path: test.info().outputPath('reveal-mid-drag.png') });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,9');
        await expect(body).not.toHaveClass(/revealing/);
        await expect(body.locator('.reveal-layer')).toHaveCount(0);
        // The panel appeared with the grab (a handle claims the track)
        // and shows the new region.
        await expect(panelOf(page, id2)).toBeVisible();
        await expect(lane.locator('.region-label')).toHaveText(/loop 3Q · 12Q take/);

        // EDGE PAN: the START grip (raw 6Q, at the frame's left edge)
        // held just inside the lane's left edge — the raw take pans
        // under the hand, so the bound walks earlier than the frame
        // alone could reach.
        await body.hover();
        const sb = await body.locator('.trim-grip.start').boundingBox();
        const sx = sb.x + sb.width / 2;
        await page.mouse.move(sx, gy);
        await page.mouse.down();
        await page.waitForTimeout(220);
        await page.mouse.move(box.x + 12, gy, { steps: 4 });
        await expect(body).toHaveClass(/revealing/);
        // Panning (rAF-paced — poll rather than sleep, so a loaded
        // runner cannot starve the pan under a fixed wait).
        await expect.poll(() => body.evaluate(b => b._reveal ? b._reveal.view.q0 : 99),
            { timeout: 4000 }).toBeLessThan(5.5);          // started at 6
        await page.mouse.up();
        await expect.poll(async () => {
            const n = await node(page, id2);
            return n.loopStart / Q;
        }).toBeLessThan(6);
        const n = await node(page, id2);
        expect(Number.isInteger(n.loopStart / Q)).toBe(true);
        expect(Number.isInteger((n.loopEnd - n.loopStart) / Q)).toBe(true);
    });
});
