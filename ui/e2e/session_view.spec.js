/**
 * Session view e2e (docs/session_view.md), on the mock page.
 *
 * Timeline MATH is the view-model unit tests' (js/tests/view_model.test.mjs
 * and its neighbours). These cases pin what only a browser shows: the
 * shell draws the model honestly and its controls round-trip through the
 * backend; drags are hit-tested; a typing hand and a held slider outlive
 * the patch tick; the DOM survives a commit; popovers dismiss; canvases
 * paint; no state moves a lane.
 */

import { test as base, expect } from '@playwright/test';
import {
    boot, mock, call, graph, root, node, quantum, segsOf, setLoop, laneOf,
    panelOf, centre, centreOf, dragBy, dragTo, release, undo, settled,
    consoleDrained, armPending,
} from './helpers.js';

/** Every case starts on the mock page with its describe's `scenario`
 * (js/mock/scenarios.js) loaded: `test.use({ scenario })`. */
const test = base.extend({
    scenario: ['empty', { option: true }],
    page: async ({ page, scenario }, use) => {
        await boot(page, { scenario });
        await use(page);
    },
});

const readout = page => page.locator('#position-readout');
const lastTick = page => page.locator('#ruler .tick-label').last();

/** The playhead's place along the ruler, 0..1. */
const playheadFrac = page => page.evaluate(() => {
    const x = document.getElementById('playhead').getBoundingClientRect().x;
    const r = document.getElementById('ruler').getBoundingClientRect();
    return (x - r.x) / r.width;
});

/** A handle's centre once it has a box: a lane's overlay is rebuilt from
 * the settled state a patch or two after a commit, and a handle resolved
 * just before that is detached by the time its box is read. */
async function grip(handle) {
    let box = null;
    await expect.poll(async () => (box = await handle.boundingBox()) !== null).toBe(true);
    return centre(box);
}

/** Drag `handle` to `frac` of the lane `body`'s width. */
async function dragToFrac(page, handle, body, frac) {
    const box = await body.boundingBox();
    await dragTo(page, await grip(handle), box.x + box.width * frac, { steps: 8 });
}

/** Drag a window bracket to `targetQ` of the lane's `cycleQ`, aimed 0.3Q
 * past it: only the Q-snap can land it there. */
const dragBracket = (page, bracket, body, targetQ, cycleQ) =>
    dragToFrac(page, bracket, body, (targetQ + 0.3) / cycleQ);

/** Every ＋ opens the creation menu; its default row, under the pointer,
 * makes a bare track. Click-click. */
async function addTrack(page, trigger = '#create-track-btn') {
    await page.locator(trigger).first().click();
    await page.click('.creation-menu .creation-item.default');
}

/** A lane's record cue: the head-row word, and whether the sub-line
 * pulses with a live take. */
const recordCue = lane => lane.evaluate(el =>
    el.querySelector('.rail-status').textContent +
    (el.querySelector('.rail-sub').classList.contains('recording') ? ' recording' : ''));

/** `read()` once it has stopped changing (two equal reads). */
async function atRest(read) {
    let last = null;
    let now = null;
    await expect.poll(async () => {
        last = now;
        now = await read();
        return now !== null && now === last;
    }).toBe(true);
    return now;
}

test.describe('An island of 1Q + 4Q + 3Q loops', () => {
    test.use({ scenario: 'example-1q-4q-3q' });

    test('is one frame: a take and its ghosts on each lane, equal Q at equal x', async ({ page }) => {
        // The group, its three clips and the add-track row, under a 12Q ruler.
        await expect(page.locator('.lane')).toHaveCount(5);
        await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(1);
        await expect(page.locator('.lane-add .add-track-row-btn')).toBeVisible();
        await expect(lastTick(page)).toHaveText('12Q ↺');
        // Each loop tiles the frame: one take, the rest ghosts.
        for (const [id, tiles] of [['clip-1q', 12], ['clip-4q', 3], ['clip-3q', 4]]) {
            await expect.soft(laneOf(page, id).locator('.rep')).toHaveCount(tiles);
            await expect.soft(laneOf(page, id).locator('.rep:not(.ghost)')).toHaveCount(1);
        }
        // One time axis: the 4Q lane's second tile and the 1Q lane's
        // fifth both start at 4Q.
        const tileX = (id, i) => laneOf(page, id).locator('.rep').nth(i)
            .evaluate(el => el.getBoundingClientRect().x);
        await expect.poll(async () =>
            Math.abs(await tileX('clip-4q', 1) - await tileX('clip-1q', 4))).toBeLessThan(1.5);
    });

    test('an unselected one-shot lane offers no handle: its seam is a mark, its grips are not drawn', async ({ page }) => {
        const Q = await quantum(page);
        // The 4Q take keeps [0, 1) and [2, 4) — one cut — and plays once.
        await call(page, 'setSegments', 'clip-4q', [0, Q, 2 * Q, 4 * Q]);
        await call(page, 'setPeriodSource', 'clip-4q', 'context');
        const lane = laneOf(page, 'clip-4q');
        const seam = lane.locator('.seam-handle').first();
        // Selected: the seam handle and the edge grips are there to take.
        await lane.locator('.rail-name').click();
        await expect(lane).toHaveClass(/\bsel\b/);
        await expect(seam).toHaveCount(1);
        await expect(seam).toHaveCSS('pointer-events', 'auto');
        await expect(lane.locator('.trim-grip').first()).toHaveCSS('display', 'block');
        // Another track selected: the seam stays as a mark that takes no
        // pointer — no tooltip, no hover — and the grips are gone.
        await laneOf(page, 'clip-3q').locator('.rail-name').click();
        await expect(lane).not.toHaveClass(/\bsel\b/);
        await expect(seam).toBeVisible();
        await expect(seam).toHaveCSS('pointer-events', 'none');
        await expect(lane.locator('.trim-grip').first()).toHaveCSS('display', 'none');
        const at = await centreOf(seam);
        const hit = await page.evaluate(({ x, y }) => {
            const e = document.elementFromPoint(x, y);
            return e ? e.className : null;
        }, at);
        expect(hit).not.toContain('seam-handle');
        // A real press there selects the track, and cuts nothing.
        await page.mouse.click(at.x, at.y);
        await expect(lane).toHaveClass(/\bsel\b/);
        expect(await segsOf(page, 'clip-4q', Q)).toBe('0,1,2,4');
    });
});

test.describe('Fold', () => {
    test.use({ scenario: 'nested-stacks' });

    test('hides a group\'s child lanes and keeps its own: view state only', async ({ page }) => {
        const parent = laneOf(page, 'parent-stack');
        const children = ['clip-1', 'child-stack', 'nested-clip-1', 'nested-clip-2'];
        for (const id of children) await expect(laneOf(page, id)).toBeVisible();
        await parent.locator('.fold-btn').click();
        for (const id of children) await expect(laneOf(page, id)).toHaveCount(0);
        await expect(parent).toBeVisible();
        // The backend holds them all the same.
        expect((await node(page, 'nested-clip-2')).name).toBe('Nested Clip B');
    });
});

