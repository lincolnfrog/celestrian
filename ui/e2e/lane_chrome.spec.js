/**
 * THE MAP CHROME on its less-travelled states (session_view/
 * lane_body.js, window_edit.js, map_bands.js, gesture.js):
 *   - a clip's cut map, bypassed: its lane chip switches it back on,
 *     and its cut band drags on the raw-framed lane;
 *   - a lane bracket's ⌥ slide (a bypassed window);
 *   - only the primary button starts a drag;
 *   - a group's map that is bypassed, or suspended by its sequence,
 *     draws and reads as off;
 *   - a definer whose selection has a cut;
 *   - a one-shot's edge grips and seam handles;
 *   - a handle press on one of several selected tracks;
 *   - the comp editor's sound cursor;
 *   - a cut band's drag on the region panel: a sloppy click edits
 *     nothing, Escape puts the map and the band back, each gesture is
 *     one undo step.
 */

import { test, expect } from '@playwright/test';
import { boot, call, mock, sampleRate, quantum, node, segsOf, loopOf, recordDefiner,
         recordTake, setLoop, loopedTake, slottedTopology, armPending, laneOf, panelOf,
         stripOf, stripX, stripQ, stripPxPerQ, viewOf, selectLane, handleTab,
         lanePxPerQ, laneFrameQ, centreOf, dragBy, dragTo, release, undo,
         sampleFrames, settled, recordMapCalls, consoleDrained }
    from './helpers.js';

/** The map as Q, to a tenth (a free slide lands where the pointer's
 * pixel puts it). */
const roundedSegs = async (page, id, Q) => (await segsOf(page, id, Q)).split(',')
    .map(v => Math.round(Number(v) * 10) / 10).join(',');

/** The owner's topology with a 1Q cut at [5, 6) of the 12Q take, the
 * take selected and its panel showing the whole of it. */
async function cutTake(page) {
    const { Q, id2: id } = await loopedTake(page, { segs: [0, 5, 6, 12] });
    await page.keyboard.press('Shift+Z');
    await expect.poll(async () => (await viewOf(page, id)).spanQ).toBe(12);
    return { Q, id };
}

/** The owner's topology with the 12Q take's window [2, 6) bypassed, the
 * take selected, the view at rest: the lane frames the raw take and
 * wears its brackets. */
async function bypassedWindow(page) {
    const { Q, id2: id } = await loopedTake(page, { loop: [2, 6], select: false });
    await call(page, 'toggleLoopWindow', id);
    await selectLane(page, id);
    await expect(laneOf(page, id).locator('.lane-body .win-chip')).toHaveText(/bypassed/);
    await settled(page);
    return { Q, id };
}

test.describe('A clip\'s cut map, bypassed', () => {
    test('the lane chip bypasses it and switches it back on', async ({ page }) => {
        const { Q, id2 } = await loopedTake(page, { loop: null });
        // CUT: double-click the take in the panel → a 1Q cell cut.
        const strip = await stripOf(page, id2).boundingBox();
        await page.mouse.dblclick(await stripX(page, id2, 5.5),
            strip.y + strip.height / 2);
        await expect.poll(() => segsOf(page, id2, Q)).toBe('0,5,6,12');
        const lane = laneOf(page, id2);
        const chip = lane.locator('.win-chip');
        await expect(chip).toHaveText(/map 11Q/);

        // BYPASS from the chip: the whole take sounds, the map is kept.
        await chip.click();
        await expect(chip).toHaveText(/bypassed/);
        expect((await node(page, id2)).loopBypassed).toBe(true);
        expect(await segsOf(page, id2, Q)).toBe('0,5,6,12');

        // …and the same chip switches it back on.
        const calls = recordMapCalls(page);
        const at = await centreOf(chip);
        await page.mouse.click(at.x, at.y);
        await expect(lane.locator('.win-heard-chip')).toHaveText(/map 11Q/);
        expect((await node(page, id2)).loopBypassed).toBe(false);
        await consoleDrained(page);
        expect(calls).toEqual(['toggleLoopWindow']);
    });

    test('its cut band drags on the lane: the band rides the hand, the bypass stays', async ({ page }) => {
        const { Q, id } = await cutTake(page);
        const lane = laneOf(page, id);
        await lane.locator('.win-chip').click();
        await expect(lane.locator('.win-chip')).toHaveText(/bypassed/);
        await settled(page);
        const chip = lane.locator('.overlay-layer > .cut-chip');
        await expect(chip).toHaveCount(1);
        const pxPerQ = await lanePxPerQ(page, id);
        const at = await centreOf(chip);
        await dragBy(page, at, 2 * pxPerQ, { hold: true });
        // Mid-drag: the 1Q band shows under the hand, 2Q to the right of
        // where its chip sat.
        const band = lane.locator('.drag-preview-layer .cut-band');
        await expect(band).toBeVisible();
        expect(await lane.locator('.drag-preview-layer').evaluate(
            l => getComputedStyle(l).opacity)).toBe('1');
        const b = await band.boundingBox();
        expect(Math.abs((b.x - (at.x - pxPerQ / 2)) / pxPerQ - 2)).toBeLessThan(0.1);
        await release(page);
        await expect.poll(() => roundedSegs(page, id, Q)).toBe('0,7,8,12');
        expect((await node(page, id)).loopBypassed).toBe(true);
        await expect(lane.locator('.drag-preview-layer')).toHaveCount(0);
    });
});

