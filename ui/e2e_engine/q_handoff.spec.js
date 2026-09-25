/**
 * HANDING Q TO A TRACK (Q22), end to end on the real engine: the owner's
 * story. An arhythmic keyboard loop sets Q (a sub-second definer trim);
 * a long drum take is recorded over five passes of it; the drums rail's
 * Q lamp hands Q to the drums — by a REAL click in the real UI — and
 * nothing sounds different (fingerprint); the drums are trimmed to their
 * own loop freely and the keyboard, no longer fitting, DRIFTS: the
 * spectral listener checks, over several passes, that what sounds is
 * the render law and is what the lanes draw for that pass. Recording the
 * next track locks the hand-off.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, call, state, rec, verifyHeard, findNode,
         listen, mod } from './engine_helpers.mjs';

const Q = 44100;

/** Listen from an ABSOLUTE clock phase of `cycle` — a hand-off moves the
 * island zero, so two listens are lined up on the clock, not the zero. */
async function listenAtClock(page, phase, cycle) {
    const s = await engine(page, 'status');
    const now = s.islandPos + (await state(page)).islandZero;
    const need = mod(phase - now, cycle);
    if (need > 0) await engine(page, 'advance', { samples: need });
    return listen(page);
}

/** The capture moments each frame sounds, frame by frame: two listens
 * started on the same clock phase must match (frames whose sound count
 * differs straddle a seam — skipped). */
function expectSameSoundByFrame(a, b, tol = 900) {
    const byTake = L => {
        const m = {};
        for (const [id, takes] of Object.entries(L.clips))
            for (const t of takes) m[`${id}/${t.take}`] = t.captureClock;
        return m;
    };
    const ta = byTake(a), tb = byTake(b);
    const clocks = (L, m, f) => f.heard.map(h => m[`${h.id}/${h.take}`] + h.inner)
        .sort((x, y) => x - y);
    let compared = 0;
    a.frames.forEach((fa, i) => {
        const fb = b.frames[i];
        if (!fb) return;
        const ca = clocks(a, ta, fa), cb = clocks(b, tb, fb);
        if (ca.length !== cb.length) return;
        ca.forEach((c, k) => expect(Math.abs(c - cb[k]),
            `frame ${i}: capture ${c} became ${cb[k]}`).toBeLessThan(tol));
        compared++;
    });
    expect(compared, 'frames compared').toBeGreaterThan(a.frames.length / 2);
}

test('the drums take over Q: sound-neutral, re-gridded, and the keys drift as drawn', async ({ page }) => {
    await openEngine(page);
    // The keyboard: the first take, trimmed as the definer to a 0.9 s
    // loop — arhythmic against anything to come.
    const keys = await rec(page, Q);
    await call(page, 'setLoopPoints', keys, Q / 10, Q);
    const Qk = (await state(page)).quantum;
    expect(Qk).toBe(Q - Q / 10);
    // The drums, recorded over five passes of the keys (the arm locks
    // the keys: they lock-collapse to their loop).
    const drums = await rec(page, 5 * Qk);
    let st = await state(page);
    expect(findNode(st, drums).duration).toBe(5 * Qk);
    expect(st.definerId).toBe('');
    await verifyHeard(page);
    const cycle = (await engine(page, 'status')).cycle;
    expect(cycle, 'the drums span five keys passes').toBe(5 * Qk);
    const before = await listenAtClock(page, 0, cycle);

    // THE HAND-OFF, by the drums rail's (hover-revealed) Q lamp.
    const lane = page.locator(`.lane[data-id="${drums}"]`);
    await lane.locator('.lane-rail').hover();
    await lane.locator('.tempo-chip.offer').click();
    await expect.poll(async () => (await state(page)).definerId).toBe(drums);
    st = await state(page);
    expect(st.quantum, 'Q := the drums loop').toBe(5 * Qk);
    expect(st.islandZero, 'zero := the drums loop top').toBe(findNode(st, drums).origin);
    // Nothing sounds different: the very capture moments at the very
    // clock phases (the cycle is still the drums' 5 keys passes).
    expect((await engine(page, 'status')).cycle).toBe(cycle);
    const after = await listenAtClock(page, 0, cycle);
    expectSameSoundByFrame(before, after);
    await verifyHeard(page);

    // Trim the drums to their own loop — free, off the keys' grid.
    const drumsOrigin = findNode(st, drums).origin;
    const s0 = Math.round(0.7 * Qk), e0 = Math.round(3.1 * Qk);
    await call(page, 'setLoopPoints', drums, s0, e0);
    st = await state(page);
    expect(st.quantum, 'Q follows the drums').toBe(e0 - s0);
    expect(findNode(st, drums).origin, 'the drums keep their timing').toBe(drumsOrigin);
    expect(st.islandZero).toBe(drumsOrigin + s0);
    // The keys no longer fit: they drift, so the island cycles on the
    // drums alone — never lcm(0.9 s, 2.16 s).
    expect((await engine(page, 'status')).cycle).toBe(e0 - s0);
    await expect(page.locator(`.lane[data-id="${keys}"] .rail-sub`)).toContainText('↯');
    // Three drum passes: every pass lines the keys up differently, and
    // each frame is judged against the drawing of ITS pass.
    await verifyHeard(page, { samples: 3 * (e0 - s0) });

    // Recording the next track locks the hand-off.
    const bass = await rec(page, e0 - s0);
    st = await state(page);
    expect(st.definerId, 'locked').toBe('');
    expect(findNode(st, drums).duration, 'the drums lock-collapsed to their loop')
        .toBe(e0 - s0);
    expect(findNode(st, bass).duration % (e0 - s0)).toBe(0);
    await verifyHeard(page, { samples: 3 * (e0 - s0) });
});
