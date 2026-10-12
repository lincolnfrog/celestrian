/**
 * THE REGION PANEL'S VIEW STATE AND NAVIGATION INPUT.
 *
 * Each lane's panel draws its take through its OWN view {q0, spanQ}
 * (the geometry and its rules: panel_view.js). The view lives HERE, per
 * lane id — never in the view model: the 50 ms poll must not undo a
 * zoom — remembered for the session and reset when the take's length
 * changes. First show = FIT REGION; after that only explicit input
 * zooms (the keys, the wheel, the label's terms, the navigator box's
 * edges), and commits only PAN (followRegion).
 *
 * A panel drag, or its commit still held, OWNS the view: every
 * navigation input waits for it (isOverlayFrozen on the strip) — but
 * for the drag's own edge pan (edge_pan.js), which goes through setView
 * like the rest.
 */

import { ctx } from './context.js';
import { isOverlayFrozen, beginGesture } from './gesture.js';
import { activeSelectedId } from './selection.js';
import { rawCursorQ } from './map_core.js';
import { clampView, fitRegion, fitTake, zoomAbout, panBy, centerOn,
         keepInView, regionBounds, qAt, wheelZoomFactor, wheelPanQ,
         boxEdgeView, keyZoomView, sameView } from './panel_view.js';

/* laneId → { totalQ, view, segsKey }. `segsKey` is the committed region
 * the view last kept in view. Kept for the session, a deleted lane's
 * too: an undo brings the lane back, and only explicit input may have
 * changed its zoom. */
const views = new Map();

/* The panel's painter (region_panel.js registers it): a view change
 * repaints at once, from the last patch's state. */
let paint = () => {};
export function setPanelPainter(fn) { paint = fn; }

/** Repaint `row`'s panel now (the dock's resize). */
export const repaintPanel = row => paint(row);

/** The row's view entry (null before its first show). */
export function entryOf(row) {
    const c = row._region && row._region.ctx;
    return (c ? views.get(c.lane.id) : null) || null;
}

/** The lane's view entry — created at FIT REGION on first show, and
 * again whenever the take's length changes (a new take). */
export function ensureView(lane) {
    const totalQ = lane.bandTotalQ;
    let e = views.get(lane.id);
    if (!e || Math.abs(e.totalQ - totalQ) > 1e-9) {
        e = { totalQ, view: fitRegion(lane.bandSegs, totalQ),
              segsKey: JSON.stringify(lane.bandSegs) };
        views.set(lane.id, e);
    }
    return e;
}

/** COMMITS ONLY PAN: when the committed region changed since the view
 * last saw it, pan (never zoom) to keep it in view — once no drag or
 * held commit owns the view. */
export function followRegion(row, lane, e) {
    const key = JSON.stringify(lane.bandSegs);
    if (e.segsKey === key || isOverlayFrozen(row._region.strip)) return;
    e.segsKey = key;
    const [a, b] = regionBounds(lane.bandSegs, e.totalQ);
    e.view = keepInView(e.view, a, b, e.totalQ);
}

/** Change the row's view (clamped) and repaint. The one writer every
 * navigation input goes through. */
export function setView(row, v) {
    const e = entryOf(row);
    if (!e) return;
    const next = clampView(v, e.totalQ);
    if (sameView(e.view, next)) return;
    e.view = next;
    paint(row);
}

/** Fit the row's panel to its loop region ('region') or the whole take
 * ('take'). */
export function fitPanel(row, kind) {
    const c = row._region.ctx;
    const e = entryOf(row);
    if (!c || !e || isOverlayFrozen(row._region.strip)) return;
    setView(row, kind === 'take' ? fitTake(e.totalQ)
                                 : fitRegion(c.lane.bandSegs, e.totalQ));
}

/** The SELECTED track's row while its panel is shown, else null. */
export function shownPanelRow() {
    const id = activeSelectedId();
    const row = id === null ? null : ctx.laneEls.get(id);
    const nav = row && row._region && row._region.nav;
    if (!nav || nav.style.display === 'none' || !entryOf(row)) return null;
    return row;
}

/** Z / ⇧Z: fit the SELECTED track's panel to its loop or the whole
 * take. False (the key falls through) when no panel is shown. */
