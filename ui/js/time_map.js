/**
 * The reified time-map (time_maps.md §2) — the JS mirror of
 * src/time_map.h, pinned alongside it to the `time_map_cases` golden
 * vectors in shared/timing_golden.json.
 *
 * A map is an ordered list of segments over a node's inner timeline; a
 * loop window is the one-segment case, and every consumer is
 * segment-general. Shape: { segs: [[start, end), …] } in samples. Pure
 * functions, no state.
 */
import { posMod } from './math_utils.js';

export const MAX_SEGMENTS = 8;

/** A one-window map; empty when the window is. */
export function singleSegment(start, end) {
    return end > start ? { segs: [[start, end]] } : { segs: [] };
}

/** Whether a map restricts anything: it has a segment. An empty or
 * absent map plays the full inner timeline. */
export function mapActive(map) {
    return !!(map && map.segs && map.segs.length > 0);
}

/** Σ (end − start) over an engine-FLAT segments array
 * [s0, e0, s1, e1, …] (samples). Read by the tests only: a node's map
 * goes through publishedMap. */
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
 * walk_segments: a HEARD offset (any integer — folded mod the period,
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

/** Inverse of mapOffset: the heard offset in [0, period) at which the
 * map visits inner position `inner`, or −1 when it never does. */
export function heardOffsetOf(map, inner) {
    if (!mapActive(map)) return -1;
    let heard = 0;
    for (const [s, e] of map.segs) {
        if (inner >= s && inner < e) return heard + (inner - s);
        heard += e - s;
    }
    return -1;
}

/**
 * Does a PUBLISHED node's map play? The backend's `windowActive` when
 * the field is there — it folds in a stack's suspension and its step
 * audition. A state without it reads active when it is not bypassed and
 * carries a map; that fallback knows nothing of suspension or audition.
 * The one copy of the rule: nothing else restates it.
 */
export function nodeWindowActive(n) {
    return n.windowActive ?? (!n.loopBypassed &&
        ((Array.isArray(n.segments) && n.segments.length >= 4) ||
         (n.loopEnd || 0) > (n.loopStart || 0)));
}

/**
 * A PUBLISHED node's STORED map, reified: { segs: [[start, end), …] } in
 * samples. The `segments` override (flat pairs) when it carries two or
 * more — the engine publishes loopStart = loopEnd = 0 beside it — else
 * the single window loopStart / loopEnd, else none (`segs` empty). The
 * geometry survives bypass and suspension: whether it PLAYS is
 * nodeWindowActive. ONE CLAMP: a committed clip's map selects its take,
 * so a span ends where the take does (a live take's `duration` is what
 * it has captured so far, and clamps nothing).
 *
 * @param {Object} node  engine-published node (clip or stack)
 * @returns {{segs: Array<[number, number]>}}
 */
export function publishedMap(node) {
    const flat = node.segments;
    const pairs = [];
    if (Array.isArray(flat) && flat.length >= 4) {
        for (let i = 0; i + 1 < flat.length; i += 2) {
            pairs.push([flat[i], flat[i + 1]]);
        }
    } else {
        pairs.push([node.loopStart || 0, node.loopEnd || 0]);
    }
    const take = node.type !== 'stack' && !node.isRecording && node.duration > 0
        ? node.duration : Infinity;
    const segs = [];
    for (const [start, end] of pairs) {
        const e = Math.min(end, take);
        if (e > start) segs.push([start, e]);
    }
    return { segs };
}

/** The period, in samples, of the map a published node PLAYS: its
 * stored map's while the window is active, else 0. */
export function publishedMapPeriod(node) {
    return nodeWindowActive(node) ? mapPeriod(publishedMap(node)) : 0;
}

/** Samples from `heardOff` for which the map advances CONTINUOUSLY: the
 * distance to the end of the containing segment (a segment boundary is
 * always a seam). 0 when the map is inactive. */
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
 * THE RENDER EQUATION (composition.md §2) — the JS twin of src/timing.h
 * innerAt, pinned to the `inner_at_cases` golden vectors. For a node
 * with `origin`, EFFECTIVE map `map` (its active map, or its whole inner
 * span as one segment), shot S = mapPeriod(map) and a0 = mapOffset(map, 0):
 *
 *   h = (t − origin − a0) mod fold;   inner = mapOffset(h) while h < S;
 *   rest = h ≥ S   (a one-shot's silent remainder of the context cycle)
 *
 * This is THE ANCHORING LAW: the map's content starts sounding at
 * origin + a0. `fold` is S for a looping node and the context cycle for
 * a one-shot; a fold below the shot reads as the shot. `run` is the
 * continuity from t: to the next seam, the shot's end, or the rest's
 * end.
 *
 * @returns {{h: number, inner: number, run: number, rest: boolean}}
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

/**
 * THE STACK FOLD — the JS twin of src/timing.h stackFold: how a stack
 * turns the clock it receives into the clock its children hear, as the
 * (map, fold) pair innerAt reads from the stack's origin.
 *
 *  - A MAPPED stack folds its map on the map period.
 *  - A ONE-SHOT stack (`periodFromContext`, in a cycle longer than its
 *    shot) folds on the CONTEXT CYCLE: its shot is its map, else
 *    [0, own period), fired once per cycle and resting for the remainder.
 *  - Any other stack is TRANSPARENT (`folds` false): the clock passes
 *    through and each child folds on its own.
 *
 * A one-shot CLIP folds the same way, its own period being its take.
 *
 * @param {{segs: Array}} map  the stack's ACTIVE map (empty = none)
 * @param {number} ownPeriod  its own period by the period law, samples
 * @param {number} contextCycle  the scope cycle it receives, samples
 * @returns {{eff: {segs: Array}, fold: number, oneShot: boolean,
 *     folds: boolean}}  `eff` and `fold` are innerAt's map and modulus
 */
export function stackFold(map, periodFromContext, ownPeriod, contextCycle) {
    const mapped = mapActive(map);
    const shot = mapped ? mapPeriod(map) : ownPeriod;
    const oneShot = !!periodFromContext && shot > 0 && contextCycle > shot;
    const eff = mapped ? map : oneShot ? singleSegment(0, shot) : { segs: [] };
    return { eff, fold: oneShot ? contextCycle : mapPeriod(eff), oneShot,
             folds: mapActive(eff) };
}

/* ---- THE TOP (↺, loop_selection.md §9) ----
 * A loop's top is where it reads as starting: a RAW take position stored
 * per node, sounding at origin + a0 + heardOffsetOf(T). Null = unset —
 * only on a take never edited, whose region start stands in: every map
 * edit STORES a top. The JS twins of src/time_map.h keepsTop /
 * regionStart / effectiveTop / reconcileTop, pinned together by the
 * `top_reconcile_cases` and `effective_top_cases` goldens. `map` is the
 * STORED map ({segs}; bypass ignored). */

/** THE KEPT SET: whether raw position `t` is one the stored map plays —
 * a segment holds it, or, with no map, the take (`duration`) does. */
export function keepsTop(map, duration, t) {
    if (t === null || t === undefined || !Number.isFinite(t)) return false;
    if (mapActive(map)) return heardOffsetOf(map, t) >= 0;
    return t >= 0 && t < duration;
}

/** THE REGION START: the map's first start while `windowActive`, else
 * 0 — a bypassed map plays the whole take from its origin. */
export function regionStart(map, windowActive) {
    const segs = (map && map.segs) || [];
    return windowActive && segs.length ? segs[0][0] : 0;
}

/** THE EFFECTIVE TOP (the published `loopTop`): the stored top when set
 * and kept, else the region start. */
export function effectiveTop(map, windowActive, duration, top) {
    return keepsTop(map, duration, top) ? top : regionStart(map, windowActive);
}

/** THE RECONCILE RULE: after ANY map edit the top is STORED —
 * `topBefore`, the effective top before the edit (or at a live gesture's
 * start), while the new kept set (`map`, AFTER the edit) still plays it;
 * else the new region start. Never left unset: a top standing in as the
 * region start would ride every later slide. */
export function reconcileTop(map, windowActive, duration, topBefore) {
    return effectiveTop(map, windowActive, duration, topBefore);
}