test.describe('A lane bracket\'s ⌥ slide (a bypassed window)', () => {
    test('the chip reads the held length as a clean number; ⌥ released re-lands on whole Q', async ({ page }) => {
        const { Q, id } = await bypassedWindow(page);
        const lane = laneOf(page, id);
        const chip = lane.locator('.lane-body .win-chip');
        const { x, y } = await centreOf(lane.locator('.win-bracket.start'));
        const pxPerQ = await lanePxPerQ(page, id);
        await page.keyboard.down('Alt');
        await page.mouse.move(x, y);
        await page.mouse.down();
        // ⌥: the window slides with the hand by any amount, 4Q long.
        const texts = [];
        for (let i = 1; i <= 40; i++) {
            await page.mouse.move(x + i * 0.071 * pxPerQ, y);
            texts.push(await chip.textContent());
        }
        expect(texts.filter(t => t !== '4Q window'),
            'the length never prints float noise').toEqual([]);
        // ⌥ released mid-drag: the slide re-lands on whole Q, length held.
        await page.keyboard.up('Alt');
        await page.mouse.move(x + 2.9 * pxPerQ, y, { steps: 2 });
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id, Q)).toBe('5,9');
    });
});

test.describe('Only the primary button drags', () => {
    test('a right-button drag on the kept box or a lane bracket edits nothing', async ({ page }) => {
        const { Q, id } = await bypassedWindow(page);
        const calls = recordMapCalls(page);
        const rightDrag = async (at, dx) => {
            await page.mouse.move(at.x, at.y);
            await page.mouse.down({ button: 'right' });
            await page.mouse.move(at.x + dx, at.y, { steps: 6 });
            await page.mouse.up({ button: 'right' });
        };
        const end = laneOf(page, id).locator('.win-bracket.end');
        const pxPerQ = await lanePxPerQ(page, id);
        await rightDrag(await centreOf(panelOf(page, id).locator('.region-kept')), 80);
        await rightDrag(await centreOf(end), -2 * pxPerQ);
        await expect(page.locator('.drag-preview-layer, .snap-ghost')).toHaveCount(0);
        await consoleDrained(page);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await loopOf(page, id, Q)).toBe('2,6');
        // The primary button still drags the same bracket: [2, 6) → [2, 4).
        await dragBy(page, await centreOf(end), -1.8 * pxPerQ);
        await expect.poll(() => loopOf(page, id, Q)).toBe('2,4');
    });
});

