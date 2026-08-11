/**
 * Session view e2e (docs/ui_overhaul.md phase 2).
 *
 * Drives the Tape Room shell through the backend facade (P2-9): the
 * harness page (index_test.html) for scenario-based rendering, and
 * /?mock=true for transport-driven states. Timeline MATH is covered by
 * the view-model unit tests (js/tests/view_model.test.mjs) — these
 * specs assert the shell renders the model honestly and that the wired
 * interactions round-trip through the mock backend.
 */

import { test, expect } from '@playwright/test';

/* ---------- the mock's sample rate ----------
 *
 * These specs used to spell 44100 (and 88200 / 110250 / 176400) into
 * every position and length. The mock's rate is a variable now
 * (ui/js/mock/rate.js), so they read it from the page instead: Q is
 * one second of audio at whatever rate the mock publishes.
 *
 * Sweep the whole spec at another rate with
 *   E2E_MOCK_RATE=48000 npx playwright test
 * which seeds window.__celestrianMockRate before every navigation.
 */
const RATE = Number(process.env.E2E_MOCK_RATE) || 0;

/** Install the sweep rate BEFORE the page's modules evaluate. Not a
 *  ?rate= query param: the dev server's clean-urls redirect drops the
 *  query on /index_test.html, which left the harness quietly at 44.1k
 *  through a whole 48 kHz sweep. Call before every goto. */
async function applyRate(page) {
    if (RATE > 0) await page.addInitScript(r => {
        window.__celestrianMockRate = r;
    }, RATE);
}

/** The mock's quantum (1 s at its published sample rate). Cached PER
 *  PAGE — a module-level cache leaks one page's rate into the next,
 *  which is exactly how the stale-44.1k bug above stayed invisible. */
const qByPage = new WeakMap();
async function mockQ(page) {
    if (!qByPage.has(page)) {
        qByPage.set(page, await page.evaluate(async () => {
            const state = window.celestrian
                ? window.celestrian.getState()
                : await window.__celestrianTest.callNative('getGraphState');
            return state.perf.sampleRate;
        }));
    }
    return qByPage.get(page);
}

async function loadHarness(page, scenario) {
    await applyRate(page);
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click(`button:has-text("${scenario}")`);
    // The mock BOOTS a "Track 1" session at module load, and the app's
    // poll can paint it before (or while) the scenario click lands — so
    // "a .lane exists" may be the BOOT shell, torn down on the next
    // tick. Counting or clicking that DOM loses the interaction (the
    // fold-test flake: `before` read as 1 boot lane, fold click
    // swallowed by the swap). No scenario names a node "Track 1", so
    // wait until lanes exist AND the boot lane is gone — one tick
    // renders the whole scenario VM, so the DOM is then complete.
    await page.waitForFunction(() => {
        const lanes = [...document.querySelectorAll('.lane')];
        return lanes.length > 0 && !lanes.some(l =>
            l.querySelector('.rail-name')?.textContent === 'Track 1');
    }, { timeout: 5000 });
}

/* ---------- shared page helpers (harness page only: they read the
 * window.celestrian surface index_test.html injects; the mock-mode
 * describe drives window.__celestrianTest instead) ---------- */

/** The scenario stack's backend node (every harness scenario used here
 *  has exactly one top-level stack). */
const stackState = page => page.evaluate(() =>
    window.celestrian.getState().nodes.find(n => n.type === 'stack'));

/** The i-th clip inside the scenario stack (default: the first). */
const clipState = (page, i = 0) => page.evaluate(idx =>
    window.celestrian.getState().nodes.find(n => n.type === 'stack')
        .nodes[idx], i);

/** Press at a locator's center and drag to an absolute point WITHOUT
 *  releasing — for mid-drag assertions. REAL input, hit-tested (the
 *  2026-07-23c law: synthetic dispatch bypasses hit-testing). */
async function dragHold(page, locator, toX, toY, steps = 5) {
    const from = await locator.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps });
}

/** Full drag: center of `locator` → (toX, toY) → release. */
async function dragTo(page, locator, toX, toY, steps = 5) {
    await dragHold(page, locator, toX, toY, steps);
    await page.mouse.up();
}

/** Drag a locator by a pixel delta from its center (dial sweeps). */
async function dragBy(page, locator, dx, dy, steps = 5) {
    const b = await locator.boundingBox();
    await dragTo(page, locator,
        b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, steps);
}

/** Drag a window bracket to targetQ (of cycleQ) with a mid-Q offset that
 *  only Q-snapping can land: proves the snap, not the pointer accuracy. */
async function dragBracket(page, bracket, body, targetQ, cycleQ) {
    const box = await body.boundingBox();
    await dragTo(page, bracket,
        box.x + box.width * ((targetQ + 0.3) / cycleQ),
        box.y + box.height / 2, 6);
}

