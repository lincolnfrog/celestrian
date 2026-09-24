/**
 * THE REGION PANEL'S VIEW (loop-region phase 1, owner-ruled
 * 2026-09-23) — pure geometry, no DOM.
 *
 * The panel draws raw-take coordinates through its OWN per-lane view
 * `{ q0, spanQ }`: the raw Q at the detail strip's left edge and the raw
 * Qs across it. It is not the main view's zoom (a 5Q frame at lane
 * scale cannot show a 56Q take) and it is not in the view model (the
 * 50 ms poll must never undo a zoom). Until 2026-09-23 the panel was
 * hard-wired to `{ 0, totalQ }` — a 56Q take got 12 px/Q, a ⌥ ⅛Q nudge
 * moved 1.5 px, and a small loop's box was all bracket (diagnosis
 * N1/N4).
 *
 * The rules that live here, so region_panel.js only wires them:
 *   - DEFAULT = FIT REGION: the loop fills ~55% of the strip, centred,
 *     clamped to the take; the whole take when that span would be most
 *     of it anyway (≥ 80%) — a near-fit is not worth a hidden edge.
 *   - After that, ZOOM CHANGES ONLY ON EXPLICIT INPUT (wheel, pinch,
 *     Z / ⇧Z, the label terms, the overview box). Commits and nudges
 *     only PAN, and only as far as it takes to keep the region in view
 *     (keepInView) — an auto re-fit after a commit rescales the box
 *     right after release, the "jump" the owner already dislikes.
 *   - The grid is WHOLE Qs only (owner ruling 2026-09-23: a sub-Q grid
 *     is arbitrary relative to the music — a 3/4 loop has no quarters
 *     of a Q; a meter setting may come later, unsure). gridStep only
 *     thins the whole-Q lines when zoomed out.
 */

/* The deepest zoom: a quarter of a Q across the strip. */
export const PANEL_MIN_SPAN_Q = 0.25;
/* Fit region: the loop's share of the strip, and the share of the
 * take at which fitting the loop gives way to fitting the take. */
export const FIT_REGION_FRAC = 0.55;
export const FIT_TAKE_SNAP = 0.8;
/* keepInView's margin, as a fraction of the visible span. */
export const KEEP_IN_VIEW_MARGIN = 0.08;
/* Whole-Q gridlines thin (1, 2, 4, 8 … Q) to stay this far apart. */
export const GRID_MIN_PX = 7;
/* Whole-Q numbers appear on the detail strip from this scale up. */
export const Q_LABEL_MIN_PX_PER_Q = 40;
/* Wheel zoom: ONE continuous, monotonic curve (review 2026-09-23 — a
 * switch between two constants at |deltaY| = 20 made a slightly faster
 * pinch zoom up to 5× LESS). A pinch-sized delta zooms by
 * WHEEL_ZOOM_K_PINCH per px (tracking the fingers); larger deltas
 * saturate toward WHEEL_ZOOM_MAX_STEP, so a mouse notch (≈ 100 px)
 * scales the span by ≈ e^0.25 ≈ 1.28. Line-mode deltas are converted
 * at WHEEL_LINE_PX per line. */
const WHEEL_ZOOM_K_PINCH = 0.012;
const WHEEL_ZOOM_MAX_STEP = 0.25;
const WHEEL_LINE_PX = 16;
/* The overview box's vertical drag: px of travel per e-fold of span
 * (drag down = zoom in, Ableton's clip-view selector), after a dead
 * zone so a sideways pan with a wobbly hand does not also zoom. */
export const BOX_ZOOM_PX_PER_E = 80;
export const BOX_ZOOM_DEAD_PX = 4;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Clamp a view to the take: span within [minSpan, totalQ] (a take
 * shorter than minSpan shows whole), q0 within [0, totalQ − span]. */
