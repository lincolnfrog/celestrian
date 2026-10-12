/**
 * A LOOP THAT SLOTS INTO THE FRAME (docs/frame.md §1). ONE loop places
 * the frame, the first longer than Q; every other loop slots in where
 * it falls, and its ↺ is WHERE IT STARTS PLAYING — the sample it plays
 * at the frame's left edge. So on the lane its ↺ rests at the left edge
 * always; in the panel it marks that sample of the take; a region swap
 * leaves it on the same sample, and nothing it does moves the frame or
 * the other lanes. (Its ↺ drags: the ↺ journeys of
 * splice_handles.spec.js, which also drives the loop that PLACES the
 * frame.)
 *
 * Also here: an unselected track's loop section (docs/loop_selection.md
 * §15), and the brackets of a raw-framed lane whose take tile wraps the
 * frame.
 */

import { test, expect } from '@playwright/test';
import { call, mock, node, loopOf, segsOf, laneOf, panelOf, panelTopQ, selectLane,
         laneHandles, laneMarks as marks, lanePxPerQ, laneFrameQ, centreOf,
         dragBy, gripDrag, release, undo, watchFrames, settled, pastVerdict,
         projectAnnounced, recordMapCalls, consoleDrained, slottedTopology }
    from './helpers.js';

/** Is any gesture preview still awaiting the engine's answer
 * (session_view/pending_edits.js)? */
const previewPending = page => page.evaluate(async () =>
    (await import('/js/session_view/pending_edits.js')).hasPendingEdits());

/* "At once": well inside the 1.5 s a preview is held when no poll
 * answers it (gesture.js COMMIT_HOLD_MAX_MS). */
const AT_ONCE_MS = 1000;

/** The clip-3 topology (helpers.js slottedTopology): a 1Q loop (A); B, a
 * 12Q take looped to [4, 8), the first loop longer than Q — it places
 * the frame; and C, a 16Q take from 14Q looped to [6, 10), which slots
 * in: its region start sounds 3Q into the 4Q frame, and the sample at
 * the frame's top is raw 7. C is selected. */
async function setup(page) {
    const t = await slottedTopology(page);
    await selectLane(page, t.c);
    await expect.poll(() => marks(page, t.c)).toEqual(['top@0', 'wrap@3']);
    return t;
}