// Scenarios: each test names the harness button it loads; shapes live in
// js/mock/scenarios.js (e.g. 'Stack with 3 Clips' = one stack "Main
// Stack" with committed clips named Clip A/B/C).
test.describe('Session shell', () => {

    test('boots the harness and renders the island as lanes', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q + 3Q (LCM=12)');
        // group + 3 clips + the add-track affordance row
        await expect(page.locator('.lane')).toHaveCount(5);
        await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(1);
        await expect(page.locator('.lane-add .add-track-row-btn')).toBeVisible();
        // Ruler spans the 12Q cycle, cycle end marked ↺
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('12Q ↺');
    });

    test('reps render one take + ghosts per lane (I2 geometry)', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q + 3Q (LCM=12)');
        const lanes = page.locator('.lane[data-kind="clip"]');
        await expect(lanes).toHaveCount(3);

        // 1Q lane: 12 reps (1 take + 11 ghosts); 4Q: 3; 3Q: 4
        const repCounts = [];
        for (let i = 0; i < 3; i++) {
            repCounts.push(await lanes.nth(i).locator('.rep').count());
        }
        expect(repCounts.slice().sort((a, b) => a - b)).toEqual([3, 4, 12]);
        for (let i = 0; i < 3; i++) {
            const takes = await lanes.nth(i).locator('.rep:not(.ghost)').count();
            expect(takes).toBe(1);
        }
    });

    test('lanes share one time axis: equal Q ⇒ equal x across lanes', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q + 3Q (LCM=12)');
        // The 4Q lane's rep boundary at 4Q and the 1Q lane's 5th rep start
        // must land at the same x. Identify lanes by rep count (not DOM
        // order) and poll until the patch has fully built both lanes.
        await expect.poll(() => page.evaluate(() => {
            const lanes = [...document.querySelectorAll('.lane[data-kind="clip"]')];
            const lane4Q = lanes.find(l => l.querySelectorAll('.rep').length === 3);
            const lane1Q = lanes.find(l => l.querySelectorAll('.rep').length === 12);
            if (!lane4Q || !lane1Q) return null;
            return Math.abs(
                lane4Q.querySelectorAll('.rep')[1].getBoundingClientRect().x -
                lane1Q.querySelectorAll('.rep')[4].getBoundingClientRect().x);
        }), { timeout: 5000 }).toBeLessThan(1.5);
    });

    test('fold hides child lanes, keeps the group lane (I6b view-only)', async ({ page }) => {
        await loadHarness(page, 'Nested Stacks');
        const before = await page.locator('.lane').count();
        await page.locator('.lane[data-kind="group"]').first()
            .locator('.fold-btn').click();
        await expect(page.locator('.lane')).not.toHaveCount(before);
        const after = await page.locator('.lane').count();
        expect(after).toBeLessThan(before);
        await expect(page.locator('.lane[data-kind="group"]').first()).toBeVisible();
    });

    test('mute round-trips through the backend', async ({ page }) => {
        // (Solo is unit-covered — view_model.test.mjs 'solo and mute
        // pass through'; this spec only wires the mute button.)
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.mute-btn').click();
        await expect(firstClip.locator('.mute-btn')).toHaveClass(/on/);
        // State is the source of truth, not just the button class
        expect((await clipState(page)).isMuted).toBe(true);
    });

    test('play button and playhead: one line, in the timeline column', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q (LCM=4)');
        // Scenario loads playing; stop first to assert the hidden state
        await page.evaluate(() => window.celestrian.setIsPlaying(false));
        await expect(page.locator('#playhead')).toBeHidden();

        // The play button round-trips through the backend
        await page.click('#play-btn');
        await expect(page.locator('#play-btn')).toHaveClass(/playing/);
        expect(await page.evaluate(() => window.celestrian.getState().isPlaying)).toBe(true);

        // Deterministic position assertion: reload the scenario (which
        // resets the mock's auto-advancing transport) and drive the
        // static state setters only — no drift between set and measure
        await page.evaluate(Q => {
            window.loadScenario('example-1q-4q');
            window.celestrian.setIsPlaying(true);
            window.celestrian.setMasterPos(2 * Q);
        }, await mockQ(page));
        // Wait for the patch loop to REFLECT the state (the poll runs every
        // 50ms but can lag under test load) before measuring geometry —
        // the readout and playhead are patched together
        await expect(page.locator('#position-readout'))
            .toHaveText(/2\.0Q \/ 4Q ↺/, { timeout: 5000 });
        await expect(page.locator('#playhead')).toBeVisible();
        // 2Q of 4Q → playhead at 50% of the ruler width. Poll: the
        // playhead GLIDES (140ms transition, lockstep with the recording
        // bar's edge) — a one-shot read lands mid-flight.
        await expect.poll(() => page.evaluate(() => {
            const phX = document.getElementById('playhead').getBoundingClientRect().x;
            const r = document.getElementById('ruler').getBoundingClientRect();
            return Math.abs(phX - (r.x + r.width * 0.5));
        })).toBeLessThan(3);
    });

    test('readout shows position over cycle in Q', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q (LCM=4)');
        await page.evaluate(Q => window.celestrian.setMasterPos(2.5 * Q),
            await mockQ(page));
        await expect(page.locator('#position-readout')).toHaveText(/2\.5Q \/ 4Q ↺/);
    });

    test('bypassed loop window renders visible brackets, no dimming', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        // Give the 3Q stack a bypassed window via the backend
        const stackId = (await stackState(page)).id;
        await page.evaluate(([id, Q]) => {
            window.celestrian.callNative('setLoopPoints', id, 0, 2 * Q);
            window.celestrian.callNative('toggleLoopWindow', id); // → bypassed
        }, [stackId, await mockQ(page)]);
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-bracket.start')).toBeVisible();
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/);
        await expect(group.locator('.win-dim')).toHaveCount(0);
    });

    test('recording lane shows the growing bar and rail state', async ({ page }) => {
        await loadHarness(page, '1Q + Recording');
        const rec = page.locator('.lane .recording-bar').first();
        await expect(rec).toBeVisible();
        // The recording clip's own rail carries the cue in the SUB-LINE:
        // the live take length, pulsing record-red (owner feedback
        // 2026-08-08 — the old head-row "recording…" word squeezed the
        // name). Its group rail aggregates it as armed (Q7).
        const recLane = page.locator('.lane', { has: page.locator('.recording-bar') });
        await expect(recLane.locator('.rail-sub')).toHaveClass(/recording/);
        await expect(recLane.locator('.rail-sub')).toHaveText(/Q|rec/);
        await expect(page.locator('.lane[data-kind="group"] .rail-status'))
            .toHaveText(/armed/);

        // STATE-METRICS LAW: recording/armed state must not move the lane
        // body (a 2px state border once right-shifted all content)
        const bodies = await page.locator('.lane[data-kind="clip"] .lane-body')
            .evaluateAll(els => els.map(e => {
                const r = e.getBoundingClientRect();
                return { x: r.x, w: r.width };
            }));
        bodies.forEach(b => {
            expect(Math.abs(b.x - bodies[0].x)).toBeLessThan(0.5);
            expect(Math.abs(b.w - bodies[0].w)).toBeLessThan(0.5);
        });
    });
});

