/**
 * THE REGION PANEL and THE SAME-SCALE REVEAL (docs/time_maps.md "The
 * same-scale reveal + the region panel"; docs/loop_selection.md §15).
 *
 * The selected track's raw take shows in the edit bar with its kept
 * region as a box: slide, trim, cut, heal, nudge. On the lane, ⇧ on a
 * splice drags the loop's end at the lane's OWN scale, the bound glued
 * to the pointer, panning at the edges. The panel's detail strip draws
 * through its own view (fit to the loop by default): every strip x ↔
 * raw Q here goes through it. The view's navigation is pinned by
 * region_panel_view.spec.js, the splice and ↺ drags by
 * splice_handles.spec.js.
 */

import { test, expect } from '@playwright/test';
import { node, loopOf, segsOf, loopedTake, laneOf, panelOf, stripOf, viewOf,
         stripX, stripPxPerQ, selectLane, keptBoxAt, centre, dragBy, dragTo,
         release, undo, lanePxPerQ, sampleFrames, settled, recordMapCalls,
         consoleDrained }
    from './helpers.js';

test.describe('Region panel', () => {
    test('follows selection: a rail click shows it in the edit bar; a top-bar click and Escape hide it', async ({ page }) => {
        const { id1, id2 } = await loopedTake(page, { select: false });
        // The default selection is the first lane (1Q — nothing to
        // show); the long take's panel is hidden.
        await expect(panelOf(page, id1)).toBeHidden();
        await expect(panelOf(page, id2)).toBeHidden();
        await selectLane(page, id2);
        await expect(panelOf(page, id2).locator('.region-label'))
            .toHaveText(/loop 4Q · 12Q take/);
        // FIT REGION: the kept box [6Q, 10Q) fills ~55% of the strip,
        // centred.
        const strip = await stripOf(page, id2).boundingBox();
        const kept = await keptBoxAt(page, id2, 6, 10);
        expect(kept.width / strip.width).toBeCloseTo(0.55, 2);
        expect((kept.x + kept.width / 2 - strip.x) / strip.width).toBeCloseTo(0.5, 2);
        // THE EDIT BAR is outside what the session view scrolls and
        // zooms, and below it: no main zoom or scroll moves the panel,
        // and the playhead — a line down the session's box — ends above it.
        await expect(page.locator('#session #region-dock')).toHaveCount(0);
        const session = await page.locator('#session').boundingBox();
        const panel = await panelOf(page, id2).boundingBox();
        expect(session.y + session.height).toBeLessThanOrEqual(panel.y);
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

    test('panel gestures: a bracket trims, the box slides, double-click cuts, right-click heals; ⌥ released mid-drag re-lands on whole Q', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page);
        const lane = laneOf(page, id2);
        const panel = panelOf(page, id2);
        const strip = await stripOf(page, id2).boundingBox();
        const y = strip.y + strip.height / 2;
        const bracketAt = async edge => ({
            x: centre(await panel.locator('.region-bracket.' + edge).boundingBox()).x, y });
        // TRIM: the start bracket to 7.3Q — [7.3, 10) proposes a 2.7Q
        // period → 3Q → the bound lands at 7Q.
        await keptBoxAt(page, id2, 6, 10);
        await dragTo(page, await bracketAt('start'), await stripX(page, id2, 7.3), { steps: 8 });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,10');
        // SLIDE: grab the box (rebuilt at [7, 10) once the commit
        // settles) and move it +1.3Q → a whole-Q step, +1.
        const kept = await keptBoxAt(page, id2, 7, 10);
        await dragBy(page, { x: centre(kept).x, y }, 1.3 * await stripPxPerQ(page, id2),
            { steps: 8 });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,11');
        // The lane re-tiled to the slid loop.
        await expect(lane.locator('.lane-body .win-chip')).toHaveText(/3Q/);
        await keptBoxAt(page, id2, 8, 11);
        // CUT: double-click the kept material at 9.5Q → a 1Q cell cut
        // at [9, 10): the map is [8, 9) ∪ [10, 11).
        await page.mouse.dblclick(await stripX(page, id2, 9.5), y);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('8,9,10,11');
        await expect(panel.locator('.region-overlay .cut-band')).toHaveCount(1);
        await expect(panel.locator('.region-label')).toHaveText(/cuts/);
        // The overview notches the cut too.
        await expect(panel.locator('.region-overview .region-ov-cut')).toHaveCount(1);
        // HEAL: right-click the cut (its chip rides the band's centre).
        await panel.locator('.region-overlay .cut-chip').click({ button: 'right' });
        await expect.poll(async () => ((await node(page, id2)).segments || []).length)
            .toBeLessThan(4);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,11');
        // ⌥ THEN PLAIN in one bracket drag: ⌥ slides the whole region
        // freely (+0.6Q); with ⌥ released the slide re-lands on whole Q
        // first (+1Q: [9, 12)) and the bracket trims from there — 8.65Q
        // proposes a 3.35Q period → 3Q, the bound stays at 9. A trim
        // from the un-slid region would land [9, 11). (The overlay is
        // rebuilt once the heal settles: grab the bracket it built.)
        await expect(panel.locator('.region-overlay .cut-band')).toHaveCount(0);
        await keptBoxAt(page, id2, 8, 11);
        const at = await bracketAt('start');
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.keyboard.down('Alt');
        await page.mouse.move(await stripX(page, id2, 8.6), y, { steps: 6 });
        await page.keyboard.up('Alt');
        await page.mouse.move(await stripX(page, id2, 8.65), y, { steps: 3 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('9,12');
    });

    test('a whole-take lane: dragging a latent bracket in creates the loop', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { lenQ: 4, loop: null });
        const panel = panelOf(page, id2);
        await expect(panel.locator('.region-label')).toHaveText(/whole take · 4Q take/);
        // No loop: the view is the whole take.
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 4 });
        const strip = await stripOf(page, id2).boundingBox();
        const end = centre(await panel.locator('.region-bracket.end').boundingBox());
        await dragTo(page, { x: end.x, y: strip.y + strip.height / 2 },
            await stripX(page, id2, 3.2), { steps: 8 });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,3');
        await expect.poll(async () => (await node(page, id2)).windowActive).toBe(true);
        await expect(panel.locator('.region-label')).toHaveText(/loop 3Q · 4Q take/);
    });

    test('← / → nudge the selected region: 1Q, ⇧ 4Q, no ⌥ step; clamped to the take; the view follows', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { loop: [8, 11] });
        const v0 = await viewOf(page, id2);
        const calls = recordMapCalls(page);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('9,12');
        // At the take's end the key is consumed and sends nothing.
        await page.keyboard.press('ArrowRight');
        await consoleDrained(page);
        expect(calls).toEqual(['setSegments']);
        await page.keyboard.press('Shift+ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,8');
        // KEEP IN VIEW: the nudged region stays on the strip — by a
        // PAN, never a zoom.
        await expect.poll(async () => {
            const v = await viewOf(page, id2);
            return v.q0 <= 5 && v.q0 + v.spanQ >= 8;
        }).toBe(true);
        expect((await viewOf(page, id2)).spanQ).toBeCloseTo(v0.spanQ, 9);
        // ⌥ is no nudge (there is no sub-Q grid; a fine move is the ⌥
        // DRAG's): nothing is sent.
        await page.keyboard.press('Alt+ArrowRight');
        await page.keyboard.press('Alt+ArrowLeft');
        await consoleDrained(page);
        expect(calls).toEqual(['setSegments', 'setSegments']);
        expect(await loopOf(page, id2, Q)).toBe('5,8');
        // KEY REPEAT: presses faster than the poll chain off the last
        // target — five quick lefts move five Qs, not one.
        for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,3');
    });

    test('a HELD ← keeps nudging and a held + keeps zooming (key repeat)', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { loop: [8, 11] });
        await keptBoxAt(page, id2, 8, 11);
        // One press and three auto-repeats (a second `down` of a key
        // already down is a repeat): four Qs.
        for (let i = 0; i < 4; i++) await page.keyboard.down('ArrowLeft');
        await page.keyboard.up('ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('4,7');
        // The zoom keys repeat too: + held for three steps zooms the
        // panel further in than one press does.
        const span = async () => (await viewOf(page, id2)).spanQ;
        await page.keyboard.press('Shift+Z');
        await expect.poll(span).toBe(12);
        for (let i = 0; i < 3; i++) await page.keyboard.down('Equal');
        await page.keyboard.up('Equal');
        const held = await span();
        await page.keyboard.press('Shift+Z');
        await expect.poll(span).toBe(12);
        await page.keyboard.press('Equal');
        const once = await span();
        expect(once).toBeLessThan(12);
        expect(held).toBeLessThan(once);
    });

    test('→, ⌘Z, → in quick succession: the second → slides from where the region shows', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { loop: [4, 8] });
        await keptBoxAt(page, id2, 4, 8);
        await page.keyboard.press('ArrowRight');
        await keptBoxAt(page, id2, 5, 9);
        await undo(page);
        await keptBoxAt(page, id2, 4, 8);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        await keptBoxAt(page, id2, 5, 9);
    });
});

