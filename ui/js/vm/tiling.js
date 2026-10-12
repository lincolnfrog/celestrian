/**
 * Tiling — pure geometry: how a lane's material repeats across the
 * frame, and which slices of a take each tile draws. Q floats unless a
 * parameter says samples. No node reading beyond a map's segments.
 */

import { posMod } from '../math_utils.js';
import { mapPeriod, innerAt, stackFold, singleSegment } from '../time_map.js';

/** Tolerance for comparing Q positions: far below any musical
 * distinction, far above the float noise of the divisions made here. */
export const EPS = 1e-9;

/** Most tiles one lane may hold: a degenerate frame (Q not established,
 * a tiny period against a huge cycle) yields none, never thousands. */
export const MAX_TILES = 256;

/** A phase in periods, in [0, 1): one within EPS of a whole period IS
 * that period's top — a tile that starts on its content's top must not
 * read a hair before it (the content's END). */
function phaseFrac(periods) {
    const f = posMod(periods, 1);
    return f < EPS || f > 1 - EPS ? 0 : f;
}

/** The `srcTopFrac` of a tile starting at `startQ` on a grid of
 * `periodQ` whose left edge shows phase `phase` (periods) of its
 * content. */
function topFracAt(startQ, periodQ, phase) {
    return phaseFrac(startQ / periodQ - phaseFrac(phase));
}

/**
 * A lane's tiles across the frame: one per q ≡ offsetQ (mod periodQ),
 * clipped to [0, cycleQ). The grid is never derived through the frame —
 * a growing recording frame is no multiple of every period. Exactly one
 * tile is the take (`ghost: false`): the one at `takeQ`, the cycle
 * position it was performed at (whole cycles fold away; the phase within
 * the cycle does not — a 2Q loop recorded at 2Q marks 2Q→4Q), else the
 * first full repetition. A tile clipped by a frame edge is `wrapped`.
 *
 * Every tile carries its mapping onto the whole of its material
 * (`srcSegs` [[0, 1]], `srcTopFrac` its own start on the frame's grid),
 * so a tile that is clipped — here, or when a one-shot above fires it
 * (fireReps) — draws the part that sounds there, never the whole take
 * squeezed into the piece.
 *
 * @param {Object} o  { periodQ, offsetQ (the grid's phase from the
 *     lane's zero), cycleQ (the frame drawn), takeQ?, maxTiles? }
 * @returns {Array<Rep>}  (lane_common.js)
 */
export function unrollReps({ periodQ, offsetQ, cycleQ, takeQ,
                             maxTiles = MAX_TILES }) {
    if (periodQ <= 0 || cycleQ <= 0) return [];
    if (cycleQ / periodQ > maxTiles) return [];
    const reps = [];
    const first = posMod(offsetQ, periodQ);
    let takeStart = first;
    if (takeQ !== undefined && takeQ >= 0 && takeQ < cycleQ) {
        // Onto this lane's tile grid; the round absorbs the float drift
        // of a fractional-Q period.
        const snapped = first + Math.round((takeQ - first) / periodQ) * periodQ;
        if (snapped >= 0 && snapped < cycleQ) takeStart = snapped;
    }
    // A tile edge within EPS of a frame edge IS that edge: float noise
    // leaves no sliver tile, and the tiles still span [0, cycleQ].
    for (let s = first - periodQ; s < cycleQ; s += periodQ) {
        const startQ = s <= EPS ? 0 : s;
        const endQ = s + periodQ >= cycleQ - EPS ? cycleQ : s + periodQ;
        if (endQ - startQ <= EPS) continue;
        reps.push({
            startQ,
            endQ,
            ghost: Math.abs(s - takeStart) > EPS,
            wrapped: s < -EPS || s + periodQ > cycleQ + EPS,
            srcSegs: [[0, 1]],
            srcTopFrac: topFracAt(startQ, periodQ, (startQ - s) / periodQ),
        });
    }
    return reps;
}

/** Where a lane's take tile starts (0 with none): the content-frame
 * origin its brackets, dims and bands are measured from. Only tile ENDS
 * are clipped, so this is the tile's unclipped start. */
export function takeTileStart(reps) {
    return (reps.find(r => !r.ghost) || { startQ: 0 }).startQ;
}

/**
 * Tiles for a lane that shows a map's CONTENT (the heard view): on the
 * frame grid from 0, every tile drawing `srcSegs` (slices of the raw
 * take, as fractions of it, in heard order) rotated so the loop's heard
 * top sits `heardTopQ` into the tile. Tiled from its anchor instead, a
 * mid-phase loop would split into a tile and a wrap sliver drawn as a
 * repeat; rotation keeps every sample at its island phase (I2). A loop
 * that fills the frame has no repeats: no tile is a ghost.
 */
export function heardReps(periodQ, cycleQ, srcSegs, heardTopQ) {
    const src = { srcSegs, srcTopFrac: periodQ > 0 ? heardTopQ / periodQ : 0 };
    const fills = periodQ >= cycleQ - EPS;
    return unrollReps({ periodQ, offsetQ: 0, cycleQ, takeQ: 0 })
        .map(r => Object.assign({}, r, src, fills ? { ghost: false } : null));
}

