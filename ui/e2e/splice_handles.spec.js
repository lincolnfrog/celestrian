/**
 * THE SPLICE AND THE TOP on the lane, and the START MARKER in the panel
 * (loop_selection.md §9, P2.3–P2.6, built 2026-09-24; prototype v10;
 * session_view/splice_handles.js, region_panel.js).
 *
 * Two effects, two handles: a SPLICE drag SWAPS what plays (the region
 * moves, the origin is kept — only the swept strip changes, and the ↺
 * stays unless the region drops its spot); the ↺ drag SHIFTS when it
 * plays (the origin moves, the audio and the splices ride along). ⇧ on
 * a splice is the LENGTH there, through the same-scale reveal. The
 * panel's ↺ is Ableton's start marker: the top moves onto another hit
 * and the audio shifts so the ↺ keeps its moment. A PLAIN loop (no map)
 * wears the ↺ alone — nothing to swap, but its timing to shift — and
 * the panel's marker walks its whole take. REAL mouse input throughout
 * (synthetic dispatch bypasses hit-testing — the 2026-07-23c law);
 * every drag grabs a handle by its tab, the way a hand does.
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, node, loopOf, segsOf, recordDefinerAndTake, setLoop,
         laneOf, stripOf, viewOf, stripX, selectLane }
    from './region_panel_helpers.js';

/** A heard lane's visible splice handles and ↺: kind, ghostliness,
 * inertness, lane position (Q, the line's centre), the tab's opacity
 * and text. */
const handles = (page, id) => page.evaluate(id => {
    const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
    const br = body.getBoundingClientRect();
    return [...body.querySelectorAll('.lr-layer > .lr-splice, .lr-layer > .lr-top')]
        .filter(h => h.style.display !== 'none')
        .map(h => {
            const r = h.getBoundingClientRect();
            const tab = h.querySelector('.lr-tab');
            return {
                kind: h.classList.contains('lr-top') ? 'top'
                    : h.classList.contains('lr-cut') ? 'cut' : 'wrap',
                ghost: h.classList.contains('lr-ghost'),
                inert: h.classList.contains('lr-inert'),
                x: ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ,
                tabOp: parseFloat(getComputedStyle(tab).opacity),
                text: tab.textContent,
            };
        })
        .sort((a, b) => a.x - b.x);
}, id);

/** The page point of a handle's TAB (the take tile's, unless `ghost`).
 * A splice resting on the frame's left edge shows at the right edge too
 * (.lr-end — the loop's END handle, 2026-10-01): `end` picks that one,
 * the default the one where the splice starts. */
async function tabPoint(page, id, kind, { ghost = false, end = false } = {}) {
    const cls = kind === 'top' ? '.lr-top' : kind === 'cut' ? '.lr-cut' : '.lr-wrap';
    const tab = laneOf(page, id).locator(
        `.lr-layer > ${cls}${ghost ? '.lr-ghost' : ':not(.lr-ghost)'}` +
        `${end ? '.lr-end' : ':not(.lr-end)'} .lr-tab`).first();
    const b = await tab.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The lane's px per Q. */
const lanePxPerQ = (page, id) => laneOf(page, id).locator('.lane-body')
    .evaluate(b => b.getBoundingClientRect().width / b._cycleQ);

/** Press at `at`, move by `dxPx` (with `mods` held from before the
 * press), and release unless `hold`. */
async function drag(page, at, dxPx, { steps = 10, hold = false, mods = [] } = {}) {
    await page.mouse.move(at.x, at.y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down();
    await page.mouse.move(at.x + dxPx, at.y, { steps });
    if (hold) return;
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
}

/** The take tile's envelope: per backing column, the filled height
 * above the centre line (heard_tiles.spec.js's probe). */
const tileProfile = (page, id) => page.evaluate(id => {
    const rep = document.querySelector(
        `.lane[data-id="${id}"] .reps-layer .rep:not(.ghost)`);
    const cv = rep && rep.querySelector('canvas');
    if (!cv || !cv.width) return null;
    const { width: W, height: H } = cv;
    const px = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const mid = Math.floor(H / 2);
    const out = [];
    for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < mid && px[(y * W + x) * 4 + 3] < 128) y++;
        out.push(mid - y);
    }
    return out;
}, id);

/** The columns (as fractions of the tile) whose envelope changed. */
function changedCols(a, b, tolPx = 1) {
    const out = [];
    for (let x = 0; x < a.length; x++) if (Math.abs(a[x] - b[x]) > tolPx) out.push(x / a.length);
    return out;
}

const near = (a, b, tol = 0.03) => Math.abs(a - b) < tol;
const of = (hs, kind) => hs.filter(h => h.kind === kind);

/** The owner's topology: a 1Q definer, a 12Q take from 1Q looped to
 * [6Q, 10Q) — a 4Q loop filling a 4Q frame, its region start (and ↺)
 * at the frame's left edge — and that lane selected. It is the first
 * loop longer than Q, so it PLACES THE FRAME (frame.md §1, owner
 * 2026-09-29): the frame's left edge is its ↺. A drag pins the frame
 * while the hand is down; released, an edit that moved the ↺'s moment
 * re-seats the frame AT ONCE — there is no edit hold. (A loop that
 * slots into the frame instead: slotted_loop.spec.js.) */
async function setup(page, opts = {}) {
    await boot(page, opts);
    const Q = await quantum(page);
    const { id1, id2 } = await recordDefinerAndTake(page, Q, 12);
    await setLoop(page, id2, 6 * Q, 10 * Q);
    await selectLane(page, id2);
    await expect.poll(async () => of(await handles(page, id2), 'top').length).toBe(1);
    return { Q, id1, id2 };
}