// Scenario: 'Stack with 3 Clips' — one stack, clips 'Clip A'/'B'/'C'.
test.describe('Rename (phase 3)', () => {

    test('double-click the rail name edits and round-trips through the backend', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.rail-name').dblclick();
        const input = firstClip.locator('.rail-name-input');
        await expect(input).toBeVisible();
        await input.fill('Kick');
        await input.press('Enter');
        // Display settles AND the backend holds the new name
        await expect(firstClip.locator('.rail-name')).toHaveText('Kick');
        expect((await clipState(page)).name).toBe('Kick');
    });

    test('group lanes rename too, committing on blur', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        await group.locator('.rail-name').dblclick();
        await group.locator('.rail-name-input').fill('Drum Kit');
        await page.locator('#ruler').click(); // blur commits
        await expect(group.locator('.rail-name')).toHaveText('Drum Kit');
        expect((await stackState(page)).name).toBe('Drum Kit');
    });

    test('Escape cancels without touching the backend', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.rail-name').dblclick();
        const input = firstClip.locator('.rail-name-input');
        await input.fill('Nope');
        await input.press('Escape');
        await expect(input).toHaveCount(0);
        await expect(firstClip.locator('.rail-name')).toHaveText('Clip A');
        expect((await clipState(page)).name).toBe('Clip A');
    });

    test('the 50ms patch tick never clobbers typing; space stays out of the transport', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.rail-name').dblclick();
        const input = firstClip.locator('.rail-name-input');
        await input.fill('');
        await input.pressSequentially('Snare Top', { delay: 30 });
        // Sit through several poll ticks: the editor (and its value) must
        // survive — patchRail skips the name write while renaming
        await page.waitForTimeout(300);
        await expect(input).toHaveValue('Snare Top');
        // The space typed above must not have toggled the transport
        expect(await page.evaluate(() => window.celestrian.getState().isPlaying)).toBe(false);
        await input.press('Enter');
        await expect(firstClip.locator('.rail-name')).toHaveText('Snare Top');
    });
});

