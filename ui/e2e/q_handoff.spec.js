/**
 * HANDING Q TO A TRACK (Q22) — the real-input journey on the mock page:
 * an arhythmic keyboard loop set Q, a long drum take sits over it; the
 * drums rail's unlit Q lamp hands Q to the drums (they open the
 * first-take trim view), their brackets trim the drummer's loop freely,
 * and the keyboard — which no longer fits — is badged drifting (↯).
 * Every gesture is a REAL mouse action (hit-tested): the lamp is
 * hover-revealed chrome, the brackets sit on the lane overlay.
 */

import { test, expect } from '@playwright/test';
import { boot, call, root, node, laneOf, centre, dragTo } from './helpers.js';

const KEYS = 'keys';     // a 1Q loop at 0: it set Q
const DRUMS = 'drums';   // a 5Q take from 2Q

/** Hover the drums' rail, then click its (hover-revealed) Q lamp. */
async function handQToDrums(page) {
    const lane = laneOf(page, DRUMS);
    await lane.locator('.lane-rail').hover();
    const lamp = lane.locator('.tempo-chip.offer');
    await expect(lamp).toBeVisible();
    await lamp.click();
    await expect.poll(async () => (await root(page)).definerId).toBe(DRUMS);
}

/** Drag `handle` to `frac` of the lane `body`'s width — grabbed once it
 * has a box: after a commit the overlay is rebuilt from the settled
 * state, and a rebuild detaches the handle just measured. */
async function dragToFrac(page, handle, body, frac) {
    let from = null;
    await expect.poll(async () => !!(from = await handle.boundingBox())).toBe(true);
    const box = await body.boundingBox();
    await dragTo(page, centre(from), box.x + box.width * frac, { steps: 8 });
}

test.beforeEach(async ({ page }) => {
    await boot(page, { scenario: 'keys-then-drums', lanes: 2 });
});

test('the Q lamp hands Q to the drums: their loop is Q, nothing moves; undo walks it back in one step', async ({ page }) => {
    const Q0 = (await root(page)).quantum;
    const drums = laneOf(page, DRUMS);
    // No lamp before the hover-offer: the definer has none either (two
    // takes, Q locked).
    await expect(drums.locator('.tempo-chip.offer')).toHaveCSS('opacity', '0');
    await handQToDrums(page);
    const s = await root(page);
    expect(s.quantum).toBe(5 * Q0);
    expect(s.islandZero).toBe(2 * Q0);
    expect((await node(page, DRUMS)).origin).toBe(2 * Q0);
    // The drums open the first-take trim view: lit lamp, "sets tempo".
    await expect(drums.locator('.win-chip.q-definer')).toContainText('sets tempo');
    await expect(drums.locator('.tempo-chip')).not.toHaveClass(/offer/);
    // …and the keys can still take it back.
    await laneOf(page, KEYS).locator('.lane-rail').hover();
    await expect(laneOf(page, KEYS).locator('.tempo-chip.offer')).toBeVisible();

    // One undo step: Q, the designation and the trim view go together.
    await call(page, 'undo');
    await expect.poll(async () => (await root(page)).quantum).toBe(Q0);
    expect((await root(page)).definerId).toBe('');
    await expect(drums.locator('.win-chip.q-definer')).toHaveCount(0);
});

test('trimming the handed-Q drums re-grids freely; the keys drift (↯)', async ({ page }) => {
    const Q0 = (await root(page)).quantum;
    await handQToDrums(page);
    const drums = laneOf(page, DRUMS);
    const body = drums.locator('.lane-body');
    const start = drums.locator('.win-bracket.start');
    // The lane has repainted as the trim view before a bracket is taken.
    await expect(drums.locator('.win-chip.q-definer')).toContainText('sets tempo');
    // The trim view frames the whole 5-keys-loop take: 0.14 of it is
    // 0.7 keys loops — a start no whole-Q snap could land.
    await dragToFrac(page, start, body, 0.14);
    await expect.poll(async () => (await node(page, DRUMS)).loopStart)
        .toBeGreaterThan(0.6 * Q0);
    // …and the brackets are rebuilt from that settled state before the
    // next grab: the start bracket sits at 14% again.
    await expect.poll(async () => {
        const b = await start.boundingBox();
        const lb = await body.boundingBox();
        return b && lb ? Math.round(100 * (b.x - lb.x) / lb.width) : -1;
    }).toBeGreaterThanOrEqual(12);
    let d = await node(page, DRUMS);
    expect(d.loopStart).toBeLessThan(0.8 * Q0);
    expect(d.origin).toBe(2 * Q0);  // the drums keep their timing
    expect((await root(page)).quantum).toBe(d.loopEnd - d.loopStart);
    // End bracket to 0.62 → a 2.4-keys-loop drum loop: the keys (one of
    // the Qs they set) no longer fit — they drift.
    await dragToFrac(page, drums.locator('.win-bracket.end'), body, 0.62);
    await expect.poll(async () => (await node(page, DRUMS)).loopEnd)
        .toBeLessThan(3.3 * Q0);
    d = await node(page, DRUMS);
    const q = (await root(page)).quantum;
    expect(q).toBe(d.loopEnd - d.loopStart);
    expect(q % Q0 !== 0 && Q0 % q !== 0).toBe(true);
    const keysSub = laneOf(page, KEYS).locator('.rail-sub');
    await expect(keysSub).toContainText('↯');
    await expect(keysSub).toHaveClass(/drift/);
    // The trim view dims the keys outside the drums' selection.
    await expect(laneOf(page, KEYS).locator('.trim-dims .trim-dim')).toHaveCount(2);
});
