/**
 * THE ZOOMABLE REGION PANEL (loop-region phase 1, owner-ruled
 * 2026-09-23 — docs/time_maps.md §6 "The region panel").
 *
 * Field video (2026-09-22): "it's awkward that I can't zoom in that
 * view … smaller localized edits are really tricky." The panel now
 * draws the take through its OWN per-lane view (panel_view.js): fit to
 * the loop by default, Ctrl/⌘+wheel or pinch to zoom about the pointer
 * (the main view no longer zooms under it), Shift+wheel to pan, Z / ⇧Z
 * and the label's terms to fit the loop / the take, a whole-take
 * overview strip whose box is the view. Every interactive element gets
 * REAL mouse/keyboard input (synthetic dispatch bypasses hit-testing —
 * the 2026-07-23c law). The letters are the diagnosis' N10 list.
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, node, loopOf, segsOf, recordDefinerAndTake,
         recordTake, setLoop, laneOf, panelOf, stripOf, viewOf, stripX,
         stripQ, selectLane, keptBoxAt, ctrlWheel } from './region_panel_helpers.js';

/** The field topology: a 1Q definer, a 56Q take looped at [40, 45). */
async function fieldCase(page) {
    await boot(page);
    const Q = await quantum(page);
    const { id1, id2 } = await recordDefinerAndTake(page, Q, 56);
    await setLoop(page, id2, 40 * Q, 45 * Q);
    await selectLane(page, id2);
    await keptBoxAt(page, id2, 40, 45);
    return { Q, id1, id2 };
}

const zoomLevel = page => page.locator('#zoom-level').textContent();

