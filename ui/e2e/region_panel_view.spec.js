/**
 * THE ZOOMABLE REGION PANEL (docs/time_maps.md §6 "The region panel";
 * session_view/panel_view.js, region_nav.js).
 *
 * The panel draws the take through its OWN per-lane view: fit to the
 * loop by default; Ctrl/⌘+wheel or a pinch zooms about the pointer (the
 * main view does not zoom under it); Shift+wheel or a sideways swipe
 * pans; + / − zoom; Z / ⇧Z and the label's terms fit the loop / the
 * take; and a whole-take overview strip whose box is the view. The
 * view's arithmetic is panel_view.test.mjs's — this pins what needs the
 * browser: wheel and key routing, hit-testing, gestures under a zoomed
 * view, the cursor across rebuilds.
 */

import { test, expect } from '@playwright/test';
import { boot, call, node, loopOf, segsOf, recordTake, setLoop, loopedTake,
         laneOf, panelOf, stripOf, viewOf, stripX, stripQ, selectLane, keptBoxAt,
         ctrlWheel, centre, dragBy, dragTo, release, watchFrames }
    from './helpers.js';

/** A 1Q definer, then a 56Q take looped at [40, 45), selected: a short
 * loop deep in a long take. */
async function longTake(page) {
    const t = await loopedTake(page, { lenQ: 56, loop: [40, 45] });
    await keptBoxAt(page, t.id2, 40, 45);
    return t;
}

const zoomLevel = page => page.locator('#zoom-level').textContent();