test.describe('Transport and ruler (1Q + 4Q, loaded playing)', () => {
    test.use({ scenario: 'example-1q-4q' });

    test('play button and playhead: one line in the timeline column; the readout is position over the cycle', async ({ page }) => {
        const playhead = page.locator('#playhead');
        // Stopped, the playhead stays — dimmed: a seek needs somewhere to land.
        await mock(page, 'setIsPlaying', false);
        await expect(playhead).toBeVisible();
        await expect(playhead).toHaveClass(/idle/);

        // The play button round-trips through the backend.
        await page.click('#play-btn');
        await expect(page.locator('#play-btn')).toHaveClass(/playing/);
        expect((await root(page)).isPlaying).toBe(true);

        // A still clock for the geometry: a fresh load stops the
        // simulated transport, and the position is set by hand.
        const Q = await quantum(page);
        await page.evaluate(Q => {
            const t = window.__celestrianTest;
            t.loadScenario('example-1q-4q');
            t.setIsPlaying(true);
            t.setMasterPos(2 * Q);
        }, Q);
        await expect(readout(page)).toHaveText(/2\.0Q \/ 4Q ↺/);
        await expect(playhead).toBeVisible();
        // 2Q of 4Q is half the ruler. (The playhead glides: poll.)
        await expect.poll(async () => {
            const b = await page.locator('#ruler').boundingBox();
            return Math.abs(await playheadFrac(page) - 0.5) * b.width;
        }).toBeLessThan(3);

        // Any position reads inside the cycle, however deep the clock.
        await mock(page, 'setMasterPos', 2.5 * Q);
        await expect(readout(page)).toHaveText(/2\.5Q \/ 4Q ↺/);
        await mock(page, 'setMasterPos', (25 * 4 + 1.5) * Q);
        await expect(readout(page)).toHaveText(/1\.5Q \/ 4Q ↺/);
    });

    test('RULER SEEK: a click teleports the transport and the dimmed playhead lands under it; a drag scrubs to where it is released', async ({ page }) => {
        const Q = await quantum(page);
        await mock(page, 'setIsPlaying', false);
        const ruler = page.locator('#ruler');
        const playhead = page.locator('#playhead');
        await expect(ruler).toHaveClass(/seekable/);
        await expect(playhead).toHaveClass(/idle/);
        const box = await ruler.boundingBox();
        const y = box.height - 4;
        const offBy = async q => Math.abs((await root(page)).masterPos - q * Q) / Q;

        // A click mid-ruler: half of the 4Q frame.
        await ruler.click({ position: { x: box.width / 2, y } });
        await expect.poll(() => offBy(2)).toBeLessThan(0.1);
        await expect.poll(async () => Math.abs(
            await playhead.evaluate(el => parseFloat(el.style.left)) - box.width / 2))
            .toBeLessThan(8);

        // Press at 25%, scrub to 75%, release: the last target lands
        // through the throttled sender.
        await page.mouse.move(box.x + box.width * 0.25, box.y + y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.5, box.y + y, { steps: 4 });
        await page.mouse.move(box.x + box.width * 0.75, box.y + y, { steps: 4 });
        await page.mouse.up();
        await expect.poll(() => offBy(3)).toBeLessThan(0.1);
    });

    test('RULER SEEK: locked while a take is armed and waiting to start', async ({ page }) => {
        const ruler = page.locator('#ruler');
        await expect(ruler).toHaveClass(/seekable/);
        const armed = await armPending(page);
        await expect(laneOf(page, armed).locator('.lane-body')).toHaveClass(/armed-empty/);
        // The ruler says so: locked, no scrub cue…
        await expect(ruler).toHaveClass(/seek-locked/);
        await expect(ruler).not.toHaveClass(/seekable/);
        // …and a real press and drag on it asks the engine for nothing.
        const seeks = [];
        page.on('console', msg => {
            if (/callNative: seekTransport/.test(msg.text())) seeks.push(msg.text());
        });
        const box = await ruler.boundingBox();
        const y = box.y + box.height - 4;
        await page.mouse.move(box.x + box.width / 2, y);
        await expect(ruler.locator('.seek-hover')).toBeHidden();
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.7, y, { steps: 4 });
        await page.mouse.up();
        await consoleDrained(page);
        expect(seeks, 'no seek reached the bridge').toEqual([]);
    });
});

test.describe('A lane that is recording', () => {
    test.use({ scenario: 'recording-1q-plus-growing' });

    test('shows the growing bar and the rail cue; no lane body moves; its input and the ruler are locked', async ({ page }) => {
        const rec = laneOf(page, 'clip-2');
        await expect(rec.locator('.recording-bar')).toBeVisible();
        // The cue is the rail's sub-line: the live take length, pulsing.
        // The group's rail aggregates it as armed.
        await expect(rec.locator('.rail-sub')).toHaveClass(/recording/);
        await expect(rec.locator('.rail-sub')).toHaveText(/Q|rec/);
        await expect(laneOf(page, 'stack-1').locator('.rail-status')).toHaveText(/armed/);

        // THE STATE-METRICS LAW: a recording or armed state moves no
        // lane body.
        const bodies = await page.locator('.lane[data-kind="clip"] .lane-body')
            .evaluateAll(els => els.map(e => {
                const r = e.getBoundingClientRect();
                return { x: r.x, w: r.width };
            }));
        expect(bodies.length).toBe(2);
        for (const b of bodies) {
            expect.soft(Math.abs(b.x - bodies[0].x)).toBeLessThan(0.5);
            expect.soft(Math.abs(b.w - bodies[0].w)).toBeLessThan(0.5);
        }

        // Mid-take the input cannot change; its committed sibling's can.
        await expect(rec.locator('.input-btn')).toBeDisabled();
        await expect(laneOf(page, 'clip-1').locator('.input-btn')).toBeEnabled();
        // A live take locks the ruler.
        await expect(page.locator('#ruler')).toHaveClass(/seek-locked/);
    });
});

test.describe('Space', () => {
    test.use({ scenario: 'single-clip' });

    test('stops a recording too: the take lands at its boundary, then the transport pauses', async ({ page }) => {
        // A real-time transport: the committed take plays, a second track records.
        const id = await page.evaluate(async () => {
            const c = window.__celestrianTest.callNative;
            const id = await c('createNode', 'clip', '');
            if (!(await c('getGraphState')).isPlaying) await c('togglePlayback');
            await c('startRecordingInNode', id);
            return id;
        });
        // Space comes once the view shows audio landing in the take (it
        // reads "a take is live" from what it last polled).
        await expect(laneOf(page, id).locator('.recording-bar'))
            .toBeVisible({ timeout: 8000 });
        await page.keyboard.press('Space');
        // The take finishes to its boundary (never cut short)…
        await expect.poll(async () => {
            const c = await node(page, id);
            return !c.isRecording && c.duration > 0;
        }, { timeout: 15000 }).toBe(true);
        // …and THEN the transport pauses — not before.
        await expect.poll(async () => (await root(page)).isPlaying).toBe(false);
        // Space again: a plain resume.
        await page.keyboard.press('Space');
        await expect.poll(async () => (await root(page)).isPlaying).toBe(true);
    });
});

