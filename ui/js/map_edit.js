/**
 * Map-editor algebra (time_maps.md §4): pure Q-space interval math for
 * the loop region's gestures. No DOM, no state.
 *
 * Leading and trailing exclusions belong to the WINDOW; INNER gaps are
 * CUTS. A cut's LENGTH is always a whole number of Qs — THE SEAM
 * THEOREM: an edit is groove-transparent iff the removed length ≡ 0
 * (mod Q). Its POSITION is free, but only within its kept neighbourhood
 * (cutBounds), so a cut meets a neighbouring gap at exact adjacency,
 * never by fractional overlap.
 *
 * A segment list is [[startQ, endQ), …], sorted and disjoint: the KEPT
 * set; null or [] = no map (the full span sounds). A result covering
 * everything is []; one that would sound nothing, or exceed
 * MAX_SEGMENTS, is null — a refusal: the caller keeps the previous map.
 */

import { MAX_SEGMENTS } from './time_map.js';

const EPS = 1e-9;

/** Normalize a kept set: sort, drop empties, merge touching runs. */
export function normalizeSegments(segs) {
    const sorted = (segs || [])
        .filter(([s, e]) => e - s > EPS)
        .slice()
        .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [s, e] of sorted) {
        const last = out[out.length - 1];
        if (last && s <= last[1] + EPS) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

/** The kept set of a node's map over [0, totalQ), normalized; no map =
 * the full span. */
export function coveredSet(segs, totalQ) {
    return segs && segs.length ? normalizeSegments(segs) : [[0, totalQ]];
}

/** The kept set AS GIVEN (the caller's own sorted, disjoint list, its
 * segments left unmerged), or the full span with no map. */
function givenSet(segs, totalQ) {
    return segs && segs.length ? segs : [[0, totalQ]];
}

/** The heard length of a kept set: Σ (end − start). */
function keptLength(segs) {
    return segs.reduce((n, [a, b]) => n + (b - a), 0);
}

/** Whether a normalized set is the full span [0, totalQ): no map. */
function isFullSpan(norm, totalQ) {
    return norm.length === 1 && norm[0][0] <= EPS && norm[0][1] >= totalQ - EPS;
}

/** Every gap in the kept set over [0, totalQ): leading, inner and
 * trailing. */
export function cutsOf(segs, totalQ) {
    const covered = coveredSet(segs, totalQ);
    const out = [];
    let prev = 0;
    for (const [s, e] of covered) {
        if (s - prev > EPS) out.push([prev, s]);
        prev = e;
    }
    if (totalQ - prev > EPS) out.push([prev, totalQ]);
    return out;
}

/** Only the INNER gaps — between the first kept start and the last kept
 * end: the cuts. */
export function innerCuts(segs, totalQ) {
    const covered = coveredSet(segs, totalQ);
    if (covered.length === 0) return [];
    const lo = covered[0][0];
    const hi = covered[covered.length - 1][1];
    return cutsOf(segs, totalQ).filter(([a, b]) => a >= lo && b <= hi);
}

/**
 * Remove [inQ, outQ) from the kept set — place or reshape a cut; a cut
 * inside a segment splits it. [] = no map left; null = refusal.
 */
export function applyCut(segs, inQ, outQ, totalQ) {
    const covered = coveredSet(segs, totalQ);
    const out = [];
    for (const [s, e] of covered) {
        if (outQ <= s + EPS || inQ >= e - EPS) { out.push([s, e]); continue; }
        if (inQ > s + EPS) out.push([s, Math.min(inQ, e)]);
        if (outQ < e - EPS) out.push([Math.max(outQ, s), e]);
    }
    const norm = normalizeSegments(out);
    if (norm.length === 0) return null;
    if (norm.length > MAX_SEGMENTS) return null;
    return isFullSpan(norm, totalQ) ? [] : norm;
}

/** Add [inQ, outQ) back to the kept set — heal a cut. [] when the
 * result is the full span. */
export function healCut(segs, inQ, outQ, totalQ) {
    const norm = normalizeSegments(
        [...coveredSet(segs, totalQ), [inQ, outQ]]);
    return isFullSpan(norm, totalQ) ? [] : norm;
}

/** Double-click creation: the 1Q cut for the Q cell containing `clickQ`
 * (a slide un-snaps it afterwards). */
export function cellCutAt(clickQ, totalQ) {
    const cell = Math.max(0, Math.min(totalQ - 1, Math.floor(clickQ)));
    return [cell, cell + 1];
}

/** The kept neighbourhood of a cut: the kept segment that would contain
 * it were it healed. Slides and resizes are clamped to it, so a cut
 * never overlaps a neighbouring gap by a fraction — which would mint a
 * fractional period. */
export function cutBounds(segs, cut, totalQ) {
    const healed = coveredSet(healCut(segs, cut[0], cut[1], totalQ), totalQ);
    for (const [s, e] of healed) {
        if (cut[0] >= s - EPS && cut[1] <= e + EPS) return [s, e];
    }
    return [0, totalQ];
}

/** Resize one edge of a cut [a, b) toward `rawQ`: the length snaps to
 * whole Qs ≥ 1 (the OTHER edge holds), capped by the room to the
 * neighbouring gap (loQ / hiQ from cutBounds). Returns { inQ, outQ,
 * lenQ, coherent }; `coherent` (always true here) feeds a defensive ⚠. */
export function resizeCutTarget({ cut, edge, rawQ, maxQ,
                                  loQ = 0, hiQ = maxQ }) {
    let [a, b] = cut;
    if (edge === 'start') a = Math.max(loQ, Math.min(rawQ, b - 0.05));
    else b = Math.min(hiQ, Math.max(rawQ, a + 0.05));
    const room = edge === 'start' ? (b - loQ) : (hiQ - a);
    const lenQ = Math.max(1, Math.min(Math.round(b - a),
                                      Math.floor(room + EPS)));
    if (edge === 'start') a = b - lenQ;
    else b = a + lenQ;
    const got = b - a;
    return { inQ: a, outQ: b, lenQ: got,
             coherent: Math.abs(got - Math.round(got)) < 1e-6 };
}

/** Slide a whole cut to start at `rawStartQ`, its length held, clamped
 * to its kept neighbourhood (loQ / hiQ from cutBounds). */
export function slideCutTarget({ cut, rawStartQ, maxQ,
                                 loQ = 0, hiQ = maxQ }) {
    const lenQ = cut[1] - cut[0];
    const a = Math.max(loQ, Math.min(hiQ - lenQ, rawStartQ));
    return { inQ: a, outQ: a + lenQ, lenQ,
             coherent: Math.abs(lenQ - Math.round(lenQ)) < 1e-6 };
}

/** A window bracket's drag target: the pointer's raw Q snaps to the
 * NEAREST whole Q, then clamps so the window keeps at least 1Q inside
 * [0, maxQ] (the lane's intrinsic period). Returns { startQ, endQ }. */
export function windowDragTarget({ edge, rawQ, startQ, endQ, maxQ }) {
    const q = Math.round(rawQ);
    if (edge === 'start') {
        return { startQ: Math.min(Math.max(0, q), endQ - 1), endQ };
    }
    return { startQ, endQ: Math.max(Math.min(maxQ, q), startQ + 1) };
}

/** Heard length of a kept set; null passes through, [] = the full span
 * sounds. */
export function segsPeriod(segs, totalQ) {
    if (segs === null) return null;
    return segs.length ? keptLength(segs) : totalQ;
}

/** Trim one outer bound to an absolute raw position (a heal reveals, a
 * cut consumes); null = refusal. */
export function trimBoundTo(segs, edge, boundQ, totalQ) {
    const cov = givenSet(segs, totalQ);
    if (edge === 'start') {
        const first = cov[0][0];
        if (boundQ < first - EPS) return healCut(cov, boundQ, first, totalQ);
        return applyCut(cov, 0, boundQ, totalQ);
    }
    const last = cov[cov.length - 1][1];
    if (boundQ > last + EPS) return healCut(cov, last, boundQ, totalQ);
    return applyCut(cov, boundQ, totalQ, totalQ);
}

/**
 * THE SEAM THEOREM'S SNAP: the outer bound at which the kept total is
 * exactly `targetP` (clamped to [1Q, the reachable span]). Coherence is
 * PERIOD ≡ 0 (mod Q), not bound ≡ 0: with a free-slid cut inside, a
 * whole-Q bound commits a fractional period and explodes the engine's
 * cycle LCM. So a trim snaps the period and derives the bound.
 */
export function trimBoundForPeriod(segs, edge, targetP, totalQ) {
    const cov = givenSet(segs, totalQ);
    const covP = keptLength(cov);
    const first = cov[0][0], last = cov[cov.length - 1][1];
    const maxP = covP + (edge === 'end' ? totalQ - last : first);
    const P = Math.max(1, Math.min(targetP, Math.floor(maxP + EPS)));
    if (P > covP - EPS) {  // at or past the current span: heal outward
        return edge === 'end'
            ? Math.min(totalQ, last + (P - covP))
            : Math.max(0, first - (P - covP));
    }
    let acc = 0;
    if (edge === 'end') {
        for (const [s, e] of cov) {
            if (acc + (e - s) >= P - EPS) return s + (P - acc);
            acc += e - s;
        }
        return last;
    }
    for (let i = cov.length - 1; i >= 0; i--) {
        const [s, e] = cov[i];
        if (acc + (e - s) >= P - EPS) return e - (P - acc);
        acc += e - s;
    }
    return first;
}

/**
 * ⌥ FREE SLIDE: move the whole kept set by `deltaQ` — any fraction —
 * with the period HELD, so Q coherence survives. Clamped so the set
 * stays inside [0, totalQ]: a slide never trims. Returns { segs, deltaQ }
 * with the delta actually applied.
 */
export function slideSegs(segs, deltaQ, totalQ) {
    const cov = givenSet(segs, totalQ);
    const lo = -cov[0][0];
    const hi = totalQ - cov[cov.length - 1][1];
    const d = Math.max(lo, Math.min(hi, deltaQ));
    return { segs: cov.map(([s, e]) => [s + d, e + d]), deltaQ: d };
}

/** A seam slide never shrinks a segment below this (Q): a sliver, but
 * never an empty segment — which would heal a cut the swap meant to
 * keep. */
export const SEAM_MIN_Q = 1 / 64;

/**
 * THE SPLICE SWAP (loop_selection.md §4.1; §10, P2.3): slide one splice
 * of the kept set by `deltaQ`, the period HELD. Only the strip between
 * the old and the new splice changes what it plays.
 *
 *   j = 0  the WRAP (the loop's end jumping back to its start): the
 *          first segment's start and the last segment's end move
 *          together, so the inner cuts keep their place — on one
 *          segment this IS slideSegs;
 *   j > 0  inner cut j: segment j−1's end and segment j's start move
 *          together (the cut slides, its length held).
 *
 * Clamped to the take, and so that no segment shrinks below SEAM_MIN_Q.
 * Returns { segs, deltaQ } with the delta actually applied; an
 * out-of-range `j` is a no-op.
 */
export function slideSeam(segs, j, deltaQ, totalQ) {
    const cov = coveredSet(segs, totalQ).map(s => s.slice());
    const n = cov.length;
    const len = i => cov[i][1] - cov[i][0];
    let lo, hi;
    if (j <= 0) {
        lo = -cov[0][0];
        hi = totalQ - cov[n - 1][1];
        if (n > 1) {
            // The first segment shrinks by d and the last grows by d (or
            // the reverse): each keeps at least the floor.
            lo = Math.max(lo, SEAM_MIN_Q - len(n - 1));
            hi = Math.min(hi, len(0) - SEAM_MIN_Q);
        }
    } else if (j < n) {
        lo = SEAM_MIN_Q - len(j - 1);
        hi = len(j) - SEAM_MIN_Q;
    } else {
        return { segs: cov, deltaQ: 0 };
    }
    const d = lo > hi ? 0 : Math.max(lo, Math.min(hi, deltaQ));
    if (j <= 0) {
        cov[0][0] += d;
        cov[n - 1][1] += d;
    } else {
        cov[j - 1][1] += d;
        cov[j][0] += d;
    }
    return { segs: cov, deltaQ: d };
}

/**
 * THE SPLICE SWAP BY WHOLE Qs — the plain drag (⌥ moves freely):
 * slideSeam by the whole number of Qs nearest `deltaQ` that its clamp
 * allows; RELATIVE, so a free offset set earlier is kept. slideSeam's
 * clamp is rarely a whole Q away, and asked for a whole Q it cannot
 * have it answers with the bound itself — a sliver of material left at
 * the splice, or a free offset re-gridded at the take's edge. So the
 * move steps back to the largest whole number of Qs inside the bound; 0
 * when none fits. Returns { segs, deltaQ } like slideSeam.
 */
export function slideSeamWhole(segs, j, deltaQ, totalQ) {
    const stay = () =>
        ({ segs: coveredSet(segs, totalQ).map(s => s.slice()), deltaQ: 0 });
    const want = Math.round(deltaQ);
    if (want === 0) return stay();
    const r = slideSeam(segs, j, want, totalQ);
    if (Math.abs(r.deltaQ - want) < EPS) return r;
    const whole = want > 0 ? Math.floor(r.deltaQ + EPS) : Math.ceil(r.deltaQ - EPS);
    // The bound lies short of the first whole Q — or on the far side of
    // 0 (a segment already under the floor): nothing moves.
    if (whole === 0 || Math.sign(whole) !== Math.sign(want)) return stay();
    const w = slideSeam(segs, j, whole, totalQ);
    return Math.abs(w.deltaQ - whole) < EPS ? w : stay();
}

/**
 * ⇧ AT A SPLICE = THE LENGTH THERE (loop_selection.md §10, P2.4): move
 * the END of the material just BEFORE splice `j` by whole Qs — the last
 * segment's end at the wrap (j = 0), segment j−1's end at cut j. Right
 * (+) = more material: a longer loop, or a smaller cut.
 *
 * Clamped so the moved segment keeps some material, the period stays
 * ≥ 1Q, the wrap stays inside the take and a cut can only close — shrunk
 * to nothing it HEALS. A loop grown to the whole take is no map ([]); a
 * sub-Q period has no whole-Q length to change (delta 0). Returns
 * { segs, deltaQ } with the whole-Q delta actually applied.
 */
export function lengthAtSeam(segs, j, deltaQ, totalQ) {
    const cov = coveredSet(segs, totalQ).map(s => s.slice());
    const n = cov.length;
    const cut = j > 0 && j < n;
    const gi = cut ? j - 1 : n - 1;
    const bound0 = cov[gi][1];
    const S0 = keptLength(cov);
    const room = cut ? cov[j][0] - bound0 : totalQ - bound0;
    let k = 0;
    if (S0 >= 1 - EPS) {
        const kmin = Math.max(-(Math.ceil(cov[gi][1] - cov[gi][0] - EPS) - 1),
                              1 - Math.round(S0));
        const kmax = Math.floor(room + EPS);
        k = Math.max(kmin, Math.min(kmax, Math.round(deltaQ)));
    }
    cov[gi][1] = bound0 + k;
    const norm = normalizeSegments(cov);
    return { segs: isFullSpan(norm, totalQ) ? [] : norm, deltaQ: k };
}