test.describe('The splice (swap)', () => {
    test('a splice drag swaps only the swept strip; the ↺ stays — until the region drops it', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        /** The take tile's splice and ↺ (lane Q). */
        const marks = async () => {
            const hs = await handles(page, id2);
            return [of(hs, 'wrap')[0].x, of(hs, 'top')[0].x].map(v => +v.toFixed(2));
        };
        // Store a top 1Q into the loop (raw 7Q): the ↺ comes apart from
        // the splice. This loop places the frame, so the frame seats on
        // the ↺ — the left edge — and the splice shows 1Q before it
        // (−1 ≡ 3 of the 4Q frame).
        await page.evaluate(({ id, Q }) =>
            window.__celestrianTest.callNative('setTiming', id, 0, 7 * Q), { id: id2, Q });
        await expect.poll(marks).toEqual([3, 0]);
        await page.waitForTimeout(200);  // settle any first-draw swap
        const before = await tileProfile(page, id2);
        const pxq = await lanePxPerQ(page, id2);

        // DRAG THE SPLICE +1.3Q (whole-Q relative → +1Q): held mid-drag,
        // the lane already shows the swap (the local preview), the badge
        // names it, and the swept strip is tinted.
        await drag(page, await tabPoint(page, id2, 'wrap'), 1.3 * pxq, { hold: true });
        await expect(laneOf(page, id2).locator('.lr-badge')).toHaveText(/swap · splice \+1Q/);
        await expect(laneOf(page, id2).locator('.lr-tint')).toHaveCount(1);
        await expect(laneOf(page, id2).locator('.lr-snap')).toHaveCount(1);
        await expect.poll(async () => changedCols(before, await tileProfile(page, id2)).length)
            .toBeGreaterThan(0);
        const mid = await tileProfile(page, id2);
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        await expect(laneOf(page, id2).locator('.lr-badge')).toHaveCount(0);
        await expect(laneOf(page, id2).locator('.lr-tint')).toHaveCount(0);
        await page.waitForTimeout(200);
        const after = await tileProfile(page, id2);
        // What the hand saw is what landed; ONLY the swept strip — the
        // last Q of the 4Q tile, [3Q, 4Q), where the splice was — changed
        // (a few px of smoothing either side, the wrap included).
        expect(changedCols(mid, after)).toEqual([]);
        const changed = changedCols(before, after);
        expect(changed.length).toBeGreaterThan(0);
        const slack = 10 / before.length;
        for (const f of changed) {
            expect(f >= 0.75 - slack || f <= slack, `column ${f.toFixed(3)}`).toBe(true);
        }
        // The swap kept the origin and the top: the splice moved onto
        // the ↺ (the left edge), the ↺ did not move — and neither did
        // the frame, whose zero is the ↺'s moment.
        let n = await node(page, id2);
        expect(n.loopTop / Q).toBe(7);
        expect(n.retime).toBe(0);
        expect(n.origin / Q).toBe(1);
        await expect.poll(marks).toEqual([0, 0]);

        // ANOTHER +1Q: [8, 12) no longer plays raw 7 — the top resets
        // to the region start, back on the splice. Under the hand the
        // frame is pinned, so the preview shows the ↺ where the engine
        // will store it: 1Q in, beside the splice's landing …
        await drag(page, await tabPoint(page, id2, 'wrap'), 1.2 * pxq, { hold: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,12');   // a live commit
        await expect.poll(async () =>
            +of(await handles(page, id2), 'top')[0].x.toFixed(2)).toBe(1);
        await page.mouse.up();
        n = await node(page, id2);
        expect(n.loopTop / Q).toBe(8);
        // … and released, the frame seats on the new ↺ at once: both at
        // the left edge (no edit hold — frame.md §1).
        await expect.poll(marks).toEqual([0, 0]);
        await page.waitForTimeout(300);
        expect(await marks()).toEqual([0, 0]);
        // One undo step per drag.
        await page.evaluate(() => window.__celestrianTest.callNative('undo'));
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect((await node(page, id2)).loopTop / Q).toBe(7);
    });

    test('a swap to the left leaves a fresh loop\'s ↺ where it was — the splice comes apart; a reset stays put when the region slides back', async ({ page }) => {
        // THE RECONCILE STORES THE TOP (loop_selection.md §9.3, P2): the
        // ↺ stays wherever the region still plays it, even where it
        // began on the region start — a top left unset would ride the
        // start (the rejected v5).
        const { Q, id2 } = await setup(page);
        const at = async kind => {
            const hs = of(await handles(page, id2), kind).filter(h => !h.ghost);
            return hs.length ? +hs[0].x.toFixed(2) : null;
        };
        expect([await at('wrap'), await at('top')]).toEqual([0, 0]);
        const pxq = await lanePxPerQ(page, id2);
        // −1.2Q of hand (whole Q → −1Q): [5, 9) still plays raw 6, so
        // the ↺ holds — mid-drag (the preview predicts the stored top)
        // and after — and only the splice moves, to −1Q ≡ 3Q of the 4Q
        // frame (mid-drag the grabbed splice rides the hand).
        await drag(page, await tabPoint(page, id2, 'wrap'), -1.2 * pxq, { hold: true });
        await expect(laneOf(page, id2).locator('.lr-badge')).toHaveText(/swap · splice −1Q/);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');   // a live commit
        await page.waitForTimeout(150);
        expect(await at('top')).toBe(0);
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        expect((await node(page, id2)).loopTop / Q).toBe(6);
        await page.waitForTimeout(200);
        expect([await at('wrap'), await at('top')]).toEqual([3, 0]);
        // The owner's bars 1–4 → 3–6 → 2–5, as nudges: back to [6, 10);
        // [7, 11) drops raw 6 and [8, 12) raw 7 — the ↺ resets onto the
        // region start each time, landing on raw 8 — then one back to
        // [7, 11): raw 8 still plays, so the ↺ STAYS on it (the engine's
        // stored top) and only the splice moves.
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,12');
        expect((await node(page, id2)).loopTop / Q).toBe(8);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect((await node(page, id2)).loopTop / Q).toBe(8);
        // The nudge chain is one pinned gesture (makeChainPin); once it
        // lets the frame go, the frame seats on the ↺ — raw 8 at the
        // left edge — and the splice (raw 7) reads 1Q before it: 3Q.
        await expect.poll(async () => [await at('wrap'), await at('top')]).toEqual([3, 0]);
    });

    test('Escape mid-drag puts back what the live commits changed — the swap and the shift', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        await page.waitForTimeout(200);
        const before = await tileProfile(page, id2);
        const pxq = await lanePxPerQ(page, id2);
        // A swap held long enough for its live commits to land, then
        // cancelled: the region is back and so is the lane's picture.
        await drag(page, await tabPoint(page, id2, 'wrap'), 1.3 * pxq, { hold: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await expect(laneOf(page, id2).locator('.lr-badge')).toHaveCount(0);
        await expect.poll(async () => changedCols(before, await tileProfile(page, id2)).length)
            .toBe(0);
        // The same for a shift: the origin goes back.
        await drag(page, await tabPoint(page, id2, 'top'), 1.3 * pxq, { hold: true });
        await expect.poll(async () => (await node(page, id2)).origin / Q).toBe(2);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).origin / Q).toBe(1);
        expect((await node(page, id2)).retime).toBe(0);
        await expect.poll(async () => near(of(await handles(page, id2), 'top')[0].x, 0))
            .toBe(true);
    });

    test('a cancelled drag leaves no undo step, and the redo it interrupted still works', async ({ page }) => {
        // The cancel used to restore by one more commit: the gesture's
        // undo step stayed on the stack reading (start → start) — a ⌘Z
        // that did nothing — the redo branch its first commit had
        // invalidated was gone, and the status line said "⌘Z to undo".
        // The engine cancels the gesture instead (cancelGesture).
        const { Q, id2 } = await setup(page);
        const st = () => page.evaluate(() =>
            window.__celestrianTest.callNative('getGraphState'));
        const pxq = await lanePxPerQ(page, id2);
        // A redo branch to interrupt: a swap, undone.
        await drag(page, await tabPoint(page, id2, 'wrap'), -1.2 * pxq);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        await page.waitForTimeout(350);
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        expect((await st()).canRedo).toBe(true);
        // (The lane has re-drawn the undone loop before the next grab:
        // its splice is back on the left edge.)
        await expect.poll(async () => +of(await handles(page, id2), 'wrap')[0].x.toFixed(2))
            .toBe(0);
        // A drag, its live commits landed (redo is invalidated — for
        // now) — and Escape.
        await drag(page, await tabPoint(page, id2, 'wrap'), 1.3 * pxq, { hold: true });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        expect((await st()).canRedo).toBe(false);
        await page.keyboard.press('Escape');
        await page.mouse.up();
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await expect(page.locator('#log-line')).toHaveText('Cancelled — nothing changed');
        await page.waitForTimeout(400);   // past any queued verdict
        await expect(page.locator('#log-line')).toHaveText('Cancelled — nothing changed');
        // REDO is back, and it is the swap that was undone.
        expect((await st()).canRedo).toBe(true);
        await page.keyboard.press('ControlOrMeta+Shift+z');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,9');
        // ⌘Z twice: that swap, then the loop itself — no step in
        // between is the cancelled drag's.
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,10');
        await page.keyboard.press('ControlOrMeta+z');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('0,0');
    });

    test('a cut\'s splice slides the cut (⌥ free) and heals on double-click', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        // A 1Q cut at [5, 6), the ↺ on the region start (raw 2): the 7Q
        // loop shows from its top, the cut's splice 3Q in. (Left on raw
        // 6 — where setup's region began — the ↺ would sit ON the cut's
        // splice, at the frame's edge, and the slide below would drop it
        // and re-seat the frame.)
        await page.evaluate(async ({ id, Q }) => {
            const c = window.__celestrianTest.callNative;
            await c('setSegments', id, [2 * Q, 5 * Q, 6 * Q, 10 * Q]);
            await c('setTiming', id, 0, 2 * Q);
        }, { id: id2, Q });
        await expect.poll(async () => of(await handles(page, id2), 'cut')
            .map(h => +h.x.toFixed(2))).toEqual([3]);
        const cut = of(await handles(page, id2), 'cut')[0];
        expect(cut.text).toBe('‖ 1Q');
        const pxq = await lanePxPerQ(page, id2);
        // ⌥: free — the cut slides 0.4Q, its length held; the region
        // still plays the ↺, so the frame holds and the splice rests
        // where the hand left it.
        await drag(page, await tabPoint(page, id2, 'cut'), 0.4 * pxq, { mods: ['Alt'] });
        await expect.poll(async () => (await segsOf(page, id2, Q)).split(',')
            .map(v => (+v).toFixed(1)).join(',')).toBe('2.0,5.4,6.4,10.0');
        await expect.poll(async () => near(of(await handles(page, id2), 'cut')[0].x,
                                           cut.x + 0.4, 0.05)).toBe(true);
        await page.waitForTimeout(300);   // …and stays, past the pin
        expect(near(of(await handles(page, id2), 'cut')[0].x, cut.x + 0.4, 0.05)).toBe(true);
        // Double-click the cut's splice: healed — back to one window.
        const at = await tabPoint(page, id2, 'cut');
        await page.mouse.dblclick(at.x, at.y);
        await expect.poll(async () => ((await node(page, id2)).segments || []).length)
            .toBeLessThan(4);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('2,10');
        await expect.poll(async () => of(await handles(page, id2), 'cut').length).toBe(0);
    });
});