export function fitSelectedPanel(kind) {
    const row = shownPanelRow();
    if (!row) return false;
    fitPanel(row, kind);
    return true;
}

/** +/−: with a panel shown, zoom IT one step (`dir` > 0 = in) about the
 * playhead's raw position in the take (keyZoomView). False — the keys
 * fall through to the main view's zoom — when no panel is shown; a view
 * that is owned consumes the key and holds still. */
export function zoomSelectedPanel(dir) {
    const row = shownPanelRow();
    if (!row) return false;
    const e = entryOf(row);
    if (!e || isOverlayFrozen(row._region.strip)) return true;
    const { lane, vm, aux } = row._region.ctx;
    const node = aux && aux.nodesById ? aux.nodesById.get(lane.id) : null;
    setView(row, keyZoomView(e.view, rawCursorQ(lane, vm, node), dir, e.totalQ));
    return true;
}

/** Wheel over the panel: Ctrl/⌘+wheel or a pinch zooms the PANEL about
 * the pointer; Shift+wheel or a horizontal swipe pans it; both stop
 * here, so the main view never zooms or scrolls under the panel. A plain
 * vertical wheel falls through (page scroll). */
export function onPanelWheel(row, ev) {
    const e = entryOf(row);
    if (!e) return;
    const strip = row._region.strip;
    const r = strip.getBoundingClientRect();
    const zoom = ev.ctrlKey || ev.metaKey;
    const panQ = zoom ? 0 : wheelPanQ(ev, e.view, r.width);
    if (!zoom && !panQ) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isOverlayFrozen(strip)) return;
    if (!zoom) {
        setView(row, panBy(e.view, panQ, e.totalQ));
        return;
    }
    // Zoom about the Q UNDER THE POINTER: on the detail strip it reads
    // through the view; on the OVERVIEW through the whole take, when it
    // lies inside the view box. Anywhere else there is no point to hold
    // still: the view scales about its middle.
    const ov = row._region.overview;
    const or = ov.getBoundingClientRect();
    let anchor = e.view.q0 + e.view.spanQ / 2;
    if (or.width > 0 && ov.contains(ev.target)) {
        const q = Math.max(0, Math.min(1, (ev.clientX - or.left) / or.width)) * e.totalQ;
        if (q >= e.view.q0 && q <= e.view.q0 + e.view.spanQ) anchor = q;
    } else if (r.width > 0 && ev.clientX >= r.left && ev.clientX <= r.right) {
        anchor = qAt(ev.clientX - r.left, e.view, r.width);
    }
    setView(row, zoomAbout(e.view, anchor,
        wheelZoomFactor(ev.deltaY, ev.deltaMode), e.totalQ));
}

/** The navigator's pointer verbs: drag the view box = pan, drag its
 * edge = set the span, press elsewhere = centre the view there and keep
 * dragging to pan; double-click = the whole take. One gesture
 * (gesture.js): Escape / a lost capture restores the view the press
 * began on. */
export function wireOverview(row) {
    const ov = row._region.overview;
    ov.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        const e = entryOf(row);
        if (!e || isOverlayFrozen(row._region.strip)) return;
        const r = ov.getBoundingClientRect();
        if (!(r.width > 0)) return;
        const qPerPx = e.totalQ / r.width;
        const edgeEl = ev.target.closest('.region-viewbox-edge');
        const edge = edgeEl
            ? (edgeEl.classList.contains('start') ? 'start' : 'end') : null;
        const inBox = !!ev.target.closest('.region-viewbox');
        const vStart = e.view;
        let v0 = vStart;  // the view the drag moves from
        const g = beginGesture(ev, {
            node: ov,
            stop: true,
            onMove: mv => {
                const dq = (mv.clientX - ev.clientX) * qPerPx;
                setView(row, edge ? boxEdgeView(v0, edge, dq, e.totalQ)
                                  : panBy(v0, dq, e.totalQ));
            },
            onEnd: committed => { if (!committed) setView(row, vStart); },
        });
        if (!g.live()) return;
        if (!inBox) {
            setView(row, centerOn(e.view, (ev.clientX - r.left) * qPerPx, e.totalQ));
            v0 = e.view;
        }
    });
    ov.addEventListener('dblclick', () => fitPanel(row, 'take'));
}
