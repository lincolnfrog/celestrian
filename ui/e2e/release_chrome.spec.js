/**
 * THE RELEASE LIFECYCLE and THE CHROME AROUND A MAP DRAG (docs/frame.md
 * §1; docs/time_maps.md §7; session_view/map_core.js runMapDrag,
 * gesture.js).
 *
 * A gesture's final commit is in flight when the pointer lets go: its
 * preview is HELD and the frame stays pinned until the engine answers.
 * With an emulated bridge round trip on setSegments this pins, frame by
 * frame:
 *   1. after release the held overlay never shows the PRE-drag chrome
 *      (the panel's box and brackets; the lane's splice handles);
 *   2. during a lane ⇧-length drag, with the pointer over the lane, the
 *      heard handles read computed opacity 0 (the hover reveals lose);
 *   3. the playhead's mask carves out a revealing lane from the frame
 *      it engages to the frame it tears down;
 *   4. the frame settles ONCE, after the final commit;
 *   5. while a take is pending, a splice / ↺ / box press, a double-click
 *      and ← / → do nothing — no preview, no bridge call.
 */

import { test, expect } from '@playwright/test';
import { boot, call, mock, quantum, node, loopOf, segsOf, loopedTake, armPending,
         laneOf, panelOf, stripOf, viewOf, stripX, selectLane, keptBoxAt,
         laneHandles, handleTab, laneFrameQ, centre, dragBy, dragTo, jiggleUntil,
         gripDrag, release, watchFrames, settled, gestureLive, recordMapCalls,
         consoleDrained }
    from './helpers.js';

/* The emulated bridge round trip for setSegments (ms). */
const BRIDGE_MS = 150;

