/**
 * Lane body: the per-lane grid area — gridlines, rep tiles (waveform
 * canvases: material, ghosts, the live recording bar, map-sliced
 * content), the overlay layer (window brackets + trim grips, cut
 * bands and seams, the arm marker, the sound cursor, sequence-step
 * dims and cue hairlines, the window/map chips), and the composite
 * canvas a group row draws.
 *
 * RECONCILED IN LAYERS, never nuked: destroying and recreating every
 * gridline/rep/canvas on any key change would make commits render as a
 * global "pop". Rep divs are REUSED — position updates morph via CSS
 * transitions — and canvases redraw only when their own peaks/geometry
 * change.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setStyle, snapThenAnimate, approxQ } from './sv_util.js';
import { drawWaveform, drawEnvelope, drawMidiTile, mappedColumns, peaksBoost,
         canvasCssSize, MIDI_VELOCITY_LANE } from '../canvas_renderer.js';
import { sliceNotesToTile } from '../midi_notes.js';
import { generateCompositeWaveform } from '../composite_waveform.js';
import { calculateStackLCM } from '../timeline_model.js';
import { oneTakeDuration, buildRulerTicks } from '../view_model.js';
import { liveBoost, PEAKS_PER_SECOND } from '../live_peaks.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { correctPosition } from '../playhead_clock.js';
import { isAnimRunning } from './animator.js';
import { buildWindowDims, dimComplementInto } from './dims.js';
import { wireBandCreate, appendCutBands, appendTrimGrips, patchRevealCursor }
    from './map_bands.js';
import { patchSpliceHandles } from './splice_handles.js';
import { wireWindow } from './window_edit.js';
import { isOverlayFrozen, isGestureLive } from './gesture.js';
import { mapDragPinQ } from './drag_pin.js';
import { appendCompCells, patchCompCanvases, compKey } from './comp_cells.js';

/* Surplus rep tiles fade out over this long before removal (instant
 * removal mid-morph leaves a momentary gap — the commit "squish"). */
const EXIT_FADE_MS = 220;
/* Content-swap cross-fade: the old canvas fades over the new one for
 * this long, and is removed a beat later. Intentionally longer than
 * the exit fade — it covers a re-render of the SAME audio. */
const CROSSFADE_MS = 240;
const CROSSFADE_REMOVE_MS = 320;
/* After the last sign of a map edit (mapEditInFlight) its re-layouts
 * keep arriving for a poll or two — the release commit's answer, the
 * frame settling on unpin — and still swap in place (≈ 8 polls). */
const EDIT_SETTLE_MS = 400;
/* A heard tile's edge within this many periods of a whole period IS
 * that period boundary (startQ / P carries float noise). */
const SPAN_SNAP = 1e-9;
/* Waveform draw height fallback / vertical inset (px). */
const BODY_H_FALLBACK_PX = 58;
const BODY_V_INSET_PX = 6;
/* Composite waveforms rasterize at this width (matches the peak count
 * app.js requests via getWaveform). */
const COMPOSITE_CANVAS_W = 800;
/* A multi-segment window cursor jump bigger than this snaps instead of
 * sweeping through the cut. */
const MULTI_JUMP_SNAP_Q = 0.3;
/* The recording bar never renders shorter than this (Q). */
const MIN_BAR_LEN_Q = 0.05;
/* Tiles never render thinner than this (px). */
const MIN_TILE_PX = 2;

function layersOf(body) {
    if (!body._layers) {
        const grid = el('div', 'body-layer grid-layer');
        const reps = el('div', 'body-layer reps-layer');
        const overlay = el('div', 'body-layer overlay-layer');
        body.append(grid, reps, overlay);
        body._layers = { grid, reps, overlay };
    }
    return body._layers;
}

/**
 * Redraw a rep canvas only when its peaks identity/length/size changed.
 * Returns true when it redrew (patchLaneBody uses this to snap instead
 * of morphing a re-laid-out tile). Options:
 *
 *   peaks       — the peaks array (identity-tracked; may grow in place
 *                 while recording). Transiently empty around a commit:
 *                 the last drawn content is KEPT (stale for a poll
 *                 beats blinking to nothing).
 *   cssWidth    — canvas CSS width (px)
 *   cssHeight   — canvas CSS height (px)
 *   isComposite — group composite tone (the summed stack)
 *   live        — the recording bar: fixed px-per-slot scale + the
 *                 ratcheting liveBoost normalization
 *   pxPerSlot   — live mode's fixed px per peak slot (0 = fit)
 *   map         — a heard tile's mapping (tileMap): `src`, the LIST of
 *                 [startFrac, endFrac] content ranges it plays in heard
 *                 order (phase 3: a multi-segment map concatenates its
 *                 slices, the heard-time picture); `rotFrac`, where the
 *                 loop's heard top sits in the period (heard tiles sit
 *                 on the frame grid); `u0`/`u1`, the tile's window onto
 *                 its period. Sampled only on redraw; identity tracking
 *                 stays on the ORIGINAL peaks array so polls don't
 *                 churn. Null = the whole take.
 *   isGhost     — EVERY ghost tile is an audible repetition ("ghosts
 *                 show what sounds") and draws in the cool ECHO tone —
 *                 warm hues are reserved for material (the take tile /
 *                 the live bar).
 *   crossfade   — false while a map edit is in flight
 *                 (mapEditInFlight): a new peaks identity then swaps in
 *                 place instead of fading the old canvas over it.
 *   midi        — a MIDI lane's notes (docs/vst3.md §11): {notes (Q
 *                 units, midi_notes.notesFromRows), range (the take's
 *                 pitch fit), intrinsicQ}. The tile paints note bars
 *                 instead of the envelope; `map` places the notes
 *                 exactly as it samples peaks. Identity-tracked on the
 *                 notes array like peaks.
 */
