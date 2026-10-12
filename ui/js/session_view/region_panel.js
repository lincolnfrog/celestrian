/**
 * THE REGION PANEL — the loop region's overview + editor for the
 * SELECTED track, in the edit bar at the foot of the session view
 * (region_dock.js).
 *
 * A heard-view lane shows only what sounds; the whole raw take and the
 * map's structure live here, where nothing rescales a lane:
 *   - a NAVIGATOR bar: an abstract map of the whole take (no waveform —
 *     the detail below draws it) — its extent, the kept region as solid
 *     blocks, cuts as the gaps, the ↺ tick, the amber cursor, and the
 *     detail view as a box. Always shown, so the loop's two ends stay a
 *     click apart however far in the detail is zoomed;
 *   - a zoomable DETAIL strip: the raw take (waveform, or a MIDI clip's
 *     piano roll over its velocity lane) through the panel's own view
 *     (region_nav.js, panel_view.js), the excluded material dimmed, the
 *     kept region as a box with bracket handles, every inner cut as a
 *     band, whole-Q gridlines, the ↺ as Ableton's start marker, and the
 *     amber sound cursor in raw coordinates.
 *
 * The strip is a raw-framed band host through the view (cycleQ = spanQ,
 * anchored at −q0), so the cut bands and dblclick creation are the
 * lane's own code (map_bands.js) and every gesture runs on the shared
 * runner (map_core.js). Live commits stream while dragging; the lane
 * above renders the audible result as it changes.
 *
 * This module builds the panel, paints it, and owns its gestures; the
 * view and navigation input are region_nav.js, the ← / → keys
 * region_nudge.js, the bar region_dock.js.
 */

import { el, pct, fmtQ, setText, setTitle, setStyle } from './sv_util.js';
import { isOverlayFrozen, isDragging } from './gesture.js';
import { selectOnly } from './selection.js';
import { drawEnvelope, drawMidiTile, MIDI_VELOCITY_LANE } from '../canvas_renderer.js';
import { sliceNotesToTile } from '../midi_notes.js';
import { dimComplementInto } from './dims.js';
import { innerCuts, segsPeriod } from '../map_edit.js';
import { heardOffsetOf } from '../time_map.js';
import { bandState, coveredSegs, laneMapActive, laneMapOff, rawCursorQ,
         commitTiming, runRawDrag, runMapDrag, timingSender, segsSamples,
         viewPct, placeCursor, badgeLeft, timingText, fmtSignedQ, fmtFineQ,
         LOCKED_TITLE } from './map_core.js';
import { trimMoveFn, slideMoveFn } from './map_moves.js';
import { previewer, wantsTopHandle, wantsLaneTop, isPlainLoop } from './splice_handles.js';
import { wireBandCreate, appendCutBands, revealColumns } from './map_bands.js';
import { makeViewPanner } from './edge_pan.js';
import { panBy, gridStep, gridLines, qAt, xOf, Q_LABEL_MIN_PX_PER_Q }
    from './panel_view.js';
import { entryOf, ensureView, followRegion, setView, fitPanel, onPanelWheel,
         wireOverview, setPanelPainter } from './region_nav.js';
import { noteNudgePublished } from './region_nudge.js';
import { wantPanel, mountInDock } from './region_dock.js';

/* Waveform vertical inset inside the strips (px). */
const STRIP_V_INSET_PX = 4;
/* A kept box narrower than three bracket hit zones (26 px each) wears
 * its brackets OUTSIDE it: the box's whole width stays a slide. */
const NARROW_BOX_PX = 78;
/* A whole-Q number needs this much strip right of its line (px). */
const Q_LABEL_EDGE_PX = 16;
/* The ↺ tab anchors inward within this many px of the strip's edges
 * (the strip clips its overflow). */
const TOP_TAB_EDGE_PX = 20;
const TOP_TITLE = '↺ The loop\'s top — Ableton\'s start marker: drag it onto ' +
    'the hit that should land on the one, and the audio shifts so it does ' +
    '(a re-time). Whole Q; ⌥ = fine.';