test.describe('Region panel view', () => {
    test('(a) fit region by default; the whole take when the loop is most of it', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        // The 5Q loop fills 55% of the strip, centred (≈6× today's
        // 12 px/Q whole-take scale).
        const v = await viewOf(page, id2);
        expect(5 / v.spanQ).toBeCloseTo(0.55, 6);
        expect(v.q0 + v.spanQ / 2).toBeCloseTo(42.5, 6);
        // A loop that is most of its take opens on the whole take.
        const id3 = await recordTake(page, Q, 12);
        await setLoop(page, id3, 1 * Q, 9 * Q);
        await selectLane(page, id3);
        expect(await viewOf(page, id3)).toEqual({ q0: 0, spanQ: 12 });
    });

    test('(b) Ctrl+wheel zooms the PANEL about the pointer; the main view stays put', async ({ page }) => {
        const { id2 } = await fieldCase(page);
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
        // The MAIN view neither zoomed nor scrolled (N2).
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
        await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -100);
        await page.keyboard.up('Control');
        await expect.poll(() => zoomLevel(page)).not.toBe('100%');
    });

    test('(c) Shift+wheel and a sideways swipe pan, clamped at the take ends; a plain wheel does not', async ({ page }) => {
        const { id2 } = await fieldCase(page);
        const s = await stripOf(page, id2).boundingBox();
        const x = s.x + s.width / 2;
        const y = s.y + s.height / 2;
        const v0 = await viewOf(page, id2);
        await page.mouse.move(x, y);
        await page.mouse.wheel(0, 100);                    // plain: page scroll
        expect(await viewOf(page, id2)).toEqual(v0);
        await page.keyboard.down('Shift');
        await page.mouse.wheel(0, 100);
        await page.keyboard.up('Shift');
        const v1 = await viewOf(page, id2);
        expect(v1.spanQ).toBeCloseTo(v0.spanQ, 9);
        expect(v1.q0 - v0.q0).toBeCloseTo(100 / s.width * v0.spanQ, 3);
        // Far right: clamped at the take's end.
        for (let i = 0; i < 12; i++) await page.mouse.wheel(300, 0);
        let v = await viewOf(page, id2);
        expect(v.q0 + v.spanQ).toBeCloseTo(56, 6);
        // Far left: clamped at 0.
        await page.keyboard.down('Shift');
        for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -300);
        await page.keyboard.up('Shift');
        v = await viewOf(page, id2);
        expect(v.q0).toBe(0);
        expect(v.spanQ).toBeCloseTo(v0.spanQ, 9);
        expect(await zoomLevel(page)).toBe('100%');
    });

    test('(d) Z / ⇧Z and the label terms fit the loop / the whole take', async ({ page }) => {
        const { id2 } = await fieldCase(page);
        const lane = laneOf(page, id2);
        const fit = await viewOf(page, id2);
        await page.keyboard.press('Shift+Z');
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 56 });
        await page.keyboard.press('z');
        expect(await viewOf(page, id2)).toEqual(fit);
        await lane.locator('.region-term.take').click();
        expect(await viewOf(page, id2)).toEqual({ q0: 0, spanQ: 56 });
        await expect(lane.locator('.region-term.loop')).toHaveText('loop 5Q');
        await lane.locator('.region-term.loop').click();
        expect(await viewOf(page, id2)).toEqual(fit);
        // No panel shown (nothing selected): z is unbound — no error,
        // and the remembered view is untouched.
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await page.keyboard.press('Shift+Z');
        await selectLane(page, id2);
        expect(await viewOf(page, id2)).toEqual(fit);
    });

    test('(e) slide, trim and double-click cut under a zoomed view (the cut lands on the take\'s Q grid)', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        const lane = laneOf(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        const y = s.y + s.height / 2;
        await ctrlWheel(page, s.x + s.width / 2, y, -1);
        const v = await viewOf(page, id2);
        expect(v.spanQ).toBeLessThan(8);
        const pxPerQ = s.width / v.spanQ;
        // ⌥ FREE SLIDE by ¼Q — at this zoom ~0.005Q per px.
        let k = await keptBoxAt(page, id2, 40, 45);
        await page.mouse.move(k.x + k.width / 2, y);
        await page.keyboard.down('Alt');
        await page.mouse.down();
        await page.mouse.move(k.x + k.width / 2 + 0.25 * pxPerQ, y, { steps: 8 });
        await page.mouse.up();
        await page.keyboard.up('Alt');
        await expect.poll(async () => (await node(page, id2)).loopStart / Q)
            .toBeCloseTo(40.25, 2);
        const a = (await node(page, id2)).loopStart / Q;
        // A PLAIN slide moves whole Qs from there (+1.3 → +1).
        k = await keptBoxAt(page, id2, a, a + 5);
        await page.mouse.move(k.x + k.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(k.x + k.width / 2 + 1.3 * pxPerQ, y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).loopStart / Q)
            .toBeCloseTo(a + 1, 4);
        // TRIM the end in by 1.2Q: the period snaps to whole Qs (4Q).
        await keptBoxAt(page, id2, a + 1, a + 6);
        const eb = await lane.locator('.region-bracket.end').boundingBox();
        await page.mouse.move(eb.x + eb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(eb.x + eb.width / 2 - 1.2 * pxPerQ, y, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => {
            const n = await node(page, id2);
            return Math.round((n.loopEnd - n.loopStart) / Q * 1e6) / 1e6;
        }).toBe(4);
        // DOUBLE-CLICK at raw 43.5 after the free slide: a 1Q cut on the
        // TAKE's own Q grid, [43, 44) — never offset by the slide
        // (owner, 2026-09-23).
        await keptBoxAt(page, id2, a + 1, a + 5);
        await page.mouse.dblclick(await stripX(page, id2, 43.5), y);
        await expect.poll(async () => {
            const segs = (await segsOf(page, id2, Q)).split(',').map(Number);
            return segs.length === 4 &&
                Math.abs(segs[1] - 43) < 1e-3 && Math.abs(segs[2] - 44) < 1e-3;
        }).toBe(true);
        await expect(lane.locator('.region-overlay .cut-band')).toHaveCount(1);
    });

    test('(f) a trim held at the strip\'s edge pans the view and lands beyond it', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        const lane = laneOf(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        const y = s.y + s.height / 2;
        await ctrlWheel(page, await stripX(page, id2, 45), y, -2);
        const v0 = await viewOf(page, id2);
        expect(v0.q0 + v0.spanQ).toBeLessThan(49);
        await keptBoxAt(page, id2, 40, 45);
        const eb = await lane.locator('.region-bracket.end').boundingBox();
        await page.mouse.move(eb.x + eb.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(s.x + s.width - 4, y, { steps: 8 });
        // The view pans under the held hand (rAF-paced: poll).
        await expect.poll(async () => (await viewOf(page, id2)).q0,
            { timeout: 5000 }).toBeGreaterThan(v0.q0 + 2);
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).loopEnd / Q)
            .toBeGreaterThan(v0.q0 + v0.spanQ);
        const n = await node(page, id2);
        expect(Number.isInteger((n.loopEnd - n.loopStart) / Q)).toBe(true);
        expect(n.loopStart / Q).toBe(40);
        // The zoom never changed.
        expect((await viewOf(page, id2)).spanQ).toBeCloseTo(v0.spanQ, 9);
    });

    test('(g) a nudge pans the view to keep the region in sight — never zooms', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        const v0 = await viewOf(page, id2);
        await page.keyboard.press('Shift+ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('44,49');
        const v = await viewOf(page, id2);
        expect(v.spanQ).toBeCloseTo(v0.spanQ, 9);
        expect(v.q0).toBeGreaterThan(v0.q0);
        expect(v.q0).toBeLessThanOrEqual(44);
        expect(v.q0 + v.spanQ).toBeGreaterThanOrEqual(49);
        await keptBoxAt(page, id2, 44, 49);
    });

    test('(h) ] walks the LANE\'s handles, never the panel\'s', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 2 * Q, 10 * Q);
        await selectLane(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        // A cut in the panel: its bands carry the lane's .cut-handle.
        await page.keyboard.press('Shift+Z');
        await page.mouse.dblclick(await stripX(page, id2, 5.5), s.y + s.height / 2);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('2,5,6,10');
        await expect(laneOf(page, id2).locator('.lane-region .cut-handle')).toHaveCount(2);
        for (let i = 0; i < 6; i++) await page.click('#zoom-in-btn');
        // Record every flash for the whole walk.
        await page.evaluate(() => {
            window.__flashes = [];
            new MutationObserver(ms => ms.forEach(m => {
                const t = m.target;
                if (t.classList && t.classList.contains('teleport-flash')) {
                    window.__flashes.push(t.closest('.lane-region') ? 'panel' : 'lane');
                }
            })).observe(document.body, { subtree: true, attributes: true,
                                         attributeFilter: ['class'] });
        });
        const scrolls = [];
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press(']');
            scrolls.push(await page.evaluate(() =>
                document.getElementById('session').scrollLeft));
        }
        const flashes = await page.evaluate(() => window.__flashes);
        expect(flashes).not.toContain('panel');
        expect(flashes).toContain('lane');
        // The walk moved and then stopped at the last handle — it never
        // creeps ~45 px per press on the panel's handle.
        expect(new Set(scrolls).size).toBeGreaterThan(1);
        expect(scrolls[scrolls.length - 1]).toBe(scrolls[scrolls.length - 2]);
    });

    test('(i) the view survives deselect/reselect and resets on a new take', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        const s = await stripOf(page, id2).boundingBox();
        await ctrlWheel(page, s.x + s.width * 0.7, s.y + s.height / 2, -3);
        const zoomed = await viewOf(page, id2);
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await selectLane(page, id2);
        expect(await viewOf(page, id2)).toEqual(zoomed);
        // A NEW TAKE of a different length (undo the take, record
        // 24Q into the same clip, loop it — deselected meanwhile, so
        // the panel first meets the take with its loop): the view
        // starts over at fit region.
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await page.evaluate(() => window.__celestrianTest.callNative('undo'));  // the loop
        await page.evaluate(() => window.__celestrianTest.callNative('undo'));  // the take
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

    test('(j) the panel keeps one width at every main zoom and scroll; the kept box stays on screen', async ({ page }) => {
        const { id2 } = await fieldCase(page);
        const panel = laneOf(page, id2).locator('.region-panel');
        const p0 = await panel.boundingBox();
        const v0 = await viewOf(page, id2);
        const sess = await page.locator('#session').boundingBox();
        const check = async () => {
            await expect.poll(async () => {
                const p = await panel.boundingBox();
                return Math.abs(p.x - p0.x) < 1 && Math.abs(p.width - p0.width) < 1;
            }).toBe(true);
            const k = await laneOf(page, id2).locator('.region-kept').boundingBox();
            expect(k.x).toBeGreaterThanOrEqual(sess.x);
            expect(k.x + k.width).toBeLessThanOrEqual(sess.x + sess.width);
        };
        // Main zoom 125% with the rail on screen (the N3 overflow case).
        await page.click('#zoom-in-btn');
        await page.evaluate(() => { document.getElementById('session').scrollLeft = 0; });
        await check();
        for (let i = 0; i < 3; i++) await page.click('#zoom-in-btn');
        await page.evaluate(() => {
            const s = document.getElementById('session');
            s.scrollLeft = s.scrollWidth;
        });
        await check();
        await page.evaluate(() => {
            const s = document.getElementById('session');
            s.scrollLeft = s.scrollWidth / 3;
        });
        await check();
        // The panel's own scale is independent of the main zoom.
        expect(await viewOf(page, id2)).toEqual(v0);
    });

    test('(k) a 1Q box on a long take is grabbable at its centre (a slide, not a bracket)', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 56);
        await setLoop(page, id2, 40 * Q, 41 * Q);
        await selectLane(page, id2);
        await page.keyboard.press('Shift+Z');               // ~20 px per Q
        const k = await keptBoxAt(page, id2, 40, 41);
        expect(k.width).toBeLessThan(30);
        const cx = k.x + k.width / 2;
        const cy = k.y + k.height / 2;
        expect(await page.evaluate(({ x, y }) =>
            document.elementFromPoint(x, y).className, { x: cx, y: cy }))
            .toMatch(/region-kept/);
        const s = await stripOf(page, id2).boundingBox();
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 3 * s.width / 56, cy, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('43,44');
        // The brackets still trim, from outside the box.
        const k2 = await keptBoxAt(page, id2, 43, 44);
        const eb = await laneOf(page, id2).locator('.region-bracket.end').boundingBox();
        expect(eb.x).toBeGreaterThanOrEqual(k2.x + k2.width - 1);
        await page.mouse.move(eb.x + eb.width / 2, cy);
        await page.mouse.down();
        await page.mouse.move(eb.x + eb.width / 2 + 2 * s.width / 56, cy, { steps: 8 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('43,46');
    });

    test('(l) the panel cursor never sits at raw 0 after a rebuild', async ({ page }) => {
        const { Q, id2 } = await fieldCase(page);
        await page.keyboard.press('Shift+Z');               // raw 0 = the strip's left
        await page.keyboard.press('Space');                 // play
        await expect(laneOf(page, id2).locator('.region-cursor')).toBeVisible();
        // Sample every frame while the map changes (each change is a
        // keyed overlay rebuild).
        const samples = await page.evaluate(async ({ id, Q }) => {
            const strip = document.querySelector(`.lane[data-id="${id}"] .region-strip`);
            const out = [];
            let run = true;
            const tick = () => {
                const cur = strip.querySelector('.region-cursor');
                if (cur && cur.style.display !== 'none') {
                    const r = cur.getBoundingClientRect();
                    const s = strip.getBoundingClientRect();
                    out.push({ left: cur.style.left, f: (r.left - s.left) / s.width });
                }
                if (run) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            const c = window.__celestrianTest.callNative;
            for (let i = 0; i < 6; i++) {
                await c('setLoopPoints', id, (40 + (i % 2)) * Q, (45 + (i % 2)) * Q);
                await new Promise(r => setTimeout(r, 90));
            }
            run = false;
            return out;
        }, { id: id2, Q });
        expect(samples.length).toBeGreaterThan(10);
        for (const s of samples) {
            expect(s.left).not.toBe('');
            expect(s.f).toBeGreaterThan(39 / 56);            // inside the loops
        }
        // One cursor node for the panel's whole life.
        await expect(laneOf(page, id2).locator('.region-cursor')).toHaveCount(1);
    });
});