test.describe('A reset ↺', () => {
    /** Every animation frame for `ms`: the take tile's ↺ and splice
     * positions (Q) and whether the frame is moving onto a new seat. */
    const sampleFrames = (page, id, ms) => page.evaluate(({ id, ms }) => new Promise(done => {
        const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
        const lanes = document.getElementById('lanes');
        const out = [];
        const t0 = performance.now();
        const xOf = sel => {
            const h = body.querySelector(sel);
            if (!h) return null;
            const br = body.getBoundingClientRect();
            const r = h.getBoundingClientRect();
            return ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ;
        };
        const tick = () => {
            out.push({ top: xOf('.lr-layer > .lr-top:not(.lr-ghost)'),
                       wrap: xOf('.lr-layer > .lr-wrap:not(.lr-ghost)'),
                       moving: lanes.classList.contains('frame-tweening') });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
            else done(out);
        };
        requestAnimationFrame(tick);
    }), { id, ms });

    test('an instant edit that resets the ↺ lands it at once; the frame then moves onto it', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        // A stored top 1Q into the loop (raw 7): the frame seats on it —
        // the ↺ at the left edge, the splice 1Q before it (3Q). (The
        // splice is the one that MOVES: wait on it — the ↺ reads 0
        // before and after, and a nudge pressed before the view has
        // re-seated would pin the old frame.)
        await page.evaluate(({ id, Q }) =>
            window.__celestrianTest.callNative('setTiming', id, 0, 7 * Q), { id: id2, Q });
        await expect.poll(async () => {
            const hs = await handles(page, id2);
            return [of(hs, 'wrap')[0].x, of(hs, 'top')[0].x].map(v => v.toFixed(2));
        }).toEqual(['3.00', '0.00']);
        // A nudge keeps raw 7 ([7, 11)): the ↺ stays — and it opens the
        // nudge chain, which PINS the frame (makeChainPin). The next
        // drops it ([8, 12)): the top resets to the region start. In
        // the pinned frame the ↺ and the splice simply LAND there, 1Q
        // on — the ↺ has no glide of its own (removed 2026-10-01).
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,11');
        await page.waitForTimeout(150);
        const framesP = sampleFrames(page, id2, 500);
        await page.keyboard.press('ArrowRight');
        const pinned = await framesP;
        expect(await loopOf(page, id2, Q)).toBe('8,12');
        expect(pinned.at(-1).top).toBeCloseTo(1, 2);
        expect(pinned.at(-1).wrap).toBeCloseTo(1, 2);
        expect(pinned.filter(f => f.top > 0.05 && f.top < 0.95).length,
            'the ↺ lands at once').toBe(0);
        expect(pinned.filter(f => f.wrap > 0.05 && f.wrap < 0.95).length,
            'so does the splice').toBe(0);
        expect(pinned.some(f => f.moving), 'the pin holds the frame').toBe(false);
        // The chain over (800 ms), the pin lets go and the FRAME moves
        // onto the new ↺ — the ↺ and the splice ride it to the left
        // edge (reseat_tween.spec.js pins the move itself).
        const moved = await sampleFrames(page, id2, 900);
        expect(moved.filter(f => f.moving).length, 'frames of the move')
            .toBeGreaterThan(3);
        expect(moved.filter(f => f.top > 0.05 && f.top < 0.95).length,
            'the ↺ rides the frame').toBeGreaterThan(2);
        expect(moved.at(-1).moving).toBe(false);
        await expect.poll(async () => {
            const hs = (await handles(page, id2)).filter(h => !h.ghost);
            return [of(hs, 'wrap')[0].x, of(hs, 'top')[0].x].map(v => +v.toFixed(2));
        }).toEqual([0, 0]);
    });
});

