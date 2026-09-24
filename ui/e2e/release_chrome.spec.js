/**
 * THE RELEASE LIFECYCLE + THE CHROME AROUND A MAP DRAG (docs/frame.md
 * §1; docs/time_maps.md §7; session_view/map_core.js runRawDrag).
 *
 * Field video: after a loop-region drag the "↺ loop top" chip showed
 * twice (11.0 s), the panel's box snapped back for a round trip, the
 * stale heard chrome stayed lit during lane drags, and the white
 * island playhead crossed the raw-take panel. What this pins, with REAL
 * mouse input (synthetic dispatch bypasses hit-testing) and an
 * emulated bridge round trip on setSegments:
 *   1. after release the held overlay never shows the PRE-drag chrome
 *      (panel box / brackets; the lane's loop-top chip and grips) —
 *      sampled on every animation frame until the rebuild;
 *   2. during a lane drag, with the pointer over the lane, the stale
 *      heard chrome reads computed opacity 0 (the hover reveals lose);
 *   3. the playhead's mask carves out the region panel, and a revealing
 *      lane from the frame it engages to the frame it tears down;
 *   4. while a take is pending, a grip / box press, a double-click and
 *      ←/→ do nothing — no preview, no bridge call.
 */

import { test, expect } from '@playwright/test';
import { boot, quantum, loopOf, recordDefinerAndTake, setLoop, laneOf,
         panelOf, stripOf, viewOf, stripX, recordMapCalls, selectLane, segsOf }
    from './region_panel_helpers.js';

/* The emulated bridge round trip for setSegments (ms). */
const BRIDGE_MS = 150;

/** Start an every-animation-frame sampler in the page. `probe` is a
 * function SOURCE evaluated each frame; samples collect in
 * window.__samples with the frame's time. */
