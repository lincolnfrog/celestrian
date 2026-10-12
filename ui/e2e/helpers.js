/**
 * Shared fixtures for the mock-page e2e specs: the boot, the bridge and
 * its state, the pointer primitives, the per-frame sampler, the waits,
 * the pixel probes and the recording recipes.
 *
 * REAL INPUT IS THE LAW: every interactive element is driven with
 * `page.mouse` / `page.keyboard` — a synthetic dispatch bypasses
 * hit-testing, pointer capture and focus, so it proves nothing about
 * what a hand can reach. The bridge (`call`) is for SETUP and for
 * reading state, never for the gesture under test.
 *
 * Not a spec (no `.spec.` in the name): Playwright never runs it.
 */

import { expect } from '@playwright/test';

/* ---------- boot ---------- */

/* `E2E_MOCK_RATE=48000 npx playwright test` sweeps the mock's sample
 * rate (docs/test_harness.md). Seeded by an init script, not `?rate=`:
 * the static server's redirect drops the query. */
const SWEEP_RATE = Number(process.env.E2E_MOCK_RATE) || 0;

/** Answer the page's `setSegments` `ms` later. The mock applies a commit
 * synchronously, so without this the span between a release and the
 * engine's answer — where a poll still carries the pre-commit state —
 * is too short to observe. */
async function delaySetSegments(page, ms) {
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
                    await new Promise(r => setTimeout(r, ${ms}));
                }
                return raw(method, ...args);
            };
        }`;
        await route.fulfill({ response: res, body: src.replace(anchor, wrapped) });
    });
}

/**
 * Boot the mock page on `scenario` (js/mock/scenarios.js), at the sweep
 * rate when one is set. `lanes`: wait until that many lane rows are
 * painted. `bridgeDelayMs`: see delaySetSegments.
 *
 * THE CLOCK IS STEPPED (js/mock/state.js `transport.stepped`): an arm
 * starts the transport, as the engine's does, but not the mock's poll
 * tick — a spec moves time with `advanceBy`, or in real time once it
 * plays (Space, `togglePlayback`, `startTransport`). `mock(page,
 * 'stepClock', false)` hands the clock back to the polls.
 */
export async function boot(page, { scenario = 'empty', lanes = 0, bridgeDelayMs = 0 } = {}) {
    await page.addInitScript(() => { window.__celestrianMockClock = 'stepped'; });
    if (SWEEP_RATE > 0) {
        await page.addInitScript(r => { window.__celestrianMockRate = r; }, SWEEP_RATE);
    }
    if (bridgeDelayMs > 0) await delaySetSegments(page, bridgeDelayMs);
    // `/?mock=true`, never `/index.html?mock=true` (the redirect again).
    // backend.js attaches the test surface during async module init:
    // wait for it with `?.` (a plain property access throws).
    await page.goto('/?mock=true');
    await page.waitForFunction(
        () => typeof window.__celestrianTest?.loadScenario === 'function',
        null, { timeout: 5000 });
    await page.evaluate(s => window.__celestrianTest.loadScenario(s), scenario);
    if (lanes > 0) await expect(page.locator('.lane[data-id]')).toHaveCount(lanes);
}

/* ---------- the bridge and its state ---------- */

/** The mock's own controls (backend.js): `startTransport`,
 * `pauseTransport`, `advanceBy`, `setIsPlaying`, `setMasterPos`, … —
 * on the mock page's test surface, or the harness page's. */
export const mock = (page, fn, ...args) => page.evaluate(
    ({ fn, args }) => (window.__celestrianTest || window.celestrian)[fn](...args),
    { fn, args });

/** One bridge call, as the app makes them. */
export const call = (page, verb, ...args) => mock(page, 'callNative', verb, ...args);

/** The published graph: the root's own facts and its `nodes`. */
export const graph = page => call(page, 'getGraphState');

/** The root's own facts (transport, quantum, undo state, its sequence). */
export async function root(page) {
    const { nodes, ...own } = await graph(page);
    return own;
}

/** The node `id` in a published tree, at any depth (null when absent). */
export function findNode(nodes, id) {
    for (const n of nodes || []) {
        if (n.id === id) return n;
        const hit = findNode(n.nodes, id);
        if (hit) return hit;
    }
    return null;
}

export const node = async (page, id) => findNode((await graph(page)).nodes, id);

/** A node's sequence — the root's with no `id` (null when it has none). */
export async function seqOf(page, id = null) {
    const owner = id === null ? await graph(page) : await node(page, id);
    return (owner && owner.sequence) || null;
}

/** The mock's sample rate. */
export const sampleRate = async page => (await graph(page)).perf.sampleRate;

/** Q in samples for the topologies recorded here: their definer is one
 * second long, so Q is the sample rate. */
export const quantum = sampleRate;

/** A node's loop region as 'startQ,endQ'. */
export const loopOf = async (page, id, Q) => {
    const n = await node(page, id);
    return [n.loopStart / Q, n.loopEnd / Q].join(',');
};

/** A node's multi-segment map as 's0,e0,s1,e1' in Q ('' with none). */
export const segsOf = async (page, id, Q) =>
    ((await node(page, id)).segments || []).map(s => s / Q).join(',');

export const setLoop = (page, id, a, b) => call(page, 'setLoopPoints', id, a, b);

/** The map-edit and re-time calls the page makes from here on (the mock
 * logs every non-poll call to the console). Read it after
 * `consoleDrained`. */
export function recordMapCalls(page) {
    const calls = [];
    page.on('console', msg => {
        const m = /\[MockBackend\] callNative: (setSegments|setLoopPoints|toggleLoopWindow|setTiming|cancelGesture)/
            .exec(msg.text());
        if (m) calls.push(m[1]);
    });
    return calls;
}

let drains = 0;

/** Resolve once the page's console has delivered everything logged
 * before now (console lines arrive in order): the fence for "no call
 * reached the bridge". */
export async function consoleDrained(page) {
    const mark = `[e2e drained ${++drains}]`;
    const seen = page.waitForEvent('console', msg => msg.text() === mark);
    await page.evaluate(m => console.log(m), mark);
    await seen;
}

/* ---------- lanes and the region panel ---------- */

export const laneOf = (page, id) => page.locator(`.lane[data-id="${id}"]`);

/** A track's region panel: in the edit bar at the foot of the session
 * view (#region-dock), not in its lane's row. */
export const panelOf = (page, id) =>
    page.locator(`#region-dock .lane-region[data-lane-id="${id}"]`);
