/**
 * THE REGION PANEL'S VIEW (session_view/panel_view.js, loop-region
 * phase 1, 2026-09-23) — the pure geometry behind the zoomable panel.
 * What this pins:
 *   (a) FIT REGION is the default: the loop at ~55% of the strip,
 *       centred, clamped to the take; the whole take once that span
 *       would be ≥ 80% of it (or there is no loop);
 *   (b) every view is clamped to the take, span ≥ ¼Q (a shorter take
 *       shows whole);
 *   (c) zoom keeps the anchored Q under the pointer; pans clamp;
 *   (d) keepInView PANS ONLY — it never changes the span, moves the
 *       least it can, and leaves a view alone while the region is in
 *       it (a commit must not re-fit — the owner's "jump");
 *   (e) the grid is WHOLE Qs only (owner ruling 2026-09-23: no sub-Q
 *       grid), thinned by powers of two to stay ≥ 7 px apart;
 *   (f) the wheel and overview-box laws; x ↔ q round trips;
 *   (g) the panel draws every slice at ONE gain per take (peaksBoost).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clampView, fitRegion, fitTake, zoomAbout, panBy, centerOn,
         keepInView, gridStep, gridLines, xOf, qAt, wheelZoomFactor,
         wheelPanQ, boxDragView, boxEdgeView, regionBounds, sameView,
         PANEL_MIN_SPAN_Q, FIT_REGION_FRAC, BOX_ZOOM_DEAD_PX }
    from '../session_view/panel_view.js';
import { peaksBoost } from '../canvas_renderer.js';

const near = (a, b, eps = 1e-9) =>
    assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('fit region: the loop fills ~55% of the strip, centred on it', () => {
    // The field case: a 5Q loop at [40, 45) of a 56Q take.
    const v = fitRegion([[40, 45]], 56);
    near(v.spanQ, 5 / FIT_REGION_FRAC);
    near(v.q0 + v.spanQ / 2, 42.5);
    near((45 - 40) / v.spanQ, 0.55);
    // A multi-segment map fits its OUTER bounds (cuts inside).
    const m = fitRegion([[40, 42], [43, 45]], 56);
    assert.ok(sameView(m, v));
});

test('fit region: clamped to the take near its ends (the loop stays whole)', () => {
    const v = fitRegion([[0, 3]], 40);
    near(v.q0, 0);
    near(v.spanQ, 3 / FIT_REGION_FRAC);
    const w = fitRegion([[37, 40]], 40);
    near(w.q0 + w.spanQ, 40);
});

test('fit region gives way to the whole take at ≥ 80% (or no loop)', () => {
    // 2Q of 3Q: 2/0.55 = 3.6Q ≥ 2.4Q → the whole take.
    assert.deepEqual(fitRegion([[0, 2]], 3), { q0: 0, spanQ: 3 });
    // A loop that is most of the take.
    assert.deepEqual(fitRegion([[1, 9]], 12), { q0: 0, spanQ: 12 });
    // Whole-take lanes (null segs) and an empty list.
    assert.deepEqual(fitRegion(null, 12), { q0: 0, spanQ: 12 });
    assert.deepEqual(fitRegion([], 12), { q0: 0, spanQ: 12 });
    assert.deepEqual(fitTake(56), { q0: 0, spanQ: 56 });
    // 1Q of 3Q: 1.82Q < 2.4Q → fits the loop.
    const v = fitRegion([[1, 2]], 3);
    assert.ok(v.spanQ < 3);
});

test('clampView: span within [¼Q, totalQ], q0 within the take', () => {
    assert.deepEqual(clampView({ q0: -5, spanQ: 4 }, 12), { q0: 0, spanQ: 4 });
    assert.deepEqual(clampView({ q0: 11, spanQ: 4 }, 12), { q0: 8, spanQ: 4 });
    assert.deepEqual(clampView({ q0: 3, spanQ: 0.01 }, 12),
                     { q0: 3, spanQ: PANEL_MIN_SPAN_Q });
    assert.deepEqual(clampView({ q0: 3, spanQ: 99 }, 12), { q0: 0, spanQ: 12 });
    // A take shorter than the minimum span shows whole.
    assert.deepEqual(clampView({ q0: 0, spanQ: 0.1 }, 0.2), { q0: 0, spanQ: 0.2 });
    assert.deepEqual(clampView({ q0: NaN, spanQ: NaN }, 8), { q0: 0, spanQ: 8 });
});

test('zoomAbout keeps the anchored Q at its place on the strip', () => {
    const v = { q0: 38, spanQ: 9 };
    const anchor = 41;                       // a third of the way in
    const f0 = (anchor - v.q0) / v.spanQ;
    const z = zoomAbout(v, anchor, 0.5, 56);
    near(z.spanQ, 4.5);
    near((anchor - z.q0) / z.spanQ, f0);
    // Zooming out at the take's start clamps q0 (the anchor then
    // drifts — the take has no material left of 0 to show).
    const out = zoomAbout({ q0: 0.5, spanQ: 4 }, 1, 4, 56);
    near(out.q0, 0);
    near(out.spanQ, 16);
    // The span is bounded both ways.
    near(zoomAbout(v, anchor, 1e-6, 56).spanQ, PANEL_MIN_SPAN_Q);
    near(zoomAbout(v, anchor, 1e6, 56).spanQ, 56);
});

test('panBy / centerOn hold the span and clamp at the take ends', () => {
    const v = { q0: 10, spanQ: 4 };
    assert.deepEqual(panBy(v, 2.5, 56), { q0: 12.5, spanQ: 4 });
    assert.deepEqual(panBy(v, -99, 56), { q0: 0, spanQ: 4 });
    assert.deepEqual(panBy(v, 99, 56), { q0: 52, spanQ: 4 });
    assert.deepEqual(centerOn(v, 30, 56), { q0: 28, spanQ: 4 });
    assert.deepEqual(centerOn(v, 55.5, 56), { q0: 52, spanQ: 4 });
});

test('keepInView pans only, and only as far as it must', () => {
    const v = { q0: 38, spanQ: 10 };        // margin 0.8Q → inner [38.8, 47.2]
    // In view: the very same object back (callers compare identity).
    assert.equal(keepInView(v, 40, 45, 56), v);
    // A nudge past the right edge: the region's end lands at the margin.
    const r = keepInView(v, 43, 48, 56);
    near(r.spanQ, 10);
    near(r.q0 + r.spanQ - 0.8, 48);
    // Past the left edge: its start lands at the margin.
    const l = keepInView(v, 35, 40, 56);
    near(l.q0 + 0.8, 35);
    near(l.spanQ, 10);
    // Clamped at the take.
    assert.deepEqual(keepInView({ q0: 10, spanQ: 10 }, 0, 2, 56), { q0: 0, spanQ: 10 });
    // Never zooms, even for a region wider than the view: while any of
    // it is visible (the user zoomed in on part of it) nothing moves…
    const deep = { q0: 41, spanQ: 1 };
    assert.equal(keepInView(deep, 40, 45, 56), deep);
    // …and a region wholly off-view brings its NEAREST edge in.
    const off = keepInView({ q0: 20, spanQ: 1 }, 40, 45, 56);
    near(off.spanQ, 1);
    near(off.q0 + 0.08, 40);
    const offL = keepInView({ q0: 50, spanQ: 1 }, 40, 45, 56);
    near(offL.q0 + 1 - 0.08, 45);
});

test('the grid is whole Qs, thinned by powers of two to ≥ 7 px', () => {
    assert.equal(gridStep(75), 1);    // fit region: 75 px/Q
    assert.equal(gridStep(7), 1);
    assert.equal(gridStep(6.9), 2);
    assert.equal(gridStep(3), 4);
    assert.equal(gridStep(0.5), 16);
    // Never below 1Q, however deep the zoom (no sub-Q grid).
    assert.equal(gridStep(4000), 1);
    assert.equal(gridStep(0), 1);
    // Lines: every visible whole multiple of the step; the take's own
    // edges are the strip's edges (no line); majors every 4Q.
    const lines = gridLines({ q0: 37.9, spanQ: 9.1 }, 1, 56);
    assert.deepEqual(lines.map(l => l.q), [38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
    assert.deepEqual(lines.filter(l => l.major).map(l => l.q), [40, 44]);
    assert.deepEqual(gridLines({ q0: 0, spanQ: 12 }, 4, 12).map(l => l.q), [4, 8]);
    assert.ok(gridLines({ q0: 0, spanQ: 56 }, 2, 56).every(l => l.q % 2 === 0));
    // A deep view between two whole Qs has no line at all.
    assert.deepEqual(gridLines({ q0: 41.2, spanQ: 0.5 }, 1, 56), []);
});

test('x ↔ q round trip through the view', () => {
    const v = { q0: 37.95, spanQ: 9.1 };
    const w = 1104;
    for (const q of [37.95, 40, 42.5, 47.05]) near(qAt(xOf(q, v, w), v, w), q, 1e-9);
    near(xOf(v.q0, v, w), 0);
    near(xOf(v.q0 + v.spanQ, v, w), w);
});

test('wheel: ctrl/pinch zooms (down = out); shift or a sideways swipe pans', () => {
    // A mouse notch (±100 px) is a moderate step; a pinch delta a fine one.
    const notchOut = wheelZoomFactor(100);
    assert.ok(notchOut > 1.2 && notchOut < 1.35);
    near(wheelZoomFactor(-100) * notchOut, 1, 1e-12);
    const pinch = wheelZoomFactor(-3);
    assert.ok(pinch < 1 && pinch > 0.9);
    // Line-mode deltas are converted to px.
    near(wheelZoomFactor(3, 1), wheelZoomFactor(48));
    // MONOTONIC and continuous in the delta (review 2026-09-23: the old
    // two-constant switch zoomed LESS at deltaY 20 than at 19.9).
    let prev = 1;
    for (let d = 0.5; d <= 400; d += 0.5) {
        const f = wheelZoomFactor(d);
        assert.ok(f > prev, `zoom-out factor grows with the delta (d=${d})`);
        assert.ok(f / prev < 1.01, `no jump at d=${d}`);
        near(wheelZoomFactor(-d) * f, 1, 1e-12);   // in and out are inverses
        prev = f;
    }
    const v = { q0: 10, spanQ: 4 };
    // Plain vertical wheel: not a pan (the page scrolls).
    assert.equal(wheelPanQ({ deltaX: 0, deltaY: 100, shiftKey: false }, v, 800), 0);
    // Shift+wheel: 100 px over an 800 px strip = ⅛ of the span.
    near(wheelPanQ({ deltaX: 0, deltaY: 100, shiftKey: true }, v, 800), 0.5);
    // A horizontal swipe pans by its deltaX.
    near(wheelPanQ({ deltaX: -200, deltaY: 10, shiftKey: false }, v, 800), -1);
    // Shift+wheel delivered as deltaX (macOS) still pans.
    near(wheelPanQ({ deltaX: 100, deltaY: 0, shiftKey: true }, v, 800), 0.5);
});

test('overview box: sideways pans, vertical zooms (down = in) past a dead zone', () => {
    const v0 = { q0: 20, spanQ: 8 };
    // Pure pan (a wobbly hand inside the dead zone does not zoom).
    const p = boxDragView(v0, 3, BOX_ZOOM_DEAD_PX, 56);
    assert.deepEqual(p, { q0: 23, spanQ: 8 });
    // Down = zoom in about the box's centre.
    const zin = boxDragView(v0, 0, 60, 56);
    assert.ok(zin.spanQ < 8);
    near(zin.q0 + zin.spanQ / 2, 24);
    const zout = boxDragView(v0, 0, -60, 56);
    assert.ok(zout.spanQ > 8);
    near(zout.q0 + zout.spanQ / 2, 24);
    // Clamped at the take.
    assert.deepEqual(boxDragView(v0, -99, 0, 56), { q0: 0, spanQ: 8 });
});

test('overview box edges set the span; the other edge holds', () => {
    const v0 = { q0: 20, spanQ: 8 };
    assert.deepEqual(boxEdgeView(v0, 'end', 4, 56), { q0: 20, spanQ: 12 });
    assert.deepEqual(boxEdgeView(v0, 'start', -4, 56), { q0: 16, spanQ: 12 });
    // An edge cannot cross its partner (minimum span) nor leave the take.
    const s = boxEdgeView(v0, 'start', 99, 56);
    near(s.q0 + s.spanQ, 28);
    near(s.spanQ, PANEL_MIN_SPAN_Q);
    assert.deepEqual(boxEdgeView(v0, 'end', 99, 56), { q0: 20, spanQ: 36 });
    assert.deepEqual(boxEdgeView(v0, 'start', -99, 56), { q0: 0, spanQ: 28 });
});

test('regionBounds: the outer kept bounds (null = the whole take)', () => {
    assert.deepEqual(regionBounds([[2, 3], [5, 9]], 12), [2, 9]);
    assert.deepEqual(regionBounds(null, 12), [0, 12]);
});

test('peaksBoost: ONE gain per take, whatever slice is drawn', () => {
    const peaks = [0.1, 0.2, 0.5, 0.25, 0.05];
    const b = peaksBoost(peaks);
    near(b, 0.95 / 0.5);
    // Cached per array identity (a second call is the same number).
    assert.equal(peaksBoost(peaks), b);
    // The quiet slice would auto-normalize louder on its own — the
    // panel passes the take's boost instead (a zoom never "breathes").
    assert.notEqual(peaksBoost(peaks.slice(0, 2)), b);
    // String peaks (JSON) and the silence/empty guards.
    near(peaksBoost(['0.5', '0.1']), 1.9);
    assert.equal(peaksBoost([0, 0]), 1);
    assert.equal(peaksBoost([]), 1);
    assert.equal(peaksBoost(null), 1);
    // The boost cap keeps near-silence flat.
    assert.equal(peaksBoost([0.001]), 8);
});
