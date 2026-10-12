/**
 * THE MOVE LAWS — what each map gesture does to the covered set, as
 * pure functions (no DOM, no bridge): TRIM, CUT (slide or resize one: a
 * heard lane's SEAM, a raw host's BAND), SLIDE (the whole region, length
 * held) and LENGTH (⇧ at a splice). The interval algebra is
 * ../map_edit.js; the gesture runner that calls these is map_core.js.
 *
 * Each builder returns the gesture's edit function
 *   onMove(rawQ, altKey) → null (refusal — keep the previous preview) or
 *   { segs, follow, active }:
 *     segs:   [[sQ,eQ],…]  the pending covered set
 *     follow: { kind:'bracket', edge, q } | { kind:'band', a, b } |
 *             { kind:'span', a, b }   — the pointer-attached element
 *     active: { q, text, incoherent, ghost } — the landing badge
 *   rawQ is the pointer's raw-take Q (clamped to [0, totalQ]), or null
 *   for the at-rest render at the press.
 * `st` is the band state (map_core bandState); the laws read its `segs`
 * and `totalQ` only.
 */

import { fmtQ } from './sv_util.js';
import { applyCut, healCut, resizeCutTarget, slideCutTarget, segsPeriod,
         trimBoundTo, trimBoundForPeriod, slideSegs, lengthAtSeam,
         coveredSet } from '../map_edit.js';

/* A cut/period length within this of a whole Q displays as whole (and
 * coherent); further off gets the ⚠ badge. */
export const WHOLE_Q_TOL = 0.02;
/* The dashed snap ghost appears only when the landing differs from the
 * pointer by more than this (free slides have no snap to preview). */
export const SNAP_GHOST_MIN_Q = 0.02;
/* The categorical period-coherence tolerance — far tighter than the
 * DISPLAY tolerance above. */
export const EPS_PERIOD = 1e-6;
/* The smallest cut a resize preview may show (Q). */
export const MIN_CUT_Q = 0.05;
/* How far past its whole-Q stops the length drag's follow element may
 * run with the hand (Q). */
const LENGTH_FOLLOW_SLACK_Q = 0.45;

/** A cut's length as text: whole Qs bare, a fraction to two decimals
 * and flagged (`whole` false — the ⚠ of an incoherent cut). */
export function cutLenText(lenQ) {
    const whole = Math.abs(lenQ - Math.round(lenQ)) < WHOLE_Q_TOL;
    return { text: String(whole ? Math.round(lenQ) : lenQ.toFixed(2)), whole };
}

/** A cut band's chip: "2Q cut", "1.50Q cut ⚠". */
export function cutChipLabel(lenQ) {
    const { text, whole } = cutLenText(lenQ);
    return { text: text + 'Q cut' + (whole ? '' : ' ⚠'), incoherent: !whole };
}

/** A signed Q amount for a move's badge ("+1", "−0.25"). */
const signedQ = q => (q >= 0 ? '+' : '−') + fmtQ(Math.abs(q));

/** The badge of a slide by `deltaQ` that holds period `p`. */
const slideBadge = (q, deltaQ, p) => ({
    q, text: 'slide ' + signedQ(deltaQ) + 'Q · ' + fmtQ(p) + 'Q',
    incoherent: false, ghost: false });

/** TRIM one outer bound (`edge`) from `bound00`. Snaps the PERIOD to
 * whole Qs and lands the bound where that period lives (the seam
 * theorem: coherence is the period's, map_edit trimBoundForPeriod); ⌥
 * SLIDES the whole region by any amount instead, length held — always
 * from the grab geometry. ⌥ released mid-drag re-lands the slide on
 * whole Qs, and the trim carries on from there. */