/**
 * WHERE A ONE-SHOT SOUNDS (Q5; clips and groups, composition.md §9),
 * from the fold the engine reads (time_map.stackFold): its SHOT — its
 * active map, else its own period — starts sounding `startQ` from the
 * lane's zero (origin + a0, folded), runs `lenQ`, and fires again every
 * `everyQ`: the scope cycle it hears. The remainder of each cycle rests.
 * In a cycle no longer than its shot a one-shot is the plain loop:
 * `everyQ` is then the shot's own length and the firings abut.
 *
 * @param {Object} o
 *   map      the node's ACTIVE map, samples ({segs}; empty = none)
 *   own      its own period, samples: a clip's take; a stack's by the
 *            period law
 *   isStack  a stack with no map in a cycle no longer than its own
 *            period is transparent — it fires nothing
 *   origin   its origin from the lane's zero, samples
 *   scopeQ   the scope cycle it hears; 0 = unknown, once per frame
 * @returns {?{startQ: number, lenQ: number, everyQ: number,
 *     segs: Array<[number, number]>}}  `segs`: the shot's slices of the
 *     node's raw material, samples, in heard order; null = no shot
 */
export function shotOf({ map, own, isStack, origin, scopeQ, quantum, cycleQ }) {
    const cycle = Math.round((scopeQ > 0 ? scopeQ : cycleQ) * quantum);
    const fold = stackFold(map, true, Math.round(own || 0), cycle);
    const eff = fold.folds || isStack ? fold.eff
                                      : singleSegment(0, Math.round(own || 0));
    const shot = mapPeriod(eff);
    if (!(shot > 0)) return null;
    const everyQ = (fold.oneShot ? fold.fold : shot) / quantum;
    const startQ = posMod(origin + eff.segs[0][0], everyQ * quantum) / quantum;
    return { startQ: everyQ - startQ < EPS ? 0 : startQ,
             lenQ: shot / quantum, everyQ, segs: eff.segs };
}

/**
 * FIRE a one-shot's picture. `tiles` are drawn in the SHOT's own frame —
 * its top at 0, `shot.lenQ` long; they repeat at every firing
 * (shot.startQ + k·shot.everyQ) and are clipped to the frame, a firing
 * the frame's end cuts continuing at its start. Between firings the lane
 * is empty: the rest.
 *
 * The first firing is the take's: its tiles keep their own `ghost`; the
 * others are repetitions — but for the tail of a sole firing wrapped to
 * the frame's start, which is the same pass. A tile that shows a mapping
 * (`srcSegs`) keeps its content where it sounds: `srcTopFrac` is re-read
 * on the frame's grid (`periodQ`, the lane's tile period). One that
 * shows none is moved whole.
 */
export function fireReps(tiles, shot, cycleQ, periodQ) {
    const out = [];
    if (!shot || !(cycleQ > 0) || !(shot.everyQ > 0)) return out;
    const echoes = cycleQ / shot.everyQ <= MAX_TILES;
    const solePass = shot.everyQ >= cycleQ - EPS;
    for (let k = -1; ; k++) {
        const at = shot.startQ + k * shot.everyQ;
        if (at >= cycleQ - EPS || (k > 0 && !echoes)) break;
        const take = k === 0 || (k === -1 && solePass);
        for (const t of tiles) {
            const a = t.startQ + at, b = t.endQ + at;
            const startQ = a <= EPS ? 0 : a;
            const endQ = b >= cycleQ - EPS ? cycleQ : b;
            if (endQ - startQ <= EPS) continue;
            const rep = { ...t, startQ, endQ,
                          ghost: !!t.ghost || !take,
                          wrapped: !!t.wrapped || a < -EPS || b > cycleQ + EPS };
            if (t.srcSegs && periodQ > 0) {
                const phase = t.startQ / periodQ - (t.srcTopFrac || 0) +
                    (startQ - a) / periodQ;
                rep.srcTopFrac = topFracAt(startQ, periodQ, phase);
            }
            out.push(rep);
        }
    }
    return out.sort((x, y) => x.startQ - y.startQ);
}

/** A one-shot's own tile in its shot's frame: the whole shot, drawing
 * `srcSegs` (fractions of its raw material, in heard order). */
export function shotTile(shot, srcSegs) {
    return { startQ: 0, endQ: shot.lenQ, ghost: false, wrapped: false,
             srcSegs, srcTopFrac: 0 };
}

/**
 * The slices of a member's take heard through an ENCLOSING active map,
 * in heard order: the `srcSegs` its tiles draw, summing to the parent's
 * map period. Each parent segment is walked run by run through THE
 * RENDER EQUATION (time_map.innerAt) — the member folds the
 * parent-mapped clock on its own map from its own origin — in WHOLE
 * SAMPLES: stepped in Q floats, a run that ends on the member's wrap can
 * land an ulp short of it and cut the slice.
 *
 * @param {Array<[number, number]>} parentSegs  the enclosing map's
 *     segments, samples from the mapping group's origin
 * @param {number} origin  the member's origin in that frame, samples
 * @param {{segs: Array}} map  the member's EFFECTIVE map: its own
 *     active map, or its whole take (`take` samples) as one segment
 * @returns {?Array<[number, number]>} fractions of `take`; null when
 *     nothing plays or the ratio is degenerate
 */
export function childSrcSegsUnderMap(parentSegs, origin, map, take) {
    const whole = segs => (segs || [])
        .map(([s, e]) => [Math.round(s), Math.round(e)])
        .filter(([s, e]) => e > s);
    const own = { segs: whole(map && map.segs) };
    const period = mapPeriod(own);
    if (!(period > 0) || !(take > 0)) return null;
    const from = Math.round(origin);
    const out = [];
    let pieces = 0;
    for (const [s0, e0] of whole(parentSegs)) {
        let t = s0;
        while (t < e0) {
            const at = innerAt(t, from, own, period);
            const step = Math.min(e0 - t, at.run);
            const a = Math.min(at.inner, take);
            const b = Math.min(at.inner + step, take);
            if (b > a) out.push([a / take, b / take]);
            t += step;
            if (++pieces > MAX_TILES) return null;
        }
    }
    return out.length ? out : null;
}