function drawRepCanvas(div, { peaks, cssWidth, cssHeight, isComposite,
                              live, pxPerSlot, map, isGhost,
                              crossfade = true, midi }) {
    let canvas = div.firstElementChild;
    if (midi && midi.notes && midi.notes.length) peaks = midi.notes;
    if (!peaks || !peaks.length) {
        // Peaks can be transiently empty around a commit (cache regen /
        // fetch in flight): KEEP the last drawn content — stale for a
        // poll beats blinking to nothing
        div._peaksRef = null;
        div._dk = null;
        return false;
    }
    if (!canvas) {
        canvas = document.createElement('canvas');
        div.appendChild(canvas);
    }
    // Peaks arrays are replaced on refetch (new ref) and mutated in place
    // while recording (same ref, growing length) — both covered here.
    // The map inputs key at FULL precision: the sampler is exact, so a
    // rounded key would leave a sub-1e-4 edit drawn stale.
    const dk = peaks.length + ':' + Math.round(cssWidth) + ':' +
        Math.round(cssHeight) + ':' + isComposite + ':' + !!live + ':' +
        Math.round((pxPerSlot || 0) * 1000) + ':' +
        (map ? JSON.stringify(map) : '') +
        ':' + !!isGhost +
        (midi ? ':m' + midi.range.lo + '-' + midi.range.hi + ':' +
            (midi.intrinsicQ || 0) : '');
    if (div._peaksRef === peaks && div._dk === dk) return false;

    // CONTENT SWAP → CROSS-FADE: a new peaks array replacing an old one
    // (live meter peaks → fetched waveform at commit; composite regen)
    // is a re-rendering of the same audio with features shifted a few
    // px — a hard swap reads as squish/stretch. The old canvas fades
    // out over the new one. NOT under a map edit (crossfade false):
    // there the new identity is the edit itself (a member's splice
    // regenerating its group's composite), and a fading old canvas is
    // a double image on every live commit (flash-chrome F9).
    if (wantsCrossfade({ live, crossfade, prev: div._peaksRef, peaks,
                         drawn: canvas.width > 0 })) {
        const old = canvas;
        old.style.transition = 'opacity ' + CROSSFADE_MS + 'ms linear';
        requestAnimationFrame(() => { old.style.opacity = '0'; });
        setTimeout(() => old.remove(), CROSSFADE_REMOVE_MS);
        canvas = document.createElement('canvas');
        div.insertBefore(canvas, old); // new below; old fades on top
    }
    div._peaksRef = peaks;
    div._dk = dk;
    // Pinned, like the live bar: the div's transition reveals/clips
    // the canvas — stretching it mid-morph would distort the content
    canvas.style.width = Math.round(cssWidth) + 'px';
    if (live) {
        // Smoothed ratcheting normalization (live_peaks.liveBoost):
        // converges to the committed boost, so commit doesn't pop. The
        // FIXED px-per-slot scale pins every drawn peak to its slot's
        // pixels for the life of the take (poolColumns fixed mode).
        div._liveBoost = liveBoost(div._liveBoost, peaks);
        drawWaveform(canvas, peaks, { cssWidth, cssHeight,
            fixedBoost: div._liveBoost, pxPerPeak: pxPerSlot || undefined });
        return true;
    }
    if (div._liveBoost !== undefined) delete div._liveBoost;
    if (midi) {
        // The piano-roll tile: the envelope's exact mapping (srcSegs,
        // rotation, the tile's window onto its period), then bars
        // instead of peaks.
        drawMidiTile(canvas,
            map ? sliceNotesToTile(midi.notes, midi.intrinsicQ, map.src,
                                   map.rotFrac, map)
                : sliceNotesToTile(midi.notes, midi.intrinsicQ, null),
            { cssWidth, cssHeight, isEcho: !!isGhost, range: midi.range,
              velocityLane: MIDI_VELOCITY_LANE });
        return true;
    }
    // Tone follows GHOSTNESS, not segment-ness: a heard-view lane's
    // bright tile carries a map (it draws the window segment) but is
    // the sounding material — warm tape, not the cool echo tone. ONE
    // GAIN PER TAKE (peaksBoost): every committed tile of a take —
    // whole, heard slice, repeat — draws at the whole take's boost, so
    // a loud hit entering or leaving a loop never rescales the lane.
    const opts = { cssWidth, cssHeight, isComposite, isEcho: !!isGhost,
                   fixedBoost: peaksBoost(peaks) };
    if (map) {
        // Map content draws only its segment(s), sampled PER COLUMN
        // through the map (mappedColumns — exact, never whole-peak
        // slices rotated and refit to the tile).
        drawEnvelope(canvas,
            sharedTileColumns(peaks, canvasCssSize(canvas, opts).cssW, map),
            opts);
    } else {
        drawWaveform(canvas, peaks, opts);
    }
    return true; // redrew
}

/* The last heard tile's columns: the full repeats of one lane draw the
 * same columns (their windows differ by whole periods only), so a
 * lane of twenty repeats samples once per redraw, not twenty times. */
let columnMemo = null;

/** mappedColumns, shared across tiles whose window onto the period
 * has the same phase and span (drawEnvelope never mutates columns). */
function sharedTileColumns(peaks, cssW, map) {
    // peaks.length: an array growing in place keeps its identity.
    const key = cssW + ':' + peaks.length + ':' + JSON.stringify([map.src,
        map.rotFrac, posMod(map.u0, 1), map.u1 - map.u0]);
    if (columnMemo && columnMemo.peaks === peaks && columnMemo.key === key) {
        return columnMemo.cols;
    }
    const cols = mappedColumns(peaks, cssW, map);
    columnMemo = { peaks, key, cols };
    return cols;
}

/**
 * Should a content swap cross-fade? Only a committed tile whose PEAKS
 * IDENTITY changed under an already-drawn canvas, and never while a
 * map edit is in flight (`crossfade` false). Pure; exported for the
 * tests.
 */
export function wantsCrossfade({ live, crossfade, prev, peaks, drawn }) {
    return !live && crossfade !== false && !!prev && prev !== peaks && !!drawn;
}

/**
 * A heard tile's window onto its loop's period: [startQ, endQ) / P.
 * Heard tiles tile from the frame's 0 at the heard period
 * (heardViewFields: unrollReps with offsetQ 0), and srcTopFrac is
 * measured on that same grid, so a full tile spans exactly one period
 * and a tile the frame clips (a pinned frame mid-trim) shows the
 * LEADING part of its period — never the whole period squeezed into
 * the clipped width, which the old whole-array stretch drew. Edges
 * within SPAN_SNAP of a whole period snap to it (startQ / P carries
 * float noise that would otherwise read as a sliver of the previous
 * period). Exported for the tests.
 *
 * @param {{startQ: number, endQ: number}} rep
 * @param {number} periodQ the heard period (lane.periodQ); ≤ 0 falls
 *     back to the tile's own length (one full period)
 * @returns {{u0: number, u1: number}}
 */