test.describe('Rails (one stack: Clip A 2Q, Clip B 3Q, Clip C 1Q)', () => {
    test.use({ scenario: 'stack-with-clips' });

    test('mute, solo and mon: each chip flips its flag in the backend and lights from it', async ({ page }) => {
        const lane = laneOf(page, 'clip-1');
        for (const [chip, flag] of [
            ['.mute-btn', 'isMuted'], ['.solo-btn', 'isSoloed'], ['.mon-btn', 'monitor'],
        ]) {
            await test.step(chip, async () => {
                const btn = lane.locator(chip);
                const on = async () => !!(await node(page, 'clip-1'))[flag];
                await expect(btn).not.toHaveClass(/\bon\b/);
                expect(await on()).toBe(false);
                await btn.click();
                await expect(btn).toHaveClass(/\bon\b/);
                await expect.poll(on).toBe(true);
                await btn.click();
                await expect(btn).not.toHaveClass(/\bon\b/);
                await expect.poll(on).toBe(false);
            });
        }
        // The mon chip says what it does: uncalibrated, its tooltip says so.
        const mon = lane.locator('.mon-btn');
        await expect(mon).toHaveText('mon');
        await expect(mon).toHaveAttribute('title', 'monitor input · not calibrated');
        await mon.click();
        await expect(page.locator('#log-line')).toHaveText('Monitoring input through the track');
    });

    test('rename: a double-click edits the rail name — Enter and blur commit, Escape cancels, the patch tick leaves a typing hand alone', async ({ page }) => {
        const clip = laneOf(page, 'clip-1');
        const group = laneOf(page, 'stack-1');
        const input = clip.locator('.rail-name-input');

        await test.step('Enter commits on a clip', async () => {
            await clip.locator('.rail-name').dblclick();
            await expect(input).toBeVisible();
            await input.fill('Kick');
            await input.press('Enter');
            await expect(clip.locator('.rail-name')).toHaveText('Kick');
            expect((await node(page, 'clip-1')).name).toBe('Kick');
        });

        await test.step('blur commits on a group', async () => {
            await group.locator('.rail-name').dblclick();
            await group.locator('.rail-name-input').fill('Drum Kit');
            await page.locator('#ruler').click();
            await expect(group.locator('.rail-name')).toHaveText('Drum Kit');
            expect((await node(page, 'stack-1')).name).toBe('Drum Kit');
        });

        await test.step('Escape cancels and sends nothing', async () => {
            await clip.locator('.rail-name').dblclick();
            await input.fill('Nope');
            await input.press('Escape');
            await expect(input).toHaveCount(0);
            await expect(clip.locator('.rail-name')).toHaveText('Kick');
            expect((await node(page, 'clip-1')).name).toBe('Kick');
        });

        await test.step('typing outlives the patch tick; its space stays out of the transport', async () => {
            await clip.locator('.rail-name').dblclick();
            await input.fill('');
            await input.pressSequentially('Snare Top', { delay: 30 });
            // A patch pass writes every rail: another lane's new name
            // shows, and the editor still holds what was typed.
            await call(page, 'renameNode', 'clip-2', 'Hat');
            await expect(laneOf(page, 'clip-2').locator('.rail-name')).toHaveText('Hat');
            await expect(input).toHaveValue('Snare Top');
            expect((await root(page)).isPlaying).toBe(false);
            await input.press('Enter');
            await expect(clip.locator('.rail-name')).toHaveText('Snare Top');
        });
    });

    test('the input chip: on clip lanes only; its menu lists the device, dismisses untouched, and picks a mono input or a stereo pair', async ({ page }) => {
        const chip = laneOf(page, 'clip-1').locator('.input-btn');
        const menu = page.locator('.input-menu');
        const clip = () => node(page, 'clip-1');
        await expect(chip).toHaveText('in 1');
        // A group has no input of its own.
        await expect(laneOf(page, 'stack-1').locator('.input-btn')).toHaveCount(0);

        await test.step('Escape and a press outside close it and change nothing', async () => {
            await chip.click();
            // The mock's device has two channels: both, "· mono", and
            // both again as the right side of a pair.
            await expect(menu.locator('.input-item')).toHaveCount(5);
            await expect(menu.locator('.input-item.current').first())
                .toHaveText(/USB Audio Device\) 1/);
            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            await chip.click();
            await expect(menu).toHaveCount(1);
            await page.locator('#ruler').click();
            await expect(menu).toHaveCount(0);
            await expect(chip).toHaveText('in 1');
            expect((await clip()).inputChannel).toBe(0);
        });

        await test.step('the right list makes a stereo pair; "· mono" clears it', async () => {
            await chip.click();
            await menu.locator('.input-item', { hasText: '(USB Audio Device) 1' }).nth(1).click();
            await expect(menu).toHaveCount(0);
            await expect(chip).toHaveText('1/1');
            expect((await clip()).inputChannelR).toBe(0);
            await chip.click();
            await menu.locator('.input-item', { hasText: 'mono' }).click();
            await expect(chip).toHaveText('in 1');
            expect((await clip()).inputChannelR).toBe(-1);
        });

        await test.step('picking an input sets it and closes the menu', async () => {
            await chip.click();
            await menu.locator('.input-item', { hasText: '(USB Audio Device) 2' }).first().click();
            await expect(menu).toHaveCount(0);
            await expect(chip).toHaveText('in 2');
            expect((await clip()).inputChannel).toBe(1);
        });
    });

    test('popovers — creation menu, take list, input menu, plugin picker, successors, fades — keep one set of rules', async ({ page }) => {
        // Staged: the first clip selected with its fx row open, and a
        // one-step song on the group with its grid open.
        const clip = laneOf(page, 'clip-1');
        const rail = clip.locator('.lane-rail');
        await clip.locator('.rail-name').click();
        await clip.locator('.fx-btn').click();
        await expect(page.locator('.lane-fx')).toHaveCount(1);
        await laneOf(page, 'stack-1').locator('.seq-btn').click();
        await page.locator('.lane-seq .seq-start').click();
        await expect(page.locator('.lane-seq .seq-hcell')).toHaveCount(1);
        await expect(rail).toHaveClass(/selected/);

        const popovers = [
            ['creation menu', page.locator('#create-track-btn'), '.creation-menu'],
            ['take list', clip.locator('.take-btn'), '.take-menu'],
            ['input menu', clip.locator('.input-btn'), '.input-menu'],
            ['plugin picker', page.locator('.lane-fx .fx-add'), '.fx-picker'],
            ['successors', page.locator('.lane-seq .seq-hcell .seq-next'), '.seq-next-pop'],
            ['fades', page.locator('.lane-seq .seq-hcell .seq-hlen'), '.seq-fade-pop'],
        ];
        const anyOpen = page.locator(popovers.map(([, , sel]) => sel).join(', '));
        /** Hover first (the take chip and the → pip are hover-revealed),
         * then a real click at the trigger's centre. */
        const press = async trigger => {
            await trigger.hover();
            const at = await centreOf(trigger);
            await page.mouse.click(at.x, at.y);
        };

        await test.step('a second press on its trigger closes it', async () => {
            // (Not the creation menu: it opens with its default row under
            // the pointer, so a second press there is that row's.)
            for (const [name, trigger, sel] of popovers.slice(1)) {
                await press(trigger);
                await expect(page.locator(sel), name).toHaveCount(1);
                await press(trigger);
                await expect(page.locator(sel), name + ': toggled shut').toHaveCount(0);
            }
        });

        await test.step('Escape closes it and nothing else: the selection stays', async () => {
            for (const [name, trigger, sel] of popovers) {
                await press(trigger);
                await expect(page.locator(sel), name).toHaveCount(1);
                await page.keyboard.press('Escape');
                await expect(page.locator(sel), name).toHaveCount(0);
                await expect(rail, name + ': still selected').toHaveClass(/selected/);
            }
            // With nothing open, Escape is the view's again.
            await page.keyboard.press('Escape');
            await expect(rail).not.toHaveClass(/selected/);
        });

        await test.step('one at a time: opening one closes the one before; a press outside closes the last', async () => {
            for (const [name, trigger, sel] of popovers) {
                await press(trigger);
                await expect(page.locator(sel), name).toHaveCount(1);
                await expect(anyOpen, name + ': the only one').toHaveCount(1);
            }
            await page.locator('#ruler').click({ position: { x: 5, y: 5 } });
            await expect(anyOpen).toHaveCount(0);
        });
    });

    test('gain dials, on a clip and on a group: a vertical drag lowers the fader, a double-click restores unity', async ({ page }) => {
        for (const id of ['clip-1', 'stack-1']) {
            await test.step(id, async () => {
                const dial = laneOf(page, id).locator('.gain-dial');
                const gain = async () => (await node(page, id)).gain;
                await expect(dial).toBeVisible();
                // 75 px is the dial's whole sweep: half of it lands near
                // half volume.
                await dragBy(page, await centreOf(dial), 0, { dy: 38, steps: 5 });
                await expect.poll(gain).toBeLessThan(0.75);
                expect(await gain()).toBeGreaterThan(0.2);
                await expect(dial).toHaveClass(/off-center/);
                // Unity is the resting state (no boost above it).
                await dial.dblclick();
                await expect.poll(gain).toBe(1);
                await expect(dial).not.toHaveClass(/off-center/);
                // The whole sweep is silence.
                await dragBy(page, await centreOf(dial), 0, { dy: 75, steps: 5 });
                await expect.poll(gain).toBe(0);
            });
        }
    });

    test('⌘-click on the only selected rail keeps it selected; on another it adds', async ({ page }) => {
        const name = id => laneOf(page, id).locator('.rail-name');
        const rail = id => laneOf(page, id).locator('.lane-rail');
        await name('clip-2').click();
        await expect(rail('clip-2')).toHaveClass(/selected/);
        await name('clip-2').click({ modifiers: ['Meta'] });
        // ⌘-click another: the bar counts both — and clip-2 was still in.
        await name('clip-3').click({ modifiers: ['Meta'] });
        await expect(page.locator('#selection-bar .sel-count')).toHaveText('2 tracks selected');
        await expect(rail('clip-2')).toHaveClass(/selected/);
        await expect(rail('clip-3')).toHaveClass(/selected/);
        await expect(page.locator('.lane-rail.selected')).toHaveCount(2);
        // Taking one out again leaves the other; the last one stays.
        await name('clip-3').click({ modifiers: ['Meta'] });
        await name('clip-2').click({ modifiers: ['Meta'] });
        await expect(page.locator('#selection-bar')).not.toHaveClass(/open/);
        await expect(rail('clip-2')).toHaveClass(/selected/);
        await expect(page.locator('.lane-rail.selected')).toHaveCount(1);
    });

    test('a click inside an open transport panel is not a click on the transport: the selection stays', async ({ page }) => {
        const rail = laneOf(page, 'clip-2').locator('.lane-rail');
        await laneOf(page, 'clip-2').locator('.rail-name').click();
        await expect(rail).toHaveClass(/selected/);
        // Each panel hangs from the transport bar. A real click on its
        // padding, then on a heading — neither is a control.
        for (const [button, panel, heading] of [
            ['#project-menu-btn', '#project-menu', '.pm-head'],
            ['#prefs-btn', '#prefs-panel', '.ap-head'],
        ]) {
            await page.click(button);
            const el = page.locator(panel);
            await expect(el, panel).toBeVisible();
            const box = await el.boundingBox();
            await page.mouse.click(box.x + 2, box.y + 2);
            await el.locator(heading).first().click();
            await expect(el, panel + ' stays open').toBeVisible();
            await expect(rail, panel + ': still selected').toHaveClass(/selected/);
            await page.keyboard.press('Escape');
            await expect(el, panel).toBeHidden();
        }
        // The bar's own empty space still clears it.
        const bar = await centreOf(page.locator('#transport .spacer'));
        await page.mouse.click(bar.x, bar.y);
        await expect(rail).not.toHaveClass(/selected/);
    });

    test('DRUM FLOW: a group\'s ● records its empty tracks and leaves the full ones playing; with every track full it is a new take, and a fresh track records', async ({ page }) => {
        const Q = await quantum(page);
        const group = laneOf(page, 'stack-1');
        const groupArm = group.locator('.arm-btn');
        const clips = page.locator('.lane[data-kind="clip"]');
        const recording = async () => (await node(page, 'stack-1')).nodes
            .map(c => !!c.isRecording).join(',');
        // The kit: three tracks with takes, two empty.
        await call(page, 'createNode', 'clip', 'stack-1');
        await call(page, 'createNode', 'clip', 'stack-1');
        await expect(clips).toHaveCount(5);

        await expect(groupArm).toBeEnabled();
        await groupArm.click();
        await expect.poll(recording).toBe('false,false,false,true,true');
        await expect(group.locator('.rail-status')).toHaveText(/armed|recording|map live/);

        // ● again asks both to stop: they commit as the transport
        // crosses the next boundary (a stop pads forward).
        await mock(page, 'advanceBy', Math.round(0.6 * Q));
        await groupArm.click();
        await mock(page, 'advanceBy', Math.round(0.5 * Q));
        await expect.poll(recording).toBe('false,false,false,false,false');

        // Arm targets emptiness: with every track full the group's ●
        // is a NEW TAKE of them. A fresh track is added by hand and
        // records from its own ●.
        await expect(groupArm).toBeEnabled();
        await expect(groupArm).toHaveAttribute('title', /new take/i);
        await addTrack(page, '.lane-add .add-track-row-btn');
        await expect(clips).toHaveCount(6);
        const fresh = clips.nth(5);
        await expect(fresh.locator('.arm-btn')).toBeEnabled();
        await fresh.locator('.arm-btn').click();
        await expect.poll(() => recordCue(fresh)).toMatch(/armed|recording/);
        // Across the boundary it armed on, and some audio: the bar takes over.
        await mock(page, 'advanceBy', Math.round(1.5 * Q));
        await expect(page.locator('.lane .recording-bar')).toHaveCount(1);
    });
});

