/**
 * THE REGION PANEL (owner-ruled 2026-09-11) — the loop region's
 * overview + coarse editor, shown under the SELECTED lane.
 *
 * A heard-view lane shows only what sounds; the whole raw take and the
 * map's structure need a home that never rescales the lane. The panel
 * is that home: a viewport-wide strip pinned under the selected
 * clip/group, drawing the ENTIRE raw take (waveform, or a MIDI clip's
 * piano roll over its velocity lane), the excluded
 * material dimmed, the kept region as a bright box with bracket
 * handles, every inner cut as a band, and the amber sound cursor in raw
 * coordinates. It appears when the track is selected — the affordance
 * IS the selection — and goes away with it (Escape, a click on empty
 * canvas, or a click on the top bar's empty space).
 *
 * Gestures (one law with the lane, map_core.js):
 *   - drag a bracket        TRIM (period snaps to whole Qs; ⌥ = slide)
 *   - drag the kept box     SLIDE the whole region by whole Qs
 *                           (⌥ = any amount), length held
 *   - drag a cut's chip     slide the cut; its handles resize it;
 *                           right-click / double-click heals
 *   - double-click material a 1Q cell cut there
 * The strip is a raw-framed band host (cycleQ = totalQ, anchor 0), so
 * the cut bands and dblclick creation are the lane's own code. Live
 * commits stream while dragging; the lane above renders the audible
 * result as it changes — overview and detail, both live.
 *
 * Positioning: the panel row spans the zoomed grid width; the panel
 * itself is pinned to the VIEWPORT by JS (patch + scroll), like the
 * nav dock it replaces (horizontal sticky misplaced in the webview).
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setText, setStyle, snapThenAnimate } from './sv_util.js';
import { isOverlayFrozen, isDragging } from './gesture.js';
import { selectOnly, activeSelectedId } from './selection.js';
import { drawWaveform, drawMidiTile, MIDI_VELOCITY_LANE } from '../canvas_renderer.js';
import { sliceNotesToTile } from '../midi_notes.js';
import { dimComplementInto } from './dims.js';
import { innerCuts, slideSegs } from '../map_edit.js';
import { bandState, coveredSegs, laneMapActive, rawCursorQ, commitBandSegs,
         newGesture, runRawDrag, trimMoveFn, slideMoveFn } from './map_core.js';
import { wireBandCreate, appendCutBands } from './map_bands.js';

/* The panel's inset from the viewport's edges (px). */
const PANEL_MARGIN_PX = 12;
/* Waveform vertical inset inside the strip (px). */
const STRIP_V_INSET_PX = 4;
/* Arrow-key nudges within this window chain off the last target sent
 * (the poll that would refresh the band state may not have run). */
const NUDGE_CHAIN_MS = 800;

/** Build the panel row once per lane (lane_build). Hidden until the
 * lane is selected and has a take to show. */