const RESET_TITLE = 'Undo every shift: put the audio back where it was played ' +
    '(the ↺ and the audio move back together)';

/** Build the lane's panel once (lane_build) and mount it in the edit
 * bar. Hidden until the lane is selected and has a take to show. The
 * row keeps it as `_region` (lane_body's expando table): `nav` the
 * mounted element, `strip` the detail strip, and the parts the paint
 * writes. */
export function buildRegionPanel(row) {
    const nav = el('div', 'lane-region');
    nav.dataset.laneId = row.dataset.id;
    nav.style.display = 'none';
    const panel = el('div', 'region-panel');
    // A press in the panel must never fall through to the page.
    panel.addEventListener('pointerdown', e => e.stopPropagation());
    // The label names the track (the bar is not next to its lane); its
    // two terms are the two zoom stops.
    const label = el('div', 'region-label mono');
    const name = el('div', 'region-name');
    const termLoop = el('span', 'region-term loop',
        { title: 'Fit the loop region in the panel (Z)' });
    const termTake = el('span', 'region-term take',
        { title: 'Show the whole take in the panel (⇧Z)' });
    const termCuts = el('span', 'region-term-cuts');
    // THE TIMING (loop_selection.md §9.2): how far a re-time has moved
    // the take from where it was played, and the way back.
    const timing = el('div', 'region-timing');
    const timingRead = el('span', 'region-timing-read');
    const timingReset = el('button', 'region-timing-reset', {
        type: 'button', textContent: 'Timing as played', title: RESET_TITLE });
    timing.append(timingRead, timingReset);
    label.append(name, termLoop, document.createTextNode(' · '), termTake,
                 termCuts, timing);
    termLoop.addEventListener('click', () => fitPanel(row, 'region'));
    termTake.addEventListener('click', () => fitPanel(row, 'take'));
    timingReset.addEventListener('click', () => resetTiming(row));
    const col = el('div', 'region-col');
    const overview = el('div', 'region-overview', {
        title: 'Map of the whole take: the loop region, its cuts and the ' +
            '↺ — drag the box to move the view, its edges to set how much ' +
            'shows; click to jump there; double-click for the whole take. ' +
            '+/− zoom the view about the playhead' });
    const ovMarks = el('div', 'region-ov-marks');
    const ovCursor = el('div', 'region-ov-cursor');
    const ovTop = el('div', 'region-ov-top');
    ovTop.style.display = 'none';
    const viewbox = el('div', 'region-viewbox');
    viewbox.append(el('div', 'region-viewbox-edge start'),
                   el('div', 'region-viewbox-edge end'));
    overview.append(ovMarks, ovCursor, ovTop, viewbox);
    const strip = el('div', 'region-strip');
    const grid = el('div', 'region-grid');
    const wave = el('div', 'region-wave');
    wave.appendChild(document.createElement('canvas'));
    const overlay = el('div', 'region-overlay overlay-layer');
    strip.append(grid, wave, overlay);
    col.append(overview, strip);
    panel.append(label, col);
    nav.appendChild(panel);
    row._region = {
        nav, strip, overlay, label, name, overview,
        terms: { loop: termLoop, take: termTake, cuts: termCuts },
        timing: { block: timing, read: timingRead, reset: timingReset },
        ctx: null,   // the last patch's { lane, vm, aux, peaks }
    };
    panel.addEventListener('wheel', ev => onPanelWheel(row, ev), { passive: false });
    wireOverview(row);
    // TEST HOOK (the reveal's body._reveal.view twin): a copy of the
    // live view, read by the e2e specs.
    Object.defineProperty(strip, '_view', {
        get: () => { const e = entryOf(row); return e ? { ...e.view } : null; },
    });
    mountInDock(nav);
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

/** Patch one lane's panel per poll: visibility, the view's upkeep, then
 * the paint. */
export function patchRegionPanel(row, lane, vm, aux, peaks) {
    if (!row._region) return;
    const { nav, strip } = row._region;
    if (!wantPanel(lane)) {
        // Never hide under a live drag: the strip holds the capture.
        if (isDragging(strip)) return;
        if (nav.style.display !== 'none') nav.style.display = 'none';
        return;
    }
    if (nav.style.display !== '') nav.style.display = '';
    setText(row._region.name, lane.name || '');
    row._region.ctx = { lane, vm, aux, peaks };
    followRegion(row, lane, ensureView(lane));
    paintPanel(row);
}

/** The label's loop term and tooltip, by how the region stands: it
 * sounds, it is stored but off (map_core laneMapOff — a clip's window or
 * a group's cut map alike), or there is none. Exported for the tests. */
export function regionTerm(lane, periodQ) {
    const len = fmtQ(periodQ) + 'Q';
    if (laneMapActive(lane)) {
        return { text: 'loop ' + len,
                 title: 'The kept region of this track\'s take: drag the box ' +
                     'to slide it, its brackets to trim, double-click to cut' };
    }
    const off = laneMapOff(lane);
    if (off === 'bypassed') {
        return { text: 'bypassed ' + len,
                 title: 'The loop region is bypassed — the whole take sounds. ' +
                     'The lane\'s chip re-activates it; the box still edits it' };
    }
    if (off === 'suspended') {
        return { text: 'suspended ' + len,
                 title: 'The loop region was drawn over the sequence timeline — ' +
                     'it returns when the sequence is active again; the box ' +
                     'still edits it' };
    }
    return { text: 'whole take',
             title: 'This track loops its whole take: drag a bracket in to ' +
                 'make a loop region, double-click to cut' };
}

/** Paint the panel from the last patch's state through the current
 * view: label, both strips, gridlines, cursors, then the chrome
 * (keyed — a stable view and map mean zero DOM churn). */
function paintPanel(row) {
    const r = row._region;
    const e = entryOf(row);
    if (!r.ctx || !e) return;
    const { lane, vm, aux, peaks } = r.ctx;
    const v = e.view;
    const totalQ = e.totalQ;
    const strip = r.strip;
    const sl = stripLane(lane, v);
    const st = bandState(sl, vm, v.spanQ);
    const segs = coveredSegs(st);
    const active = laneMapActive(lane);
    const withTop = panelOffersTop(lane);
    const cuts = !!(lane.mapMulti || innerCuts(st.segs, totalQ).length);
    // The label names the region: what is kept of what exists.
    const term = regionTerm(lane, segsPeriod(segs, totalQ));
    setText(r.terms.loop, term.text);
    setText(r.terms.take, fmtQ(totalQ) + 'Q take');
    setText(r.terms.cuts, cuts ? ' · cuts' : '');
    setTitle(r.label, term.title);

    const midi = lane.isMidi && aux && aux.midiNotes
        ? aux.midiNotes.get(lane.id) || null : null;
    drawStripWave(strip, peaks, lane.kind === 'group', midi, totalQ, v);
    paintOverviewMarks(r.overview, segs, active, totalQ);
    paintOverviewTop(r.overview, lane, withTop, totalQ);
    paintViewBox(r.overview, v, totalQ);
    paintGrid(strip, v, totalQ);
    paintTiming(row, lane, vm);

    // Creation (dblclick) and the nudge keys read per-paint state:
    // refreshed before the frozen gate.
    wireBandCreate(strip, sl, vm, v.spanQ);
    noteNudgePublished(strip);
    patchCursors(row, lane, vm, aux, v);
    if (isOverlayFrozen(strip)) return;   // gesture.js, the freeze law
    const a = segs[0][0];
    const b = segs[segs.length - 1][1];
    const narrow = xOf(b, v, strip.clientWidth) - xOf(a, v, strip.clientWidth)
        < NARROW_BOX_PX;
    const key = JSON.stringify(['region', lane.bandSegs, totalQ, active,
                                lane.bandEditable, vm.quantum, v.q0, v.spanQ,
                                narrow, withTop && lane.topQ,
                                !!lane.canRetime]);
    const o = r.overlay;
    if (o._key === key) return;
    o._key = key;
    o.textContent = '';
    // The panel's chrome carries its OWN class vocabulary (region-*):
    // lane-scoped queries for a lane's brackets and dims — the tests,
    // the [ ] teleport walk — must never find the panel's.
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
    // THE ↺, the start marker, at the top's raw position above the box.
    // Only its TAB grabs: its line sits inside the box and must never
    // steal a slide. Inert under the recording gate.
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
    // Inner cuts as bands: the lane's raw-frame band code, framed
    // through the view by stripLane.
    appendCutBands(o, sl, vm, strip, v.spanQ);
}
setPanelPainter(paintPanel);

/* ---------- the gestures ---------- */

/** Pointer x → raw Q on the detail strip through `view` (unclamped). */
function rawQAtStrip(strip, clientX, view) {
    const r = strip.getBoundingClientRect();
    return r.width > 0 ? qAt(clientX - r.left, view, r.width) : view.q0;
}

/** Run one panel drag with the panel's EDGE PAN (edge_pan.js): the view
 * `e` moves under a hand held near the strip's edge. `start(hooks)`
 * starts the gesture with the pan's `onPointer` / `onRelease` hooks and
 * returns its run. */
function withPanelPan(row, ev, e, start) {
    const strip = row._region.strip;
    let run = null;
    const pan = makeViewPanner({
        rect: () => strip.getBoundingClientRect(),
        grabX: ev.clientX,
        view: () => e.view,
        totalQ: e.totalQ,
        pxPerQ: () => strip.clientWidth / e.view.spanQ,
        onPan: dq => {
            setView(row, panBy(e.view, dq, e.totalQ));
            run.reapply();
        },
    });
    run = start({ onPointer: mv => pan.update(mv.clientX),
                  onRelease: () => pan.stop() });
    if (!run.live) pan.stop();
}

/** One RAW panel drag (the kept box's slide, a bracket's trim) in the
 * panel's view. */
function startPanelDrag(row, ev, st, onMove) {
    const strip = row._region.strip;
    const e = entryOf(row);
    if (!e) return;
    withPanelPan(row, ev, e, hooks => runRawDrag(ev, row._region.overlay, st, {
        rawQAt: x => rawQAtStrip(strip, x, e.view),
        view: () => e.view,
        onMove,
        freeze: [strip],
        ...hooks,
    }));
}

/** The ↺ mark at raw `q` through `v`, its tab anchored inward at the
 * strip's edges. */
function placeTopMark(mark, q, v, w) {
    setStyle(mark, 'left', viewPct(q, v));
    const x = w > 0 ? xOf(q, v, w) : 0;
    mark.classList.toggle('region-at-left', x < TOP_TAB_EDGE_PX);
    mark.classList.toggle('region-at-right', x > w - TOP_TAB_EDGE_PX);
}

/** Does the panel offer the ↺ — the start marker? Where the clip has
 * one (wantsTopHandle) over a kept set its drag can walk: an active
 * map's, or a plain loop's whole take. Not over a bypassed map: a top
 * must lie in its STORED region (setTiming refuses any other), and that
 * is not what plays. Exported for the tests. */
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
 * Exported for the tests. */
export function showsTiming(lane, quantum) {
    return wantsTopHandle(lane) && (panelOffersTop(lane) || wantsLaneTop(lane) ||
                                    isShifted(lane, quantum));
}

/** The label's timing readout and its reset (showsTiming); the reset
 * acts only where a re-time is offered now, on a shifted take. */
function paintTiming(row, lane, vm) {
    const t = row._region.timing;
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
    setTitle(t.reset, lane.canRetime ? RESET_TITLE : LOCKED_TITLE);
}

/** "Timing as played": one re-time by −retime (the preview the poll
 * brought — or a drag's still in flight — is the retime to undo). */
function resetTiming(row) {
    const c = row._region.ctx;
    if (!c || !c.lane.canRetime || isOverlayFrozen(row._region.strip)) return;
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
 * set is its whole take, whose heard offset is the raw position. The
 * lane above previews it (pending_edits: the top and the shift
 * together), live commits stream as one undo step (map_core
 * timingSender), and the view edge-pans like a box drag. Samples
 * throughout: the top must land inside the kept set.
 */
function startPanelTopDrag(row, ev, st, mark) {
    const strip = row._region.strip;
    const c = row._region.ctx;
    const e = entryOf(row);
    if (!c || !e || isOverlayFrozen(strip)) return;
    const lane = c.lane;
    const q = st.quantum;
    const segsS = segsSamples(coveredSegs(st), q);
    const map = { segs: segsS };
    const T0 = Math.round(lane.topQ * q);
    // The engine's own top — what a cancel puts back, and the picture
    // held meanwhile: the ↺ as shown (T0) on the loop that places the
    // frame, another sample on one that slots in.
    const topStored = Math.round((lane.storedTopQ ?? lane.topQ) * q);
    const h0 = heardOffsetOf(map, T0);
    if (h0 < 0) return;  // a top the region does not play: nothing to hold
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
    const sender = timingSender(st, pv, T0);
    const o = row._region.overlay;
    let badge = null;
    const dropBadge = () => { if (badge) { badge.remove(); badge = null; } };
    withPanelPan(row, ev, e, hooks => runMapDrag(ev, o, st, {
        posAt: x => rawQAtStrip(strip, x, e.view),
        onMove: (rawQ, alt) => {
            if (rawQ === null) return { T: T0, shift: 0, handQ: T0 / q, alt };
            const free = rawQ - grab0;
            const dq = alt ? free : Math.round(free);
            const T = keep(T0 + Math.round(dq * q));
            return { T, shift: h0 - heardOffsetOf(map, T), alt,
                     handQ: Math.max(aS / q, Math.min(bS / q, T0 / q + free)) };
        },
        parts: {
            preview: res => {
                // The tab rides the hand; the badge names the landing.
                // The mark moved under the overlay's key: poisoned, it
                // rebuilds once the gesture lets go.
                o._key = 'top-drag';
                placeTopMark(mark, res.handQ, e.view, strip.clientWidth);
                if (!badge) {
                    badge = el('div', 'region-badge mono');
                    o.appendChild(badge);
                }
                setText(badge, '↺ on ' + fmtFineQ(res.T / q) + 'Q · shift ' +
                    fmtSignedQ(res.shift / q) + 'Q' + (res.alt ? ' · fine' : ''));
                const w = strip.clientWidth;
                setStyle(badge, 'left',
                    badgeLeft(xOf(res.T / q, e.view, w), badge.offsetWidth, w));
                pv.show({ top: res.T, originShift: res.shift });
            },
            commit: res => sender.commit(res.shift, res.T),
            restore: () => sender.restore({ top: topStored, originShift: 0 }),
            held: res => {
                // The landing, the stale chrome under it taking no press.
                placeTopMark(mark, (res ? res.T : T0) / q, e.view, strip.clientWidth);
                dropBadge();
                o.classList.add('drag-held');
            },
            teardown: () => {
                dropBadge();
                o.classList.remove('drag-held');
            },
        },
        freeze: [strip],
        ...hooks,
    }));
}

/* ---------- the paint ---------- */

/** The take's content for a strip: MIDI notes when the clip has them,
 * else the peaks; null when there is nothing to draw. */
function stripContent(peaks, midi) {
    const notes = midi && midi.notes && midi.notes.length ? midi.notes : null;
    const content = notes || peaks;
    return content && content.length ? { notes, content } : null;
}

/** Draw the VISIBLE slice of the take in the detail strip — its
 * waveform at ONE gain per take (a slice never rescales against its own
 * loudest peak), or with `midi` ({notes, range}, Q units over `totalQ`)
 * the note bars over a velocity lane. The canvas is exactly strip-wide
 * and re-sampled for each view, keyed on it: a still view redraws
 * nothing. */
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
    // The SAME per-column sampler the lane's reveal draws with
    // (map_bands revealColumns): the two raw surfaces cannot drift
    // apart, and a pan or zoom never re-quantizes the picture.
    const key = 'p:' + v.q0 + ':' + v.spanQ + ':' + w + ':' + h + ':' + isComposite;
    if (wave._peaksRef === peaks && wave._dk === key) return;
    wave._peaksRef = peaks;
    wave._dk = key;
    canvas.style.width = w + 'px';
    const { cols, boost } = revealColumns(peaks, totalQ, v.q0, v.q0 + v.spanQ, w);
    drawEnvelope(canvas, cols, { cssWidth: w, cssHeight: h, isComposite,
                                 fixedBoost: boost });
}

/** The navigator's region marks (keyed): the kept segments as solid
 * blocks, each inner cut marked in the gap between them. */
function paintOverviewMarks(ov, segs, active, totalQ) {
    const marks = ov.querySelector('.region-ov-marks');
    const key = JSON.stringify([segs, active, totalQ]);
    if (marks._key === key) return;
    marks._key = key;
    marks.textContent = '';
    const span = (cls, s, e) => {
        const k = el('div', cls);
        k.style.left = pct(s, totalQ);
        k.style.width = pct(e - s, totalQ);
        marks.appendChild(k);
    };
    for (const [s, e] of segs) span('region-ov-kept' + (active ? '' : ' whole'), s, e);
    for (const [s, e] of innerCuts(segs, totalQ)) span('region-ov-cut', s, e);
}

/** The ↺'s tick on the overview (per paint: it follows a start-marker
 * drag's preview) — wherever the panel offers the ↺ (`withTop`). */
function paintOverviewTop(ov, lane, withTop, totalQ) {
    const tick = ov.querySelector('.region-ov-top');
    const show = withTop && totalQ > 0 && Number.isFinite(lane.topQ);
    setStyle(tick, 'display', show ? '' : 'none');
    if (show) setStyle(tick, 'left', pct(lane.topQ, totalQ));
}

/** The detail view as a box on the overview. */
function paintViewBox(ov, v, totalQ) {
    const box = ov.querySelector('.region-viewbox');
    setStyle(box, 'left', pct(v.q0, totalQ));
    setStyle(box, 'width', pct(v.spanQ, totalQ));
}

/** Whole-Q gridlines (panel_view gridStep / gridLines — no sub-Q grid)
 * and, from Q_LABEL_MIN_PX_PER_Q up, small whole-Q numbers. Keyed on
 * the view and width. */
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

/** The amber sound cursors in raw coordinates (per paint): the
 * overview's over the whole take; the detail's through the view —
 * hidden outside it. The detail cursor is made ONCE and lives outside
 * the keyed overlay: a rebuild never leaves a fresh, unplaced cursor,
 * and a panel drag's `.drag-live` never hides it. */
function patchCursors(row, lane, vm, aux, v) {
    const strip = row._region.strip;
    let cur = strip.querySelector(':scope > .region-cursor');
    if (!cur) {
        cur = el('div', 'region-cursor');
        cur.style.display = 'none';
        strip.appendChild(cur);
    }
    const ovCur = row._region.overview.querySelector('.region-ov-cursor');
    const node = aux && aux.nodesById ? aux.nodesById.get(lane.id) : null;
    const rawQ = vm.isPlaying ? rawCursorQ(lane, vm, node) : null;
    const totalQ = lane.bandTotalQ;
    placeCursor(ovCur, rawQ === null ? null : rawQ / totalQ);
    placeCursor(cur, rawQ === null ? null : (rawQ - v.q0) / v.spanQ,
        v.q0 + ':' + v.spanQ);
}
