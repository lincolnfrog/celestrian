/**
 * THE REGION PANEL (owner-ruled 2026-09-11; ZOOMABLE since loop-region
 * phase 1, 2026-09-23) — the loop region's overview + editor, shown
 * under the SELECTED lane.
 *
 * A heard-view lane shows only what sounds; the whole raw take and the
 * map's structure need a home that never rescales the lane. The panel
 * is that home: a full-row, viewport-pinned panel under the selected
 * clip/group with
 *   - an OVERVIEW strip: the whole raw take (fixed gain), the kept
 *     region tinted, the cuts notched, the amber cursor, and the
 *     detail view as an outlined box — drag the box = pan (vertically
 *     = zoom, Ableton's clip-view selector), drag its edges = set the
 *     span, click elsewhere = centre there, double-click = the whole
 *     take;
 *   - a zoomable DETAIL strip: the raw take (waveform, or a MIDI
 *     clip's piano roll over its velocity lane) through the panel's
 *     own view {q0, spanQ} (panel_view.js), the excluded material
 *     dimmed, the kept region as a bright box with bracket handles,
 *     every inner cut as a band, whole-Q gridlines (numbered when
 *     there is room), and the amber sound cursor in raw coordinates.
 * It appears when the track is selected — the affordance IS the
 * selection — and goes away with it (Escape, a click on empty canvas,
 * or a click on the top bar's empty space).
 *
 * THE VIEW (panel_view.js): per lane, in THIS module's state (never
 * the view model — the 50 ms poll must not undo a zoom), remembered
 * for the session, reset when the take's length changes. First show =
 * FIT REGION. After that only explicit input zooms: Ctrl/⌘+wheel or a
 * pinch over the panel (about the pointer — the MAIN view no longer
 * zooms under the panel, diagnosis N2), Z / ⇧Z (init.js), the label's
 * "loop NQ" / "NQ take" terms, the overview box. Shift+wheel or a
 * horizontal swipe pans; a plain wheel scrolls the page. Commits and
 * nudges only PAN (keepInView). v1: the view holds still while a
 * panel drag is live or its commit is held — except the drag's own
 * edge pan (edge_pan.js).
 *
 * Gestures (one law with the lane, map_core.js):
 *   - drag a bracket        TRIM (period snaps to whole Qs; ⌥ = slide)
 *   - drag the kept box     SLIDE the whole region by whole Qs
 *                           (⌥ = any amount), length held
 *   - drag a cut's chip     slide the cut; its handles resize it;
 *                           right-click / double-click heals
 *   - double-click material a 1Q cell cut there (the take's own grid)
 *   - drag the ↺ by its tab THE START MARKER (loop_selection.md §9.3,
 *                           Ableton's): the top moves onto another hit
 *                           and the audio shifts so the ↺ keeps its
 *                           moment — a re-time (setTiming with a top);
 *                           whole Q, ⌥ fine, kept material only (a plain
 *                           loop keeps its whole take). Its line never
 *                           takes a press (it sits in the box). Not over
 *                           a bypassed map: a top must lie in its stored
 *                           region, and that is not what plays.
 *   - "Timing as played"    puts every re-time back (setTiming −retime) —
 *                           shown wherever the take is shifted, ↺ or not
 *   - a drag near the strip's edge pans the view under the hand
 * The strip is a raw-framed band host through the view (cycleQ =
 * spanQ, anchored at −q0), so the cut bands and dblclick creation are
 * the lane's own code. Live commits stream while dragging; the lane
 * above renders the audible result as it changes — overview and
 * detail, both live.
 *
 * Positioning: the panel row spans the whole lane row (under the rail
 * too); the panel is pinned to the VIEWPORT by JS (patch + scroll) at a
 * constant width, independent of the main zoom and scroll (N3).
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setText, setTitle, setStyle, snapThenAnimate } from './sv_util.js';
import { isOverlayFrozen, isDragging, beginGesture, afterSettled } from './gesture.js';
import { selectOnly, activeSelectedId } from './selection.js';
import { drawWaveform, drawEnvelope, drawMidiTile, MIDI_VELOCITY_LANE, peaksBoost }
    from '../canvas_renderer.js';
import { sliceNotesToTile } from '../midi_notes.js';
import { dimComplementInto } from './dims.js';
import { innerCuts, slideSegs } from '../map_edit.js';
import { heardOffsetOf } from '../time_map.js';
import { bandState, coveredSegs, laneMapActive, rawCursorQ, commitBandSegs,
         commitTiming, newGesture, runRawDrag, trimMoveFn, slideMoveFn, viewPct,
         timingText, fmtSignedQ, fmtFineQ, LOCKED_TITLE,
         COMMIT_HOLD_MAX_MS } from './map_core.js';
import { previewer, wantsTopHandle, wantsLaneTop, isPlainLoop } from './splice_handles.js';
import { wireBandCreate, appendCutBands, revealColumns } from './map_bands.js';
import { pinFrame, unpinFrame } from './drag_pin.js';
import { makeEdgePanner, canPanView } from './edge_pan.js';
import { clampView, fitRegion, fitTake, zoomAbout, panBy, centerOn,
         keepInView, regionBounds, gridStep, gridLines, qAt, xOf,
         wheelZoomFactor, wheelPanQ, boxDragView, boxEdgeView, sameView,
         Q_LABEL_MIN_PX_PER_Q } from './panel_view.js';

/* The panel's inset from the viewport's edges when #session has no
 * padding to read (px). Normally the inset IS #session's horizontal
 * padding, so at zoom 1 the panel lines up with the lanes above. */
const PANEL_MARGIN_PX = 12;
/* Waveform vertical inset inside the strips (px). */
const STRIP_V_INSET_PX = 4;
/* Arrow-key nudges within this window chain off the last target sent
 * (the poll that would refresh the band state may not have run) — and
 * share ONE frame pin (the nudge chain is one gesture). */
export const NUDGE_CHAIN_MS = 800;
/* A kept box narrower than three bracket hit zones (26 px each) gets
 * its brackets OUTSIDE it (N4): the box's whole width stays a slide. */