export const stripOf = (page, id) => panelOf(page, id).locator('.region-strip');

/** The panel's live view {q0, spanQ} (null before its first show): the
 * detail strip draws raw Q through it. */
export const viewOf = (page, id) => stripOf(page, id).evaluate(s => s._view);

/** Raw Q → page x on the detail strip, through the current view. */
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

/** The strip's px per raw Q in the current view. */
export async function stripPxPerQ(page, id) {
    const s = await stripOf(page, id).boundingBox();
    return s.width / (await viewOf(page, id)).spanQ;
}

/** Select a lane the real way (the rail NAME — the rail's centre is a
 * button) and wait for its panel. */
export async function selectLane(page, id) {
    await laneOf(page, id).locator('.rail-name').click();
    await expect(panelOf(page, id)).toBeVisible();
}

/** The kept box's box once the overlay has rebuilt at `a`..`b` raw Q.
 * After a commit the overlay is held until the bridge answers: poll the
 * element's geometry, never grab it straight after an engine poll. */
export async function keptBoxAt(page, id, a, b) {
    const kept = panelOf(page, id).locator('.region-kept');
    await expect.poll(async () => {
        const k = await kept.boundingBox();
        if (!k) return false;  // a tick while the overlay rebuilds
        const xa = await stripX(page, id, a);
        const xb = await stripX(page, id, b);
        return Math.abs(k.x - xa) < 2 && Math.abs(k.x + k.width - xb) < 2;
    }).toBe(true);
    return kept.boundingBox();
}

/** The raw Q the panel's ↺ mark sits on (null while it is not drawn —
 * poll it). */
export async function panelTopQ(page, id) {
    const b = await panelOf(page, id).locator('.region-top').boundingBox();
    return b ? +(await stripQ(page, id, b.x + b.width / 2)).toFixed(2) : null;
}

/* ---------- the lane's loop handles (splice_handles.js) ---------- */