test.describe('Region panel view', () => {
    test('Ctrl+wheel zooms the PANEL about the pointer; the main view stays put', async ({ page }) => {
        const { id2 } = await longTake(page);
        const s = await stripOf(page, id2).boundingBox();
        const x = s.x + s.width * 0.3;
        const y = s.y + s.height / 2;
        const v0 = await viewOf(page, id2);
        const q = await stripQ(page, id2, x, v0);
        const scroll0 = await page.evaluate(() =>
            document.getElementById('session').scrollLeft);
        await ctrlWheel(page, x, y, -4);
        const v1 = await viewOf(page, id2);
        expect(v1.spanQ).toBeLessThan(v0.spanQ * 0.5);
        // The Q under the pointer stays under it (within 2 px).
        expect(Math.abs(await stripX(page, id2, q) - x)).toBeLessThan(2);
        // The MAIN view neither zoomed nor scrolled.
        expect(await zoomLevel(page)).toBe('100%');
        expect(await page.evaluate(() =>
            document.getElementById('session').scrollLeft)).toBe(scroll0);
        // Out again, past the whole take: clamped to it.
        await ctrlWheel(page, x, y, 30);
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 56 });
        expect(await zoomLevel(page)).toBe('100%');
        // A PINCH (ctrl+wheel with small deltas) zooms finely.
        await page.mouse.move(x, y);
        await page.keyboard.down('Control');
        for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -4);
        await page.keyboard.up('Control');
        const v2 = await viewOf(page, id2);
        expect(v2.spanQ).toBeLessThan(56);
        expect(v2.spanQ).toBeGreaterThan(56 * 0.7);
        // Outside the panel, Ctrl+wheel still zooms the main view.
        const body = await laneOf(page, id2).locator('.lane-body').boundingBox();
        await ctrlWheel(page, body.x + body.width / 2, body.y + body.height / 2, -1);
        await expect.poll(() => zoomLevel(page)).not.toBe('100%');
    });

    test('Shift+wheel and a sideways swipe pan; a plain wheel does not', async ({ page }) => {
        const { id2 } = await longTake(page);
        const s = await stripOf(page, id2).boundingBox();
        const v0 = await viewOf(page, id2);
        await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
        await page.mouse.wheel(0, 100);                    // plain: page scroll
        expect(await viewOf(page, id2)).toEqual(v0);
        await page.keyboard.down('Shift');
        await page.mouse.wheel(0, 100);
        await page.keyboard.up('Shift');
        const v1 = await viewOf(page, id2);
        expect(v1.spanQ).toBeCloseTo(v0.spanQ, 9);
        expect(v1.q0 - v0.q0).toBeCloseTo(100 / s.width * v0.spanQ, 3);
        await page.mouse.wheel(100, 0);                    // a sideways swipe
        const v2 = await viewOf(page, id2);
        expect(v2.spanQ).toBeCloseTo(v0.spanQ, 9);
        expect(v2.q0 - v1.q0).toBeCloseTo(100 / s.width * v0.spanQ, 3);
        expect(await zoomLevel(page)).toBe('100%');
    });

    test('+ / −, Z / ⇧Z and the label terms drive the PANEL while it shows; with nothing selected + zooms the song view', async ({ page }) => {
        const { id2 } = await longTake(page);
        const panel = panelOf(page, id2);
        const fit = await viewOf(page, id2);
        const whole = { q0: 0, spanQ: 56 };
        // + / − zoom the panel, never the song view.
        await page.keyboard.press('Equal');
        await page.keyboard.press('Equal');
        const zoomed = await viewOf(page, id2);
        expect(zoomed.spanQ).toBeLessThan(fit.spanQ * 0.5);
        expect(await zoomLevel(page)).toBe('100%');
        await page.keyboard.press('Minus');
        expect((await viewOf(page, id2)).spanQ).toBeGreaterThan(zoomed.spanQ);
        expect(await zoomLevel(page)).toBe('100%');
        // ⇧Z / Z and the label's terms: the whole take / the loop.
        await page.keyboard.press('Shift+Z');
        expect(await viewOf(page, id2)).toEqual(whole);
        await page.keyboard.press('z');
        expect(await viewOf(page, id2)).toEqual(fit);
        await panel.locator('.region-term.take').click();
        expect(await viewOf(page, id2)).toEqual(whole);
        await expect(panel.locator('.region-term.loop')).toHaveText('loop 5Q');
        await panel.locator('.region-term.loop').click();
        expect(await viewOf(page, id2)).toEqual(fit);
        // Nothing selected, no panel: Z is unbound (the remembered view
        // is untouched) and + zooms the song view.
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await page.keyboard.press('Shift+Z');
        await page.keyboard.press('Equal');
        await expect.poll(() => zoomLevel(page)).not.toBe('100%');
        await selectLane(page, id2);
        expect(await viewOf(page, id2)).toEqual(fit);
    });

    test('slide, trim and double-click cut under a zoomed view (the cut lands on the take\'s Q grid)', async ({ page }) => {
        const { Q, id2 } = await longTake(page);
        const panel = panelOf(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        const y = s.y + s.height / 2;
        await ctrlWheel(page, s.x + s.width / 2, y, -1);
        const v = await viewOf(page, id2);
        expect(v.spanQ).toBeLessThan(8);
        const pxPerQ = s.width / v.spanQ;
        const startQ = async () => (await node(page, id2)).loopStart / Q;
        // ⌥ FREE SLIDE by ¼Q — at this zoom ~0.005Q per px.
        let k = await keptBoxAt(page, id2, 40, 45);
        await dragBy(page, { x: centre(k).x, y }, 0.25 * pxPerQ, { steps: 8, mods: ['Alt'] });
        await expect.poll(startQ).toBeCloseTo(40.25, 2);
        const a = await startQ();
        // A PLAIN slide moves whole Qs from there (+1.3 → +1).
        k = await keptBoxAt(page, id2, a, a + 5);
        await dragBy(page, { x: centre(k).x, y }, 1.3 * pxPerQ, { steps: 8 });
        await expect.poll(startQ).toBeCloseTo(a + 1, 4);
        // TRIM the end in by 1.2Q: the period snaps to whole Qs (4Q).
        await keptBoxAt(page, id2, a + 1, a + 6);
        const end = centre(await panel.locator('.region-bracket.end').boundingBox());
        await dragBy(page, { x: end.x, y }, -1.2 * pxPerQ, { steps: 8 });
        await expect.poll(async () => {
            const n = await node(page, id2);
            return Math.round((n.loopEnd - n.loopStart) / Q * 1e6) / 1e6;
        }).toBe(4);
        // DOUBLE-CLICK at raw 43.5 after the free slide: a 1Q cut on the
        // TAKE's own Q grid, [43, 44) — never offset by the slide.
        await keptBoxAt(page, id2, a + 1, a + 5);
        await page.mouse.dblclick(await stripX(page, id2, 43.5), y);
        await expect.poll(async () => {
            const segs = (await segsOf(page, id2, Q)).split(',').map(Number);
            return segs.length === 4 &&
                Math.abs(segs[1] - 43) < 1e-3 && Math.abs(segs[2] - 44) < 1e-3;
        }).toBe(true);
        await expect(panel.locator('.region-overlay .cut-band')).toHaveCount(1);
    });

    test('a trim held at the strip\'s edge pans the view and lands beyond it', async ({ page }) => {
        const { Q, id2 } = await longTake(page);
        const s = await stripOf(page, id2).boundingBox();
        const y = s.y + s.height / 2;
        await ctrlWheel(page, await stripX(page, id2, 45), y, -2);
        const v0 = await viewOf(page, id2);
        expect(v0.q0 + v0.spanQ).toBeLessThan(49);
        await keptBoxAt(page, id2, 40, 45);
        const end = centre(await panelOf(page, id2).locator('.region-bracket.end').boundingBox());
        await dragTo(page, { x: end.x, y }, s.x + s.width - 4, { steps: 8, hold: true });
        // The view pans under the held hand (paced by the frame: poll).
        await expect.poll(async () => (await viewOf(page, id2)).q0,
            { timeout: 5000 }).toBeGreaterThan(v0.q0 + 2);
        await release(page);
        await expect.poll(async () => (await node(page, id2)).loopEnd / Q)
            .toBeGreaterThan(v0.q0 + v0.spanQ);
        const n = await node(page, id2);
        expect(Number.isInteger((n.loopEnd - n.loopStart) / Q)).toBe(true);
        expect(n.loopStart / Q).toBe(40);
        // The zoom never changed.
        expect((await viewOf(page, id2)).spanQ).toBeCloseTo(v0.spanQ, 9);
    });

    test('the view survives deselect/reselect and resets on a new take', async ({ page }) => {
        const { Q, id2 } = await longTake(page);
        const s = await stripOf(page, id2).boundingBox();
        await ctrlWheel(page, s.x + s.width * 0.7, s.y + s.height / 2, -3);
        const zoomed = await viewOf(page, id2);
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await selectLane(page, id2);
        expect(await viewOf(page, id2)).toEqual(zoomed);
        // A NEW TAKE of a different length (undo the loop and the take,
        // record 24Q into the same clip, loop it — deselected meanwhile,
        // so the panel first meets the take with its loop): the view
        // starts over at fit region.
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await call(page, 'undo');
        await call(page, 'undo');
        await expect.poll(async () => {
            const n = await node(page, id2);
            return n ? n.duration || 0 : -1;
        }).toBe(0);
        await recordTake(page, Q, 24, id2);
        await setLoop(page, id2, 4 * Q, 8 * Q);
        await selectLane(page, id2);
        await expect.poll(async () => {
            const v = await viewOf(page, id2);
            return v && Math.abs(4 / v.spanQ - 0.55) < 1e-6 &&
                Math.abs(v.q0 + v.spanQ / 2 - 6) < 1e-6;
        }).toBe(true);
    });

    test('a 1Q box on a long take is grabbable at its centre (a slide, not a bracket)', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { lenQ: 56, loop: [40, 41] });
        await page.keyboard.press('Shift+Z');               // ~20 px per Q
        const k = await keptBoxAt(page, id2, 40, 41);
        expect(k.width).toBeLessThan(30);
        const mid = centre(k);
        expect(await page.evaluate(({ x, y }) =>
            document.elementFromPoint(x, y).className, mid)).toMatch(/region-kept/);
        const s = await stripOf(page, id2).boundingBox();
        await dragBy(page, mid, 3 * s.width / 56, { steps: 8 });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('43,44');
        // The brackets still trim, from outside the box.
        const k2 = await keptBoxAt(page, id2, 43, 44);
        const eb = await panelOf(page, id2).locator('.region-bracket.end').boundingBox();
        expect(eb.x).toBeGreaterThanOrEqual(k2.x + k2.width - 1);
        await dragBy(page, { x: centre(eb).x, y: mid.y }, 2 * s.width / 56, { steps: 8 });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('43,46');
    });

    test('the panel cursor never sits at raw 0 after a rebuild', async ({ page }) => {
        const { Q, id2 } = await longTake(page);
        await page.keyboard.press('Shift+Z');               // raw 0 = the strip's left
        await page.keyboard.press('Space');                 // play
        await expect(panelOf(page, id2).locator('.region-cursor')).toBeVisible();
        // Every frame while the map changes — each change a keyed overlay
        // rebuild, waited for before the next.
        const watch = await watchFrames(page, id => {
            const strip = document.querySelector(
                `#region-dock .lane-region[data-lane-id="${id}"] .region-strip`);
            const cur = strip.querySelector('.region-cursor');
            if (!cur || cur.style.display === 'none') return { shown: false };
            const r = cur.getBoundingClientRect();
            const s = strip.getBoundingClientRect();
            return { shown: true, placed: cur.style.left !== '',
                     f: (r.left - s.left) / s.width };
        }, id2);
        for (let i = 1; i <= 6; i++) {
            const a = 40 + i % 2;
            await setLoop(page, id2, a * Q, (a + 5) * Q);
            await keptBoxAt(page, id2, a, a + 5);
        }
        const shown = (await watch.stop()).filter(f => f.shown);
        expect(shown.length).toBeGreaterThan(10);
        for (const f of shown) {
            expect(f.placed).toBe(true);
            expect(f.f).toBeGreaterThan(39 / 56);          // inside the loops
        }
        // One cursor node for the panel's whole life.
        await expect(panelOf(page, id2).locator('.region-cursor')).toHaveCount(1);
    });
});