test.describe('A loop that slots into the frame', () => {
    test('its ↺ is where it starts; a swap keeps it there and moves nothing else; an undo shows at once, even before the engine has answered', async ({ page }) => {
        const { Q, b, c } = await setup(page);
        const log = page.locator('#log-line');
        await projectAnnounced(page);
        // The ↺ at the frame's left edge on the lane; in the panel, on
        // the sample that plays there (raw 7) — not on the engine's own
        // top, the region start it has stored (raw 6).
        await expect.poll(() => panelTopQ(page, c)).toBe(7);
        expect((await node(page, c)).loopTop / Q).toBe(6);
        const bBefore = await marks(page, b);
        expect(bBefore).toEqual(['top@0', 'wrap@0', 'wrap@4']);

        // DRAG ITS SPLICE −1Q (whole-Q relative): [5, 9). Held, the lane
        // shows the swap; the ↺ does not move.
        await gripDrag(page, c, 'wrap', -1.2, { hold: true });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveText(/swap · splice −1Q/);
        await expect.poll(async () => (await laneHandles(page, c))
            .filter(h => h.kind === 'top' && !h.ghost).map(h => h.x)).toEqual([0]);
        await release(page);
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');
        // The same sample starts it (a swap never moves audio), the
        // engine's top is the one it had (the region still plays raw 6),
        // and nothing else moved.
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
        await expect.poll(() => panelTopQ(page, c)).toBe(7);
        const n = await node(page, c);
        expect(n.loopTop / Q).toBe(6);
        expect(n.origin / Q).toBe(14);
        expect(n.retime).toBe(0);
        expect(await marks(page, b)).toEqual(bBefore);

        // THE PREVIEW IS ANSWERED by the next poll (it shows the top the
        // ENGINE will store, not the ↺ as shown) — it does not sit on
        // the lane for the hold cap — so an undo shows at once.
        await expect.poll(() => previewPending(page), { timeout: AT_ONCE_MS }).toBe(false);
        await undo(page);
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,10');
        await expect.poll(() => marks(page, c), { timeout: AT_ONCE_MS })
            .toEqual(['top@0', 'wrap@3']);
        await expect(log).toHaveText('Undo');

        // AN UNDO BEFORE THE ENGINE HAS ANSWERED: the preview is kept
        // until a poll MATCHES it, and after an undo none will — the
        // keystroke drops it, and the edit's queued verdict with it
        // (which would call the undone edit "refused").
        await gripDrag(page, c, 'wrap', -1.2, { hold: true });
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');   // a live commit
        await page.mouse.up();
        await undo(page);                                          // no pause at all
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,10');
        await expect.poll(() => marks(page, c), { timeout: AT_ONCE_MS })
            .toEqual(['top@0', 'wrap@3']);
        await pastVerdict(page);
        await expect(log).toHaveText('Undo');
    });

    test('a whole-Q drag of a cut never leaves a sliver: no room, no move', async ({ page }) => {
        const { Q, c } = await setup(page);
        // [6, 8) ∪ [9, 10): a 1Q cut whose neighbour after it is 1Q long.
        await call(page, 'setSegments', c, [6, 8, 9, 10].map(q => q * Q));
        await expect.poll(async () => (await laneHandles(page, c))
            .filter(h => h.kind === 'cut' && !h.ghost).length).toBe(1);
        // The frame settles on the 3Q loop (12Q with B's 4Q).
        await expect.poll(() => laneFrameQ(page, c)).toBe(12);
        // +1.2Q of hand toward it: a whole Q would swallow the 1Q
        // segment, so nothing moves — no sliver is left playing at the
        // splice.
        await gripDrag(page, c, 'cut', 1.2, { hold: true });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveText(/swap · move cut \+0Q/);
        await release(page);
        await settled(page);
        expect(await segsOf(page, c, Q)).toBe('6,8,9,10');
        // −1.2Q: a whole Q the other way has room — [6, 7) ∪ [8, 10).
        await gripDrag(page, c, 'cut', -1.2);
        await expect.poll(() => segsOf(page, c, Q)).toBe('6,7,8,10');
    });

    test('a new take of the 1Q loop above the placing loop never moves the frame', async ({ page }) => {
        const { Q, a, b, c } = await setup(page);
        const bBefore = await marks(page, b);
        const cBefore = await marks(page, c);
        const readoutQ = async () => +/^([\d.]+)Q/.exec(
            await page.locator('#position-readout').textContent())[1];
        const still = async when => {
            expect(await marks(page, b), when + ': B').toEqual(bBefore);
            expect(await marks(page, c), when + ': C').toEqual(cBefore);
        };
        /** Run the clock on by `q` and wait for the view to draw it (the
         * readout follows the clock). */
        const step = async q => {
            const shown = await readoutQ();
            await mock(page, 'advanceBy', Math.round(q * Q));
            await expect.poll(readoutQ).not.toBe(shown);
        };
        // ● on the 1Q loop: a NEW TAKE, armed for its next top — and the
        // clock held at once (an arm starts the transport), so the case
        // steps it by hand. (The published shape is the engine's,
        // docs/takes.md §6: ARMED is isPendingStart alone; isRecording
        // means capturing.)
        const up = n => n.isRecording || n.isPendingStart;
        await laneOf(page, a).locator('.arm-btn').click();
        await mock(page, 'pauseTransport');
        const r0 = await readoutQ();
        await expect.poll(async () => up(await node(page, a))).toBe(true);
        expect((await node(page, a)).isRecording, 'armed, not capturing').toBe(false);
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        await still('armed');
        // Into the take: the cursor runs on in the SAME frame (0.7Q of
        // clock, folded on 4Q).
        await step(0.7);
        await still('recording');
        expect(Math.abs(((await readoutQ()) - r0 + 4) % 4 - 0.7)).toBeLessThan(0.11);
        // On through the take — it waits for the slot's next top, then
        // captures one period — the picture still at every step. While
        // it captures the slot publishes the LIVE captured length on
        // `duration` — under one period — and its own on `periodQ`.
        let captured = false;
        for (let i = 0; i < 16 && up(await node(page, a)); i++) {
            const n = await node(page, a);
            if (n.isRecording) {
                captured = true;
                expect(n.duration, 'the live captured length').toBeLessThan(Q);
                expect(n.periodQ, 'the slot stands on periodQ').toEqual({ num: 1, den: 1 });
            }
            await step(0.2);
            await still('step ' + i);
        }
        expect(captured, 'the take captured (not only waited)').toBe(true);
        await expect.poll(async () => up(await node(page, a))).toBe(false);
        expect((await node(page, a)).duration, 'the slot\'s length again').toBe(Q);
        await expect(page.locator('#lanes')).not.toHaveClass(/map-locked/);
        await still('committed');
        expect((await node(page, a)).takes).toBe(2);
    });

    test('a ⇧ trim of the placing loop: the transport readout keeps its width while the drag adds "· loop NQ", and the re-laid frame snaps', async ({ page }) => {
        // THE STATE-METRICS LAW in the transport: ⇧-shortening B to 3Q
        // makes the live cycle 12Q under a frame the drag pins at 4Q, so
        // the readout says where the cursor wraps — " · loop 4Q" — for
        // as long as the hand is down. The odometer keeps its size and
        // the meters after it their place.
        const { Q, b } = await setup(page);
        await selectLane(page, b);
        const readout = page.locator('#position-readout');
        const boxes = async () => page.evaluate(() => ({
            odometer: document.getElementById('odometer').getBoundingClientRect().width,
            meters: document.getElementById('master-monitor').getBoundingClientRect().left,
        }));
        await expect(readout).not.toHaveText(/loop/);
        const rest = await boxes();
        const watch = await watchFrames(page, () => ({
            moving: document.getElementById('lanes').classList.contains('frame-tweening'),
        }));
        await gripDrag(page, b, 'wrap', -1.1, { end: true, mods: ['Shift'], hold: true });
        await expect(readout).toHaveText(/· loop 4Q/);
        expect(await boxes()).toEqual(rest);
        await release(page, ['Shift']);
        await expect(readout).not.toHaveText(/· loop/);
        expect((await boxes()).odometer).toBe(rest.odometer);
        // [4, 7): the frame is re-laid out (3Q against C's 4Q: 12Q). A
        // change of the frame's LENGTH snaps — no frame of the drag or
        // of its landing is a re-seat move.
        await expect.poll(() => loopOf(page, b, Q)).toBe('4,7');
        await expect.poll(() => laneFrameQ(page, b)).toBe(12);
        await settled(page);
        const rows = await watch.stop();
        expect(rows.length).toBeGreaterThan(10);
        expect(rows.some(f => f.moving), 'never a tween').toBe(false);
    });
});