const NARROW_BOX_PX = 78;
/* A whole-Q number needs this much strip right of its line (px). */
const Q_LABEL_EDGE_PX = 16;
/* The cursor glides with the lane cursors' transition; a backward jump
 * larger than this fraction of the strip is a wrap — snap. */
const CURSOR_WRAP_FRAC = 0.02;
/* The ↺ tab anchors inward within this many px of the strip's edges
 * (the strip clips its overflow). */
const TOP_TAB_EDGE_PX = 20;
/* The start-marker drag's badge keeps this far inside the strip (px). */
const BADGE_INSET_PX = 4;
const TOP_TITLE = '↺ The loop\'s top — Ableton\'s start marker: drag it onto ' +
    'the hit that should land on the one, and the audio shifts so it does ' +
    '(a re-time). Whole Q; ⌥ = fine.';

/* The per-lane panel views: laneId → { totalQ, view, segsKey }.
 * `segsKey` is the committed region the view last kept in view. */
const views = new Map();

/** Build the panel row once per lane (lane_build). Hidden until the
 * lane is selected and has a take to show. */
export function buildRegionPanel(row) {
    const nav = el('div', 'lane-region');
    nav.style.display = 'none';
    const panel = el('div', 'region-panel');
    // A press in the panel must never fall through to the lane below.
    panel.addEventListener('pointerdown', e => e.stopPropagation());
    // The label's two terms are the two zoom stops.
    const label = el('div', 'region-label mono');
    const termLoop = el('span', 'region-term loop',
        { title: 'Fit the loop region in the panel (Z)' });
    const termTake = el('span', 'region-term take',
        { title: 'Show the whole take in the panel (⇧Z)' });
    const termCuts = el('span', 'region-term-cuts');
    // THE TIMING (loop_selection.md §9.2): how far a re-time has moved
    // the take from where it was played, and the way back. Clips only
    // (a group is never re-timed); gated like the rest of the chrome.
    const timing = el('div', 'region-timing');
    const timingRead = el('span', 'region-timing-read');
    const timingReset = el('button', 'region-timing-reset', {
        type: 'button',
        textContent: 'Timing as played',
        title: 'Undo every shift: put the audio back where it was played ' +
            '(the ↺ and the audio move back together)' });
    timing.append(timingRead, timingReset);
    label.append(termLoop, document.createTextNode(' · '), termTake, termCuts,
                 timing);
    termLoop.addEventListener('click', () => fitPanel(row, 'region'));
    termTake.addEventListener('click', () => fitPanel(row, 'take'));
    timingReset.addEventListener('click', () => resetTiming(row));
    const col = el('div', 'region-col');
    // The OVERVIEW: the whole take, always.
    const overview = el('div', 'region-overview', {
        title: 'The whole take — drag the box to move the view (up/down ' +
            'zooms), its edges to set the span; click to jump there; ' +
            'double-click for the whole take' });
    overview.appendChild(document.createElement('canvas'));
    const ovMarks = el('div', 'region-ov-marks');
    const ovCursor = el('div', 'region-ov-cursor');
    // The ↺'s tick over the whole take (placed per paint, so it follows
    // a start-marker drag's preview).
    const ovTop = el('div', 'region-ov-top');
    ovTop.style.display = 'none';
    const viewbox = el('div', 'region-viewbox');
    viewbox.append(el('div', 'region-viewbox-edge start'),
                   el('div', 'region-viewbox-edge end'));
    overview.append(ovMarks, ovCursor, ovTop, viewbox);
    // The DETAIL strip: the take through the panel's view.
    const strip = el('div', 'region-strip');
    const grid = el('div', 'region-grid');
    const wave = el('div', 'region-wave');
    wave.appendChild(document.createElement('canvas'));
    const overlay = el('div', 'region-overlay overlay-layer');
    strip.append(grid, wave, overlay);
    col.append(overview, strip);
    panel.append(label, col);
    nav.appendChild(panel);
    row._regionPanel = panel;
    row._regionStrip = strip;
    row._regionOverlay = overlay;
    row._regionLabel = label;
    row._regionTerms = { loop: termLoop, take: termTake, cuts: termCuts };
    row._regionTiming = { block: timing, read: timingRead, reset: timingReset };
    row._regionOverview = overview;
    // Wheel over ANY part of the panel: zoom / pan the panel's view.
    panel.addEventListener('wheel', ev => onPanelWheel(row, ev), { passive: false });
    wireOverview(row);
    // TEST HOOK (the reveal's body._reveal.view twin): a copy of the
    // live view, read by the e2e specs.
    Object.defineProperty(strip, '_view', {
        get: () => { const e = entryOf(row); return e ? { ...e.view } : null; },
    });
    return nav;
}

/** Should this lane show the panel right now? The most recently
 * selected clip/group with a take of at least 2Q; not while the lane
 * is its own raw inspector (windowEditing), a Q-definer (its trim law
 * is different — it SETS Q), or a child shown through a parent's map
 * (the parent owns the edit). */
function wantPanel(row, lane) {
    if (lane.kind !== 'clip' && lane.kind !== 'group') return false;
    if (activeSelectedId() !== lane.id) return false;
    if (!(lane.bandTotalQ >= 2)) return false;
    if (lane.windowEditing || lane.isQDefiner) return false;
    if (lane.underMap || lane.definerMember) return false;
    if (lane.recording) return false;
    return true;
}

/** The lane the strip's band code edits: the same take, framed RAW
 * through the view — the strip's frame is the view's span, and the
 * take starts q0 before the strip's left edge. */
function stripLane(lane, view) {
    return {
        id: lane.id, kind: lane.kind,
        bandSegs: lane.bandSegs, bandTotalQ: lane.bandTotalQ,
        bandEditable: lane.bandEditable, bandHeard: false,
        bandPeriodQ: 0, takeStartQ: -view.q0,
        intrinsicQ: lane.bandTotalQ,
    };
}

