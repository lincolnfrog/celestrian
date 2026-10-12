/**
 * THE SPLICE AND THE TOP on the lane, and the START MARKER in the panel
 * (docs/loop_selection.md §9; session_view/splice_handles.js,
 * region_panel.js).
 *
 * Two effects, two handles: a SPLICE drag SWAPS what plays (the region
 * moves, the origin is kept — only the swept strip changes, and the ↺
 * stays unless the region drops its spot); the ↺ drag SHIFTS when it
 * plays (the origin moves, the audio and the splices ride along). ⇧ on
 * a splice is the LENGTH there, through the same-scale reveal (its wrap
 * and cut drags: region_panel.spec.js, release_chrome.spec.js). The
 * panel's ↺ is the start marker: the top moves onto another hit and the
 * audio shifts so the ↺ keeps its moment. A PLAIN loop (no map) wears
 * the ↺ alone — nothing to swap, but its timing to shift — and the
 * panel's marker walks its whole take. Every drag grabs a handle by its
 * tab, the way a hand does.
 */

import { test, expect } from '@playwright/test';
import { call, node, root, loopOf, segsOf, recordTake, setLoop, loopedTake,
         slottedTopology, laneOf, panelOf, stripPxPerQ, panelTopQ, selectLane,
         keptBoxAt, laneHandles, laneMarks, handleTab, lanePxPerQ, centreOf, dragBy,
         gripDrag, release, undo, redo, sampleFrames, settled, pastVerdict,
         projectAnnounced, tileProfile, tileAtRest, changedCols }
    from './helpers.js';

const near = (a, b, tol = 0.03) => Math.abs(a - b) < tol;
const of = (hs, kind) => hs.filter(h => h.kind === kind);

/** The owner's topology: a 1Q definer, a 12Q take from 1Q looped to
 * [6Q, 10Q) — a 4Q loop filling a 4Q frame — and that lane selected. It
 * is the first loop longer than Q, so it PLACES THE FRAME (docs/frame.md
 * §1): the frame's left edge is its ↺. A drag pins the frame while the
 * hand is down; released, an edit that moved the ↺'s moment re-seats
 * the frame. (A loop that slots into the frame: slotted_loop.spec.js.) */
async function setup(page) {
    const t = await loopedTake(page);
    await expect.poll(async () => of(await laneHandles(page, t.id2), 'top').length).toBe(1);
    return t;
}