test.describe('The top (shift)', () => {
    test('the ↺ drag re-times: whole Q moves the origin, the readout follows, ⌥ is fine', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const lane = laneOf(page, id2);
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: as played');
        await expect(lane.locator('.region-timing-reset')).toBeDisabled();
        await page.waitForTimeout(200);
        const before = await tileProfile(page, id2);
        const pxq = await lanePxPerQ(page, id2);
        // +1.3Q → +1Q: held, the waveform already moved with the hand.
        await drag(page, await tabPoint(page, id2, 'top'), 1.3 * pxq, { hold: true });
        await expect(lane.locator('.lr-badge'))
            .toHaveText('shift +1Q · timing: shifted +1Q');
        await expect.poll(async () => changedCols(before, await tileProfile(page, id2)).length)
            .toBeGreaterThan(before.length / 4);
        // Under the hand (the frame pinned) the splice moves with the
        // audio: 1Q in.
        await expect.poll(async () =>
            +of(await handles(page, id2), 'wrap')[0].x.toFixed(2)).toBe(1);
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).origin / Q).toBe(2);
        let n = await node(page, id2);
        expect(n.retime / Q).toBe(1);
        expect(await loopOf(page, id2, Q)).toBe('6,10');   // the region is untouched
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: shifted +1Q');
        await expect(lane.locator('.region-timing-reset')).toBeEnabled();
        // The ↺ and the splice moved together, with the audio — and this
        // loop places the frame, so released, the frame seats on its ↺
        // again: both back at the left edge (the shift shows against
        // the OTHER lanes).
        const marks = async () => {
            const hs = await handles(page, id2);
            return [of(hs, 'top')[0].x, of(hs, 'wrap')[0].x];
        };
        await expect.poll(async () => (await marks()).map(v => +v.toFixed(2))).toEqual([0, 0]);

        // ⌥ = fine: a few px left pulls the take early by that much.
        const dx = -12;
        await drag(page, await tabPoint(page, id2, 'top'), dx, { mods: ['Alt'], steps: 6 });
        await expect.poll(async () => (await node(page, id2)).retime / Q)
            .toBeLessThan(1);
        n = await node(page, id2);
        const fine = n.retime / Q - 1;
        expect(Math.abs(fine - dx / pxq)).toBeLessThan(0.01);
        expect(Number.isInteger(n.retime / Q)).toBe(false);
        await expect(lane.locator('.region-timing-read'))
            .toHaveText(/^timing: shifted \+0\.9\d+Q \(\d+ ms later\)$/);
        // A top a little EARLY of its bar line is a pickup (¼Q, frame.md
        // §1): the frame stays on that line and the ↺ reads just before
        // the frame's end.
        await expect.poll(async () => near((await marks())[0], 4 + fine, 0.01)).toBe(true);
    });

    test('"Timing as played" puts the take back where it was played', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setTiming', id, Math.round(-0.04 * Q)), { id: id2, Q });
        const lane = laneOf(page, id2);
        await expect(lane.locator('.region-timing-read'))
            .toHaveText('timing: shifted −0.04Q (40 ms earlier)');
        const reset = lane.locator('.region-timing-reset');
        await expect(reset).toBeEnabled();
        await reset.click();
        await expect.poll(async () => (await node(page, id2)).retime).toBe(0);
        expect((await node(page, id2)).origin / Q).toBe(1);
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: as played');
        await expect(reset).toBeDisabled();
    });
});

