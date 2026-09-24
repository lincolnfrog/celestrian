/**
 * HEARD TILES DON'T LURCH, BREATHE OR DOUBLE (loop-region phase 1,
 * 2026-09-23 — field video: "every live commit makes the whole lane
 * lurch sideways and breathe").
 *
 * The browser half of heard_tile_sampler.test.mjs: the real canvases,
 * the real reconcile. (1) A map SLIDE repaints only the strip its seam
 * sweeps — measured on the heard tile's pixels. (2) A panel TRIM drag
 * re-lays tiles in place: no surplus tile fading over the new layout,
 * no old canvas cross-fading over a regenerated composite. Real mouse
 * input for the drag (synthetic dispatch bypasses hit-testing).
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, laneOf } from './region_panel_helpers.js';

/** Record takes of the given lengths (Q) in order, each waiting out its
 * pending start and its awaiting-stop; the first take sets Q. */
async function recordTakes(page, Q, lengths) {
    return page.evaluate(async ({ Q, lengths }) => {
        const c = window.__celestrianTest.callNative;
        const adv = window.__celestrianTest.advanceBy;
        const find = async id =>
            (await c('getGraphState')).nodes.find(n => n.id === id);
        const ids = [];
        for (const lenQ of lengths) {
            const id = await c('createNode', 'clip', '');
            await c('startRecordingInNode', id);
            for (let i = 0; i < 40; i++) {
                const n = await find(id);
                if (n.isRecording && !n.isPendingStart) break;
                adv(Q / 10);
            }
            adv(lenQ * Q - (ids.length ? Q / 4 : 0));
            await c('stopRecordingInNode', id);
            for (let i = 0; i < 40; i++) {
                if (!(await find(id)).isRecording) break;
                adv(Q / 10);
            }
            ids.push(id);
        }
        return ids;
    }, { Q, lengths });
}

/** The heard take tile's envelope: per backing column, the height
 * (px) of the filled shape above the centre line. */
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

/** The shortest circular band (columns) holding every changed column. */
function changedBand(a, b, tolPx = 1) {
    const W = a.length;
    const changed = [];
    for (let x = 0; x < W; x++) if (Math.abs(a[x] - b[x]) > tolPx) changed.push(x);
    if (!changed.length) return { count: 0, width: 0 };
    // The band is the circle minus its largest unchanged gap.
    let maxGap = W - changed[changed.length - 1] + changed[0];
    for (let i = 1; i < changed.length; i++) {
        maxGap = Math.max(maxGap, changed[i] - changed[i - 1]);
    }
    return { count: changed.length, width: W - maxGap + 1 };
}

