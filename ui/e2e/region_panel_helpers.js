/**
 * Shared fixtures for the loop-region specs (region_panel.spec.js,
 * region_panel_view.spec.js, release_chrome.spec.js,
 * heard_tiles.spec.js): the mock boot (with an emulated bridge round
 * trip), the owner's topology (a 1Q definer, then a long take),
 * engine-state readers, the map-edit call log, and the panel's
 * VIEW-AWARE geometry — since loop-region phase 1 (2026-09-23) the
 * detail strip draws raw Q through its own view {q0, spanQ} (the
 * strip's `_view` test hook), so strip x ↔ raw Q goes through it.
 *
 * Not a spec (no `.spec.` in the name): Playwright never runs it.
 */

import { expect } from '@playwright/test';

/**
 * Boot the mock page on `scenario`. `bridgeDelayMs` > 0 serves
 * backend.js with its `setSegments` answered that much later — the
 * mock applies commits synchronously, so without it the window between
 * a release and the engine's answer (where a poll still carries the
 * pre-commit state) is too short to observe.
 */
export async function boot(page, { bridgeDelayMs = 0, scenario = 'empty' } = {}) {
    if (bridgeDelayMs > 0) {
        await page.route('**/js/backend.js', async route => {
            const res = await route.fetch();
            const src = await res.text();
            const anchor = '({ callNative, log, getState } = mockBackend);';
            if (!src.includes(anchor)) throw new Error('backend.js anchor moved');
            const wrapped = anchor + `
        {
            const raw = callNative;
            callNative = async (method, ...args) => {
                if (method === 'setSegments') {
                    await new Promise(r => setTimeout(r, ${bridgeDelayMs}));
                }
                return raw(method, ...args);
            };
        }`;
            await route.fulfill({ response: res, body: src.replace(anchor, wrapped) });
        });
    }
    // `/?mock=true` — the static server's redirect drops the query on
    // `/index.html` (test_harness.md gotcha 10).
    await page.goto('/?mock=true');
    await page.waitForFunction(() => !!window.__celestrianTest, null,
        { timeout: 5000 });
    await page.evaluate(s => window.__celestrianTest.loadScenario(s), scenario);
}

/** The bridge calls the page made that change geometry or timing — the
 * mock logs every non-poll call; collect the map-edit and re-time ones
 * from the console. */
export function recordMapCalls(page) {
    const calls = [];
    page.on('console', msg => {
        const m = /\[MockBackend\] callNative: (setSegments|setLoopPoints|toggleLoopWindow|setTiming)/
            .exec(msg.text());
        if (m) calls.push(m[1]);
    });
    return calls;
}

export const quantum = page => page.evaluate(async () =>
    (await window.__celestrianTest.callNative('getGraphState')).perf.sampleRate);

export const node = (page, id) => page.evaluate(async id =>
    (await window.__celestrianTest.callNative('getGraphState'))
        .nodes.find(n => n.id === id), id);

export const loopOf = async (page, id, Q) => {
    const n = await node(page, id);
    return [n.loopStart / Q, n.loopEnd / Q].join(',');
};

export const segsOf = async (page, id, Q) =>
    ((await node(page, id)).segments || []).map(s => s / Q).join(',');

/** Record a `lenQ` take into clip `id` (a new clip when omitted),
 * once Q exists. The arm waits for the next Q boundary (the transport
 * may sit mid-Q after earlier takes): step until the take is live,
 * then stop just short of lenQ — the stop lands on the boundary. */
export async function recordTake(page, Q, lenQ, id = null) {
    const got = await page.evaluate(async ({ Q, lenQ, id }) => {
        const c = window.__celestrianTest.callNative;
        const adv = window.__celestrianTest.advanceBy;
        const nid = id || await c('createNode', 'clip', '');
        const live = async () => {
            const n = (await c('getGraphState')).nodes.find(x => x.id === nid);
            return !!(n && n.isRecording && !n.isPendingStart);
        };
        const step = Math.round(Q / 64);
        await c('startRecordingInNode', nid);
        for (let i = 0; i < 256 && !(await live()); i++) adv(step);
        adv(lenQ * Q - 2 * step);
        await c('stopRecordingInNode', nid);
        adv(4 * step);
        return nid;
    }, { Q, lenQ, id });
    await expect.poll(async () => (await node(page, got)).duration).toBe(lenQ * Q);
    return got;
}

/** A 1Q definer, then a `lenQ` take from 1Q (the owner's topology). */
export async function recordDefinerAndTake(page, Q, lenQ) {
    // The definer SETS Q: exactly Q samples, stopped at once.
    const id1 = await page.evaluate(async Q => {
        const c = window.__celestrianTest.callNative;
        const id = await c('createNode', 'clip', '');
        await c('startRecordingInNode', id);
        window.__celestrianTest.advanceBy(Q);
        await c('stopRecordingInNode', id);
        return id;
    }, Q);
    const id2 = await recordTake(page, Q, lenQ);
    return { id1, id2 };
}

export const setLoop = (page, id, a, b) => page.evaluate(
    ({ id, a, b }) => window.__celestrianTest.callNative('setLoopPoints', id, a, b),
    { id, a, b });

export const laneOf = (page, id) => page.locator(`.lane[data-id="${id}"]`);
export const panelOf = (page, id) => laneOf(page, id).locator('.lane-region');
export const stripOf = (page, id) => laneOf(page, id).locator('.region-strip');

/** The panel's live view {q0, spanQ} (null before its first show). */
export const viewOf = (page, id) => stripOf(page, id).evaluate(s => s._view);

