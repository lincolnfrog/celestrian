/**
 * Helpers for the ENGINE e2e specs (playwright.engine.config.js): the
 * real UI in Chromium against the real engine behind the headless
 * server. Everything here goes through the page's
 * window.__celestrianTest — `callNative` (the bridge) and `engine` (the
 * server's control surface: the synthetic clock, the input generator,
 * the audible-truth probe).
 */

import { expect } from '@playwright/test';

import { innerAt, singleSegment } from '../js/time_map.js';
import { deriveViewModel } from '../js/view_model.js';

const BLOCK = 512;
export const mod = (x, p) => ((x % p) + p) % p;

/* ---------- THE SPECTRAL LISTENER ----------
 * The server records the CHIRP input (every sample carries its capture
 * clock as a frequency) and `listen` decodes the island's OUTPUT frame
 * by frame: which clip, which take, which content index sounds at each
 * moment — the mix itself, level-blind, no soloing. The two checks
 * below are the whole point of the harness:
 *   verifyHeard  — what sounds == the render law (the JS twin of
 *                  timing::innerAt, golden-pinned against the engine)
 *                  AND == what the lanes DRAW at that moment.
 */

/** Listen to `samples` of output (default one island cycle). */
export function listen(page, { samples = 0, hop = 4096 } = {}) {
    return engine(page, 'listen', { samples, hop });
}

/** A clip's active single-segment map from its published state. */
export function mapOfNode(n) {
    const win = n.windowActive && (n.loopEnd || 0) > (n.loopStart || 0);
    if (n.segments && n.segments.length >= 4 && !n.loopBypassed) {
        const segs = [];
        for (let i = 0; i + 1 < n.segments.length; i += 2)
            segs.push([n.segments[i], n.segments[i + 1]]);
        return { segs };
    }
    return win ? singleSegment(n.loopStart, n.loopEnd) : singleSegment(0, n.duration);
}

/** What the lanes DRAW for clip `id` at lane-frame position `q` (Q):
 * the content index (Q) the tile grid puts there, and whether a tile
 * is there at all (one-shots rest between firings). */
export function displayInnerQ(vm, id, q, durationQ) {
    const lane = vm.lanes.find(l => l.id === id);
    if (!lane || !(lane.periodQ > 0)) return null;
    const tile = (lane.reps || []).find(r => q >= r.startQ && q < r.endQ);
    if (!tile) return { rest: true };
    // A HEARD lane (a window: srcSegs) tiles on the FRAME grid and bakes
    // the loop's phase in as content ROTATION (srcTopFrac, display law
    // 2026-07-23d): the tile shows slice[(q − tile.start + rot) mod P].
    // Single-segment maps only (the specs' scope).
    if (tile.srcSegs) {
        if (tile.srcSegs.length !== 1) return null;
        const rel = mod(q - tile.startQ + (tile.srcTopFrac || 0) * lane.periodQ, lane.periodQ);
        return { rest: false, innerQ: tile.srcSegs[0][0] * durationQ + rel };
    }
    // A plain lane tiles on the TAKE grid (takeStartQ mod periodQ; a
    // wrapped first tile is clamped, so the grid — not the tile — is
    // the reference) and draws the take from its top.
    return { rest: false, innerQ: mod(q - (lane.takeStartQ || 0), lane.periodQ) };
}

/**
 * The see-vs-hear check over one listen: for every frame and every
 * committed clip, what the engine SOUNDS must match the render law and
 * the display. `silent(id, phaseQ)` may answer true (expect silence),
 * false, or 'skip' (near a gate seam); `foldOf(id)` gives a one-shot's
 * context cycle in samples. Frames whose centre sits within half a
 * frame of a loop seam are skipped for that clip (two capture moments
 * share the window). Returns the listen result for further asserts.
 */
export async function verifyHeard(page, {
    silent = () => false, foldOf = () => 0, tolQ = 0.03, opts = {}, only = null,
} = {}) {
    const st = await state(page);
    const L = await listen(page);
    const Q = L.quantum;
    const vm = deriveViewModel(st, { fxOpen: new Set(), windowEdit: new Set(), ...opts });
    const clips = [];
    (function walk(n) {
        for (const c of n.nodes || []) {
            if (c.type === 'clip' && c.duration > 0 && (!only || only.includes(c.id))) clips.push(c);
            walk(c);
        }
    })(st);
    expect(clips.length, 'committed clips').toBeGreaterThan(0);
    const half = L.frame / 2;
    let checked = 0;
    for (const f of L.frames) {
        const t = L.epoch + f.pos;          // absolute clock of the frame centre
        const phaseQ = f.phase / Q;
        for (const c of clips) {
            const gate = silent(c.id, phaseQ);
            if (gate === 'skip') continue;
            const heard = f.heard.filter(h => h.id === c.id);
            const law = innerAt(t, c.origin, mapOfNode(c), foldOf(c.id));
            const label = `${c.name || ''}[${c.id.slice(0, 6)} ${c.duration / Q}Q] @ ${phaseQ.toFixed(2)}Q (frame pos ${f.pos})`;
            if (gate === true || law.rest) {
                expect(heard, `${label}: expected silence`).toEqual([]);
                continue;
            }
            // Near a seam the window holds two capture moments: skip.
            if (law.run < half || law.inner < half) continue;
            expect(heard.length, `${label}: expected the clip to sound (law content[${(law.inner / Q).toFixed(3)}Q]); frame heard ${JSON.stringify(f.heard.map(h => [h.id.slice(0, 6), +(h.inner / Q).toFixed(3), +h.level.toFixed(2)]))} unknown ${JSON.stringify(f.unknown.map(u => +(u / Q).toFixed(3)))}`).toBeGreaterThan(0);
            const nearest = heard.reduce((a, b) =>
                Math.abs(b.inner - law.inner) < Math.abs(a.inner - law.inner) ? b : a);
            expect(Math.abs(nearest.inner - law.inner) / Q,
                `${label}: heard content[${(nearest.inner / Q).toFixed(3)}Q], law says content[${(law.inner / Q).toFixed(3)}Q]`)
                .toBeLessThan(tolQ);
            // …and the lane draws that very content there.
            const d = displayInnerQ(vm, c.id, phaseQ, c.duration / Q);
            if (d && !d.rest) {
                const diff = Math.abs(mod(d.innerQ - nearest.inner / Q + c.duration / Q / 2, c.duration / Q) - c.duration / Q / 2);
                expect(diff, `${label}: lane draws content[${d.innerQ.toFixed(3)}Q], engine sounds content[${(nearest.inner / Q).toFixed(3)}Q]`)
                    .toBeLessThan(tolQ);
            }
            checked++;
        }
    }
    expect(checked, 'frames checked').toBeGreaterThan(0);
    return L;
}

