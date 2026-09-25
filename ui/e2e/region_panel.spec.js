/**
 * THE REGION PANEL + THE SAME-SCALE REVEAL (owner-ruled 2026-09-11 —
 * docs/time_maps.md "The same-scale reveal + the region panel").
 *
 * Field report: a 1Q definer, a long drum take, a 4Q window — "when I
 * grab a handle and the track blows up to its full length I am very
 * confused about where the current selection is." The fix is two
 * surfaces under one law: the SELECTED lane grows a panel showing the
 * raw take with the kept region as a box (slide / trim / cut), and a
 * lane handle drags at the lane's OWN scale, the bound glued to the
 * pointer, panning at the edges (since 2026-09-24: ⇧ on a splice — the
 * length there; splice_handles.spec.js pins the splice and ↺ drags).
 * Real mouse input throughout — synthetic dispatch bypasses
 * hit-testing (the 2026-07-23c law).
 *
 * Since loop-region phase 1 (2026-09-23) the panel's detail strip has
 * its own VIEW (fit-region by default): every strip x ↔ raw Q here goes
 * through it (region_panel_helpers.js). The view's own navigation is
 * pinned by region_panel_view.spec.js.
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, node, loopOf, segsOf, recordDefinerAndTake, setLoop,
         laneOf, panelOf, stripOf, viewOf, stripX, selectLane, keptBoxAt }
    from './region_panel_helpers.js';

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
        await selectLane(page, id2);
        await expect(laneOf(page, id2).locator('.region-label'))
            .toHaveText(/loop 4Q · 12Q take/);
        // FIT REGION: the kept box [6Q, 10Q) fills ~55% of the strip,
        // centred.
        const strip = await stripOf(page, id2).boundingBox();
        const kept = await keptBoxAt(page, id2, 6, 10);
        expect(kept.width / strip.width).toBeCloseTo(0.55, 2);
        expect((kept.x + kept.width / 2 - strip.x) / strip.width).toBeCloseTo(0.5, 2);
        // DESELECT from the top bar: a click on the transport's empty
        // space clears the selection and the panel goes with it.
        const tb = await page.locator('#transport').boundingBox();
        const sp = await page.locator('#transport .spacer').boundingBox();
        await page.mouse.click(sp.x + sp.width / 2, tb.y + tb.height / 2);
        await expect(page.locator('.lane.sel')).toHaveCount(0);
        await expect(panelOf(page, id2)).toBeHidden();
        // Escape does the same.
        await selectLane(page, id2);
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
    });

    test('panel gestures: a bracket trims, the box slides, double-click cuts, right-click heals', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        await selectLane(page, id2);
        const lane = laneOf(page, id2);
        const strip = await stripOf(page, id2).boundingBox();
        const y = strip.y + strip.height / 2;
        // TRIM: the start bracket to 7.3Q — [7.3, 10) proposes a 2.7Q
        // period → 3Q → the bound lands at 7Q.
        await keptBoxAt(page, id2, 6, 10);
        const sb = await lane.locator('.region-bracket.start').boundingBox();
        await page.mouse.move(sb.x + sb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(await stripX(page, id2, 7.3), y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,10');
        // The panel rebuilds once the commit settles: wait for the box
        // to show [7, 10) before grabbing it.
        const kept = await keptBoxAt(page, id2, 7, 10);
        // SLIDE: grab the box and move it +1.3Q → whole-Q step +1.
        const v = await viewOf(page, id2);
        await page.mouse.move(kept.x + kept.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(kept.x + kept.width / 2 + strip.width * (1.3 / v.spanQ), y,
            { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,11');
        // The lane above re-tiled to the slid loop (overview → detail).
        await expect(lane.locator('.lane-body .win-chip')).toHaveText(/3Q/);
        await keptBoxAt(page, id2, 8, 11);
        // CUT: double-click the kept material at 9.5Q → a 1Q cell cut
        // at [9, 10): the map is [8, 9) ∪ [10, 11).
        await page.mouse.dblclick(await stripX(page, id2, 9.5), y);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('8,9,10,11');
        await expect(lane.locator('.region-overlay .cut-band')).toHaveCount(1);
        await expect(lane.locator('.region-label')).toHaveText(/cuts/);
        // The overview notches the cut too.
        await expect(lane.locator('.region-overview .region-ov-cut')).toHaveCount(1);
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
        await selectLane(page, id2);
        const lane = laneOf(page, id2);
        await expect(lane.locator('.region-label')).toHaveText(/whole take · 4Q take/);
        // No loop: the view is the whole take.
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 4 });
        const strip = await stripOf(page, id2).boundingBox();
        const y = strip.y + strip.height / 2;
        const eb = await lane.locator('.region-bracket.end').boundingBox();
        await page.mouse.move(eb.x + eb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(await stripX(page, id2, 3.2), y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,3');
        await expect.poll(async () => (await node(page, id2)).windowActive).toBe(true);
        await expect(lane.locator('.region-label')).toHaveText(/loop 3Q · 4Q take/);
    });

    test('← / → nudge the selected region: 1Q, ⇧ 4Q, ⌥ ⅛Q; clamped to the take; the view follows', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 8 * Q, 11 * Q);
        await selectLane(page, id2);
        const v0 = await viewOf(page, id2);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('9,12');
        await page.keyboard.press('ArrowRight');           // at the end: no-op
        await page.waitForTimeout(150);
        expect(await loopOf(page, id2, Q)).toBe('9,12');
        await page.keyboard.press('Shift+ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,8');
        // KEEP IN VIEW: the nudged region stays on the strip — by a
        // PAN, never a zoom.
        await expect.poll(async () => {
            const v = await viewOf(page, id2);
            return v.q0 <= 5 && v.q0 + v.spanQ >= 8;
        }).toBe(true);
        expect((await viewOf(page, id2)).spanQ).toBeCloseTo(v0.spanQ, 9);
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
    test('⇧ on a splice drags the loop\'s end at the lane\'s own scale, glued to the pointer, and pans at the edge', async ({ page }) => {
        // (Since 2026-09-24 the reveal serves ⇧ on a splice — the LENGTH
        // there, loop_selection.md P2.4; the plain-drag edge grips it
        // used to serve are retired, time_maps.md §8.)
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);            // 4Q frame
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        const wrapTab = body.locator('.lr-layer > .lr-wrap:not(.lr-ghost) .lr-tab');
        await expect(wrapTab).toHaveCount(1);
        const box = await body.boundingBox();
        // THE WRAP'S SPLICE (the region start, at the frame's left edge),
        // ⇧-dragged right by 1.2 frame-Q (= 1.2 raw Q: same scale): the
        // loop's END — the material before the splice — follows the hand.
        const eb = await wrapTab.boundingBox();
        const gx = eb.x + eb.width / 2;
        const gy = eb.y + eb.height / 2;
        await page.mouse.move(gx, gy);
        await page.keyboard.down('Shift');
        await page.mouse.down();
        await page.waitForTimeout(220);                    // engage (hold)
        await page.mouse.move(gx + 6, gy);
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
        await followNear(gx + 6);
        await page.mouse.move(gx + box.width * (1.2 / 4), gy, { steps: 10 });
        await followNear(gx + box.width * (1.2 / 4));
        await page.screenshot({ path: test.info().outputPath('reveal-mid-drag.png') });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,11');
        await expect(body).not.toHaveClass(/revealing/);
        await expect(body.locator('.reveal-layer')).toHaveCount(0);
        // The panel appeared with the grab (a handle claims the track)
        // and shows the new region.
        await expect(panelOf(page, id2)).toBeVisible();
        await expect(lane.locator('.region-label')).toHaveText(/loop 5Q · 12Q take/);

        // THE DIRECTION RULE (edge_pan.js; release-jump F5): the wrap's
        // splice rests at the frame's left edge, its tab INSIDE the edge
        // zone. A fine INWARD move must not pan (it used to run the
        // loop outward by whole Qs)…
        const sb = await wrapTab.boundingBox();
        const sx = sb.x + sb.width / 2;
        await page.mouse.move(sx, gy);
        await page.keyboard.down('Shift');
        await page.mouse.down();
        await page.waitForTimeout(220);
        await page.mouse.move(sx + 10, gy, { steps: 3 });
        await expect(body).toHaveClass(/revealing/);
        const q0Inward = await body.evaluate(b => b._reveal.view.q0);
        await page.waitForTimeout(500);
        expect(await body.evaluate(b => b._reveal.view.q0)).toBeCloseTo(q0Inward, 9);
        // …while moving OUTWARD past the grab (beyond the lane's left
        // edge) pans the raw take under the hand, so the bound walks
        // earlier than the frame alone could reach.
        await page.mouse.move(box.x - 24, gy, { steps: 4 });
        // Panning (rAF-paced — poll rather than sleep, so a loaded
        // runner cannot starve the pan under a fixed wait).
        await expect.poll(() => body.evaluate(b => b._reveal ? b._reveal.view.q0 : 99),
            { timeout: 4000 }).toBeLessThan(q0Inward - 0.5);
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await expect.poll(async () => {
            const n = await node(page, id2);
            return n.loopEnd / Q;
        }).toBeLessThan(11);
        const n = await node(page, id2);
        expect(n.loopStart / Q).toBe(6);
        expect(Number.isInteger(n.loopEnd / Q)).toBe(true);
        expect(n.loopEnd / Q).toBeGreaterThanOrEqual(7);   // never under 1Q
    });
});