export function tileSpan(rep, periodQ) {
    const P = periodQ > 0 ? periodQ : rep.endQ - rep.startQ;
    if (!(P > 0)) return { u0: 0, u1: 1 };
    const snap = u => {
        const k = Math.round(u);
        return Math.abs(u - k) < SPAN_SNAP ? k : u;
    };
    return { u0: snap(rep.startQ / P), u1: snap(rep.endQ / P) };
}

/**
 * The tile's CSS width (px) as patchLaneBody lays it out: its share of
 * the body, never thinner than MIN_TILE_PX. With canvasCssSize this is
 * the column count the tile's sampler fills. Exported for the tests.
 */
export function tileCssWidth(bodyW, rep, cycleQ) {
    return Math.max(MIN_TILE_PX, bodyW * (rep.endQ - rep.startQ) / cycleQ);
}

/**
 * A rep's MAPPING for the samplers (mappedColumns / sliceNotesToTile):
 * its content slices (`srcSegs`), the loop top's rotation
 * (`srcTopFrac`) and its window onto the heard period (tileSpan) — or
 * null for a tile that draws the whole take.
 *
 * @param {Object} rep a view-model rep
 * @param {number} periodQ the lane's heard period (lane.periodQ)
 * @returns {?{src: Array<[number, number]>, rotFrac: number, u0: number, u1: number}}
 */
export function tileMap(rep, periodQ) {
    if (!rep.srcSegs) return null;
    return { src: rep.srcSegs, rotFrac: rep.srcTopFrac || 0,
             ...tileSpan(rep, periodQ) };
}

/**
 * The pooled column amplitudes a committed HEARD tile draws (before
 * the take's boost and the envelope shaping) — drawRepCanvas's own
 * path (tileMap → the shared mappedColumns), exported so the invariant
 * test (heard_tile_sampler.test.mjs) measures exactly what the lane
 * paints.
 */
export function heardTileColumns(peaks, rep, periodQ, cssW) {
    return sharedTileColumns(peaks, cssW, tileMap(rep, periodQ));
}

/* Each lane's map geometry at the last patch (mapGeometry, by lane id)
 * and the performance.now() of the last sign of a map edit. Module
 * state, not per-body: a group's map edit re-lays its MEMBERS' tiles
 * too, and their rows see no freeze or hold of their own. */
let lastGeometry = null;
let editSeenAt = -Infinity;
const vmsSeen = new WeakSet();

/** lane id → its map geometry (what a map edit changes). */
function mapGeometry(vm) {
    const out = new Map();
    for (const l of vm.lanes || []) {
        out.set(l.id, JSON.stringify([l.bandSegs || null, l.mapSegs || null]));
    }
    return out;
}

/** Did any lane present in both views change its map geometry? Lanes
 * appearing or leaving (a new track, a fold, a delete) are not map
 * edits — their re-lays keep the settle fade. */
function geometryChanged(prev, next) {
    for (const [id, g] of next) {
        if (prev.has(id) && prev.get(id) !== g) return true;
    }
    return false;
}

/**
 * IS A MAP EDIT IN FLIGHT? (flash-chrome F9, 2026-09-23.) True while
 * any map/window gesture is live (gesture.js — every beginGesture site
 * is one), the frame pin is held (drag_pin.js), this lane's overlay or
 * its region panel's strip is frozen or held for a commit, or the map
 * geometry of any lane changed since the last patch (a ← / → nudge, an
 * undo, the release commit landing) — and for EDIT_SETTLE_MS after
 * the last such sign. While true, patchLaneBody removes surplus tiles
 * at once and content swaps skip the cross-fade: each live splice
 * re-lays the heard tiles, and a fading copy of the old layout over
 * the new one is a double image on every whole-Q trim step.
 *
 * @param {?Element} row the lane row (its region panel's strip is read)
 * @param {?Element} body the lane body
 * @param {?Object} vm the view model being patched (its lanes' map
 *     geometry is compared once per view model)
 * @param {number} [now] performance.now() (injectable for the tests)
 * @returns {boolean}
 */
export function mapEditInFlight(row, body, vm, now = performance.now()) {
    if (vm && !vmsSeen.has(vm)) {
        vmsSeen.add(vm);
        const geometry = mapGeometry(vm);
        if (lastGeometry && geometryChanged(lastGeometry, geometry)) {
            editSeenAt = now;
        }
        lastGeometry = geometry;
    }
    const strip = row && row._regionStrip;
    if (isGestureLive() || mapDragPinQ() !== null ||
        (body && isOverlayFrozen(body)) || (strip && isOverlayFrozen(strip))) {
        editSeenAt = now;
    }
    return now - editSeenAt < EDIT_SETTLE_MS;
}

/**
 * Retire the surplus rep divs past the first `keep` live ones: FADE
 * them out through the settle (instant removal while the surviving
 * tile is still mid-morph leaves a momentary gap — the group lane's
 * "squish" at commit, a DOM-layer effect, not a state one) — or, while
 * a map edit is in flight (`instant`), remove them at once (the fade
 * is a double image of the old layout over each live re-layout).
 * Returns the kept divs. Exported for the tests.
 */
export function retireSurplusTiles(repsL, keep, instant) {
    const live = [...repsL.children].filter(d => !d._exiting);
    for (let i = live.length - 1; i >= keep; i--) {
        const d = live[i];
        if (instant) {
            d.remove();
            continue;
        }
        d._exiting = true;
        d.style.opacity = '0';
        setTimeout(() => d.remove(), EXIT_FADE_MS);
    }
    // A fade begun just before the edit goes now too (its timer's
    // remove() of a detached node is a no-op).
    if (instant) {
        for (const d of [...repsL.children]) if (d._exiting) d.remove();
    }
    return live.slice(0, keep);
}

/**
 * The lane's gridlines — the ruler's Q lines (view_model
 * buildRulerTicks) minus the frame's edges — PLACED on every patch in
 * reused elements, never rebuilt: while the frame settles each line
 * sits at (line − zero) / Q, so the grid scrolls with the tiles, frame
 * by frame, and at rest a patch writes nothing (setStyle skips equal
 * values). Edge suppression is epsilon-tolerant like the ruler's
 * cycle-end label.
 */