/** The row's view entry (null before its first show). */
const entryOf = row => (row._regionCtx ? views.get(row._regionCtx.lane.id) : null) || null;

/** The lane's view entry — created at FIT REGION on first show, and
 * again whenever the take's length changes (a new take). */
function ensureView(lane) {
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
 * last saw it, pan (never zoom) to keep it in view. Not under a live
 * panel drag or its held commit — the gesture owns the view then; the
 * first patch after it settles catches up. */
function followRegion(row, lane, e) {
    const key = JSON.stringify(lane.bandSegs);
    if (e.segsKey === key || isOverlayFrozen(row._regionStrip)) return;
    e.segsKey = key;
    const [a, b] = regionBounds(lane.bandSegs, e.totalQ);
    e.view = keepInView(e.view, a, b, e.totalQ);
}

/** Patch one lane's panel per poll: visibility, viewport pinning, the
 * view's upkeep, then the paint. */
export function patchRegionPanel(row, lane, vm, aux, peaks) {
    const nav = row.querySelector(':scope > .lane-region');
    if (!nav) return;
    const want = wantPanel(row, lane);
    const strip = row._regionStrip;
    if (!want) {
        // Never hide under a live drag: the strip holds the capture.
        if (isDragging(strip)) return;
        if (nav.style.display !== 'none') nav.style.display = 'none';
        return;
    }
    if (nav.style.display !== '') nav.style.display = '';
    pinToViewport(row, nav);
    row._regionCtx = { lane, vm, aux, peaks };
    followRegion(row, lane, ensureView(lane));
    paintPanel(row);
}

/** Change the row's view (clamped) and repaint with the last patch's
 * state. The one writer every navigation input goes through. */
function setView(row, v) {
    const e = entryOf(row);
    if (!e) return;
    const next = clampView(v, e.totalQ);
    if (sameView(e.view, next)) return;
    e.view = next;
    paintPanel(row);
}

/** Fit the row's panel to its loop region ('region') or the whole take
 * ('take'). No-op while a panel drag or its commit holds the view. */
function fitPanel(row, kind) {
    const c = row._regionCtx;
    const e = entryOf(row);
    if (!c || !e || isOverlayFrozen(row._regionStrip)) return;
    setView(row, kind === 'take' ? fitTake(e.totalQ)
                                 : fitRegion(c.lane.bandSegs, e.totalQ));
}

/** Z / ⇧Z (init.js): fit the SELECTED track's panel to its loop or the
 * whole take. False (the key falls through) when no panel is shown. */
export function fitSelectedPanel(kind) {
    const id = activeSelectedId();
    const row = id === null ? null : ctx.laneEls.get(id);
    const nav = row && row.querySelector(':scope > .lane-region');
    if (!nav || nav.style.display === 'none' || !row._regionCtx) return false;
    fitPanel(row, kind);
    return true;
}

/** Paint the panel from the last patch's state through the current
 * view: label, both strips, gridlines, cursors, then the chrome
 * (keyed — a stable view and map mean zero DOM churn). */
function paintPanel(row) {
    const c = row._regionCtx;
    const e = entryOf(row);
    if (!c || !e) return;
    const { lane, vm, aux, peaks } = c;
    const v = e.view;
    const totalQ = e.totalQ;
    const strip = row._regionStrip;
    const sl = stripLane(lane, v);
    const st = bandState(sl, vm, v.spanQ);
    const segs = coveredSegs(st);
    const periodQ = segs.reduce((n, [a, b]) => n + (b - a), 0);
    const active = laneMapActive(lane);
    const bypassed = !!(lane.window && lane.window.bypassed);
    const withTop = panelOffersTop(lane);
    const cuts = !!(lane.mapMulti || innerCuts(st.segs, totalQ).length);
    // The label names the region: what is kept of what exists. Its
    // two terms double as the fit-region / fit-take buttons.
    const terms = row._regionTerms;
    setText(terms.loop, active ? 'loop ' + fmtQ(periodQ) + 'Q'
        : bypassed ? 'bypassed ' + fmtQ(periodQ) + 'Q' : 'whole take');
    setText(terms.take, fmtQ(totalQ) + 'Q take');
    setText(terms.cuts, cuts ? ' · cuts' : '');
    row._regionLabel.title = active
        ? 'The kept region of this track\'s take: drag the box to slide ' +
          'it, its brackets to trim, double-click to cut'
        : bypassed
            ? 'The loop region is bypassed — the whole take sounds. The ' +
              'lane\'s chip re-activates it; the box still edits it'
            : 'This track loops its whole take: drag a bracket in to make a ' +
              'loop region, double-click to cut';

    // The raw take: the detail strip's visible slice, the overview's
    // whole — the waveform, or a MIDI clip's piano roll.
    const midi = lane.isMidi && aux && aux.midiNotes
        ? aux.midiNotes.get(lane.id) || null : null;
    const isGroup = lane.kind === 'group';
    drawStripWave(strip, peaks, isGroup, midi, totalQ, v);
    drawOverviewWave(row._regionOverview, peaks, isGroup, midi, totalQ);
    paintOverviewMarks(row._regionOverview, segs, active, totalQ);
    paintOverviewTop(row._regionOverview, lane, withTop, totalQ);
    paintViewBox(row._regionOverview, v, totalQ);
    paintGrid(strip, v, totalQ);
    paintTiming(row, lane, vm);

    // Creation (dblclick) reads per-paint state; must refresh before
    // any early return.
    wireBandCreate(strip, sl, vm, v.spanQ);
    patchCursors(row, lane, vm, aux, v);
    if (isOverlayFrozen(strip)) return;
    const a = segs[0][0];
    const b = segs[segs.length - 1][1];
    const narrow = xOf(b, v, strip.clientWidth) - xOf(a, v, strip.clientWidth)
        < NARROW_BOX_PX;
    const key = JSON.stringify(['region', lane.bandSegs, totalQ, active,
                                lane.bandEditable, vm.quantum, v.q0, v.spanQ,
                                narrow, withTop && lane.topQ,
                                !!lane.canRetime]);
    const o = row._regionOverlay;
    if (o._key === key) return;
    o._key = key;
    o.textContent = '';
    // The panel's chrome carries its OWN class vocabulary (region-*):
    // lane-row-scoped queries for a lane's brackets/dims — tests, the
    // [ ] teleport walk — must never find the panel's.
    if (active) dimComplementInto(o, v.spanQ, segs, -v.q0, totalQ, 'region-dim');
    // The kept box: the span from the first kept sample to the last —
    // grab it to SLIDE the region (bands and handles sit above it).
    const kept = el('div', 'region-kept' + (active ? '' : ' whole'), {
        title: st.editable
            ? 'Drag to slide the loop region (whole Qs; ⌥ = any amount)'
            : '' });
    kept.style.left = viewPct(a, v);
    kept.style.width = pct(b - a, v.spanQ);
    o.appendChild(kept);
    // THE ↺ — Ableton's start marker — at the top's raw position, above
    // the box. Its line never takes a press (it sits inside the box and
    // must never steal a slide); only its TAB grabs. Inert under the
    // recording gate.
    if (withTop) {
        const mark = el('div', 'region-top' + (lane.canRetime ? '' : ' inert'));
        const tab = el('span', 'region-top-tab mono', {
            textContent: '↺ top',
            title: lane.canRetime ? TOP_TITLE : LOCKED_TITLE });
        mark.appendChild(tab);
        placeTopMark(mark, lane.topQ, v, strip.clientWidth);
        o.appendChild(mark);
        if (lane.canRetime) {
            tab.addEventListener('pointerdown', ev => {
                if (ev.button !== 0) return;
                startPanelTopDrag(row, ev, st, mark);
            });
        }
        // A double-click on the tab never cuts the cell under it.
        tab.addEventListener('dblclick', ev => {
            ev.preventDefault();
            ev.stopPropagation();
        });
    }
    if (!st.editable) return;
    kept.addEventListener('pointerdown', ev => {
        const grabQ = rawQAtStrip(strip, ev.clientX, entryOf(row).view);
        startPanelDrag(row, ev, st, slideMoveFn(st, segs, grabQ));
    });
    // The brackets: trim (period-snapped), ⌥ slides. A NARROW box
    // wears them outside (N4) so its whole width stays a slide.
    for (const edge of ['start', 'end']) {
        const bound0 = edge === 'start' ? a : b;
        const br = el('div', 'region-bracket ' + edge +
            (active ? '' : ' latent') + (narrow ? ' narrow' : ''), {
            title: (edge === 'start'
                ? 'Loop START — drag to trim (whole-Q snap)'
                : 'Loop END — drag to trim (whole-Q snap)') +
                ' · ⌥-drag slides the region (length held)' });
        br.style.left = viewPct(bound0, v);
        br.addEventListener('pointerdown', ev =>
            startPanelDrag(row, ev, st, trimMoveFn(st, segs, edge, bound0)));
        o.appendChild(br);
    }
    // Inner cuts as bands (the lane's raw-frame band code, unchanged —
    // framed through the view by stripLane).
    appendCutBands(o, sl, vm, strip, v.spanQ);
}

/** One panel drag (the kept box's slide, a bracket's trim) through the
 * shared raw-frame runner, in the panel's view — which the drag's EDGE
 * PAN may move under a still hand (edge_pan.js, the reveal's rule). */
function startPanelDrag(row, ev, st, onMove) {
    const strip = row._regionStrip;
    if (isDragging(strip)) return;
    const e = entryOf(row);
    if (!e) return;
    selectOnly(st.laneId);
    const pan = makeEdgePanner({
        rect: () => strip.getBoundingClientRect(),
        grabX: ev.clientX,
        canPan: dir => canPanView(dir, e.view.q0, e.view.spanQ, e.totalQ),
        pxPerQ: () => strip.clientWidth / e.view.spanQ,
        onPan: dq => {
            setView(row, panBy(e.view, dq, e.totalQ));
            run.reapply();
        },
    });
    const run = runRawDrag(ev, row._regionOverlay, st, {
        rawQAt: x => rawQAtStrip(strip, x, e.view),
        view: () => e.view,
        onMove,
        freeze: [strip],
        engage: true,
        onPointer: mv => pan.update(mv.clientX),
        onRelease: () => pan.stop(),
    });
}

/** The ↺ mark at raw `q` through `v`, its tab anchored inward at the
 * strip's edges. */
function placeTopMark(mark, q, v, w) {
    setStyle(mark, 'left', viewPct(q, v));
    const x = w > 0 ? (q - v.q0) / v.spanQ * w : 0;
    mark.classList.toggle('region-at-left', x < TOP_TAB_EDGE_PX);
    mark.classList.toggle('region-at-right', x > w - TOP_TAB_EDGE_PX);
}

/** The ↺'s tick on the overview (per paint: it follows a start-marker
 * drag's preview) — wherever the panel offers the ↺ (`withTop`). */
function paintOverviewTop(ov, lane, withTop, totalQ) {
    const tick = ov.querySelector('.region-ov-top');
    const show = withTop && totalQ > 0 && Number.isFinite(lane.topQ);
    setStyle(tick, 'display', show ? '' : 'none');
    if (show) setStyle(tick, 'left', pct(lane.topQ, totalQ));
}

/** Does the panel offer the ↺ — the start marker? Where the clip has
 * one (wantsTopHandle) over a kept set its drag can walk: an active
 * map's, or a plain loop's whole take. Not over a bypassed map: a top
 * must lie in its STORED region (setTiming refuses any other), and
 * that is not what plays. Exported for the tests. */
export function panelOffersTop(lane) {
    return (laneMapActive(lane) || isPlainLoop(lane)) && wantsTopHandle(lane);
}

/** Has a re-time moved the take by a sample or more (the reset's
 * reach)? */
const isShifted = (lane, quantum) =>
    Math.round(Math.abs(lane.retimeQ || 0) * quantum) >= 1;

/** Does the label show the timing readout and its reset? On a clip a
 * re-time can reach (a gated one's stay, the reset inert): where a ↺
 * is offered — on the lane or here — and wherever the take IS shifted,
 * ↺ or not, since "Timing as played" still puts back a bypassed map's.
 * Hidden only where nothing can act on them. Exported for the tests. */
export function showsTiming(lane, quantum) {
    return wantsTopHandle(lane) && (panelOffersTop(lane) || wantsLaneTop(lane) ||
                                    isShifted(lane, quantum));
}

/** The label's timing readout and its reset (showsTiming); the reset
 * acts only where a re-time is offered now, on a shifted take. */
function paintTiming(row, lane, vm) {
    const t = row._regionTiming;
    const q = vm.quantum;
    const show = showsTiming(lane, q);
    setStyle(t.block, 'display', show ? '' : 'none');
    if (!show) return;
    const r = lane.retimeQ || 0;
    const msPerQ = vm.sampleRate > 0 && q > 0 ? q / vm.sampleRate * 1000 : 0;
    setText(t.read, timingText(r, msPerQ));
    t.block.classList.toggle('shifted', Math.abs(r) > 1e-9);
    const off = !lane.canRetime || !isShifted(lane, q);
    if (t.reset.disabled !== off) t.reset.disabled = off;
    setTitle(t.reset, lane.canRetime
        ? 'Undo every shift: put the audio back where it was played ' +
          '(the ↺ and the audio move back together)'
        : LOCKED_TITLE);
}

/** "Timing as played": one re-time by −retime (the preview the poll
 * brought — or a drag's still in flight — is the retime to undo). */
function resetTiming(row) {
    const c = row._regionCtx;
    if (!c || !c.lane.canRetime || isOverlayFrozen(row._regionStrip)) return;
    const shift = -Math.round((c.lane.retimeQ || 0) * c.vm.quantum);
    if (!shift) return;
    selectOnly(c.lane.id);
    commitTiming({ laneId: c.lane.id }, shift, null, false);  // its own undo step
}

/**
 * THE START MARKER (loop_selection.md §9.3 — Ableton's): drag the ↺ by
 * its tab onto another hit and the audio moves so that hit lands where
 * the ↺ sounds. T′ = T0 + δ (whole Q from the grab, ⌥ free), clamped
 * into the kept set and skipping its gaps; the compensating shift is
 * heardOffset(T0) − heardOffset(T′), so the ↺ keeps its MOMENT and the
 * take re-times under it (setTiming with the top). A plain loop's kept
 * set is its whole take, [0, duration) (st.segs null): its heard offset
 * is the raw position, so the shift is simply T0 − T′. The lane above
 * previews it (pending_edits: the top and the shift together), live
 * commits stream as one undo step, and the view edge-pans like a box
 * drag. Samples throughout: the top must land inside the kept set.
 */
function startPanelTopDrag(row, ev, st, mark) {
    const strip = row._regionStrip;
    const c = row._regionCtx;
    const e = entryOf(row);
    if (!c || !e || isOverlayFrozen(strip)) return;
    const lane = c.lane;
    const q = st.quantum;
    const segsS = coveredSegs(st).map(([a, b]) => [Math.round(a * q), Math.round(b * q)]);
    const map = { segs: segsS };
    const T0 = Math.round(lane.topQ * q);
    const h0 = heardOffsetOf(map, T0);
    if (h0 < 0) return;  // a top the region does not play: nothing to hold
    selectOnly(lane.id);
    const aS = segsS[0][0];
    const bS = segsS[segsS.length - 1][1];
    /** A top inside the kept set: clamped to its span, a gap skipped
     * forward to the next kept sample. */
    const keep = t => {
        t = Math.max(aS, Math.min(bS - 1, t));
        for (let i = 0; i + 1 < segsS.length; i++) {
            if (t >= segsS[i][1] && t < segsS[i + 1][0]) return segsS[i + 1][0];
        }
        return t;
    };
    const grab0 = rawQAtStrip(strip, ev.clientX, e.view);
    const pv = previewer(lane.id);
    const o = row._regionOverlay;
    let badge = null;
    let sent = 0;           // samples of shift this gesture has committed
    let sentTop = T0;       // the top it last sent
    let lastP;              // its last commit
    const pan = makeEdgePanner({
        rect: () => strip.getBoundingClientRect(),
        grabX: ev.clientX,
        canPan: dir => canPanView(dir, e.view.q0, e.view.spanQ, e.totalQ),
        pxPerQ: () => strip.clientWidth / e.view.spanQ,
        onPan: dq => {
            setView(row, panBy(e.view, dq, e.totalQ));
            run.reapply();
        },
    });
    const run = runRawDrag(ev, o, st, {
        rawQAt: x => rawQAtStrip(strip, x, e.view),
        clamp: false,
        onMove: (rawQ, alt) => {
            if (rawQ === null) return { T: T0, shift: 0, handQ: T0 / q, alt };
            const free = rawQ - grab0;
            const dq = alt ? free : Math.round(free);
            const T = keep(T0 + Math.round(dq * q));
            return { T, shift: h0 - heardOffsetOf(map, T), alt,
                     handQ: Math.max(aS / q, Math.min(bS / q, T0 / q + free)) };
        },
        preview: res => {
            // The tab rides the hand; the badge names the landing. The
            // overlay rebuilds once the gesture lets go (its key is
            // poisoned: the mark moved under it).
            o._key = 'top-drag';
            placeTopMark(mark, res.handQ, e.view, strip.clientWidth);
            if (!badge) {
                badge = el('div', 'region-badge mono');
                o.appendChild(badge);
            }
            setText(badge, '↺ on ' + fmtFineQ(res.T / q) + 'Q · shift ' +
                fmtSignedQ(res.shift / q) + 'Q' + (res.alt ? ' · fine' : ''));
            // Centred on the landing, kept inside the strip (it clips).
            const w = strip.clientWidth;
            const bx = (res.T / q - e.view.q0) / e.view.spanQ * w;
            const bw = badge.offsetWidth;
            setStyle(badge, 'left', Math.max(BADGE_INSET_PX,
                Math.min(w - bw - BADGE_INSET_PX, bx - bw / 2)) + 'px');
            pv.show({ top: res.T, originShift: res.shift });
        },
        commit: res => {
            if (res.shift === sent && res.T === sentTop) return lastP;
            const delta = res.shift - sent;
            sent = res.shift;
            sentTop = res.T;
            return (lastP = commitTiming(st, delta, res.T, true));
        },
        restore: () => {
            if (!lastP) {
                pv.restore(null);
                return undefined;
            }
            // Put back the shift AND the top the gesture found — the
            // effective one: a top never set comes back STORED at the
            // same sample, as any map edit would leave it (the reconcile
            // materializes), and it plays the same. The gesture's one
            // undo step still restores the stored top exactly, unset
            // included (the verb itself has no "unset").
            const p = commitTiming(st, -sent, T0, true);
            sent = 0;
            sentTop = T0;
            pv.restore({ top: T0, originShift: 0 });
            return p;
        },
        held: res => {
            // The landing, still the box's until the rebuild; no presses
            // meanwhile (the stale chrome would take them).
            placeTopMark(mark, (res ? res.T : T0) / q, e.view, strip.clientWidth);
            if (badge) { badge.remove(); badge = null; }
            o.classList.add('drag-held');
        },
        teardown: () => {
            if (badge) { badge.remove(); badge = null; }
            o.classList.remove('drag-held');
        },
        freeze: [strip],
        engage: true,
        onPointer: mv => pan.update(mv.clientX),
        onRelease: () => pan.stop(),
    });
    if (!run.live) pan.stop();
}

/** Pointer x → raw Q on the detail strip through `view` (unclamped;
 * the runner clamps). */
function rawQAtStrip(strip, clientX, view) {
    const r = strip.getBoundingClientRect();
    return r.width > 0 ? qAt(clientX - r.left, view, r.width) : view.q0;
}

/** The take's content for a strip: MIDI notes when the clip has them,
 * else the peaks; null when there is nothing to draw. */
function stripContent(peaks, midi) {
    const notes = midi && midi.notes && midi.notes.length ? midi.notes : null;
    const content = notes || peaks;
    return content && content.length ? { notes, content } : null;
}

/** Draw the VISIBLE slice of the take in the detail strip — its
 * waveform at ONE gain per take (peaksBoost: a slice never rescales
 * against its own loudest peak, N8), or with `midi` ({notes, range},
 * Q units over `totalQ`) the note bars over a velocity lane. The peak
 * slice is drawn at its exact raw position (a canvas wider than the
 * strip, translated), so a pan GLIDES: it only translates until the
 * slice gains or drops a peak. */
function drawStripWave(strip, peaks, isComposite, midi, totalQ, v) {
    const wave = strip.querySelector('.region-wave');
    const canvas = wave.firstElementChild;
    const w = strip.clientWidth;
    const h = strip.clientHeight - STRIP_V_INSET_PX;
    const c = stripContent(peaks, midi);
    if (!c || !(w > 0) || !(totalQ > 0)) {
        if (canvas.style.display !== 'none') canvas.style.display = 'none';
        return;
    }
    if (canvas.style.display !== '') canvas.style.display = '';
    if (c.notes) {
        const key = 'm:' + w + ':' + h + ':' + midi.range.lo + '-' +
            midi.range.hi + ':' + totalQ.toFixed(4) + ':' + v.q0 + ':' + v.spanQ;
        setStyle(canvas, 'transform', '');
        if (wave._peaksRef === c.content && wave._dk === key) return;
        wave._peaksRef = c.content;
        wave._dk = key;
        canvas.style.width = w + 'px';
        drawMidiTile(canvas, sliceNotesToTile(c.notes, totalQ,
            [[v.q0 / totalQ, (v.q0 + v.spanQ) / totalQ]]),
            { cssWidth: w, cssHeight: h, range: midi.range,
              velocityLane: MIDI_VELOCITY_LANE });
        return;
    }
    // The visible raw range through the SAME exact per-column sampler the
    // lane's reveal draws with (map_bands revealColumns → mappedColumns,
    // one gain per take) — no whole-peak slicing, so the two raw surfaces
    // can never drift apart and a pan or zoom never re-quantizes the
    // picture (review 2026-09-23: one implementation, not two).
    setStyle(canvas, 'transform', '');
    const key = 'p:' + v.q0 + ':' + v.spanQ + ':' + w + ':' + h + ':' + isComposite;
    if (wave._peaksRef === peaks && wave._dk === key) return;
    wave._peaksRef = peaks;
    wave._dk = key;
    canvas.style.width = w + 'px';
    const { cols, boost } = revealColumns(peaks, totalQ, v.q0, v.q0 + v.spanQ, w);
    drawEnvelope(canvas, cols, { cssWidth: w, cssHeight: h, isComposite,
                                 fixedBoost: boost });
}

/** Draw the WHOLE take in the overview strip (same fixed gain as the
 * detail — one picture at two scales). */
function drawOverviewWave(ov, peaks, isComposite, midi, totalQ) {
    const canvas = ov.firstElementChild;
    const w = ov.clientWidth;
    const h = ov.clientHeight;
    const c = stripContent(peaks, midi);
    if (!c || !(w > 0) || !(h > 0)) {
        if (canvas.style.display !== 'none') canvas.style.display = 'none';
        return;
    }
    if (canvas.style.display !== '') canvas.style.display = '';
    const key = c.content.length + ':' + w + ':' + h + ':' + isComposite +
        (c.notes ? ':m' + midi.range.lo + '-' + midi.range.hi + ':' +
            totalQ.toFixed(4) : '');
    if (ov._peaksRef === c.content && ov._dk === key) return;
    ov._peaksRef = c.content;
    ov._dk = key;
    canvas.style.width = w + 'px';
    if (c.notes) {
        drawMidiTile(canvas, sliceNotesToTile(c.notes, totalQ, null),
            { cssWidth: w, cssHeight: h, range: midi.range });
    } else {
        drawWaveform(canvas, peaks,
            { cssWidth: w, cssHeight: h, isComposite, fixedBoost: peaksBoost(peaks) });
    }
}

/** The overview's region marks (keyed): the kept segments tinted, each
 * inner cut notched. */
function paintOverviewMarks(ov, segs, active, totalQ) {
    const marks = ov.querySelector('.region-ov-marks');
    const key = JSON.stringify([segs, active, totalQ]);
    if (marks._key === key) return;
    marks._key = key;
    marks.textContent = '';
    for (const [s, e] of segs) {
        const k = el('div', 'region-ov-kept' + (active ? '' : ' whole'));
        k.style.left = pct(s, totalQ);
        k.style.width = pct(e - s, totalQ);
        marks.appendChild(k);
    }
    for (const [s, e] of innerCuts(segs, totalQ)) {
        const n = el('div', 'region-ov-cut');
        n.style.left = pct(s, totalQ);
        n.style.width = pct(e - s, totalQ);
        marks.appendChild(n);
    }
}

/** The detail view as a box on the overview. */
function paintViewBox(ov, v, totalQ) {
    const box = ov.querySelector('.region-viewbox');
    setStyle(box, 'left', pct(v.q0, totalQ));
    setStyle(box, 'width', pct(v.spanQ, totalQ));
}

/** Whole-Q gridlines (thinned to ≥ GRID_MIN_PX apart; no sub-Q grid —
 * owner ruling 2026-09-23) and, from Q_LABEL_MIN_PX_PER_Q up, small
 * whole-Q numbers. Keyed on the view and width. */
function paintGrid(strip, v, totalQ) {
    const grid = strip.querySelector('.region-grid');
    const w = strip.clientWidth;
    const key = v.q0 + ':' + v.spanQ + ':' + w + ':' + totalQ;
    if (grid._key === key) return;
    grid._key = key;
    grid.textContent = '';
    if (!(w > 0)) return;
    const pxPerQ = w / v.spanQ;
    const labels = pxPerQ >= Q_LABEL_MIN_PX_PER_Q;
    for (const { q, major } of gridLines(v, gridStep(pxPerQ), totalQ)) {
        const line = el('div', 'region-gridline' + (major ? ' major' : ''));
        line.style.left = viewPct(q, v);
        grid.appendChild(line);
        // (No number where it would clip at the strip's right edge.)
        if (labels && xOf(q, v, w) < w - Q_LABEL_EDGE_PX) {
            const t = el('div', 'region-qlabel mono', { textContent: String(q) });
            t.style.left = viewPct(q, v);
            grid.appendChild(t);
        }
    }
}

/** Position one cursor at fraction `f` of its host (glide; snap on a
 * wrap, on reappearing, or when `viewKey` says the scale changed). */
function placeCursor(cur, f, viewKey) {
    const show = f !== null && f >= 0 && f <= 1;
    setStyle(cur, 'display', show ? '' : 'none');
    if (!show) { cur._frac = undefined; return; }
    if (cur._frac === undefined || cur._vk !== viewKey ||
        f < cur._frac - CURSOR_WRAP_FRAC) snapThenAnimate(cur);
    cur._frac = f;
    cur._vk = viewKey;
    setStyle(cur, 'left', (f * 100) + '%');
}

/** The amber sound cursors in raw coordinates (per paint): the
 * overview's over the whole take; the detail's through the view —
 * hidden outside it. The detail cursor is made ONCE and lives outside
 * the keyed overlay, so a rebuild can never leave a fresh, unplaced
 * cursor at raw 0 (flash-chrome F5 / N6), and a panel drag's
 * `.drag-live` never hides it. */
function patchCursors(row, lane, vm, aux, v) {
    const strip = row._regionStrip;
    let cur = strip.querySelector(':scope > .region-cursor');
    if (!cur) {
        cur = el('div', 'region-cursor');
        cur.style.display = 'none';
        strip.appendChild(cur);
    }
    const ovCur = row._regionOverview.querySelector('.region-ov-cursor');
    const node = aux && aux.nodesById ? aux.nodesById.get(lane.id) : null;
    const rawQ = vm.isPlaying ? rawCursorQ(lane, vm, node) : null;
    const totalQ = lane.bandTotalQ;
    placeCursor(ovCur, rawQ === null ? null : rawQ / totalQ, '');
    placeCursor(cur, rawQ === null ? null : (rawQ - v.q0) / v.spanQ,
        v.q0 + ':' + v.spanQ);
}

/* ---------- navigation input ---------- */

/** Wheel over the panel (N2): Ctrl/⌘+wheel or a pinch zooms the
 * PANEL about the pointer; Shift+wheel or a horizontal swipe pans it;
 * both stop here, so the main view never zooms or scrolls under the
 * panel. A plain vertical wheel falls through (page scroll). v1: the
 * view holds still while a panel drag is live or its commit is held —
 * the event is still swallowed. */
function onPanelWheel(row, ev) {
    const e = entryOf(row);
    if (!e) return;
    const strip = row._regionStrip;
    const r = strip.getBoundingClientRect();
    const zoom = ev.ctrlKey || ev.metaKey;
    const panQ = zoom ? 0 : wheelPanQ(ev, e.view, r.width);
    if (!zoom && !panQ) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (isOverlayFrozen(strip)) return;
    if (zoom) {
        // Zoom about the Q UNDER THE POINTER (review 2026-09-23: the
        // overview used the detail strip's fraction). On the detail strip
        // that Q reads through the view. On the OVERVIEW it reads through
        // the whole take, and the view box scales about it — when it lies
        // inside the box; outside the box (or over the label) there is no
        // point to hold still, so the view scales about its middle.
        const ov = row._regionOverview;
        const or = ov ? ov.getBoundingClientRect() : null;
        const mid = e.view.q0 + e.view.spanQ / 2;
        let anchor = mid;
        if (or && or.width > 0 && ov.contains(ev.target)) {
            const q = Math.max(0, Math.min(1, (ev.clientX - or.left) / or.width)) * e.totalQ;
            if (q >= e.view.q0 && q <= e.view.q0 + e.view.spanQ) anchor = q;
        } else if (r.width > 0 && ev.clientX >= r.left && ev.clientX <= r.right) {
            anchor = e.view.q0 + ((ev.clientX - r.left) / r.width) * e.view.spanQ;
        }
        setView(row, zoomAbout(e.view, anchor,
            wheelZoomFactor(ev.deltaY, ev.deltaMode), e.totalQ));
    } else {
        setView(row, panBy(e.view, panQ, e.totalQ));
    }
}

/** The overview's pointer verbs: drag the view box = pan (vertical =
 * zoom), drag its edge = set the span, press elsewhere = centre the
 * view there and keep dragging to pan; double-click = the whole take.
 * One gesture (gesture.js): Escape / a lost capture restores the view
 * the press began on. */
function wireOverview(row) {
    const ov = row._regionOverview;
    ov.addEventListener('pointerdown', ev => {
        if (ev.button !== 0) return;
        const e = entryOf(row);
        if (!e || isOverlayFrozen(row._regionStrip)) return;
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
                    : inBox ? boxDragView(v0, dq, mv.clientY - ev.clientY, e.totalQ)
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

/** Pin the panel to the viewport horizontally at a CONSTANT width (N3):
 * the row spans the zoomed grid; the panel sits at the viewport's
 * content left (#session's padding in) with the viewport's content
 * width — the same at every main zoom and scroll. Returns true when
 * the width changed (the caller repaints). */
function pinToViewport(row, nav) {
    const panel = row._regionPanel;
    const session = ctx.els.session;
    if (!panel || !session) return false;
    const sr = session.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    if (!(sr.width > 0) || !(nr.width > 0)) return false;
    const pad = parseFloat(getComputedStyle(session).paddingLeft);
    const m = pad > 0 ? pad : PANEL_MARGIN_PX;
    const l = Math.round(sr.left + session.clientLeft + m - nr.left) + 'px';
    const w = Math.max(120, Math.round(session.clientWidth - 2 * m)) + 'px';
    if (panel.style.left !== l) panel.style.left = l;
    if (panel.style.width === w) return false;
    panel.style.width = w;
    return true;
}

/* ---------- the nudge keys ---------- */

/**
 * THE NUDGE CHAIN IS ONE PINNED GESTURE (release-jump F3): a nudge
 * commits with no drag, so each press used to re-seat the frame — a
 * ⌥← from a grid-aligned loop shifted every lane and the cursor 1Q.
 * The first press of a chain pins the frame (drag_pin.js, the drag's
 * pin); every press within `windowMs` extends the chain; the pin drops
 * once the window elapses after the LAST press and that press's commit
 * has settled (capped at `capMs`, the overlay hold's cap). Timers are
 * injectable for tests. Returns press(commitPromise).
 */
export function makeChainPin({ pin = pinFrame, unpin = unpinFrame,
                               windowMs = NUDGE_CHAIN_MS,
                               capMs = COMMIT_HOLD_MAX_MS,
                               setTimer = setTimeout,
                               clearTimer = clearTimeout } = {}) {
    let chain = null;  // { timer, seq }
    return function press(p) {
        if (!chain) { pin(); chain = { timer: 0, seq: 0 }; }
        const mine = chain;
        const seq = ++mine.seq;
        clearTimer(mine.timer);
        mine.timer = setTimer(() => afterSettled(p, () => {
            // A press that landed while this one settled owns the
            // chain now; only the LAST press releases it.
            if (chain !== mine || mine.seq !== seq) return;
            chain = null;
            unpin();
        }, { capMs, setTimer, clearTimer }), windowMs);
    };
}
const nudgePin = makeChainPin();

/** ← / → (init.js): slide the selected track's loop region by
 * `deltaQ` (length held, clamped to the take — slideSegs). Reads the
 * strip's per-patch band state, so it works exactly when the panel
 * does. One undo step per press; the chain holds the frame still
 * (makeChainPin) and the view pans to keep the region in sight.
 * Returns false when nothing applies (no panel, not editable, nothing
 * to slide) so the key falls through. */
export function nudgeRegion(deltaQ) {
    const id = activeSelectedId();
    if (id === null) return false;
    const row = ctx.laneEls.get(id);
    const strip = row && row._regionStrip;
    const st = strip && strip._bandState;
    const nav = row && row.querySelector(':scope > .lane-region');
    if (!st || !st.editable || !nav || nav.style.display === 'none') return false;
    if (isDragging(strip)) return false;
    // CHAINED PRESSES: key repeat fires faster than the poll that
    // refreshes `_bandState`, so a press that lands before the previous
    // commit is seen would slide from the OLD region (and, at the
    // take's edge, clamp to nothing). Base each press on the last
    // target sent within the chain window instead.
    const chain = strip._nudge;
    const base = chain && performance.now() - chain.t < NUDGE_CHAIN_MS
        ? chain.segs : coveredSegs(st);
    const { segs, deltaQ: moved } = slideSegs(base, deltaQ, st.totalQ);
    if (Math.abs(moved) < 1e-9) return true;  // at the take's edge: consumed, no-op
    strip._nudge = { segs, t: performance.now() };
    newGesture();
    nudgePin(commitBandSegs(st, segs, true));
    const e = entryOf(row);
    if (e) {
        const [a, b] = regionBounds(segs, e.totalQ);
        setView(row, keepInView(e.view, a, b, e.totalQ));
    }
    return true;
}

/** The panels track horizontal scroll live (the 50ms patch would lag
 * a flick); rAF-coalesced. A width change (the viewport resized, a
 * scrollbar came or went) repaints at once. */
export function wireRegionScroll() {
    let raf = 0;
    ctx.els.session.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            ctx.laneEls.forEach(row => {
                const nav = row.querySelector(':scope > .lane-region');
                if (nav && nav.style.display !== 'none' &&
                    pinToViewport(row, nav)) paintPanel(row);
            });
        });
    }, { passive: true });
}