export function trimMoveFn(st, segs0, edge, bound00) {
    let segs = segs0;
    let bound0 = bound00;
    let slidDelta = 0;
    let wasAlt = false;
    const edgeOf = s => edge === 'start' ? s[0][0] : s[s.length - 1][1];
    return (rawQ, alt) => {
        if (alt && rawQ !== null) {
            const { segs: next, deltaQ: delta } =
                slideSegs(segs0, rawQ - bound00, st.totalQ);
            slidDelta = delta;
            wasAlt = true;
            const edgeQ = edgeOf(next);
            return { segs: next,
                follow: { kind: 'bracket', edge, q: edgeQ },
                active: slideBadge(edgeQ, delta, segsPeriod(next, st.totalQ)) };
        }
        if (wasAlt && rawQ !== null) {
            wasAlt = false;
            segs = slideSegs(segs0, Math.round(slidDelta), st.totalQ).segs;
            bound0 = edgeOf(segs);
        }
        const rawBound = rawQ === null
            ? bound0                       // at-rest render
            : Math.max(0, Math.min(st.totalQ, rawQ));
        // No snap until the pointer moves: at rest the bound is shown as
        // it IS (a fractional bound never previews a rounded landing).
        let bound = rawBound;
        if (rawQ !== null) {
            const pFree = segsPeriod(
                trimBoundTo(segs, edge, rawBound, st.totalQ), st.totalQ);
            if (pFree === null) return null;  // refusal zone
            bound = trimBoundForPeriod(segs, edge, Math.round(pFree), st.totalQ);
        }
        const next = trimBoundTo(segs, edge, bound, st.totalQ);
        if (next === null) return null;  // refusal: keep previous
        const p = segsPeriod(next, st.totalQ);
        const whole = Math.abs(p - Math.round(p)) < EPS_PERIOD;
        return { segs: next,
            // The bracket rides the pointer; the ghost marks the landing.
            follow: { kind: 'bracket', edge, q: rawBound },
            active: {
                q: bound,
                text: 'loop ' + edge + ' · ' + fmtQ(p) + 'Q' + (whole ? '' : ' ⚠'),
                incoherent: !whole,
                ghost: Math.abs(rawBound - bound) > SNAP_GHOST_MIN_Q,
            } };
    };
}

/** A CUT (an inner cut `cut` = [inQ, outQ] with kept-neighbourhood
 * clamp [loQ, hiQ]) moved one of two ways, fixed for the call:
 *   - `edge` null — SLIDE: the cut follows the pointer by any amount
 *     from the grab point `grabQ`, length held;
 *   - `edge` 'start' | 'end' — RESIZE: that edge follows the pointer and
 *     lands on whole Qs (the other edge holds).
 * The follow element is the BAND: at its landing for a slide (free, no
 * ghost), from the raw edge under the pointer for a resize, with the
 * snap ghost at the whole-Q landing. */
function cutMove(st, cut, edge, grabQ, loQ, hiQ, rawQ) {
    const target = rawQ === null
        ? { inQ: cut[0], outQ: cut[1] } // at rest
        : edge
            ? resizeCutTarget({ cut, edge, rawQ, maxQ: st.totalQ, loQ, hiQ })
            : slideCutTarget({ cut, rawStartQ: cut[0] + (rawQ - grabQ),
                               maxQ: st.totalQ, loQ, hiQ });
    let next = healCut(st.segs, cut[0], cut[1], st.totalQ);
    next = applyCut(next, target.inQ, target.outQ, st.totalQ);
    if (next === null) return null;  // refusal: keep previous
    const label = cutChipLabel(target.outQ - target.inQ);
    let a = target.inQ;
    let b = target.outQ;
    if (edge === 'start' && rawQ !== null) {
        a = Math.max(0, Math.min(cut[1] - MIN_CUT_Q, rawQ));
    } else if (edge === 'end' && rawQ !== null) {
        b = Math.min(st.totalQ, Math.max(cut[0] + MIN_CUT_Q, rawQ));
    }
    const landQ = edge === 'start' ? target.inQ : target.outQ;
    const handQ = edge === 'start' ? a : b;
    return { segs: next,
        follow: { kind: 'band', a, b },
        active: {
            q: edge ? landQ : (target.inQ + target.outQ) / 2,
            text: label.text,
            incoherent: label.incoherent,
            ghost: !!edge && Math.abs(handQ - landQ) > SNAP_GHOST_MIN_Q,
        } };
}