test.describe('⇧ on a splice (length)', () => {
    test('at the wrap: the loop end rides the hand through the reveal, whole Q', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const body = laneOf(page, id2).locator('.lane-body');
        const pxq = await lanePxPerQ(page, id2);
        const at = await tabPoint(page, id2, 'wrap');
        await drag(page, at, 1.2 * pxq, { mods: ['Shift'], hold: true });
        await expect(body).toHaveClass(/revealing/);         // the raw take unrolled
        await expect(body).not.toHaveClass(/inspecting/);    // …at the lane's scale
        // The loop's END bracket rides the pointer; the handles stepped
        // aside (opacity only — the grabbed one keeps its capture).
        await expect.poll(async () => {
            const fb = await body.locator('.drag-preview-layer .win-bracket.dragging')
                .boundingBox();
            return fb ? Math.abs((fb.x + fb.width) - (at.x + 1.2 * pxq)) < 14 : false;
        }).toBe(true);
        expect(await body.locator('.lr-layer').evaluate(l =>
            getComputedStyle(l).opacity)).toBe('0');
        await expect(body.locator('.drag-preview-layer .cut-chip'))
            .toHaveText(/loop 5Q \(\+1\)/);
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,11');
        await expect(body).not.toHaveClass(/revealing/);
        await expect(laneOf(page, id2).locator('.win-heard-chip')).toHaveText(/5Q/);
    });

    test('the loop\'s END handle — the splice at the frame\'s right edge — shortens by dragging inward, and never runs away', async ({ page }) => {
        // BOTH EDGES (2026-10-01): a wrap resting on the frame's left
        // edge shows at the right edge too. ⇧ moves the end of the
        // material BEFORE a splice, so with the left-edge handle alone a
        // shorter loop meant dragging off the lane, where the reveal's
        // edge pan ran the length away (1.2Q of hand took 3Q) — the
        // owner's 2026-08-18 "the right handle is gone".
        const { Q, id2 } = await setup(page);
        const body = laneOf(page, id2).locator('.lane-body');
        const pxq = await lanePxPerQ(page, id2);
        // This loop fills the frame: both ends are the take's, tabbed.
        expect(of(await handles(page, id2), 'wrap').map(h => [+h.x.toFixed(2), h.ghost]))
            .toEqual([[0, false], [4, false]]);
        await expect(body.locator('.lr-layer > .lr-wrap.lr-end')).toHaveCount(1);
        const at = await tabPoint(page, id2, 'wrap', { end: true });
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
        await drag(page, at, -1.2 * pxq, { mods: ['Shift'], hold: true });
        await expect(body).toHaveClass(/revealing/);
        const chip = body.locator('.drag-preview-layer .cut-chip');
        await expect(chip).toHaveText(/loop 3Q \(−1\)/);
        // … and STAYS there under a still hand (inside the lane, clear
        // of the edge pan).
        await page.waitForTimeout(600);
        await expect(chip).toHaveText(/loop 3Q \(−1\)/);
        await page.mouse.up();
        await page.keyboard.up('Shift');
        await expect.poll(() => loopOf(page, id2, Q)).toBe('6,9');
        await expect(body).not.toHaveClass(/revealing/);
        // The 3Q loop fills its 3Q frame: a handle at each end again.
        await expect.poll(async () => of(await handles(page, id2), 'wrap')
            .map(h => +h.x.toFixed(2))).toEqual([0, 3]);
        // A PLAIN drag of the end handle is the same swap as any splice's:
        // 1Q inward — [5, 8) still plays the ↺ (raw 6), so the frame holds
        // and the splice rests 1Q before the frame's end.
        await drag(page, await tabPoint(page, id2, 'wrap', { end: true }), -1.2 * pxq);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('5,8');
        expect((await node(page, id2)).loopTop / Q).toBe(6);
        await expect.poll(async () => {
            const hs = await handles(page, id2);
            return [of(hs, 'wrap').map(h => +h.x.toFixed(2)), +of(hs, 'top')[0].x.toFixed(2)];
        }).toEqual([[2], 0]);
    });

    test('at a cut: more material before it shrinks the cut — to nothing heals it', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setSegments', id, [2 * Q, 5 * Q, 7 * Q, 10 * Q]), { id: id2, Q });
        await expect.poll(async () => of(await handles(page, id2), 'cut').length).toBe(1);
        expect(of(await handles(page, id2), 'cut')[0].text).toBe('‖ 2Q');
        const pxq = await lanePxPerQ(page, id2);
        await drag(page, await tabPoint(page, id2, 'cut'), 1.2 * pxq, { mods: ['Shift'] });
        await expect.poll(() => segsOf(page, id2, Q)).toBe('2,6,7,10');
        await expect.poll(async () => of(await handles(page, id2), 'cut')
            .map(h => h.text).join()).toBe('‖ 1Q');
        // The loop is 7Q now: wait for the frame to settle on it before
        // reading the handle's place (the drag's pin outlives the release
        // until the commit settles — a point read under the pinned 6Q
        // frame is off the handle once the lane re-lays out).
        await expect.poll(() => laneOf(page, id2).locator('.lane-body')
            .evaluate(b => b._cycleQ)).toBe(7);
        // Once more: the cut closes — healed, one window.
        await drag(page, await tabPoint(page, id2, 'cut'),
                   1.1 * await lanePxPerQ(page, id2), { mods: ['Shift'] });
        await expect.poll(() => loopOf(page, id2, Q)).toBe('2,10');
        await expect.poll(async () => of(await handles(page, id2), 'cut').length).toBe(0);
    });
});