function patchGridlines(grid, ticks, cycleQ) {
    const lines = grid._lines || (grid._lines = []);
    let n = 0;
    for (const t of ticks) {
        if (approxQ(t.q, 0) || approxQ(t.q, cycleQ)) continue;
        let d = lines[n];
        if (!d || d.parentNode !== grid) {
            d = el('div', 'gridline');
            grid.appendChild(d);
            lines[n] = d;
        }
        setStyle(d, 'left', pct(t.q, cycleQ));
        d.classList.toggle('major', !!t.major);
        n++;
    }
    for (const d of lines.splice(n)) d.remove();
}

/** Keep `container`'s children to exactly the built descriptors. */
function reconcileMarkers(container, key, build) {
    if (container._key === key) return;
    container._key = key;
    container.textContent = '';
    build(container);
}

/**
 * Patch one lane's body: state classes, grid layer, reps layer, the
 * splice layer (splice_handles.js: a heard lane's splice handles and ↺,
 * and a plain loop's lone ↺, outside the keyed overlay), then ONE of
 * three overlay branches, checked in this order:
 *
 *   1. heard-view chrome (lane.windowChipQ && !windowEditing): the chip
 *      (and a one-shot's edge grips + seam handles) — then return.
 *   2. multi-segment map on a group (lane.mapSegs): dims + seam ticks
 *      + one bypass chip + cut bands — then return.
 *   3. the bracket overlay: the lane's window, or the LATENT full-span
 *      window a resting take offers (latentWindow), or — when neither
 *      exists — just the arm marker and cut bands over the take. (A
 *      plain loop's ↺ sits on the latent start bracket, grabbed by its
 *      tab only, so the bracket keeps its press.)
 *
 * The heard-time cursor is patched every poll OUTSIDE the keyed
 * rebuilds, and BEFORE the isOverlayFrozen gates — a frozen overlay
 * still shows where the sound is. The overlay itself is NEVER rebuilt
 * under an active drag (the captured node would orphan the gesture),
 * nor during the post-release HOLD (gesture.js holdOverlay) while
 * the engine has not yet answered the commit.
 */
