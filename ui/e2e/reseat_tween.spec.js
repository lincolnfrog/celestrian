/**
 * THE RE-SEAT TWEEN, in the running app (docs/frame.md §1; owner
 * 2026-10-01; app.js deriveFrame / patchFrame,
 * session_view/reseat_tween.js).
 *
 * The unit tests pin the rule (reseat_tween.test.mjs); this pins the
 * plumbing, with REAL mouse input: an edit that moves the frame's seat
 * — a swap that drops the placing loop's ↺, a ↺ drag, the undo of
 * either — no longer ends in a jump. The frame MOVES onto the new seat
 * over ~200 ms: every lane's handles and gridlines, the ruler and the
 * cursor together, landing exactly; the tiles' own morph is off while
 * it runs. What re-lays the picture out (a trim: the frame's length
 * changes) still snaps; a hand coming down completes the move at once;
 * under prefers-reduced-motion it jumps.
 *
 * The picture is sampled once per animation frame, inside the page.
 * The observables are the things drawn from the frame's zero: with the
 * mock clock still, the cursor, the ruler's lines, a lane's gridlines
 * and every lane's handles move if and only if the zero does — and by
 * the same amount.
 */

import { test, expect } from '@playwright/test';
import { node, loopOf, laneOf, selectLane, laneMarks as marks,
         handleTab as tabPoint, lanePxPerQ, dragBy as drag, slottedTopology }
    from './region_panel_helpers.js';

/** The clip-3 topology with B — the loop that PLACES the frame —
 * selected: B [4, 8) of a 12Q take, its ↺ and splice at the left edge
 * (and the splice's twin at the right); C slots in, its splice 3Q
 * along. A 4Q frame. */
async function setup(page) {
    const t = await slottedTopology(page);
    await selectLane(page, t.b);
    await expect.poll(() => marks(page, t.b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
    await expect.poll(() => marks(page, t.c)).toEqual(['top@0', 'wrap@3']);
    await installSampler(page, t);
    return t;
}

/** `window.__frames(ms)`: one row per animation frame for `ms` — where
 * B's ↺ and C's splice and ↺ are drawn (lane Q), the ruler's lines and
 * C's gridlines (Q), the cursor (Q), and whether #lanes says the frame
 * is moving. `window.__frame()`: one row, now. */
const installSampler = (page, ids) => page.evaluate(({ b, c }) => {
    const bodyOf = id => document.querySelector(`.lane[data-id="${id}"] .lane-body`);
    const ruler = document.getElementById('ruler');
    const lanes = document.getElementById('lanes');
    const centreQ = (h, body) => {
        if (!h) return null;
        const r = h.getBoundingClientRect(), br = body.getBoundingClientRect();
        return ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ;
    };
    const leftQ = (el, host, F) => {
        const r = el.getBoundingClientRect(), hr = host.getBoundingClientRect();
        return (r.left - hr.left) / hr.width * F;
    };
    const grab = () => {
        const B = bodyOf(b), C = bodyOf(c), F = B._cycleQ;
        const one = (body, sel) => centreQ(body.querySelector(
            `.lr-layer > ${sel}:not(.lr-ghost):not(.lr-end)`), body);
        return {
            t: performance.now(),
            F,
            topB: one(B, '.lr-top'),
            wrapC: one(C, '.lr-wrap'),
            topC: one(C, '.lr-top'),
            ticks: [...ruler.querySelectorAll('.tick')].map(t => leftQ(t, ruler, F)),
            grid: [...C.querySelectorAll('.grid-layer .gridline')].map(g => leftQ(g, C, F)),
            ph: parseFloat(document.getElementById('playhead').style.left) /
                ruler.clientWidth * F,
            moving: lanes.classList.contains('frame-tweening'),
        };
    };
    window.__frame = grab;
    window.__frames = ms => new Promise(done => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
            out.push(grab());
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
            else done(out);
        };
        requestAnimationFrame(tick);
    });
}, ids);

const frames = (page, ms) => page.evaluate(ms => window.__frames(ms), ms);
const frameNow = page => page.evaluate(() => window.__frame());

/** Mark when the NEXT press or key lands, on the sampler's clock
 * (`handAt`) — so a test can show the hand came down MID-move, and
 * read the frames after it. */