test.describe('The panel\'s ↺ (the start marker)', () => {
    test('dragging the ↺ onto another hit re-times the take so the ↺ keeps its moment', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        const lane = laneOf(page, id2);
        const tab = lane.locator('.region-top-tab');
        await expect(tab).toBeVisible();
        const tb = await tab.boundingBox();
        expect(Math.abs(tb.x + tb.width / 2 - await stripX(page, id2, 6))).toBeLessThan(26);
        const v = await viewOf(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        const pxq = s.width / v.spanQ;
        // The overview ticks the ↺ too.
        await expect(lane.locator('.region-ov-top')).toBeVisible();
        // Onto raw 7Q (+1.3Q of hand → +1Q): the ↺ keeps its moment,
        // so the take moves 1Q EARLIER under it.
        await drag(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 },
                   1.3 * pxq, { hold: true });
        await expect(lane.locator('.region-badge')).toHaveText('↺ on 7Q · shift −1Q');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).loopTop / Q).toBe(7);
        const n = await node(page, id2);
        expect(n.retime / Q).toBe(-1);
        expect(n.origin / Q).toBe(0);
        expect(await loopOf(page, id2, Q)).toBe('6,10');
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: shifted −1Q');
        // On the lane: the ↺ held its place, the splice moved with the
        // audio (a whole Q earlier: 0 → −1 ≡ 3 of the 4Q frame).
        const hs = await handles(page, id2);
        expect(near(of(hs, 'top')[0].x, 0)).toBe(true);
        expect(near(of(hs, 'wrap')[0].x, 3)).toBe(true);
        // The panel's mark sits on the new top.
        await expect.poll(async () => {
            const b = await lane.locator('.region-top-tab').boundingBox();
            return b ? Math.abs(b.x + b.width / 2 - await stripX(page, id2, 7)) < 26 : false;
        }).toBe(true);
        // The ↺'s line never steals a box slide: a press on the line
        // below the tab grabs the kept box (once the held commit has
        // let go — .drag-held keeps the stale chrome press-proof).
        await expect(lane.locator('.region-overlay')).not.toHaveClass(/drag-held/);
        const line = await lane.locator('.region-top').boundingBox();
        expect(await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return hit && hit.className;
        }, { x: line.x + line.width / 2, y: line.y + line.height * 0.75 }))
            .toMatch(/region-kept/);
    });
});

