/**
 * EDGE PAN — the ONE autoscroll rule for raw-frame drags: the lane's
 * same-scale reveal (map_bands.js runRevealDrag) and every region-panel
 * drag pan their raw view under a hand held near a visible edge.
 *
 * DIRECTION-AWARE: a drag pans toward an edge only once the pointer is
 * OUTWARD of where it grabbed — by more than the slop — and inside that
 * edge's zone; the speed ramps with the distance past whichever comes
 * first, the zone's inner line or the grab point. (A handle resting near
 * a lane edge is grabbed inside the zone: a few px of inward travel must
 * never run the view outward.)
 */

/* The edge zone (px inside the visible edge) and the top pan speed at
 * the zone's outer edge (px of the view per second). */
export const PAN_EDGE_PX = 36;
export const PAN_MAX_PX_PER_S = 520;
/* Travel outward of the grab point before a pan may start (px): the
 * engage gate's slop — a hand that has not yet moved does not pan. */
export const PAN_GRAB_SLOP_PX = 4;
/* The slowest pan once the zone is entered (fraction of the top). */
const PAN_MIN_FRAC = 0.15;
/* A dropped frame must not become a pan leap (ms). */
const PAN_MAX_DT_MS = 64;

/**
 * The pure rule: where is the pointer relative to the visible
 * [left, right] and its grab x? → { dir: −1 | 0 | 1, f: speed in
 * [PAN_MIN_FRAC, 1] (0 when dir is 0) }.
 */
export function edgePanStep({ x, grabX, left, right,
                              zonePx = PAN_EDGE_PX, slopPx = PAN_GRAB_SLOP_PX }) {
    // Each edge's pan line: the zone's inner line, pulled out to the
    // grab point (less the slop) when the grab was already in the zone.
    const lineL = Math.min(left + zonePx, grabX - slopPx);
    const lineR = Math.max(right - zonePx, grabX + slopPx);
    let dir = 0;
    let d = 0;
    if (x < lineL) {
        dir = -1; d = lineL - x;
    } else if (x > lineR) {
        dir = 1; d = x - lineR;
    }
    if (!dir) return { dir: 0, f: 0 };
    return { dir, f: Math.min(1, Math.max(PAN_MIN_FRAC, d / zonePx)) };
}

/**
 * May a raw view {q0, spanQ} over a take of `totalQ` pan in `dir`? Not
 * past the take's start (dir −1) or end (dir +1).
 */
export const canPanView = (dir, q0, spanQ, totalQ) =>
    dir < 0 ? q0 > 1e-9 : q0 + spanQ < totalQ - 1e-9;

/**
 * Move a raw view's q0 by `dq`, clamped ONLY in the direction of travel.
 * The same-scale reveal anchors its view so the grabbed bound sits under
 * the hand, wherever that puts the view — past the take's end, before
 * its start. Such a view glides from where it is and stops at the take's
 * edge; clamped into [0, totalQ − spanQ] it would leap on its first pan
 * frame, and the bound — read through q0 — with it.
 */
export function panViewQ0(q0, dq, spanQ, totalQ) {
    return dq < 0
        ? Math.max(Math.min(0, q0), q0 + dq)
        : Math.min(Math.max(totalQ - spanQ, q0), q0 + dq);
}

/**
 * The rAF pan loop around edgePanStep.
 *
 *   const pan = makeEdgePanner({
 *     rect,    () → { left, right } the VISIBLE surface, in client px
 *     grabX,   the pointer's client x at the grab
 *     canPan,  (dir) → false at the take's end in that direction
 *     pxPerQ,  () → the surface's scale (px per raw Q)
 *     onPan,   (dq) → move the view by dq raw Q (signed), redraw,
 *              re-evaluate the drag under the still hand
 *   });
 *   pan.update(clientX)  per pointermove (after engage)
 *   pan.stop()           on release / cancel
 *   pan.active()         is it panning now? (tests only)
 *
 * `raf`, `caf` and `now` are injectable for tests.
 */
export function makeEdgePanner({ rect, grabX, canPan, pxPerQ, onPan,
                                 zonePx = PAN_EDGE_PX,
                                 maxPxPerS = PAN_MAX_PX_PER_S,
                                 slopPx = PAN_GRAB_SLOP_PX,
                                 raf = cb => requestAnimationFrame(cb),
                                 caf = id => cancelAnimationFrame(id),
                                 now = () => performance.now() }) {
    let dir = 0;
    let speed = 0;   // px/s
    let last = 0;
    let id = 0;
    const stop = () => {
        if (id) caf(id);
        id = 0;
        dir = 0;
    };
    const tick = t => {
        id = 0;
        if (!dir || !canPan(dir)) { stop(); return; }
        const dt = Math.min(PAN_MAX_DT_MS, t - last);
        last = t;
        const scale = pxPerQ();
        if (scale > 0 && dt > 0) onPan(dir * (speed * dt / 1000) / scale);
        id = raf(tick);
    };
    const update = clientX => {
        const r = rect();
        const s = edgePanStep({ x: clientX, grabX, left: r.left, right: r.right,
                                zonePx, slopPx });
        if (!s.dir || !canPan(s.dir)) { stop(); return; }
        speed = maxPxPerS * s.f;
        if (dir !== s.dir) {
            dir = s.dir;
            last = now();
            if (!id) id = raf(tick);
        }
    };
    return { update, stop, active: () => dir !== 0 };
}

/**
 * The panner of a raw VIEW over a `totalQ` take — the builder every
 * raw-frame drag uses: makeEdgePanner that pans while the view
 * (`view()` → {q0, spanQ}, read live) can still move that way.
 */
export function makeViewPanner({ view, totalQ, ...rest }) {
    return makeEdgePanner({
        canPan: dir => {
            const v = view();
            return canPanView(dir, v.q0, v.spanQ, totalQ);
        },
        ...rest,
    });
}