test.describe('A group\'s map that is not sounding', () => {
    /** stack-1 (a 6Q inner cycle) under a two-step song. */
    async function songGroup(page) {
        await boot(page, { scenario: 'stack-with-clips' });
        const Q = await quantum(page);
        await call(page, 'setSequence', 'stack-1', {
            steps: [{ name: 'A', len: 6 * Q }, { name: 'B', len: 6 * Q }],
            gates: {} });
        return Q;
    }
    const cutMap = (page, Q) =>
        call(page, 'setSegments', 'stack-1', [0, 2, 4, 6].map(q => q * Q));
    const suspended = page => expect.poll(async () =>
        (await node(page, 'stack-1')).windowSuspended).toBe(true);

    test('a cut map its sequence suspends draws as off — says why, no dims, no sound cursor — and the panel says suspended', async ({ page }) => {
        // A song over the group, a cut map authored over the song, then
        // the sequence switched off: the map is suspended, its shape kept.
        const Q = await songGroup(page);
        await cutMap(page, Q);
        const lane = laneOf(page, 'stack-1');
        await expect(lane.locator('.win-heard-chip')).toHaveText(/map 4Q/);
        await call(page, 'toggleSequence', 'stack-1');
        await mock(page, 'startTransport');
        await suspended(page);
        await expect(lane.locator('.lane-body .win-chip'))
            .toHaveText('map · suspended (sequence off)');
        await expect(lane.locator('.lane-body .map-seam-tick')).toHaveCount(4);
        await expect(lane.locator('.lane-body .win-dim')).toHaveCount(0);
        await expect(lane.locator('.lane-body .win-cursor')).toHaveCount(0);
        await selectLane(page, 'stack-1');
        const panel = panelOf(page, 'stack-1');
        await expect(panel.locator('.region-term.loop')).toHaveText('suspended 4Q');
        await expect(panel.locator('.region-label')).toHaveAttribute('title', /sequence/);
        // The sequence back on: the map sounds again.
        await call(page, 'toggleSequence', 'stack-1');
        await expect(lane.locator('.win-heard-chip')).toHaveText(/map 4Q/);
    });

    test('a cut map, bypassed: the panel says bypassed, not "whole take"', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        await cutMap(page, await quantum(page));
        await call(page, 'toggleLoopWindow', 'stack-1');
        await selectLane(page, 'stack-1');
        await expect(laneOf(page, 'stack-1').locator('.lane-body .win-chip'))
            .toHaveText('map · bypassed');
        const panel = panelOf(page, 'stack-1');
        await expect(panel.locator('.region-term.loop')).toHaveText('bypassed 4Q');
        await expect(panel.locator('.region-label')).toHaveAttribute('title', /bypassed/);
    });

    test('a suspended window\'s chip keeps its reason as the tooltip', async ({ page }) => {
        const Q = await songGroup(page);
        await setLoop(page, 'stack-1', 2 * Q, 6 * Q);
        await call(page, 'toggleSequence', 'stack-1');
        await suspended(page);
        const chip = laneOf(page, 'stack-1').locator('.lane-body .win-chip');
        await expect(chip).toHaveText('window · suspended (sequence off)');
        await expect(chip).toHaveAttribute('title',
            /returns when the sequence is active again/);
    });
});

test.describe('A definer whose selection has a cut (the trim view)', () => {
    test('the cut is dimmed on the lane, and a ruler press past it seeks into the second run', async ({ page }) => {
        await boot(page);
        const SR = await sampleRate(page);
        // One 4 s take sets Q; its second second cut out, Q is the 3 s kept
        // and the frame is the 4 s buffer.
        const id = await recordDefiner(page, 4 * SR);
        await call(page, 'setSegments', id, [0, SR, 2 * SR, 4 * SR]);
        await mock(page, 'setIsPlaying', false);
        await expect.poll(() => segsOf(page, id, SR)).toBe('0,1,2,4');
        const body = laneOf(page, id).locator('.lane-body');
        await expect(body.locator('.win-chip.q-definer')).toBeVisible();
        // The cut [1 s, 2 s) of the 4 s buffer: one dim, a quarter in, a
        // quarter wide.
        const dim = body.locator('.win-dim');
        await expect(dim).toHaveCount(1);
        const b = await body.boundingBox();
        const d = await dim.boundingBox();
        expect(Math.abs((d.x - b.x) / b.width - 0.25)).toBeLessThan(0.01);
        expect(Math.abs(d.width / b.width - 0.25)).toBeLessThan(0.01);

        // A press at 3 s of the buffer is 1 s into the second run: 2 s
        // into the 3 s loop.
        const ruler = await page.locator('#ruler').boundingBox();
        await page.mouse.click(ruler.x + ruler.width * 0.75, ruler.y + ruler.height - 4);
        await expect.poll(async () => Math.abs((await call(page, 'getGraphState')).masterPos - 2 * SR))
            .toBeLessThan(0.05 * SR);
        // …and the stopped playhead shows under the press.
        await expect.poll(async () => Math.abs(await page.locator('#playhead')
            .evaluate(el => parseFloat(el.style.left)) - ruler.width * 0.75))
            .toBeLessThan(8);
    });
});

