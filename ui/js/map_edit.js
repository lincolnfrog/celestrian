/**
 * Map-editor algebra (time_maps.md §4, phase 3 — CUT BANDS, the
 * owner-chosen design 2026-07-22) — pure Q-space interval math. No
 * DOM, no state.
 *
 * The vocabulary split: leading/trailing exclusions belong to the
 * WINDOW (the existing bracket gesture); INNER gaps are CUT BANDS —
 * visible objects with their own handles. A cut's length links to
 * whole Qs (the seam theorem: groove-transparent iff removed length
 * ≡ 0 mod Q) unless deliberately freed (⚠, never silent). Cuts slide
 * FREELY — excising exactly 1Q off the grid is the design's reason to
 * exist.
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
 * Resize one edge of a cut [a, b): the handle follows `rawQ`; the
 * released length snaps to whole Qs ≥ 1 (linked edges — the OTHER edge
 * holds) unless `free`. Returns { inQ, outQ, lenQ, coherent } —
 * coherent ⇔ lenQ ≡ 0 (mod 1), the "2Q" vs "1.37Q ⚠" badge.
 */
export function resizeCutTarget({ cut, edge, rawQ, maxQ, free = false }) {
    let [a, b] = cut;
    if (edge === 'start') a = Math.max(0, Math.min(rawQ, b - 0.05));
    else b = Math.min(maxQ, Math.max(rawQ, a + 0.05));
    if (!free) {
        const lenQ = Math.max(1, Math.round(b - a));
        if (edge === 'start') a = Math.max(0, b - lenQ);
        else b = Math.min(maxQ, a + lenQ);
    }
    const lenQ = b - a;
    return { inQ: a, outQ: b, lenQ,
             coherent: Math.abs(lenQ - Math.round(lenQ)) < 1e-6 };
}

/** Slide a whole cut to start at `rawStartQ`, length held, clamped to
 * the span. */
export function slideCutTarget({ cut, rawStartQ, maxQ }) {
    const lenQ = cut[1] - cut[0];
    const a = Math.max(0, Math.min(maxQ - lenQ, rawStartQ));
    return { inQ: a, outQ: a + lenQ, lenQ,
             coherent: Math.abs(lenQ - Math.round(lenQ)) < 1e-6 };
}