// Scenario: '1Q + 3Q (Loop)' (1q-3q-loop-bug) — one stack holding a 1Q
// clip + a 3Q clip (id 'clip-3q'), Q = the mock's quantum,
// full-span loop points.
test.describe('Loop window brackets (phase 3)', () => {

    /** Give the 1Q+3Q stack a [0, 2Q) window through the backend. */
    async function setWindow(page, endSamples) {
        if (endSamples === undefined) endSamples = 2 * await mockQ(page);
        return page.evaluate(async end => {
            const stack = window.celestrian.getState().nodes.find(n => n.type === 'stack');
            await window.celestrian.callNative('setLoopPoints', stack.id, 0, end);
            return stack.id;
        }, endSamples);
    }

    test('chip click toggles active ↔ bypassed; brackets stay visible', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await setWindow(page); // active [0, 2Q): cycle shortens to 2Q (E-C)
        const group = page.locator('.lane[data-kind="group"]').first();
        const chip = group.locator('.win-chip');
        await expect(chip).toHaveText(/active/);

        await chip.click();
        await expect(chip).toHaveText(/bypassed/);
        expect((await stackState(page)).loopBypassed).toBe(true);
        // Bypassed: no dimming, brackets remain editable/visible
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await expect(group.locator('.win-bracket.start')).toBeVisible();

        await chip.click();
        await expect(chip).toHaveText(/active/);
        expect((await stackState(page)).loopBypassed).toBe(false);
    });

    test('dragging the end bracket Q-snaps and round-trips setLoopPoints', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page);
        // Bypass so the display cycle stays 3Q and both brackets sit
        // strictly inside the lane (an active 2Q window IS the 2Q cycle)
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        const group = page.locator('.lane[data-kind="group"]').first();
        const body = group.locator('.lane-body');
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/);

        // End bracket 2Q → 1Q (pointer aims at 1.3Q; the snap must land 1Q)
        await dragBracket(page, group.locator('.win-bracket.end'), body, 1, 3);
        await expect.poll(async () => (await stackState(page)).loopEnd)
            .toBe(await mockQ(page));
        expect((await stackState(page)).loopStart).toBe(0);
    });

    test('dragging the start bracket in respects the 1Q minimum window', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page);
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        const group = page.locator('.lane[data-kind="group"]').first();
        const body = group.locator('.lane-body');
        await expect(group.locator('.win-chip')).toBeVisible();

        // Start 0Q → aim past the end (2.7Q): clamps to endQ − 1 = 1Q
        await dragBracket(page, group.locator('.win-bracket.start'), body, 2.4, 3);
        await expect.poll(async () => (await stackState(page)).loopStart)
            .toBe(await mockQ(page));
        expect((await stackState(page)).loopEnd).toBe(2 * await mockQ(page));
    });

    test('an ACTIVE window never compresses the timeline (field 2026-07-11)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        const id = await setWindow(page); // ACTIVE [0, 2Q)
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-chip')).toHaveText(/active/);

        // The frame stays the intrinsic 3Q; the window dims [2Q, 3Q)
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(1);

        // Toggling bypass ↔ active must never reframe (it once breathed
        // 1Q ↔ 2Q per toggle); only the dims come and go
        await group.locator('.win-chip').click();
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/);
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await group.locator('.win-chip').click();
        await expect(group.locator('.win-chip')).toHaveText(/active/);
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(1);
    });

    test('drag feedback: handle follows the pointer; a snap ghost previews the landing', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await setWindow(page); // [0, 2Q) of a 3Q lane
        const group = page.locator('.lane[data-kind="group"]').first();
        const body = group.locator('.lane-body');
        // Wait for the REAL window's overlay (chip only exists once the
        // poll echoes it) — grabbing the transient latent bracket at
        // 100% made the pointerdown miss the settled bracket at 66.7%
        await expect(group.locator('.win-chip')).toHaveText(/active/);
        const endBracket = group.locator('.win-bracket.end:not(.latent)');
        await expect(endBracket).toBeVisible();

        // Hold mid-drag at 1.3Q: the HANDLE sits at the pointer (~43%),
        // the GHOST sits at the snapped 1Q (33.3%)
        const box = await body.boundingBox();
        await dragHold(page, endBracket,
            box.x + box.width * (1.3 / 3), box.y + box.height / 2, 4);

        const ghost = group.locator('.win-bracket.snap-ghost');
        await expect(ghost).toHaveCount(1);
        const positions = await page.evaluate(() => {
            const g = document.querySelector('.win-bracket.snap-ghost');
            const h = document.querySelector('.win-bracket.end.dragging');
            return { ghost: parseFloat(g.style.left), handle: parseFloat(h.style.left) };
        });
        expect(Math.abs(positions.ghost - 100 / 3)).toBeLessThan(0.5);   // snapped 1Q
        expect(Math.abs(positions.handle - 100 * 1.3 / 3)).toBeLessThan(2); // pointer

        // Release: ghost gone, snap committed
        await page.mouse.up();
        await expect(ghost).toHaveCount(0);
        await expect.poll(async () => (await stackState(page)).loopEnd)
            .toBe(await mockQ(page));
    });

    test('FRACTAL: clip lanes window exactly like group lanes (I5)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const clips = page.locator('.lane[data-kind="clip"]');
        const clip1Q = clips.nth(0);
        const clip3Q = clips.nth(1);
        // A 1Q lane has no sub-window to make; the 3Q lane offers latents
        await expect(clip1Q.locator('.win-bracket')).toHaveCount(0);
        await expect(clip3Q.locator('.win-bracket.latent')).toHaveCount(2);

        // Drag the clip's latent end bracket 3Q → 2Q: window created
        await dragBracket(page, clip3Q.locator('.win-bracket.end'),
            clip3Q.locator('.lane-body'), 2, 3);
        const clip3qState = () => page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack')
                .nodes.find(c => c.id === 'clip-3q'));
        await expect.poll(async () => (await clip3qState()).loopEnd)
            .toBe(2 * await mockQ(page));
        expect((await clip3qState()).windowActive).toBe(true);

        // An ACTIVE clip window rests in the HEARD view (law 13, cut
        // bands 2026-07-23): the chip names the audible loop and opens
        // the inspector — "window · active" text lives on raw-framed
        // lanes only.
        await expect(clip3Q.locator('.win-open-chip'))
            .toHaveText(/window 2Q/);

        // Bypass through the SAME engine verb groups use (fractal —
        // toggleLoopWindow works on any node since 2026-07-11): the raw
        // frame returns with the toggle chip.
        await page.evaluate(() =>
            window.celestrian.callNative('toggleLoopWindow', 'clip-3q'));
        const chip = clip3Q.locator('.win-chip');
        await expect(chip).toHaveText(/bypassed/);
        expect((await clip3qState()).loopBypassed).toBe(true);

        // And that chip IS the bypass toggle, exactly like a group's:
        // clicking it re-activates and the lane rests heard again.
        await chip.click();
        await expect(clip3Q.locator('.win-open-chip'))
            .toHaveText(/window 2Q/);
        expect((await clip3qState()).loopBypassed).toBe(false);
    });

    test('window cursor: the heard-time playhead loops inside the brackets', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page); // stack window [0, 2Q), ACTIVE
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-cursor')).toBeVisible();

        // masterPos 1.5Q → window phase (1.5 mod 2)/2 = 0.75 → heard
        // position 1.5Q of the 3Q frame = 50%
        await page.evaluate(Q => window.celestrian.setMasterPos(1.5 * Q),
            await mockQ(page));
        await expect.poll(() => page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left))).toBeGreaterThan(49);
        expect(await page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left))).toBeLessThan(51);

        // Raw transport past the window: the VIEW wraps at the audible
        // cycle (E-C) — both clocks land at 0.5Q (16.7%); with a sole
        // windowed lane, white and amber coincide by construction
        await page.evaluate(Q => window.celestrian.setMasterPos(2.5 * Q),
            await mockQ(page));
        await expect.poll(() => page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left))).toBeLessThan(18);

        // Not playing → no cursor; bypassed → no cursor element at all
        await page.evaluate(() => window.celestrian.setIsPlaying(false));
        await expect(group.locator('.win-cursor')).toBeHidden();
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        await expect(group.locator('.win-cursor')).toHaveCount(0);
    });

    test('E-C: the playhead never sails past an active window (field 2026-07-11)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page); // [0, 2Q) of the sole 3Q stack
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-chip')).toHaveText(/active/);

        // Raw transport at 2.5Q: the published view wraps at the AUDIBLE
        // cycle (2Q) → 0.5Q. The readout explains the early wrap.
        await page.evaluate(Q => window.celestrian.setMasterPos(2.5 * Q),
            await mockQ(page));
        await expect(page.locator('#position-readout'))
            .toHaveText(/0\.5Q \/ 3Q ↺ · loop 2Q/);
        // Playhead sits at 0.5Q of the 3Q frame (~16.7%), inside the window
        await expect.poll(() => page.evaluate(() => {
            const phX = document.getElementById('playhead').getBoundingClientRect().x;
            const r = document.getElementById('ruler').getBoundingClientRect();
            return (phX - r.x) / r.width;
        })).toBeLessThan(0.67); // never past the 2Q bracket

        // Bypass: full 3Q cycle again, loop note gone
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        await expect(page.locator('#position-readout'))
            .toHaveText(/2\.5Q \/ 3Q ↺(?! · loop)/);
    });

    test('the playhead sweep TOUCHES the loop end before wrapping (dead-reckoning)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await setWindow(page); // audible cycle 2Q of a 3Q frame (Q = 1s)
        // Real-time transport: scenario loads isPlaying but not
        // auto-advancing; toggle off and on so the mock transport runs
        await page.evaluate(async () => {
            await window.celestrian.callNative('togglePlayback'); // stop
            await window.celestrian.callNative('togglePlayback'); // run
        });
        await expect(page.locator('#playhead')).toBeVisible();

        // Sample the rendered playhead at frame rate for one full loop
        // + 30% margin. The window is WALL-CLOCK, so it must be sized
        // from how fast the mock simulates audio, not from the device
        // rate: the clock steps a fixed sample count per poll, so a 2Q
        // loop takes 2Q / SIMULATED_SAMPLES_PER_SECOND seconds — which
        // grows with Q. (Hardcoded 2600 ms, it timed out at 96 kHz.)
        const loopMs = await page.evaluate(Q =>
            (2 * Q / window.celestrian.SIMULATED_SAMPLES_PER_SECOND) * 1000,
            await mockQ(page));
        const samples = await page.evaluate(windowMs => new Promise(res => {
            const out = [];
            const t0 = performance.now();
            (function tick() {
                const r = document.getElementById('ruler').getBoundingClientRect();
                const x = document.getElementById('playhead').getBoundingClientRect().x;
                out.push((x - r.x) / r.width); // fraction of the 3Q frame
                if (performance.now() - t0 < windowMs) requestAnimationFrame(tick);
                else res(out);
            })();
        }), Math.round(loopMs * 1.3));
        const boundary = 2 / 3; // the 2Q loop end in the 3Q frame
        // The sweep must REACH the loop end (was wrapping ~5% early)…
        expect(Math.max(...samples)).toBeGreaterThan(boundary - 0.05);
        // …never pass it…
        expect(Math.max(...samples)).toBeLessThan(boundary + 0.02);
        // …and restart near ZERO (was restarting visibly offset)
        for (let i = 1; i < samples.length; i++) {
            if (samples[i] < samples[i - 1] - boundary / 2) {
                expect(samples[i - 1]).toBeGreaterThan(boundary - 0.05);
                expect(samples[i]).toBeLessThan(0.06);
                return;
            }
        }
        throw new Error(`no wrap observed in ${Math.round(loopMs * 1.3)}ms ` +
            `of a ${Math.round(loopMs)}ms loop`);
    });

    test('latent brackets: dragging in CREATES a window on a group lane', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        // Full-span loop points → no window → latent brackets only
        const group = page.locator('.lane[data-kind="group"]').first();
        const body = group.locator('.lane-body');
        await expect(group.locator('.win-bracket.latent')).toHaveCount(2);
        await expect(group.locator('.win-chip')).toHaveCount(0);

        // Drag the latent end bracket 3Q → 2Q: the window becomes real
        await dragBracket(page, group.locator('.win-bracket.end'), body, 2, 3);
        await expect.poll(async () => (await stackState(page)).loopEnd)
            .toBe(2 * await mockQ(page));
        expect((await stackState(page)).windowActive).toBe(true);
        // The settled overlay shows a real (non-latent) window + chip
        await expect(group.locator('.win-bracket.start:not(.latent)')).toHaveCount(1);
        await expect(group.locator('.win-chip')).toHaveText(/active/);
    });
});