export function buildRegionPanel(row) {
    const nav = el('div', 'lane-region');
    nav.style.display = 'none';
    const panel = el('div', 'region-panel');
    // A press in the panel must never fall through to the lane below.
    panel.addEventListener('pointerdown', e => e.stopPropagation());
    const label = el('div', 'region-label mono');
    const strip = el('div', 'region-strip');
    const wave = el('div', 'region-wave');
    wave.appendChild(document.createElement('canvas'));
    const overlay = el('div', 'region-overlay overlay-layer');
    strip.append(wave, overlay);
    panel.append(label, strip);
    nav.appendChild(panel);
    row._regionPanel = panel;
    row._regionStrip = strip;
    row._regionOverlay = overlay;
    row._regionLabel = label;
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
 * (cycleQ = totalQ, anchored at 0). */
function stripLane(lane) {
    return {
        id: lane.id, kind: lane.kind,
        bandSegs: lane.bandSegs, bandTotalQ: lane.bandTotalQ,
        bandEditable: lane.bandEditable, bandHeard: false,
        bandPeriodQ: 0, takeStartQ: 0,
        intrinsicQ: lane.bandTotalQ,
    };
}

/** Patch one lane's panel per poll: visibility, viewport pinning, the
 * raw waveform, the region chrome (keyed), the cursor. */
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

    const totalQ = lane.bandTotalQ;
    const sl = stripLane(lane);
    const st = bandState(sl, vm, totalQ);
    const segs = coveredSegs(st);
    const periodQ = segs.reduce((n, [a, b]) => n + (b - a), 0);
    const active = laneMapActive(lane);
    const bypassed = !!(lane.window && lane.window.bypassed);
    // The label names the region: what is kept of what exists.
    setText(row._regionLabel,
        (active ? 'loop ' + fmtQ(periodQ) + 'Q'
            : bypassed ? 'bypassed ' + fmtQ(periodQ) + 'Q' : 'whole take') +
        ' · ' + fmtQ(totalQ) + 'Q take' +
        (lane.mapMulti || innerCuts(st.segs, totalQ).length ? ' · cuts' : ''));
    row._regionLabel.title = active
        ? 'The kept region of this track\'s take: drag the box to slide ' +
          'it, its brackets to trim, double-click to cut'
        : bypassed
            ? 'The loop region is bypassed — the whole take sounds. The ' +
              'lane\'s chip re-activates it; the box still edits it'
            : 'This track loops its whole take: drag a bracket in to make a ' +
              'loop region, double-click to cut';

    // The raw take across the strip: the waveform, or a MIDI clip's
    // piano roll + velocity lane (the lane tiles' picture, unsliced).
    const midi = lane.isMidi && aux && aux.midiNotes
        ? aux.midiNotes.get(lane.id) || null : null;
    drawStripWave(row._regionStrip, peaks, lane.kind === 'group', midi, totalQ);

    // Creation (dblclick) reads per-patch state; must refresh before
    // any early return.
    wireBandCreate(strip, sl, vm, totalQ);
    patchCursor(row._regionOverlay, lane, vm, aux);
    if (isOverlayFrozen(strip)) return;
    const key = JSON.stringify(['region', lane.bandSegs, totalQ, active,
                                lane.bandEditable, vm.quantum]);
    const o = row._regionOverlay;
    if (o._key === key) return;
    o._key = key;
    o.textContent = '';
    o.appendChild(el('div', 'region-cursor'));
    // The panel's chrome carries its OWN class vocabulary (region-*):
    // lane-row-scoped queries for a lane's brackets/dims — tests, the
    // [ ] teleport walk — must never find the panel's.
    if (active) dimComplementInto(o, totalQ, segs, 0, totalQ, 'region-dim');
    // The kept box: the span from the first kept sample to the last —
    // grab it to SLIDE the region (bands and handles sit above it).
    const a = segs[0][0];
    const b = segs[segs.length - 1][1];
    const kept = el('div', 'region-kept' + (active ? '' : ' whole'), {
        title: st.editable
            ? 'Drag to slide the loop region (whole Qs; ⌥ = any amount)'
            : '' });
    kept.style.left = pct(a, totalQ);
    kept.style.width = pct(b - a, totalQ);
    o.appendChild(kept);
    if (!st.editable) return;
    kept.addEventListener('pointerdown', ev => {
        if (isDragging(strip)) return;
        selectOnly(lane.id);
        const grabQ = rawQAtStrip(strip, ev.clientX, totalQ);
        runRawDrag(ev, o, st, {
            rawQAt: x => rawQAtStrip(strip, x, totalQ),
            view: () => ({ q0: 0, spanQ: totalQ }),
            onMove: slideMoveFn(st, segs, grabQ),
            freeze: [strip],
            engage: true,
        });
    });
    // The brackets: trim (period-snapped), ⌥ slides.
    for (const edge of ['start', 'end']) {
        const bound0 = edge === 'start' ? a : b;
        const br = el('div', 'region-bracket ' + edge +
            (active ? '' : ' latent'), {
            title: (edge === 'start'
                ? 'Loop START — drag to trim (whole-Q snap)'
                : 'Loop END — drag to trim (whole-Q snap)') +
                ' · ⌥-drag slides the region (length held)' });
        br.style.left = pct(bound0, totalQ);
        br.addEventListener('pointerdown', ev => {
            if (isDragging(strip)) return;
            selectOnly(lane.id);
            runRawDrag(ev, o, st, {
                rawQAt: x => rawQAtStrip(strip, x, totalQ),
                view: () => ({ q0: 0, spanQ: totalQ }),
                onMove: trimMoveFn(st, segs, edge, bound0),
                freeze: [strip],
                engage: true,
            });
        });
        o.appendChild(br);
    }
    // Inner cuts as bands (the lane's raw-frame band code, unchanged).
    appendCutBands(o, sl, vm, strip, totalQ);
}

