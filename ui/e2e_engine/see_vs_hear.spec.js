/**
 * THE GRID YOU SEE IS THE GRID YOU HEAR — end to end (owner ruling
 * 2026-09-09; the field bug: a root song sounded the full band over the
 * guitar-only section while the lanes showed otherwise).
 *
 * The real UI builds the song with real clicks on the root sequencer
 * grid, over takes the real engine recorded (one armed mid-cycle so the
 * epoch re-bases — the case that used to part the engine's grid from
 * the display's). Then the engine is asked for the AUDIBLE TRUTH — it
 * solos each clip and listens, cell by cell — and every lane's dims in
 * the DOM must sit exactly where the engine is silent.
 */

import { test, expect } from '@playwright/test';
import { openEngine, engine, state, rec, dimmedCells, verifyHeard, listen, findNode, mod }
    from './engine_helpers.mjs';

test('root song after a growth re-base: lane dims == engine silence', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await engine(page, 'advance', { samples: 4 * Q });
    // An 8Q take armed at phase 2Q: the cycle grows 4Q → 8Q and the
    // epoch moves to the take's heard top (whole old cycles).
    const c3 = await rec(page, 8 * Q, { atPhase: 2 * Q });
    const s = await engine(page, 'status');
    expect(s.cycle).toBe(8 * Q);
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3);

    // THE ROOT SONG, by hand: chip → start (one 8Q step) → + step →
    // gate the first track off in step 2.
    const chip = page.locator('#root-seq-btn');
    await chip.click();
    const grid = page.locator('.lane-seq');
    await expect(grid).toHaveCount(1);
    await grid.locator('.seq-start').click();
    await expect(grid.locator('.seq-pad')).toHaveCount(3);
    await grid.locator('.seq-addstep').click();
    await expect(grid.locator('.seq-pad')).toHaveCount(6);
    const c1Row = grid.locator('.seq-grid-row').nth(1);  // first track
    await c1Row.locator('.seq-pad').nth(1).click();
    await expect(c1Row.locator('.seq-pad').nth(1)).not.toHaveClass(/on/);
    await expect.poll(async () => {
        const st = await state(page);
        const g = st.sequence && st.sequence.gates && st.sequence.gates[c1];
        return g ? g.join(',') : null;
    }).toBe('true,false');
    await expect(page.locator(`.lane[data-id="${c1}"] .seq-dim`)).toHaveCount(1);

    // The engine's audible truth, per Q cell of the 16Q song.
    const truth = await engine(page, 'truth');
    expect(truth.cycleQ).toBe(16);
    expect(truth.truth[c1]).toEqual(
        [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0].map(Boolean));
    expect(truth.truth[c2].every(Boolean)).toBe(true);
    expect(truth.truth[c3].every(Boolean)).toBe(true);

    // What the lanes DRAW, cell by cell, must be the complement.
    for (const id of [c1, c2, c3]) {
        const dimmed = await dimmedCells(page, id, truth.cycleQ);
        expect(dimmed, `lane ${id}`).toEqual(truth.truth[id].map(on => !on));
    }
    await page.screenshot({ path: 'test-results/engine_see_vs_hear.png' });

    // The listener says the same, with content: c1 sounds its loop law
    // in step 1 and nothing in step 2 (frames near the 10 ms seams
    // skipped); c2 and c3 sound throughout.
    const fade = 0.010 * 44100 / Q;
    await verifyHeard(page, {
        silent: (id, phaseQ) => {
            if (id !== c1) return false;
            const d = Math.min(mod(phaseQ, 8), 8 - mod(phaseQ, 8));
            if (d < fade + 0.1) return 'skip';
            return phaseQ >= 8;
        },
    });
});

test('a CUED step replays the song top (S18): in step 2 the clips sound what they sound in step 1', async ({ page }) => {
    await openEngine(page);
    const Q = 44100;
    const c1 = await rec(page, Q);
    const c2 = await rec(page, 4 * Q);
    await page.locator('#root-seq-btn').click();
    const grid = page.locator('.lane-seq');
    await grid.locator('.seq-start').click();
    await grid.locator('.seq-addstep').click();
    // The second header's cue pip: step 2 re-bases to the song top.
    await grid.locator('.seq-hcell').nth(1).hover();
    await grid.locator('.seq-hcell').nth(1).locator('.seq-cue').click();
    await expect.poll(async () => {
        const s = (await state(page)).sequence;
        return s && s.steps.length === 2 ? !!s.steps[1].cue : null;
    }).toBe(true);
    const L = await listen(page);
    expect(L.cycle).toBe(8 * Q);
    const st = await state(page);
    const cueMap = f => f.pos - (f.phase >= 4 * Q ? 4 * Q : 0);  // song top re-base
    for (const f of L.frames) {
        const d = Math.min(f.phase % (4 * Q), 4 * Q - (f.phase % (4 * Q)));
        if (d < 3 * L.frame) continue;  // seams: the cue cut and the loop wraps
        for (const id of [c1, c2]) {
            const n = findNode(st, id);
            const t = st.islandEpoch + cueMap(f);
            const expected = mod(t - n.origin, n.duration);
            // The clip's own loop wrap inside the window: skip.
            if (expected < L.frame / 2 || n.duration - expected < L.frame / 2) continue;
            const hs = f.heard.filter(x => x.id === id);
            expect(hs.length, `${id} sounds @ ${(f.phase / Q).toFixed(2)}Q`).toBeGreaterThan(0);
            const h = hs.reduce((a, b) => Math.abs(b.inner - expected) < Math.abs(a.inner - expected) ? b : a);
            const diff = Math.abs(mod(h.inner - expected + n.duration / 2, n.duration) - n.duration / 2);
            expect(diff / Q, `${id} @ ${(f.phase / Q).toFixed(2)}Q: heard ${(h.inner / Q).toFixed(2)}Q, cue law ${(expected / Q).toFixed(2)}Q`).toBeLessThan(0.05);
        }
    }
});
