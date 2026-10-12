/**
 * HEARD TILES DON'T LURCH, BREATHE OR DOUBLE (session_view/lane_body.js;
 * the browser half of heard_tile_sampler.test.mjs: the real canvases,
 * the real reconcile).
 *
 * (1) A map SLIDE repaints only the strip its seam sweeps — measured on
 * the heard tile's pixels. (2) A panel TRIM drag re-lays tiles in
 * place: no surplus tile fading over the new layout, no old canvas
 * cross-fading over a regenerated composite.
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, node, recordTake, setLoop, loopedTake, laneOf, panelOf,
         selectLane, centre, dragBy, jiggleUntil, release, watchFrames, settled,
         tileProfile, tileAtRest, changedCols }
    from './helpers.js';

/** The shortest circular band (columns) holding every changed column. */
function changedBand(a, b) {
    const W = a.length;
    const changed = changedCols(a, b).map(f => Math.round(f * W));
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
        // A 1Q definer, a 4Q loop (it seats the frame: 4Q), then a 12Q
        // take windowed to [6Q, 10Q) — a lane that does NOT seat the
        // frame, so the slide cannot re-seat anything but by whole
        // 4Q cycles (invisible).
        const { Q } = await loopedTake(page, { lenQ: 4, loop: null, select: false });
        const b = await recordTake(page, Q, 12);
        await setLoop(page, b, 6 * Q, 10 * Q);
        await expect(laneOf(page, b).locator('.win-heard-chip')).toHaveText(/4Q/);
        const before = await tileAtRest(page, b);

        // SLIDE +0.37Q, length held (what the panel box's ⌥-drag and a
        // single splice drag commit): a non-whole number of peaks.
        const d = 0.37;
        const start = Math.round((6 + d) * Q);
        await setLoop(page, b, start, start + 4 * Q);
        await expect.poll(async () => {
            const now = await tileProfile(page, b);
            return !!now && changedCols(before, now).length > 0;
        }).toBe(true);
        const after = await tileAtRest(page, b);
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
        const Q = await quantum(page);
        const panel = panelOf(page, 'clip-2');    // 3Q, inside a 6Q group
        await selectLane(page, 'clip-2');
        // Let the load settle: the composite's first regenerations (as
        // the members' peaks arrive) legitimately cross-fade.
        await tileAtRest(page, 'stack-1');
        await expect.poll(() => page.evaluate(() =>
            document.querySelectorAll('.reps-layer .rep canvas + canvas').length)).toBe(0);

        // Every reps layer, each frame from here to after the release.
        const watch = await watchFrames(page, () => {
            const row = { exiting: 0, canvases: 0, where: '', tiles: 0, groupRef: 0 };
            document.querySelectorAll('.lane-body .reps-layer').forEach(layer => {
                const kids = [...layer.children];
                row.exiting = Math.max(row.exiting,
                    kids.filter(k => k._exiting || k.style.opacity === '0').length);
                for (const k of kids) {
                    const n = k.querySelectorAll('canvas').length;
                    if (n > row.canvases) {
                        row.canvases = n;
                        row.where = layer.closest('.lane').dataset.id;
                    }
                }
            });
            const member = document.querySelector('.lane[data-id="clip-2"] .reps-layer');
            if (member) row.tiles = member.children.length;
            // The group composite's peaks, numbered by identity.
            const g = document.querySelector('.lane[data-id="stack-1"] .reps-layer .rep');
            if (g && g._peaksRef) {
                const seen = window.__peakRefs || (window.__peakRefs = []);
                if (!seen.includes(g._peaksRef)) seen.push(g._peaksRef);
                row.groupRef = seen.indexOf(g._peaksRef) + 1;
            }
            return row;
        });
        const tiles = async () => (await watch.rows()).at(-1).tiles;

        // Px per Q from the kept box (the whole 3Q take): robust to any
        // panel zoom.
        const kept = await panel.locator('.region-kept').boundingBox();
        const pxQ = kept.width / 3;
        const end = centre(await panel.locator('.region-bracket.end').boundingBox());
        // In to a 2Q loop (three 2Q tiles in the pinned 6Q frame), a
        // live commit carrying it …
        await dragBy(page, end, -1.2 * pxQ, { steps: 12, hold: true });
        await jiggleUntil(page, { x: end.x - 1.2 * pxQ, y: end.y },
            async () => (await node(page, 'clip-2')).loopEnd / Q, 2);
        await expect.poll(tiles).toBe(3);
        // … and back out to the whole 3Q take (two tiles: one retired).
        await page.mouse.move(end.x + 0.3 * pxQ, end.y, { steps: 12 });
        await expect.poll(tiles).toBe(2);
        await release(page);
        await settled(page);
        const rows = await watch.stop();
        // Non-vacuous: the trim really re-laid the member's tiles, and
        // its live commits really regenerated the group's composite.
        expect([...new Set(rows.map(r => r.tiles))]).toEqual(expect.arrayContaining([2, 3]));
        expect(new Set(rows.map(r => r.groupRef).filter(Boolean)).size).toBeGreaterThan(1);
        // The law: no surplus tile ever faded over a re-lay, and no old
        // canvas ever cross-faded over a regenerated one.
        expect(Math.max(...rows.map(r => r.exiting)), 'a surplus tile faded over the re-lay')
            .toBe(0);
        const worst = rows.reduce((a, r) => (r.canvases > a.canvases ? r : a));
        expect(worst.canvases, `a cross-fade on ${worst.where}`).toBeLessThanOrEqual(1);
    });
});