/* HANDLES ON THE SELECTED TRACK ONLY (docs/loop_selection.md §15). An
 * unselected lane's loop section shows how its loop aligns with the
 * song — the ↺ and splices as quiet lines — and is not an edit surface:
 * a press there selects the track and does nothing else, its
 * double-click never cuts, and its chip still toggles. The region panel
 * is in the edit bar at the foot of the view, so a selection never
 * moves a lane. */
test.describe('An unselected track', () => {
    /** B selected; C — below it — is not. */
    async function setupUpper(page) {
        const t = await setup(page);
        await selectLane(page, t.b);
        await expect(panelOf(page, t.c)).toBeHidden();
        return t;
    }
    const isSel = (page, id) => laneOf(page, id)
        .evaluate(row => row.classList.contains('sel'));

    test('shows its loop as marks — lines, no tabs, nothing to grab; its double-click never cuts; its chip still toggles the loop', async ({ page }) => {
        const { b, c } = await setupUpper(page);
        const body = laneOf(page, c).locator('.lane-body');
        const cuts = async () => ((await node(page, c)).segments || []).length / 2;
        const calls = recordMapCalls(page);
        // The ↺ and the splice are still where they are, as lines: no
        // tab shows, and no handle takes a press.
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@3']);
        for (const tab of await body.locator('.lr-layer .lr-tab').all()) {
            await expect(tab).toBeHidden();
        }
        expect(await body.locator('.lr-layer > :is(.lr-splice, .lr-top)').evaluateAll(hs =>
            hs.map(h => getComputedStyle(h).pointerEvents))).not.toContain('auto');
        // ITS DOUBLE-CLICK selects it and sends nothing.
        const bb = await body.boundingBox();
        const cell = { x: bb.x + bb.width * 0.4, y: bb.y + bb.height / 2 };
        await page.mouse.dblclick(cell.x, cell.y);
        await expect.poll(() => isSel(page, c)).toBe(true);
        await consoleDrained(page);
        expect(calls).toEqual([]);
        expect(await cuts()).toBe(0);
        // Selected, the same lane wears its tabs and the same
        // double-click cuts the cell.
        await expect(body.locator('.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end) .lr-tab'))
            .toBeVisible();
        await page.mouse.dblclick(cell.x, cell.y);
        await expect.poll(cuts).toBe(2);
        await consoleDrained(page);
        expect(calls).toEqual(['setSegments']);
        // ITS CHIP (the cut undone, B selected again) still toggles the
        // loop — and selects the track.
        await undo(page);
        await expect.poll(cuts).toBe(0);
        await selectLane(page, b);
        const chip = laneOf(page, c).locator('.win-heard-chip');
        await expect(chip).toHaveText(/window 4Q/);
        await chip.click();
        await expect.poll(async () => (await node(page, c)).loopBypassed).toBe(true);
        await expect.poll(() => isSel(page, c)).toBe(true);
    });

    test('a press on it selects it and does nothing else; no lane moves', async ({ page }) => {
        const { Q, a, b, c } = await setupUpper(page);
        const bodyTop = id => laneOf(page, id).locator('.lane-body')
            .evaluate(el => Math.round(el.getBoundingClientRect().top));
        const tops = async () => [await bodyTop(a), await bodyTop(b), await bodyTop(c)];
        const tops0 = await tops();
        const calls = recordMapCalls(page);
        // The wrap splice's line on the lane, below where its tab would be.
        const at = await laneOf(page, c).locator('.lane-body').evaluate(body => {
            const h = body.querySelector('.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end)');
            const r = h.getBoundingClientRect();
            const bb = body.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: bb.top + bb.height * 0.75 };
        });
        // A DRAG from the line: the press selects; the drag swaps
        // nothing (there was no handle under it).
        await dragBy(page, at, 0, { hold: true, steps: 1 });
        await expect.poll(() => isSel(page, c)).toBe(true);
        expect(await tops(), 'at the press: the edit bar moves no lane').toEqual(tops0);
        await page.mouse.move(at.x - 1.2 * await lanePxPerQ(page, c), at.y, { steps: 10 });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveCount(0);
        await release(page);
        await consoleDrained(page);
        expect(calls, 'the drag sent nothing').toEqual([]);
        expect(await loopOf(page, c, Q)).toBe('6,10');
        expect(await isSel(page, b)).toBe(false);
        await expect(panelOf(page, c)).toBeVisible();
        await expect(panelOf(page, b)).toBeHidden();
        expect(await tops(), 'after: still no lane moved').toEqual(tops0);
        // Now selected, the same splice drags: −1Q, a swap.
        await gripDrag(page, c, 'wrap', -1.2);
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');
        await consoleDrained(page);
        expect(calls.length).toBeGreaterThan(0);
        expect(await tops()).toEqual(tops0);
    });
});

