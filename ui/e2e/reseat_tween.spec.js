/**
 * THE RE-SEAT TWEEN, in the running app (docs/frame.md §1; app.js
 * deriveFrame / patchFrame, session_view/reseat_tween.js).
 *
 * The unit tests pin the rule (reseat_tween.test.mjs); this pins the
 * plumbing: an edit that moves the frame's seat — a swap that drops the
 * placing loop's ↺, a ↺ drag, the undo of either — does not end in a
 * jump. The frame MOVES onto the new seat over ~200 ms: every lane's
 * handles and gridlines, the ruler and the cursor together, landing
 * exactly. A hand coming down completes the move at once; under
 * prefers-reduced-motion it jumps. (What re-lays the picture out — a
 * trim: the frame's length changes — snaps: slotted_loop.spec.js.)
 *
 * The picture is sampled once per animation frame, inside the page.
 * The observables are the things drawn from the frame's zero: with the
 * mock clock still, the cursor, the ruler's lines, a lane's gridlines
 * and every lane's handles move if and only if the zero does — and by
 * the same amount.
 */

import { test, expect } from '@playwright/test';
import { mock, node, loopOf, laneOf, panelOf, selectLane, laneMarks as marks,
         centreOf, gripDrag, undo, sampleFrames, watchFrames, settled,
         slottedTopology }
    from './helpers.js';

/** The clip-3 topology with B — the loop that PLACES the frame —
 * selected: B [4, 8) of a 12Q take, its ↺ and splice at the left edge
 * (and the splice's twin at the right); C slots in, its splice 3Q
 * along. A 4Q frame. */