// Scenario: 'Stack with 3 Clips' — clips sit on inputChannel 0; the
// mock's active audio device exposes 2 channels ("USB Audio Device").
test.describe('Input picker (phase 3)', () => {

    test('chip on clip lanes only; picking an input round-trips setNodeInput', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        const chip = firstClip.locator('.input-btn');
        await expect(chip).toHaveText('in 1'); // scenario clips sit on channel 0
        // A group has no input of its own (Q7)
        await expect(page.locator('.lane[data-kind="group"] .input-btn')).toHaveCount(0);

        await chip.click();
        const menu = page.locator('.input-menu');
        // Input names derive from the mock's ACTIVE audio device (the
        // device-panel model): "Microphone (USB Audio Device)" exposes 2
        // channels → two in the LEFT list + "· mono" + two in the RIGHT
        // (stereo pair) list.
        await expect(menu.locator('.input-item')).toHaveCount(5);
        await expect(menu.locator('.input-item.current').first())
            .toHaveText(/USB Audio Device\) 1/);

        await menu.locator('.input-item', { hasText: '(USB Audio Device) 2' })
            .first().click();
        await expect(menu).toHaveCount(0); // picking closes the menu
        await expect(chip).toHaveText('in 2');
        expect((await clipState(page)).inputChannel).toBe(1);
    });

    test('stereo pair: picking a right input round-trips setNodeInputRight', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        const chip = firstClip.locator('.input-btn');

        await chip.click();
        const menu = page.locator('.input-menu');
        // The RIGHT list is everything after "· mono": pick channel 1
        // (nth(1) — the left list's channel 1 is nth(0)).
        await menu.locator('.input-item', { hasText: '(USB Audio Device) 1' })
            .nth(1).click();
        await expect(menu).toHaveCount(0);
        await expect(chip).toHaveText('1/1'); // L=ch1, R=ch1
        expect((await clipState(page)).inputChannelR).toBe(0);

        // "· mono" clears the pair
        await chip.click();
        await page.locator('.input-menu .input-item', { hasText: 'mono' }).click();
        await expect(chip).toHaveText('in 1');
        expect((await clipState(page)).inputChannelR).toBe(-1);
    });

    test('menu dismisses on Escape and outside press, changing nothing', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const chip = page.locator('.lane[data-kind="clip"]').first().locator('.input-btn');

        await chip.click();
        await expect(page.locator('.input-menu')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('.input-menu')).toHaveCount(0);

        await chip.click();
        await expect(page.locator('.input-menu')).toHaveCount(1);
        await page.locator('#ruler').click();
        await expect(page.locator('.input-menu')).toHaveCount(0);

        await expect(chip).toHaveText('in 1'); // untouched
        expect((await clipState(page)).inputChannel).toBe(0);
    });

    test('a recording lane cannot switch input mid-take', async ({ page }) => {
        await loadHarness(page, '1Q + Recording');
        const recLane = page.locator('.lane', { has: page.locator('.recording-bar') });
        await expect(recLane.locator('.input-btn')).toBeDisabled();
        // Its committed sibling still can
        const committed = page.locator('.lane[data-kind="clip"]').first();
        await expect(committed.locator('.input-btn')).toBeEnabled();
    });
});