test.describe('Effects rack', () => {
    test.use({ scenario: 'stack-with-clips' });

    /** A node's chain by slot type (the root's with no id). */
    const chainOf = async (page, id) => Object.fromEntries(
        ((id ? await node(page, id) : await root(page)).effects.chain || [])
            .map(s => [s.type, s]));

    test('the fx chip opens the rack — a clip\'s, a group\'s, the master\'s: a powered card lights and counts on the chip; the chip folds the row', async ({ page }) => {
        for (const [who, id, chip, card] of [
            ['clip', 'clip-1', laneOf(page, 'clip-1').locator('.fx-btn'), 'echo'],
            ['group', 'stack-1', laneOf(page, 'stack-1').locator('.fx-btn'), 'reverb'],
            ['master', null, page.locator('#master-fx-btn'), 'reverb'],
        ]) {
            await test.step(who, async () => {
                const row = page.locator(`.lane.lane-fx[data-id="fx:${id || 'mock-root'}"]`);
                const slot = row.locator(`.fx-card[data-fx="${card}"]`);
                await expect(chip).toHaveText('fx');
                await chip.click();
                await expect(row).toBeVisible();
                await expect(row.locator('.fx-card')).toHaveCount(4);  // the fixed rack
                await slot.locator('.fx-power').click();
                await expect.poll(async () => (await chainOf(page, id))[card].enabled).toBe(true);
                await expect(slot).not.toHaveClass(/\boff\b/);
                await expect(chip).toHaveText('fx·1');
                await expect(chip).toHaveClass(/\bon\b/);
                if (!id) {
                    // The root has no lane: its rack is the first row,
                    // and its chip shows the row open.
                    await expect(page.locator('#lanes .lane').first())
                        .toHaveAttribute('data-id', 'fx:mock-root');
                    await expect(chip).toHaveClass(/\bopen\b/);
                }
                // The chip again: the row folds away, the state stays.
                await chip.click();
                await expect(row).toHaveCount(0);
                await expect(chip).toHaveText('fx·1');
                if (!id) await expect(chip).not.toHaveClass(/\bopen\b/);
                expect((await chainOf(page, id))[card].enabled).toBe(true);
            });
        }
    });

    test('VST3 chips: add from the picker, toggle, remove, undo', async ({ page }) => {
        const clip = laneOf(page, 'clip-1');
        await clip.locator('.fx-btn').click();
        const row = page.locator('.lane-fx');
        await expect(row.locator('.fx-card')).toHaveCount(4);

        // "+" lists the mock registry; a pick adds a chip (it arrives
        // enabled) and the chain gains a vst3 slot.
        await row.locator('.fx-add').click();
        const picker = row.locator('.fx-picker');
        await expect(picker.locator('.fx-picker-item')).toHaveCount(2);
        await picker.locator('.fx-picker-item', { hasText: 'Aurora Reverb' }).click();
        const chip = row.locator('.fx-card.fx-vst3');
        await expect(chip).toHaveCount(1);
        await expect(chip.locator('.fx-vst3-name')).toHaveText('Aurora Reverb');
        await expect(chip).not.toHaveClass(/\boff\b/);
        await expect.poll(async () => (await chainOf(page, 'clip-1')).vst3?.enabled).toBe(true);
        // It counts on the rail's chip like any slot.
        await expect(clip.locator('.fx-btn')).toHaveText('fx·1');

        await chip.locator('.fx-power').click();
        await expect(chip).toHaveClass(/\boff\b/);

        await chip.locator('.fx-remove').click();
        await expect(row.locator('.fx-card.fx-vst3')).toHaveCount(0);
        await undo(page);
        await expect(row.locator('.fx-card.fx-vst3')).toHaveCount(1);
    });

    test('the MIDI target follows selection: an instrument lane lights its MIDI chip and keeps it while an audio lane is selected', async ({ page }) => {
        const audio = laneOf(page, 'clip-1');
        await expect(audio.locator('.input-btn')).not.toHaveClass(/midi/);

        // An empty track whose chain carries an instrument IS a MIDI
        // track. (The registry's synth exists once a scan has run.)
        const id = await page.evaluate(async () => {
            const c = window.__celestrianTest.callNative;
            await c('scanPlugins');
            for (let i = 0; i < 5 && (await c('getPluginScanStatus')).scanning; i++);
            const id = await c('createNode', 'clip', '');
            const synth = (await c('getKnownPlugins')).find(p => p.isInstrument);
            await c('addPluginToChain', id, synth.uid, -1);
            return id;
        });
        const midi = laneOf(page, id);
        const chip = midi.locator('.input-btn');
        await expect(chip).toHaveClass(/midi/);
        await expect(chip).toHaveText(/MIDI/);
        await expect(chip).toBeDisabled();

        // Selected (by its NAME: a rail's centre can be a button, which
        // keeps its own verb), it is the keyboard's target.
        await midi.locator('.rail-name').click();
        await expect.poll(async () => (await node(page, id)).midiArmed).toBe(true);
        await expect(chip).toHaveClass(/\bon\b/);
        await expect(chip).toHaveText(/♪ MIDI/);

        // An audio lane selected leaves the target where it was: another
        // track can be tweaked without silencing the keys.
        await audio.locator('.rail-name').click();
        await expect(audio.locator('.lane-rail')).toHaveClass(/selected/);
        await settled(page);
        expect((await node(page, id)).midiArmed).toBe(true);
        await expect(chip).toHaveClass(/\bon\b/);
    });

    test('visualizations: every card draws; the compressor shows its gain reduction while crushing', async ({ page }) => {
        await laneOf(page, 'clip-1').locator('.fx-btn').click();
        const row = page.locator('.lane-fx');
        await expect(row.locator('canvas.fx-viz')).toHaveCount(4);
        const comp = row.locator('.fx-card[data-fx="compressor"]');

        // The compressor on, the transport somewhere loud (the mock's
        // scope peak there is well above the threshold).
        await comp.locator('.fx-power').click();
        await page.evaluate(() => {
            window.__celestrianTest.setIsPlaying(true);
            window.__celestrianTest.setMasterPos(24568);
        });
        await expect.poll(async () => (await node(page, 'clip-1')).effects.scope.gr)
            .toBeGreaterThan(1);
        await expect(comp.locator('.fx-gr')).toHaveText(/dB/);

        // The canvas has drawn pixels.
        await expect.poll(() => comp.locator('.fx-viz').evaluate(c => {
            const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return true;
            return false;
        })).toBe(true);
    });

    test('a slider held by the mouse keeps its value AND its label until the release, wherever that lands', async ({ page }) => {
        await laneOf(page, 'clip-1').locator('.fx-btn').click();
        const card = page.locator('.fx-card[data-fx="echo"]');
        const slider = card.locator('input[data-key="mix"]');
        const label = card.locator('.fx-param-value').nth(2);
        const feedback = card.locator('input[data-key="feedback"]');
        const echo = async () => (await chainOf(page, 'clip-1')).echo;
        const box = await slider.boundingBox();
        expect((await echo()).mix).toBeLessThan(1);
        // Press the slider, drag it to its right end and hold it there:
        // the value streams to the backend and the label reads it.
        const y = box.y + box.height / 2;
        await page.mouse.move(box.x + box.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width + 20, y, { steps: 4 });
        await expect.poll(async () => (await echo()).mix).toBe(1);
        expect([await slider.inputValue(), await label.textContent()]).toEqual(['1', '100%']);
        // The engine's values change under the hand (an undo, another
        // surface). The slider beside it follows at once — a poll has
        // patched — and the held one, with its label, does not move.
        const slot = (await echo()).slot;
        await call(page, 'setSlotParam', 'clip-1', slot, 'mix', 0.1);
        await call(page, 'setSlotParam', 'clip-1', slot, 'feedback', 0.33);
        await expect(feedback).toHaveValue('0.33');
        await expect(slider).toHaveValue('1');
        await expect(label).toHaveText('100%');
        // Let go well below the slider: the hold is over all the same.
        await page.mouse.move(box.x + box.width + 20, y + 120, { steps: 4 });
        await page.mouse.up();
        await expect(slider).toHaveValue('0.1');
        await expect(label).toHaveText('10%');
    });
});

