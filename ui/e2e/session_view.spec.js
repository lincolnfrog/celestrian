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

async function loadHarness(page, scenario) {
    await page.goto('/index_test.html');
    await page.waitForSelector('#test-controls', { timeout: 5000 });
    await page.click(`button:has-text("${scenario}")`);
    await page.waitForSelector('.lane', { timeout: 5000 });
}

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
        await expect(page.locator('.lane')).not.toHaveCount(before, { timeout: 3000 });
        const after = await page.locator('.lane').count();
        expect(after).toBeLessThan(before);
        await expect(page.locator('.lane[data-kind="group"]').first()).toBeVisible();
    });

    test('mute and solo round-trip through the backend', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await firstClip.locator('.mute-btn').click();
        await expect(firstClip.locator('.mute-btn')).toHaveClass(/on/, { timeout: 3000 });
        // State is the source of truth, not just the button class
        const muted = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack')
                .nodes[0].isMuted);
        expect(muted).toBe(true);
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
        await page.evaluate(() => {
            window.loadScenario('example-1q-4q');
            window.celestrian.setIsPlaying(true);
            window.celestrian.setMasterPos(88200); // 2Q @44.1k
        });
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
        }), { timeout: 3000 }).toBeLessThan(3);
    });

    test('readout shows position over cycle in Q', async ({ page }) => {
        await loadHarness(page, '1Q + 4Q (LCM=4)');
        await page.evaluate(() => window.celestrian.setMasterPos(110250)); // 2.5Q
        await expect(page.locator('#position-readout')).toHaveText(/2\.5Q \/ 4Q ↺/, { timeout: 3000 });
    });

    test('bypassed loop window renders visible brackets, no dimming', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        // Give the 3Q stack a bypassed window via the backend
        await page.evaluate(() => {
            const stack = window.celestrian.getState().nodes.find(n => n.type === 'stack');
            window.celestrian.callNative('setLoopPoints', stack.id, 0, 88200);
            window.celestrian.callNative('toggleLoopWindow', stack.id); // → bypassed
        });
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-bracket.start')).toBeVisible({ timeout: 3000 });
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/);
        await expect(group.locator('.win-dim')).toHaveCount(0);
    });

    test('recording lane shows the growing bar and rail state', async ({ page }) => {
        await loadHarness(page, '1Q + Recording');
        const rec = page.locator('.lane .recording-bar').first();
        await expect(rec).toBeVisible();
        // The recording clip's own rail says "recording…"; its group rail
        // aggregates it as armed (Q7) — assert both
        const recLane = page.locator('.lane', { has: page.locator('.recording-bar') });
        await expect(recLane.locator('.rail-status')).toHaveText(/recording/);
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
        await expect(firstClip.locator('.rail-name')).toHaveText('Kick', { timeout: 3000 });
        const name = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack').nodes[0].name);
        expect(name).toBe('Kick');
    });

    test('group lanes rename too, committing on blur', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        await group.locator('.rail-name').dblclick();
        await group.locator('.rail-name-input').fill('Drum Kit');
        await page.locator('#ruler').click(); // blur commits
        await expect(group.locator('.rail-name')).toHaveText('Drum Kit', { timeout: 3000 });
        const name = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack').name);
        expect(name).toBe('Drum Kit');
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
        const name = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack').nodes[0].name);
        expect(name).toBe('Clip A');
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
        await expect(firstClip.locator('.rail-name')).toHaveText('Snare Top', { timeout: 3000 });
    });
});