test.describe('Release lifecycle', () => {
    test('panel slide: the held box never shows at the pre-drag place', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { bridgeDelayMs: BRIDGE_MS });
        const panel = panelOf(page, id2);
        // ⇧Z shows the whole 12Q take: on that strip a `left` of n% is
        // raw n·12/100 Q, the geometry the sampler reads positions in.
        await page.keyboard.press('Shift+Z');
        await expect.poll(async () => (await viewOf(page, id2)).spanQ).toBe(12);
        const strip = await stripOf(page, id2).boundingBox();
        const watch = await watchFrames(page, id => {
            const o = document.querySelector(
                `#region-dock .lane-region[data-lane-id="${id}"] .region-overlay`);
            const seen = el => {
                const cs = getComputedStyle(el);
                return cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
            };
            const q = el => parseFloat(el.style.left) / 100 * 12;
            const layer = o.querySelector(':scope > .drag-preview-layer');
            return {
                kept: [...o.querySelectorAll(':scope > .region-kept')]
                    .filter(seen).map(q),
                brackets: [...o.querySelectorAll(':scope > .region-bracket')]
                    .filter(seen).map(q)
                    .concat(layer && seen(layer)
                        ? [...layer.querySelectorAll('.win-bracket')].map(q) : []),
            };
        }, id2);
        // SLIDE the box +2Q (whole-Q steps): [6, 10) → [8, 12).
        const kept = await panel.locator('.region-kept').boundingBox();
        await dragBy(page, { x: centre(kept).x, y: strip.y + strip.height / 2 },
            strip.width * (2.2 / 12), { hold: true });
        await watch.mark('up');
        await release(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,12');
        await keptBoxAt(page, id2, 8, 12);
        await settled(page);
        const after = (await watch.stop()).filter(s => s.up);
        expect(after.length, 'frames sampled after release').toBeGreaterThan(5);
        for (const s of after) {
            for (const k of s.kept) {
                expect(Math.abs(k - 6), `frame ${s.t.toFixed(0)}: a box at the pre-drag 6Q`)
                    .toBeGreaterThan(0.05);
            }
            for (const b of s.brackets) {
                expect(Math.abs(b - 6) > 0.05 && Math.abs(b - 10) > 0.05,
                    `frame ${s.t.toFixed(0)}: a bracket at the pre-drag ${b.toFixed(2)}Q`)
                    .toBe(true);
            }
        }
        // The held frames show the landing (the preview's brackets).
        expect(after.some(s => s.brackets.some(b => Math.abs(b - 8) < 0.05)))
            .toBe(true);
    });

    test('lane ⇧-length at a cut: more material before it shrinks the cut, to nothing heals it; the splices step aside, never show at the pre-drag spot, and the mask follows the reveal', async ({ page }) => {
        // [2, 5) ∪ [7, 10): a 2Q cut, a 6Q loop; its cut's splice sounds
        // 3Q after the region start.
        const { Q, id2 } = await loopedTake(page,
            { segs: [2, 5, 7, 10], bridgeDelayMs: BRIDGE_MS });
        const body = laneOf(page, id2).locator('.lane-body');
        const cuts = async () => (await laneHandles(page, id2))
            .filter(h => h.kind === 'cut' && !h.ghost);
        await expect.poll(async () => (await cuts()).map(h => h.text)).toEqual(['‖ 2Q']);
        const cut0 = (await cuts())[0].exact;
        const watch = await watchFrames(page, id => {
            const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
            const o = body.querySelector(':scope > .overlay-layer');
            const layer = body.querySelector(':scope > .lr-layer');
            const br = body.getBoundingClientRect();
            const cut = layer.querySelector(':scope > .lr-cut:not(.lr-ghost)');
            const r = cut ? cut.getBoundingClientRect() : null;
            // The white playhead's mask: does it carve this body out?
            const ph = document.getElementById('playhead');
            const pr = ph.getBoundingClientRect();
            const top = (br.top - pr.top) / pr.height * 100;
            const bot = (br.bottom - pr.top) / pr.height * 100;
            const bands = [...(ph.style.maskImage || '').matchAll(
                /transparent ([\d.]+)%, transparent ([\d.]+)%/g)]
                .map(m => [+m[1], +m[2]]);
            return {
                live: o.classList.contains('drag-live'),
                revealing: body.classList.contains('revealing'),
                masked: bands.some(([a, b]) => a <= top + 0.5 && b >= bot - 0.5),
                layerOp: parseFloat(getComputedStyle(layer).opacity),
                cutQ: r && cut.style.display !== 'none'
                    ? ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ : null,
                hovered: body.matches(':hover'),
            };
        }, id2);
        // ⇧-drag the cut's splice right by 1.2Q: 1Q more material before
        // it — [2, 6) ∪ [7, 10), the cut's splice now 4Q in. Held for a
        // few frames under the hovering pointer.
        await gripDrag(page, id2, 'cut', 1.2, { mods: ['Shift'], hold: true });
        await expect(body).toHaveClass(/revealing/);
        await expect.poll(async () => (await watch.rows()).filter(s => s.revealing).length)
            .toBeGreaterThan(3);
        await watch.mark('up');
        await release(page, ['Shift']);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('2,6,7,10');
        await expect(body).not.toHaveClass(/revealing/);
        await expect.poll(async () => (await cuts())[0].exact).toBeCloseTo(cut0 + 1, 2);
        await settled(page);
        const samples = await watch.stop();

        // THE HEARD HANDLES STEP ASIDE MID-DRAG, pointer over the lane
        // (the raw take is up — they would sit over the wrong time).
        const dragging = samples.filter(s => s.revealing && !s.up);
        expect(dragging.length, 'frames sampled mid-drag').toBeGreaterThan(3);
        expect(dragging.some(s => s.hovered), 'the pointer is over the lane').toBe(true);
        for (const s of dragging) expect(s.layerOp, 'splices hidden mid-drag').toBe(0);
        // NEVER AT THE PRE-DRAG SPOT after release: the held frames keep
        // them hidden under the reveal; the rebuild shows the new.
        const after = samples.filter(s => s.up);
        const shown = after.filter(s => s.layerOp > 0.05 && s.cutQ !== null);
        expect(after.length).toBeGreaterThan(5);
        expect(shown.length, 'frames with the rebuilt splice').toBeGreaterThan(0);
        for (const s of shown) {
            expect(Math.abs(s.cutQ - cut0), `frame ${s.t.toFixed(0)}: a splice at the pre-drag spot`)
                .toBeGreaterThan(0.5);
        }
        expect(after.some(s => s.live), 'the preview is held past the release').toBe(true);
        // THE MASK FOLLOWS THE REVEAL frame for frame: carved out from
        // the frame the lane reveals to the frame it relaxes.
        for (const s of samples) {
            expect(s.masked, `frame ${s.t.toFixed(0)}: mask ${s.masked} vs revealing ${s.revealing}`)
                .toBe(s.revealing);
        }

        // The cut is 1Q now and the loop 7Q (the handle is where the
        // settled frame draws it) — once more and the cut closes:
        // healed, one window.
        expect((await cuts()).map(h => h.text)).toEqual(['‖ 1Q']);
        expect(await laneFrameQ(page, id2)).toBe(7);
        await gripDrag(page, id2, 'cut', 1.1, { mods: ['Shift'] });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('2,10');
        await expect.poll(async () => (await cuts()).length).toBe(0);
    });

    test('panel cut resize: the frame settles ONCE, after the final commit', async ({ page }) => {
        // A cut band's drag hands its final commit to the runner, so the
        // pin holds until it settles: a poll carrying the last LIVE cut
        // never re-seats the frame in between (7Q → 6Q → 5Q).
        await page.setViewportSize({ width: 1400, height: 900 });
        const { Q, id2 } = await loopedTake(page,
            { segs: [2, 5, 6, 10], bridgeDelayMs: BRIDGE_MS });
        await page.keyboard.press('Shift+Z');
        await expect.poll(async () => (await viewOf(page, id2)).spanQ).toBe(12);
        await expect.poll(() => laneFrameQ(page, id2)).toBe(7);
        const handle = panelOf(page, id2).locator('.region-overlay .cut-handle.end');
        await expect(handle).toHaveCount(1);
        const at = centre(await handle.boundingBox());
        // A LIVE commit lands a 2Q cut [5, 7) (period 6) mid-drag…
        const x1 = await stripX(page, id2, 7.1);
        await dragTo(page, at, x1, { steps: 5, hold: true });
        await jiggleUntil(page, { x: x1, y: at.y }, () => segsOf(page, id2, Q), '2,5,7,10');
        // …then the final move makes it 3Q [5, 8) (period 5) and releases.
        const watch = await watchFrames(page, id => ({
            frameQ: document.querySelector(`.lane[data-id="${id}"] .lane-body`)._cycleQ,
        }), id2);
        await page.mouse.move(await stripX(page, id2, 8.1), at.y, { steps: 1 });
        await release(page);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('2,5,8,10');
        await expect.poll(() => laneFrameQ(page, id2)).toBe(5);
        await settled(page);
        const frames = (await watch.stop()).map(f => f.frameQ);
        const distinct = frames.filter((c, i) => i === 0 || c !== frames[i - 1]);
        expect(distinct, 'the frame goes straight from 7Q to 5Q').toEqual([7, 5]);
    });
});