/** A lane's visible splice handles and ↺, left to right: `kind` ('wrap'
 * | 'cut' | 'top'), `ghost` (a repeat's, not the take tile's), `inert`,
 * lane position in Q at the line's centre (`x` to 0.01, `exact`
 * unrounded), the tab's computed opacity and its text. */
export const laneHandles = (page, id) => page.evaluate(id => {
    const body = document.querySelector(`.lane[data-id="${id}"] .lane-body`);
    const br = body.getBoundingClientRect();
    return [...body.querySelectorAll('.lr-layer > .lr-splice, .lr-layer > .lr-top')]
        .filter(h => h.style.display !== 'none')
        .map(h => {
            const r = h.getBoundingClientRect();
            const tab = h.querySelector('.lr-tab');
            const exact = ((r.left + r.width / 2) - br.left) / br.width * body._cycleQ;
            return {
                kind: h.classList.contains('lr-top') ? 'top'
                    : h.classList.contains('lr-cut') ? 'cut' : 'wrap',
                ghost: h.classList.contains('lr-ghost'),
                inert: h.classList.contains('lr-inert'),
                x: +exact.toFixed(2),
                exact,
                tabOp: tab ? parseFloat(getComputedStyle(tab).opacity) : 0,
                text: tab ? tab.textContent : '',
            };
        })
        .sort((a, b) => a.exact - b.exact);
}, id);

/** The take tile's handles as 'kind@x', sorted. */
export const laneMarks = async (page, id) => (await laneHandles(page, id))
    .filter(h => !h.ghost).map(h => h.kind + '@' + h.x).sort();

/** The page point of a handle's TAB of `kind` — the take tile's, or a
 * `ghost` repeat's. `end`: the right-edge twin of a splice that rests
 * on the frame's left edge (.lr-end). */
export async function handleTab(page, id, kind, { end = false, ghost = false } = {}) {
    const cls = kind === 'top' ? '.lr-top' : kind === 'cut' ? '.lr-cut' : '.lr-wrap';
    return centreOf(laneOf(page, id).locator(
        `.lr-layer > ${cls}${ghost ? '.lr-ghost' : ':not(.lr-ghost)'}` +
        `${end ? '.lr-end' : ':not(.lr-end)'} .lr-tab`).first());
}

/** The lane's px per Q (its frame, as last patched). */
export const lanePxPerQ = (page, id) => laneOf(page, id).locator('.lane-body')
    .evaluate(b => b.getBoundingClientRect().width / b._cycleQ);

/** The frame a lane is drawn in, in Q. */
export const laneFrameQ = (page, id) => laneOf(page, id).locator('.lane-body')
    .evaluate(b => b._cycleQ);

/* ---------- the pointer ---------- */

export const centre = b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
export const centreOf = async locator => centre(await locator.boundingBox());

/** Drag `dxPx` (and `dy`) from the point `at`. `mods`: keys held from
 * before the press ('Shift', 'Alt'). `hold`: leave the button — and the
 * keys — down; `release` ends it. */
export async function dragBy(page, at, dxPx, { dy = 0, steps = 10, hold = false, mods = [] } = {}) {
    await page.mouse.move(at.x, at.y);
    for (const m of mods) await page.keyboard.down(m);
    await page.mouse.down();
    await page.mouse.move(at.x + dxPx, at.y + dy, { steps });
    if (!hold) await release(page, mods);
}

/** Drag from the point `at` to page x `toX` (dragBy's options). */
export const dragTo = (page, at, toX, options) => dragBy(page, at, toX - at.x, options);

/** Release the button, then the keys a held drag kept down. */
export async function release(page, mods = []) {
    await page.mouse.up();
    for (const m of mods) await page.keyboard.up(m);
}

/** Keep a HELD pointer moving about `at` (a px to and fro) until `read()`
 * gives `want`. A drag's live commits are throttled and ride a pointer
 * move: a still hand never sends the one it rests on. */
export async function jiggleUntil(page, at, read, want) {
    let k = 0;
    await expect.poll(async () => {
        k = 1 - k;
        await page.mouse.move(at.x + k, at.y);
        return read();
    }).toBe(want);
}

/** Drag a lane handle's tab by `dQ` of the lane's own scale. Returns the
 * grab point. */
