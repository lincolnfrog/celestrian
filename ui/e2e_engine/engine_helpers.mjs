/**
 * Helpers for the ENGINE e2e specs (playwright.engine.config.js): the
 * real UI in Chromium against the real engine behind the headless
 * server. Everything here goes through the page's
 * window.__celestrianTest — `callNative` (the bridge) and `engine` (the
 * server's control surface: the synthetic clock, the input generator,
 * the audible-truth probe).
 */

import { expect } from '@playwright/test';

import { innerAt, singleSegment, mapPeriod, mapOffset } from '../js/time_map.js';
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

/** A node's ACTIVE map from its published state (null = none): a
 * multi-segment override, else a window, for clips and stacks alike. */
export function activeMapOf(n) {
    if (n.loopBypassed) return null;
    if (n.segments && n.segments.length >= 4) {
        const segs = [];
        for (let i = 0; i + 1 < n.segments.length; i += 2)
            segs.push([n.segments[i], n.segments[i + 1]]);
        return { segs };
    }
    if (n.windowActive && (n.loopEnd || 0) > (n.loopStart || 0))
        return singleSegment(n.loopStart, n.loopEnd);
    return null;
}

/** Whether heard offset `h` lies within `half` of a map seam (the
 * boundaries between segments, and the period top). */
export function nearSeam(map, h, half) {
    const P = mapPeriod(map);
    let acc = 0;
    const seams = [0, P];
    for (const [s, e] of map.segs) { acc += e - s; seams.push(acc); }
    return seams.some(x => Math.abs(h - x) < half || Math.abs(h - x + P) < half || Math.abs(h - x - P) < half);
}

/** A clip's map for the render law: its active map, else its whole take. */
export function mapOfNode(n) {
    return activeMapOf(n) || singleSegment(0, n.duration);
}

/** The path of stacks (root excluded) above `id`, top-down; [] at top level. */
export function ancestorsOf(st, id) {
    const walk = (node, chain) => {
        for (const c of node.nodes || []) {
            if (c.id === id) return chain;
            if (c.nodes) {
                const hit = walk(c, [...chain, c]);
                if (hit) return hit;
            }
        }
        return null;
    };
    return walk(st, []) || [];
}

/** A stack's intrinsic period: the lcm of its looping members' parts
 * (a window is a part length), 0 when empty. */
export function stackPeriod(stack) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const lcm = (a, b) => (a && b ? a / gcd(a, b) * b : a || b);
    let p = 0;
    for (const c of stack.nodes || []) {
        if (c.periodSource === 'context') continue;
        const m = activeMapOf(c);
        let part;
        if (c.type === 'clip') part = m ? mapPeriod(m) : c.duration;
        else part = m ? mapPeriod(m) : stackPeriod(c);
        if (part > 0) p = lcm(p, part);
    }
    return p;
}

/**
 * THE RECEIVED CLOCK of a clip at absolute time `t`: each windowed or
 * one-shot ancestor maps the clock on the way down (StackNode::childContext
 * — the JS twin of the stack form of innerAt). `contextCycle` is the
 * island cycle (one-shot stacks at the top level fold on it). Returns
 * { t, rest } — rest when an ancestor one-shot is between firings.
 */
export function receivedClock(st, id, t, contextCycle, half = 0) {
    let epoch = st.islandEpoch;
    let near = false;
    for (const s of ancestorsOf(st, id)) {
        const map = activeMapOf(s);
        const oneShot = s.periodSource === 'context';
        if (!map && !oneShot) continue;
        const O = s.anchored ? s.origin : epoch;
        const shot = map ? mapPeriod(map) : stackPeriod(s);
        const eff = map || singleSegment(0, shot);
        const at = innerAt(t, O, eff, oneShot ? contextCycle : mapPeriod(eff));
        if (at.rest) return { t, rest: true, run: at.run };
        // An ANCESTOR's seam inside the analysis window: the frame holds
        // two capture moments of every member — skip it for them.
        if (half > 0 && (at.run < half || nearSeam(eff, at.h, half))) near = true;
        t = O + at.inner;
        if (map) epoch = O + mapOffset(map, 0);
    }
    return { t, rest: false, near };
}