export function patchLaneBody(row, lane, vm, aux) {
    if (lane.kind === 'add' || lane.kind === 'fx' || lane.kind === 'seq') {
        return;
    }
    const body = row.querySelector('.lane-body');
    // Per-lane scale (law 13 amendment): a window-EDITING lane shows its
    // full raw take on its own horizontal frame — an inspector, not a
    // timeline. Everything below maps through this local cycle.
    const cycleQ = lane.frameQ || vm.cycleQ;
    // The file-drop handler (lane_build.js) maps its x through this
    // frame: an import lands on the Q the pointer is over.
    body._cycleQ = cycleQ;
    const { grid, reps: repsL, overlay } = layersOf(body);
    const bodyW = body.clientWidth;
    const peaks = lanePeaks(lane, aux, bodyW);
    const bodyH = body.clientHeight - BODY_V_INSET_PX || BODY_H_FALLBACK_PX;
    // The raw take's peaks, for the surfaces that draw the WHOLE take
    // (the same-scale reveal, map_bands.js; the region panel, patch.js).
    body._peaks = peaks;
    body._isGroup = lane.kind === 'group';

    // State classes (idempotent via classList.toggle)
    body.classList.toggle('win-bypassed', !!(lane.window && lane.window.bypassed));
    body.classList.toggle('win-suspended', !!(lane.window && lane.window.suspended));
    body.classList.toggle('one-shot', !!lane.oneShot);
    body.classList.toggle('is-recording', !!lane.recording);
    body.classList.toggle('armed-empty',
        lane.kind === 'clip' && !lane.recording && lane.reps.length === 0 && lane.armed);
    // Inspector honesty: an edit-view lane frames its raw take on its
    // own scale — the global playhead is suppressed over it (stacking,
    // see .inspecting) and the amber heard cursor is its one honest
    // cursor.
    body.classList.toggle('inspecting', !!lane.windowEditing);

    // Grid layer: the ruler's Q lines, placed on every patch — they
    // glide with the tiles while the frame settles (patchGridlines). A
    // raw-framed lane (comp mode's inspector) shows raw time, which a
    // settle never moves: its lines stay at their resting places.
    patchGridlines(grid, lane.frameQ
        ? buildRulerTicks(vm.qEstablished, vm.cycleQ) : vm.ruler.ticks, cycleQ);

    // SEQUENCE DIMS (docs/sequencer.md §9 — the lanes are the DISPLAY):
    // an enclosing sequence's gated-off spans dim this lane, tiled every
    // pass. A dedicated layer, so the three overlay paths below stay
    // untouched by the sequencer entirely.
    patchSeqDims(body, lane, cycleQ);

    // Reps layer: RECONCILE — reuse divs, update geometry in place.
    // The bar anchors at its Q boundary; in the first-take frame there
    // is no Q yet (quantum = 1 sample — rounding is meaningless and the
    // latency wobble would make the left edge vibrate), and the first
    // take by definition starts the timeline: anchor 0.
    const wantBar = lane.recording && !lane.pendingStart;
    const barStartQ = !vm.qEstablished ? 0
        : Math.max(0, Math.round(vm.playheadQ - lane.recordingLengthQ));
    // The bar's edge is "now" (the playhead) — the written content
    // (canvas) trails inside by the latency compensation, and the bar's
    // background marks the being-written zone. Ending the bar at
    // start+length would leave the playhead visibly ahead of the
    // waveform. A NEW TAKE (docs/takes.md) keeps the slot's resting
    // tiles beneath the bar, `silent` — the slot renders silence while
    // the take is live; a plain recording lane has none.
    const tiles = wantBar
        ? [...lane.reps, {
            startQ: barStartQ,
            endQ: Math.max(vm.playheadQ,
                barStartQ + Math.max(lane.recordingLengthQ, MIN_BAR_LEN_Q)),
            ghost: false, bar: true,
        }]
        : lane.reps;

    // Surplus tiles FADE OUT through the settle instead of vanishing —
    // except under a map edit, where they go at once and content swaps
    // skip the cross-fade (mapEditInFlight: each live splice re-lays
    // the tiles, and a fade is a double image of the old layout).
    const editing = mapEditInFlight(row, body, vm);
    const rows = retireSurplusTiles(repsL, tiles.length, editing);
    tiles.forEach((rep, i) => {
        let div = rows[i];
        if (!div) {
            div = document.createElement('div');
            // A fresh tile must appear AT its geometry, never animate
            // from width 0 (a commit that changes the tile count would
            // otherwise collapse the composite to zero, then expand it)
            snapThenAnimate(div);
            repsL.appendChild(div);
        }
        // A MIDI lane's resting tiles draw note bars from the fetched
        // notes (docs/vst3.md §11); the live bar and a retake's silent
        // tiles keep the velocity envelope.
        const midi = lane.isMidi && !rep.bar && !rep.silent && aux.midiNotes
            ? aux.midiNotes.get(lane.id) || null : null;
        const cls = 'rep' + (rep.ghost ? ' ghost' : '') +
            (rep.silent ? ' silent' : '') +
            (midi ? ' midi' : '') +
            (rep.bar
                ? ' recording-bar' + (lane.throughMap ? ' map-bar' : '')
                : '');
        if (div.className !== cls) div.className = cls;
        const noteCount = midi ? String(midi.notes.length) : '';
        if ((div.dataset.notes || '') !== noteCount) {
            if (noteCount) div.dataset.notes = noteCount;
            else delete div.dataset.notes;
        }
        // A silent tile draws the ACTIVE take from the per-take cache:
        // the lane's live array holds the new take's bar peaks.
        const tilePeaks = rep.silent
            ? (typeof aux.takePeaks === 'function'
                ? aux.takePeaks(lane.id, lane.activeTake || 0) : null)
            : peaks;
        // The live bar draws at a FIXED px-per-slot scale: a peak's
        // pixels are a function of its slot index only, never of the
        // growing count — fit-to-width would remap every column each
        // poll and the bar would vibrate (worst after a frame extension
        // shrinks the scale). The bar div's edge still advances
        // smoothly, ≤1 slot ahead of the canvas.
        let cssW = tileCssWidth(bodyW, rep, cycleQ);
        let pxPerSlot = 0;
        if (rep.bar && peaks && aux.sampleRate) {
            const slotQ = aux.sampleRate / (PEAKS_PER_SECOND * aux.vmQuantum);
            pxPerSlot = bodyW * slotQ / cycleQ;
            cssW = Math.max(MIN_TILE_PX, Math.ceil(peaks.length * pxPerSlot));
        }
        const redrew = drawRepCanvas(div, {
            peaks: tilePeaks, cssWidth: cssW, cssHeight: bodyH,
            isComposite: lane.kind === 'group', live: !!rep.bar, pxPerSlot,
            // The heard period (lane.periodQ) frames the tile's window
            // onto it — a frame-clipped tile shows its leading part.
            map: tileMap(rep, lane.periodQ),
            isGhost: !!rep.ghost,
            crossfade: !editing,
            // Notes slice on the RAW take (srcSegs are fractions of it),
            // not the heard period a windowed lane's intrinsicQ carries
            midi: midi ? { notes: midi.notes, range: midi.range,
                           intrinsicQ: lane.contentQ || lane.intrinsicQ || 0 } : null,
        });

        // MORPH ONLY PURE MOVES; SNAP RE-LAYOUTS. When the canvas was
        // redrawn AND the geometry changed in the same patch (a commit
        // or frame settle), animating the container over new content
        // reads as false motion (the composite visibly stretches at a
        // growing commit). Since px-per-Q is preserved across the
        // settle, snapping makes the change read as the ghost half
        // lighting up, not movement.
        const newLeft = pct(rep.startQ, cycleQ);
        const newWidth = pct(rep.endQ - rep.startQ, cycleQ);
        const geomChanged = div.style.left !== newLeft || div.style.width !== newWidth;
        if (redrew && geomChanged && !rep.bar) {
            snapThenAnimate(div);
        }
        setStyle(div, 'left', newLeft);
        setStyle(div, 'width', newWidth);
    });

    // Overlay layer: window brackets + arm marker (small, cheap rebuild).
    // NEVER rebuilt under an active bracket drag: the drag holds pointer
    // capture on a bracket element — replacing it mid-drag would orphan
    // the gesture (same node-replacement class as the setText law).
    const armedEmpty = (lane.kind === 'clip' && !lane.recording &&
        lane.reps.length === 0 && lane.armed) || (lane.recording && lane.pendingStart);
    // A pending NEW TAKE waits for the SLOT's top (view_model armAtQ),
    // not the next Q boundary.
    const retakePending = !!(lane.retake && lane.pendingStart);
    const armQ = (retakePending ? lane.armAtQ : vm.armAtQ) % cycleQ;
    // Cut-band creation is wired ONCE per body and reads per-patch
    // state — refresh it before any early return so a lane changing
    // views never leaves a stale (wrong-frame) editor behind.
    wireBandCreate(body, lane, vm, cycleQ);
    // THE SPLICE AND THE TOP (splice_handles.js, loop-region phase 2):
    // a heard lane's splice handles (drag = swap, ⇧ = length) and ↺
    // (drag = shift) — and a PLAIN loop's ↺ alone, over the bracket
    // overlay below — live in their own layer, positioned on every
    // patch BEFORE the frozen gates below — they move with a drag's
    // local preview and glide — and cleared off every other lane.
    patchSpliceHandles(body, overlay, lane, vm, cycleQ);
    // HEARD-VIEW chrome (law 13 amendment): a quiet chip, the splice
    // layer above; the whole raw take lives on the region panel under
    // the selected lane (region_panel.js).
    if (lane.windowChipQ && !lane.windowEditing) {
        // HEARD-VIEW chrome, MODELESS: the chip is the readout + bypass
        // toggle, as on every other lane (the raw take lives on the
        // region panel — the chip-click inspector retired 2026-09-13).
        // A ONE-SHOT keeps its edge grips (trim through the same-scale
        // reveal) and seam handles: its offset IS its placement (Q5),
        // so it has no splice to swap and no ↺ to shift. (The paired
        // `] [` grips, the "↺ loop top" chip and plain-drag trims on
        // the other lanes retired 2026-09-24 — time_maps.md §8.)
        const heardKey = JSON.stringify(
            ['heard', lane.bandSegs, lane.bandTotalQ, lane.windowChipQ,
             lane.mapMulti, cycleQ, lane.takeStartQ, lane.bandEditable,
             !!lane.oneShot, lane.reps.map(r => [r.startQ, r.endQ])]);
        // A revealing lane's amber cursor moves through the gesture
        // (the reconcile below is frozen; the ear isn't).
        patchRevealCursor(body, lane, vm, aux.nodesById.get(lane.id));
        if (isOverlayFrozen(body)) return;
        reconcileMarkers(overlay, heardKey, o => {
            const chip = el('div', 'win-chip win-heard-chip toggle', {
                title: 'Toggle the ' + (lane.mapMulti ? 'map' : 'window') +
                    ': active ↔ bypassed (the whole take sounds while ' +
                    'bypassed; the region panel below the selected track ' +
                    'edits it)',
                textContent: (lane.mapSuspended ? 'map · suspended (sequence off) · ' : '') +
                    (lane.mapMulti ? 'map ' : 'window ') +
                    fmtQ(lane.windowChipQ) + 'Q' });
            chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
            o.appendChild(chip);
            if (lane.oneShot) {
                appendTrimGrips(o, lane, vm, body, cycleQ);
                appendCutBands(o, lane, vm, body, cycleQ);  // heard → seams
            }
        });
        return;
    }
    // MULTI-SEGMENT map on a group (phase 3): dims over the uncovered
    // regions + segment boundary ticks + ONE chip (bypass toggle) + the
    // inner cuts as draggable BANDS. No per-segment brackets.
    if (lane.mapSegs) {
        const mapKey = JSON.stringify(
            ['map', lane.mapSegs, lane.mapBypassed, cycleQ,
             lane.bandEditable]);
        // The sound cursor keeps moving through a band drag (the
        // reconcile below is frozen, but the ear isn't).
        patchWinCursor(overlay, lane, vm, cycleQ);
        if (isOverlayFrozen(body)) return;
        reconcileMarkers(overlay, mapKey, o => {
            if (!lane.mapBypassed) {
                buildWindowDims(o, { segs: lane.mapSegs }, lane, cycleQ);
            }
            for (const [s, e] of lane.mapSegs) {
                for (const q of [s, e]) {
                    const t = el('div', 'map-seam-tick');
                    t.style.left = pct(q, cycleQ);
                    o.appendChild(t);
                }
            }
            const chip = el('div', 'win-chip toggle' +
                (lane.mapSegs[lane.mapSegs.length - 1][1] >= cycleQ
                    ? ' at-end' : ''));
            chip.style.left =
                pct(lane.mapSegs[lane.mapSegs.length - 1][1], cycleQ);
            chip.textContent = lane.mapBypassed
                ? 'map · bypassed'
                : 'map · ' + fmtQ(lane.mapChipQ) + 'Q';
            chip.title = 'Toggle the map (bypass keeps its shape)';
            chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
            o.appendChild(chip);
            if (!lane.mapBypassed) {
                // Heard-time cursor: jumps across the cuts (seam-aware
                // positioning below) — the honest line on a lane whose
                // intrinsic frame the audible cycle no longer matches.
                o.appendChild(el('div', 'win-cursor'));
            }
            appendCutBands(o, lane, vm, body, cycleQ);
        });
        patchWinCursor(overlay, lane, vm, cycleQ);
        return;
    }
    const win = lane.window || latentWindow(lane, vm);
    // Window geometry is CONTENT-relative; the lane's content-frame
    // origin is its take tile (takeStartQ) — brackets/dims/cursor all
    // shift by it (otherwise they draw a phase off for takes not
    // anchored at the frame top).
    const anchorQ = lane.takeStartQ || 0;
    const overlayKey = JSON.stringify(
        [win, armedEmpty && armQ, cycleQ, anchorQ,
         lane.bandSegs || null, lane.bandEditable || false,
         lane.windowEditing || false, lane.parentMapSegs || null,
         // The drag closure converts frame Q → samples with vm.quantum
         // and clamps to intrinsicQ: a change in either must rebuild.
         vm.quantum, lane.intrinsicQ || 0, !!lane.isQDefiner,
         // The comp cells (docs/takes.md) rebuild with the comp.
         compKey(lane), retakePending]);

    // The heard-time WINDOW CURSOR: where in its window this lane is
    // sounding right now (the engine publishes the window phase on
    // `playhead`). The island playhead sweeps ISLAND time — under an
    // active window the lane hears MAPPED time, and without this cursor
    // the loop looks dead. Patched every poll, OUTSIDE the keyed
    // rebuild — and BEFORE the drag gate: during an expanded map drag
    // this same lane frames the RAW take (per-lane scale), the phase
    // maps through the live-committed segments, and the cursor jumps
    // the cuts — the "where is the sound" line of the editing view.
    patchWinCursor(overlay, lane, vm, cycleQ);
    if (isOverlayFrozen(body)) return;

    reconcileMarkers(overlay, overlayKey, o => {
        // Enclosing-map projection (phase 3): the group map's excluded
        // regions dim this child lane too — what the map silences, the
        // child shows silenced. Tiled per GROUP cycle.
        if (lane.parentMapSegs && lane.parentMapPeriodQ > 0) {
            const P = lane.parentMapPeriodQ;
            for (let base = 0; base < cycleQ; base += P) {
                dimComplementInto(o, cycleQ, lane.parentMapSegs, base, P,
                    'win-dim parent-map-dim');
            }
        }
        if (armedEmpty) {
            const m = el('div', 'arm-marker');
            m.style.left = pct(armQ, cycleQ);
            const label = el('div', 'arm-label');
            label.style.left = pct(armQ, cycleQ);
            label.textContent = retakePending
                ? '● new take at the top'
                : '● at ' + (armQ === 0 ? '↺' : fmtQ(armQ) + 'Q');
            o.append(m, label);
        }
        if (win) {
            const { startQ, endQ, active, bypassed, latent } = win;
            if (active && !bypassed) {
                // The window is a SUBSET of every repetition: the frame
                // stays intrinsic (displayPeriodQ), so dim the outside
                // regions once per period tile across the whole cycle
                buildWindowDims(o, { startQ, endQ }, lane, cycleQ);
            }
            // Q13: the sole Q-definer's handles re-establish Q — style
            // them as "sets tempo" and always show the chip (even latent).
            const qDef = !!lane.isQDefiner;
            const qCls = qDef ? ' q-definer' : '';
            const latentCls = latent ? ' latent' : '';
            const b1 = el('div', 'win-bracket start' + latentCls + qCls);
            b1.style.left = pct(anchorQ + startQ, cycleQ);
            const b2 = el('div', 'win-bracket end' + latentCls + qCls);
            b2.style.left = pct(anchorQ + endQ, cycleQ);
            o.append(b1, b2);
            if (!latent || qDef) {
                const chip = document.createElement('div');
                if (qDef) {
                    // The Q-definer chip CENTERS over the take: pinned to
                    // the window end it would sit clipped against the
                    // lane's right edge, unreadable.
                    chip.className = 'win-chip q-definer centered';
                    chip.style.left =
                        pct(anchorQ + (startQ + endQ) / 2, cycleQ);
                    chip.textContent = 'sets tempo · drag ends to trim';
                    chip.title = 'This first take defines the loop length '
                        + '(Q — the tempo everything else locks to). Drag '
                        + 'its end handles to trim it; the tempo locks '
                        + 'when you record a second track.';
                } else {
                    // A window ending AT the display cycle would put the
                    // chip past the lane's overflow clip — align it inward
                    chip.className = 'win-chip' +
                        (anchorQ + endQ >= cycleQ ? ' at-end' : '');
                    chip.style.left = pct(anchorQ + endQ, cycleQ);
                    chip.textContent = win.suspended
                        ? 'window · suspended (sequence off)'
                        : bypassed ? 'window · bypassed'
                        : active ? 'window · active' : 'window';
                    if (win.suspended) {
                        chip.title = 'This window was drawn over the ' +
                            'sequence timeline; it returns when the ' +
                            'sequence is active again';
                    }
                }
                o.appendChild(chip);
                if (active && !bypassed && !qDef) {
                    // Heard-time cursor: positioned per poll below. NOT
                    // on the Q-definer — there the MAIN playhead is
                    // mapped into the selection (vm.loopStartQ), and a
                    // second cursor over the same span would read as
                    // two cursors.
                    o.appendChild(el('div', 'win-cursor'));
                }
            }
            wireWindow(o, lane, vm, body, win);
        }
        // Cut bands ride alongside the bracket chrome wherever the lane
        // frames its raw material (groups, clip edit views, windowless
        // resting clips).
        appendCutBands(o, lane, vm, body, cycleQ);
        // The comp (docs/takes.md): cells over the take tile — the
        // tinted ones at rest, every one in comp mode.
        appendCompCells(o, lane, vm, body, cycleQ);
    });
    // Slice canvases draw as their take peaks arrive (per poll, outside
    // the keyed rebuild — the cache answers asynchronously).
    patchCompCanvases(overlay, lane, aux, bodyW, bodyH, cycleQ);
}