// Scenario: '1Q + 4Q (LCM=4)' (example-1q-4q) — a stack with committed
// 1Q + 4Q clips (the 1Q lane ghosts across the 4Q frame).
test.describe('One-shot toggle (period source, Q5)', () => {

    test('1× drops the ghosts; toggling back restores the loop; undoable', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q (LCM=4)');
        // The 1Q lane loops across the 4Q frame: take tile + 3 ghosts.
        const lane = page.locator('.lane[data-kind="clip"]').first();
        await expect(lane.locator('.rep.ghost')).toHaveCount(3);

        const ps = lane.locator('.oneshot-btn');
        await expect(ps).toHaveText('↺');
        await ps.click();

        // One-shot: only the take tile remains, dashed lane styling on,
        // the state knob round-trips, and the 4Q frame is untouched.
        await expect(ps).toHaveText('1×');
        await expect(lane.locator('.rep.ghost')).toHaveCount(0);
        await expect(lane.locator('.lane-body')).toHaveClass(/one-shot/);
        expect((await clipState(page)).periodSource).toBe('context');
        await expect(page.locator('#ruler .tick-label').last())
            .toHaveText(/4Q/); // the one-shot never extends the frame

        // A musical fact: ⌘Z takes it back.
        await page.keyboard.press(process.platform === 'darwin'
            ? 'Meta+z' : 'Control+z');
        await expect(ps).toHaveText('↺');
        await expect(lane.locator('.rep.ghost')).toHaveCount(3);
    });

    test('groups have no period-source toggle', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        await expect(page.locator('.lane[data-kind="group"] .oneshot-btn'))
            .toHaveCount(0);
    });
});

// Scenario: 'Stack with 3 Clips' — clips born at unity gain.
test.describe('Gain dial (volume fader)', () => {

    const clipGain = async page => (await clipState(page)).gain;

    test('vertical drag lowers the fader; double-click restores unity', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const dial = page.locator('.lane[data-kind="clip"]').first()
            .locator('.gain-dial');
        await expect(dial).toBeVisible();

        // 75px is the full dial sweep, so ~38px down lands near half
        // volume (dragBy is real, hit-tested input).
        await dragBy(page, dial, 0, 38);
        const dragged = await clipGain(page);
        expect(dragged).toBeLessThan(0.75);
        expect(dragged).toBeGreaterThan(0.2);
        await expect(dial).toHaveClass(/off-center/);

        // Double-click restores unity (the resting state — no boost).
        await dial.dblclick();
        await expect.poll(() => clipGain(page)).toBe(1);
        await expect(dial).not.toHaveClass(/off-center/);
    });

    test('groups have faders too (fractal)', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const dial = page.locator('.lane[data-kind="group"]').first()
            .locator('.gain-dial');
        await expect(dial).toBeVisible();
        await dragBy(page, dial, 0, 75); // the full sweep → silence
        expect((await stackState(page)).gain).toBe(0);
    });
});