test.describe('A loop window on a lane (1Q + 3Q under one stack)', () => {
    test.use({ scenario: '1q-3q-loop-bug' });

    const STACK = 'stack-1';

    /** Give the stack a [0, 2Q) window — bypassed when asked. */
    async function windowed(page, { bypassed = false } = {}) {
        const Q = await quantum(page);
        await setLoop(page, STACK, 0, 2 * Q);
        if (bypassed) await call(page, 'toggleLoopWindow', STACK);
        return Q;
    }

    test('an ACTIVE group window is the part: the lane rests heard, the frame and the playhead follow it; the chip is the bypass toggle', async ({ page }) => {
        const group = laneOf(page, STACK);
        await expect(lastTick(page)).toHaveText('3Q ↺');
        const Q = await windowed(page);
        // The frame is the audible cycle, lcm(1Q, 2Q): the lane shows
        // only what sounds — no dims, no brackets. Its loop chrome is
        // what a heard clip wears: the splice and the ↺.
        await expect(group.locator('.win-heard-chip')).toHaveText(/window 2Q/);
        await expect(lastTick(page)).toHaveText('2Q ↺');
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await expect(group.locator('.win-bracket')).toHaveCount(0);
        await expect(group.locator('.lr-splice.lr-wrap').first()).toBeVisible();
        await expect(group.locator('.lr-top:not(.lr-ghost)')).toHaveCount(1);
        // The playhead wraps with what is heard: a raw clock at 2.5Q is
        // 0.5Q into the 2Q frame — a quarter of the ruler — and the
        // readout needs no "loop" note.
        await mock(page, 'setMasterPos', 2.5 * Q);
        await expect(readout(page)).toHaveText(/0\.5Q \/ 2Q ↺(?! · loop)/);
        await expect.poll(async () => Math.abs(await playheadFrac(page) - 0.25))
            .toBeLessThan(0.03);

        // Bypassed through the engine verb: the raw 3Q frame is back,
        // with the toggle chip and the brackets, and it all plays.
        await call(page, 'toggleLoopWindow', STACK);
        const chip = group.locator('.win-chip');
        await expect(chip).toHaveText(/bypassed/);
        expect((await node(page, STACK)).loopBypassed).toBe(true);
        await expect(group.locator('.win-bracket.start')).toBeVisible();
        await expect(group.locator('.win-dim')).toHaveCount(0);
        await expect(lastTick(page)).toHaveText('3Q ↺');
        await expect(readout(page)).toHaveText(/2\.5Q \/ 3Q ↺(?! · loop)/);

        // That chip IS the bypass toggle: a click and the lane rests
        // heard again.
        await chip.click();
        await expect(group.locator('.win-heard-chip')).toHaveText(/window 2Q/);
        expect((await node(page, STACK)).loopBypassed).toBe(false);
        await expect(lastTick(page)).toHaveText('2Q ↺');
    });

    test('a bracket drag: the handle rides the pointer, a ghost previews the snap, the release lands on it; the start bracket leaves a 1Q window', async ({ page }) => {
        const Q = await windowed(page, { bypassed: true });
        const group = laneOf(page, STACK);
        const body = group.locator('.lane-body');
        const loop = async () => {
            const n = await node(page, STACK);
            return [n.loopStart / Q, n.loopEnd / Q].join(',');
        };
        const leftPct = sel => group.locator(sel).evaluate(el => parseFloat(el.style.left));
        // The window's own brackets arrive with its chip; until the poll
        // echoes it the end bracket is the latent one, at the take's end.
        await expect(group.locator('.win-chip')).toHaveText(/bypassed/);
        const end = group.locator('.win-bracket.end:not(.latent)');
        await expect(end).toBeVisible();

        // Held at 1.3Q of the 3Q lane: the handle is under the pointer,
        // the ghost on the snapped 1Q.
        const box = await body.boundingBox();
        await dragTo(page, await grip(end), box.x + box.width * (1.3 / 3),
            { steps: 4, hold: true });
        const ghost = group.locator('.win-bracket.snap-ghost');
        await expect(ghost).toHaveCount(1);
        await expect.poll(async () => Math.abs(await leftPct('.win-bracket.snap-ghost') - 100 / 3))
            .toBeLessThan(0.5);
        await expect.poll(async () => Math.abs(await leftPct('.win-bracket.end.dragging') - 130 / 3))
            .toBeLessThan(2);
        // Release: the ghost goes, the snap commits, the start held.
        await release(page);
        await expect(ghost).toHaveCount(0);
        await expect.poll(loop).toBe('0,1');

        // The start bracket of [0, 2Q), aimed past the end: it stops a
        // whole Q short of it.
        await setLoop(page, STACK, 0, 2 * Q);
        await expect.poll(async () => Math.abs(
            await leftPct('.win-bracket.end:not(.latent)') - 200 / 3)).toBeLessThan(0.5);
        await dragBracket(page, group.locator('.win-bracket.start'), body, 2.4, 3);
        await expect.poll(loop).toBe('1,2');
    });

    for (const [kind, id] of [['group', STACK], ['clip', 'clip-3q']]) {
        test(`a ${kind} lane: dragging a latent bracket in creates its window; active it rests heard, bypassed its chip is the toggle`, async ({ page }) => {
            const Q = await quantum(page);
            const lane = laneOf(page, id);
            // Whole: no window, latent brackets only — and none on the
            // 1Q lane, which has no sub-window to make.
            await expect(lane.locator('.win-bracket.latent')).toHaveCount(2);
            await expect(lane.locator('.win-chip')).toHaveCount(0);
            await expect(laneOf(page, 'clip-1q').locator('.win-bracket')).toHaveCount(0);
            // Handles are the selected track's.
            await lane.locator('.rail-name').click();

            // The latent end bracket, 3Q → 2Q: the window is real, and
            // the lane rests heard — the chip names the part's length,
            // the splice is the loop's handle.
            await dragBracket(page, lane.locator('.win-bracket.end'),
                lane.locator('.lane-body'), 2, 3);
            await expect.poll(async () => (await node(page, id)).loopEnd).toBe(2 * Q);
            expect((await node(page, id)).windowActive).toBe(true);
            await expect(lane.locator('.win-heard-chip')).toHaveText(/window 2Q/);
            await expect(lane.locator('.win-bracket')).toHaveCount(0);
            await expect(lane.locator('.lr-splice.lr-wrap').first()).toBeVisible();

            // Bypassed by the one engine verb, the raw frame returns with
            // the toggle chip; a click on it re-activates.
            await call(page, 'toggleLoopWindow', id);
            const chip = lane.locator('.win-chip');
            await expect(chip).toHaveText(/bypassed/);
            expect((await node(page, id)).loopBypassed).toBe(true);
            await chip.click();
            await expect(lane.locator('.win-heard-chip')).toHaveText(/window 2Q/);
            expect((await node(page, id)).loopBypassed).toBe(false);
        });
    }

    test('the heard lane wears no cursor of its own; the region panel carries the sound cursor in raw time', async ({ page }) => {
        const Q = await windowed(page);
        const group = laneOf(page, STACK);
        // Heard, the white playhead is honest on the lane.
        await expect(group.locator('.win-heard-chip')).toHaveText(/window 2Q/);
        await expect(group.locator('.win-cursor')).toHaveCount(0);

        // Selected, its panel shows the raw 3Q take, the kept region at
        // [0, 2Q), and the cursor: heard time in raw coordinates.
        await group.locator('.rail-name').click();
        const cursor = panelOf(page, STACK).locator('.region-cursor');
        await expect(cursor).toBeVisible();
        const leftPct = () => cursor.evaluate(el => parseFloat(el.style.left));
        // 1.5Q into the 2Q window is raw 1.5Q of the 3Q take: half way.
        await mock(page, 'setMasterPos', 1.5 * Q);
        await expect.poll(async () => Math.abs(await leftPct() - 50)).toBeLessThan(1);
        // A raw clock past the window wraps at the audible cycle: 0.5Q
        // of the take.
        await mock(page, 'setMasterPos', 2.5 * Q);
        await expect.poll(async () => Math.abs(await leftPct() - 100 / 6)).toBeLessThan(1);
        // Stopped: no cursor.
        await mock(page, 'setIsPlaying', false);
        await expect(cursor).toBeHidden();
    });
});