test.describe('Same-scale reveal', () => {
    test('⇧ on a splice drags the loop\'s end at the lane\'s own scale, glued to the pointer, and pans at the edge', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page);            // a 4Q frame
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        // The wrap rests on the frame's left edge, so it shows at the
        // right edge too (.lr-end); this is the left one.
        const wrapTab = body.locator(
            '.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end) .lr-tab');
        await expect(wrapTab).toHaveCount(1);
        const box = await body.boundingBox();
        const pxq = await lanePxPerQ(page, id2);
        // THE WRAP'S SPLICE (the region start, at the frame's left edge),
        // ⇧-dragged right by 1.2 frame-Q (= 1.2 raw Q: same scale): the
        // loop's END — the material before the splice — follows the hand.
        // A few px of travel engage the drag.
        const grab = centre(await wrapTab.boundingBox());
        await dragBy(page, grab, 6, { mods: ['Shift'], hold: true, steps: 1 });
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
        await followNear(grab.x + 6);
        await page.mouse.move(grab.x + 1.2 * pxq, grab.y, { steps: 10 });
        await followNear(grab.x + 1.2 * pxq);
        await expect(body.locator('.drag-preview-layer .cut-chip'))
            .toHaveText(/loop 5Q \(\+1\)/);
        await release(page, ['Shift']);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,11');
        await expect(body).not.toHaveClass(/revealing/);
        await expect(body.locator('.reveal-layer')).toHaveCount(0);
        await expect(lane.locator('.win-heard-chip')).toHaveText(/5Q/);
        // The panel shows the new region.
        await expect(panelOf(page, id2)).toBeVisible();
        await expect(panelOf(page, id2).locator('.region-label'))
            .toHaveText(/loop 5Q · 12Q take/);

        // THE DIRECTION RULE (edge_pan.js): the wrap's splice rests at
        // the frame's left edge, its tab INSIDE the edge zone. A fine
        // INWARD move does not pan — the pan is paced by the frame, so
        // a still hand shows it in every one…
        await settled(page);
        const again = centre(await wrapTab.boundingBox());
        await dragBy(page, again, 10, { mods: ['Shift'], hold: true, steps: 3 });
        await expect(body).toHaveClass(/revealing/);
        const q0Inward = await body.evaluate(b => b._reveal.view.q0);
        const still = await sampleFrames(page, id => ({
            q0: document.querySelector(`.lane[data-id="${id}"] .lane-body`)._reveal.view.q0,
        }), id2, { frames: 20 });
        for (const f of still) expect(f.q0).toBeCloseTo(q0Inward, 9);
        // …while moving OUTWARD past the grab (beyond the lane's left
        // edge) pans the raw take under the hand, so the bound walks
        // earlier than the frame alone could reach.
        await page.mouse.move(box.x - 24, again.y, { steps: 4 });
        await expect.poll(() => body.evaluate(b => b._reveal ? b._reveal.view.q0 : 99),
            { timeout: 4000 }).toBeLessThan(q0Inward - 0.5);
        await release(page, ['Shift']);
        await expect.poll(async () => (await node(page, id2)).loopEnd / Q).toBeLessThan(11);
        const n = await node(page, id2);
        expect(n.loopStart / Q).toBe(6);
        expect(Number.isInteger(n.loopEnd / Q)).toBe(true);
        expect(n.loopEnd / Q).toBeGreaterThanOrEqual(7);   // never under 1Q
    });
});