/** Raw Q → page x on the detail strip, through the CURRENT view. */
export async function stripX(page, id, q) {
    const s = await stripOf(page, id).boundingBox();
    const v = await viewOf(page, id);
    return s.x + s.width * (q - v.q0) / v.spanQ;
}

/** Page x → raw Q on the detail strip, through `v` (or the current). */
export async function stripQ(page, id, x, v = null) {
    const s = await stripOf(page, id).boundingBox();
    const view = v || await viewOf(page, id);
    return view.q0 + (x - s.x) / s.width * view.spanQ;
}

/** Select a lane the real way (the rail NAME — the rail's centre is a
 * button) and wait for its panel. */
export async function selectLane(page, id) {
    await laneOf(page, id).locator('.rail-name').click();
    await expect(panelOf(page, id)).toBeVisible();
}

/** The kept box's box once the overlay has rebuilt at `a`..`b` raw Q
 * (after a commit the overlay is HELD until the bridge answers — poll
 * the element's geometry, never grab it straight after an engine poll). */
export async function keptBoxAt(page, id, a, b) {
    const lane = laneOf(page, id);
    await expect.poll(async () => {
        // (null for a tick while the overlay rebuilds — keep polling)
        const k = await lane.locator('.region-kept').boundingBox();
        if (!k) return false;
        const xa = await stripX(page, id, a);
        const xb = await stripX(page, id, b);
        return Math.abs(k.x - xa) < 2 && Math.abs(k.x + k.width - xb) < 2;
    }).toBe(true);
    return lane.locator('.region-kept').boundingBox();
}

/** Ctrl+wheel (the panel's zoom) at page (x, y): `notches` of −100
 * (in) or +100 (out). */
export async function ctrlWheel(page, x, y, notches) {
    await page.mouse.move(x, y);
    await page.keyboard.down('Control');
    for (let i = 0; i < Math.abs(notches); i++) {
        await page.mouse.wheel(0, notches < 0 ? -100 : 100);
    }
    await page.keyboard.up('Control');
}

/* ---------- the lane's loop handles (splice_handles.js) ---------- */

/** A lane's visible splice handles and ↺ (the take tile's and the
 * ghosts'): kind, ghostliness, lane position (Q, the line's centre). */
export const laneHandles = (page, id) => page.evaluate(id => {
    const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
    const br = body.getBoundingClientRect();
    return [...body.querySelectorAll('.lr-layer > .lr-splice, .lr-layer > .lr-top')]
        .filter(h => h.style.display !== 'none')
        .map(h => {
            const r = h.getBoundingClientRect();
            return {
                kind: h.classList.contains('lr-top') ? 'top'
                    : h.classList.contains('lr-cut') ? 'cut' : 'wrap',
                ghost: h.classList.contains('lr-ghost'),
                x: +(((r.left + r.width / 2) - br.left) / br.width * body._cycleQ).toFixed(2),
            };
        })
        .sort((a, b) => a.x - b.x);
}, id);

/** The take tile's handles as 'kind@x', sorted. */
export const laneMarks = async (page, id) => (await laneHandles(page, id))
    .filter(h => !h.ghost).map(h => h.kind + '@' + h.x).sort();

/** The page point of the take tile's handle TAB of `kind` ('wrap' |
 * 'cut' | 'top'). `end`: the right-edge twin of a splice that rests on
 * the frame's left edge (.lr-end) instead of the left one. */
export async function handleTab(page, id, kind, { end = false } = {}) {
    const cls = kind === 'top' ? '.lr-top' : kind === 'cut' ? '.lr-cut' : '.lr-wrap';
    const b = await laneOf(page, id).locator(
        `.lr-layer > ${cls}:not(.lr-ghost)${end ? '.lr-end' : ':not(.lr-end)'} .lr-tab`)
        .first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export const lanePxPerQ = (page, id) => laneOf(page, id).locator('.lane-body')
    .evaluate(b => b.getBoundingClientRect().width / b._cycleQ);

/** A REAL-mouse drag of `dxPx` from `at` (synthetic dispatch bypasses
 * hit-testing). `hold`: leave the button down; `mods`: keys held from
 * before the press ('Shift', 'Alt'). */
export async function dragBy(page, at, dxPx, { steps = 10, hold = false, mods = [] } = {}) {
    await page.mouse.move(at.x, at.y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down();
    await page.mouse.move(at.x + dxPx, at.y, { steps });
    if (hold) return;
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
}

/** THE CLIP-3 TOPOLOGY (frame.md §1, owner 2026-09-29): a 1Q loop (A);
 * a 12Q take from 1Q looped to [4, 8) — B, the first loop longer than
 * Q: it PLACES the frame, its ↺ (raw 4, sounding at 5Q) the left edge;
 * and a 16Q take from 14Q looped to [6, 10) — C, which SLOTS IN: its
 * region start sounds at 20Q, 3Q into the 4Q frame, and the sample at
 * the frame's top is raw 7. Nothing is selected by it. */
export async function slottedTopology(page) {
    await boot(page);
    const Q = await quantum(page);
    const { id1, id2 } = await recordDefinerAndTake(page, Q, 12);
    const id3 = await recordTake(page, Q, 16);
    await setLoop(page, id2, 4 * Q, 8 * Q);
    await setLoop(page, id3, 6 * Q, 10 * Q);
    expect((await node(page, id3)).origin / Q).toBe(14);
    return { Q, a: id1, b: id2, c: id3 };
}