test.describe('A one-shot\'s loop region (edge grips and seam handles)', () => {
    /** A 1Q loop, a 12Q take looped to [4, 8) and made a ONE-SHOT, and an
     * 8Q loop that makes the frame 8Q: the shot sounds over the frame's
     * first 4Q. `selected`: select the shot (its handles are live). */
    async function oneShot(page, { selected = true } = {}) {
        const { Q, id2: id } = await loopedTake(page, { loop: null, select: false });
        const other = await recordTake(page, Q, 8);
        await setLoop(page, id, 4 * Q, 8 * Q);
        await call(page, 'setPeriodSource', id, 'context');
        const lane = laneOf(page, id);
        await expect(lane.locator('.lane-body')).toHaveClass(/one-shot/);
        await selectLane(page, selected ? id : other);
        await settled(page);
        return { Q, id, other, lane, body: lane.locator('.lane-body') };
    }
    /** A 1Q cut at [5, 6) of the shot's region. */
    const cut = async (page, id, Q) => {
        await call(page, 'setSegments', id, [4, 5, 6, 8].map(q => q * Q));
        await expect.poll(() => segsOf(page, id, Q)).toBe('4,5,6,8');
    };

    test('the end grip trims in on whole Qs and back out through the reveal', async ({ page }) => {
        const { Q, id, lane, body } = await oneShot(page);
        await expect(body.locator('.trim-grip')).toHaveCount(2);
        const pxPerQ = await lanePxPerQ(page, id);
        const calls = recordMapCalls(page);
        // IN: 1.1Q to the left — the loop is 3Q, [4, 7).
        const end = body.locator('.trim-grip.end');
        await dragBy(page, await centreOf(end), -1.1 * pxPerQ);
        await expect.poll(() => loopOf(page, id, Q)).toBe('4,7');
        await expect(lane.locator('.win-heard-chip')).toHaveText(/window 3Q/);
        await expect(body).not.toHaveClass(/revealing/);
        // OUT: the lane unrolls the raw take at its own scale under the
        // hand, the material coming back shown dimmed beside the loop.
        await settled(page);
        await dragBy(page, await centreOf(end), 1.1 * pxPerQ, { hold: true });
        await expect(body).toHaveClass(/revealing/);
        await expect(body.locator('.reveal-layer .reveal-tile')).toBeVisible();
        await expect(body.locator('.drag-preview-layer .win-bracket.dragging'))
            .toBeVisible();
        await release(page);
        await expect.poll(() => loopOf(page, id, Q)).toBe('4,8');
        await expect(body).not.toHaveClass(/revealing/);
        await consoleDrained(page);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(c => c === 'setSegments'), calls.join()).toBe(true);
        // Two gestures, two undo steps.
        await undo(page);
        await expect.poll(() => loopOf(page, id, Q)).toBe('4,7');
        await undo(page);
        await expect.poll(() => loopOf(page, id, Q)).toBe('4,8');
    });

    test('a cut\'s seam handle slides it; a double-click on it, or beside it, heals', async ({ page }) => {
        const { Q, id, body } = await oneShot(page);
        await cut(page, id, Q);
        const seam = body.locator('.seam-handle');
        await expect(seam).toHaveCount(1);
        await settled(page);
        const pxPerQ = await lanePxPerQ(page, id);
        const frameQ = await laneFrameQ(page, id);
        // The seam sits 1Q into the shot (the kept [4, 5) before the
        // cut): 1Q on from the shot's start grip, round the frame —
        // wherever in the frame the shot sounds.
        const bb = await body.boundingBox();
        const s0 = await centreOf(seam);
        const shotStart = (await body.locator('.trim-grip.start').boundingBox()).x;
        const intoShot = (((s0.x - shotStart) / pxPerQ) % frameQ + frameQ) % frameQ;
        expect(Math.abs(intoShot - 1)).toBeLessThan(0.1);
        // SLIDE it 1Q later: the cut [5, 6) becomes [6, 7), length held.
        await dragBy(page, s0, pxPerQ);
        await expect.poll(() => roundedSegs(page, id, Q)).toBe('4,6,7,8');
        await expect(body).not.toHaveClass(/revealing/);
        // HEAL by a double-click on the handle.
        await settled(page);
        const s1 = await centreOf(seam);
        await page.mouse.dblclick(s1.x, s1.y);
        await expect.poll(() => segsOf(page, id, Q)).toBe('');
        expect(await loopOf(page, id, Q)).toBe('4,8');
        // …and by one just beside the seam (it has no width to hit).
        await cut(page, id, Q);
        await settled(page);
        const s2 = await seam.boundingBox();
        await page.mouse.dblclick(s2.x + s2.width + 3, bb.y + bb.height - 5);
        await expect.poll(() => segsOf(page, id, Q)).toBe('');
        expect(await loopOf(page, id, Q)).toBe('4,8');
    });

    test('a take armed elsewhere: the grips and the seam draw inert and take no drag', async ({ page }) => {
        const { Q, id, body } = await oneShot(page);
        await cut(page, id, Q);
        await expect(body.locator('.seam-handle')).toHaveCount(1);
        await armPending(page);
        await expect(body.locator('.trim-grip.inert')).toHaveCount(2);
        await expect(body.locator('.seam-handle.inert')).toHaveCount(1);
        await expect(body.locator('.trim-grip:not(.inert), .seam-handle:not(.inert)'))
            .toHaveCount(0);
        const calls = recordMapCalls(page);
        const pxPerQ = await lanePxPerQ(page, id);
        await dragBy(page, await centreOf(body.locator('.trim-grip.end')), -1.2 * pxPerQ);
        await dragBy(page, await centreOf(body.locator('.seam-handle')), pxPerQ);
        await consoleDrained(page);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await segsOf(page, id, Q)).toBe('4,5,6,8');
    });

    test('unselected, its seam is no edit surface: a right-click heals nothing', async ({ page }) => {
        const { Q, id, body } = await oneShot(page, { selected: false });
        await cut(page, id, Q);
        const seam = body.locator('.seam-handle');
        await expect(seam).toHaveCount(1);
        await settled(page);
        const calls = recordMapCalls(page);
        const s = await centreOf(seam);
        await page.mouse.click(s.x, s.y, { button: 'right' });
        await consoleDrained(page);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await segsOf(page, id, Q)).toBe('4,5,6,8');
        // Selected, the same right-click heals it.
        await selectLane(page, id);
        await settled(page);
        const s2 = await centreOf(seam);
        await page.mouse.click(s2.x, s2.y, { button: 'right' });
        await expect.poll(() => segsOf(page, id, Q)).toBe('');
    });
});