test.describe('Loop window brackets (phase 3)', () => {

    /** Give the 1Q+3Q stack a [0, 2Q) window through the backend. */
    async function setWindow(page, endSamples = 88200) {
        return page.evaluate(async end => {
            const stack = window.celestrian.getState().nodes.find(n => n.type === 'stack');
            await window.celestrian.callNative('setLoopPoints', stack.id, 0, end);
            return stack.id;
        }, endSamples);
    }
    const stackState = page => page.evaluate(() =>
        window.celestrian.getState().nodes.find(n => n.type === 'stack'));

    /** Drag a bracket to targetQ (of cycleQ) with a mid-Q offset that only
     *  Q-snapping can land: proves the snap, not the pointer accuracy. */
    async function dragBracket(page, bracket, body, targetQ, cycleQ) {
        const from = await bracket.boundingBox();
        const box = await body.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * ((targetQ + 0.3) / cycleQ),
            box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
    }

    test('chip click toggles active ↔ bypassed; brackets stay visible', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await setWindow(page); // active [0, 2Q): cycle shortens to 2Q (E-C)
        const group = page.locator('.lane[data-kind="group"]').first();
        const chip = group.locator('.win-chip');
        await expect(chip).toHaveText(/active/, { timeout: 3000 });

        await chip.click();
        await expect(chip).toHaveText(/bypassed/, { timeout: 3000 });
        expect((await stackState(page)).loopBypassed).toBe(true);
        // Bypassed: no dimming, brackets remain editable/visible
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await expect(group.locator('.win-bracket.start')).toBeVisible();

        await chip.click();
        await expect(chip).toHaveText(/active/, { timeout: 3000 });
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
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/, { timeout: 3000 });

        // End bracket 2Q → 1Q (pointer aims at 1.3Q; the snap must land 1Q)
        await dragBracket(page, group.locator('.win-bracket.end'), body, 1, 3);
        await expect.poll(async () => (await stackState(page)).loopEnd,
            { timeout: 3000 }).toBe(44100);
        expect((await stackState(page)).loopStart).toBe(0);
    });

    test('dragging the start bracket in respects the 1Q minimum window', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page);
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        const group = page.locator('.lane[data-kind="group"]').first();
        const body = group.locator('.lane-body');
        await expect(group.locator('.win-chip')).toBeVisible({ timeout: 3000 });

        // Start 0Q → aim past the end (2.7Q): clamps to endQ − 1 = 1Q
        await dragBracket(page, group.locator('.win-bracket.start'), body, 2.4, 3);
        await expect.poll(async () => (await stackState(page)).loopStart,
            { timeout: 3000 }).toBe(44100);
        expect((await stackState(page)).loopEnd).toBe(88200);
    });

    test('an ACTIVE window never compresses the timeline (field 2026-07-11)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        const id = await setWindow(page); // ACTIVE [0, 2Q)
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-chip')).toHaveText(/active/, { timeout: 3000 });

        // The frame stays the intrinsic 3Q; the window dims [2Q, 3Q)
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(1);

        // Toggling bypass ↔ active must never reframe (it once breathed
        // 1Q ↔ 2Q per toggle); only the dims come and go
        await group.locator('.win-chip').click();
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/, { timeout: 3000 });
        await expect(page.locator('#ruler .tick-label').last()).toHaveText('3Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await group.locator('.win-chip').click();
        await expect(group.locator('.win-chip')).toHaveText(/active/, { timeout: 3000 });
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
        await expect(group.locator('.win-chip')).toHaveText(/active/, { timeout: 3000 });
        const endBracket = group.locator('.win-bracket.end:not(.latent)');
        await expect(endBracket).toBeVisible({ timeout: 3000 });

        // Hold mid-drag at 1.3Q: the HANDLE sits at the pointer (~43%),
        // the GHOST sits at the snapped 1Q (33.3%)
        const from = await endBracket.boundingBox();
        const box = await body.boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * (1.3 / 3), box.y + box.height / 2, { steps: 4 });

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
        await expect.poll(async () => (await stackState(page)).loopEnd,
            { timeout: 3000 }).toBe(44100);
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
        const clipState = () => page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack')
                .nodes.find(c => c.id === 'clip-3q'));
        await expect.poll(async () => (await clipState()).loopEnd,
            { timeout: 3000 }).toBe(88200);
        expect((await clipState()).windowActive).toBe(true);

        // Same chip, same toggle as a group window — on a CLIP
        const chip = clip3Q.locator('.win-chip');
        await expect(chip).toHaveText(/active/, { timeout: 3000 });
        await chip.click();
        await expect(chip).toHaveText(/bypassed/, { timeout: 3000 });
        expect((await clipState()).loopBypassed).toBe(true);
    });

    test('window cursor: the heard-time playhead loops inside the brackets', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page); // stack window [0, 2Q), ACTIVE
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-cursor')).toBeVisible({ timeout: 3000 });

        // masterPos 1.5Q → window phase (1.5 mod 2)/2 = 0.75 → heard
        // position 1.5Q of the 3Q frame = 50%
        await page.evaluate(() => window.celestrian.setMasterPos(1.5 * 44100));
        await expect.poll(() => page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left)),
            { timeout: 3000 }).toBeGreaterThan(49);
        expect(await page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left))).toBeLessThan(51);

        // Raw transport past the window: the VIEW wraps at the audible
        // cycle (E-C) — both clocks land at 0.5Q (16.7%); with a sole
        // windowed lane, white and amber coincide by construction
        await page.evaluate(() => window.celestrian.setMasterPos(2.5 * 44100));
        await expect.poll(() => page.evaluate(() =>
            parseFloat(document.querySelector('.win-cursor').style.left)),
            { timeout: 3000 }).toBeLessThan(18);

        // Not playing → no cursor; bypassed → no cursor element at all
        await page.evaluate(() => window.celestrian.setIsPlaying(false));
        await expect(group.locator('.win-cursor')).toBeHidden({ timeout: 3000 });
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        await expect(group.locator('.win-cursor')).toHaveCount(0, { timeout: 3000 });
    });

    test('E-C: the playhead never sails past an active window (field 2026-07-11)', async ({ page }) => {
        await loadHarness(page, '1Q + 3Q (Loop)');
        const id = await setWindow(page); // [0, 2Q) of the sole 3Q stack
        const group = page.locator('.lane[data-kind="group"]').first();
        await expect(group.locator('.win-chip')).toHaveText(/active/, { timeout: 3000 });

        // Raw transport at 2.5Q: the published view wraps at the AUDIBLE
        // cycle (2Q) → 0.5Q. The readout explains the early wrap.
        await page.evaluate(() => window.celestrian.setMasterPos(2.5 * 44100));
        await expect(page.locator('#position-readout'))
            .toHaveText(/0\.5Q \/ 3Q ↺ · loop 2Q/, { timeout: 3000 });
        // Playhead sits at 0.5Q of the 3Q frame (~16.7%), inside the window
        await expect.poll(() => page.evaluate(() => {
            const phX = document.getElementById('playhead').getBoundingClientRect().x;
            const r = document.getElementById('ruler').getBoundingClientRect();
            return (phX - r.x) / r.width;
        }), { timeout: 3000 }).toBeLessThan(0.67); // never past the 2Q bracket

        // Bypass: full 3Q cycle again, loop note gone
        await page.evaluate(i => window.celestrian.callNative('toggleLoopWindow', i), id);
        await expect(page.locator('#position-readout'))
            .toHaveText(/2\.5Q \/ 3Q ↺(?! · loop)/, { timeout: 3000 });
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
        await expect(page.locator('#playhead')).toBeVisible({ timeout: 3000 });

        // Sample the rendered playhead at frame rate for ~2.6s (one
        // full 2s loop + margin) and check the sweep's extremes
        const samples = await page.evaluate(() => new Promise(res => {
            const out = [];
            const t0 = performance.now();
            (function tick() {
                const r = document.getElementById('ruler').getBoundingClientRect();
                const x = document.getElementById('playhead').getBoundingClientRect().x;
                out.push((x - r.x) / r.width); // fraction of the 3Q frame
                if (performance.now() - t0 < 2600) requestAnimationFrame(tick);
                else res(out);
            })();
        }));
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
        throw new Error('no wrap observed in 2.6s of a 2s loop');
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
        await expect.poll(async () => (await stackState(page)).loopEnd,
            { timeout: 3000 }).toBe(88200);
        expect((await stackState(page)).windowActive).toBe(true);
        // The settled overlay shows a real (non-latent) window + chip
        await expect(group.locator('.win-bracket.start:not(.latent)')).toHaveCount(1, { timeout: 3000 });
        await expect(group.locator('.win-chip')).toHaveText(/active/);
    });
});

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
        await expect(menu.locator('.input-item')).toHaveCount(2); // mock device
        await expect(menu.locator('.input-item.current')).toHaveText(/Built-in Microphone/);

        await menu.locator('.input-item', { hasText: 'External Audio' }).click();
        await expect(menu).toHaveCount(0); // picking closes the menu
        await expect(chip).toHaveText('in 2', { timeout: 3000 });
        const ch = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack').nodes[0].inputChannel);
        expect(ch).toBe(1);
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
        const ch = await page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack').nodes[0].inputChannel);
        expect(ch).toBe(0);
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