test.describe('Heard tiles', () => {
    test('a map SLIDE repaints only the swept strip of the heard lane', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        // A 1Q definer, a 4Q loop (it seats the frame: 4Q), then a 12Q
        // take windowed to [6Q, 10Q) — a lane that does NOT seat the
        // frame, so the slide cannot re-seat anything but by whole
        // 4Q cycles (invisible).
        const [, , b] = await recordTakes(page, Q, [1, 4, 12]);
        await page.evaluate(({ b, Q }) =>
            window.__celestrianTest.callNative('setLoopPoints', b, 6 * Q, 10 * Q),
        { b, Q });
        await expect(laneOf(page, b).locator('.win-heard-chip')).toHaveText(/4Q/);
        await expect.poll(async () => (await tileProfile(page, b)) !== null).toBe(true);
        await page.waitForTimeout(200);  // settle any first-draw swap
        const before = await tileProfile(page, b);

        // SLIDE +0.37Q, length held (what the panel box's ⌥-drag and a
        // single splice drag commit): a non-whole number of peaks.
        const d = 0.37;
        await page.evaluate(({ b, Q, d }) => window.__celestrianTest.callNative(
            'setLoopPoints', b, Math.round((6 + d) * Q), Math.round((6 + d) * Q) + 4 * Q),
        { b, Q, d });
        await expect.poll(async () => {
            const now = await tileProfile(page, b);
            return now && changedBand(before, now).count > 0;
        }).toBe(true);
        await page.waitForTimeout(200);
        const after = await tileProfile(page, b);
        expect(after.length).toBe(before.length);

        // One heard tile spans the 4Q frame: the seam sweeps d·W/4
        // columns; the envelope's smoothing and anti-aliasing may touch
        // a few more either side. EVERYTHING ELSE is pixel-identical.
        const band = changedBand(before, after);
        const sweptPx = d * before.length / 4;
        expect(band.count).toBeGreaterThan(0);
        expect(band.width).toBeLessThanOrEqual(Math.ceil(sweptPx) + 8);
    });

    test('a panel TRIM drag re-lays tiles in place: no fading surplus, no cross-fading composite', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        const lane = laneOf(page, 'clip-2');   // 3Q, inside a 6Q group
        await lane.locator('.rail-name').click();
        const strip = lane.locator('.region-strip');
        await expect(strip).toBeVisible();
        // Let the load settle: the composite's first regenerations (as
        // the members' peaks arrive) legitimately cross-fade.
        await page.waitForTimeout(500);
        await expect.poll(() => page.evaluate(() =>
            document.querySelectorAll('.reps-layer .rep canvas + canvas').length)).toBe(0);

        // Watch every reps layer each frame from here to after release.
        await page.evaluate(() => {
            const s = window.__ws3 = { exiting: 0, canvases: 0, run: true,
                                       counts: new Set(), groupRefs: new Set(),
                                       t0: performance.now(), where: '' };
            const tick = () => {
                if (!s.run) return;
                document.querySelectorAll('.lane-body .reps-layer').forEach(layer => {
                    const kids = [...layer.children];
                    s.exiting = Math.max(s.exiting,
                        kids.filter(k => k._exiting || k.style.opacity === '0').length);
                    for (const k of kids) {
                        const n = k.querySelectorAll('canvas').length;
                        if (n > s.canvases) {
                            s.canvases = n;
                            s.where = layer.closest('.lane').dataset.id + ' @' +
                                Math.round(performance.now() - s.t0);
                        }
                    }
                });
                const c2 = document.querySelector('.lane[data-id="clip-2"] .reps-layer');
                if (c2) s.counts.add(c2.children.length);
                const g = document.querySelector('.lane[data-id="stack-1"] .reps-layer .rep');
                if (g && g._peaksRef) s.groupRefs.add(g._peaksRef);
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        // Px per Q from the kept box (the whole 3Q take): robust to any
        // panel zoom.
        const kept = await lane.locator('.region-kept').boundingBox();
        const pxQ = kept.width / 3;
        const eb = await lane.locator('.region-bracket.end').boundingBox();
        const x0 = eb.x + eb.width / 2;
        const y = eb.y + eb.height / 2;
        await page.mouse.move(x0, y);
        await page.mouse.down();
        // In to a 2Q loop (three 2Q tiles in the pinned 6Q frame) …
        await page.mouse.move(x0 - 1.2 * pxQ, y, { steps: 12 });
        await page.waitForTimeout(250);
        // … and back out to the whole 3Q take (two tiles: one retired).
        await page.mouse.move(x0 + 0.3 * pxQ, y, { steps: 12 });
        await page.waitForTimeout(250);
        await page.mouse.up();
        await page.waitForTimeout(600);
        const s = await page.evaluate(() => {
            const s = window.__ws3;
            s.run = false;
            return { exiting: s.exiting, canvases: s.canvases, where: s.where,
                     counts: [...s.counts].sort(), groupRefs: s.groupRefs.size };
        });
        // Non-vacuous: the trim really re-laid the member's tiles, and
        // its live commits really regenerated the group's composite.
        expect(s.counts).toEqual(expect.arrayContaining([2, 3]));
        expect(s.groupRefs).toBeGreaterThan(1);
        // The law: no surplus tile ever faded over a re-lay, and no old
        // canvas ever cross-faded over a regenerated one.
        expect(s.exiting, 'a surplus tile faded over the re-lay').toBe(0);
        expect(s.canvases, `a cross-fade on ${s.where} (lane @ms)`).toBeLessThanOrEqual(1);
    });
});