for (const row of [
    { what: 'clip', scenario: 'example-1q-4q', id: 'clip-1q', ghosts: 3,
      frame: '4Q ↺', frameOnce: '4Q ↺', member: null },
    // A 2Q beat beside a 3Q melody: a stack has an origin, so a group
    // plays once per cycle like a clip does.
    { what: 'group', scenario: 'multiple-stacks', id: 'stack-1', ghosts: 2,
      frame: '6Q ↺', frameOnce: '3Q ↺', member: 'clip-1' },
]) {
    test.describe(`A one-shot ${row.what}`, () => {
        test.use({ scenario: row.scenario });

        test(`the ↺ chip makes a ${row.what} play once per cycle: dashed, no ghosts, out of the frame; ⌘Z takes it back`, async ({ page }) => {
            const lane = laneOf(page, row.id);
            const chip = lane.locator('.oneshot-btn');
            await expect(lastTick(page)).toHaveText(row.frame);
            await expect(lane.locator('.rep.ghost')).toHaveCount(row.ghosts);
            await expect(chip).toHaveText('↺');

            // One-shot: only the take tile, the dashed lane, the knob in
            // the backend — and a one-shot never extends the frame.
            await chip.click();
            await expect(chip).toHaveText('1×');
            await expect(lane.locator('.lane-body')).toHaveClass(/one-shot/);
            await expect(lane.locator('.rep')).toHaveCount(1);
            await expect(lane.locator('.rep.ghost')).toHaveCount(0);
            expect((await node(page, row.id)).periodSource).toBe('context');
            await expect(lastTick(page)).toHaveText(row.frameOnce);
            // A one-shot group's member draws whole beneath it: no echoes.
            if (row.member) {
                await expect(laneOf(page, row.member).locator('.rep.ghost')).toHaveCount(0);
            }

            // A musical fact: ⌘Z takes it back.
            await undo(page);
            await expect(chip).toHaveText('↺');
            await expect(lane.locator('.rep.ghost')).toHaveCount(row.ghosts);
            await expect(lastTick(page)).toHaveText(row.frame);
        });
    });
}