/** Pointer x → raw Q on the strip (unclamped; the runner clamps). */
function rawQAtStrip(strip, clientX, totalQ) {
    const r = strip.getBoundingClientRect();
    return r.width > 0 ? ((clientX - r.left) / r.width) * totalQ : 0;
}

/** Draw the whole take across the strip — its waveform, or with `midi`
 * ({notes, range}, Q units over `totalQ`) the note bars over a
 * velocity lane. Redraws only when the content identity or the strip
 * size changes. */
function drawStripWave(strip, peaks, isComposite, midi = null, totalQ = 0) {
    const wave = strip.querySelector('.region-wave');
    const canvas = wave.firstElementChild;
    const w = strip.clientWidth;
    const h = strip.clientHeight - STRIP_V_INSET_PX;
    const notes = midi && midi.notes && midi.notes.length ? midi.notes : null;
    const content = notes || peaks;
    if (!content || !content.length || !(w > 0)) {
        if (canvas.style.display !== 'none') canvas.style.display = 'none';
        return;
    }
    if (canvas.style.display !== '') canvas.style.display = '';
    const key = content.length + ':' + w + ':' + h + ':' + isComposite +
        (notes ? ':m' + midi.range.lo + '-' + midi.range.hi + ':' +
            totalQ.toFixed(4) : '');
    if (wave._peaksRef === content && wave._dk === key) return;
    wave._peaksRef = content;
    wave._dk = key;
    canvas.style.width = w + 'px';
    if (notes) {
        drawMidiTile(canvas, sliceNotesToTile(notes, totalQ, null),
            { cssWidth: w, cssHeight: h, range: midi.range,
              velocityLane: MIDI_VELOCITY_LANE });
    } else {
        drawWaveform(canvas, peaks, { cssWidth: w, cssHeight: h, isComposite });
    }
}

/** The amber sound cursor in raw coordinates (per poll; glides with the
 * same transition the lane cursors use, snaps on a wrap). */
function patchCursor(o, lane, vm, aux) {
    const cur = o.querySelector(':scope > .region-cursor');
    if (!cur) return;
    const show = vm.isPlaying;
    setStyle(cur, 'display', show ? '' : 'none');
    if (!show) return;
    const node = aux && aux.nodesById ? aux.nodesById.get(lane.id) : null;
    const rawQ = rawCursorQ(lane, vm, node);
    if (rawQ === null) return;
    const frac = rawQ / lane.bandTotalQ;
    if (cur._frac !== undefined && frac < cur._frac - 0.02) snapThenAnimate(cur);
    cur._frac = frac;
    setStyle(cur, 'left', (frac * 100) + '%');
}

/** Pin the panel to the viewport horizontally: the row spans the
 * zoomed grid; the panel sits at (viewport left + margin) with the
 * viewport's width minus margins. */
function pinToViewport(row, nav) {
    const panel = row._regionPanel;
    const session = ctx.els.session;
    if (!panel || !session) return;
    const sr = session.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    if (!(sr.width > 0) || !(nr.width > 0)) return;
    const left = Math.max(0, Math.round(sr.left + PANEL_MARGIN_PX - nr.left));
    const width = Math.max(120, Math.round(Math.min(
        sr.width - 2 * PANEL_MARGIN_PX, nr.right - (nr.left + left))));
    const l = left + 'px';
    const w = width + 'px';
    if (panel.style.left !== l) panel.style.left = l;
    if (panel.style.width !== w) panel.style.width = w;
}

/** ← / → (init.js): slide the selected track's loop region by
 * `deltaQ` (length held, clamped to the take — slideSegs). Reads the
 * strip's per-patch band state, so it works exactly when the panel
 * does. One undo step per press. Returns false when nothing applies
 * (no panel, not editable, nothing to slide) so the key falls through. */
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
    commitBandSegs(st, segs, true);
    return true;
}

/** The panels track horizontal scroll live (the 50ms patch would lag
 * a flick); rAF-coalesced. */
export function wireRegionScroll() {
    let raf = 0;
    ctx.els.session.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            ctx.laneEls.forEach(row => {
                const nav = row.querySelector(':scope > .lane-region');
                if (nav && nav.style.display !== 'none') pinToViewport(row, nav);
            });
        });
    }, { passive: true });
}