test.describe('Effects rack (built-ins)', () => {

    const clipFx = page => page.evaluate(() =>
        window.celestrian.getState().nodes.find(n => n.type === 'stack')
            .nodes[0].effects);

    test('fx chip expands the rack; enable and params round-trip', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const firstClip = page.locator('.lane[data-kind="clip"]').first();
        await expect(firstClip.locator('.fx-btn')).toHaveText('fx');

        await firstClip.locator('.fx-btn').click();
        const fxRow = page.locator('.lane-fx');
        await expect(fxRow).toHaveCount(1, { timeout: 3000 });
        await expect(fxRow.locator('.fx-card')).toHaveCount(4); // the fixed rack

        // Power on the echo: backend flag flips, card lights, chip counts
        await fxRow.locator('.fx-card[data-fx="echo"] .fx-power').click();
        await expect.poll(async () => (await clipFx(page)).echo.enabled,
            { timeout: 3000 }).toBe(true);
        await expect(fxRow.locator('.fx-card[data-fx="echo"]')).not.toHaveClass(/off/);
        await expect(firstClip.locator('.fx-btn')).toHaveText('fx·1', { timeout: 3000 });

        // Drag-equivalent: set the mix slider → setEffectParam round-trips
        await fxRow.locator('.fx-card[data-fx="echo"] input[data-key="mix"]')
            .evaluate(el => {
                el.value = '0.8';
                el.dispatchEvent(new Event('input', { bubbles: true }));
            });
        await expect.poll(async () => (await clipFx(page)).echo.mix,
            { timeout: 3000 }).toBe(0.8);
        await expect(fxRow.locator('.fx-card[data-fx="echo"] .fx-param-value')
            .nth(2)).toHaveText('80%');

        // Chip again: panel folds away, state stays
        await firstClip.locator('.fx-btn').click();
        await expect(page.locator('.lane-fx')).toHaveCount(0, { timeout: 3000 });
        expect((await clipFx(page)).echo.enabled).toBe(true);
    });

    test('groups have racks too (fractal): reverb on the whole kit', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        const group = page.locator('.lane[data-kind="group"]').first();
        await group.locator('.fx-btn').click();
        await expect(page.locator('.lane-fx')).toHaveCount(1, { timeout: 3000 });

        await page.locator('.fx-card[data-fx="reverb"] .fx-power').click();
        await expect.poll(() => page.evaluate(() =>
            window.celestrian.getState().nodes.find(n => n.type === 'stack')
                .effects.reverb.enabled), { timeout: 3000 }).toBe(true);
        await expect(group.locator('.fx-btn')).toHaveText('fx·1', { timeout: 3000 });
    });

    test('the 50ms tick never fights a slider being dragged', async ({ page }) => {
        await loadHarness(page, 'Stack with 3 Clips');
        await page.locator('.lane[data-kind="clip"]').first()
            .locator('.fx-btn').click();
        const slider = page.locator('.fx-card[data-fx="eq"] input[data-key="low"]');
        await expect(slider).toBeVisible({ timeout: 3000 });
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

test.describe('Session shell (mock mode)', () => {

    test.beforeEach(async ({ page }) => {
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
        await page.evaluate(() => {
            window.__celestrianTest.loadScenario('example-1q-4q');
            // 25 cycles + 1.5Q deep (44.1k mock quantum)
            window.__celestrianTest.setMasterPos((25 * 4 + 1.5) * 44100);
            window.__celestrianTest.setIsPlaying(true);
        });
        await expect(page.locator('#position-readout')).toHaveText(/1\.5Q \/ 4Q ↺/, { timeout: 3000 });
    });

    test('FIRST TAKE: new stack → add track → arm → stop → committed take', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        await expect(page.locator('#empty-state')).toBeVisible();

        // Build the session from the chrome alone (the field-reported flow)
        await page.click('#add-stack-btn');
        await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(1);
        await page.locator('.lane-add .add-track-row-btn').click();
        const clipLane = page.locator('.lane[data-kind="clip"]');
        await expect(clipLane).toHaveCount(1);
        await expect(clipLane.locator('.rail-sub')).toHaveText('empty');

        // The empty track's ● is enabled; a full track's would not be
        const armBtn = clipLane.locator('.arm-btn');
        await expect(armBtn).toBeEnabled();
        await armBtn.click();
        await expect(clipLane.locator('.rail-status'))
            .toHaveText(/recording|armed/, { timeout: 3000 });
        await expect(page.locator('#record-btn')).toHaveClass(/recording|armed/);

        // Let 2Q of "audio" pass, then stop from the same button
        await page.evaluate(() => window.__celestrianTest.setMasterPos(2 * 44100));
        await armBtn.click();

        // The take commits: one solid rep, rail shows a period, ● disables
        await expect(clipLane.locator('.rep:not(.ghost)')).toHaveCount(1, { timeout: 3000 });
        await expect(armBtn).toBeDisabled(); // arm targets emptiness (Q7)
    });

    test('DRUM FLOW: global ● records all empty tracks, full ones play (Q7)', async ({ page }) => {
        // Kit: 3 tracks with takes + 2 empty tracks in one stack
        await page.evaluate(async () => {
            window.__celestrianTest.loadScenario('stack-with-clips');
            const call = window.__celestrianTest.callNative;
            const stack = (await call('getGraphState')).nodes.find(n => n.type === 'stack');
            await call('createNode', 'clip', stack.id);
            await call('createNode', 'clip', stack.id);
        });
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(5);

        await page.click('#record-btn');

        // Both empty tracks record; the three full ones are untouched
        await expect.poll(() => page.evaluate(async () => {
            const s = (await window.__celestrianTest.callNative('getGraphState'))
                .nodes.find(n => n.type === 'stack');
            return s.nodes.map(c => !!c.isRecording).join(',');
        }), { timeout: 3000 }).toBe('false,false,false,true,true');
        await expect(page.locator('#record-btn')).toHaveClass(/recording/);

        // Global ● again stops both: the stop request enters
        // awaiting-stop; the takes commit as the transport crosses the
        // next boundary (stops always pad forward — owner ruling)
        await page.evaluate(() => window.__celestrianTest.advanceBy(Math.round(0.6 * 44100)));
        await page.click('#record-btn');
        await page.evaluate(() => window.__celestrianTest.advanceBy(Math.round(0.5 * 44100)));
        await expect.poll(() => page.evaluate(async () => {
            const s = (await window.__celestrianTest.callNative('getGraphState'))
                .nodes.find(n => n.type === 'stack');
            return s.nodes.some(c => c.isRecording);
        }), { timeout: 3000 }).toBe(false);
    });

    test('global ● on an all-full island records into a fresh track', async ({ page }) => {
        await page.evaluate(() => window.__celestrianTest.loadScenario('example-1q-4q'));
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(2);
        await page.click('#record-btn');
        // A new lane appears, recording (pending start until audio is
        // written, so it shows the arm marker, not a zero-length bar)
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(3, { timeout: 3000 });
        const recLane = page.locator('.lane', { has: page.locator('.rail-status:text("recording…")') });
        await expect(recLane.locator('.arm-marker')).toBeVisible();
        // Once the transport crosses the Q11 boundary and audio flows,
        // the bar takes over (scenario sits at 2.5Q: 0.5Q to the arm
        // point, then some audio)
        await page.evaluate(() => window.__celestrianTest.advanceBy(Math.round(0.8 * 44100)));
        await expect(page.locator('.lane .recording-bar')).toHaveCount(1, { timeout: 3000 });
    });

    test('NO FLASH: committing a take must not destroy other lanes\' DOM', async ({ page }) => {
        // Build: 1Q committed take, then record a second track past 1Q
        await page.evaluate(() => window.__celestrianTest.loadScenario('empty'));
        await page.click('#add-stack-btn');
        await page.locator('.lane-add .add-track-row-btn').click();
        await page.locator('.lane[data-kind="clip"] .arm-btn').click();
        await page.evaluate(() => window.__celestrianTest.advanceBy(44100));
        await page.locator('.lane[data-kind="clip"] .arm-btn').click();
        await expect(page.locator('.lane[data-kind="clip"] .rep')).toHaveCount(1);

        await page.locator('.lane-add .add-track-row-btn').click();
        await page.locator('.lane[data-kind="clip"]').nth(1).locator('.arm-btn').click();
        await page.evaluate(() => window.__celestrianTest.advanceBy(Math.round(1.5 * 44100)));
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
        await expect(page.locator('.rail-status').nth(2)).toHaveText('finishing…');
        await page.evaluate(() => window.__celestrianTest.advanceBy(Math.round(0.5 * 44100) + 10));
        await expect(page.locator('#position-readout')).toHaveText(/2Q ↺/, { timeout: 3000 });

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
            .toHaveText(/armed|recording/, { timeout: 3000 });
    });
});
