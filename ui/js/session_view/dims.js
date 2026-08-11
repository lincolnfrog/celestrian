/**
 * Window/map dim overlays: the "everything OUTSIDE the covered set is
 * dimmed" builders, shared by the lane body, the window brackets, and
 * the expanded-drag preview.
 */

import { el, pct } from './sv_util.js';
import { posMod } from '../math_utils.js';

/* Degenerate-span guard: a dim thinner than this is fp noise. */
const EPS_Q = 1e-9;

function addDim(o, cycleQ, fromQ, toQ, className) {
    const from = Math.max(0, fromQ);
    const to = Math.min(cycleQ, toQ);
    if (to - from <= EPS_Q) return;
    const d = el('div', className);
    d.style.left = pct(from, cycleQ);
    d.style.width = pct(to - from, cycleQ);
    o.appendChild(d);
}

/** Dim the COMPLEMENT of `segs` inside one span [baseQ, baseQ+spanQ),
 * clipped to [0, cycleQ). `className` lets callers brand the dims
 * (e.g. 'win-dim parent-map-dim' for the enclosing-map projection). */
export function dimComplementInto(o, cycleQ, segs, baseQ, spanQ,
                                  className = 'win-dim') {
    let prev = 0;
    for (const [s, e] of segs) {
        addDim(o, cycleQ, baseQ + prev, baseQ + s, className);
        prev = e;
    }
    addDim(o, cycleQ, baseQ + prev, baseQ + spanQ, className);
}

/**
 * Dim everything OUTSIDE the window, in EVERY repetition of the lane's
 * period across the cycle — the frame stays intrinsic (displayPeriodQ),
 * so the window reads as a subset of each tile, never as a reframe.
 */
export function buildWindowDims(o, win, lane, cycleQ) {
    const intrinsicQ = lane.intrinsicQ || 0;
    if (intrinsicQ <= 0) return;
    // Segment-general (phase 3): dim the COMPLEMENT of the map's
    // covered set. A single window is the one-segment case.
    const segs = win.segs || [[win.startQ, win.endQ]];
    const anchorQ = lane.takeStartQ || 0;
    if (lane.kind === 'clip') {
        // Clips render raw material in ONE place — the take tile; every
        // other tile is an audible echo of the window segment and must
        // not be dimmed as "outside the window" (ghosts show what
        // sounds, Q 2026-07-16). Use the RAW intrinsicQ (not rounded):
        // the provisional Q-definer's tile is buffer/selection, a
        // fractional number of Q, so rounding dropped its trailing dim.
        dimComplementInto(o, cycleQ, segs, anchorQ, intrinsicQ);
        return;
    }
    // Groups: every tile shows the composite (raw material) — dim the
    // uncovered regions per period tile, on the lane's grid.
    const P = Math.round(intrinsicQ);
    if (P <= 0) return;
    const first = posMod(anchorQ, P);
    for (let base = first - P; base < cycleQ; base += P) {
        dimComplementInto(o, cycleQ, segs, base, P);
    }
}