export function clampView(v, totalQ, minSpan = PANEL_MIN_SPAN_Q) {
    if (!(totalQ > 0)) return { q0: 0, spanQ: 0 };
    const lo = Math.min(minSpan, totalQ);
    const spanQ = clamp(Number.isFinite(v.spanQ) ? v.spanQ : totalQ, lo, totalQ);
    const q0 = clamp(Number.isFinite(v.q0) ? v.q0 : 0, 0, totalQ - spanQ);
    return { q0, spanQ };
}

/** The whole take. */
export const fitTake = totalQ => clampView({ q0: 0, spanQ: totalQ }, totalQ);

/** The kept region's outer bounds [a, b) (null segs = the whole take). */
export function regionBounds(segs, totalQ) {
    if (!segs || !segs.length) return [0, totalQ];
    return [segs[0][0], segs[segs.length - 1][1]];
}

/** FIT REGION: the loop at `frac` of the strip, centred, clamped to
 * the take — or the whole take when that span would be ≥ `takeSnap`
 * of it (or there is no loop). */
export function fitRegion(segs, totalQ,
                          { frac = FIT_REGION_FRAC, takeSnap = FIT_TAKE_SNAP } = {}) {
    const [a, b] = regionBounds(segs, totalQ);
    const len = b - a;
    if (!(len > 0) || !(totalQ > 0)) return fitTake(totalQ);
    const spanQ = len / frac;
    if (spanQ >= takeSnap * totalQ) return fitTake(totalQ);
    return clampView({ q0: (a + b) / 2 - spanQ / 2, spanQ }, totalQ);
}

/** Zoom by `factor` (> 1 = out) about raw Q `qAnchor`, which keeps its
 * place on the strip (the Q under the pointer stays under it). */
export function zoomAbout(v, qAnchor, factor, totalQ, minSpan = PANEL_MIN_SPAN_Q) {
    const f = v.spanQ > 0 ? (qAnchor - v.q0) / v.spanQ : 0.5;
    const spanQ = clamp(v.spanQ * factor, Math.min(minSpan, totalQ), totalQ);
    return clampView({ q0: qAnchor - f * spanQ, spanQ }, totalQ, minSpan);
}

/** Pan by `dq` raw Q (clamped at the take's ends). */
export const panBy = (v, dq, totalQ) =>
    clampView({ q0: v.q0 + dq, spanQ: v.spanQ }, totalQ);

/** Centre the view on raw Q `q`, span held. */
export const centerOn = (v, q, totalQ) =>
    clampView({ q0: q - v.spanQ / 2, spanQ: v.spanQ }, totalQ);

/** KEEP [a, b) IN VIEW — PANS ONLY, never zooms. A region that fits
 * inside the view's inner band (margin on both sides) is brought in by
 * the smallest pan; a region wider than that band is left alone while
 * any of it is visible (the user zoomed in on part of it) and otherwise
 * has its nearest edge brought to the margin. Returns `v` itself when
 * nothing moves (callers compare identity). */
export function keepInView(v, a, b, totalQ, margin = KEEP_IN_VIEW_MARGIN) {
    const m = v.spanQ * margin;
    const lo = v.q0 + m;
    const hi = v.q0 + v.spanQ - m;
    let q0 = v.q0;
    if (b - a <= hi - lo) {
        if (a < lo) q0 = a - m;
        else if (b > hi) q0 = b + m - v.spanQ;
    } else if (b <= v.q0) {
        q0 = b + m - v.spanQ;       // all of it left of the view
    } else if (a >= v.q0 + v.spanQ) {
        q0 = a - m;                 // all of it right of the view
    }
    if (q0 === v.q0) return v;
    const next = clampView({ q0, spanQ: v.spanQ }, totalQ);
    return Math.abs(next.q0 - v.q0) < 1e-9 ? v : next;
}

/** The whole-Q gridline step for `pxPerQ`: the smallest of 1, 2, 4,
 * 8 … Q whose lines sit at least `minPx` apart. Never below 1Q (no
 * sub-Q grid — owner ruling 2026-09-23). */
export function gridStep(pxPerQ, minPx = GRID_MIN_PX) {
    if (!(pxPerQ > 0)) return 1;
    let step = 1;
    while (step * pxPerQ < minPx && step < 1 << 20) step *= 2;
    return step;
}