/**
 * The heard-time WINDOW/MAP CURSOR — where in its map this lane is
 * sounding right now (the engine publishes the phase on `playhead`).
 * Patched every poll, OUTSIDE the keyed rebuild. SEAM-AWARE (phase 3):
 * the heard phase maps through the SEGMENTS, so over a multi-segment
 * map the cursor JUMPS across cuts instead of gliding through removed
 * time; multi lanes skip the linear animator (its glide assumes a
 * contiguous span) and big jumps snap instead of sweeping.
 */
function patchWinCursor(overlay, lane, vm, cycleQ) {
    const winCursor = overlay.querySelector('.win-cursor');
    const w = lane.window ||
        (lane.mapSegs ? { segs: lane.mapSegs, periodQ: lane.mapChipQ } : null);
    if (!winCursor || !w) return;
    const anchorQ = lane.takeStartQ || 0;
    const lenQ = w.periodQ ?? (w.endQ - w.startQ);
    if (!(lenQ > 0)) return;
    const multi = !!(w.segs && w.segs.length > 1);
    if (isAnimRunning() && !multi) {
        // The animator draws this cursor at 60fps (same clock as the
        // playhead); the poll corrects its phase (wrap-aware, ease
        // small errors, snap teleports)
        winCursor._startQ = anchorQ + w.startQ;
        winCursor._lenQ = lenQ;
        winCursor._cycleQ = cycleQ;
        const target = lane.windowPhase || 0;
        if (winCursor._phase === undefined) {
            winCursor._phase = target;
        } else {
            winCursor._phase = correctPosition(winCursor._phase, target, 1, 0.15);
        }
        if (winCursor.style.transition !== 'none') winCursor.style.transition = 'none';
    } else {
        const heardQ = (lane.windowPhase || 0) * lenQ;
        const posQ = anchorQ + (multi
            ? mapOffset({ segs: w.segs }, heardQ)
            : (w.startQ ?? 0) + heardQ);
        // Glides like the playhead; a wrap (phase 1 → 0) must snap
        // back, never sweep backwards through the window — and a SEAM
        // jump must snap forward, never sweep through the cut.
        const frac = posQ / cycleQ;
        const jumpQ = winCursor._pos !== undefined
            ? Math.abs(frac - winCursor._pos) * cycleQ : 0;
        if (winCursor.style.transition === 'none') winCursor.style.transition = '';
        if (winCursor._pos !== undefined &&
            (frac < winCursor._pos - 0.5 * lenQ / cycleQ ||
             (multi && jumpQ > MULTI_JUMP_SNAP_Q))) {
            snapThenAnimate(winCursor);
        }
        winCursor._pos = frac;
        winCursor._phase = undefined;
        setStyle(winCursor, 'left', pct(posQ, cycleQ));
    }
    const disp = vm.isPlaying ? '' : 'none';
    if (winCursor.style.display !== disp) winCursor.style.display = disp;
}