/* A RAW-FRAMED LANE WHOSE TAKE TILE WRAPS THE FRAME (window_edit.js).
 * C's take is 16Q, performed from 14Q: with its window bypassed — or
 * cleared — the lane frames the raw take, the frame is 16Q, the take
 * tile starts partway in and the frame's end clips it: the rest of the
 * take is drawn from the frame's start. A bracket is placed where its
 * content is DRAWN, wrapped with the tile, so every bracket is on the
 * lane and in reach. */
test.describe('Brackets on a take tile that wraps the frame', () => {
    /** The lane's brackets: edge, lane position (Q, the bracket's own
     * line), and whether the box is inside the lane. */
    const brackets = (page, id) => page.evaluate(id => {
        const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
        const br = body.getBoundingClientRect();
        return [...body.querySelectorAll('.overlay-layer > .win-bracket:not(.snap-ghost)')]
            .map(b => {
                const r = b.getBoundingClientRect();
                const end = b.classList.contains('end');
                return { edge: end ? 'end' : 'start',
                         q: +((((end ? r.right : r.left) - br.left) / br.width) * body._cycleQ).toFixed(2),
                         inside: r.left >= br.left - 1 && r.right <= br.right + 1 };
            });
    }, id);
    const bracketPoint = (page, id, edge) => centreOf(laneOf(page, id)
        .locator(`.overlay-layer > .win-bracket.${edge}:not(.snap-ghost)`));
    const frameIs = (page, id, q) => expect.poll(() => laneFrameQ(page, id)).toBe(q);

    test('a bypassed window: its end bracket and chip are on the lane, and the bracket drags', async ({ page }) => {
        const { Q, c } = await setup(page);
        await call(page, 'toggleLoopWindow', c);
        await frameIs(page, c, 16);
        // [6, 10) of a take whose tile starts 9Q in: the start at 15Q,
        // the end on the wrapped part, 3Q in.
        await expect.poll(() => brackets(page, c)).toEqual([
            { edge: 'start', q: 15, inside: true },
            { edge: 'end', q: 3, inside: true }]);
        const chip = laneOf(page, c).locator('.overlay-layer > .win-chip');
        await expect(chip).toHaveText('window · bypassed');
        const lb = await laneOf(page, c).locator('.lane-body').boundingBox();
        const cb = await chip.boundingBox();
        expect(cb.x + cb.width, 'the whole chip is on the lane')
            .toBeLessThanOrEqual(lb.x + lb.width);
        // Drag the end bracket 1Q LEFT: [6, 9) — the pointer reads the
        // content on the wrapped side.
        await dragBy(page, await bracketPoint(page, c, 'end'), -1.1 * await lanePxPerQ(page, c));
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,9');
        expect((await node(page, c)).loopBypassed, 'still bypassed').toBe(true);
        await expect.poll(async () => (await brackets(page, c)).find(b => b.edge === 'end').q)
            .toBe(2);
    });

    test('a plain loop: both latent brackets sit on the take\'s seam, each on its own side — either draws a region in', async ({ page }) => {
        const { Q, c } = await setup(page);
        const clear = () => call(page, 'setLoopPoints', c, 0, 0);
        await clear();
        await frameIs(page, c, 16);
        // One seam, where the take tile starts — inside the lane, not on
        // its edge — and a bracket on each side of it.
        await expect.poll(async () => {
            const bs = await brackets(page, c);
            return bs.length === 2 && bs.every(b => b.inside) &&
                bs[0].edge === 'start' && bs[1].edge === 'end' &&
                bs[0].q === bs[1].q && bs[0].q > 0 && bs[0].q < 16;
        }).toBe(true);
        const pxq = await lanePxPerQ(page, c);
        // THE END, 2Q inward (left): the take's last 2Q go — [0, 14).
        await laneOf(page, c).locator('.lane-body').hover();
        await dragBy(page, await bracketPoint(page, c, 'end'), -2.1 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('0,14');
        // THE START, 2Q inward (right) — pressed on its own visible box,
        // clear of the end bracket's hit zone: [2, 16).
        await clear();
        await expect.poll(() => loopOf(page, c, Q)).toBe('0,0');
        await frameIs(page, c, 16);
        await expect.poll(async () => (await brackets(page, c)).length).toBe(2);
        await settled(page);
        await laneOf(page, c).locator('.lane-body').hover();
        await dragBy(page, await bracketPoint(page, c, 'start'), 2.1 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('2,16');
    });
});