/** The capture-clock offset (input clock − origin) of every take: with
 * an uninterrupted transport it is ONE number for the whole island, so
 * a take whose origin was folded or moved would stand out. */
export function captureOffsets(L, st) {
    const out = {};
    for (const [id, takes] of Object.entries(L.clips)) {
        const n = findNode(st, id);
        for (const t of takes) out[`${id}/${t.take}`] = t.captureClock - (n ? n.origin : 0);
    }
    return out;
}

/** Open the real UI in engine mode and start from an empty project. */
export async function openEngine(page) {
    await page.goto('/index.html?engine=true');
    await page.waitForFunction(() => !!window.__celestrianTest?.engine,
        null, { timeout: 15000 });
    await engine(page, 'reset');
    await expect(page.locator('.lane[data-kind="clip"]')).toHaveCount(0);
}

export function engine(page, op, params = {}) {
    return page.evaluate(([op, params]) =>
        window.__celestrianTest.engine(op, params), [op, params]);
}

export function call(page, name, ...args) {
    return page.evaluate(([name, args]) =>
        window.__celestrianTest.callNative(name, ...args), [name, args]);
}

export const state = page => call(page, 'getGraphState');

export function findNode(st, id) {
    for (const n of st.nodes || []) {
        if (n.id === id) return n;
        const hit = findNode({ nodes: n.nodes }, id);
        if (hit) return hit;
    }
    return null;
}

const hot = n => !!(n && (n.isRecording || n.isPendingStart || n.isAwaitingStop));

/** Advance the paused clock until `pred(state)` holds (≤ `maxSamples`). */
export async function advanceUntil(page, pred, maxSamples = 30 * 44100) {
    let done = 0;
    for (;;) {
        const st = await state(page);
        if (pred(st)) return st;
        if (done >= maxSamples) throw new Error('advanceUntil: condition never held');
        await engine(page, 'advance', { samples: BLOCK });
        done += BLOCK;
    }
}

/**
 * Record a take of `len` samples into a fresh top-level clip through the
 * bridge, the engine's clock paused and advanced by exact counts (the
 * scenario harness's recipe, tests/scenario_utils.h): arm, wait for the
 * capture, drive `len − live` (a block short for a padded take so the
 * stop lands ON the boundary), stop, settle. `atPhase` first drives the
 * island to just before that phase of the current cycle, so the arm
 * targets it exactly. Returns the clip id.
 */
export async function rec(page, len, { atPhase = null } = {}) {
    const before = await state(page);
    const first = !(before.quantum > 0);
    if (atPhase !== null) {
        const s = await engine(page, 'status');
        // islandPos is published EPOCH-RELATIVE (unwrapped): the phase
        // is its fold on the cycle.
        const ph = mod(s.islandPos, s.cycle);
        const need = mod(atPhase - 100 - ph, s.cycle);
        if (need > 0) await engine(page, 'advance', { samples: need });
    }
    await call(page, 'createNode', 'clip', '');
    const st = await state(page);
    const id = st.nodes[st.nodes.length - 1].id;
    await call(page, 'startRecordingInNode', id);
    const rs = await advanceUntil(page, s => {
        const n = findNode(s, id);
        return n && n.isRecording;
    });
    const live = findNode(rs, id).duration;
    const more = len - live - (first ? 0 : BLOCK);
    if (more > 0) await engine(page, 'advance', { samples: more });
    await call(page, 'stopRecordingInNode', id);
    await advanceUntil(page, s => !hot(findNode(s, id)));
    return id;
}

/**
 * Which Q cells of the frame are DIMMED on a lane, read from the DOM
 * the way a performer reads it: a `.seq-dim` covering the cell's centre.
 */
export async function dimmedCells(page, laneId, cells) {
    const lane = page.locator(`.lane[data-id="${laneId}"]`);
    const body = lane.locator('.lane-body');
    const box = await body.boundingBox();
    const dims = await lane.locator('.seq-dim').evaluateAll(els =>
        els.map(e => { const r = e.getBoundingClientRect(); return [r.left, r.right]; }));
    const out = [];
    for (let i = 0; i < cells; i++) {
        const cx = box.x + ((i + 0.5) / cells) * box.width;
        out.push(dims.some(([l, r]) => cx >= l && cx < r));
    }
    return out;
}
