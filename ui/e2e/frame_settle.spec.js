/**
 * THE EDIT HOLD AND THE SETTLE, in the running app (docs/frame.md §1;
 * session_view.md law 17; app.js deriveFrame / renderNow,
 * session_view/frame_hold.js).
 *
 * The unit tests pin the rule (frame_hold.test.mjs); this pins the
 * plumbing: the poll feeds the hold, a selected lane's edits leave the
 * picture still, and a deselect glides the frame onto the seat by rAF
 * re-derives from the last poll — the one playhead riding the glide —
 * landing exactly, with the tiles' own morph off while it runs; under
 * prefers-reduced-motion it jumps.
 *
 * The observable is the playhead: drawn at (clock − zero) mod the loop,
 * it moves — with the mock clock standing still, as in all but the
 * playing case — if and only if the frame's zero does. A gesture's
 * pending preview rides the same re-derive (requestRender).
 */

import { test, expect } from '@playwright/test';

test.describe('The edit hold and the settle', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
    });

    /** A 1Q definer, then a 10Q take from 1Q (so the frame seats on
     * 1Q); the definer is selected by default. Returns { Q, id2 }. */
    async function setup(page) {
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        const Q = await page.evaluate(async () =>
            (await window.__celestrianTest.callNative('getGraphState')).perf.sampleRate);
        const id2 = await page.evaluate(async Q => {
            const c = window.__celestrianTest.callNative;
            const adv = window.__celestrianTest.advanceBy;
            const id1 = await c('createNode', 'clip', '');
            await c('startRecordingInNode', id1);
            adv(Q);
            await c('stopRecordingInNode', id1);
            const id2 = await c('createNode', 'clip', '');
            await c('startRecordingInNode', id2);
            adv(10 * Q - 10);
            await c('stopRecordingInNode', id2);
            adv(Math.round(0.3 * Q));
            window.__celestrianTest.setIsPlaying(false);
            return id2;
        }, Q);
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
        await expect(page.locator('.lane-rail.selected')).toHaveCount(1);
        await expect(page.locator('#playhead')).toBeVisible();
        return { Q, id2 };
    }

    const playheadX = page => page.locator('#playhead').evaluate(
        el => parseFloat(el.style.left));

    /** The playhead's frame-to-frame steps, unwrapped: a glide carries
     * the cursor through the frame's edge (it rides the audio). */
    const stepsOf = (xs, width) => xs.slice(1).map((x, i) => {
        const d = x - xs[i];
        return d > width / 2 ? d - width : d < -width / 2 ? d + width : d;
    });

    /** Every frame's playhead x and #lanes settling flag for `ms`. */
    const sample = (page, ms) => page.evaluate(ms => new Promise(done => {
        const out = [];
        const t0 = performance.now();
        const tick = () => {
            out.push({ x: parseFloat(document.getElementById('playhead').style.left),
                       settling: document.getElementById('lanes')
                           .classList.contains('frame-settling') });
            if (performance.now() - t0 < ms) requestAnimationFrame(tick);
            else done(out);
        };
        requestAnimationFrame(tick);
    }), ms);

    test('a selected lane\'s edit holds the picture; the deselect glides onto the seat', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        // Let the hold capture the seated frame (a poll or two).
        await page.waitForTimeout(200);
        const width = await page.locator('#ruler').evaluate(el => el.clientWidth);
        // The take windowed to [6Q, 10Q): seated alone its top (7Q)
        // would move the zero 6Q — a 4Q loop, so the playhead 2Q along.
        await page.evaluate(async ({ id, Q }) => {
            await window.__celestrianTest.callNative('setLoopPoints', id, 6 * Q, 10 * Q);
        }, { id: id2, Q });
        await expect(page.locator('.lane[data-kind="clip"]').nth(1)
            .locator('.win-chip')).toHaveText(/4Q/);
        await page.waitForTimeout(250);
        const held = await playheadX(page);
        await page.waitForTimeout(250);
        expect(await playheadX(page)).toBe(held);   // HELD: nothing moved

        // Deselect: the frame settles once, gliding.
        await page.keyboard.press('Escape');
        const frames = await sample(page, 900);
        const xs = [held, ...frames.map(f => f.x)];
        const steps = stepsOf(xs, width);
        const travelQ = (steps.reduce((a, d) => a + d, 0) / width) * 4;
        expect(Math.abs(Math.abs(travelQ) - 2)).toBeLessThan(0.05);   // 2Q
        expect(steps.filter(d => Math.abs(d) > 0.5).length)
            .toBeGreaterThan(5);                              // a glide, not a jump
        expect(Math.max(...steps.map(Math.abs))).toBeLessThan(width / 8);
        expect(frames.some(f => f.settling)).toBe(true);     // morphs off meanwhile
        expect(frames[frames.length - 1].settling).toBe(false);
        // Landed ON the seat: no further motion.
        const landed = xs[xs.length - 1];
        await page.waitForTimeout(200);
        expect(await playheadX(page)).toBe(landed);
    });

    test('the ruler and the gridlines glide with the frame, every line riding the picture', async ({ page }) => {
        // The whole picture moves as one (the prototype's drawFrameGrid /
        // drawRuler): the ruler's ticks and a lane's gridlines sit at
        // (line − zero) / Q every frame of the glide, as the cursor does
        // — with the clock still, the cursor moves exactly as the zero
        // does, so each line's offset from it (mod 1Q) never changes.
        // The labels ride their lines, named where they land: the frame
        // end's "4Q ↺" slides from 2Q to the right edge.
        const { Q, id2 } = await setup(page);
        await page.waitForTimeout(200);
        await page.evaluate(async ({ id, Q }) => {
            await window.__celestrianTest.callNative('setLoopPoints', id, 6 * Q, 10 * Q);
        }, { id: id2, Q });
        await expect(page.locator('.lane[data-kind="clip"]').nth(1)
            .locator('.win-chip')).toHaveText(/4Q/);
        await page.waitForTimeout(250);
        const grab = () => {
            const ruler = document.getElementById('ruler');
            const body = document.querySelectorAll('.lane[data-kind="clip"]')[1]
                .querySelector('.lane-body');
            const F = body._cycleQ;
            const at = el => parseFloat(el.style.left) / 100 * F;
            return {
                F,
                ph: parseFloat(document.getElementById('playhead').style.left) /
                    ruler.clientWidth * F,
                ticks: [...ruler.querySelectorAll('.tick')].map(at),
                grid: [...body.querySelectorAll('.grid-layer .gridline')].map(at),
                end: [...ruler.querySelectorAll('.tick-label.cycle-end')]
                    .map(l => ({ x: at(l), text: l.textContent })),
                settling: document.getElementById('lanes').classList.contains('frame-settling'),
            };
        };
        const held = await page.evaluate(grab);
        expect(held.F).toBe(4);
        expect(held.ticks.map(q => +q.toFixed(3))).toEqual([0, 1, 2, 3, 4]);
        expect(held.end).toEqual([{ x: 4, text: '4Q ↺' }]);
        const off = (ph, q) => ((ph - q) % 1 + 1) % 1;
        const c = off(held.ph, 0);   // the cursor's offset from the lines
        await page.keyboard.press('Escape');
        const frames = await page.evaluate(`new Promise(done => {
            const grab = ${grab.toString()};
            const out = [];
            const t0 = performance.now();
            const tick = () => {
                out.push(grab());
                if (performance.now() - t0 < 900) requestAnimationFrame(tick);
                else done(out);
            };
            requestAnimationFrame(tick);
        })`);
        const gliding = frames.filter(f => f.settling);
        expect(gliding.length).toBeGreaterThan(5);
        const dist = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));
        for (const f of gliding) {
            for (const q of [...f.ticks, ...f.grid]) {
                expect(dist(off(f.ph, q), c), JSON.stringify({ ph: f.ph, q })).toBeLessThan(0.01);
            }
        }
        // …and they MOVED: mid-glide the lines sit between whole Qs.
        expect(gliding.some(f => f.ticks.some(q => dist(q % 1, 0) > 0.1))).toBe(true);
        expect(gliding.some(f => f.grid.some(q => dist(q % 1, 0) > 0.1))).toBe(true);
        // The labels are named in the frame the glide LANDS in (renamed
        // as it begins, then riding their lines): the frame end's line
        // starts 2Q in and slides to the right edge, never jumping.
        const ends = gliding.filter(f => f.end.length === 1).map(f => f.end[0].x);
        expect(ends.length).toBeGreaterThan(3);
        expect(ends[0]).toBeLessThan(3);
        for (let i = 1; i < ends.length; i++) {
            expect(ends[i]).toBeGreaterThanOrEqual(ends[i - 1] - 1e-6);
            expect(ends[i] - ends[i - 1]).toBeLessThan(0.5);
        }
        expect(gliding.every(f => f.end.every(e => e.text === '4Q ↺'))).toBe(true);
        // Landed: whole Qs again, the cycle end at the right edge.
        const last = frames[frames.length - 1];
        expect(last.settling).toBe(false);
        expect(last.ticks.map(q => +q.toFixed(3))).toEqual([0, 1, 2, 3, 4]);
        expect(last.end).toEqual([{ x: 4, text: '4Q ↺' }]);
    });

    test('playing: the cursor rides the glide and keeps its pace', async ({ page }) => {
        // The glide carries the cursor +2Q and the transport carries it
        // on, so EVERY frame moves it forward by at least the sweep's
        // own step (~1Q/s here, ~0.016Q a frame). A re-render fed to the
        // dead-reckoner as a poll — its clock is the last poll's — reads
        // as a teleport: the sweep stalls between polls and after the
        // glide (measured: six frames under 0.005Q, two at zero). The
        // frame's move is taken on its own instead (animator.js
        // animatorFrame).
        const { Q, id2 } = await setup(page);
        await page.evaluate(() => window.__celestrianTest.startTransport());
        await page.waitForTimeout(400);
        const width = await page.locator('#ruler').evaluate(el => el.clientWidth);
        await page.evaluate(async ({ id, Q }) => {
            await window.__celestrianTest.callNative('setLoopPoints', id, 6 * Q, 10 * Q);
        }, { id: id2, Q });
        await page.waitForTimeout(400);
        await page.keyboard.press('Escape');
        const frames = await sample(page, 1200);
        const steps = stepsOf(frames.map(f => f.x), width);
        const pxPerQ = width / 4;
        expect(Math.min(...steps) / pxPerQ).toBeGreaterThan(-0.005);    // never back
        expect(steps.filter(d => d / pxPerQ < 0.005).length)
            .toBeLessThanOrEqual(2);                                     // never stalls
        expect(frames.some(f => f.settling)).toBe(true);
        const travelQ = steps.reduce((a, d) => a + d, 0) / pxPerQ;
        expect(travelQ).toBeGreaterThan(2);                 // the glide, and time
        expect(travelQ).toBeLessThan(2 + 1.2 * 1.5);        // …no more than 1.2 s of it
    });

    test('a pending preview patches at once (requestRender) and lets go unanswered', async ({ page }) => {
        const { Q, id2 } = await setup(page);
        await page.waitForTimeout(200);
        // The 10Q take (unwindowed) fills the 10Q frame from its top; a
        // 1Q re-time preview moves its tile a tenth of the lane — in the
        // SAME task as the request (no poll can run in between), with
        // the zero held (the definer is selected).
        const moved = await page.evaluate(async ({ id, Q }) => {
            const pe = await import('/js/session_view/pending_edits.js');
            const rr = await import('/js/session_view/render_request.js');
            const tile = () => {
                const t = document.querySelector(
                    `.lane[data-id="${id}"] .reps-layer .rep:not(.ghost)`);
                return parseFloat(t.style.left);
            };
            const before = tile();
            pe.clearPendingEdit(id);
            pe.setPendingEdit(id, { originShift: Q });
            rr.requestRender();
            return { before, after: tile() };
        }, { id: id2, Q });
        expect(moved.after - moved.before).toBeCloseTo(10, 1);   // 1Q of 10Q, in %
        // Nothing answers it (no gesture is live): it lets go after the
        // commit hold, and the tile returns.
        await expect.poll(() => page.locator(
            `.lane[data-id="${id2}"] .reps-layer .rep:not(.ghost)`).first()
            .evaluate(el => parseFloat(el.style.left)), { timeout: 4000 })
            .toBeCloseTo(moved.before, 1);
    });

    test('prefers-reduced-motion: the deselect jumps', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const { Q, id2 } = await setup(page);
        await page.waitForTimeout(200);
        await page.evaluate(async ({ id, Q }) => {
            await window.__celestrianTest.callNative('setLoopPoints', id, 6 * Q, 10 * Q);
        }, { id: id2, Q });
        await expect(page.locator('.lane[data-kind="clip"]').nth(1)
            .locator('.win-chip')).toHaveText(/4Q/);
        await page.waitForTimeout(250);
        const width = await page.locator('#ruler').evaluate(el => el.clientWidth);
        const held = await playheadX(page);
        await page.keyboard.press('Escape');
        const frames = await sample(page, 600);
        const xs = [held, ...frames.map(f => f.x)];
        const steps = stepsOf(xs, width);
        const travelQ = (steps.reduce((a, d) => a + d, 0) / width) * 4;
        expect(Math.abs(Math.abs(travelQ) - 2)).toBeLessThan(0.05);   // 2Q…
        expect(steps.filter(d => Math.abs(d) > 0.5).length).toBe(1);  // …at once
        expect(frames.some(f => f.settling)).toBe(false);
    });
});