async function setup(page) {
    const t = await slottedTopology(page);
    await selectLane(page, t.b);
    await expect.poll(() => marks(page, t.b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
    await expect.poll(() => marks(page, t.c)).toEqual(['top@0', 'wrap@3']);
    return t;
}

/** One row of the picture, read in the page: where B's ↺ and C's splice
 * and ↺ are drawn (lane Q), the ruler's lines and C's gridlines (Q),
 * the cursor (Q), and whether #lanes says the frame is moving. */
const picture = ({ b, c }) => {
    const bodyOf = id => document.querySelector(`.lane[data-id="${id}"] .lane-body`);
    const ruler = document.getElementById('ruler');
    const B = bodyOf(b);
    const C = bodyOf(c);
    const F = B._cycleQ;
    const centreQ = (body, sel) => {
        const h = body.querySelector(`.lr-layer > ${sel}:not(.lr-ghost):not(.lr-end)`);
        if (!h) return null;
        const r = h.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        return ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ;
    };
    const leftQ = (el, host) => {
        const r = el.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        return (r.left - hr.left) / hr.width * F;
    };
    return {
        F,
        topB: centreQ(B, '.lr-top'),
        wrapC: centreQ(C, '.lr-wrap'),
        topC: centreQ(C, '.lr-top'),
        ticks: [...ruler.querySelectorAll('.tick')].map(t => leftQ(t, ruler)),
        grid: [...C.querySelectorAll('.grid-layer .gridline')].map(g => leftQ(g, C)),
        ph: parseFloat(document.getElementById('playhead').style.left) /
            ruler.clientWidth * F,
        moving: document.getElementById('lanes').classList.contains('frame-tweening'),
    };
};

const frameNow = async (page, ids) =>
    (await sampleFrames(page, picture, ids, { frames: 1 }))[0];

/** Every frame from just before `act` until the view is at rest again.
 * `moves`: wait for the frame to be seen moving first. */
async function through(page, ids, act, { moves = true } = {}) {
    const watch = await watchFrames(page, picture, ids);
    await act();
    if (moves) {
        await expect.poll(async () => (await watch.rows()).some(f => f.moving)).toBe(true);
    }
    await settled(page);
    return watch.stop();
}

/** B's splice dragged +1Q and held: its ↺ (raw 4) is dropped and resets
 * to the new region start, which sounds 1Q into the PINNED frame — the
 * seat is 1Q on, and C's ↺ (the sample at the frame's top) says so. */
async function holdSwap(page, t) {
    await gripDrag(page, t.b, 'wrap', 1.2, { hold: true });
    await expect.poll(async () => (await frameNow(page, t)).topC).toBeCloseTo(1, 2);
}

/** The swap released and, with the frame MID-MOVE, `hand()` coming
 * down. Returns the sampler (running since before the release), when
 * the hand landed on its clock, and `since()`: the frames so far from
 * 50 ms after that. */
async function handMidMove(page, t, hand) {
    await holdSwap(page, t);
    await page.evaluate(() => {
        window.__hand = null;
        const mark = () => { if (window.__hand === null) window.__hand = performance.now(); };
        window.addEventListener('pointerdown', mark, { capture: true, once: true });
        window.addEventListener('keydown', mark, { capture: true, once: true });
    });
    const watch = await watchFrames(page, picture, t);
    await page.mouse.up();
    await page.waitForFunction(() =>
        document.getElementById('lanes').classList.contains('frame-tweening'));
    await hand();
    const pressed = await page.evaluate(() => window.__hand);
    const since = async () => (await watch.rows()).filter(f => f.t > pressed + 50);
    return { watch, pressed, since };
}

/** The hand came down MID-move — the frame had most of its way to go. */
function expectMidMove(rows, pressed) {
    const before = rows.filter(f => f.t < pressed);
    expect(before.at(-1).moving, 'pressed mid-move').toBe(true);
    expect(before.at(-1).topB).toBeGreaterThan(0.2);
}

/** x folded into [−½, ½) of a period P: a signed distance round it. */
const fold = (x, P) => ((x + P / 2) % P + P) % P - P / 2;

const GRID = [0, 1, 2, 3, 4];
const ticksOf = f => f.ticks.map(q => +q.toFixed(2));

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
    test('a swap that drops the ↺, its undo, a ↺ drag: the whole frame moves onto the new seat — together, ~200 ms, landing exactly', async ({ page }) => {
        const t = await setup(page);
        const { Q, b, c } = t;
        const rest = await frameNow(page, t);
        await holdSwap(page, t);
        await expect(laneOf(page, b).locator('.lr-badge')).toHaveText(/swap · splice \+1Q/);
        const held = await frameNow(page, t);
        expect(held.wrapC, 'pinned: nothing else moved').toBeCloseTo(3, 2);
        expect(held.ph).toBeCloseTo(rest.ph, 2);
        expect(held.moving).toBe(false);

        // RELEASE — and watch every frame.
        let rows = await through(page, t, () => page.mouse.up());
        expect(await loopOf(page, b, Q)).toBe('5,9');
        let moving = rows.filter(f => f.moving);
        expect(moving.length, 'frames of the move').toBeGreaterThan(5);
        // It starts from the picture the hand left (no jump)…
        expect(moving[0].topB).toBeCloseTo(1, 1);
        // …passes through the places between, never more than a third
        // of the way in one frame, never backwards…
        expect(moving.filter(f => f.topB > 0.05 && f.topB < 0.95).length, 'frames mid-move')
            .toBeGreaterThan(3);
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
        let last = rows.at(-1);
        expect(last.moving).toBe(false);
        expect(last.topB).toBeCloseTo(0, 2);
        expect(last.wrapC).toBeCloseTo(2, 2);
        expect(last.topC).toBeCloseTo(0, 2);
        expect(ticksOf(last)).toEqual(GRID);
        await expect.poll(() => marks(page, b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);

        // ⌘Z: no hand, no pin — the frame moves back from where it is.
        // C's splice: 2Q → 3Q, through the places between.
        rows = await through(page, t, () => undo(page));
        expect(await loopOf(page, b, Q)).toBe('4,8');
        moving = rows.filter(f => f.moving);
        expect(moving.length, 'the undo moves too').toBeGreaterThan(5);
        expect(moving.filter(f => f.wrapC > 2.05 && f.wrapC < 2.95).length)
            .toBeGreaterThan(3);
        last = rows.at(-1);
        expect(last.moving).toBe(false);
        expect(last.wrapC).toBeCloseTo(3, 2);
        await expect.poll(() => marks(page, b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);

        // A ↺ DRAG (a shift) ends the same way: B plays 1Q later.
        // Pinned, its audio, ↺ and splice ride the hand; released, the
        // frame moves onto the ↺, and the others slot in 1Q earlier.
        await gripDrag(page, b, 'top', 1.3, { hold: true });
        await expect(laneOf(page, b).locator('.lr-badge')).toHaveText(/shift \+1Q/);
        rows = await through(page, t, () => page.mouse.up());
        expect((await node(page, b)).retime / Q).toBe(1);
        moving = rows.filter(f => f.moving);
        expect(moving.length, 'frames of the move').toBeGreaterThan(5);
        expect(moving.filter(f => f.topB > 0.05 && f.topB < 0.95).length)
            .toBeGreaterThan(3);
        last = rows.at(-1);
        expect(last.moving).toBe(false);
        expect(last.topB).toBeCloseTo(0, 2);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
        // …and its undo moves the frame back.
        rows = await through(page, t, () => undo(page));
        expect((await node(page, b)).retime).toBe(0);
        expect(rows.filter(f => f.moving).length, 'the undo moves too').toBeGreaterThan(5);
        expect(rows.at(-1).wrapC).toBeCloseTo(3, 2);
    });

    test('playing: the cursor rides the move and keeps its pace', async ({ page }) => {
        const t = await setup(page);
        // The mock plays a fixed number of samples per wall second
        // whatever its rate (docs/test_harness.md): 1Q a second at
        // 44.1 kHz. From twice real time on, the dead-reckoner reads
        // every poll as a seek (playhead_clock.js) and has no pace to
        // keep.
        const pace = await page.evaluate(() =>
            window.__celestrianTest.SIMULATED_SAMPLES_PER_SECOND) / t.Q;
        test.skip(pace >= 1.9, 'at this mock rate the transport runs past the dead-reckoner');
        await mock(page, 'startTransport');
        const ph0 = (await frameNow(page, t)).ph;
        await expect.poll(async () => (await frameNow(page, t)).ph).not.toBe(ph0);
        await holdSwap(page, t);
        const watching = sampleFrames(page, picture, t, { ms: 900 });
        await page.mouse.up();
        const rows = await watching;
        expect(rows.some(f => f.moving)).toBe(true);
        // Measured against the picture it rides (B's ↺ marks the frame's
        // own move), the cursor only ever runs FORWARD at the
        // transport's pace: it never steps back, and never stalls — a
        // re-render fed to the dead-reckoner as a poll would read its
        // stale clock as a teleport.
        const rel = rows.map(f => f.ph - f.topB);
        const steps = rel.slice(1).map((x, i) => fold(x - rel[i], rows[0].F));
        expect(Math.min(...steps), 'never back').toBeGreaterThan(-0.01);
        expect(steps.filter(d => d < 0.004 * pace).length, 'never stalls')
            .toBeLessThanOrEqual(2);
        const travel = steps.reduce((a, d) => a + d, 0);
        const run = pace * (rows.at(-1).t - rows[0].t) / 1000;
        expect(travel).toBeGreaterThan(run * 0.7);
        expect(travel).toBeLessThan(run * 1.3);
    });

    test('a hand coming down mid-move completes it at once, on the grid', async ({ page }) => {
        const t = await setup(page);
        // The panel's navigator is raw time, pinned to the viewport — it
        // does not move with the frame — and a press on its view box is
        // a gesture that changes nothing (a pan by 0).
        const press = await centreOf(panelOf(page, t.b).locator('.region-viewbox'));
        const { watch, pressed, since } = await handMidMove(page, t, async () => {
            await page.mouse.move(press.x, press.y);
            await page.mouse.down();
        });
        await expect.poll(async () => (await since()).length).toBeGreaterThan(3);
        const rows = await watch.stop();
        await page.mouse.up();
        expectMidMove(rows, pressed);
        // Within a frame or two of the press the move is over and the
        // frame is ON the seat — never left part-way under the hand.
        for (const f of rows.filter(f => f.t > pressed + 50)) {
            expect(f.moving, 'no move under a hand').toBe(false);
            expect(f.topB, 'on the seat').toBeCloseTo(0, 2);
            expect(ticksOf(f)).toEqual(GRID);
        }
    });

    test('a pin taken mid-move holds the SEAT, never the passing zero; the chain over, the frame moves on', async ({ page }) => {
        const t = await setup(page);
        const { Q, b } = t;
        // → mid-move: the nudge chain pins the frame AT ONCE (the
        // keyboard's pin, region_nudge.js makeChainPin) and nudges B to
        // [6, 10). The pin must hold the frame the move was landing on —
        // whole-Q lines — for the whole chain, not the off-grid zero it
        // was passing through. In that frame the nudged loop's ↺ —
        // reset to its new start — comes to sit 1Q along.
        const { watch, pressed, since } = await handMidMove(page, t,
            () => page.keyboard.press('ArrowRight'));
        await expect.poll(() => loopOf(page, b, Q)).toBe('6,10');
        let pinned = [];
        await expect.poll(async () => {
            pinned = await since();
            return pinned.length > 8 && Math.abs(pinned.at(-1).topB - 1) < 0.01;
        }).toBe(true);
        for (const f of pinned) {
            expect(f.moving, 'pinned: no move').toBe(false);
            expect(ticksOf(f), 'a grid-true frame').toEqual(GRID);
        }
        // The chain over, the pin lets go and the FRAME moves onto the
        // new ↺ (the one sampler has every frame of it).
        await settled(page);
        const rows = await watch.stop();
        expectMidMove(rows, pressed);
        const moved = rows.filter(f => f.t > pinned.at(-1).t);
        expect(moved.filter(f => f.moving).length, 'frames of the move').toBeGreaterThan(3);
        expect(moved.at(-1).moving).toBe(false);
        await expect.poll(() => marks(page, b)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
    });

    test('prefers-reduced-motion: the frame jumps', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const t = await setup(page);
        await holdSwap(page, t);
        const rows = await through(page, t, () => page.mouse.up(), { moves: false });
        expect(await loopOf(page, t.b, t.Q)).toBe('5,9');
        expect(rows.some(f => f.moving)).toBe(false);
        expect(rows.filter(f => f.topB > 0.05 && f.topB < 0.95).length,
            'no places between').toBe(0);
        expect(rows.at(-1).topB).toBeCloseTo(0, 2);
        await expect.poll(() => marks(page, t.c)).toEqual(['top@0', 'wrap@2']);
    });
});