// Scenario: 'Stack with 3 Clips' — the fixed 4-card rack (eq /
// compressor / echo / reverb), everything off at load.
test.describe('Effects rack (built-ins)', () => {

    const clipFx = async page => (await clipState(page)).effects;

    test('fx chip expands the rack; enable and params round-trip', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await expect(firstClip.locator('.fx-btn')).toHaveText('fx');

        await firstClip.locator('.fx-btn').click();
        const fxRow = page.locator('.lane-fx');
        await expect(fxRow).toHaveCount(1);
        await expect(fxRow.locator('.fx-card')).toHaveCount(4); // the fixed rack

        // Power on the echo: backend flag flips, card lights, chip counts
        await fxRow.locator('.fx-card[data-fx="echo"] .fx-power').click();
        await expect.poll(async () => (await clipFx(page)).echo.enabled).toBe(true);
        await expect(fxRow.locator('.fx-card[data-fx="echo"]')).not.toHaveClass(/off/);
        await expect(firstClip.locator('.fx-btn')).toHaveText('fx·1');

        // Drag-equivalent: set the mix slider → setEffectParam round-trips
        await fxRow.locator('.fx-card[data-fx="echo"] input[data-key="mix"]')
            .evaluate(el => {
                el.value = '0.8';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
        await expect.poll(async () => (await clipFx(page)).echo.mix).toBe(0.8);
        await expect(fxRow.locator('.fx-card[data-fx="echo"] .fx-param-value')
            .nth(2)).toHaveText('80%');

        // Chip again: panel folds away, state stays
        await firstClip.locator('.fx-btn').click();
        await expect(page.locator('.lane-fx')).toHaveCount(0);
        expect((await clipFx(page)).echo.enabled).toBe(true);
    });

    test('groups have racks too (fractal): reverb on the whole kit', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        await group.locator('.fx-btn').click();
        await expect(page.locator('.lane-fx')).toHaveCount(1);

        await page.locator('.fx-card[data-fx="reverb"] .fx-power').click();
        await expect.poll(async () => (await stackState(page)).effects.reverb.enabled).toBe(true);
        await expect(group.locator('.fx-btn')).toHaveText('fx·1');
    });

    test('visualizations: every card draws; comp shows GR while crushing', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.fx-btn').click();
        const fxRow = page.locator('.lane-fx');
        await expect(fxRow.locator('canvas.fx-viz')).toHaveCount(4);

        // Enable the compressor and put the transport somewhere loud
        // (mock scope peak ≈ 0.65 → well above the −18 dB threshold)
        await fxRow.locator('.fx-card[data-fx="compressor"] .fx-power').click();
        await page.evaluate(() => {
            window.celestrian.setIsPlaying(true);
            window.celestrian.setMasterPos(24568); // sin phase ≈ 1
        });
        // The engine-parity scope publishes a positive gain reduction…
        await expect.poll(async () => (await clipState(page)).effects.scope.gr).toBeGreaterThan(1);
        // …and the card's readout shows it
        await expect(fxRow.locator('.fx-card[data-fx="compressor"] .fx-gr'))
            .toHaveText(/dB/);

        // Canvases actually paint (non-zero backing store, drawn pixels)
        const painted = await fxRow.locator('.fx-card[data-fx="compressor"] .fx-viz')
            .evaluate(c => {
                const ctx = c.getContext('2d');
                const px = ctx.getImageData(0, 0, c.width, c.height).data;
                for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return true;
                return false;
            });
        expect(painted).toBe(true);
    });

    test('the 50ms tick never fights a slider being dragged', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        await page.locator('.lane[data-kind="clip"]').first()
            .locator('.fx-btn').click();
        const slider = page.locator('.fx-card[data-fx="eq"] input[data-key="low"]');
        await expect(slider).toBeVisible();
        // Hold the slider "hot" and give it a local value; several polls
        // must not clobber it while held
        await slider.evaluate(el => {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            el.value = '7';
        });
        await page.waitForTimeout(300);
        await expect(slider).toHaveValue('7');
        await slider.evaluate(el =>
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    });
});

