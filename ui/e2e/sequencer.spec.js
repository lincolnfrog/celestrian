/**
 * THE SEQUENCER — e2e (docs/sequencer.md §9; twins: sequencer_tests.cc
 * and sequence.test.mjs). The pad grid under real pointer input: a
 * group's grid on 'stack-with-clips', the root's over loose takes.
 */

import { test, expect } from '@playwright/test';
import {
    boot, call, root, node, seqOf, quantum, setLoop, laneOf, centreOf, undo,
    redo, consoleDrained, recordDefinerAndTake,
} from './helpers.js';

const STACK = 'stack-1';

/** 'stack-with-clips' with a new song of `steps` equal steps on its
 * group, the grid open. */
async function groupGrid(page, steps) {
    await boot(page, { scenario: 'stack-with-clips' });
    await laneOf(page, STACK).locator('.seq-btn').click();
    const grid = page.locator('.lane-seq');
    await grid.locator('.seq-start').click();
    for (let i = 1; i < steps; i++) await grid.locator('.seq-addstep').click();
    await expect(grid.locator('.seq-hcell')).toHaveCount(steps);
    return grid;
}

/**
 * An empty session with a 1Q loop and a `lenQ` take (the inner cycle is
 * `lenQ`), `stepsQ` as the root song, and the root grid open. `setSong`
 * replaces the song through the bridge (`extra`: successors, a seed).
 */
async function rootSong(page, lenQ, stepsQ) {
    await boot(page);
    const Q = await quantum(page);
    const { id2: take } = await recordDefinerAndTake(page, Q, lenQ);
    const rootId = (await root(page)).id;
    const setSong = (lens, extra = []) => call(page, 'setSequence', rootId, {
        steps: lens.map((q, i) => ({ name: 'abcde'[i], len: q * Q, ...extra[i] })),
        gates: {} });
    await setSong(stepsQ);
    // The chip shows the song once a poll has it; then the grid opens.
    const chip = page.locator('#root-seq-btn');
    await expect(chip).toHaveText('seq·' + stepsQ.reduce((n, q) => n + q, 0) + 'Q');
    await chip.click();
    const grid = page.locator('.lane-seq');
    await expect(grid.locator('.seq-foot')).toHaveCount(1);
    const stepsOf = async () => (await seqOf(page)).steps.map(s => s.len / Q).join(',');
    return { Q, take, grid, chip, stepsOf, setSong };
}

/** Count the setSequence calls that reach the bridge from here on (the
 * mock logs every call): the answer once the console has delivered all
 * that was logged. */
async function watchSetSequence(page) {
    await consoleDrained(page);
    let calls = 0;
    page.on('console', msg => {
        if (/callNative: setSequence/.test(msg.text())) calls++;
    });
    return async () => {
        await consoleDrained(page);
        return calls;
    };
}