const armHandMark = page => page.evaluate(() => {
    window.__hand = null;
    const mark = () => { if (window.__hand === null) window.__hand = performance.now(); };
    window.addEventListener('pointerdown', mark, { capture: true, once: true });
    window.addEventListener('keydown', mark, { capture: true, once: true });
});
const handAt = page => page.evaluate(() => window.__hand);

/** x folded into [−½, ½) of a period P: a signed distance round it. */
const fold = (x, P) => ((x + P / 2) % P + P) % P - P / 2;

/** THE WHOLE PICTURE MOVED AS ONE: in every frame of `rows`, each thing
 * drawn from the frame's zero sits the same offset `o` from where it
 * lands — `o` read off B's ↺ (it lands on the left edge). */
function expectOnePicture(rows, { landWrapC, landPh }) {
    for (const f of rows) {
        const o = f.topB;
        const msg = what => `${what} at offset ${o.toFixed(3)}`;
        expect(Math.abs(fold(f.wrapC - landWrapC - o, f.F)), msg('C splice')).toBeLessThan(0.02);
        expect(Math.abs(fold(f.topC - o, f.F)), msg('C ↺')).toBeLessThan(0.02);
        expect(Math.abs(fold(f.ph - landPh - o, f.F)), msg('the cursor')).toBeLessThan(0.02);
        for (const q of f.ticks) {
            expect(Math.abs(fold(q - o, 1)), msg('ruler line ' + q.toFixed(3))).toBeLessThan(0.02);
        }
        for (const q of f.grid) {
            expect(Math.abs(fold(q - o, 1)), msg('gridline ' + q.toFixed(3))).toBeLessThan(0.02);
        }
    }
}