test.describe('From an empty session', () => {

    /** Seed the template library through the backend, leaving no lane:
     * a routed Guitar clip and a three-mic Drums group. */
    const seedTemplates = page => page.evaluate(async () => {
        const c = window.__celestrianTest.callNative;
        const g = await c('createNode', 'clip', '');
        await c('renameNode', g, 'Guitar');
        await c('setNodeInput', g, 3);
        await c('saveTrackTemplate', g, 'Guitar');
        await c('deleteNode', g);
        const s = await c('createNode', 'stack', '');
        await c('renameNode', s, 'Drums');
        for (let i = 0; i < 3; i++) {
            const mic = await c('createNode', 'clip', s);
            await c('renameNode', mic, `Mic ${i + 1}`);
            await c('setNodeInput', mic, i);
        }
        await c('saveTrackTemplate', s, 'Drums');
        await c('deleteNode', s);
    });

    test('FIRST TAKE: the empty session is its ＋; ＋ Track, its ●, ● again — a committed take', async ({ page }) => {
        const Q = await quantum(page);
        // Wordless: the ＋ is the whole invitation.
        await expect(page.locator('#empty-state')).toBeVisible();
        await expect(page.locator('#empty-state')).toHaveText('');
        await expect(page.locator('.lane')).toHaveCount(0);

        // ＋ opens the creation menu with its fixed default row under
        // the pointer: click-click makes a bare track.
        await page.click('#create-track-btn');
        const menu = page.locator('.creation-menu');
        await expect(menu.locator('.creation-item.default')).toHaveText(/Track/);
        await menu.locator('.creation-item.default').click();
        await expect(menu).toHaveCount(0);
        const lane = page.locator('.lane[data-kind="clip"]');
        await expect(lane).toHaveCount(1);
        await expect(lane.locator('.rail-sub')).toHaveText('empty');

        // The track's ● is the record verb (there is no global one).
        // Armed is the head-row word; once audio flows the cue is the
        // pulsing sub-line.
        const arm = lane.locator('.arm-btn');
        await expect(arm).toBeEnabled();
        await arm.click();
        await expect.poll(() => recordCue(lane)).toMatch(/armed|recording/);

        // 2Q of audio, then stop from the same button: one solid tile,
        // and ● now means NEW TAKE (arm targets emptiness).
        await mock(page, 'setMasterPos', 2 * Q);
        await arm.click();
        await expect(lane.locator('.rep:not(.ghost)')).toHaveCount(1);
        await expect(arm).toBeEnabled();
        await expect(arm).toHaveAttribute('title', /new take/i);
    });

    test('NO FLASH: committing a take leaves every other lane\'s DOM in place', async ({ page }) => {
        const clips = page.locator('.lane[data-kind="clip"]');
        /** A lane's ●, and then the clock is this case's: time moves by
         * `advanceBy` alone. (● reads what the view last polled, so the
         * next press comes once the lane shows its take.) */
        const arm = async lane => {
            await lane.locator('.arm-btn').click();
            await expect.poll(() => recordCue(lane)).toMatch(/armed|recording/);
            await mock(page, 'pauseTransport');
        };
        // A committed take — it sets Q — then a second track recording
        // 1.5Q from the boundary the first ended on. Both through the
        // chrome.
        await addTrack(page);
        await arm(clips.first());
        await mock(page, 'advanceBy', await quantum(page));
        await clips.locator('.arm-btn').click();
        await expect(clips.locator('.rep:not(.ghost)')).toHaveCount(1);
        await expect(clips.locator('.recording-bar')).toHaveCount(0);
        const Q = (await root(page)).quantum;
        await addTrack(page);
        await expect(clips).toHaveCount(2);
        const second = clips.nth(1);
        await arm(second);
        await mock(page, 'advanceBy', Math.round(1.5 * Q));
        await expect(second.locator('.recording-bar')).toBeVisible();

        // Mark the first lane's tile and its canvas.
        await clips.first().locator('.rep').first().evaluate(rep => {
            window.__keepRep = rep;
            window.__keepCanvas = rep.querySelector('canvas');
        });

        // Stopped mid-Q the take pads to the boundary (its live length
        // gains an ellipsis) and commits as the transport crosses 2Q.
        // The frame grows 1Q → 2Q and everything is laid out again —
        // with the first lane's tile and canvas still the same nodes.
        await second.locator('.arm-btn').click();
        await expect(second.locator('.rail-sub')).toHaveText(/…$/);
        await mock(page, 'advanceBy', Math.round(0.5 * Q) + 10);
        await expect(readout(page)).toHaveText(/2Q ↺/);
        expect(await page.evaluate(() => ({
            repConnected: window.__keepRep.isConnected,
            canvasConnected: window.__keepCanvas.isConnected,
            repStillFirst: window.__keepRep ===
                document.querySelectorAll('.lane[data-kind="clip"]')[0].querySelector('.rep'),
        }))).toEqual({ repConnected: true, canvasConnected: true, repStillFirst: true });
    });

    test('track templates: saved from a selection; inserted named and routed, one ⌘Z removing it whole; a group lands whole', async ({ page }) => {
        const clips = page.locator('.lane[data-kind="clip"]');
        const menuRow = name => page.locator('.creation-item', { hasText: name });

        await test.step('save from selection: the menu grows the library', async () => {
            await addTrack(page);
            await expect(clips).toHaveCount(1);
            const id = await clips.getAttribute('data-id');
            await call(page, 'renameNode', id, 'Keys');
            await call(page, 'setNodeInput', id, 1);
            await expect(clips.locator('.rail-name')).toHaveText('Keys');
            await clips.locator('.rail-name').click();
            await page.click('#create-track-btn');
            const input = page.locator('.creation-save-input');
            await expect(input).toBeVisible();
            await expect(input).toHaveAttribute('placeholder', /Keys/);
            await input.fill('Keys');
            await page.click('.creation-save-btn');
            await expect(page.locator('.creation-menu')).toHaveCount(0);
            // Reopened, the template is a row; it stamps a copy.
            await page.click('#create-track-btn');
            await menuRow('Keys').click();
            await expect(clips).toHaveCount(2);
            await expect(clips.nth(1).locator('.rail-name')).toHaveText('Keys');
        });

        await seedTemplates(page);

        await test.step('insert: named and routed on arrival; one undo removes it', async () => {
            await page.click('#create-track-btn');
            await menuRow('Guitar').click();
            await expect(clips).toHaveCount(3);
            await expect(clips.nth(2).locator('.rail-name')).toHaveText('Guitar');
            // The saved routing: channel 4 is index 3.
            await expect(clips.nth(2).locator('.input-btn')).toHaveText(/in 4/);
            await undo(page);
            await expect(clips).toHaveCount(2);
        });

        await test.step('a group template lands whole', async () => {
            await page.click('#create-track-btn');
            await expect(menuRow('Drums').locator('.creation-item-meta')).toHaveText('3 tracks');
            await menuRow('Drums').click();
            await expect(page.locator('.lane[data-kind="group"]')).toHaveCount(1);
            await expect(clips).toHaveCount(5);
        });
    });

    test('a long template list stays inside the window and scrolls to its last row', async ({ page }) => {
        await page.setViewportSize({ width: 1000, height: 420 });
        await page.evaluate(async () => {
            const c = window.__celestrianTest.callNative;
            const g = await c('createNode', 'clip', '');
            for (let i = 1; i <= 16; i++) {
                await c('renameNode', g, 'Rig ' + i);
                await c('saveTrackTemplate', g, 'Rig ' + i);
            }
            await c('deleteNode', g);
        });
        await page.click('#create-track-btn');
        const menu = page.locator('.creation-menu');
        const last = menu.locator('.creation-item', { hasText: 'Rig 16' });
        await expect(last).toHaveCount(1);
        const box = await menu.boundingBox();
        expect(box.y + box.height, 'the menu ends inside the window')
            .toBeLessThanOrEqual(page.viewportSize().height);
        // The default row is still the one under the pointer…
        const btn = await centreOf(page.locator('#create-track-btn'));
        const first = await menu.locator('.creation-item.default').boundingBox();
        expect(first.y).toBeLessThanOrEqual(btn.y);
        expect(first.y + first.height).toBeGreaterThanOrEqual(btn.y);
        // …and the last template is a wheel away: scroll to it, pick it.
        const inside = async () => {
            const b = await last.boundingBox();
            return b.y >= box.y && b.y + b.height <= box.y + box.height;
        };
        expect(await inside(), 'it starts below the fold').toBe(false);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, 120);
        await expect.poll(inside).toBe(true);
        const at = await centreOf(last);
        await page.mouse.click(at.x, at.y);
        await expect(page.locator('.lane[data-kind="clip"] .rail-name')).toHaveText('Rig 16');
    });

    test('R on an empty project creates and arms the default track', async ({ page }) => {
        await expect(page.locator('#empty-state')).toBeVisible();
        await page.keyboard.press('r');
        await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(1);
        // A first take on an empty island captures at once.
        await expect.poll(async () => {
            const { nodes } = await graph(page);
            return nodes.length === 1 && !!nodes[0].isRecording;
        }).toBe(true);
    });

    test('Project ▾: the pre-birth verbs read right; Save births the project; Rename edits the name, never the id', async ({ page }) => {
        const button = page.locator('#project-menu-btn');
        const menu = page.locator('#project-menu');
        const item = text => menu.locator(`.pm-item:has-text("${text}")`);
        await button.click();
        await expect(menu).toBeVisible();
        // Unborn: Save offers to create today's project, and there is
        // nothing to fork and nothing to bounce.
        await expect(menu.locator('.pm-item').first())
            .toHaveText('Save now — creates today’s project');
        await expect(item('Duplicate project')).toBeDisabled();
        await expect(item('Bounce song…')).toBeDisabled();
        // A click away closes it.
        await page.click('#session', { position: { x: 40, y: 40 } });
        await expect(menu).not.toBeVisible();

        // Birth: the button reads the dated id (YYYYMMDD-NN).
        await button.click();
        await item('Save now').click();
        await expect(button).toHaveText(/^\d{8}-\d{2} ▾$/);
        const id = (await button.textContent()).replace(' ▾', '');
        // Renamed by the inline row, the display name changes…
        await button.click();
        const rename = menu.locator('.pm-inline', { hasText: 'Rename' });
        await rename.locator('input').fill('Slow Burn');
        await rename.locator('button').click();
        await expect(button).toHaveText('Slow Burn ▾');
        // …and the id (its folder) stays beneath, in the recents row.
        await button.click();
        await expect(item(`Slow Burn · ${id}`)).toBeVisible();
    });
});

