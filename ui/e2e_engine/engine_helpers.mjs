/**
 * Helpers for the ENGINE e2e specs (playwright.engine.config.js): the
 * real UI in Chromium against the real engine behind the headless
 * server. Everything here goes through the page's
 * window.__celestrianTest — `callNative` (the bridge) and `engine` (the
 * server's control surface: the synthetic clock, the input generator,
 * the audible-truth probe).
 */

import { expect } from '@playwright/test';

const BLOCK = 512;
export const mod = (x, p) => ((x % p) + p) % p;

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