// Mock mode (/?mock=true): drives the REAL backend facade through
// window.__celestrianTest (backend.js) with scenario IDS, not harness
// buttons — window.celestrian and the helpers above don't exist here.
test.describe('Session shell (mock mode)', () => {

    test.beforeEach(async ({ page }) => {
        await applyRate(page);
        await page.goto('/?mock=true');
        await page.waitForFunction(
            () => typeof window.__celestrianTest?.loadScenario === 'function',
            { timeout: 5000 });
    });

    test('empty session shows the empty state', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(page.locator('.lane')).toHaveCount(0);
    });

    test('deep playback position stays in the cycle frame', async ({ page }) => {
        await page.evaluate(Q => {
            window.__celestrianTest.loadScenario('example-1q-4q');
            // 25 cycles + 1.5Q deep, in the mock's own quantum
            window.__celestrianTest.setMasterPos((25 * 4 + 1.5) * Q);
            window.__celestrianTest.setIsPlaying(true);
        }, await mockQ(page));
        await expect(page.locator('#position-readout')).toHaveText(/1\.5Q \/ 4Q ↺/);
    });

    test('FIRST TAKE: ＋ Track → arm → stop → committed take', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        await expect(page.locator('#empty-state')).toBeVisible();

        // Build the session from the chrome alone — the core journey
        // (owner ruling 2026-07-19h): ＋ Track, then hit ITS ●. There
        // is no global record button; the track's ● is the record verb.
        await page.click('#create-track-btn');
        const clipLane = page.locator('.lane[data-kind="clip"]');
        await expect(clipLane).toHaveCount(1);
        await expect(clipLane.locator('.rail-sub')).toHaveText('empty');

        // The empty track's ● is enabled; a full track's would not be
        const armBtn = clipLane.locator('.arm-btn');
        await expect(armBtn).toBeEnabled();
        await armBtn.click();
        // Armed shows as the head-row word; once audio flows the cue is
        // the pulsing sub-line length (the head row stays quiet).
        await expect.poll(() => page.evaluate(() => {
            const lane = document.querySelector('.lane[data-kind="clip"]');
            return lane.querySelector('.rail-status').textContent +
                (lane.querySelector('.rail-sub').classList.contains('recording')
                    ? ' recording' : '');
        })).toMatch(/armed|recording/);

        // Let 2Q of "audio" pass, then stop from the same button
        await page.evaluate(Q => window.__celestrianTest.setMasterPos(2 * Q),
            await mockQ(page));
        await armBtn.click();

        // The take commits: one solid rep, rail shows a period, ● disables
        await expect(clipLane.locator('.rep:not(.ghost)')).toHaveCount(1);
        await expect(armBtn).toBeDisabled(); // arm targets emptiness (Q7)
    });

    test('DRUM FLOW: group ● records all empty tracks, full ones play (Q7)', async ({ page }) => {
        // Kit: 3 tracks with takes + 2 empty tracks in one stack
        await page.evaluate(async () => {
            window.__celestrianTest.loadScenario('stack-with-clips');
            const call = window.__celestrianTest.callNative;
            const stack = (await call('getGraphState')).nodes.find(n => n.type === 'stack');
            await call('createNode', 'clip', stack.id);
            await call('createNode', 'clip', stack.id);
        });
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(5);

        // The GROUP's ● is the drum-mic verb (owner ruling 2026-07-19h:
        // there is no global record button): both empty tracks record,
        // the three full ones are untouched.
        const groupArm = page.locator('.lane[data-kind="group"] .arm-btn').first();
        await expect(groupArm).toBeEnabled();
        await groupArm.click();
        await expect.poll(() => page.evaluate(async () => {
            const s = (await window.__celestrianTest.callNative('getGraphState'))
                .nodes.find(n => n.type === 'stack');
            return s.nodes.map(c => !!c.isRecording).join(',');
        })).toBe('false,false,false,true,true');
        await expect(page.locator('.lane[data-kind="group"] .rail-status').first())
            .toHaveText(/armed|recording|map live/);

        // Group ● again stops both: the stop request enters
        // awaiting-stop; the takes commit as the transport crosses the
        // next boundary (stops always pad forward — owner ruling)
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Math.round(0.6 * Q)),
            await mockQ(page));
        await groupArm.click();
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Math.round(0.5 * Q)),
            await mockQ(page));
        await expect.poll(() => page.evaluate(async () => {
            const s = (await window.__celestrianTest.callNative('getGraphState'))
                .nodes.find(n => n.type === 'stack');
            return s.nodes.some(c => c.isRecording);
        })).toBe(false);
    });

    test('all-full island: group ● disables; a fresh track records (Q7)', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('example-1q-4q'));
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);

        // Arm targets EMPTINESS: with every track full, the group's ●
        // has nothing to record and disables. (The old global-● verb
        // "record into a fresh track" left with the global button —
        // owner ruling 2026-07-19h; adding the track is now explicit.)
        const groupArm = page.locator('.lane[data-kind="group"] .arm-btn').first();
        await expect(groupArm).toBeDisabled();

        // The modern flow: ＋ Add track, then ITS ●.
        await page.locator('.lane-add .add-track-row-btn').click();
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3);
        const fresh = page.locator('.lane[data-kind="clip"]').nth(2);
        await expect(fresh.locator('.arm-btn')).toBeEnabled();
        await fresh.locator('.arm-btn').click();
        await expect.poll(() => page.evaluate(() => {
            const lane = document.querySelectorAll('.lane[data-kind="clip"]')[2];
            return lane.querySelector('.rail-status').textContent +
                (lane.querySelector('.rail-sub').classList.contains('recording')
                    ? ' recording' : '');
        })).toMatch(/armed|recording/);
        // Once the transport crosses the Q11 boundary and audio flows,
        // the bar takes over (scenario sits at ~0.5Q: 0.5Q to the arm
        // point, then some audio)
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Math.round(0.8 * Q)),
            await mockQ(page));
        await expect(page.locator('.lane .recording-bar')).toHaveCount(1);
    });

    test('NO FLASH: committing a take must not destroy other lanes\' DOM', async ({ page }) => {
        // Build: 1Q committed take, then record a second track past 1Q
        // — through the current chrome (＋ Track + the per-track ●).
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        await page.click('#create-track-btn');
        await page.locator('.lane[data-kind="clip"] .arm-btn').click();
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Q),
            await mockQ(page));
        await page.locator('.lane[data-kind="clip"] .arm-btn').click();
        await expect(page.locator('.lane[data-kind="clip"] .rep')).toHaveCount(1);

        await page.click('#create-track-btn');
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
        await page.locator('.lane[data-kind="clip"]').nth(1).locator('.arm-btn').click();
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Math.round(1.5 * Q)),
            await mockQ(page));
        await expect(page.locator('.recording-bar')).toBeVisible();

        // Mark clip 1's rep div and its canvas before the commit
        await page.evaluate(() => {
            const rep = document.querySelectorAll('.lane[data-kind="clip"]')[0]
                .querySelector('.rep');
            window.__keepRep = rep;
            window.__keepCanvas = rep.querySelector('canvas');
        });

        // Stop mid-Q: the take enters AWAITING-STOP (stops always pad
        // forward — owner ruling) and commits at the 2Q boundary as the
        // transport crosses it. The frame settles 1Q → 2Q, everything
        // re-lays-out — but clip 1's rep div and canvas must SURVIVE
        // (destroy-and-recreate rendered as a global pop in the field)
        await page.locator('.lane[data-kind="clip"]').nth(1).locator('.arm-btn').click();
        // Awaiting-stop reads on the sub-line: the live length gains a
        // trailing ellipsis ("1.5Q…") while the take pads to the boundary.
        await expect(page.locator('.lane[data-kind="clip"]').nth(1)
            .locator('.rail-sub')).toHaveText(/…$/);
        await page.evaluate(Q => window.__celestrianTest.advanceBy(Math.round(0.5 * Q) + 10),
            await mockQ(page));
        await expect(page.locator('#position-readout')).toHaveText(/2Q ↺/);

        const survived = await page.evaluate(() => ({
            repConnected: window.__keepRep.isConnected,
            canvasConnected: window.__keepCanvas.isConnected,
            repStillFirst: window.__keepRep ===
                document.querySelectorAll('.lane[data-kind="clip"]')[0].querySelector('.rep'),
        }));
        expect(survived).toEqual({
            repConnected: true, canvasConnected: true, repStillFirst: true,
        });
    });

    test('group arm aggregate appears on the rail (Q7)', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        // Create an empty clip in the stack, then arm it via the backend
        const clipId = await page.evaluate(async () => {
            const s = (await window.__celestrianTest.callNative('getGraphState'))
                .nodes.find(n => n.type === 'stack');
            return window.__celestrianTest.callNative('createNode', 'clip', s.id);
        });
        await page.evaluate(id => window.__celestrianTest.callNative('startRecordingInNode', id), clipId);
        await expect(page.locator('.lane[data-kind="group"] .rail-status'))
            .toHaveText(/armed|recording/);
    });
});