test.describe('A loop handle pressed on one of several selected tracks', () => {
    test('selects that track alone from the press on; the edit bar shows it', async ({ page }) => {
        const { Q, b, c } = await slottedTopology(page);
        await selectLane(page, c);
        await laneOf(page, b).locator('.rail-name').click({ modifiers: ['Meta'] });
        await expect(page.locator('.lane-rail.selected')).toHaveCount(2);
        // The bar shows the track selected last.
        await expect(panelOf(page, b)).toBeVisible();
        await settled(page);
        // PRESS C's splice and hold: C alone is selected, before any move.
        const tab = await handleTab(page, c, 'wrap');
        await dragBy(page, tab, 0, { hold: true, steps: 1 });
        await expect(page.locator('.lane.sel')).toHaveCount(1);
        await expect(laneOf(page, c)).toHaveClass(/\bsel\b/);
        await expect(page.locator('#selection-bar')).not.toHaveClass(/open/);
        await expect(panelOf(page, c)).toBeVisible();
        await expect(panelOf(page, b)).toBeHidden();
        // The drag edits it: the splice −1Q, [6, 10) → [5, 9).
        await page.mouse.move(tab.x - 1.2 * await lanePxPerQ(page, c), tab.y, { steps: 8 });
        await release(page);
        await expect.poll(() => loopOf(page, c, Q)).toBe('5,9');
        expect(await loopOf(page, b, Q)).toBe('4,8');
        await expect(page.locator('.lane.sel')).toHaveCount(1);
        await expect(laneOf(page, c)).toHaveClass(/\bsel\b/);
    });
});

test.describe('The comp editor\'s sound cursor (an active window, raw-framed)', () => {
    test('is placed inside the window and moves with the sound', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        const Q = await quantum(page);
        await call(page, 'newTake', 'clip-1');
        await mock(page, 'advanceBy', 2 * Q);
        await setLoop(page, 'clip-1', 0, Q);
        const lane = laneOf(page, 'clip-1');
        await expect(lane.locator('.take-btn')).toHaveText('T2/2');
        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-comp-row').click();
        const body = lane.locator('.lane-body');
        await expect(body.locator('.comp-cell.editing')).toHaveCount(2);
        const cursor = body.locator('.win-cursor');
        await expect(cursor).toHaveCount(1);
        await mock(page, 'startTransport');
        await expect(cursor).toBeVisible();
        // The window is the take's first Q of two: in every frame the
        // cursor is in the lane's first half, and it travels.
        const rows = await sampleFrames(page, () => {
            const b = document.querySelector('.lane[data-id="clip-1"] .lane-body');
            const br = b.getBoundingClientRect();
            const cr = b.querySelector('.win-cursor').getBoundingClientRect();
            return { f: (cr.left + cr.width / 2 - br.left) / br.width };
        }, null, { ms: 600 });
        for (const { f } of rows) {
            expect(f).toBeGreaterThan(-0.01);
            expect(f).toBeLessThan(0.51);
        }
        expect(new Set(rows.map(r => Math.round(r.f * 50))).size).toBeGreaterThan(3);
    });
});

