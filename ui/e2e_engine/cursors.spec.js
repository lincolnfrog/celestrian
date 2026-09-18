/**
 * CURSORS, end to end: the white playhead's x is the engine's island
 * phase over the frame; a windowed lane's amber cursor is the heard
 * phase inside its brackets. Checked at several exact clock positions
 * (the clock is paused between advances, so the dead-reckoning
 * animator has nothing to extrapolate and the poll's correction wins).
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, findNode, mod } from './engine_helpers.mjs';
import { deriveViewModel } from '../js/view_model.js';
import { innerAt } from '../js/time_map.js';

const Q = 44100;

async function playheadFrac(page) {
    return page.evaluate(() => {
        const ph = document.querySelector('#playhead');
        const ruler = document.querySelector('#ruler');
        return parseFloat(ph.style.left) / ruler.clientWidth;
    });
}

test('the playhead follows the island phase over the frame', async ({ page }) => {
    await openEngine(page);
    await rec(page, Q);
    await rec(page, 4 * Q);
    for (const step of [Q, Q + 12345, 2 * Q - 99]) {
        await engine(page, 'advance', { samples: step });
        const st = await state(page);
        // The frame's zero is the view's seat (docs/frame.md): the
        // playhead's x is the view model's phase over its frame.
        const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set() });
        const expected = vm.playheadQ / vm.cycleQ;
        await expect.poll(() => playheadFrac(page), { timeout: 3000 })
            .toBeCloseTo(expected, 2);
    }
});

test('the region panel\'s amber cursor sits at the heard moment inside the kept region', async ({ page }) => {
    // Heard lanes tile the window's content, so the white playhead is
    // honest on them. The RAW view — the region panel under the
    // selected lane: the whole take, the kept region boxed — carries
    // the amber cursor: heard time inside the box, sweeping the kept
    // material.
    await openEngine(page);
    await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await call(page, 'setLoopPoints', c2, Q, 3 * Q);
    expect((await engine(page, 'status')).cycle).toBe(2 * Q);
    const lane = page.locator(`.lane[data-id="${c2}"]`);
    await lane.locator('.rail-name').click();
    await expect(lane.locator('.region-cursor')).toHaveCount(1);
    for (const step of [777, Q / 2, Q + 4321]) {
        await engine(page, 'advance', { samples: step });
        const st = await state(page);
        const s = await engine(page, 'status');
        const n = findNode(st, c2);
        const at = innerAt(st.islandZero + s.islandPos, n.origin,
                           { segs: [[Q, 3 * Q]] }, 2 * Q);
        // The raw frame is the whole 4Q take: the cursor at the inner
        // position of the heard moment.
        const expected = (at.inner / Q) / 4;
        await expect.poll(() => page.evaluate(id => {
            const lane = document.querySelector('.lane[data-id="' + id + '"]');
            const cur = lane.querySelector('.region-cursor');
            const strip = lane.querySelector('.region-strip');
            if (!cur) return null;
            const r = cur.getBoundingClientRect(), b = strip.getBoundingClientRect();
            return (r.left + r.width / 2 - b.left) / b.width;
        }, c2), { timeout: 3000 }).toBeCloseTo(expected, 1);
    }
    void deriveViewModel; void mod;
});