test.describe('Region panel overview', () => {
    test('the view box: drag pans, drag down zooms, edges set the span, click centres, dblclick = whole take', async ({ page }) => {
        const { id2 } = await fieldCase(page);
        const lane = laneOf(page, id2);
        const ov = await lane.locator('.region-overview').boundingBox();
        const oy = ov.y + ov.height / 2;
        const qPerPx = 56 / ov.width;
        const v0 = await viewOf(page, id2);
        const box = await lane.locator('.region-viewbox').boundingBox();
        expect((box.x - ov.x) * qPerPx).toBeCloseTo(v0.q0, 0);
        // PAN: drag the box left 100 px.
        const bx = box.x + box.width / 2;
        await page.mouse.move(bx, oy);
        await page.mouse.down();
        await page.mouse.move(bx - 100, oy, { steps: 6 });
        await page.mouse.up();
        let v = await viewOf(page, id2);
        expect(v.q0).toBeCloseTo(v0.q0 - 100 * qPerPx, 3);
        expect(v.spanQ).toBeCloseTo(v0.spanQ, 9);
        // ZOOM: drag the box DOWN (in), centre held.
        const b1 = await lane.locator('.region-viewbox').boundingBox();
        const c1 = v.q0 + v.spanQ / 2;
        await page.mouse.move(b1.x + b1.width / 2, oy);
        await page.mouse.down();
        await page.mouse.move(b1.x + b1.width / 2, oy + 60, { steps: 6 });
        await page.mouse.up();
        v = await viewOf(page, id2);
        expect(v.spanQ).toBeLessThan(v0.spanQ * 0.7);
        expect(v.q0 + v.spanQ / 2).toBeCloseTo(c1, 3);
        // EDGE: drag the box's end edge right → a wider span, start held.
        const b2 = await lane.locator('.region-viewbox').boundingBox();
        const q0 = v.q0;
        await page.mouse.move(b2.x + b2.width - 1, oy);
        await page.mouse.down();
        await page.mouse.move(b2.x + b2.width - 1 + 80, oy, { steps: 6 });
        await page.mouse.up();
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
        // The main view never moved.
        expect(await zoomLevel(page)).toBe('100%');
    });

    test('Ctrl+wheel over the overview zooms about the Q under the pointer', async ({ page }) => {
        // Review 2026-09-23: over the overview the zoom anchored at the
        // DETAIL strip's fraction of the view, not at the overview Q.
        const { id2 } = await fieldCase(page);
        const lane = laneOf(page, id2);
        const ov = await lane.locator('.region-overview').boundingBox();
        const oy = ov.y + ov.height / 2;
        const v0 = await viewOf(page, id2);
        // A point INSIDE the view box, a quarter of the way in: it holds
        // its place in the view while the view zooms out about it.
        const q = v0.q0 + v0.spanQ * 0.25;
        const x = ov.x + (q / 56) * ov.width;
        await ctrlWheel(page, x, oy, 2);
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
        expect(await zoomLevel(page)).toBe('100%');
    });

    test('a MIDI clip\'s piano roll draws in the panel at any zoom', async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('midi-clip'));
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