/* The first take sets Q, and its brackets trim it freely (sub-Q): the
 * frame is the whole take and stays put, a bracket lands where the
 * pointer went, and the far bracket never moves on its own. A group
 * take trims exactly as a sole clip does. */
test.describe('The Q-definer\'s trim view', () => {

    /** Record a first take of `seconds` into a new group of two tracks
     * (`group`) or a new track; answers the id that was armed. */
    const firstTake = (page, seconds, { group }) => page.evaluate(async ({ seconds, group }) => {
        const { callNative: c, advanceBy } = window.__celestrianTest;
        const rate = (await c('getGraphState')).perf.sampleRate;
        const id = await c('createNode', group ? 'stack' : 'clip', '');
        if (group) {
            await c('createNode', 'clip', id);
            await c('createNode', 'clip', id);
        }
        await c('startRecordingInNode', id);
        advanceBy(seconds * rate);
        await c('stopRecordingInNode', id);
        return id;
    }, { seconds, group });

    const islandQ = async page => (await root(page)).quantum;
    const leftPct = handle => handle.evaluate(el => parseFloat(el.style.left));

    test('a group take: one bracket moves alone and the frame stays the whole take; the dims are the selection\'s complement; the composite is never redrawn', async ({ page }) => {
        const id = await firstTake(page, 4, { group: true });
        const group = laneOf(page, id);
        const body = group.locator('.lane-body');
        const start = group.locator('.win-bracket.start');
        const end = group.locator('.win-bracket.end');
        await expect(group.locator('.win-chip')).toContainText('sets tempo');
        await expect(lastTick(page)).toHaveText('1Q ↺');
        const D = await islandQ(page);   // the whole take
        expect(D).toBeGreaterThan(0);
        /** The stack once `edge` has come to within 0.05 D of `frac`. */
        const landed = async (edge, frac) => {
            await expect.poll(async () =>
                Math.abs((await node(page, id))[edge] / D - frac)).toBeLessThan(0.05);
            return node(page, id);
        };

        // The composite, once the members' peaks have landed — and a
        // count of every canvas its tile gains from here on.
        const snap = () => group.locator('.rep canvas').first().evaluate(el => el.toDataURL());
        await expect.poll(async () => (await snap()).length, { timeout: 5000 })
            .toBeGreaterThan(3000);
        const before = await atRest(snap);
        await group.locator('.rep').first().evaluate(rep => {
            window.__tile = rep;
            window.__canvasesAdded = 0;
            new MutationObserver(records => {
                for (const r of records) {
                    for (const n of r.addedNodes) {
                        if (n.nodeName === 'CANVAS') window.__canvasesAdded++;
                    }
                }
            }).observe(rep, { childList: true, subtree: true });
        });

        await test.step('start → 50%: the selection is [D/2, D), Q its length; the end holds', async () => {
            await dragToFrac(page, start, body, 0.5);
            const st = await landed('loopStart', 0.5);
            expect(st.loopEnd).toBe(D);
            expect(await islandQ(page)).toBe(st.loopEnd - st.loopStart);
            await expect(lastTick(page)).toHaveText('2Q ↺');
            // The bracket rests where the pointer left it.
            await expect.poll(async () => Math.abs(await leftPct(start) - 50)).toBeLessThan(3);
        });

        await test.step('start → 25%: the selection grows leftward; the frame is still the whole take', async () => {
            await dragToFrac(page, start, body, 0.25);
            const st = await landed('loopStart', 0.25);
            expect(st.loopEnd).toBe(D);
            expect(await islandQ(page)).toBe(st.loopEnd - st.loopStart);
            // 4/3 of the new Q, drawn whole: the tile fills the lane and
            // the bracket sits at loopStart / D of it.
            await expect.poll(async () =>
                Math.abs(await leftPct(start) - 100 * st.loopStart / D)).toBeLessThan(1);
            expect(await group.locator('.rep').first().evaluate(el => el.style.width))
                .toBe('100%');
        });

        await test.step('end → 70%: only the end moves; the dims are exactly what is outside the brackets', async () => {
            const startWas = (await node(page, id)).loopStart;
            await dragToFrac(page, end, body, 0.7);
            const st = await landed('loopEnd', 0.7);
            expect(st.loopStart).toBe(startWas);
            expect(await islandQ(page)).toBe(st.loopEnd - st.loopStart);
            // A fractional frame (the take is 2.2 Q): one dim each side
            // of the selection, nothing on a Q grid line.
            await expect(group.locator('.win-dim')).toHaveCount(2);
            await expect.poll(async () => {
                const dims = await group.locator('.win-dim').evaluateAll(els => els
                    .map(el => [parseFloat(el.style.left), parseFloat(el.style.width)])
                    .sort((a, b) => a[0] - b[0]));
                const a = await leftPct(start);
                const b = await leftPct(end);
                return Math.max(Math.abs(dims[0][0]), Math.abs(dims[0][0] + dims[0][1] - a),
                    Math.abs(dims[1][0] - b), Math.abs(dims[1][0] + dims[1][1] - 100));
            }).toBeLessThan(0.5);
        });

        // Three re-trims on, the composite is the same canvas with the
        // same pixels: no cross-fade pair was ever made.
        await settled(page);
        expect(await page.evaluate(() =>
            [window.__tile.isConnected, window.__canvasesAdded])).toEqual([true, 0]);
        await expect(group.locator('.rep canvas')).toHaveCount(1);
        expect(await snap()).toBe(before);
    });

    test('a sole clip trims the same way', async ({ page }) => {
        const id = await firstTake(page, 4, { group: false });
        const lane = laneOf(page, id);
        await expect(lane.locator('.win-chip')).toContainText('sets tempo');
        const D = await islandQ(page);
        await dragToFrac(page, lane.locator('.win-bracket.start'), lane.locator('.lane-body'), 0.5);
        await expect.poll(async () =>
            Math.abs((await node(page, id)).loopStart / D - 0.5)).toBeLessThan(0.05);
        const clip = await node(page, id);
        expect(clip.loopEnd).toBe(D);
        expect(await islandQ(page)).toBe(clip.loopEnd - clip.loopStart);
        await expect(lastTick(page)).toHaveText('2Q ↺');
    });
});
