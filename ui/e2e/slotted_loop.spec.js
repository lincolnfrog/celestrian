/**
 * A LOOP THAT SLOTS INTO THE FRAME — "clip 3+" (frame.md §1, owner
 * 2026-09-29): ONE loop places the frame, the first longer than Q; every
 * other loop slots in where it falls, and its ↺ is WHERE IT STARTS
 * PLAYING — the sample it plays at the frame's left edge. So on the lane
 * its ↺ rests at the left edge always; in the panel it marks that sample
 * of the take; a region swap leaves it on the same sample; a ↺ drag
 * re-times the take so another sample starts it.
 *
 * splice_handles.spec.js drives the loop that PLACES the frame; nothing
 * drove one that slots in until the 2026-10-01 audit, whose findings
 * this pins — REAL mouse input throughout (synthetic dispatch bypasses
 * hit-testing):
 *   (a) the ↺ as shown vs the engine's own top: a splice swap previews
 *       the top the ENGINE will store, so the preview is answered by the
 *       next poll and an undo shows at once (predicted from the ↺ as
 *       shown it never matched, and the lane sat on the undone edit for
 *       the 1.5 s hold cap);
 *   (b) the lane ↺ re-times; the panel's ↺ puts the chosen hit on the
 *       frame's top; a cancelled marker drag puts the engine's top back;
 *   (c) a whole-Q drag of a cut never leaves a sliver segment;
 *   (d) → then ←, a moment apart, lands on the sample it left;
 *   (e) a NEW TAKE of the 1Q loop above the placing loop never moves the
 *       frame;
 *   (f) editing the slotted loop never moves the frame or the others;
 *   (g) the transport's readout keeps its width through a drag that
 *       adds "· loop NQ" to it (the state-metrics law).
 */

import { test, expect } from '@playwright/test';
import { node, loopOf, segsOf, laneOf, stripOf, viewOf, selectLane,
         laneHandles as handles, laneMarks as marks, handleTab as tabPoint,
         lanePxPerQ, dragBy as drag, slottedTopology, panelOf }
    from './region_panel_helpers.js';

/** The raw Q the panel's ↺ mark sits on. */
async function panelTopQ(page, id) {
    const b = await panelOf(page, id).locator('.region-top').boundingBox();
    const s = await stripOf(page, id).boundingBox();
    const v = await viewOf(page, id);
    return +(v.q0 + (b.x + b.width / 2 - s.x) / s.width * v.spanQ).toFixed(2);
}

/** Is any gesture preview still pending (session_view/pending_edits)? */
const previewPending = page => page.evaluate(async () =>
    (await import('/js/session_view/pending_edits.js')).hasPendingEdits());

/** The owner's topology (region_panel_helpers slottedTopology): a 1Q
 * loop (A); B, a 12Q take looped to [4, 8), the first loop longer than
 * Q — it places the frame; and C, a 16Q take from 14Q looped to
 * [6, 10), which slots in: its region start sounds 3Q into the 4Q
 * frame, and the sample at the frame's top is raw 7. C is selected. */
async function setup(page) {
    const t = await slottedTopology(page);
    await selectLane(page, t.c);
    await expect.poll(() => marks(page, t.c)).toEqual(['top@0', 'wrap@3']);
    return t;
}