/** The whole-Q gridlines inside the view: [{ q, major }] at `step`
 * (major = a multiple of 4Q, the ruler's bar grammar). The take's own
 * edges (0, totalQ) are the strip's edges — no line. */
export function gridLines(v, step, totalQ) {
    const out = [];
    const end = v.q0 + v.spanQ;
    for (let q = Math.ceil(v.q0 / step - 1e-9) * step; q <= end + 1e-9; q += step) {
        if (q <= 1e-9 || q >= totalQ - 1e-9) continue;
        out.push({ q, major: q % 4 === 0 });
    }
    return out;
}

/** Raw Q → px from the strip's left edge (`w` = strip width). */
export const xOf = (q, v, w) => ((q - v.q0) / v.spanQ) * w;
/** Px from the strip's left edge → raw Q (unclamped). */
export const qAt = (x, v, w) => v.q0 + (x / w) * v.spanQ;

/** The span factor for one wheel event (ctrl/⌘+wheel or pinch):
 * > 1 zooms out (wheel down), < 1 in. */
export function wheelZoomFactor(deltaY, deltaMode = 0) {
    const d = deltaMode === 1 ? deltaY * WHEEL_LINE_PX : deltaY;
    const step = WHEEL_ZOOM_MAX_STEP *
        (1 - Math.exp(-Math.abs(d) * WHEEL_ZOOM_K_PINCH / WHEEL_ZOOM_MAX_STEP));
    return Math.exp(Math.sign(d) * step);
}

/** A wheel event's pan in raw Q, or 0 when it is not a pan (a plain
 * vertical wheel scrolls the page). Shift+wheel or a mostly-horizontal
 * swipe pans; `w` = strip width in px. */
export function wheelPanQ(e, v, w) {
    const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (!e.shiftKey && !horiz) return 0;
    let d = horiz ? e.deltaX : e.deltaY;
    // Shift+wheel on some platforms arrives as deltaX already.
    if (e.shiftKey && !d) d = e.deltaX;
    if (e.deltaMode === 1) d *= WHEEL_LINE_PX;
    return w > 0 ? (d / w) * v.spanQ : 0;
}

/** THE OVERVIEW BOX, dragged from `v0`: horizontal travel pans (`dxQ`,
 * already in raw Q at the overview's scale), vertical travel past the
 * dead zone zooms about the box's centre (down = in). */
export function boxDragView(v0, dxQ, dyPx, totalQ, minSpan = PANEL_MIN_SPAN_Q) {
    const c = v0.q0 + v0.spanQ / 2 + dxQ;
    const dy = Math.sign(dyPx) * Math.max(0, Math.abs(dyPx) - BOX_ZOOM_DEAD_PX);
    const spanQ = clamp(v0.spanQ * Math.exp(-dy / BOX_ZOOM_PX_PER_E),
        Math.min(minSpan, totalQ), totalQ);
    return clampView({ q0: c - spanQ / 2, spanQ }, totalQ, minSpan);
}

/** An overview box EDGE dragged by `dq` raw Q from `v0`: that edge
 * moves, the other stays (the span follows, ≥ minSpan). */
export function boxEdgeView(v0, edge, dq, totalQ, minSpan = PANEL_MIN_SPAN_Q) {
    const lo = Math.min(minSpan, totalQ);
    const a0 = v0.q0;
    const b0 = v0.q0 + v0.spanQ;
    if (edge === 'start') {
        const a = clamp(a0 + dq, 0, b0 - lo);
        return clampView({ q0: a, spanQ: b0 - a }, totalQ, minSpan);
    }
    const b = clamp(b0 + dq, a0 + lo, totalQ);
    return clampView({ q0: a0, spanQ: b - a0 }, totalQ, minSpan);
}

/** Two views equal to fp noise (repaint keys, test assertions). */
export const sameView = (a, b) => !!a && !!b &&
    Math.abs(a.q0 - b.q0) < 1e-9 && Math.abs(a.spanQ - b.spanQ) < 1e-9;