test.describe('Region panel overview', () => {
    test('the view box: drag pans (never zooms), edges set the span, click centres, dblclick = whole take; Ctrl+wheel zooms about the Q under the pointer', async ({ page }) => {
        const { id2 } = await longTake(page);
        const panel = panelOf(page, id2);
        const viewbox = () => panel.locator('.region-viewbox').boundingBox();
        const ov = await panel.locator('.region-overview').boundingBox();
        const oy = ov.y + ov.height / 2;
        const qPerPx = 56 / ov.width;
        const v0 = await viewOf(page, id2);
        const box = await viewbox();
        expect((box.x - ov.x) * qPerPx).toBeCloseTo(v0.q0, 0);
        // PAN: drag the box left 100 px.
        await dragBy(page, { x: centre(box).x, y: oy }, -100, { steps: 6 });
        let v = await viewOf(page, id2);
        expect(v.q0).toBeCloseTo(v0.q0 - 100 * qPerPx, 3);
        expect(v.spanQ).toBeCloseTo(v0.spanQ, 9);
        // A VERTICAL drag does not zoom: the span holds.
        await dragBy(page, { x: centre(await viewbox()).x, y: oy }, 0, { dy: 60, steps: 6 });
        v = await viewOf(page, id2);
        expect(v.spanQ).toBeCloseTo(v0.spanQ, 9);
        // (Narrow the view for the edge drag below.)
        await page.keyboard.press('Equal');
        v = await viewOf(page, id2);
        expect(v.spanQ).toBeLessThan(v0.spanQ * 0.7);
        // EDGE: drag the box's end edge right → a wider span, start held.
        const b2 = await viewbox();
        const q0 = v.q0;
        await dragBy(page, { x: b2.x + b2.width - 1, y: oy }, 80, { steps: 6 });
        v = await viewOf(page, id2);
        expect(v.q0).toBeCloseTo(q0, 6);
        expect(v.spanQ).toBeGreaterThan(80 * qPerPx);
        // CLICK outside the box: the view centres there.
        await page.mouse.click(ov.x + ov.width * 0.1, oy);
        v = await viewOf(page, id2);
        expect(v.q0 + v.spanQ / 2).toBeCloseTo(5.6, 1);
        // DOUBLE-CLICK: the whole take.
        await page.mouse.dblclick(ov.x + ov.width * 0.5, oy);
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 56 });

        // CTRL+WHEEL over the overview, from the fit view. A point
        // INSIDE the view box, a quarter of the way in, holds its place
        // in the view while the view zooms out about it (the anchor is
        // the OVERVIEW's Q under the pointer).
        await page.keyboard.press('z');
        expect(await viewOf(page, id2)).toEqual(v0);
        const q = v0.q0 + v0.spanQ * 0.25;
        await ctrlWheel(page, ov.x + (q / 56) * ov.width, oy, 2);
        const v1 = await viewOf(page, id2);
        expect(v1.spanQ).toBeGreaterThan(v0.spanQ * 1.2);
        // The overview px is ~0.05Q wide at 56Q: allow that much drift.
        expect(Math.abs((q - v1.q0) / v1.spanQ - 0.25)).toBeLessThan(0.02);
        // OUTSIDE the view box: the view scales about its own middle.
        const mid = v1.q0 + v1.spanQ / 2;
        await ctrlWheel(page, ov.x + ov.width * 0.05, oy, -2);
        const v2 = await viewOf(page, id2);
        expect(v2.spanQ).toBeLessThan(v1.spanQ);
        expect(v2.q0 + v2.spanQ / 2).toBeCloseTo(mid, 1);
        // The main view never moved.
        expect(await zoomLevel(page)).toBe('100%');
    });

    test('a MIDI clip\'s piano roll draws in the panel at any zoom', async ({ page }) => {
        await boot(page, { scenario: 'midi-clip' });
        await selectLane(page, 'midi-1');
        const inked = () => stripOf(page, 'midi-1').evaluate(s => {
            const c = s.querySelector('.region-wave canvas');
            if (!c || c.style.display === 'none' || !c.width) return 0;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n;
        });
        await expect.poll(inked).toBeGreaterThan(0);
        const s = await stripOf(page, 'midi-1').boundingBox();
        await ctrlWheel(page, s.x + s.width * 0.25, s.y + s.height / 2, -4);
        expect((await viewOf(page, 'midi-1')).spanQ).toBeLessThan(1);
        await expect.poll(inked).toBeGreaterThan(0);
    });
});