/** A SEAM (a cut on a heard lane, through the reveal): drag slides the
 * cut freely (length held, its START on the pointer); ⌥-drag resizes
 * (whole-Q snap, its END on the pointer). */
export function seamMoveFn(st, cut, loQ, hiQ) {
    return (rawQ, alt) =>
        cutMove(st, cut, alt ? 'end' : null, cut[0], loQ, hiQ, rawQ);
}

/** A CUT BAND (a cut on a raw-framed host): its chip slides it from the
 * grab point `grabQ` (`edge` null), a handle resizes from its `edge`. */
export function bandMoveFn(st, cut, edge, grabQ, loQ, hiQ) {
    return rawQ => cutMove(st, cut, edge, grabQ, loQ, hiQ, rawQ);
}

/** SLIDE the whole kept region (every segment as one body, length
 * held) from the grab point `grabQ`: whole-Q steps, ⌥ = any amount. */
export function slideMoveFn(st, segs, grabQ) {
    return (rawQ, alt) => {
        const free = rawQ === null ? 0 : rawQ - grabQ;
        const delta = alt ? free : Math.round(free);
        const { segs: next, deltaQ } = slideSegs(segs, delta, st.totalQ);
        const a = next[0][0];
        const b = next[next.length - 1][1];
        return { segs: next,
            follow: { kind: 'span', a, b },
            active: slideBadge((a + b) / 2, deltaQ, segsPeriod(next, st.totalQ)) };
    };
}

/** ⇧ AT SPLICE `j` = THE LENGTH THERE (loop_selection.md P2.4; map_edit
 * lengthAtSeam): the end of the material before the splice — the loop's
 * end at the wrap (j = 0), segment j−1's end at a cut — follows the
 * pointer and lands on whole Qs; right is more material. The follow
 * element: the loop's end bracket at the wrap; at a cut, the band from
 * the pointer to the cut's end (it closes as the material grows — a cut
 * shrunk to nothing heals). */
export function lengthMoveFn(st, segs0, j) {
    const cov = coveredSet(segs0, st.totalQ);
    const n = cov.length;
    const cut = j > 0 && j < n;
    const gi = cut ? j - 1 : n - 1;
    const bound0 = cov[gi][1];
    const cutEnd = cut ? cov[j][0] : null;
    // The reachable stops, for the follow element's leash.
    const lo = lengthAtSeam(cov, j, -1e9, st.totalQ).deltaQ;
    const hi = lengthAtSeam(cov, j, 1e9, st.totalQ).deltaQ;
    return rawQ => {
        const { segs, deltaQ } = lengthAtSeam(cov, j,
            rawQ === null ? 0 : rawQ - bound0, st.totalQ);
        const at = bound0 + deltaQ;
        const hand = rawQ === null ? bound0
            : Math.max(bound0 + lo - LENGTH_FOLLOW_SLACK_Q,
                       Math.min(bound0 + hi + LENGTH_FOLLOW_SLACK_Q, rawQ));
        const p = segsPeriod(segs, st.totalQ);
        const healed = cut && at >= cutEnd - EPS_PERIOD;
        return { segs,
            follow: cut ? { kind: 'band', a: Math.min(hand, cutEnd), b: cutEnd }
                        : { kind: 'bracket', edge: 'end', q: hand },
            active: {
                q: at,
                text: cut
                    ? (healed ? 'cut healed · loop ' + fmtQ(p) + 'Q'
                              : 'cut ' + fmtQ(cutEnd - at) + 'Q · loop ' + fmtQ(p) + 'Q')
                    : 'loop ' + fmtQ(p) + 'Q (' + signedQ(deltaQ) + ')',
                incoherent: false,
                ghost: Math.abs(hand - at) > SNAP_GHOST_MIN_Q,
            } };
    };
}