/** The capture moments sounding per frame, keyed by island phase (Q,
 * rounded to the hop) — a model-free fingerprint of what sounds, for
 * before/after comparisons of an edit that must be audio-neutral. */
export function fingerprint(L, ids = null) {
    const byTake = {};
    for (const [id, takes] of Object.entries(L.clips))
        for (const t of takes) byTake[`${id}/${t.take}`] = t.captureClock;
    const out = new Map();
    for (const f of L.frames) {
        const clocks = f.heard
            .filter(h => !ids || ids.includes(h.id))
            .map(h => byTake[`${h.id}/${h.take}`] + h.inner)
            .sort((a, b) => a - b);
        out.set(Math.round(f.phase), clocks);
    }
    return out;
}

/** Listen from the island's cycle TOP so two listens share their frame
 * phases exactly (the fingerprint comparison needs it). */
export async function listenAtTop(page, opts = {}) {
    const s = await engine(page, 'status');
    const need = mod(-s.islandPos, s.cycle);
    if (need > 0) await engine(page, 'advance', { samples: need });
    return listen(page, opts);
}

/** Two listens from the top must sound the same capture moments at
 * every phase (within `tol` samples), frames near seams excepted. */
export function expectSameSound(before, after, { ids = null, tol = 900, label = '' } = {}) {
    const a = fingerprint(before, ids), b = fingerprint(after, ids);
    let compared = 0;
    for (const [phase, clocks] of a) {
        const other = b.get(phase);
        if (!other) continue;
        // A seam inside either window shows as a differing count: skip.
        if (clocks.length !== other.length) continue;
        clocks.forEach((c, i) => {
            expect(Math.abs(c - other[i]), `${label} @ ${(phase / before.quantum).toFixed(2)}Q: capture ${(c / before.quantum).toFixed(3)}Q became ${(other[i] / before.quantum).toFixed(3)}Q`)
                .toBeLessThan(tol);
        });
        compared++;
    }
    expect(compared, `${label}: frames compared`).toBeGreaterThan(before.frames.length / 2);
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
    // 2026-07-23d): the loop's TOP is drawn at srcTopFrac of the tile
    // (lane_body.js drawRepCanvas rotates the slice so its index 0 lands
    // there), so position x of the tile shows slice[(x − rot·P) mod P].
    // (The sign matters only when 2·rot ≢ 0 mod P — every earlier
    // journey happened to be symmetric; the chain's 12Q take windowed to
    // 6Q with its top at 5Q was the first to tell.) Single-segment maps
    // only (the specs' scope).
    if (tile.srcSegs) {
        if (tile.srcSegs.length !== 1) return null;
        const rel = mod(q - tile.startQ - (tile.srcTopFrac || 0) * lane.periodQ, lane.periodQ);
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
    // Members of a ONE-SHOT group: the lane geometry is not judged
    // (their tiles sit under the dashed group tile). Members of a
    // WINDOWED group draw the parent's slice of their own take
    // (childSrcSegsUnderMap) — judged like any heard lane.
    const underMap = id => ancestorsOf(st, id).some(s => s.periodSource === 'context');
    let checked = 0;
    for (const f of L.frames) {
        const t = L.epoch + f.pos;          // absolute clock of the frame centre
        const phaseQ = f.phase / Q;
        for (const c of clips) {
            const gate = silent(c.id, phaseQ);
            if (gate === 'skip') continue;
            const heard = f.heard.filter(h => h.id === c.id);
            const rc = receivedClock(st, c.id, t, L.cycle, half);
            if (rc.near) continue;  // an ancestor map seam inside the frame
            const law = rc.rest ? { rest: true, run: rc.run }
                : innerAt(rc.t, c.origin, mapOfNode(c), foldOf(c.id));
            const label = `${c.name || ''}[${c.id.slice(0, 6)} ${c.duration / Q}Q] @ ${phaseQ.toFixed(2)}Q (frame pos ${f.pos})`;
            if (gate === true || law.rest) {
                // A rest that ends inside the window (a firing edge): skip.
                if (law.rest && law.run !== undefined && law.run < half) continue;
                // Evidence of SOUND is a real peak: a clip gated off
                // that still played would show at its full level
                // (~0.45); leakage from another clip's seam inside the
                // window shows an order of magnitude lower.
                expect(heard.filter(h => h.level > 0.15).map(h => +(h.inner / Q).toFixed(3)),
                    `${label}: expected silence; clip map ${JSON.stringify(L.clips[c.id])}; frame heard ${JSON.stringify(f.heard.map(h => [h.id.slice(0, 6), +(h.inner / Q).toFixed(3), +h.level.toFixed(2)]))}`)
                    .toEqual([]);
                continue;
            }
            // Near a seam the window holds two capture moments: skip —
            // the next seam (run), the loop top, or any map seam behind.
            if (law.run < half || law.inner < half || nearSeam(mapOfNode(c), law.h, half)) continue;
            expect(heard.length, `${label}: expected the clip to sound (law content[${(law.inner / Q).toFixed(3)}Q]); frame heard ${JSON.stringify(f.heard.map(h => [h.id.slice(0, 6), +(h.inner / Q).toFixed(3), +h.level.toFixed(2)]))} unknown ${JSON.stringify(f.unknown.map(u => +(u / Q).toFixed(3)))}`).toBeGreaterThan(0);
            const nearest = heard.reduce((a, b) =>
                Math.abs(b.inner - law.inner) < Math.abs(a.inner - law.inner) ? b : a);
            expect(Math.abs(nearest.inner - law.inner) / Q,
                `${label}: heard content[${(nearest.inner / Q).toFixed(3)}Q], law says content[${(law.inner / Q).toFixed(3)}Q]`)
                .toBeLessThan(tolQ);
            // …and the lane draws that very content there.
            // The lane-frame x of this instant: the view model SEATS the
            // frame zero from the lanes (docs/frame.md; vm.epochSamples),
            // so the frame's x is the absolute clock folded from that
            // zero — never the engine's phase — except the sole definer's
            // RAW frame, where the cursor is mapped into the trim brackets.
            const zeroQ = vm.epochSamples / Q;
            const laneQ = vm.provisionalDefiner
                ? (vm.loopStartQ || 0) + mod(t / Q - zeroQ, vm.loopCycleQ || vm.cycleQ)
                : mod(t / Q - zeroQ, vm.cycleQ);
            const d = underMap(c.id) ? null : displayInnerQ(vm, c.id, laneQ, c.duration / Q);
            if (d && !d.rest) {
                const diff = Math.abs(mod(d.innerQ - nearest.inner / Q + c.duration / Q / 2, c.duration / Q) - c.duration / Q / 2);
                if (diff >= tolQ) {
                    const lane = vm.lanes.find(l => l.id === c.id);
                    const tile = (lane.reps || []).find(r => laneQ >= r.startQ && laneQ < r.endQ) || lane.reps?.[0];
                    console.log(`DISPLAY MISMATCH ${label}\n  node: origin−epoch ${(c.origin - st.islandEpoch) / Q}Q loop [${c.loopStart / Q}, ${c.loopEnd / Q}) active ${c.windowActive} ancestors ${JSON.stringify(ancestorsOf(st, c.id).map(a => ({ id: a.id.slice(0, 6), anchored: a.anchored, originQ: (a.origin - st.islandEpoch) / Q, loop: [a.loopStart / Q, a.loopEnd / Q], active: a.windowActive })))}\n  lane: periodQ ${lane.periodQ} takeStartQ ${lane.takeStartQ} underMap ${!!lane.underMap} tile ${JSON.stringify(tile)}\n  vm: cycleQ ${vm.cycleQ} epochQ ${vm.epochSamples / Q}`);
                }
                expect(diff, `${label}: lane draws content[${d.innerQ.toFixed(3)}Q], engine sounds content[${(nearest.inner / Q).toFixed(3)}Q]`)
                    .toBeLessThan(tolQ);
            }
            checked++;
        }
    }
    expect(checked, 'frames checked').toBeGreaterThan(0);
    return L;
}

/** Every take's DECODED capture clock lies inside the sweep span its
 * recording consumed (recSweep) — the listener's clip map read the
 * buffer right. */
export function expectCaptureClocksSane(L) {
    for (const [id, takes] of Object.entries(L.clips)) {
        const span = recSweep.get(id);
        if (!span) continue;
        for (const t of takes) {
            expect(t.captureClock, `${id.slice(0, 6)} take ${t.take}: capture clock ≥ arm`)
                .toBeGreaterThan(span.from - 600);
            expect(t.captureClock, `${id.slice(0, 6)} take ${t.take}: capture clock ≤ settle`)
                .toBeLessThan(span.to + 600);
        }
    }
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
export async function driveToPhase(page, atPhase) {
    const s = await engine(page, 'status');
    // islandPos is published EPOCH-RELATIVE (unwrapped): the phase
    // is its fold on the cycle.
    const ph = mod(s.islandPos, s.cycle);
    const need = mod(atPhase - 100 - ph, s.cycle);
    if (need > 0) await engine(page, 'advance', { samples: need });
}

/** A fresh empty clip under `parent` ('' = top level); returns its id. */
export async function newClip(page, parent = '') {
    await call(page, 'createNode', 'clip', parent);
    const st = await state(page);
    const holder = parent ? findNode(st, parent) : st;
    return holder.nodes[holder.nodes.length - 1].id;
}

/** The sweep-clock span each recorded take consumed (arm → settle):
 * its decoded capture clock must fall inside it. */
export const recSweep = new Map();

export async function rec(page, len, { atPhase = null, parent = '' } = {}) {
    const before = await state(page);
    const first = !(before.quantum > 0);
    if (atPhase !== null) await driveToPhase(page, atPhase);
    const id = await newClip(page, parent);
    const sweepFrom = (await engine(page, 'status')).sweepClock;
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
    recSweep.set(id, { from: sweepFrom, to: (await engine(page, 'status')).sweepClock });
    return id;
}

/** A fresh empty group at the top level; returns its id. */
export async function newGroup(page) {
    await call(page, 'createNode', 'stack', '');
    const st = await state(page);
    return st.nodes[st.nodes.length - 1].id;
}

/**
 * A GROUP TAKE (Q7): arm the stack — every empty member records as one
 * performance, each from its own input channel — `len` samples, the
 * clock paused and advanced exactly (the `rec` recipe). Returns the
 * member ids in tree order.
 */
export async function recGroup(page, stackId, len, { atPhase = null } = {}) {
    const before = await state(page);
    const first = !(before.quantum > 0);
    if (atPhase !== null) await driveToPhase(page, atPhase);
    const members = (findNode(before, stackId).nodes || []).map(n => n.id);
    expect(members.length, 'group has members to arm').toBeGreaterThan(0);
    await call(page, 'startRecordingInNode', stackId);
    const rs = await advanceUntil(page, s => {
        const n = findNode(s, members[0]);
        return n && n.isRecording;
    });
    const live = findNode(rs, members[0]).duration;
    const more = len - live - (first ? 0 : BLOCK);
    if (more > 0) await engine(page, 'advance', { samples: more });
    await call(page, 'stopRecordingInNode', stackId);
    await advanceUntil(page, s => members.every(id => !hot(findNode(s, id))));
    return members;
}

/** Arm an empty member under a WINDOWED group: the take records
 * through the map and auto-finishes after one pass (no stop). */
export async function recThrough(page, parent) {
    const id = await newClip(page, parent);
    await call(page, 'startRecordingInNode', id);
    await advanceUntil(page, s => { const n = findNode(s, id); return n && n.isRecording; });
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
