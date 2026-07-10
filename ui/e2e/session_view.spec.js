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