test.describe('A cut band\'s drag (the region panel)', () => {
    /** The panel's resting cut band as raw Q [a, b] (null while none). */
    async function panelBandQ(page, id) {
        const band = panelOf(page, id).locator('.region-overlay > .cut-band');
        const b = await band.count() ? await band.first().boundingBox() : null;
        if (!b) return null;
        return [await stripQ(page, id, b.x), await stripQ(page, id, b.x + b.width)]
            .map(q => Math.round(q * 100) / 100);
    }

    test('a sloppy click on the chip edits nothing and leaves no undo step', async ({ page }) => {
        const { Q, id } = await cutTake(page);
        const calls = recordMapCalls(page);
        const chip = panelOf(page, id).locator('.region-overlay > .cut-chip');
        await dragBy(page, await centreOf(chip), 1, { steps: 1 });
        await consoleDrained(page);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await segsOf(page, id, Q)).toBe('0,5,6,12');
        // ⌘Z still undoes the cut itself: the click logged nothing.
        await undo(page);
        await expect.poll(() => segsOf(page, id, Q)).toBe('');
    });

    test('Escape mid-drag puts the map back, and the band back where it was', async ({ page }) => {
        const { Q, id } = await cutTake(page);
        const panel = panelOf(page, id);
        expect(await panelBandQ(page, id)).toEqual([5, 6]);
        const at = await centreOf(panel.locator('.region-overlay > .cut-handle.end'));
        await dragTo(page, at, await stripX(page, id, 8.1), { steps: 8, hold: true });
        // A live commit lands the resized cut [5, 8) while the hand holds.
        await expect.poll(() => segsOf(page, id, Q)).toBe('0,5,8,12');
        await page.keyboard.press('Escape');
        await expect.poll(() => segsOf(page, id, Q)).toBe('0,5,6,12');
        await page.mouse.up();
        // The chrome follows the map: the band at [5, 6), no snap ghost,
        // no preview left behind.
        await expect.poll(() => panelBandQ(page, id)).toEqual([5, 6]);
        await expect(panel.locator('.drag-preview-layer')).toHaveCount(0);
        await expect(panel.locator('.region-overlay .cut-ghost:visible')).toHaveCount(0);
        // The cancelled drag left no undo step: ⌘Z undoes the cut itself.
        await undo(page);
        await expect.poll(() => segsOf(page, id, Q)).toBe('');
    });

    test('a handle resizes on the whole-Q grid, a chip slides freely; one undo step each', async ({ page }) => {
        const { Q, id } = await cutTake(page);
        const panel = panelOf(page, id);
        const calls = recordMapCalls(page);
        // RESIZE the start edge left: [5, 6) → [3, 6).
        const start = await centreOf(panel.locator('.region-overlay > .cut-handle.start'));
        await dragTo(page, start, await stripX(page, id, 3.2), { steps: 6 });
        await expect.poll(() => segsOf(page, id, Q)).toBe('0,3,6,12');
        await expect.poll(() => panelBandQ(page, id)).toEqual([3, 6]);
        // SLIDE by the chip, +1.5Q (free, length held): [4.5, 7.5).
        const chip = await centreOf(panel.locator('.region-overlay > .cut-chip'));
        await dragBy(page, { x: chip.x, y: start.y }, 1.5 * await stripPxPerQ(page, id),
            { steps: 6 });
        await expect.poll(() => roundedSegs(page, id, Q)).toBe('0,4.5,7.5,12');
        await consoleDrained(page);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(c => c === 'setSegments')).toBe(true);
        // Two gestures, two undo steps.
        await undo(page);
        await expect.poll(() => segsOf(page, id, Q)).toBe('0,3,6,12');
        await undo(page);
        await expect.poll(() => segsOf(page, id, Q)).toBe('0,5,6,12');
    });
});