test.describe('A plain loop\'s ↺ (no map: the shift alone)', () => {
    /** A 1Q definer, then a 4Q take from 1Q left PLAIN — no loop region,
     * the whole take loops ("my drum loop is 40 ms late") — selected. The
     * 4Q frame's zero seats on the take's top: its ↺ at the left edge. */
    async function plainSetup(page) {
        await boot(page);
        const Q = await quantum(page);
        const { id1, id2 } = await recordDefinerAndTake(page, Q, 4);
        await selectLane(page, id2);
        await expect.poll(async () => of(await handles(page, id2), 'top').length).toBe(1);
        return { Q, id1, id2 };
    }
    /** The lane's ↺s: [x (Q), whether it wears its tab]. */
    const topsAt = async (page, id) =>
        of(await handles(page, id), 'top').map(h => [+h.x.toFixed(2), !h.ghost]);

    test('it wears the ↺ and no splice; one Q right re-times it by 1Q; "Timing as played" puts it back', async ({ page }) => {
        const { Q, id2 } = await plainSetup(page);
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        const n0 = await node(page, id2);
        expect(n0.windowActive).toBe(false);
        expect(n0.origin / Q).toBe(1);
        const loop0 = await loopOf(page, id2, Q);
        // The ↺ alone, on the take tile's start: nothing to swap.
        const hs = await handles(page, id2);
        expect(hs.map(h => [h.kind, h.ghost, h.inert, h.text]))
            .toEqual([['top', false, false, '↺ top']]);
        expect(near(hs[0].x, 0)).toBe(true);
        await expect(body.locator('.lr-splice')).toHaveCount(0);
        // Only its TAB grabs: its line sits on the latent start bracket
        // (drag an edge in to make a region), which keeps its press —
        // in the lane's upper half too, just under the tab.
        const bb = await body.boundingBox();
        expect(await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return [!!hit.closest('.lr-top'), !!hit.closest('.win-bracket.start')];
        }, { x: bb.x + 3, y: bb.y + bb.height * 0.45 })).toEqual([false, true]);
        // The panel reads its timing.
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: as played');
        await expect(lane.locator('.region-timing-reset')).toBeDisabled();

        // +1.3Q of hand → +1Q: held, the badge names the shift.
        const pxq = await lanePxPerQ(page, id2);
        await drag(page, await tabPoint(page, id2, 'top'), 1.3 * pxq, { hold: true });
        await expect(lane.locator('.lr-badge'))
            .toHaveText('shift +1Q · timing: shifted +1Q');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).origin / Q).toBe(2);
        const n1 = await node(page, id2);
        expect(n1.retime / Q).toBe(1);
        // A shift, never a swap: still no map, the top unmoved on the take.
        expect(n1.windowActive).toBe(false);
        expect(await loopOf(page, id2, Q)).toBe(loop0);
        expect(n1.loopTop).toBe(0);
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: shifted +1Q');
        await expect(lane.locator('.region-timing-reset')).toBeEnabled();
        // The ↺ moved with the audio — and this loop places the frame,
        // so released, the frame seats on it again: the ↺ at the left
        // edge, its tab with it; still no splice.
        await expect.poll(() => topsAt(page, id2)).toEqual([[0, true]]);
        await page.waitForTimeout(300);
        expect(await topsAt(page, id2)).toEqual([[0, true]]);
        await expect(body.locator('.lr-splice')).toHaveCount(0);

        // "Timing as played": the origin goes back, the ↺ with it.
        await lane.locator('.region-timing-reset').click();
        await expect.poll(async () => (await node(page, id2)).origin / Q).toBe(1);
        expect((await node(page, id2)).retime).toBe(0);
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: as played');
        await expect(lane.locator('.region-timing-reset')).toBeDisabled();
        await expect.poll(() => topsAt(page, id2)).toEqual([[0, true]]);
    });

    test('the panel\'s start marker walks the whole take: the top moves, the ↺ keeps its moment', async ({ page }) => {
        const { Q, id2 } = await plainSetup(page);
        const lane = laneOf(page, id2);
        await expect(lane.locator('.region-label')).toHaveText(/whole take · 4Q take/);
        // The ↺ at raw 0 (the take's own start), ticked on the overview.
        const mark = lane.locator('.region-top');
        await expect(lane.locator('.region-top-tab')).toBeVisible();
        await expect(lane.locator('.region-ov-top')).toBeVisible();
        const mb = await mark.boundingBox();
        expect(Math.abs(mb.x + mb.width / 2 - await stripX(page, id2, 0))).toBeLessThan(2);
        const tb = await lane.locator('.region-top-tab').boundingBox();
        const v = await viewOf(page, id2);
        const s = await stripOf(page, id2).boundingBox();
        // Onto raw 1Q (+1.3Q of hand → +1Q): the ↺ keeps its moment, so
        // the take moves 1Q EARLIER under it — the shift heardOffset(T0) −
        // heardOffset(T′), on the whole take simply T0 − T′.
        await drag(page, { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 },
                   1.3 * s.width / v.spanQ, { hold: true });
        await expect(lane.locator('.region-badge')).toHaveText('↺ on 1Q · shift −1Q');
        await page.mouse.up();
        await expect.poll(async () => (await node(page, id2)).loopTop / Q).toBe(1);
        const n = await node(page, id2);
        expect(n.retime / Q).toBe(-1);
        expect(n.origin / Q).toBe(0);
        expect(n.windowActive).toBe(false);   // still a plain loop
        await expect(lane.locator('.region-timing-read')).toHaveText('timing: shifted −1Q');
        // On the lane the ↺ held its place (its moment) — and its tab: raw
        // 0 now sounds 1Q before the left edge, so the take tile is the
        // clipped [3, 4) and the ↺ sits in the take's pass wrapped to the
        // frame's start, never a tabless ghost. In the panel the mark
        // sits on the new top.
        await expect.poll(async () => of(await handles(page, id2), 'top')
            .map(h => [+h.x.toFixed(2), h.ghost, h.tabOp])).toEqual([[0, false, 1]]);
        await expect.poll(async () => {
            const b = await mark.boundingBox();
            return b ? Math.abs(b.x + b.width / 2 - await stripX(page, id2, 1)) < 2 : false;
        }).toBe(true);
    });

    test('under the recording gate each plain loop\'s ↺ draws inert — the 1Q one\'s too', async ({ page }) => {
        const { Q, id1, id2 } = await plainSetup(page);
        // ARM a new track, the transport paused: it stays pending — the
        // gate holds every loop edit.
        const id3 = await page.evaluate(async () => {
            const t = window.__celestrianTest;
            t.pauseTransport();
            const id = await t.callNative('createNode', 'clip', '');
            await t.callNative('startRecordingInNode', id);
            return id;
        });
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        const takeTops = async id => of(await handles(page, id), 'top')
            .filter(h => !h.ghost).map(h => h.inert);
        for (const id of [id1, id2]) {
            await expect.poll(() => takeTops(id)).toEqual([true]);
            await expect(laneOf(page, id).locator('.lr-layer > .lr-top:not(.lr-ghost)'))
                .toHaveAttribute('title', /wait until the take finishes/i);
        }
        // A press on the inert tab does nothing.
        await drag(page, await tabPoint(page, id2, 'top'), 80, { steps: 6 });
        await expect(laneOf(page, id2).locator('.lr-badge')).toHaveCount(0);
        expect((await node(page, id2)).origin / Q).toBe(1);
        // The arm cancelled: the gate lifts, the ↺s are live again.
        await page.evaluate(id => window.__celestrianTest.callNative(
            'stopRecordingInNode', id), id3);
        await expect(page.locator('#lanes')).not.toHaveClass(/map-locked/);
        for (const id of [id1, id2]) await expect.poll(() => takeTops(id)).toEqual([false]);
    });
});

