/**
 * Dim overlays: everything OUTSIDE a covered set is dimmed — the lane
 * body's window dims, the bracket drag's, the region panel's, the
 * raw-frame drag preview's (map_core.js) — and the one "a span of the
 * frame, clipped to it" builder the other span layers share (addDim).
 */

import { el, pct } from './sv_util.js';
import { posMod } from '../math_utils.js';

/* A span thinner than this is fp noise. */
const EPS_Q = 1e-9;

/** Append a `className` div over [fromQ, toQ) of a `cycleQ` frame,
 * clipped to the frame. Returns it, or null when none of it shows. */
export function addDim(o, cycleQ, fromQ, toQ, className) {
    const from = Math.max(0, fromQ);
    const to = Math.min(cycleQ, toQ);
    if (to - from <= EPS_Q) return null;
    const d = el('div', className);
    d.style.left = pct(from, cycleQ);
    d.style.width = pct(to - from, cycleQ);
    o.appendChild(d);
    return d;
}

/** Dim the COMPLEMENT of `segs` inside one span [baseQ, baseQ+spanQ),
 * clipped to [0, cycleQ). `className` brands the dims (e.g. 'win-dim
 * parent-map-dim' for the enclosing-map projection). */
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
 * Dim everything OUTSIDE the window (`win.segs`, or the one span
 * [startQ, endQ)) in EVERY place the lane draws its raw material — the
 * frame stays intrinsic, so the window reads as a subset of each tile,
 * never as a reframe.
 */
export function buildWindowDims(o, win, lane, cycleQ) {
    const intrinsicQ = lane.intrinsicQ || 0;
    if (intrinsicQ <= 0) return;
    const segs = win.segs || [[win.startQ, win.endQ]];
    const anchorQ = lane.takeStartQ || 0;
    if (lane.kind === 'clip' || lane.isQDefiner) {
        // ONE raw tile — a clip's take tile (its other tiles are audible
        // echoes of the window: never dimmed), the definer's buffer (a
        // stack's too). The RAW intrinsicQ, unrounded: a definer's tile
        // is a fractional number of Q, and a rounded span would end its
        // trailing dim off the end bracket.
        dimComplementInto(o, cycleQ, segs, anchorQ, intrinsicQ);
        // A tile the frame's end clips draws its rest from the frame's
        // start: so do the dims over it.
        if (anchorQ + intrinsicQ > cycleQ + EPS_Q) {
            dimComplementInto(o, cycleQ, segs, anchorQ - cycleQ, intrinsicQ);
        }
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