test.describe('Recording gate', () => {
    test('while a take is pending, no loop-region gesture does anything', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page);
        const panel = panelOf(page, id2);
        const body = laneOf(page, id2).locator('.lane-body');
        const calls = recordMapCalls(page);
        const id3 = await armPending(page);
        await selectLane(page, id2);   // the track keeps its panel
        const titleAt = (at, sel) => page.evaluate(({ x, y, sel }) => {
            const hit = document.elementFromPoint(x, y).closest(sel);
            return hit ? hit.title : null;
        }, { ...at, sel });

        // A SPLICE PRESS (and a ⇧ one, and the ↺): the handles still
        // draw (inert) and start no gesture. They stay HOVERABLE, so
        // their tooltip explains the gate. (The left-edge splice; its
        // twin at the right edge — .lr-end — is held inert the same way.)
        const grip = body.locator('.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end)');
        const top = body.locator('.lr-layer > .lr-top:not(.lr-ghost)');
        await expect(grip).toHaveCount(1);
        await expect(body.locator('.lr-layer > .lr-wrap.lr-end')).toHaveClass(/lr-inert/);
        await expect(grip).toHaveClass(/lr-inert/);
        await expect(top).toHaveClass(/lr-inert/);
        const g = await handleTab(page, id2, 'wrap');
        expect(await grip.evaluate(el => getComputedStyle(el).cursor)).toBe('default');
        expect(await titleAt(g, '.lr-splice')).toMatch(/wait until the take finishes/i);
        for (const mods of [[], ['Shift']]) {
            await dragBy(page, g, 0, { mods, hold: true, steps: 1 });
            expect(await gestureLive(page), 'an inert handle starts no gesture').toBe(false);
            await page.mouse.move(g.x + 80, g.y, { steps: 6 });
            await expect(body).not.toHaveClass(/revealing/);
            await expect(page.locator('.drag-preview-layer')).toHaveCount(0);
            await expect(body.locator('.lr-badge')).toHaveCount(0);
            await release(page, mods);
        }
        const t = await handleTab(page, id2, 'top');
        expect(await titleAt(t, '.lr-top')).toMatch(/wait until the take finishes/i);
        await dragBy(page, t, 80, { steps: 6, hold: true });
        await expect(body.locator('.lr-badge')).toHaveCount(0);
        await release(page);
        // THE PANEL'S ↺ and the timing reset: drawn, never grabbable.
        await expect(panel.locator('.region-top')).toHaveClass(/inert/);
        expect(await panel.locator('.region-top-tab').evaluate(el =>
            getComputedStyle(el).pointerEvents)).toBe('none');
        await expect(panel.locator('.region-timing-reset')).toBeDisabled();
        // THE PANEL BOX: drawn, not grabbable.
        const kept = await panel.locator('.region-kept').boundingBox();
        expect(await panel.locator('.region-kept').evaluate(k =>
            getComputedStyle(k).cursor)).toBe('default');
        await dragBy(page, centre(kept), 60, { steps: 6, hold: true });
        await expect(page.locator('.drag-preview-layer')).toHaveCount(0);
        await release(page);
        // DOUBLE-CLICK a cell (lane and strip) and → : nothing reaches
        // the bridge.
        const bb = await body.boundingBox();
        await page.mouse.dblclick(bb.x + bb.width * 0.6, bb.y + bb.height / 2);
        await page.mouse.dblclick(await stripX(page, id2, 7.5), centre(kept).y);
        await page.keyboard.press('ArrowRight');
        await consoleDrained(page);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await loopOf(page, id2, Q)).toBe('6,10');

        // The take goes (the arm cancelled): the gate lifts — the same
        // splice and ↺ are live again, and the same → is a nudge.
        await call(page, 'stopRecordingInNode', id3);
        await expect(page.locator('#lanes')).not.toHaveClass(/map-locked/);
        await expect(grip).not.toHaveClass(/lr-inert/);
        await expect(top).not.toHaveClass(/lr-inert/);
        await expect.poll(() => page.evaluate(({ x, y }) =>
            !!document.elementFromPoint(x, y).closest('.lr-splice'), g)).toBe(true);
        expect(await panel.locator('.region-top-tab').evaluate(el =>
            getComputedStyle(el).pointerEvents)).toBe('auto');
        await dragBy(page, g, 0, { hold: true, steps: 1 });
        expect(await gestureLive(page), 'a live handle takes the press').toBe(true);
        await release(page);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        await consoleDrained(page);
        expect(calls).toEqual(['setSegments']);
    });

    test('comp mode\'s "done" chip still closes the comp editor under the gate', async ({ page }) => {
        // The gate holds map edits; "comp · done" is a VIEW toggle.
        await boot(page, { scenario: 'stack-with-clips' });
        const Q = await quantum(page);
        await call(page, 'newTake', 'clip-1');
        await mock(page, 'advanceBy', 2 * Q);
        await expect.poll(async () => (await node(page, 'clip-1')).takes).toBe(2);
        const lane = laneOf(page, 'clip-1');
        const body = lane.locator('.lane-body');
        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-comp-row').click();
        const done = body.locator('.comp-done-chip');
        await expect(done).toBeVisible();
        // Arm a new take elsewhere: pending → the gate is on.
        await call(page, 'newTake', 'clip-2');
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        const at = centre(await done.boundingBox());
        await page.mouse.click(at.x, at.y);
        await expect(body.locator('.comp-cell.editing')).toHaveCount(0);
    });
});