test.describe('A loop that slots into the frame (clip 3+)', () => {
    test('(a)(f) its ↺ is where it starts; a swap keeps it there, moves nothing else, and an undo shows at once', async ({ page }) => {
        const { Q, b, c } = await setup(page);
        // The ↺ at the frame's left edge on the lane; in the panel, on
        // the sample that plays there (raw 7) — not on the engine's own
        // top, the region start it has stored (raw 6).
        expect(await panelTopQ(page, c)).toBe(7);
        expect((await node(page, c)).loopTop / Q).toBe(6);
        const bBefore = await marks(page, b);
        expect(bBefore).toEqual(['top@0', 'wrap@0', 'wrap@4']);

        // DRAG ITS SPLICE −1Q (whole-Q relative): [5, 9). Held, the lane
        // shows the swap; the ↺ does not move.
        const pxq = await lanePxPerQ(page, c);
        await drag(page, await tabPoint(page, c, 'wrap'), -1.2 * pxq, { hold: true });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveText(/swap · splice −1Q/);
        await expect.poll(async () => (await handles(page, c))
            .filter(h => h.kind === 'top' && !h.ghost).map(h => h.x)).toEqual([0]);
        await page.mouse.up();
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');
        // The same sample starts it (a swap never moves audio), the
        // engine's top is the one it had (the region still plays raw 6),
        // and nothing else moved.
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
        expect(await panelTopQ(page, c)).toBe(7);
        const n = await node(page, c);
        expect(n.loopTop / Q).toBe(6);
        expect(n.origin / Q).toBe(14);
        expect(n.retime).toBe(0);
        expect(await marks(page, b)).toEqual(bBefore);

        // THE PREVIEW IS ANSWERED: gone within a few polls of the
        // release — it used to sit for the whole 1.5 s hold cap, the
        // lane frozen on it.
        await expect.poll(() => previewPending(page), { timeout: 600 }).toBe(false);
        // …so an undo shows at once.
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,10');
        await expect.poll(() => marks(page, c), { timeout: 600 }).toEqual(['top@0', 'wrap@3']);
        await expect(page.locator('#log-line')).toHaveText('Undo');
    });

    test('(a) an undo pressed before the engine has answered still shows at once', async ({ page }) => {
        // The preview is kept until the poll MATCHES it, and after an
        // undo no poll will: the keystroke drops it (app.js
        // dropStaleEditFeedback), and the edit's queued verdict with it —
        // which would otherwise call the undone edit "refused".
        const { Q, c } = await setup(page);
        const pxq = await lanePxPerQ(page, c);
        await drag(page, await tabPoint(page, c, 'wrap'), -1.2 * pxq, { hold: true });
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');   // a live commit
        await page.mouse.up();
        await page.keyboard.press('ControlOrMeta+z');              // no pause at all
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,10');
        await expect.poll(() => marks(page, c), { timeout: 600 }).toEqual(['top@0', 'wrap@3']);
        await page.waitForTimeout(400);                            // past the verdict's debounce
        await expect(page.locator('#log-line')).toHaveText('Undo');
    });

    test('(b) the lane ↺ re-times it: the audio moves, the ↺ rests at the left edge, the panel names the new sample', async ({ page }) => {
        const { Q, b, c } = await setup(page);
        const bBefore = await marks(page, b);
        const pxq = await lanePxPerQ(page, c);
        await drag(page, await tabPoint(page, c, 'top'), 1.3 * pxq, { hold: true });
        await expect(laneOf(page, c).locator('.lr-badge'))
            .toHaveText('shift +1Q · timing: shifted +1Q');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, c)).origin / Q).toBe(15);
        expect((await node(page, c)).retime / Q).toBe(1);
        expect(await loopOf(page, c, Q)).toBe('6,10');            // the region is untouched
        // The splice went with the audio (3Q → 4Q ≡ the frame's edge:
        // both ends); the ↺ is at the left edge again, on the sample the
        // shift brought there — raw 6, the region start.
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@0', 'wrap@4']);
        await expect.poll(() => panelTopQ(page, c)).toBe(6);
        await expect(panelOf(page, c).locator('.region-timing-read'))
            .toHaveText('timing: shifted +1Q');
        // The loop that places the frame did not move.
        expect(await marks(page, b)).toEqual(bBefore);
        // "Timing as played" puts it back.
        await panelOf(page, c).locator('.region-timing-reset').click();
        await expect.poll(async () => (await node(page, c)).origin / Q).toBe(14);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@3']);
        await expect.poll(() => panelTopQ(page, c)).toBe(7);
    });

    test('(b) the panel\'s ↺ puts the chosen hit on the frame\'s top; Escape puts the engine\'s own top back', async ({ page }) => {
        const { Q, c } = await setup(page);
        const lane = laneOf(page, c);
        const panel = panelOf(page, c);
        const tab = panel.locator('.region-top-tab');
        const tb = await tab.boundingBox();
        const v = await viewOf(page, c);
        const s = await stripOf(page, c).boundingBox();
        const pxq = s.width / v.spanQ;
        const at = { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 };
        // Onto raw 8 (+1.3Q of hand → +1Q): the take moves 1Q EARLIER so
        // raw 8 lands where raw 7 did — on the frame's top.
        await drag(page, at, 1.3 * pxq, { hold: true });
        await expect(panel.locator('.region-badge')).toHaveText('↺ on 8Q · shift −1Q');
        await expect.poll(async () => (await node(page, c)).origin / Q).toBe(13);  // live
        // ESCAPE: the origin goes back — and so does the engine's top,
        // to the one it HAD (raw 6), not to the ↺ as shown (raw 7).
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, c)).origin / Q).toBe(14);
        const n0 = await node(page, c);
        expect(n0.retime).toBe(0);
        expect(n0.loopTop / Q).toBe(6);
        await expect.poll(() => panelTopQ(page, c)).toBe(7);
        await expect(panel.locator('.region-overlay')).not.toHaveClass(/drag-held/);

        // The same drag, released: it lands.
        const tb2 = await panel.locator('.region-top-tab').boundingBox();
        await drag(page, { x: tb2.x + tb2.width / 2, y: tb2.y + tb2.height / 2 }, 1.3 * pxq);
        await expect.poll(async () => (await node(page, c)).loopTop / Q).toBe(8);
        const n1 = await node(page, c);
        expect(n1.origin / Q).toBe(13);
        expect(n1.retime / Q).toBe(-1);
        await expect.poll(() => panelTopQ(page, c)).toBe(8);
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@2']);
        await expect(panel.locator('.region-timing-read')).toHaveText('timing: shifted −1Q');
    });

    test('(c) a whole-Q drag of a cut never leaves a sliver: no room, no move', async ({ page }) => {
        const { Q, c } = await setup(page);
        // [6, 8) ∪ [9, 10): a 1Q cut whose neighbour after it is 1Q long.
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setSegments', id, [6 * Q, 8 * Q, 9 * Q, 10 * Q]), { id: c, Q });
        await expect.poll(async () => (await handles(page, c))
            .filter(h => h.kind === 'cut' && !h.ghost).length).toBe(1);
        // Wait for the frame to settle on the 3Q loop (12Q with B's 4Q).
        await expect.poll(() => laneOf(page, c).locator('.lane-body')
            .evaluate(b => b._cycleQ)).toBe(12);
        // +1.2Q of hand toward it: a whole Q would swallow the 1Q
        // segment, so nothing moves (it used to land 1/64 Q short of it,
        // a sliver left playing at the splice).
        await drag(page, await tabPoint(page, c, 'cut'),
                   1.2 * await lanePxPerQ(page, c), { hold: true });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveText(/swap · move cut \+0Q/);
        await page.mouse.up();
        await page.waitForTimeout(300);
        expect(await segsOf(page, c, Q)).toBe('6,8,9,10');
        // −1.2Q: a whole Q the other way has room — [6, 7) ∪ [8, 10).
        await drag(page, await tabPoint(page, c, 'cut'), -1.2 * await lanePxPerQ(page, c));
        await expect.poll(() => segsOf(page, c, Q)).toBe('6,7,8,10');
        // ⌥ stays free.
        await expect.poll(() => laneOf(page, c).locator('.lane-body')
            .evaluate(b => b._cycleQ)).toBe(12);
        await drag(page, await tabPoint(page, c, 'cut'), 0.4 * await lanePxPerQ(page, c),
                   { mods: ['Alt'] });
        await expect.poll(async () => (await segsOf(page, c, Q)).split(',')
            .map(v => (+v).toFixed(1)).join()).toBe('6.0,7.4,8.4,10.0');
    });

    test('(d) → then ←, a moment apart, lands on the sample it left', async ({ page }) => {
        // (Until 2026-10-08 this pinned the ⌥ ⅛Q nudge's whole-sample
        // step; the ⌥ nudge is gone — no sub-Q grid — and the round trip
        // is pinned with the whole-Q keys.)
        const { Q, c } = await setup(page);
        const before = await node(page, c);
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => (await node(page, c)).loopStart)
            .toBe(before.loopStart + Q);
        // Past the nudge chain's window (800 ms): the next press reads
        // the region back from the polled samples.
        await page.waitForTimeout(1000);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(async () => (await node(page, c)).loopStart).toBe(before.loopStart);
        expect((await node(page, c)).loopEnd).toBe(before.loopEnd);
        // …so its ↺ stays on the same sample.
        await expect.poll(() => panelTopQ(page, c)).toBe(7);
    });

    test('(e) a new take of the 1Q loop above the placing loop never moves the frame', async ({ page }) => {
        const { Q, a, b, c } = await setup(page);
        const bBefore = await marks(page, b);
        const cBefore = await marks(page, c);
        const readoutQ = async () => +/^([\d.]+)Q/.exec(
            await page.locator('#position-readout').textContent())[1];
        const r0 = await readoutQ();
        // ● on the 1Q loop: a NEW TAKE, armed for its next top. (The
        // published shape is the engine's, takes.md §6: ARMED is
        // isPendingStart alone; isRecording means capturing.)
        const up = n => n.isRecording || n.isPendingStart;
        await laneOf(page, a).locator('.arm-btn').click();
        await expect.poll(async () => up(await node(page, a))).toBe(true);
        expect((await node(page, a)).isRecording, 'armed, not capturing').toBe(false);
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        const still = async when => {
            expect(await marks(page, b), when + ': B').toEqual(bBefore);
            expect(await marks(page, c), when + ': C').toEqual(cBefore);
        };
        await page.waitForTimeout(150);
        await still('armed');
        // Into the take, then through its end (it captures one period).
        const step = async q => {
            await page.evaluate(n => window.__celestrianTest.advanceBy(n), Math.round(q * Q));
            await page.waitForTimeout(150);
        };
        await step(0.7);
        await still('recording');
        // The cursor ran on in the SAME frame (0.7Q of clock, folded on 4Q).
        expect(Math.abs(((await readoutQ()) - r0 + 4) % 4 - 0.7)).toBeLessThan(0.11);
        // On through the take — it waits for the slot's next top, then
        // captures one period — the picture still at every step.
        // While it captures the slot publishes the LIVE captured length
        // on `duration` — under one period — and its own on `periodQ`.
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

    test('(g) the transport readout keeps its width when a drag adds "· loop NQ"', async ({ page }) => {
        // THE STATE-METRICS LAW in the transport: ⇧-shortening B to 3Q
        // makes the live cycle 12Q under a frame the drag pins at 4Q, so
        // the readout says where the cursor wraps — " · loop 4Q" — for
        // as long as the hand is down. Sized by its text the odometer
        // grew with it and pushed the meters and everything after them
        // sideways (12 px here) under the pointer.
        const { b } = await setup(page);
        await selectLane(page, b);
        const readout = page.locator('#position-readout');
        const boxes = async () => page.evaluate(() => ({
            odometer: document.getElementById('odometer').getBoundingClientRect().width,
            meters: document.getElementById('master-monitor').getBoundingClientRect().left,
        }));
        await expect(readout).not.toHaveText(/loop/);
        const rest = await boxes();
        const pxq = await lanePxPerQ(page, b);
        await drag(page, await tabPoint(page, b, 'wrap', { end: true }), -1.1 * pxq,
                   { mods: ['Shift'], hold: true });
        await expect(readout).toHaveText(/· loop 4Q/);
        expect(await boxes()).toEqual(rest);
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await expect(readout).not.toHaveText(/· loop/);
        expect((await boxes()).odometer).toBe(rest.odometer);
    });
});