test.describe('Sequencer (docs/sequencer.md)', () => {
    test('a group\'s grid: create, append, gate, dims, bypass, cue, rename, delete — each undoable', async ({ page }) => {
        await boot(page, { scenario: 'stack-with-clips' });
        const chip = laneOf(page, STACK).locator('.seq-btn');
        const grid = page.locator('.lane-seq');
        const clip = i => page.locator('.lane[data-kind="clip"]').nth(i);
        const seq = () => seqOf(page, STACK);
        const cues = async () => (await seq()).steps.map(s => !!s.cue).join(',');

        await test.step('create and append: one pad row per child, every gate on', async () => {
            await expect(chip).toHaveText('seq');
            // No sequence yet: the grid opens on its creation affordance.
            await chip.click();
            await expect(grid).toHaveCount(1);
            await grid.locator('.seq-start').click();
            await expect(grid.locator('.seq-hcell')).toHaveCount(1);
            await expect(grid.locator('.seq-pad')).toHaveCount(3);
            await expect(grid.locator('.seq-pad.on')).toHaveCount(3);
            await expect(chip).toHaveClass(/\bon\b/);
            await expect(chip).toHaveText(/seq·\d/);
            await expect.poll(async () => (await seq())?.steps.length).toBe(1);
            // A second step: the pads double.
            await grid.locator('.seq-addstep').click();
            await expect(grid.locator('.seq-hcell')).toHaveCount(2);
            await expect(grid.locator('.seq-pad')).toHaveCount(6);
            await expect.poll(async () => (await seq()).steps.length).toBe(2);
        });

        const firstRow = grid.locator('.seq-grid-row').nth(1);
        const firstId = await clip(0).getAttribute('data-id');

        await test.step('a gate: the pad, the stored row and the child\'s lane agree', async () => {
            // The first child off in step 2: its lane dims there (the
            // song is read on the lanes); a child with no row stays on.
            await firstRow.locator('.seq-pad').nth(1).click();
            await expect(firstRow.locator('.seq-pad').nth(1)).not.toHaveClass(/\bon\b/);
            await expect.poll(async () => ((await seq()).gates[firstId] || []).join(','))
                .toBe('true,false');
            await expect(clip(0).locator('.seq-dim')).toHaveCount(1);
            await expect(clip(1).locator('.seq-dim')).toHaveCount(0);
            // The row's name (in the rail column) toggles the whole row:
            // a mixed row goes all on, then all off, then on again.
            const rowName = grid.locator('.seq-rowname').nth(0);
            for (const on of [2, 0, 2]) {
                await rowName.click();
                await expect(firstRow.locator('.seq-pad.on')).toHaveCount(on);
            }
        });

        await test.step('bypass: the jam is back — dims drop, the geometry stays; ⌘Z re-activates', async () => {
            await firstRow.locator('.seq-pad').nth(1).click();
            await expect(clip(0).locator('.seq-dim')).toHaveCount(1);
            await grid.locator('.seq-bypass').click();
            await expect(chip).toHaveClass(/bypassed/);
            await expect(clip(0).locator('.seq-dim')).toHaveCount(0);
            await expect(grid.locator('.seq-hcell')).toHaveCount(2);
            await expect.poll(async () => (await seq()).bypassed).toBe(true);
            await undo(page);
            await expect.poll(async () => (await seq()).bypassed).toBe(false);
            await expect(chip).toHaveClass(/\bon\b/);
            await expect(clip(0).locator('.seq-dim')).toHaveCount(1);
        });

        await test.step('cue: the header pip toggles, marks the lanes, undoes', async () => {
            // The pip is hover-revealed on the header.
            const head = grid.locator('.seq-hcell').nth(1);
            await head.hover();
            await head.locator('.seq-cue').click();
            await expect(head).toHaveClass(/cued/);
            await expect(head.locator('.seq-cue')).toHaveClass(/\bon\b/);
            await expect.poll(cues).toBe('false,true');
            // A cued step still sounds (it re-bases): the scope's
            // children wear the cued span.
            await expect(clip(1).locator('.seq-cue-span')).toHaveCount(1);
            await expect(clip(2).locator('.seq-cue-span')).toHaveCount(1);
            // Again: back to a gate; the marker drops.
            await head.hover();
            await head.locator('.seq-cue').click();
            await expect(head).not.toHaveClass(/cued/);
            await expect.poll(cues).toBe('false,false');
            await expect(clip(1).locator('.seq-cue-span')).toHaveCount(0);
            await undo(page);
            await expect.poll(cues).toBe('false,true');
            await expect(grid.locator('.seq-hcell').nth(1)).toHaveClass(/cued/);
        });

        await test.step('a step renames inline and deletes by right-click; the last delete clears the song', async () => {
            await grid.locator('.seq-hcell').nth(1).locator('.seq-hname').dblclick();
            const input = grid.locator('.seq-hname-input');
            await input.fill('chorus');
            await input.press('Enter');
            await expect(grid.locator('.seq-hcell').nth(1)).toContainText('chorus');
            await grid.locator('.seq-hcell').nth(1).click({ button: 'right' });
            await expect(grid.locator('.seq-hcell')).toHaveCount(1);
            // No steps, no song: the creation affordance returns.
            await grid.locator('.seq-hcell').first().click({ button: 'right' });
            await expect(grid.locator('.seq-start')).toHaveCount(1);
            await expect(chip).toHaveText('seq');
        });
    });

    test('STEP AUDITION (§11): ⟲ loops a step; a take recorded through it is one step long and gated to it; Esc releases', async ({ page }) => {
        // intro 2Q | chorus 4Q | out 2Q, on the root.
        const { Q, grid, chip } = await rootSong(page, 2, [2, 4, 2]);

        // Hover the chorus header: ⟲ appears. Clicked, the song folds
        // to the step — and the root has no lane, so the ruler brackets it.
        const chorus = grid.locator('.seq-hcell').nth(1);
        await chorus.hover();
        const loop = chorus.locator('.seq-loop');
        await expect(loop).toBeVisible();
        await loop.click();
        await expect(loop).toHaveText('⟲ looping');
        await expect(chorus).toHaveClass(/looping/);
        await expect(chip).toHaveText('⟲ step 2');
        const bracket = page.locator('.ruler-root-window');
        await expect(bracket).toHaveCount(1);
        await expect(bracket).toHaveText(/2Q–6Q/);
        await expect.poll(async () => {
            const st = await root(page);
            return [st.windowActive, st.loopStart, st.loopEnd,
                    st.sequence.auditionStep].join(',');
        }).toBe(['true', 2 * Q, 6 * Q, 1].join(','));
        // The frame is still the song; the cursor loops inside the step.
        await expect(page.locator('#position-readout')).toContainText('8Q');

        // A take recorded through the step is capped at the step…
        const id = await page.evaluate(async Q => {
            const { callNative: c, advanceBy } = window.__celestrianTest;
            const id = await c('createNode', 'clip', '');
            await c('startRecordingInNode', id);
            advanceBy(6 * Q);
            advanceBy(512);
            return id;
        }, Q);
        const taken = async () => {
            const c = await node(page, id);
            return c.isRecording ? 'rec' : c.duration / Q;
        };
        const gates = async () => ((await seqOf(page)).gates[id] || []).join(',');
        await expect.poll(taken, { timeout: 5000 }).toBe(4);
        // …and auto-gated: its row is ON in the chorus only.
        await expect.poll(gates).toBe('false,true,false');
        await expect(grid.locator('.seq-grid-row').nth(3).locator('.seq-pad.on')).toHaveCount(1);
        // ONE undo removes the take and its gates together.
        await undo(page);
        await expect.poll(async () => [await taken(), await gates()].join('|')).toBe('0|');
        await redo(page);
        await expect.poll(async () => [await taken(), await gates()].join('|'))
            .toBe('4|false,true,false');

        // The loop outlives the commit; Esc releases it.
        await expect(chorus).toHaveClass(/looping/);
        await page.keyboard.press('Escape');
        await expect(bracket).toHaveCount(0);
        await expect(chip).toHaveText(/seq·8Q/);
        await expect.poll(async () => (await root(page)).windowActive).toBe(false);
    });

    test('FRAME HEALTH (§11.6): a song that drifts over the inner cycle says so and offers the snaps a step can take; the append label counts in that cycle', async ({ page }) => {
        const { Q, take, grid, chip, stepsOf, setSong } = await rootSong(page, 4, [5]);
        const badge = grid.locator('.seq-health-drift');
        const fix = grid.locator('.seq-health-fix');

        await test.step('5Q over a 4Q cycle drifts; a snap up stretches the last step', async () => {
            await expect(chip).toHaveClass(/drift/);
            await expect(badge).toHaveText(/↯ drifting · 5Q over 4Q/);
            await fix.filter({ hasText: 'snap to 8Q' }).click();
            await expect(grid.locator('.seq-hlen')).toHaveText('8Q');
            await expect(badge).toHaveCount(0);
            await expect(chip).not.toHaveClass(/drift/);
            await expect(chip).toHaveText(/seq·8Q/);
        });

        await test.step('4Q + 1Q: a snap down takes more than the last step can give, so the step before gives it — one edit', async () => {
            await setSong([4, 1]);
            await expect(badge).toHaveText(/5Q over 4Q/);
            const sent = await watchSetSequence(page);
            await fix.filter({ hasText: 'snap to 4Q' }).click();
            await expect.poll(stepsOf).toBe('3,1');
            await expect(badge).toHaveCount(0);
            await expect(chip).toHaveText(/seq·4Q/);
            expect(await sent(), 'one edit, one undo step').toBe(1);
            await undo(page);
            await expect.poll(stepsOf).toBe('4,1');
        });

        await test.step('five 1Q steps: 4Q is not offered — no step can give a Q and stay a step', async () => {
            await setSong([1, 1, 1, 1, 1]);
            await expect(badge).toHaveText(/5Q over 4Q/);
            await expect(fix).toHaveText(['snap to 8Q']);
            await fix.click();
            await expect.poll(stepsOf).toBe('1,1,1,1,4');
            await expect(badge).toHaveCount(0);
        });

        await test.step('"＋ step" is one inner cycle: it follows the take\'s loop', async () => {
            await setSong([8]);
            const append = grid.locator('.seq-addstep');
            await expect(append).toHaveText('＋ step · 4Q');
            // The long take loops its first 2Q: no step, gate or badge
            // changed, and the cycle the steps count in is 2Q.
            await setLoop(page, take, 0, 2 * Q);
            await expect(append).toHaveText('＋ step · 2Q');
        });
    });

    test('STEP EDITS on the root grid: a rename that renames nothing sends nothing; a cancelled grip drag edits nothing; the grip stretches by whole cycles, ⌥ by whole Q; a radio drags at the scale of the steps shown', async ({ page }) => {
        // Two 2Q steps over a 2Q cycle: the row is 4Q wide.
        const { grid, chip, stepsOf, setSong } = await rootSong(page, 2, [2, 2]);
        const sent = await watchSetSequence(page);
        const len = grid.locator('.seq-hcell').nth(0).locator('.seq-hlen');
        /** Press the first step's grip; answers the press point and the
         * pad row's width (the drag's scale: the whole row is the song). */
        const pressGrip = async () => {
            const at = await centreOf(grid.locator('.seq-hcell').nth(0).locator('.seq-grip'));
            const row = await grid.locator('.seq-head').boundingBox();
            await page.mouse.move(at.x, at.y);
            await page.mouse.down();
            return { ...at, rowW: row.width };
        };

        await test.step('a rename that changes nothing sends nothing', async () => {
            const name = grid.locator('.seq-hcell').nth(1).locator('.seq-hname');
            await expect(name).toHaveText('b');
            // The editor, left by a press elsewhere, then by Enter.
            await name.dblclick();
            await expect(grid.locator('.seq-hname-input')).toBeFocused();
            await page.locator('#ruler').click({ position: { x: 5, y: 5 } });
            await expect(grid.locator('.seq-hname-input')).toHaveCount(0);
            await name.dblclick();
            await page.keyboard.press('Enter');
            await expect(grid.locator('.seq-hname-input')).toHaveCount(0);
            // The next real edit is the first thing the bridge hears.
            await name.dblclick();
            await page.keyboard.type('bridge');
            await page.keyboard.press('Enter');
            await expect(name).toHaveText('bridge');
            expect(await stepsOf()).toBe('2,2');
            expect(await sent(), 'only the rename that renamed').toBe(1);
        });

        await test.step('a cancelled drag: the preview comes down, nothing is sent', async () => {
            const g = await pressGrip();
            await page.mouse.move(g.x + g.rowW / 2, g.y, { steps: 6 });
            await expect(len).toHaveText('4Q');
            // The system takes the pointer away mid-drag (a cancel, and
            // the capture with it): the release that follows is not the
            // grip's.
            await grid.locator('.seq-hcell').nth(0).locator('.seq-grip').evaluate(grip => {
                grip.dispatchEvent(new PointerEvent('pointercancel',
                    { pointerId: 1, bubbles: true }));
                grip.releasePointerCapture(1);
            });
            await page.mouse.up();
            await expect(len).toHaveText('2Q');
            expect(await stepsOf()).toBe('2,2');
            expect(await sent(), 'a cancelled drag sends nothing').toBe(1);
        });

        await test.step('the next drag is one edit: half the row is +2Q, one cycle; ⌥ holds the whole-Q grid', async () => {
            let g = await pressGrip();
            await page.mouse.move(g.x + g.rowW / 2, g.y, { steps: 6 });
            // The chip previews the length under the hand; the release
            // commits it.
            await expect(len).toHaveText('4Q');
            expect(await stepsOf(), 'nothing is sent before the release').toBe('2,2');
            await page.mouse.up();
            await expect.poll(stepsOf).toBe('4,2');
            await expect(chip).toHaveText('seq·6Q');
            expect(await sent(), 'one drag, one edit').toBe(2);
            // A sixth of the 6Q row to the left, under ⌥: −1Q.
            g = await pressGrip();
            await page.keyboard.down('Alt');
            await page.mouse.move(g.x - g.rowW / 6, g.y, { steps: 6 });
            await expect(len).toHaveText(/^3Q/);
            await page.mouse.up();
            await page.keyboard.up('Alt');
            await expect.poll(stepsOf).toBe('3,2');
            expect(await sent()).toBe(3);
            // One undo step each.
            await undo(page);
            await expect.poll(stepsOf).toBe('4,2');
            await undo(page);
            await expect.poll(stepsOf).toBe('2,2');
        });

        await test.step('a radio: one column\'s width is a third of the 6Q shown, not of its unrolled run', async () => {
            // The last step may go to the top OR to the second step: its
            // run is hundreds of Q long, its grid three equal columns.
            await setSong([2, 2, 2], [{}, {}, { next: [{ to: 0, w: 1 }, { to: 1, w: 1 }] }]);
            await expect(grid.locator('.seq-radio')).toHaveCount(1);
            await expect(grid.locator('.seq-hcell')).toHaveCount(3);
            const g = await pressGrip();
            await page.mouse.move(g.x + g.rowW / 3, g.y, { steps: 6 });
            await expect(len).toHaveText(/^4Q/);
            await page.mouse.up();
            await expect.poll(stepsOf).toBe('4,2,2');
        });
    });

    test('pad painting: a right-click toggles nothing; a release the page never saw leaves no hover painting', async ({ page }) => {
        const grid = await groupGrid(page, 3);
        const row = grid.locator('.seq-grid-row').nth(1);  // the first child's
        const pads = row.locator('.seq-pad');
        const at = i => centreOf(pads.nth(i));
        await expect(pads).toHaveCount(3);

        await pads.nth(0).click({ button: 'right' });
        await pads.nth(1).click();              // the next edit, to wait on
        await expect(pads.nth(1)).not.toHaveClass(/\bon\b/);
        await expect(pads.nth(0)).toHaveClass(/\bon\b/);
        await expect(row.locator('.seq-pad.on')).toHaveCount(2);
        await pads.nth(1).click();
        await expect(row.locator('.seq-pad.on')).toHaveCount(3);

        // A drag paints: press the first pad (off), sweep to the second.
        const p0 = await at(0), p1 = await at(1), p2 = await at(2);
        await page.mouse.move(p0.x, p0.y);
        await page.mouse.down();
        await page.mouse.move(p1.x, p1.y, { steps: 4 });
        await expect(row.locator('.seq-pad.on')).toHaveCount(1);
        // The release never reaches the page (a capture lost to a window
        // switch): hovering on with no button down paints nothing more.
        await page.evaluate(() => window.addEventListener('pointerup',
            e => e.stopImmediatePropagation(), { capture: true, once: true }));
        await page.mouse.up();
        await page.mouse.move(p2.x, p2.y, { steps: 4 });
        await page.mouse.move(p1.x, p1.y, { steps: 4 });
        await page.mouse.move(p2.x, p2.y, { steps: 4 });
        // …and the next real click is a plain toggle of that one pad.
        await pads.nth(1).click();
        await expect(pads.nth(1)).toHaveClass(/\bon\b/);
        await expect(pads.nth(2)).toHaveClass(/\bon\b/);
        await expect(row.locator('.seq-pad.on')).toHaveCount(2);
    });

    test('NESTED (§12): the fractal drum kit — two grids, layered dims, a group lane as long as its song', async ({ page }) => {
        await boot(page, { scenario: 'fractal-drums' });
        const drums = laneOf(page, 'drums');
        const kick = laneOf(page, 'kick');
        const hat = laneOf(page, 'hat');
        // The group lane reads its SONG length, not the kit's lcm.
        await expect(drums.locator('.rail-sub')).toHaveText('4Q');
        await expect(drums.locator('.seq-btn')).toHaveText('seq·4Q');
        // Layered dims: Drums carries the root's intro dim; Kick the
        // root's AND its own pattern (layers 0 and 1).
        await expect(drums.locator('.seq-dim')).toHaveCount(1);
        await expect(kick.locator('.seq-dim[data-layer="0"]')).toHaveCount(1);
        await expect(kick.locator('.seq-dim[data-layer="1"]')).toHaveCount(4);
        await expect(hat.locator('.seq-dim')).toHaveCount(1);
        // Two grids at once: the root's and the kit's.
        await page.locator('#root-seq-btn').click();
        await drums.locator('.seq-btn').click();
        await expect(page.locator('.lane-seq')).toHaveCount(2);
        const kit = page.locator('.lane-seq[data-id="seq:drums"]');
        await expect(kit.locator('.seq-hcell')).toHaveCount(4);
        await expect(kit.locator('.seq-addstep')).toHaveText(/1Q/);
        // The hat painted off in step 1: its lane gains the inner layer.
        await kit.locator('.seq-grid-row').nth(3).locator('.seq-pad').nth(0).click();
        await expect(hat.locator('.seq-dim[data-layer="1"]')).toHaveCount(2);
        // The kit's pattern bypassed from its footer: the group lane is
        // its intrinsic 1Q tiling again; the root's layer stays.
        await kit.locator('.seq-bypass').click();
        await expect(drums.locator('.rail-sub')).toHaveText('1Q');
        await expect(kick.locator('.seq-dim[data-layer="1"]')).toHaveCount(0);
        await expect(kick.locator('.seq-dim[data-layer="0"]')).toHaveCount(1);
    });
});