test.describe('Ghosts and what remains', () => {
    test('on a short loop only the take tile\'s handles wear tabs; ghosts are quiet, and still grab', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        // A 4Q partner makes the frame 4Q; the 12Q take loops 2Q in it.
        const id3 = await page.evaluate(async Q => {
            const c = window.__celestrianTest.callNative;
            const adv = window.__celestrianTest.advanceBy;
            const id = await c('createNode', 'clip', '');
            await c('startRecordingInNode', id);
            for (let i = 0; i < 64; i++) {
                const n = (await c('getGraphState')).nodes.find(x => x.id === id);
                if (n.isRecording && !n.isPendingStart) break;
                adv(Math.round(Q / 16));
            }
            adv(4 * Q - Math.round(Q / 32));
            await c('stopRecordingInNode', id);
            adv(Math.round(Q / 8));
            return id;
        }, Q);
        await expect.poll(async () => (await node(page, id3)).duration).toBe(4 * Q);
        await setLoop(page, id2, 6 * Q, 8 * Q);
        await selectLane(page, id2);
        await expect.poll(async () => (await handles(page, id2)).length).toBe(5);
        const hs = await handles(page, id2);
        // Two repeats of the 2Q loop: one splice and one ↺ each; the take
        // tile's wear their tabs, the ghost repeat's are faint lines —
        // and so is the splice at the frame's right edge (the wrap rests
        // on the left edge, so it shows at both: there it ends the ghost
        // repeat).
        expect(of(hs, 'wrap').map(h => [+h.x.toFixed(2), h.ghost]))
            .toEqual([[0, false], [2, true], [4, true]]);
        expect(of(hs, 'top').map(h => h.ghost)).toEqual([false, true]);
        for (const h of hs) expect(h.tabOp).toBe(h.ghost ? 0 : 1);
        // Hover a ghost: its tab shows.
        const ghost = laneOf(page, id2).locator('.lr-layer > .lr-wrap.lr-ghost:not(.lr-end)');
        const gb = await ghost.boundingBox();
        await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height * 0.7);
        await expect.poll(() => ghost.locator('.lr-tab').evaluate(t =>
            parseFloat(getComputedStyle(t).opacity))).toBe(1);
        // …and it grabs: a ghost repeat's splice swaps like the take's.
        const pxq = await lanePxPerQ(page, id2);
        await drag(page, { x: gb.x + gb.width / 2, y: gb.y + gb.height * 0.7 }, 1.2 * pxq);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('7,9');
        // The teleport walk visits the take tile's handles, never a
        // ghost's (recorded as the walk lands).
        await page.evaluate(() => {
            window.__landed = [];
            new MutationObserver(ms => ms.forEach(m => {
                const t = m.target;
                if (t.classList && t.classList.contains('teleport-flash')) {
                    window.__landed.push(t.classList.contains('lr-ghost'));
                }
            })).observe(document.body, { subtree: true, attributes: true,
                                         attributeFilter: ['class'] });
        });
        for (let i = 0; i < 4; i++) await page.keyboard.press(']');
        await page.keyboard.press('{');
        const landed = await page.evaluate(() => window.__landed);
        expect(landed.length).toBeGreaterThan(0);
        expect(landed).not.toContain(true);
    });

    test('no paired grips, no loop-top chip: an off-grid loop shows its ↺ and splice', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        // [6.4, 9.4): the loop's top rests 0.4Q into the held frame.
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setSegments', id, [Math.round(6.4 * Q), Math.round(9.4 * Q)]), { id: id2, Q });
        await expect(laneOf(page, id2).locator('.win-heard-chip')).toHaveText(/3Q/);
        const body = laneOf(page, id2).locator('.lane-body');
        await expect(body.locator('.trim-grip')).toHaveCount(0);
        await expect(body.locator('.loop-top-chip')).toHaveCount(0);
        await expect(body.locator('.win-bracket')).toHaveCount(0);
        await expect(body.locator('.seam-handle')).toHaveCount(0);
        await expect.poll(async () => {
            const hs = await handles(page, id2);
            return hs.filter(h => !h.ghost).map(h => h.kind + '@' + h.x.toFixed(1)).sort();
        }).toEqual(['top@0.4', 'wrap@0.4']);
        // The ↺ keeps clear of the heard chip in the top-right, even
        // re-timed under it (−0.5Q: the ↺ at 2.9Q of the 3Q frame).
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setTiming', id, Math.round(-0.5 * Q)), { id: id2, Q });
        await expect.poll(async () => of(await handles(page, id2), 'top')[0].x.toFixed(1))
            .toBe('2.9');
        const chip = await laneOf(page, id2).locator('.win-heard-chip').boundingBox();
        const tb = await body.locator('.lr-top:not(.lr-ghost) .lr-tab').boundingBox();
        const overlap = tb.x < chip.x + chip.width && tb.x + tb.width > chip.x &&
            tb.y < chip.y + chip.height && tb.y + tb.height > chip.y;
        expect(overlap, JSON.stringify({ tb, chip })).toBe(false);
        expect(tb.x + tb.width).toBeGreaterThan(chip.x);   // it is under the chip's span
        // …and the chip keeps its click (the bypass toggle) over the ↺'s
        // line; the ↺ still grabs by its tab.
        const line = await body.locator('.lr-top:not(.lr-ghost)').boundingBox();
        const lx = line.x + line.width / 2;
        expect(lx).toBeGreaterThan(chip.x);
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y).className,
            { x: lx, y: chip.y + chip.height / 2 })).toMatch(/win-heard-chip/);
        expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y).closest('.lr-top'),
            { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 })).toBe(true);
    });
});
