/**
 * The reified time-map (time_maps.md §2) — JS mirror of src/time_map.h.
 *
 * A map is an ordered list of segments over a node's inner timeline;
 * today's loop window is the single-segment case, and the phase-3
 * cell/punch editor edits the same object with more segments. Every
 * consumer is segment-general NOW.
 *
 * Shape: { segs: [[start, end), ...] } in samples. Pure functions, no
 * state — pinned to the `time_map_cases` golden vectors in
 * shared/timing_golden.json alongside the C++ side.
 */
import { posMod } from './math_utils.js';

export const MAX_SEGMENTS = 8;

/** Today's loop window: one segment, empty when invalid. */
export function singleSegment(start, end) {
    return end > start ? { segs: [[start, end]] } : { segs: [] };
}

/**
 * Whether a map restricts anything: non-null with at least one segment.
 * An empty/absent map means "play the full inner timeline".
 *
 * @param {?{segs: Array<[number, number]>}} map
 * @returns {boolean}
 */
export function mapActive(map) {
    return !!(map && map.segs && map.segs.length > 0);
}

/**
 * Heard-time period of an ENGINE-FLAT segments array
 * `[s0, e0, s1, e1, ...]` (samples, as published on node metadata):
 * Σ (end − start). The companion of {@link mapPeriod}, which does the
 * same sum over the reified pair-list shape. The `length >= 4`
 * activity check ("is this a multi-segment override at all?") stays at
 * the call sites — a short or absent array is a semantic fact about the
 * node, not about this sum.
 *
 * @param {number[]} flatSegs  flat [start, end, start, end, ...] samples
 * @returns {number}           summed segment length in samples
 */
export function flatSegPeriod(flatSegs) {
    let p = 0;
    for (let i = 0; i + 1 < flatSegs.length; i += 2) {
        p += flatSegs[i + 1] - flatSegs[i];
    }
    return p;
}

/** Heard-time length of one map pass: Σ (end − start). */
export function mapPeriod(map) {
    if (!mapActive(map)) return 0;
    let p = 0;
    for (const [s, e] of map.segs) p += e - s;
    return p;
}

/**
 * walk_segments: a HEARD offset (any integer — folded mod period,
 * negatives included) → the inner-time offset it selects. The caller
 * re-bases into absolute time by adding the received frame top.
 */
export function mapOffset(map, heardOff) {
    const p = mapPeriod(map);
    if (p <= 0) return heardOff;
    let h = posMod(heardOff, p);
    for (const [s, e] of map.segs) {
        const len = e - s;
        if (h < len) return s + h;
        h -= len;
    }
    return map.segs[0][0]; // unreachable: h < p by construction
}

/**
 * Inverse of mapOffset: the heard offset (within [0, period)) at which
 * the map visits inner position `inner`, or -1 when unvisited.
 */
export function heardOffsetOf(map, inner) {
    if (!mapActive(map)) return -1;
    let heard = 0;
    for (const [s, e] of map.segs) {
        if (inner >= s && inner < e) return heard + (inner - s);
        heard += e - s;
    }
    return -1;
}

/** A PUBLISHED node's window-activity verdict — the engine's
 * `windowActive` when the field is present, else derived exactly the
 * way the engine does (not bypassed, and either a multi-segment map or
 * a forward single window). ONE copy: the composite mixdown, the
 * timeline period math and the VM's member checks all read this
 * instead of restating the fallback. */
export function nodeWindowActive(n) {
    return n.windowActive ?? (!n.loopBypassed &&
        ((Array.isArray(n.segments) && n.segments.length >= 4) ||
         (n.loopEnd || 0) > (n.loopStart || 0)));
}

/**
 * Samples from heardOff for which the map advances CONTINUOUSLY: the
 * distance to the end of the containing segment. Segment boundaries
 * always count as seams. Returns 0 when the map is inactive.
 */
export function seamDistance(map, heardOff) {
    const p = mapPeriod(map);
    if (p <= 0) return 0;
    let h = posMod(heardOff, p);
    for (const [s, e] of map.segs) {
        const len = e - s;
        if (h < len) return len - h;
        h -= len;
    }
    return 0; // unreachable
}

/**
 * THE RENDER EQUATION (composition.md §2), the JS twin of
 * src/timing.h innerAt — pinned to the `inner_at_cases` golden vectors.
 * For a node with `origin`, EFFECTIVE map `map` (active, or the whole
 * inner span as one segment), shot S = mapPeriod(map) and a0 =
 * mapOffset(map, 0):
 *   h = (t − origin − a0) mod fold;  inner = mapOffset(h) while h < S;
 *   rest = h >= S (a one-shot's silent remainder of the context cycle).
 * `fold` is S for a looping node and the context cycle for a one-shot;
 * a fold below the shot reads as the shot. `run` is the continuity
 * from t: to the next seam, the shot end, or the rest end.
 * @returns {{h:number, inner:number, run:number, rest:boolean}}
 */
export function innerAt(t, origin, map, fold) {
    const shot = mapPeriod(map);
    if (shot <= 0) return { h: 0, inner: 0, run: 1, rest: false };
    if (fold < shot) fold = shot;
    const h = posMod(t - origin - mapOffset(map, 0), fold);
    if (h >= shot) return { h, inner: h, run: fold - h, rest: true };
    const run = seamDistance(map, h);
    return { h, inner: mapOffset(map, h), run: run > 0 ? run : 1, rest: false };
}

/* ---- THE TOP (↺, loop_selection.md §9; owner 2026-09-24) ----
 * A loop's top is where it reads as starting: a RAW take position
 * stored per clip, sounding at origin + a0 + heardOffsetOf(T); null =
 * unset — only on a take never edited (a fresh take, an old session),
 * whose region start stands in: every map edit STORES a top. The JS
 * twins of src/time_map.h keepsTop / reconcileTop / regionStart /
 * effectiveTop, pinned together by the `top_reconcile_cases` and
 * `effective_top_cases` goldens. `map` is the STORED map ({segs},
 * bypass ignored). */

/** THE KEPT SET: whether raw position `t` is one the stored map plays —
 * a segment holds it, or, with no map, the take (`duration`) does. */
export function keepsTop(map, duration, t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return false;
    if (mapActive(map)) return heardOffsetOf(map, t) >= 0;
    return t >= 0 && t < duration;
}

/** THE REGION START: the map's first start while `windowActive` — one
 * window or many segments alike — else 0, the take's own start (a
 * bypassed map plays the whole take from its origin). */
export function regionStart(map, windowActive) {
    const segs = (map && map.segs) || [];
    return windowActive && segs.length ? segs[0][0] : 0;
}

/** THE EFFECTIVE TOP (the published `loopTop`): the stored top when set
 * and kept, else the region start. */
export function effectiveTop(map, windowActive, duration, top) {
    return keepsTop(map, duration, top) ? top : regionStart(map, windowActive);
}

/** THE RECONCILE RULE: after ANY map edit the top is STORED — `topBefore`,
 * the EFFECTIVE top before the edit (or at a live gesture's start),
 * while the new kept set (`map`, AFTER the edit) still plays it, else
 * the new region start. Never unset (null): a top left to stand in as
 * the region start would ride every later slide (the rejected v5), and
 * the owner's P2 keeps an existing ↺ put while the region holds it. */
export function reconcileTop(map, windowActive, duration, topBefore) {
    return effectiveTop(map, windowActive, duration, topBefore);
}