test.describe('The splice (swap)', () => {
    test('a splice drag swaps only what it sweeps; the ↺ stays while the region still plays it, and resets when it is dropped', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const lane = laneOf(page, id2);
        const top = async () => (await node(page, id2)).loopTop / Q;
        /** The take tile's splice and ↺ (lane Q). */
        const marks = async () => {
            const hs = (await laneHandles(page, id2)).filter(h => !h.ghost);
            return [of(hs, 'wrap')[0].x, of(hs, 'top')[0].x];
        };
        expect(await marks()).toEqual([0, 0]);

        // A SWAP TO THE LEFT, −1.2Q of hand (whole Q → −1Q): [5, 9)
        // still plays raw 6, so the ↺ holds — the preview predicts the
        // top the engine will store — and only the splice moves, under
        // the hand. THE RECONCILE STORES THE TOP: left unset it would
        // ride the region start.
        await gripDrag(page, id2, 'wrap', -1.2, { hold: true });
        await expect(lane.locator('.lr-badge')).toHaveText(/swap · splice −1Q/);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');   // a live commit
        await expect.poll(async () => (await marks())[0]).toBeLessThan(-1);
        expect((await marks())[1]).toBe(0);
        await release(page);
        // The ↺ and the splice have come apart: the frame is seated on
        // the ↺, the splice 1Q before it (−1 ≡ 3 of the 4Q frame).
        await expect.poll(marks).toEqual([3, 0]);
        expect(await loopOf(page, id2, Q)).toBe('5,9');
        expect(await top()).toBe(6);

        // A SWAP TO THE RIGHT, +1.3Q (→ +1Q): held, the lane already
        // shows the swap (the local preview), the badge names it, and
        // the swept strip is tinted. (A press while the last release
        // still settles is swallowed: each grab waits for rest.)
        await settled(page);
        const before = await tileAtRest(page, id2);
        await gripDrag(page, id2, 'wrap', 1.3, { hold: true });
        await expect(lane.locator('.lr-badge')).toHaveText(/swap · splice \+1Q/);
        await expect(lane.locator('.lr-tint')).toHaveCount(1);
        await expect(lane.locator('.lr-snap')).toHaveCount(1);
        await expect.poll(async () => changedCols(before, await tileProfile(page, id2)).length)
            .toBeGreaterThan(0);
        const mid = await tileProfile(page, id2);
        await release(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await expect(lane.locator('.lr-badge')).toHaveCount(0);
        await expect(lane.locator('.lr-tint')).toHaveCount(0);
        // What the hand saw is what landed. (Only the swept strip
        // changes: heard_tiles.spec.js measures it.)
        const after = await tileAtRest(page, id2);
        expect(changedCols(mid, after)).toEqual([]);
        expect(changedCols(before, after).length).toBeGreaterThan(0);
        // The swap kept the origin and the top: the splice moved onto
        // the ↺ (the left edge), the ↺ did not move — and neither did
        // the frame, whose zero is the ↺'s moment.
        const n = await node(page, id2);
        expect(n.loopTop / Q).toBe(6);
        expect(n.retime).toBe(0);
        expect(n.origin / Q).toBe(1);
        await expect.poll(marks).toEqual([0, 0]);

        // ANOTHER +1Q: [7, 11) no longer plays raw 6 — the top resets
        // to the region start, back on the splice. Under the hand the
        // frame is pinned, so the preview shows the ↺ where the engine
        // will store it: 1Q in, beside the splice's landing …
        await settled(page);
        await gripDrag(page, id2, 'wrap', 1.2, { hold: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');   // a live commit
        await expect.poll(async () => (await marks())[1]).toBe(1);
        await release(page);
        // … and released, the frame seats on the new ↺: both at the
        // left edge, to stay.
        await expect.poll(marks).toEqual([0, 0]);
        await settled(page);
        expect(await marks()).toEqual([0, 0]);
        expect(await top()).toBe(7);
        // One undo step per drag.
        await undo(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        expect(await top()).toBe(6);

        // THE SAME RECONCILE BY NUDGE: [7, 11) drops raw 6 and [8, 12)
        // raw 7 — the ↺ resets onto the region start each time — then
        // one back to [7, 11): raw 8 still plays, so the ↺ STAYS on it
        // and only the splice moves. (A nudge slides the region the
        // panel shows: wait for it to show the undone one.)
        await keptBoxAt(page, id2, 6, 10);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect(await top()).toBe(7);
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,12');
        expect(await top()).toBe(8);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect(await top()).toBe(8);
        // The nudge chain is one pinned gesture; once it lets the frame
        // go, the frame seats on the ↺ — raw 8 at the left edge — and
        // the splice (raw 7) reads 1Q before it: 3Q.
        await expect.poll(marks).toEqual([3, 0]);
    });

    test('Escape mid-drag puts back the swap or the shift, leaves no undo step, and the redo it interrupted still works', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const lane = laneOf(page, id2);
        const log = page.locator('#log-line');
        const canRedo = async () => (await root(page)).canRedo;
        const origin = async () => (await node(page, id2)).origin / Q;
        await projectAnnounced(page);
        // A redo branch to interrupt: a swap, undone.
        await gripDrag(page, id2, 'wrap', -1.2);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        await settled(page);
        await undo(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        expect(await canRedo()).toBe(true);
        // (The lane has re-drawn the undone loop before the next grab.)
        await expect.poll(async () => of(await laneHandles(page, id2), 'wrap')[0].x).toBe(0);
        const before = await tileAtRest(page, id2);

        // A SWAP held until its live commits land (redo is invalidated
        // — for now) — and Escape: the region is back, the lane's
        // picture with it, and the status line says so, to stay.
        await gripDrag(page, id2, 'wrap', 1.3, { hold: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect(await canRedo()).toBe(false);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await expect(log).toHaveText('Cancelled — nothing changed');
        await expect(lane.locator('.lr-badge')).toHaveCount(0);
        await expect.poll(async () => changedCols(before, await tileProfile(page, id2)).length)
            .toBe(0);
        await pastVerdict(page);
        await expect(log).toHaveText('Cancelled — nothing changed');
        expect(await canRedo()).toBe(true);

        // The same for a SHIFT: the origin goes back.
        await settled(page);
        await gripDrag(page, id2, 'top', 1.3, { hold: true });
        await expect.poll(origin).toBe(2);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(origin).toBe(1);
        expect((await node(page, id2)).retime).toBe(0);
        await expect.poll(async () => near(of(await laneHandles(page, id2), 'top')[0].x, 0))
            .toBe(true);
        expect(await canRedo()).toBe(true);

        // REDO is the swap that was undone …
        await redo(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        // … and ⌘Z twice is that swap, then the loop itself: no step
        // in between is a cancelled drag's.
        await undo(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await undo(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,0');
    });

    test('a cut\'s splice slides the cut (⌥ free) and heals on double-click', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const cuts = async () => of(await laneHandles(page, id2), 'cut');
        // A 1Q cut at [5, 6), the ↺ on the region start (raw 2): the 7Q
        // loop shows from its top, the cut's splice 3Q in. (Left on raw
        // 6 — where setup's region began — the ↺ would sit ON the cut's
        // splice, at the frame's edge, and the slide below would drop it
        // and re-seat the frame.)
        await call(page, 'setSegments', id2, [2, 5, 6, 10].map(q => q * Q));
        await call(page, 'setTiming', id2, 0, 2 * Q);
        await expect.poll(async () => (await cuts()).map(h => h.x)).toEqual([3]);
        const cut = (await cuts())[0];
        expect(cut.text).toBe('‖ 1Q');
        // ⌥: free — the cut slides 0.4Q, its length held; the region
        // still plays the ↺, so the frame holds and the splice rests
        // where the hand left it.
        await gripDrag(page, id2, 'cut', 0.4, { mods: ['Alt'] });
        await expect.poll(async () => (await segsOf(page, id2, Q)).split(',')
            .map(v => (+v).toFixed(1)).join(',')).toBe('2.0,5.4,6.4,10.0');
        const rests = async () => near((await cuts())[0].exact, cut.exact + 0.4, 0.05);
        await expect.poll(rests).toBe(true);
        await settled(page);
        expect(await rests()).toBe(true);
        // Double-click the cut's splice: healed — back to one window.
        const at = await handleTab(page, id2, 'cut');
        await page.mouse.dblclick(at.x, at.y);
        await expect.poll(async () => ((await node(page, id2)).segments || []).length)
            .toBeLessThan(4);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('2,10');
        await expect.poll(async () => (await cuts()).length).toBe(0);
    });
});

/* THE ↺, one journey per topology: the lane's ↺ dragged +1Q RE-TIMES the
 * take (the origin moves; the region and the stored top do not), "Timing
 * as played" puts it back, and the panel's ↺ dragged onto the next Q
 * moves the TOP and shifts the take the other way, so the ↺ keeps its
 * moment. The rows differ in where the handles rest and in the legs
 * only that topology has. */
const TOPOLOGIES = [{
    name: 'the loop that places the frame',
    setup: async page => {
        const t = await setup(page);
        return { Q: t.Q, id: t.id2, still: [] };
    },
    // The 4Q loop fills its frame: the ↺ and the splice at the left
    // edge, the splice's twin at the right. Released, the frame seats on
    // the ↺ again — the shift shows against the OTHER lanes.
    rest: { originQ: 1, marks: ['top@0', 'wrap@0', 'wrap@4'], panelTop: 6 },
    lifted: { marks: ['top@0', 'wrap@0', 'wrap@4'], panelTop: 6 },
    // The ↺ held its place; the splice moved with the audio, a whole Q
    // earlier (0 → −1 ≡ 3 of the 4Q frame).
    marked: ['top@0', 'wrap@3'],
    atRest: async (page, t) => { t.tile = await tileAtRest(page, t.id); },
    held: async (page, { id, tile }) => {
        // The waveform has already moved with the hand, and under it
        // (the frame pinned) the splice with the audio: 1Q in.
        await expect.poll(async () => changedCols(tile, await tileProfile(page, id)).length)
            .toBeGreaterThan(tile.length / 4);
        await expect.poll(async () => of(await laneHandles(page, id), 'wrap')[0].x).toBe(1);
    },
    afterLift: async (page, { Q, id }) => {
        // ⌥ = FINE: a few px left pulls the take early by that much.
        const dx = -12;
        const pxq = await lanePxPerQ(page, id);
        await dragBy(page, await handleTab(page, id, 'top'), dx, { mods: ['Alt'], steps: 6 });
        await expect.poll(async () => (await node(page, id)).retime / Q).toBeLessThan(1);
        const retimeQ = (await node(page, id)).retime / Q;
        const fine = retimeQ - 1;
        expect(Math.abs(fine - dx / pxq)).toBeLessThan(0.01);
        expect(Number.isInteger(retimeQ)).toBe(false);
        await expect(panelOf(page, id).locator('.region-timing-read'))
            .toHaveText(/^timing: shifted \+0\.9\d+Q \(\d+ ms later\)$/);
        // A top a little EARLY of its bar line is a pickup (docs/frame.md
        // §1): the frame stays on that line and the ↺ reads just before
        // the frame's end.
        await expect.poll(async () =>
            near(of(await laneHandles(page, id), 'top')[0].exact, 4 + fine, 0.01)).toBe(true);
    },
    landed: async (page, { id }) => {
        // The ↺'s line never steals a box slide: a press on the line
        // below the tab grabs the kept box.
        const panel = panelOf(page, id);
        await expect(panel.locator('.region-overlay')).not.toHaveClass(/drag-held/);
        const line = await panel.locator('.region-top').boundingBox();
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).className,
            { x: line.x + line.width / 2, y: line.y + line.height * 0.75 }))
            .toMatch(/region-kept/);
    },
}, {
    name: 'a plain loop (no map: the whole take loops)',
    setup: async page => {
        const t = await loopedTake(page, { lenQ: 4, loop: null });
        await expect.poll(async () => of(await laneHandles(page, t.id2), 'top').length).toBe(1);
        return { Q: t.Q, id: t.id2, still: [] };
    },
    // The 4Q frame's zero seats on the take's top: the ↺ alone at the
    // left edge, before and after — there is nothing to swap.
    rest: { originQ: 1, marks: ['top@0'], panelTop: 0 },
    lifted: { marks: ['top@0'], panelTop: 0 },
    marked: ['top@0'],
    atRest: async (page, { id }) => {
        const body = laneOf(page, id).locator('.lane-body');
        expect((await node(page, id)).windowActive).toBe(false);
        expect((await laneHandles(page, id)).map(h => [h.kind, h.ghost, h.inert, h.text]))
            .toEqual([['top', false, false, '↺ top']]);
        await expect(body.locator('.lr-splice')).toHaveCount(0);
        await expect(panelOf(page, id).locator('.region-label'))
            .toHaveText(/whole take · 4Q take/);
        // Only its TAB grabs: its line sits on the latent start bracket
        // (drag an edge in to make a region), which keeps its press —
        // in the lane's upper half too, just under the tab.
        const bb = await body.boundingBox();
        expect(await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return [!!hit.closest('.lr-top'), !!hit.closest('.win-bracket.start')];
        }, { x: bb.x + 3, y: bb.y + bb.height * 0.45 })).toEqual([false, true]);
    },
    landed: async (page, { id }) => {
        // Raw 0 now sounds 1Q before the left edge, so the take tile is
        // the clipped [3, 4) and the ↺ sits in the take's pass wrapped
        // to the frame's start — with its tab, never a tabless ghost.
        expect(of(await laneHandles(page, id), 'top').map(h => [h.x, h.ghost, h.tabOp]))
            .toEqual([[0, false, 1]]);
        await expect(laneOf(page, id).locator('.lr-splice')).toHaveCount(0);
    },
}, {
    name: 'a loop that slots into the frame',
    setup: async page => {
        const { Q, b, c } = await slottedTopology(page);
        await selectLane(page, c);
        return { Q, id: c, still: [b] };
    },
    // Its ↺ is WHERE IT STARTS PLAYING: at the frame's left edge on the
    // lane, and in the panel on the sample that plays there (raw 7) —
    // not on the engine's own top, the region start (raw 6). Shifted
    // +1Q, the splice goes with the audio (3Q → 4Q ≡ the frame's edge:
    // both ends) and raw 6 is the sample at the edge.
    rest: { originQ: 14, marks: ['top@0', 'wrap@3'], panelTop: 7 },
    lifted: { marks: ['top@0', 'wrap@0', 'wrap@4'], panelTop: 6 },
    marked: ['top@0', 'wrap@2'],
    // A cancelled marker drag puts back the engine's OWN top (raw 6),
    // not the ↺ as shown (raw 7).
    cancelFirst: true,
}];

test.describe('The ↺: the top on the lane (shift), the start marker in the panel', () => {
    for (const row of TOPOLOGIES) {
        test(row.name + ': the lane ↺ re-times it, "Timing as played" puts it back, the panel\'s ↺ moves the top', async ({ page }) => {
            const t = await row.setup(page);
            const { Q, id } = t;
            const lane = laneOf(page, id);
            const panel = panelOf(page, id);
            const read = panel.locator('.region-timing-read');
            const reset = panel.locator('.region-timing-reset');
            const n0 = await node(page, id);
            const loop0 = await loopOf(page, id, Q);
            const originQ = async () => (await node(page, id)).origin / Q;
            expect(await originQ()).toBe(row.rest.originQ);
            const stillMarks = [];
            for (const other of t.still) stillMarks.push(await laneMarks(page, other));
            const othersStill = async () => {
                for (const [i, other] of t.still.entries()) {
                    expect(await laneMarks(page, other)).toEqual(stillMarks[i]);
                }
            };
            await expect.poll(() => laneMarks(page, id)).toEqual(row.rest.marks);
            await expect.poll(() => panelTopQ(page, id)).toBe(row.rest.panelTop);
            await expect(read).toHaveText('timing: as played');
            await expect(reset).toBeDisabled();
            if (row.atRest) await row.atRest(page, t);

            // THE LANE ↺, +1.3Q of hand → +1Q: held, the badge names the
            // shift.
            await gripDrag(page, id, 'top', 1.3, { hold: true });
            await expect(lane.locator('.lr-badge'))
                .toHaveText('shift +1Q · timing: shifted +1Q');
            if (row.held) await row.held(page, t);
            await release(page);
            await expect.poll(originQ).toBe(n0.origin / Q + 1);
            const n1 = await node(page, id);
            expect(n1.retime / Q).toBe(1);
            // A shift, never a swap: the region, whether there is one,
            // and the stored top are as they were.
            expect(await loopOf(page, id, Q)).toBe(loop0);
            expect(n1.windowActive).toBe(n0.windowActive);
            expect(n1.loopTop).toBe(n0.loopTop);
            await expect(read).toHaveText('timing: shifted +1Q');
            await expect(reset).toBeEnabled();
            // The ↺ rests at the left edge again, to stay; no other
            // lane moved.
            await expect.poll(() => laneMarks(page, id)).toEqual(row.lifted.marks);
            await expect.poll(() => panelTopQ(page, id)).toBe(row.lifted.panelTop);
            await settled(page);
            expect(await laneMarks(page, id)).toEqual(row.lifted.marks);
            await othersStill();
            if (row.afterLift) await row.afterLift(page, t);

            // "TIMING AS PLAYED": the origin goes back, the ↺ with it.
            await reset.click();
            await expect.poll(originQ).toBe(n0.origin / Q);
            expect((await node(page, id)).retime).toBe(0);
            await expect(read).toHaveText('timing: as played');
            await expect(reset).toBeDisabled();
            await expect.poll(() => laneMarks(page, id)).toEqual(row.rest.marks);
            await expect.poll(() => panelTopQ(page, id)).toBe(row.rest.panelTop);

            // THE PANEL'S ↺, onto the next Q (+1.3Q of hand → +1Q): the
            // ↺ keeps its moment, so the take moves 1Q EARLIER under it.
            const tab = panel.locator('.region-top-tab');
            const landsOn = row.rest.panelTop + 1;
            const badge = '↺ on ' + landsOn + 'Q · shift −1Q';
            await expect(tab).toBeVisible();
            await expect(panel.locator('.region-ov-top')).toBeVisible();  // ticked on the overview
            await settled(page);
            const dx = 1.3 * await stripPxPerQ(page, id);
            if (row.cancelFirst) {
                await dragBy(page, await centreOf(tab), dx, { hold: true });
                await expect(panel.locator('.region-badge')).toHaveText(badge);
                await expect.poll(originQ).toBe(n0.origin / Q - 1);   // a live commit
                await page.keyboard.press('Escape');
                await page.mouse.up();
                await expect.poll(originQ).toBe(n0.origin / Q);
                const back = await node(page, id);
                expect(back.retime).toBe(0);
                expect(back.loopTop).toBe(n0.loopTop);
                await expect.poll(() => panelTopQ(page, id)).toBe(row.rest.panelTop);
                await expect(panel.locator('.region-overlay')).not.toHaveClass(/drag-held/);
            }
            await dragBy(page, await centreOf(tab), dx, { hold: true });
            await expect(panel.locator('.region-badge')).toHaveText(badge);
            await release(page);
            await expect.poll(async () => (await node(page, id)).loopTop / Q).toBe(landsOn);
            const n2 = await node(page, id);
            expect(n2.retime / Q).toBe(-1);
            expect(n2.origin / Q).toBe(n0.origin / Q - 1);
            expect(await loopOf(page, id, Q)).toBe(loop0);
            expect(n2.windowActive).toBe(n0.windowActive);
            await expect(read).toHaveText('timing: shifted −1Q');
            // On the lane the ↺ held its place; in the panel the mark
            // sits on the new top.
            await expect.poll(() => laneMarks(page, id)).toEqual(row.marked);
            await expect.poll(() => panelTopQ(page, id)).toBe(landsOn);
            if (row.landed) await row.landed(page, t);
        });
    }
});

test.describe('⇧ on a splice (length)', () => {
    test('the loop\'s END handle — the splice at the frame\'s right edge — shortens by dragging inward, and never runs away', async ({ page }) => {
        // A wrap resting on the frame's left edge shows at the right
        // edge too. ⇧ moves the end of the material BEFORE a splice, so
        // a shorter loop is an INWARD drag of the right-edge handle —
        // inside the lane, clear of the reveal's edge pan.
        const { Q, id2 } = await setup(page);
        const body = laneOf(page, id2).locator('.lane-body');
        const wraps = async () => of(await laneHandles(page, id2), 'wrap');
        // This loop fills the frame: both ends are the take's, tabbed.
        expect((await wraps()).map(h => [h.x, h.ghost])).toEqual([[0, false], [4, false]]);
        await expect(body.locator('.lr-layer > .lr-wrap.lr-end')).toHaveCount(1);
        const at = await handleTab(page, id2, 'wrap', { end: true });
        const bb = await body.boundingBox();
        expect(at.x).toBeGreaterThan(bb.x + bb.width - 60);   // at the right edge …
        expect(at.x).toBeLessThan(bb.x + bb.width);           // … inside the lane
        // It takes the press itself (real hit-testing).
        expect(await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y).closest('.lr-splice');
            return !!hit && hit.classList.contains('lr-end');
        }, at)).toBe(true);
        // ⇧-drag it 1.2Q LEFT — inward: the take unrolls with the loop's
        // end under the hand, the kept material in view to its left, and
        // the length lands on 3Q …
        await gripDrag(page, id2, 'wrap', -1.2, { end: true, mods: ['Shift'], hold: true });
        await expect(body).toHaveClass(/revealing/);
        const chip = body.locator('.drag-preview-layer .cut-chip');
        await expect(chip).toHaveText(/loop 3Q \(−1\)/);
        // … and STAYS there under a still hand: the pan is paced by the
        // frame, so thirty of them show it.
        const held = await sampleFrames(page, id => {
            const b = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
            const c = b.querySelector('.drag-preview-layer .cut-chip');
            return { q0: b._reveal.view.q0, chip: c ? c.textContent : '' };
        }, id2, { frames: 30 });
        for (const f of held) {
            expect(f.q0).toBe(held[0].q0);
            expect(f.chip).toMatch(/loop 3Q \(−1\)/);
        }
        await release(page, ['Shift']);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,9');
        await expect(body).not.toHaveClass(/revealing/);
        // The 3Q loop fills its 3Q frame: a handle at each end again.
        await expect.poll(async () => (await wraps()).map(h => h.x)).toEqual([0, 3]);
        // A PLAIN drag of the end handle is the same swap as any splice's:
        // 1Q inward — [5, 8) still plays the ↺ (raw 6), so the frame holds
        // and the splice rests 1Q before the frame's end.
        await settled(page);
        await gripDrag(page, id2, 'wrap', -1.2, { end: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,8');
        expect((await node(page, id2)).loopTop / Q).toBe(6);
        await expect.poll(async () => {
            const hs = await laneHandles(page, id2);
            return [of(hs, 'wrap').map(h => h.x), of(hs, 'top')[0].x];
        }).toEqual([[2], 0]);
    });
});

test.describe('Ghosts and what remains', () => {
    test('on a short loop only the take tile\'s handles wear tabs; ghosts are quiet, and still grab; [ / ] walk the take tile\'s handles', async ({ page }) => {
        // A 4Q partner makes the frame 4Q; the 12Q take loops 2Q in it.
        const { Q, id2 } = await loopedTake(page, { loop: null, select: false });
        await recordTake(page, Q, 4);
        await setLoop(page, id2, 6 * Q, 8 * Q);
        await selectLane(page, id2);
        await expect.poll(async () => (await laneHandles(page, id2)).length).toBe(5);
        const hs = await laneHandles(page, id2);
        // Two repeats of the 2Q loop: one splice and one ↺ each; the take
        // tile's wear their tabs, the ghost repeat's are faint lines —
        // and so is the splice at the frame's right edge (the wrap rests
        // on the left edge, so it shows at both: there it ends the ghost
        // repeat).
        expect(of(hs, 'wrap').map(h => [h.x, h.ghost]))
            .toEqual([[0, false], [2, true], [4, true]]);
        expect(of(hs, 'top').map(h => h.ghost)).toEqual([false, true]);
        for (const h of hs) expect(h.tabOp).toBe(h.ghost ? 0 : 1);
        // Hover a ghost: its tab shows.
        const ghost = laneOf(page, id2).locator('.lr-layer > .lr-wrap.lr-ghost:not(.lr-end)');
        const gb = await ghost.boundingBox();
        const grab = { x: gb.x + gb.width / 2, y: gb.y + gb.height * 0.7 };
        await page.mouse.move(grab.x, grab.y);
        await expect.poll(() => ghost.locator('.lr-tab').evaluate(t =>
            parseFloat(getComputedStyle(t).opacity))).toBe(1);
        // …and it grabs: a ghost repeat's splice swaps like the take's.
        await dragBy(page, grab, 1.2 * await lanePxPerQ(page, id2));
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,9');
        await settled(page);

        // THE HANDLE WALK (teleport.js): zoomed in and scrolled to the
        // far right, [ walks the view left through the take tile's
        // handles — never a ghost's — and stops at the last one; } jumps
        // to the outermost.
        for (let i = 0; i < 6; i++) await page.click('#zoom-in-btn');
        await page.evaluate(() => {
            window.__landed = [];
            new MutationObserver(ms => ms.forEach(m => {
                const t = m.target;
                if (t.classList && t.classList.contains('teleport-flash')) {
                    window.__landed.push(t.classList.contains('lr-ghost'));
                }
            })).observe(document.body, { subtree: true, attributes: true,
                                         attributeFilter: ['class'] });
            const session = document.getElementById('session');
            session.scrollLeft = session.scrollWidth;
        });
        const scrollLeft = () => page.evaluate(() =>
            document.getElementById('session').scrollLeft);
        const scrolls = [await scrollLeft()];
        for (let i = 0; i < 6; i++) {
            await page.keyboard.press('[');
            scrolls.push(await scrollLeft());
        }
        await page.keyboard.press('}');
        const landed = await page.evaluate(() => window.__landed);
        expect(landed.length).toBeGreaterThan(0);
        expect(landed).not.toContain(true);
        expect(new Set(scrolls).size).toBeGreaterThan(1);
        expect(scrolls.at(-1)).toBe(scrolls.at(-2));
    });

    test('an off-grid loop shows its ↺ and splice — no grips, no brackets — and the ↺ keeps clear of the heard chip', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        const chip = lane.locator('.win-heard-chip');
        // [6.4, 9.4): the loop's top rests 0.4Q into the held frame.
        await call(page, 'setSegments', id2, [Math.round(6.4 * Q), Math.round(9.4 * Q)]);
        await expect(chip).toHaveText(/3Q/);
        // A looping lane's edit chrome is the ↺ and the splice: a
        // one-shot's grips and seams and a raw lane's brackets are not
        // drawn.
        await expect(body.locator('.trim-grip')).toHaveCount(0);
        await expect(body.locator('.win-bracket')).toHaveCount(0);
        await expect(body.locator('.seam-handle')).toHaveCount(0);
        await expect.poll(async () => (await laneHandles(page, id2))
            .filter(h => !h.ghost).map(h => h.kind + '@' + h.exact.toFixed(1)).sort())
            .toEqual(['top@0.4', 'wrap@0.4']);
        // The ↺ keeps clear of the heard chip in the top-right, even
        // re-timed under it (−0.5Q: the ↺ at 2.9Q of the 3Q frame).
        await call(page, 'setTiming', id2, Math.round(-0.5 * Q));
        await expect.poll(async () => of(await laneHandles(page, id2), 'top')[0].exact.toFixed(1))
            .toBe('2.9');
        const cb = await chip.boundingBox();
        const tb = await body.locator('.lr-top:not(.lr-ghost) .lr-tab').boundingBox();
        const overlap = tb.x < cb.x + cb.width && tb.x + tb.width > cb.x &&
            tb.y < cb.y + cb.height && tb.y + tb.height > cb.y;
        expect(overlap, JSON.stringify({ tb, cb })).toBe(false);
        expect(tb.x + tb.width).toBeGreaterThan(cb.x);   // it is under the chip's span
        // …and the chip keeps its click (the bypass toggle) over the ↺'s
        // line; the ↺ still grabs by its tab.
        const line = await body.locator('.lr-top:not(.lr-ghost)').boundingBox();
        const lx = line.x + line.width / 2;
        expect(lx).toBeGreaterThan(cb.x);
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).className,
            { x: lx, y: cb.y + cb.height / 2 })).toMatch(/win-heard-chip/);
        expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y).closest('.lr-top'),
            { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 })).toBe(true);
    });
});