/* HANDLES ON THE SELECTED TRACK ONLY (owner 2026-10-08; loop_selection.md
 * §15). An unselected lane's loop section shows how its loop aligns
 * with the song — the ↺ and splices as quiet lines — and is not an edit
 * surface: a press there selects the track and does nothing else, its
 * double-click never cuts, and its chip still toggles. The region panel
 * is in the edit bar at the foot of the view, so a selection never
 * moves a lane. (Until 2026-10-08 every lane wore handles and a gesture
 * claimed its track when it ENDED, because the panel opened as a row
 * under the selected lane and moved the lanes below it — 74 px under
 * the hand on a press.) */
test.describe('An unselected track', () => {
    /** B selected; C — below it — is not. */
    async function setupUpper(page) {
        const t = await setup(page);
        await selectLane(page, t.b);
        await expect(panelOf(page, t.c)).toBeHidden();
        return t;
    }
    const bodyTop = (page, id) => laneOf(page, id).locator('.lane-body')
        .evaluate(el => Math.round(el.getBoundingClientRect().top));
    const isSel = (page, id) => laneOf(page, id)
        .evaluate(row => row.classList.contains('sel'));
    /** The wrap splice's line on the lane (page px), tab or no tab. */
    const wrapLine = (page, id) => laneOf(page, id).locator('.lane-body').evaluate(body => {
        const h = body.querySelector('.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end)');
        const r = h.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: b.top + b.height * 0.75 };
    });

    test('shows its loop as marks: lines, no tabs, nothing to grab', async ({ page }) => {
        const { c } = await setupUpper(page);
        const body = laneOf(page, c).locator('.lane-body');
        // The ↺ and the splice are still where they are…
        await expect.poll(() => marks(page, c)).toEqual(['top@0', 'wrap@3']);
        // …as lines: no tab shows, and no handle takes a press.
        for (const tab of await body.locator('.lr-layer .lr-tab').all()) {
            await expect(tab).toBeHidden();
        }
        expect(await body.locator('.lr-layer > :is(.lr-splice, .lr-top)').evaluateAll(hs =>
            hs.map(h => getComputedStyle(h).pointerEvents))).not.toContain('auto');
        // Selected, the same lane wears them.
        await selectLane(page, c);
        await expect(body.locator('.lr-layer > .lr-wrap:not(.lr-ghost):not(.lr-end) .lr-tab'))
            .toBeVisible();
    });

    test('a press on it selects it and does nothing else; no lane moves', async ({ page }) => {
        const { Q, a, b, c } = await setupUpper(page);
        const tops = async () => [await bodyTop(page, a), await bodyTop(page, b),
                                  await bodyTop(page, c)];
        const tops0 = await tops();
        // A DRAG from the splice's line: the press selects; the drag swaps
        // nothing (there was no handle under it).
        const at = await wrapLine(page, c);
        const pxq = await lanePxPerQ(page, c);
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await expect.poll(() => isSel(page, c)).toBe(true);
        expect(await tops(), 'at the press: the edit bar moves no lane').toEqual(tops0);
        await page.mouse.move(at.x - 1.2 * pxq, at.y, { steps: 10 });
        await expect(laneOf(page, c).locator('.lr-badge')).toHaveCount(0);
        await page.mouse.up();
        await page.waitForTimeout(200);
        expect(await loopOf(page, c, Q)).toBe('6,10');
        expect(await isSel(page, b)).toBe(false);
        await expect(panelOf(page, c)).toBeVisible();
        await expect(panelOf(page, b)).toBeHidden();
        expect(await tops(), 'after: still no lane moved').toEqual(tops0);
        // Now selected, the same splice drags: −1Q, a swap.
        await drag(page, await tabPoint(page, c, 'wrap'), -1.2 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');
        expect(await tops()).toEqual(tops0);
    });

    test('its double-click selects it and never cuts', async ({ page }) => {
        const { Q, c } = await setupUpper(page);
        const bb = await laneOf(page, c).locator('.lane-body').boundingBox();
        await page.mouse.dblclick(bb.x + bb.width * 0.4, bb.y + bb.height / 2);
        await expect.poll(() => isSel(page, c)).toBe(true);
        await page.waitForTimeout(200);
        expect(await loopOf(page, c, Q)).toBe('6,10');
        expect((await node(page, c)).segments || []).toEqual([]);
        // Selected, the same double-click cuts the cell.
        await page.mouse.dblclick(bb.x + bb.width * 0.4, bb.y + bb.height / 2);
        await expect.poll(async () => ((await node(page, c)).segments || []).length).toBe(4);
    });

    test('its chip still toggles the loop — and selects the track', async ({ page }) => {
        const { c } = await setupUpper(page);
        const chip = laneOf(page, c).locator('.win-heard-chip');
        await expect(chip).toHaveText(/window 4Q/);
        await chip.click();
        await expect.poll(async () => (await node(page, c)).loopBypassed).toBe(true);
        await expect.poll(() => isSel(page, c)).toBe(true);
    });
});

