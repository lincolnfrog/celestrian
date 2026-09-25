/**
 * HANDING Q TO A TRACK (Q22) — the real-input journey on the mock page:
 * an arhythmic keyboard loop set Q, a long drum take sits over it; the
 * drums rail's unlit Q lamp hands Q to the drums (they open the
 * first-take trim view), their brackets trim the drummer's loop freely,
 * and the keyboard — which no longer fits — is badged drifting (↯).
 * Every gesture here is a REAL mouse action (hit-tested): the lamp is
 * hover-revealed chrome, the brackets sit on the lane overlay.
 */

import { test, expect } from '@playwright/test';

const state = page => page.evaluate(() => window.celestrian.getState());
const nodeOf = (page, id) => page.evaluate(i =>
    window.celestrian.getState().nodes.find(n => n.id === i), id);

async function loadKeysThenDrums(page) {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click('button:has-text("Keys then Drums")');
    await page.waitForFunction(
        () => document.querySelectorAll('.lane[data-kind="clip"]').length === 2,
        { timeout: 5000 });
}

const laneOf = (page, name) => page.locator('.lane', {
    has: page.locator('.rail-name', { hasText: name }) });

/** Hover the rail, then click its (hover-revealed) Q lamp. */
async function handQTo(page, name) {
    const lane = laneOf(page, name);
    await lane.locator('.lane-rail').hover();
    const lamp = lane.locator('.tempo-chip.offer');
    await expect(lamp).toBeVisible();
    await lamp.click();
}

async function dragToFrac(page, handle, body, frac) {
    // After a commit the overlay is held, then rebuilt from the settled
    // state: grab the handle once the rebuilt one has a box (a rebuild
    // can detach the one just measured — measure again).
    let from = null;
    await expect.poll(async () => !!(from = await handle.boundingBox())).toBe(true);
    const box = await body.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * frac, box.y + box.height / 2,
                          { steps: 8 });
    await page.mouse.up();
}

test('the Q lamp hands Q to the drums: their loop is Q, nothing moves', async ({ page }) => {
    await loadKeysThenDrums(page);
    const Q0 = (await state(page)).quantum;
    const drums = laneOf(page, 'Drums');
    // No lamp before the hover-offer: the definer has none either (two
    // takes, Q locked).
    await expect(drums.locator('.tempo-chip.offer')).toHaveCSS('opacity', '0');
    await handQTo(page, 'Drums');
    await expect.poll(async () => (await state(page)).definerId).toBe('drums');
    const s = await state(page);
    expect(s.quantum).toBe(5 * Q0);
    expect(s.islandZero).toBe(2 * Q0);
    expect((await nodeOf(page, 'drums')).origin).toBe(2 * Q0);
    // The drums open the first-take trim view: lit lamp, "sets tempo".
    await expect(drums.locator('.win-chip.q-definer')).toContainText('sets tempo');
    await expect(drums.locator('.tempo-chip')).not.toHaveClass(/offer/);
    // …and the keys can still take it back.
    await laneOf(page, 'Keys').locator('.lane-rail').hover();
    await expect(laneOf(page, 'Keys').locator('.tempo-chip.offer')).toBeVisible();
});

test('trimming the handed-Q drums re-grids freely; the keys drift (↯)', async ({ page }) => {
    await loadKeysThenDrums(page);
    const Q0 = (await state(page)).quantum;
    await handQTo(page, 'Drums');
    await expect.poll(async () => (await state(page)).definerId).toBe('drums');
    const drums = laneOf(page, 'Drums');
    const body = drums.locator('.lane-body');
    // Grab the brackets only once the lane has repainted as the trim
    // view (the poll above reads the engine, not the screen).
    await expect(drums.locator('.win-chip.q-definer')).toContainText('sets tempo');
    // The trim view frames the whole 5-keys-loop take: 0.14 of it is
    // 0.7 keys loops — a start no whole-Q snap could land.
    await dragToFrac(page, drums.locator('.win-bracket.start'), body, 0.14);
    await expect.poll(async () => (await nodeOf(page, 'drums')).loopStart)
        .toBeGreaterThan(0.6 * Q0);
    // …and the brackets are rebuilt from that settled state before the
    // next grab: the start bracket sits at 14% again.
    await expect.poll(async () => {
        const b = await drums.locator('.win-bracket.start').boundingBox();
        const lb = await body.boundingBox();
        return b && lb ? Math.round(100 * (b.x - lb.x) / lb.width) : -1;
    }).toBeGreaterThanOrEqual(12);
    let d = await nodeOf(page, 'drums');
    expect(d.loopStart).toBeLessThan(0.8 * Q0);
    expect(d.origin).toBe(2 * Q0);  // the drums keep their timing
    expect((await state(page)).quantum).toBe(d.loopEnd - d.loopStart);
    // End bracket to 0.62 → a 2.4-keys-loop drum loop: the keys (1 of
    // the old Qs) no longer fit — they drift.
    await dragToFrac(page, drums.locator('.win-bracket.end'), body, 0.62);
    await expect.poll(async () => (await nodeOf(page, 'drums')).loopEnd)
        .toBeLessThan(3.3 * Q0);
    d = await nodeOf(page, 'drums');
    const q = (await state(page)).quantum;
    expect(q).toBe(d.loopEnd - d.loopStart);
    expect(q % Q0 !== 0 && Q0 % q !== 0).toBe(true);
    const keysSub = laneOf(page, 'Keys').locator('.rail-sub');
    await expect(keysSub).toContainText('↯');
    await expect(keysSub).toHaveClass(/drift/);
    // The trim view dims the keys outside the drums' selection.
    await expect(laneOf(page, 'Keys').locator('.trim-dims .trim-dim')).toHaveCount(2);
});

test('undo walks the hand-off back in one step', async ({ page }) => {
    await loadKeysThenDrums(page);
    const Q0 = (await state(page)).quantum;
    await handQTo(page, 'Drums');
    await expect.poll(async () => (await state(page)).definerId).toBe('drums');
    await page.evaluate(() => window.celestrian.callNative('undo'));
    await expect.poll(async () => (await state(page)).quantum).toBe(Q0);
    expect((await state(page)).definerId).toBe('');
    await expect(laneOf(page, 'Drums').locator('.win-chip.q-definer')).toHaveCount(0);
});