/**
 * LATENT window for a lane that has none: full-span brackets
 * (hover-revealed) so a window can be CREATED by dragging an edge in —
 * the same gesture as editing, no separate affordance. Full span is
 * "no window" (windowOf suppresses it), so dragging back out to the
 * full span removes the window — creation and deletion are symmetric.
 * FRACTAL (I5): clips and groups alike — a clip's loop region is the
 * single-segment case of the stack's time-map.
 */
function latentWindow(lane, vm) {
    if (lane.window || lane.recording || !vm.qEstablished) return null;
    // Heard-view windowed lanes edit through the EXPAND view (chip /
    // edge grip) — a latent full-span drag here would reinterpret the
    // collapsed coordinates as raw loop points.
    if (lane.windowChipQ) return null;
    // A child shown THROUGH an enclosing map (the child heard unroll)
    // frames the parent's slice, not its own take — a latent drag here
    // would author a window in the wrong coordinates. The parent owns
    // the chrome.
    if (lane.underMap || lane.definerMember) return null;
    const maxQ = Math.round(lane.intrinsicQ || 0);
    // (The Q-definer never reaches here: its lane always carries a
    // window — the provisional branch builds the selection explicitly.)
    if (maxQ < 2) return null; // a 1Q lane has no sub-window to make
    return { startQ: 0, endQ: maxQ, active: false, bypassed: false, latent: true };
}

