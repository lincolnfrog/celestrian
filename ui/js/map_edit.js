/**
 * Map-editor algebra (time_maps.md §4, phase 3 — CUT BANDS, the
 * owner-chosen design 2026-07-22) — pure Q-space interval math. No
 * DOM, no state.
 *
 * The vocabulary split: leading/trailing exclusions belong to the
 * WINDOW (the existing bracket gesture); INNER gaps are CUT BANDS —
 * visible objects with their own handles. A cut's length is ALWAYS a
 * whole number of Qs (the seam theorem: groove-transparent iff removed
 * length ≡ 0 mod Q; owner ruling 2026-08-09 made this categorical —
 * the earlier ⌥-free escape hatch is gone, edits can only snap to Q
 * unless they modify the Q-defining clip itself). Cuts slide FREELY in
 * POSITION — excising exactly 1Q off the grid is the design's reason
 * to exist — but only within their kept neighbourhood (cutBounds), so
 * a cut meets a neighbouring gap at exact adjacency (whole ∪ whole
 * stays whole), never by fractional overlap.
 *
 * Conventions: segments are [[startQ, endQ), ...] sorted and disjoint
 * — the KEPT (covered) set; `null`/`[]` = no map (the full span
 * sounds). Results covering everything return [] (full span = no map);
 * results that would sound NOTHING or exceed MAX_SEGMENTS return null
 * (refusal — callers keep the previous map).
 */

import { MAX_SEGMENTS } from './time_map.js';

const EPS = 1e-9;

/** Normalize a covered set: sort, drop empties, merge touching runs. */
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

/** The covered set of a node's map over [0, totalQ): no map = all. */
export function coveredSet(segs, totalQ) {
    return segs && segs.length ? normalizeSegments(segs) : [[0, totalQ]];
}

/** Every gap in the covered set over [0, totalQ) — leading, inner,
 * and trailing. */
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

/** Only the INNER gaps — strictly between the first kept start and the
 * last kept end. Leading/trailing exclusions are the window brackets'
 * domain; these are the cut bands. */
export function innerCuts(segs, totalQ) {
    const covered = coveredSet(segs, totalQ);
    if (covered.length === 0) return [];
    const lo = covered[0][0];
    const hi = covered[covered.length - 1][1];
    return cutsOf(segs, totalQ).filter(([a, b]) => a > lo - EPS && b < hi + EPS
        && a >= lo && b <= hi);
}

/**
 * Remove [inQ, outQ) from the covered set — place or reshape a cut; a
 * cut inside a segment splits it. [] = no map restored; null = refusal
 * (nothing would sound, or too many segments).
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
    if (norm.length === 1 && norm[0][0] <= EPS && norm[0][1] >= totalQ - EPS) {
        return [];
    }
    return norm;
}

/** Add [inQ, outQ) back to the covered set — heal a cut. Collapses to
 * [] when the result covers the full span. */
export function healCut(segs, inQ, outQ, totalQ) {
    const norm = normalizeSegments(
        [...coveredSet(segs, totalQ), [inQ, outQ]]);
    if (norm.length === 1 && norm[0][0] <= EPS && norm[0][1] >= totalQ - EPS) {
        return [];
    }
    return norm;
}

/** Double-click creation: the 1Q cut for the Q cell containing
 * `clickQ` (cell-snapped; sliding un-snaps it afterwards). */
export function cellCutAt(clickQ, totalQ) {
    const cell = Math.max(0, Math.min(totalQ - 1, Math.floor(clickQ)));
    return [cell, cell + 1];
}

/**
 * The kept neighbourhood of a cut: the healed covered segment that
 * contains it. Slides and resizes are clamped here (owner ruling
 * 2026-08-09, categorical coherence): a cut may only meet a
 * neighbouring gap at EXACT adjacency — whole ∪ whole stays whole —
 * never by fractional overlap, which is how a slide/resize used to
 * mint a fractional period.
 */
export function cutBounds(segs, cut, totalQ) {
    const healed = coveredSet(healCut(segs, cut[0], cut[1], totalQ), totalQ);
    for (const [s, e] of healed) {
        if (cut[0] >= s - EPS && cut[1] <= e + EPS) return [s, e];
    }
    return [0, totalQ];
}