test.describe('The re-seat tween', () => {
    test('a swap that drops the ↺: on release the whole frame moves onto the new seat — together, ~200 ms, landing exactly', async ({ page }) => {
        const { Q, b, c } = await setup(page);
        const rest = await frameNow(page);
        // Drag B's splice +1Q: [5, 9). Its ↺ (raw 4) is dropped and
        // resets to the new region start, which sounds 1Q into the
        // PINNED frame — the seat is 1Q on, and C's ↺ (the sample at the
        // frame's top) says so too.
        const pxq = await lanePxPerQ(page, b);
        await drag(page, await tabPoint(page, b, 'wrap'), 1.2 * pxq, { hold: true });
        await expect(laneOf(page, b).locator('.lr-badge')).toHaveText(/swap · splice \+1Q/);
        await expect.poll(async () => (await frameNow(page)).topC).toBeCloseTo(1, 2);
        const held = await frameNow(page);
        expect(held.wrapC, 'pinned: nothing else moved').toBeCloseTo(3, 2);
        expect(held.ph).toBeCloseTo(rest.ph, 2);
        expect(held.moving).toBe(false);

        // RELEASE — and watch every frame.
        const watching = frames(page, 700);
        await page.mouse.up();
        const rows = await watching;
        expect(await loopOf(page, b, Q)).toBe('5,9');
        const moving = rows.filter(f => f.moving);
        expect(moving.length, 'frames of the move').toBeGreaterThan(5);
        // It starts from the picture the hand left (no jump)…
        expect(moving[0].topB).toBeCloseTo(1, 1);
        // …passes through the places between, never more than a third
        // of the way in one frame, never backwards…
        const between = moving.filter(f => f.topB > 0.05 && f.topB < 0.95);
        expect(between.length, 'frames mid-move').toBeGreaterThan(3);
        for (let i = 1; i < moving.length; i++) {
            const step = moving[i - 1].topB - moving[i].topB;
            expect(step, 'toward the seat').toBeGreaterThan(-0.005);
            expect(step, 'no jump').toBeLessThan(0.34);
        }
        // …for about 200 ms…
        const ms = moving.at(-1).t - moving[0].t;
        expect(ms).toBeGreaterThan(120);
        expect(ms).toBeLessThan(400);
        // …everything drawn from the zero moving as one picture…
        expectOnePicture(moving, { landWrapC: 2, landPh: rest.ph - 1 });
        // …and lands exactly: B's ↺ on the left edge, C's splice 2Q
        // along, whole-Q lines, the move over.
        const last = rows.at(-1);
        expect(last.moving).toBe(false);
        expect(last.topB).toBeCloseTo(0, 2);
        expect(last.wrapC).toBeCloseTo(2, 2);
        expect(last.topC).toBeCloseTo(0, 2);
        expect(last.ticks.map(q => +q.toFixed(2))).toEqual([0, 1, 2, 3, 4]);
        await expect.poll(() => marks(page, b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
    });

    test('a ↺ drag (a shift) ends the same way; its undo moves the frame back', async ({ page }) => {
        const { Q, b, c } = await setup(page);
        const pxq = await lanePxPerQ(page, b);
        // B's ↺ +1Q: the take plays 1Q later. Pinned, B's audio, ↺ and
        // splice ride the hand; released, the frame moves onto the ↺.
        await drag(page, await tabPoint(page, b, 'top'), 1.3 * pxq, { hold: true });
        await expect(laneOf(page, b).locator('.lr-badge')).toHaveText(/shift \+1Q/);
        let watching = frames(page, 700);
        await page.mouse.up();
        let rows = await watching;
        expect((await node(page, b)).retime / Q).toBe(1);
        let moving = rows.filter(f => f.moving);
        expect(moving.length, 'frames of the move').toBeGreaterThan(5);
        expect(moving.filter(f => f.topB > 0.05 && f.topB < 0.95).length)
            .toBeGreaterThan(3);
        expect(rows.at(-1).moving).toBe(false);
        expect(rows.at(-1).topB).toBeCloseTo(0, 2);
        // The others slot in 1Q earlier in the new frame.
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);

        // ⌘Z: no hand, no pin — the frame moves back from where it is.
        await page.waitForTimeout(300);
        watching = frames(page, 700);
        await page.keyboard.press('ControlOrMeta+z');
        rows = await watching;
        expect((await node(page, b)).retime).toBe(0);
        moving = rows.filter(f => f.moving);
        expect(moving.length, 'the undo moves too').toBeGreaterThan(5);
        // C's splice: 2Q → 3Q, through the places between.
        expect(moving.filter(f => f.wrapC > 2.05 && f.wrapC < 2.95).length)
            .toBeGreaterThan(3);
        expect(rows.at(-1).moving).toBe(false);
        expect(rows.at(-1).wrapC).toBeCloseTo(3, 2);
        await expect.poll(() => marks(page, b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
    });

    test('a re-layout still snaps: a trim changes the frame\'s length', async ({ page }) => {
        const { Q, b } = await setup(page);
        // ⇧ on B's END handle, 1Q inward: [4, 7) — a 3Q loop, so the
        // frame is re-laid out (3Q against C's 4Q: 12Q). No move.
        const pxq = await lanePxPerQ(page, b);
        const at = await tabPoint(page, b, 'wrap', { end: true });
        const watching = frames(page, 900);
        await drag(page, at, -1.1 * pxq, { mods: ['Shift'] });
        const rows = await watching;
        await expect.poll(() => loopOf(page, b, Q)).toBe('4,7');
        expect(rows.some(f => f.moving), 'never a tween').toBe(false);
        await expect.poll(() => laneOf(page, b).locator('.lane-body')
            .evaluate(el => el._cycleQ)).toBe(12);
    });

    test('playing: the cursor rides the move and keeps its pace', async ({ page }) => {
        const { b } = await setup(page);
        await page.evaluate(() => window.__celestrianTest.startTransport());
        await page.waitForTimeout(400);
        const pxq = await lanePxPerQ(page, b);
        await drag(page, await tabPoint(page, b, 'wrap'), 1.2 * pxq, { hold: true });
        await expect.poll(async () => (await frameNow(page)).topC).toBeCloseTo(1, 2);
        const watching = frames(page, 900);
        await page.mouse.up();
        const rows = await watching;
        expect(rows.some(f => f.moving)).toBe(true);
        // Measured against the picture it rides (B's ↺ marks the frame's
        // own move), the cursor only ever runs FORWARD at the
        // transport's pace (1Q a second here): it never steps back, and
        // never stalls — a re-render fed to the dead-reckoner as a poll
        // would read its stale clock as a teleport.
        const rel = rows.map(f => f.ph - f.topB);
        const steps = rel.slice(1).map((x, i) => fold(x - rel[i], rows[0].F));
        expect(Math.min(...steps), 'never back').toBeGreaterThan(-0.01);
        expect(steps.filter(d => d < 0.004).length, 'never stalls').toBeLessThanOrEqual(2);
        const travel = steps.reduce((a, d) => a + d, 0);
        const secs = (rows.at(-1).t - rows[0].t) / 1000;
        expect(travel).toBeGreaterThan(secs * 0.7);
        expect(travel).toBeLessThan(secs * 1.3);
    });

    test('a hand coming down mid-move completes it at once, on the grid', async ({ page }) => {
        const { b } = await setup(page);
        const pxq = await lanePxPerQ(page, b);
        // The panel's navigator is raw time, pinned to the viewport — it
        // does not move with the frame — and a press on its view box is
        // a gesture that changes nothing (a pan by 0).
        const vb = await laneOf(page, b).locator('.region-viewbox').boundingBox();
        const press = { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 };
        await drag(page, await tabPoint(page, b, 'wrap'), 1.2 * pxq, { hold: true });
        await expect.poll(async () => (await frameNow(page)).topC).toBeCloseTo(1, 2);
        await armHandMark(page);
        const watching = frames(page, 800);
        await page.mouse.up();
        await page.waitForFunction(() => window.__frame().moving);
        await page.mouse.move(press.x, press.y);
        await page.mouse.down();
        const rows = await watching;
        const pressed = await handAt(page);
        await page.mouse.up();
        // The press came MID-move — the frame had most of its way still
        // to go…
        const before = rows.filter(f => f.t < pressed);
        expect(before.at(-1).moving, 'pressed mid-move').toBe(true);
        expect(before.at(-1).topB).toBeGreaterThan(0.2);
        // …and within a frame or two of it the move is over and the
        // frame is ON the seat — never left part-way under the hand.
        const settled = rows.filter(f => f.t > pressed + 50);
        expect(settled.length).toBeGreaterThan(3);
        for (const f of settled) {
            expect(f.moving, 'no move under a hand').toBe(false);
            expect(f.topB, 'on the seat').toBeCloseTo(0, 2);
            expect(f.ticks.map(q => +q.toFixed(2))).toEqual([0, 1, 2, 3, 4]);
        }
    });

    test('a pin taken mid-move holds the SEAT, never the passing zero', async ({ page }) => {
        const { Q, b } = await setup(page);
        const pxq = await lanePxPerQ(page, b);
        await drag(page, await tabPoint(page, b, 'wrap'), 1.2 * pxq, { hold: true });
        await expect.poll(async () => (await frameNow(page)).topC).toBeCloseTo(1, 2);
        await armHandMark(page);
        const watching = frames(page, 800);
        await page.mouse.up();
        await page.waitForFunction(() => window.__frame().moving);
        // → mid-move: the nudge chain pins the frame AT ONCE (keyboard,
        // makeChainPin) and nudges B to [6, 10). The pin must hold the
        // frame the move was landing on — whole-Q lines — for the whole
        // chain, not the off-grid zero it was passing through.
        await page.keyboard.press('ArrowRight');
        const rows = await watching;
        const pressed = await handAt(page);
        await expect.poll(() => loopOf(page, b, Q)).toBe('6,10');
        const before = rows.filter(f => f.t < pressed);
        expect(before.at(-1).moving, 'pressed mid-move').toBe(true);
        expect(before.at(-1).topB).toBeGreaterThan(0.2);
        const pinned = rows.filter(f => f.t > pressed + 50);
        expect(pinned.length).toBeGreaterThan(8);
        for (const f of pinned) {
            expect(f.moving, 'pinned: no move').toBe(false);
            expect(f.ticks.map(q => +q.toFixed(2)), 'a grid-true frame')
                .toEqual([0, 1, 2, 3, 4]);
        }
        // In that frame the nudged loop's ↺ — reset to its new start —
        // sits 1Q along; the chain over, the frame moves onto it.
        expect(pinned.at(-1).topB).toBeCloseTo(1, 2);
        await expect.poll(() => marks(page, b), { timeout: 4000 })
            .toEqual(['top@0', 'wrap@0', 'wrap@4']);
    });

    test('prefers-reduced-motion: the frame jumps', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const { Q, b, c } = await setup(page);
        const pxq = await lanePxPerQ(page, b);
        await drag(page, await tabPoint(page, b, 'wrap'), 1.2 * pxq, { hold: true });
        await expect.poll(async () => (await frameNow(page)).topC).toBeCloseTo(1, 2);
        const watching = frames(page, 500);
        await page.mouse.up();
        const rows = await watching;
        expect(await loopOf(page, b, Q)).toBe('5,9');
        expect(rows.some(f => f.moving)).toBe(false);
        expect(rows.filter(f => f.topB > 0.05 && f.topB < 0.95).length,
            'no places between').toBe(0);
        expect(rows.at(-1).topB).toBeCloseTo(0, 2);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
    });
});