/** Peaks for a lane: clip peaks from the store; group = composite. */
function lanePeaks(lane, aux, bodyW = 0) {
    if (lane.kind === 'clip') return aux.livePeaks.get(lane.id);
    const node = aux.nodesById.get(lane.id);
    if (!node || !node.nodes || node.nodes.length === 0) return null;
    // The composite's extent = the lane's intrinsic extent (one take →
    // its raw duration; else the commensurate LCM) — the heard view's
    // srcSegs index into THIS, so the two must agree.
    const stackDuration = Math.max(
        oneTakeDuration(node) || calculateStackLCM(node.nodes, aux.vmQuantum),
        node.effectiveQuantum || aux.vmQuantum);
    // Rasterize at least at the lane's own width: a lane wider than the
    // fixed 800 would upsample (interpolate) the composite, and the
    // group would read softer than its children.
    const canvasWidth = Math.max(COMPOSITE_CANVAS_W, Math.ceil(bodyW || 0));
    return generateCompositeWaveform({
        stack: node, stackDuration, effectiveQ: aux.vmQuantum,
        canvasWidth, livePeaks: aux.livePeaks,
        cache: ctx.compositeCache,
        excludeIds: aux.pendingFetch,
        // THE COMPOSITE'S FRAME (Q18, composition.md §9): the group's
        // tile sits at its take mark and the heard view's srcSegs are
        // INNER positions, so the mixdown is built in the STACK's own
        // frame — x = 0 is the stack's origin (inner time 0), each
        // member's content at its origin relative to that. An
        // unanchored stack (no content) keeps the island frame.
        frameZero: node.anchored ? (node.origin || 0)
                                    : (aux.frameZero || 0),
        // The Q-definer trim view frames the RAW take with the
        // selection over it (pushDefinerLane); its members draw their
        // whole takes beneath. The composite must be the same raw
        // material — a heard mixdown (windowed slices on the zero
        // grid) would disagree with the children and re-shape on every
        // trim release.
        raw: !!lane.isQDefiner,
    });
}

/**
 * SEQUENCE DIMS (docs/sequencer.md §9): the display projection of an
 * enclosing sequence's gates — gated-off spans render as dim overlays,
 * tiled across the frame every sequence pass. Keyed rebuild; the layer
 * is created/removed on demand and never touches the marker overlay.
 */
function patchSeqDims(body, lane, cycleQ) {
    let layer = body.querySelector(':scope > .seq-dims');
    // LAYERS (docs/sequencer.md §12.2): every enclosing sequence that
    // gates this lane contributes one tiled layer; the lane reads as
    // silent where ANY of them silences it.
    const layers = Array.isArray(lane.seqDims) ? lane.seqDims
        : (lane.seqDims ? [lane.seqDims] : []);
    const want = layers.some(d => d.periodQ > 0) && !lane.windowEditing;
    if (!want) {
        if (layer) layer.remove();
        return;
    }
    if (!layer) {
        layer = el('div', 'seq-dims');
        body.appendChild(layer);
    }
    const key = JSON.stringify([layers, cycleQ]);
    if (layer._key === key) return;
    layer._key = key;
    layer.textContent = '';
    layers.forEach((dims, li) => {
        const P = dims.periodQ;
        if (!(P > 0)) return;
        // The layer's song is anchored at `phaseQ` in the lane frame
        // (its owner's origin — a group's Q18 origin; the root's, a
        // whole song from the seated zero, so 0 — frame.md §4):
        // tile from the first pass that touches the frame, clipped.
        const ph = (((dims.phaseQ || 0) % P) + P) % P;
        for (let base = ph - P; base < cycleQ; base += P) {
            for (const [s, e] of dims.offSegsQ) {
                const from = Math.max(base + s, 0);
                const to = Math.min(base + e, cycleQ);
                if (to - from <= 1e-9) continue;
                const d = el('div', 'seq-dim');
                d.dataset.layer = String(li);
                d.style.left = pct(from, cycleQ);
                d.style.width = pct(to - from, cycleQ);
                layer.appendChild(d);
            }
            // PER-STEP FADES (S13, sequencer.md §15): the ramp at a
            // run's edge reads as a gradient into / out of the dim.
            for (const [s, e, kind] of dims.fadeSegsQ || []) {
                const from = Math.max(base + s, 0);
                const to = Math.min(base + e, cycleQ);
                if (to - from <= 1e-9) continue;
                const f = el('div', 'seq-fade ' + kind);
                f.dataset.layer = String(li);
                f.style.left = pct(from, cycleQ);
                f.style.width = pct(to - from, cycleQ);
                f.title = kind === 'in' ? 'Fades in over this span'
                                        : 'Fades out over this span';
                layer.appendChild(f);
            }
            // CUED spans (docs/sequencer.md ss3): the subtree replays
            // the SONG TOP here - marked, not dimmed (it still sounds;
            // it just re-bases). The pip echoes the grid header's.
            for (const [s, e] of dims.cueSegsQ || []) {
                const from = Math.max(base + s, 0);
                const to = Math.min(base + e, cycleQ);
                if (to - from <= 1e-9) continue;
                const c = el('div', 'seq-cue-span mono');
                c.dataset.layer = String(li);
                c.style.left = pct(from, cycleQ);
                c.style.width = pct(to - from, cycleQ);
                c.title = 'Cued step: replays this track from the song top';
                c.appendChild(el('span', 'seq-cue-pip',
                    { textContent: '\u21e4' }));
                layer.appendChild(c);
            }
        }
    });
}