/**
 * Resize one edge of a cut [a, b): the handle follows `rawQ`; the
 * released length snaps to whole Qs ≥ 1 (linked edges — the OTHER edge
 * holds), capped by the room to the neighbouring gap (loQ/hiQ from
 * cutBounds). No free mode (owner ruling 2026-08-09). Returns
 * { inQ, outQ, lenQ, coherent } — coherent stays in the shape for the
 * defensive ⚠ badge, but every path through here is coherent now.
 */
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

/** Slide a whole cut to start at `rawStartQ`, length held, clamped to
 * its kept neighbourhood (loQ/hiQ from cutBounds — see there). */
export function slideCutTarget({ cut, rawStartQ, maxQ,
                                 loQ = 0, hiQ = maxQ }) {
    const lenQ = cut[1] - cut[0];
    const a = Math.max(loQ, Math.min(hiQ - lenQ, rawStartQ));
    return { inQ: a, outQ: a + lenQ, lenQ,
             coherent: Math.abs(lenQ - Math.round(lenQ)) < 1e-6 };
}

/** Heard-time period of a covered set (null passes through; [] = the
 * full span sounds). */
export function segsPeriod(segs, totalQ) {
    if (segs === null) return null;
    return segs.length
        ? segs.reduce((n, [a, b]) => n + (b - a), 0)
        : totalQ;
}

/** Trim one outer bound to an absolute raw position (heal reveals,
 * cut consumes); null = refusal, keep previous. */
export function trimBoundTo(segs, edge, boundQ, totalQ) {
    const cov = (segs && segs.length) ? segs : [[0, totalQ]];
    if (edge === 'start') {
        const first = cov[0][0];
        if (boundQ < first - EPS) return healCut(cov, boundQ, first, totalQ);
        return applyCut(cov, 0, boundQ, totalQ);
    }
    const last = cov[cov.length - 1][1];
    if (boundQ > last + EPS) return healCut(cov, last, boundQ, totalQ);
    return applyCut(cov, boundQ, totalQ, totalQ);
}

/** THE SEAM THEOREM'S SNAP (field video 2026-08-08: a whole-Q BOUND
 * over a free-slid cut committed a 0.65Q PERIOD, and the engine's
 * cycle LCM exploded to 66187Q — the timeline went blank). Coherence
 * is period ≡ 0 (mod Q), not bound ≡ 0: with fractional seam positions
 * inside, the two differ. So trims snap the PERIOD and derive the
 * bound. The period is piecewise linear in the bound (slope 1 inside
 * kept material, 0 across cuts) — walk the covered set to the raw
 * position where the kept total is exactly `targetP` (clamped to
 * [1Q, the reachable span]). */
export function trimBoundForPeriod(segs, edge, targetP, totalQ) {
    const cov = (segs && segs.length) ? segs : [[0, totalQ]];
    const covP = cov.reduce((n, [a, b]) => n + (b - a), 0);
    const first = cov[0][0], last = cov[cov.length - 1][1];
    const maxP = covP + (edge === 'end' ? totalQ - last : first);
    const P = Math.max(1, Math.min(targetP, Math.floor(maxP + EPS)));
    if (P > covP - EPS) {  // at/past the current span: heal outward
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

/** ⌥ FREE SLIDE (owner request 2026-08-18): move the whole covered set
 * by `deltaQ` — any fractional amount — with the period HELD, so Q
 * coherence survives (the anchoring law keeps content in place; only
 * which stretch of the take is heard changes). The delta is clamped so
 * the set stays inside [0, totalQ]; a slide never trims. Returns
 * { segs, deltaQ } with the clamped delta actually applied. A full-span
 * set (nothing to slide against) comes back unchanged. */
export function slideSegs(segs, deltaQ, totalQ) {
    const cov = (segs && segs.length) ? segs : [[0, totalQ]];
    const lo = -cov[0][0];
    const hi = totalQ - cov[cov.length - 1][1];
    const d = Math.max(lo, Math.min(hi, deltaQ));
    return { segs: cov.map(([s, e]) => [s + d, e + d]), deltaQ: d };
}