/* A RAW-FRAMED LANE WHOSE TAKE TILE WRAPS THE FRAME (window_edit.js
 * bracketQ / contentQNear). C's take is 16Q, performed from 14Q: with
 * its window bypassed — or cleared — the lane frames the raw take, the
 * frame is 16Q, the take tile starts 9Q in and the frame's end clips
 * it: its last 9Q are drawn from the frame's start. Brackets were
 * placed unwrapped, so the END bracket (and the chip) of a bypassed
 * window, and the latent end of a plain loop, sat past the lane's right
 * edge — out of sight and out of reach. */
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
    const bracketPoint = async (page, id, edge) => {
        const b = await laneOf(page, id)
            .locator(`.overlay-layer > .win-bracket.${edge}:not(.snap-ghost)`).boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const frameIs = (page, id, q) => expect.poll(() => laneOf(page, id)
        .locator('.lane-body').evaluate(el => el._cycleQ)).toBe(q);

    test('a bypassed window: its end bracket and chip are on the lane, and the bracket drags', async ({ page }) => {
        const { Q, c } = await setup(page);
        await page.evaluate(id =>
            window.__celestrianTest.callNative('toggleLoopWindow', id), c);
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
        // content on the wrapped side (it read a whole frame early).
        const pxq = await lanePxPerQ(page, c);
        await drag(page, await bracketPoint(page, c, 'end'), -1.1 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('6,9');
        expect((await node(page, c)).loopBypassed, 'still bypassed').toBe(true);
        await expect.poll(async () => (await brackets(page, c)).find(b => b.edge === 'end').q)
            .toBe(2);
    });

    test('a plain loop: both latent brackets sit on the take\'s seam, each on its own side — either draws a region in', async ({ page }) => {
        const { Q, c } = await setup(page);
        const clear = () => page.evaluate(id =>
            window.__celestrianTest.callNative('setLoopPoints', id, 0, 0), c);
        await clear();
        await frameIs(page, c, 16);
        await expect.poll(() => brackets(page, c)).toEqual([
            { edge: 'start', q: 9, inside: true },
            { edge: 'end', q: 9, inside: true }]);
        const pxq = await lanePxPerQ(page, c);
        // THE END, 2Q inward (left): the take's last 2Q go — [0, 14).
        await laneOf(page, c).locator('.lane-body').hover();
        await drag(page, await bracketPoint(page, c, 'end'), -2.1 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('0,14');
        // THE START, 2Q inward (right) — pressed on its own visible box,
        // which the end bracket's hit zone used to cover: [2, 16).
        await clear();
        await expect.poll(() => loopOf(page, c, Q)).toBe('0,0');
        await frameIs(page, c, 16);
        await expect.poll(async () => (await brackets(page, c)).length).toBe(2);
        await laneOf(page, c).locator('.lane-body').hover();
        await drag(page, await bracketPoint(page, c, 'start'), 2.1 * pxq);
        await expect.poll(() => loopOf(page, c, Q)).toBe('2,16');
    });
});