export async function gripDrag(page, id, kind, dQ, { end = false, ghost = false, ...drag } = {}) {
    const at = await handleTab(page, id, kind, { end, ghost });
    await dragBy(page, at, dQ * await lanePxPerQ(page, id), drag);
    return at;
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

export const undo = page => page.keyboard.press('ControlOrMeta+z');
export const redo = page => page.keyboard.press('ControlOrMeta+Shift+z');

/* ---------- per-frame sampling ---------- */

/**
 * Sample the page one row per animation frame, for `ms` or for `frames`
 * of them: `probe(arg)` runs IN THE PAGE (it closes over nothing here)
 * and its fields join `t`, the frame's `performance.now()`. Start it,
 * act, then await it — or await it at once to watch a still hand: what
 * the app paces by the frame (a pan, a tween) shows in every row.
 */
export function sampleFrames(page, probe, arg, { ms = 0, frames = 0 }) {
    return page.evaluate(({ src, arg, ms, frames }) => new Promise(done => {
        // eslint-disable-next-line no-new-func
        const probe = new Function('arg', 'return (' + src + ')(arg);');
        const rows = [];
        const t0 = performance.now();
        const tick = () => {
            rows.push(Object.assign({ t: performance.now() }, probe(arg)));
            const more = frames > 0 ? rows.length < frames
                                    : performance.now() - t0 < ms;
            if (more) requestAnimationFrame(tick);
            else done(rows);
        };
        requestAnimationFrame(tick);
    }), { src: probe.toString(), arg, ms, frames });
}

/**
 * The open-ended sampler, for a window an observable ends: rows collect
 * from now until `stop()`, which resolves to them. `mark(name)` stamps
 * every later row `{ [name]: true }` (a release, a press); `rows()`
 * reads what there is so far.
 */
export async function watchFrames(page, probe, arg = null) {
    const key = await page.evaluate(({ src, arg }) => {
        // eslint-disable-next-line no-new-func
        const probe = new Function('arg', 'return (' + src + ')(arg);');
        const all = window.__frameWatch || (window.__frameWatch = []);
        const w = { rows: [], marks: {}, run: true };
        const tick = () => {
            if (!w.run) return;
            w.rows.push(Object.assign({ t: performance.now() }, w.marks, probe(arg)));
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return all.push(w) - 1;
    }, { src: probe.toString(), arg });
    return {
        mark: name => page.evaluate(({ key, name }) => {
            window.__frameWatch[key].marks[name] = true;
        }, { key, name }),
        rows: () => page.evaluate(key => window.__frameWatch[key].rows, key),
        stop: () => page.evaluate(key => {
            const w = window.__frameWatch[key];
            w.run = false;
            return w.rows;
        }, key),
    };
}

/* ---------- waits ---------- */

/* How long the picture must hold still to count as at rest: two of the
 * app's graph polls (app.js POLL_MS) and a frame to spare — over at
 * least REST_FRAMES animation frames, so one long hitch of the page (in
 * which no poll ran either) is not mistaken for rest. */
const REST_MS = 130;
const REST_FRAMES = 4;

/**
 * Resolve once the session view is AT REST: no gesture live, no preview
 * awaiting the engine's answer, no frame pin (a drag's, a nudge
 * chain's), no re-seat tween, no held preview — and the lanes, the
 * ruler and the panel drawn the same for two polls. From here lane
 * geometry is where a press will find it, and "nothing moved" is a
 * fact, not a guess at a delay.
 */
export async function settled(page, { timeout = 6000 } = {}) {
    const rested = await page.evaluate(async ({ REST_MS, REST_FRAMES, timeout }) => {
        const [gesture, pending, pin] = await Promise.all([
            import('/js/session_view/gesture.js'),
            import('/js/session_view/pending_edits.js'),
            import('/js/session_view/drag_pin.js')]);
        const lanes = document.getElementById('lanes');
        const quiet = () => !gesture.isGestureLive() && !pending.hasPendingEdits() &&
            pin.mapDragPinQ() === null &&
            !lanes.classList.contains('frame-tweening') &&
            !document.querySelector('.drag-held, .drag-preview-layer');
        const drawn = '.lane-body .rep, .lr-layer > *, .overlay-layer > *, ' +
            '.region-overlay > *, #ruler .tick';
        const picture = () => [...document.querySelectorAll(drawn)]
            .filter(el => !/cursor/.test(el.className))
            .map(el => el.className + '{' + el.style.cssText + '}').join('');
        return new Promise(done => {
            const t0 = performance.now();
            let since = t0;
            let frames = 0;
            let last = null;
            const tick = () => {
                const now = performance.now();
                const pic = quiet() ? picture() : null;
                if (pic === null || pic !== last) { since = now; frames = 0; }
                else frames++;
                last = pic;
                if (pic !== null && now - since >= REST_MS && frames >= REST_FRAMES) {
                    return done(true);
                }
                if (now - t0 > timeout) return done(false);
                requestAnimationFrame(tick);
            };
            tick();
        });
    }, { REST_MS, REST_FRAMES, timeout });
    expect(rested, 'the session view came to rest').toBe(true);
}

/** Resolve once the project's birth has been announced. The first
 * committed take births the project and the shell says so on the
 * STATUS LINE at its next identity poll (project_menu.js, every 2 s) —
 * whenever that falls. A case that reads the status line waits for the
 * announcement first; the project button is renamed in the same step. */
export const projectAnnounced = page =>
    expect(page.locator('#project-menu-btn')).not.toHaveText('Project ▾', { timeout: 5000 });

/** Is a pointer gesture live (session_view/gesture.js)? A press on an
 * inert handle starts none. */
export const gestureLive = page => page.evaluate(async () =>
    (await import('/js/session_view/gesture.js')).isGestureLive());

/**
 * Resolve once every edit verdict queued before now has spoken. A
 * commit's verdict is read `VERDICT_DEBOUNCE_MS` after it by a timer
 * the app publishes nowhere, so this waits on the page's own timer
 * queue — an earlier timer of the same delay runs first — and one
 * bridge round trip for the verdict's state read.
 */
export const pastVerdict = page => page.evaluate(async () => {
    const { VERDICT_DEBOUNCE_MS } = await import('/js/edit_verdict.js');
    await new Promise(r => setTimeout(r, VERDICT_DEBOUNCE_MS));
    await (window.__celestrianTest || window.celestrian).callNative('getGraphState');
    await new Promise(r => setTimeout(r, 0));
});

/* ---------- pixel probes ---------- */

/** The take tile's envelope: per backing column of its canvas, the
 * filled height above the centre line (null before it has drawn). */
export const tileProfile = (page, id) => page.evaluate(id => {
    const rep = document.querySelector(
        `.lane[data-id="${id}"] .reps-layer .rep:not(.ghost)`);
    const cv = rep && rep.querySelector('canvas');
    if (!cv || !cv.width) return null;
    const { width: W, height: H } = cv;
    const px = cv.getContext('2d').getImageData(0, 0, W, H).data;
    const mid = Math.floor(H / 2);
    const out = [];
    for (let x = 0; x < W; x++) {
        let y = 0;
        while (y < mid && px[(y * W + x) * 4 + 3] < 128) y++;
        out.push(mid - y);
    }
    return out;
}, id);

/** The columns (as fractions of the tile) whose envelope differs. */
export function changedCols(a, b, tolPx = 1) {
    const out = [];
    for (let x = 0; x < a.length; x++) {
        if (Math.abs(a[x] - b[x]) > tolPx) out.push(x / a.length);
    }
    return out;
}

/** The take tile's envelope once it has stopped changing (two equal
 * reads): a first draw swaps canvases as the peaks arrive. */
export async function tileAtRest(page, id) {
    let last = null;
    let now = null;
    await expect.poll(async () => {
        last = now;
        now = await tileProfile(page, id);
        return !!now && !!last && now.length === last.length &&
            changedCols(last, now, 0).length === 0;
    }).toBe(true);
    return now;
}

/* ---------- recording recipes ---------- */

/* THE RECIPES DRIVE THE MOCK'S CLOCK BY HAND. An arm starts the
 * transport, as the engine's does; a running transport ticks on every
 * state read, so each recipe pauses the tick in the step that arms —
 * whatever the clock switch (boot) says — and from there only
 * `advanceBy` moves time. They leave the transport stopped and the
 * clock still. */

/** Record a `lenQ` take into clip `id` (a new clip when omitted), once
 * Q exists. The arm waits for the next Q boundary (the clock may sit
 * mid-Q after earlier takes): step until the take is live, run it to
 * just short of lenQ, stop — the stop lands on the boundary. */
export async function recordTake(page, Q, lenQ, id = null) {
    const got = await page.evaluate(async ({ Q, lenQ, id }) => {
        const t = window.__celestrianTest;
        const c = t.callNative;
        const nid = id || await c('createNode', 'clip', '');
        const read = async () => (await c('getGraphState')).nodes.find(x => x.id === nid);
        const step = Math.round(Q / 64);
        await c('startRecordingInNode', nid);
        t.pauseTransport();
        let n = await read();
        for (let i = 0; i < 256 && !(n && n.isRecording && !n.isPendingStart); i++) {
            t.advanceBy(step);
            n = await read();
        }
        // (A live take publishes its captured length so far.)
        t.advanceBy(lenQ * Q - 2 * step - Math.min(n.duration || 0, step));
        await c('stopRecordingInNode', nid);
        t.advanceBy(4 * step);
        t.setIsPlaying(false);
        return nid;
    }, { Q, lenQ, id });
    await expect.poll(async () => (await node(page, got)).duration).toBe(lenQ * Q);
    return got;
}

/** The first take of an empty session: it SETS Q — exactly `samples`.
 * Its stop is a request the next audio callback takes up, at the length
 * the take has then: the recipe runs that callback over no samples, so
 * the take is committed, and Q set, when it returns. Returns the clip. */
export const recordDefiner = (page, samples) => page.evaluate(async samples => {
    const t = window.__celestrianTest;
    const id = await t.callNative('createNode', 'clip', '');
    await t.callNative('startRecordingInNode', id);
    t.pauseTransport();
    t.advanceBy(samples);
    await t.callNative('stopRecordingInNode', id);
    t.advanceBy(0);
    t.setIsPlaying(false);
    return id;
}, samples);

/** A 1Q definer, then a `lenQ` take from 1Q. */
export async function recordDefinerAndTake(page, Q, lenQ) {
    const id1 = await recordDefiner(page, Q);
    const id2 = await recordTake(page, Q, lenQ);
    return { id1, id2 };
}

/**
 * THE OWNER'S TOPOLOGY, booted: a 1Q definer (`id1`), then a `lenQ`
 * take from 1Q (`id2`) — looped to `loop` ([a, b] in Q; null leaves the
 * whole take looping), or cut to the map `segs` (flat Q) — and, unless
 * `select` is false, selected with its panel showing. Other options go
 * to `boot`.
 */
export async function loopedTake(page, { lenQ = 12, loop = [6, 10], segs = null,
                                         select = true, ...bootOptions } = {}) {
    await boot(page, bootOptions);
    const Q = await quantum(page);
    const { id1, id2 } = await recordDefinerAndTake(page, Q, lenQ);
    if (segs) {
        await call(page, 'setSegments', id2, segs.map(q => q * Q));
        await expect.poll(() => segsOf(page, id2, Q)).toBe(segs.join(','));
    } else if (loop) {
        await setLoop(page, id2, loop[0] * Q, loop[1] * Q);
    }
    if (select) await selectLane(page, id2);
    return { Q, id1, id2 };
}

/** THE CLIP-3 TOPOLOGY (docs/frame.md §1), booted: a 1Q loop (`a`); a
 * 12Q take from 1Q looped to [4, 8) — `b`, the first loop longer than
 * Q: it PLACES the frame, its ↺ (raw 4, sounding at 5Q) the left edge;
 * and a 16Q take from 14Q looped to [6, 10) — `c`, which SLOTS IN: its
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

/** ARM a new track and hold the clock: its take stays pending, so the
 * recording gate holds every loop edit (#lanes.map-locked). Returns the
 * armed clip; `stopRecordingInNode` on it lifts the gate. */
export async function armPending(page) {
    const id = await page.evaluate(async () => {
        const t = window.__celestrianTest;
        const id = await t.callNative('createNode', 'clip', '');
        await t.callNative('startRecordingInNode', id);
        t.pauseTransport();
        return id;
    });
    await expect(page.locator('#lanes')).toHaveClass(/map-locked/);
    return id;
}