async function startSampler(page, probeSrc, arg) {
    await page.evaluate(({ probeSrc, arg }) => {
        // eslint-disable-next-line no-new-func
        const probe = new Function('arg', 'return (' + probeSrc + ')(arg);');
        window.__samples = [];
        window.__sampling = true;
        const tick = () => {
            if (!window.__sampling) return;
            window.__samples.push(Object.assign({ t: performance.now(),
                up: !!window.__upAt }, probe(arg)));
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, { probeSrc: probeSrc.toString(), arg });
}
const stopSampler = page => page.evaluate(() => {
    window.__sampling = false;
    return window.__samples;
});
/** Mark the release in the sampler's timeline, then release. */
async function releaseMarked(page) {
    await page.evaluate(() => { window.__upAt = performance.now(); });
    await page.mouse.up();
}

test.describe('Release lifecycle', () => {
    test('panel slide: the held box never shows at the pre-drag place', async ({ page }) => {
        await boot(page, { bridgeDelayMs: BRIDGE_MS });
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        await laneOf(page, id2).locator('.rail-name').click();
        const lane = laneOf(page, id2);
        await expect(panelOf(page, id2)).toBeVisible();
        // The panel opens FIT TO THE LOOP; ⇧Z shows the whole 12Q take,
        // the geometry the sampler below reads positions in.
        await page.keyboard.press('Shift+Z');
        await expect.poll(async () => (await viewOf(page, id2)).spanQ).toBe(12);
        const strip = await stripOf(page, id2).boundingBox();
        const y = strip.y + strip.height / 2;
        await startSampler(page, id => {
            const lane = document.querySelector(`.lane[data-id="${id}"]`);
            const o = lane.querySelector('.region-overlay');
            const seen = el => {
                const cs = getComputedStyle(el);
                return cs.display !== 'none' && parseFloat(cs.opacity) > 0.05;
            };
            const q = el => parseFloat(el.style.left) / 100 * 12;
            const layer = o.querySelector(':scope > .drag-preview-layer');
            return {
                kept: [...o.querySelectorAll(':scope > .region-kept')]
                    .filter(seen).map(q),
                brackets: [...o.querySelectorAll(':scope > .region-bracket')]
                    .filter(seen).map(q)
                    .concat(layer && seen(layer)
                        ? [...layer.querySelectorAll('.win-bracket')].map(q) : []),
            };
        }, id2);
        // SLIDE the box +2Q (whole-Q steps): [6, 10) → [8, 12).
        const kept = await lane.locator('.region-kept').boundingBox();
        const kx = kept.x + kept.width / 2;
        await page.mouse.move(kx, y);
        await page.mouse.down();
        await page.mouse.move(kx + strip.width * (2.2 / 12), y, { steps: 10 });
        await releaseMarked(page);
        await expect.poll(() => loopOf(page, id2, Q)).toBe('8,12');
        await expect.poll(async () => {
            const k = await lane.locator('.region-kept').boundingBox();
            return k ? (k.x - strip.x) / strip.width : -1;
        }).toBeCloseTo(8 / 12, 2);
        await page.waitForTimeout(150);
        const samples = await stopSampler(page);
        const after = samples.filter(s => s.up);
        expect(after.length, 'frames sampled after release').toBeGreaterThan(5);
        for (const s of after) {
            for (const k of s.kept) {
                expect(Math.abs(k - 6), `frame ${s.t.toFixed(0)}: a box at the pre-drag 6Q`)
                    .toBeGreaterThan(0.05);
            }
            for (const b of s.brackets) {
                expect(Math.abs(b - 6) > 0.05 && Math.abs(b - 10) > 0.05,
                    `frame ${s.t.toFixed(0)}: a bracket at the pre-drag ${b.toFixed(2)}Q`)
                    .toBe(true);
            }
        }
        // The held frames show the landing (the preview's brackets).
        expect(after.some(s => s.brackets.some(b => Math.abs(b - 8) < 0.05)))
            .toBe(true);
    });

    test('lane ⌥-slide: the loop-top chip never doubles, and hides while dragging', async ({ page }) => {
        await boot(page, { bridgeDelayMs: BRIDGE_MS });
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        // [6.4, 9.4): a 3Q loop whose top rests 0.4Q into the frame —
        // the paired ][ grips and the "↺ loop top" chip mid-lane.
        await setLoop(page, id2, Math.round(6.4 * Q), Math.round(9.4 * Q));
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        await expect(body.locator('.loop-top-chip')).toHaveCount(1);
        const box = await body.boundingBox();
        const qAt = x => (x - box.x) / box.width * 3;
        const chip0 = await body.locator('.loop-top-chip').boundingBox();
        expect(qAt(chip0.x + chip0.width / 2)).toBeCloseTo(0.4, 1);
        await startSampler(page, id => {
            const lane = document.querySelector(`.lane[data-id="${id}"]`);
            const body = lane.querySelector('.lane-body');
            const o = body.querySelector(':scope > .overlay-layer');
            const br = body.getBoundingClientRect();
            const qOf = r => ((r.left + r.width / 2) - br.left) / br.width * 3;
            const op = el => parseFloat(getComputedStyle(el).opacity);
            const chips = [...o.querySelectorAll(':scope > .loop-top-chip')];
            const grips = [...o.querySelectorAll(':scope > .trim-grip')];
            // The white playhead's mask: does it carve this body out?
            const ph = document.getElementById('playhead');
            const pr = ph.getBoundingClientRect();
            const top = (br.top - pr.top) / pr.height * 100;
            const bot = (br.bottom - pr.top) / pr.height * 100;
            const bands = [...(ph.style.maskImage || '').matchAll(
                /transparent ([\d.]+)%, transparent ([\d.]+)%/g)]
                .map(m => [+m[1], +m[2]]);
            return {
                live: o.classList.contains('drag-live'),
                revealing: body.classList.contains('revealing'),
                masked: bands.some(([a, b]) => a <= top + 0.5 && b >= bot - 0.5),
                chips: chips.map(c => ({ q: qOf(c.getBoundingClientRect()), op: op(c) })),
                gripOps: grips.map(op),
                hovered: body.matches(':hover'),
            };
        }, id2);
        // ⌥-drag the END grip (the "]" of the pair) left by 0.2Q:
        // [6.2, 9.2) — the top moves to 0.2Q; no re-seat (±½Q).
        const eb = await body.locator('.trim-grip.end').boundingBox();
        const gx = eb.x + eb.width / 2;
        const gy = eb.y + eb.height / 2;
        await page.mouse.move(gx, gy);
        await page.keyboard.down('Alt');
        await page.mouse.down();
        await page.mouse.move(gx - box.width * (0.2 / 3), gy, { steps: 10 });
        await expect(body).toHaveClass(/revealing/);
        await page.waitForTimeout(120);   // frames under a held, hovering pointer
        await releaseMarked(page);
        await page.keyboard.up('Alt');
        await expect.poll(async () => (await loopOf(page, id2, Q))
            .split(',').map(v => (+v).toFixed(2)).join(',')).toBe('6.20,9.20');
        await expect(body).not.toHaveClass(/revealing/);
        await expect.poll(async () => {
            const c = await body.locator('.loop-top-chip').boundingBox();
            return c ? qAt(c.x + c.width / 2) : -1;
        }).toBeCloseTo(0.2, 1);
        await page.waitForTimeout(100);
        const samples = await stopSampler(page);

        // 2. STALE CHROME HIDDEN MID-DRAG, pointer over the lane.
        const dragging = samples.filter(s => s.live && !s.up);
        expect(dragging.length, 'frames sampled mid-drag').toBeGreaterThan(3);
        expect(dragging.some(s => s.hovered), 'the pointer is over the lane').toBe(true);
        for (const s of dragging) {
            for (const c of s.chips) expect(c.op, 'stale chip mid-drag').toBe(0);
            for (const o of s.gripOps) expect(o, 'stale grip mid-drag').toBe(0);
        }
        // 1. NO DOUBLE CHIP: after release, no visible chip at the
        // pre-drag 0.4Q — ever; the held frames show none, the rebuild
        // shows the new one.
        const after = samples.filter(s => s.up);
        expect(after.length).toBeGreaterThan(5);
        for (const s of after) {
            for (const c of s.chips) {
                if (c.op > 0.05) {
                    expect(Math.abs(c.q - 0.4), `frame ${s.t.toFixed(0)}: chip at the pre-drag top`)
                        .toBeGreaterThan(0.08);
                }
            }
        }
        expect(after.some(s => s.live), 'the preview is held past the release').toBe(true);
        // 3. THE MASK FOLLOWS THE REVEAL frame-for-frame: carved out
        // from the frame the lane reveals to the frame it relaxes.
        for (const s of samples) {
            expect(s.masked, `frame ${s.t.toFixed(0)}: mask ${s.masked} vs revealing ${s.revealing}`)
                .toBe(s.revealing);
        }
    });

    test('panel cut resize: the frame settles ONCE, after the final commit', async ({ page }) => {
        // Review 2026-09-23: cut-band drags (appendCutBands) dropped the
        // frame pin at pointerup, so a poll carrying the last LIVE cut
        // re-seated the frame before the final commit answered — every
        // lane rescaled twice (7Q → 6Q → 5Q). Their onEnd now returns
        // the commit and the pin holds until it settles.
        await page.setViewportSize({ width: 1400, height: 900 });
        await boot(page, { bridgeDelayMs: BRIDGE_MS });
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await page.evaluate(({ id, Q }) => window.__celestrianTest.callNative(
            'setSegments', id, [2 * Q, 5 * Q, 6 * Q, 10 * Q]), { id: id2, Q });
        await expect.poll(() => segsOf(page, id2, Q)).toBe('2,5,6,10');
        await selectLane(page, id2);
        await page.keyboard.press('Shift+Z');
        await expect.poll(async () => (await viewOf(page, id2)).spanQ).toBe(12);
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        await expect.poll(() => body.evaluate(b => b._cycleQ)).toBe(7);
        const h = lane.locator('.region-overlay .cut-handle.end');
        await expect(h).toHaveCount(1);
        const hb = await h.boundingBox();
        const y = hb.y + hb.height / 2;
        const x0 = hb.x + hb.width / 2;
        const x1 = await stripX(page, id2, 7.1);
        await page.mouse.move(x0, y);
        await page.mouse.down();
        // A LIVE commit lands a 2Q cut [5,7) (period 6) mid-drag…
        for (let i = 1; i <= 5; i++) {
            await page.mouse.move(x0 + (x1 - x0) * i / 5, y);
            await page.waitForTimeout(120);
        }
        await page.waitForTimeout(500);
        // …then the final move makes it 3Q [5,8) (period 5) and releases.
        await body.evaluate(b => {
            window.__frames = [];
            const t0 = performance.now();
            const tick = () => {
                window.__frames.push(b._cycleQ);
                if (performance.now() - t0 < 900) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
        await page.mouse.move(await stripX(page, id2, 8.1), y, { steps: 1 });
        await page.mouse.up();
        await page.waitForTimeout(1000);
        const frames = await page.evaluate(() => window.__frames);
        const distinct = frames.filter((c, i) => i === 0 || c !== frames[i - 1]);
        expect(distinct, 'the frame goes straight from 7Q to 5Q').toEqual([7, 5]);
        expect(await segsOf(page, id2, Q)).toBe('2,5,8,10');
    });
});

test.describe('Playhead mask', () => {
    test('the white playhead never crosses the region panel', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        await laneOf(page, id2).locator('.rail-name').click();
        await expect(panelOf(page, id2)).toBeVisible();
        await page.evaluate(() => window.__celestrianTest.startTransport());
        await expect(page.locator('#playhead')).toBeVisible();
        await expect.poll(() => page.evaluate(id => {
            const ph = document.getElementById('playhead');
            const pr = ph.getBoundingClientRect();
            const nr = document.querySelector(`.lane[data-id="${id}"] .lane-region`)
                .getBoundingClientRect();
            const top = (nr.top - pr.top) / pr.height * 100;
            const bot = (nr.bottom - pr.top) / pr.height * 100;
            const bands = [...(ph.style.maskImage || '').matchAll(
                /transparent ([\d.]+)%, transparent ([\d.]+)%/g)]
                .map(m => [+m[1], +m[2]]);
            return bands.some(([a, b]) => a <= top + 0.5 && b >= bot - 0.5);
        }, id2)).toBe(true);
        // Deselect: the panel goes, and so does its carve-out.
        await page.keyboard.press('Escape');
        await expect(panelOf(page, id2)).toBeHidden();
        await expect.poll(() => page.evaluate(() =>
            document.getElementById('playhead').style.maskImage || '')).toBe('');
    });
});

test.describe('Recording gate', () => {
    test('while a take is pending, no loop-region gesture does anything', async ({ page }) => {
        await boot(page);
        const Q = await quantum(page);
        const { id2 } = await recordDefinerAndTake(page, Q, 12);
        await setLoop(page, id2, 6 * Q, 10 * Q);
        const lane = laneOf(page, id2);
        const body = lane.locator('.lane-body');
        await lane.locator('.rail-name').click();
        await expect(panelOf(page, id2)).toBeVisible();
        const calls = recordMapCalls(page);
        // ARM a new track: pending on its boundary (transport paused, so
        // it stays pending) — a take is active.
        const id3 = await page.evaluate(async () => {
            const t = window.__celestrianTest;
            t.pauseTransport();
            const id = await t.callNative('createNode', 'clip', '');
            await t.callNative('startRecordingInNode', id);
            return id;
        });
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        await lane.locator('.rail-name').click();   // the track keeps its panel
        await expect(panelOf(page, id2)).toBeVisible();

        // A GRIP PRESS: the grips still draw (inert) and take no press.
        // They stay HOVERABLE so their tooltip explains the gate (review
        // 2026-09-23: a hit-test-transparent grip could never show it).
        const grip = body.locator('.trim-grip.end');
        await expect(grip).toHaveCount(1);
        await expect(grip).toHaveClass(/inert/);
        const gb = await grip.boundingBox();
        const gx = gb.x + gb.width / 2;
        const gy = gb.y + gb.height / 2;
        expect(await grip.evaluate(g => getComputedStyle(g).cursor)).toBe('default');
        expect(await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y).closest('.trim-grip');
            return hit ? hit.title : null;
        }, { x: gx, y: gy })).toMatch(/wait until the take finishes/i);
        await page.mouse.move(gx, gy);
        await page.mouse.down();
        await page.waitForTimeout(220);
        await page.mouse.move(gx - 80, gy, { steps: 6 });
        await expect(body).not.toHaveClass(/revealing/);
        await expect(page.locator('.drag-preview-layer')).toHaveCount(0);
        await page.mouse.up();
        // THE PANEL BOX: drawn, not grabbable.
        const kept = await lane.locator('.region-kept').boundingBox();
        expect(await lane.locator('.region-kept').evaluate(k =>
            getComputedStyle(k).cursor)).toBe('default');
        await page.mouse.move(kept.x + kept.width / 2, kept.y + kept.height / 2);
        await page.mouse.down();
        await page.mouse.move(kept.x + kept.width / 2 + 60, kept.y + kept.height / 2,
            { steps: 6 });
        await expect(page.locator('.drag-preview-layer')).toHaveCount(0);
        await page.mouse.up();
        // DOUBLE-CLICK a cell (lane and strip) and ←/→: nothing.
        const bb = await body.boundingBox();
        await page.mouse.dblclick(bb.x + bb.width * 0.6, bb.y + bb.height / 2);
        await page.mouse.dblclick(await stripX(page, id2, 7.5),
            kept.y + kept.height / 2);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(200);
        expect(calls, 'no map edit reached the bridge').toEqual([]);
        expect(await loopOf(page, id2, Q)).toBe('6,10');

        // The take goes (the arm cancelled): the gate lifts — the same
        // grip is live again.
        await page.evaluate(id => window.__celestrianTest.callNative(
            'stopRecordingInNode', id), id3);
        await expect(page.locator('#lanes')).not.toHaveClass(/map-locked/);
        await expect(grip).not.toHaveClass(/inert/);
        await expect.poll(() => page.evaluate(({ x, y }) =>
            !!document.elementFromPoint(x, y).closest('.trim-grip'), { x: gx, y: gy }))
            .toBe(true);
    });

    test('comp mode\'s "done" chip still closes the comp editor under the gate', async ({ page }) => {
        // Review 2026-09-23: the gate's .win-chip.toggle rule also caught
        // comp mode's "comp · done" chip — a VIEW toggle, not a map edit.
        const clipOf = id => page.evaluate(async id => {
            const s = await window.__celestrianTest.callNative('getGraphState');
            const find = ns => {
                for (const n of ns || []) {
                    if (n.id === id) return n;
                    const h = find(n.nodes);
                    if (h) return h;
                }
                return null;
            };
            return find(s.nodes);
        }, id);
        await page.goto('/?mock=true');
        await page.waitForFunction(() => !!window.__celestrianTest, null, { timeout: 5000 });
        await page.evaluate(() => window.__celestrianTest.loadScenario('stack-with-clips'));
        const Q = await quantum(page);
        await page.evaluate(async Q => {
            const t = window.__celestrianTest;
            await t.callNative('newTake', 'clip-1');
            t.advanceBy(2 * Q);
        }, Q);
        await expect.poll(async () => (await clipOf('clip-1')).takes).toBe(2);
        const lane = page.locator('.lane[data-id="clip-1"]');
        const body = lane.locator('.lane-body');
        await lane.locator('.take-btn').click();
        await lane.locator('.take-menu .take-comp-row').click();
        const done = body.locator('.comp-done-chip');
        await expect(done).toBeVisible();
        // Arm a new take elsewhere: pending → the gate is on.
        await page.evaluate(() => window.__celestrianTest.callNative('newTake', 'clip-2'));
        await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
        const b = await done.boundingBox();
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
        await expect(body.locator('.comp-cell.editing')).toHaveCount(0);
    });
});
