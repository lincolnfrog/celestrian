/**
 * Lane body: the per-lane grid area — gridlines, rep tiles (waveform
 * canvases: material, ghosts, the live recording bar, map-sliced
 * content), the splice layer, and the keyed overlay (window brackets,
 * cut bands and seams, the arm marker, the sound cursor, the window /
 * map chips, the comp cells).
 *
 * RECONCILED IN LAYERS, never nuked: recreating every gridline, rep and
 * canvas on any change would make commits render as a global "pop". Rep
 * divs are REUSED — position updates morph via CSS transitions — and
 * canvases redraw only when their own peaks or geometry change. The
 * overlay rebuilds by key, and never under a hand (gesture.js, the
 * freeze law — patchOverlay is the one place that asks).
 *
 * THE DOM EXPANDOS that are this slice's cross-module state (every other
 * `_x` on a node is a render cache private to the module that writes
 * it, dying with its node):
 *
 *   on the lane BODY
 *     _cycleQ          lane_body, every patch → lane_build (a file
 *                      drop's Q), the e2e helpers
 *     _peaks, _isGroup, _waveH
 *                      lane_body, every patch → map_bands (the reveal
 *                      draws the raw take at the lane's own height);
 *                      patch.js hands `_peaks` to the region panel
 *     _bandState       map_bands wireBandCreate, every patch → its own
 *                      dblclick handler (`_bandsWired` marks it wired)
 *     _reveal          map_bands runRevealDrag, engage → teardown →
 *                      patchRevealCursor, the e2e specs (`.view`)
 *     _lrLayer, _lrPools, _lrCtx, _lrDrag
 *                      splice_handles only: the handle layer, its
 *                      pools, the per-patch context, the live drag
 *                      (press → end)
 *     _compPending     comp_cells: a cell click → the next click's base,
 *                      until published or the commit cap
 *   on a splice / ↺ HANDLE
 *     _body, _kind, _pool, _spot
 *                      splice_handles (made once; `_spot` every patch)
 *                      → its press handlers
 *   on a `.win-cursor`
 *     _startQ, _lenQ, _cycleQ, _phase
 *                      patchWinCursor, every poll → animator.js, every
 *                      frame (it advances `_phase`); gone with the
 *                      overlay rebuild that replaces the cursor
 *   on an overlay (a lane's, the panel's)
 *     _key             its keyed rebuild — and POISONED by any gesture
 *                      that changed what it shows (map_core
 *                      renderRawPreview, the panel's ↺ drag, window_edit)
 *                      so the next free patch rebuilds
 *   on the lane ROW
 *     _region          region_panel build, `.ctx` every patch: the
 *                      panel's parts and its last patch's { lane, vm,
 *                      aux, peaks } → region_panel and region_nav. Two
 *                      parts are read elsewhere: `.nav`, the mounted
 *                      panel → region_nav / region_nudge (is it shown?),
 *                      patch.js (removes it with the lane); `.strip`,
 *                      the detail strip → mapEditInFlight here (its
 *                      freeze), region_nav, region_nudge
 *   on the panel STRIP
 *     _bandState       as on a body → region_nudge reads it too
 *     _nudge           region_nudge: one nudge chain
 *     _view            a getter for the e2e specs
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setStyle, snapThenAnimate, approxQ } from './sv_util.js';
import { drawWaveform, drawEnvelope, drawMidiTile, mappedColumns, peaksBoost,
         canvasCssSize, MIDI_VELOCITY_LANE } from '../canvas_renderer.js';
import { sliceNotesToTile } from '../midi_notes.js';
import { generateCompositeWaveform } from '../composite_waveform.js';
import { buildRulerTicks } from '../view_model.js';
import { liveBoost, PEAKS_PER_SECOND } from '../live_peaks.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { correctPosition } from '../playhead_clock.js';
import { isAnimRunning } from './animator.js';
import { buildWindowDims, dimComplementInto } from './dims.js';
import { patchSeqDims, patchTrimDims } from './seq_dims.js';
import { wireBandCreate, appendCutBands, appendTrimGrips, patchRevealCursor }
    from './map_bands.js';
import { laneMapOff } from './map_core.js';
import { patchSpliceHandles } from './splice_handles.js';
import { wireWindow, bracketQ } from './window_edit.js';
import { isOverlayFrozen, isGestureLive } from './gesture.js';
import { mapDragPinQ } from './drag_pin.js';
import { appendCompCells, patchCompCanvases, compKey } from './comp_cells.js';

/* Surplus rep tiles fade out over this long before removal (instant
 * removal mid-morph leaves a momentary gap — the commit "squish"). */
const EXIT_FADE_MS = 220;
/* Content-swap cross-fade: the old canvas fades over the new one for
 * this long, and is removed a beat later. Longer than the exit fade —
 * it covers a re-render of the SAME audio. */
const CROSSFADE_MS = 240;
const CROSSFADE_REMOVE_MS = 320;
/* After the last sign of a map edit its re-layouts keep arriving for a
 * poll or two — the release commit's answer, the frame settling on
 * unpin — and still swap in place (≈ 8 polls). */
const EDIT_SETTLE_MS = 400;
/* A heard tile's edge within this many periods of a whole period IS
 * that period boundary (startQ / P carries float noise). */
const SPAN_SNAP = 1e-9;
/* A raw frame within this of a whole Q is that many Qs (fp noise). */
const FRAME_EPS_Q = 1e-9;
/* A tile's waveform height: the body's less this inset (px), or the
 * fallback before the body is laid out. */
const BODY_H_FALLBACK_PX = 58;
const BODY_V_INSET_PX = 6;
/* Composite waveforms rasterize at this width at least (px). */
const COMPOSITE_CANVAS_W = 800;
/* A multi-segment window cursor jump bigger than this snaps instead of
 * sweeping through the cut. */
const MULTI_JUMP_SNAP_Q = 0.3;
/* The recording bar never renders shorter than this (Q). */
const MIN_BAR_LEN_Q = 0.05;
/* Tiles never render thinner than this (px). */
const MIN_TILE_PX = 2;

const suspendedTitle = what => 'This ' + what + ' was drawn over the ' +
    'sequence timeline; it returns when the sequence is active again';

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

/* ---------- the tiles ---------- */

/**
 * Redraw a rep canvas only when its peaks identity/length/size changed.
 * Returns true when it redrew (patchReps then snaps instead of morphing
 * a re-laid-out tile). Options:
 *
 *   peaks       — the peaks array (identity-tracked; may grow in place
 *                 while recording). Transiently empty around a commit:
 *                 the last drawn content is KEPT (stale for a poll
 *                 beats blinking to nothing).
 *   cssWidth, cssHeight — canvas CSS size (px)
 *   isComposite — group composite tone (the summed stack)
 *   live        — the recording bar: fixed px-per-slot scale + the
 *                 ratcheting liveBoost normalization
 *   pxPerSlot   — live mode's fixed px per peak slot (0 = fit)
 *   map         — a heard tile's mapping (tileMap): `src`, the LIST of
 *                 [startFrac, endFrac] content ranges it plays in heard
 *                 order; `rotFrac`, where the loop's heard top sits in
 *                 the period; `u0`/`u1`, the tile's window onto its
 *                 period. Null = the whole take.
 *   isGhost     — a ghost tile is an audible repetition and draws in
 *                 the cool ECHO tone — warm hues are the material's (the
 *                 take tile, the live bar).
 *   crossfade   — false while a map edit is in flight
 *                 (mapEditInFlight): a new peaks identity then swaps in
 *                 place instead of fading the old canvas over it.
 *   midi        — a MIDI lane's notes (docs/vst3.md §8.5): {notes (Q
 *                 units), range (the take's pitch fit), intrinsicQ}.
 *                 The tile paints note bars instead of the envelope;
 *                 `map` places the notes exactly as it samples peaks.
 */
function drawRepCanvas(div, { peaks, cssWidth, cssHeight, isComposite,
                              live, pxPerSlot, map, isGhost,
                              crossfade = true, midi }) {
    let canvas = div.firstElementChild;
    if (midi && midi.notes && midi.notes.length) peaks = midi.notes;
    if (!peaks || !peaks.length) {
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

    // CONTENT SWAP → CROSS-FADE (wantsCrossfade): a new peaks array for
    // the same audio (meter peaks → the fetched waveform at commit; a
    // composite regenerated) shifts features a few px — a hard swap
    // reads as squish/stretch, so the old canvas fades out over the new.
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
    // Pinned: the div's transition reveals/clips the canvas — stretching
    // it mid-morph would distort the content.
    canvas.style.width = Math.round(cssWidth) + 'px';
    if (live) {
        // Smoothed ratcheting normalization (live_peaks.liveBoost): it
        // converges to the committed boost, so commit doesn't pop. The
        // FIXED px-per-slot scale pins every drawn peak to its slot's
        // pixels for the life of the take.
        div._liveBoost = liveBoost(div._liveBoost, peaks);
        drawWaveform(canvas, peaks, { cssWidth, cssHeight,
            fixedBoost: div._liveBoost, pxPerPeak: pxPerSlot || undefined });
        return true;
    }
    if (div._liveBoost !== undefined) delete div._liveBoost;
    if (midi) {
        drawMidiTile(canvas,
            map ? sliceNotesToTile(midi.notes, midi.intrinsicQ, map.src,
                                   map.rotFrac, map)
                : sliceNotesToTile(midi.notes, midi.intrinsicQ, null),
            { cssWidth, cssHeight, isEcho: !!isGhost, range: midi.range,
              velocityLane: MIDI_VELOCITY_LANE });
        return true;
    }
    // Tone follows GHOSTNESS, not segment-ness (a heard lane's bright
    // tile carries a map and is still the sounding material). ONE GAIN
    // PER TAKE (peaksBoost): every committed tile of a take — whole,
    // heard slice, repeat — draws at the whole take's boost, so a loud
    // hit entering or leaving a loop never rescales the lane.
    const opts = { cssWidth, cssHeight, isComposite, isEcho: !!isGhost,
                   fixedBoost: peaksBoost(peaks) };
    if (map) {
        // Sampled PER COLUMN through the map (mappedColumns — exact).
        drawEnvelope(canvas,
            sharedTileColumns(peaks, canvasCssSize(canvas, opts).cssW, map),
            opts);
    } else {
        drawWaveform(canvas, peaks, opts);
    }
    return true;
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
 * IDENTITY changed under an already-drawn canvas, and never while a map
 * edit is in flight (`crossfade` false): there the new identity is the
 * edit itself, and a fading old canvas is a double image on every live
 * commit. Pure; exported for the tests.
 */
export function wantsCrossfade({ live, crossfade, prev, peaks, drawn }) {
    return !live && crossfade !== false && !!prev && prev !== peaks && !!drawn;
}

/**
 * A heard tile's window onto its loop's period: [startQ, endQ) / P.
 * Heard tiles tile from the frame's 0 at the heard period, and
 * srcTopFrac is measured on that same grid, so a full tile spans exactly
 * one period and a tile the frame clips shows the LEADING part of its
 * period — never the whole period squeezed into the clipped width.
 * Edges within SPAN_SNAP of a whole period snap to it. Exported for the
 * tests.
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
 * The tile's CSS width (px) as patchReps lays it out: its share of the
 * body, never thinner than MIN_TILE_PX. With canvasCssSize this is the
 * column count the tile's sampler fills. Exported for the tests.
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
 * The pooled column amplitudes a committed HEARD tile draws (before the
 * take's boost and the envelope shaping) — drawRepCanvas's own path,
 * exported so the invariant test (heard_tile_sampler.test.mjs) measures
 * exactly what the lane paints.
 */
export function heardTileColumns(peaks, rep, periodQ, cssW) {
    return sharedTileColumns(peaks, cssW, tileMap(rep, periodQ));
}

/* Each lane's map geometry at the last patch (by lane id) and the
 * performance.now() of the last sign of a map edit. Module state, not
 * per-body: a group's map edit re-lays its MEMBERS' tiles too, and
 * their rows see no freeze or hold of their own. */
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
 * IS A MAP EDIT IN FLIGHT? True while any gesture is live, the frame pin
 * is held (drag_pin.js), this lane's overlay or its region panel's strip
 * is frozen or held for a commit, the map geometry of any lane changed
 * since the last patch (a nudge, an undo, the release commit landing),
 * or the frame is moving onto a new seat — and for EDIT_SETTLE_MS after
 * the last such sign. While true, patchReps removes surplus tiles at
 * once and content swaps skip the cross-fade: each live commit re-lays
 * the heard tiles, and a fading copy of the old layout over the new one
 * is a double image.
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
    const strip = row && row._region && row._region.strip;
    if (isGestureLive() || mapDragPinQ() !== null ||
        (vm && vm.frameTweening) ||
        (body && isOverlayFrozen(body)) || (strip && isOverlayFrozen(strip))) {
        editSeenAt = now;
    }
    return now - editSeenAt < EDIT_SETTLE_MS;
}

/**
 * Retire the surplus rep divs past the first `keep` live ones: FADE
 * them out through the settle (instant removal while the surviving tile
 * is still mid-morph leaves a momentary gap) — or, while a map edit is
 * in flight (`instant`), remove them at once. Returns the kept divs.
 * Exported for the tests.
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
 * The reps layer: RECONCILE the lane's tiles — reuse the divs, update
 * geometry in place, redraw a canvas only when its content changed.
 * While a take is live the recording BAR is one more tile.
 */
function patchReps(row, body, lane, vm, aux, { cycleQ, bodyW, bodyH, peaks }) {
    const repsL = layersOf(body).reps;
    // The bar anchors at its Q boundary; in the first-take frame there
    // is no Q yet (quantum = 1 sample — rounding is meaningless and the
    // latency wobble would make the left edge vibrate), and the first
    // take by definition starts the timeline: anchor 0.
    const wantBar = lane.recording && !lane.pendingStart;
    const barStartQ = !vm.qEstablished ? 0
        : Math.max(0, Math.round(vm.playheadQ - lane.recordingLengthQ));
    // The bar's edge is "now" (the playhead): the written content trails
    // inside it by the latency compensation, and ending the bar at
    // start + length would leave the playhead ahead of the waveform. A
    // NEW TAKE (docs/takes.md) keeps the slot's resting tiles beneath
    // the bar, `silent`.
    const tiles = wantBar
        ? [...lane.reps, {
            startQ: barStartQ,
            endQ: Math.max(vm.playheadQ,
                barStartQ + Math.max(lane.recordingLengthQ, MIN_BAR_LEN_Q)),
            ghost: false, bar: true,
        }]
        : lane.reps;

    const editing = mapEditInFlight(row, body, vm);
    const rows = retireSurplusTiles(repsL, tiles.length, editing);
    tiles.forEach((rep, i) => {
        let div = rows[i];
        if (!div) {
            div = document.createElement('div');
            // A fresh tile appears AT its geometry, never animating
            // from width 0.
            snapThenAnimate(div);
            repsL.appendChild(div);
        }
        // A MIDI lane's resting tiles draw note bars from the fetched
        // notes; the live bar and a retake's silent tiles keep the
        // velocity envelope.
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
        // growing count (fit-to-width would remap every column each
        // poll, and the bar would vibrate). The bar div's edge still
        // advances smoothly, ≤ 1 slot ahead of the canvas.
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
            // A live take's lane has no period of its own: its slot's
            // silent tiles are on the slot's (intrinsicQ).
            map: tileMap(rep, lane.periodQ || lane.intrinsicQ),
            isGhost: !!rep.ghost,
            crossfade: !editing,
            // Notes slice on the RAW take (srcSegs are fractions of it),
            // not the heard period a windowed lane's intrinsicQ carries.
            midi: midi ? { notes: midi.notes, range: midi.range,
                           intrinsicQ: lane.contentQ || lane.intrinsicQ || 0 } : null,
        });

        // MORPH ONLY PURE MOVES; SNAP RE-LAYOUTS. A canvas redrawn AND
        // re-placed in the same patch (a commit, a frame settle) must
        // not animate: the container moving over new content reads as
        // false motion.
        const newLeft = pct(rep.startQ, cycleQ);
        const newWidth = pct(rep.endQ - rep.startQ, cycleQ);
        const geomChanged = div.style.left !== newLeft || div.style.width !== newWidth;
        if (redrew && geomChanged && !rep.bar) {
            snapThenAnimate(div);
        }
        setStyle(div, 'left', newLeft);
        setStyle(div, 'width', newWidth);
    });
}

/* ---------- the grid ---------- */

/**
 * The lane's gridlines — the ruler's Q lines minus the frame's edges —
 * PLACED on every patch in reused elements, never rebuilt: while the
 * frame settles the grid scrolls with the tiles, frame by frame, and at
 * rest a patch writes nothing.
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

/**
 * The Q lines a lane's grid draws: the ruler's (vm.ruler.ticks). A
 * raw-framed lane (comp mode's inspector, `lane.frameQ`) shows raw
 * time on its own frame, which a settle never moves: its lines rest at
 * the whole Qs of THAT frame — a take longer than the shared frame
 * keeps its lines to its end. Exported for the tests.
 */
export function laneGridTicks(lane, vm) {
    if (!lane.frameQ) return vm.ruler.ticks;
    return buildRulerTicks(vm.qEstablished, Math.floor(lane.frameQ + FRAME_EPS_Q));
}

/* ---------- the overlay ---------- */

/** Keep `container`'s children to exactly the built descriptors.
 * Returns true when it rebuilt them. */
function reconcileMarkers(container, key, build) {
    if (container._key === key) return false;
    container._key = key;
    container.textContent = '';
    build(container);
    return true;
}

/**
 * THE ONE OVERLAY PATCH — every chrome branch goes through it:
 *   1. `cursorFn()`: the sound cursor moves on every poll, frozen or
 *      not (a frozen overlay still shows where the sound is);
 *   2. the frozen gate (gesture.js, the freeze law): nothing further;
 *   3. the keyed rebuild;
 *   4. `cursorFn()` again when it rebuilt — a cursor the rebuild just
 *      made is placed (or hidden) in this same patch, never shown at
 *      the lane's left edge for a poll.
 * Returns false when the overlay is frozen.
 */
function patchOverlay(body, overlay, key, build, cursorFn) {
    cursorFn();
    if (isOverlayFrozen(body)) return false;
    if (reconcileMarkers(overlay, key, build)) cursorFn();
    return true;
}

/**
 * Patch one lane's body: state classes, the grid, the two foreign dim
 * layers (seq_dims.js), the tiles, the splice layer (splice_handles.js,
 * outside the keyed overlay), then ONE of three overlay chromes:
 *
 *   1. HEARD (lane.windowChipQ, not a raw inspector): the chip — and a
 *      one-shot's edge grips + seam handles;
 *   2. MAP (lane.mapSegs: a group's cut map resting raw-framed): dims,
 *      seam ticks, one chip, the cuts as bands;
 *   3. BRACKETS: the lane's window, or the LATENT full-span one a
 *      resting take offers (latentWindow), with the arm marker, cut
 *      bands and comp cells over the take.
 */
export function patchLaneBody(row, lane, vm, aux) {
    if (lane.kind === 'add' || lane.kind === 'fx' || lane.kind === 'seq') {
        return;
    }
    const body = row.querySelector('.lane-body');
    // A raw inspector (comp mode) frames its whole take on its own
    // horizontal scale; everything below maps through this frame.
    const cycleQ = lane.frameQ || vm.cycleQ;
    const { grid, overlay } = layersOf(body);
    const bodyW = body.clientWidth;
    const peaks = lanePeaks(lane, aux, bodyW);
    const bodyH = body.clientHeight - BODY_V_INSET_PX || BODY_H_FALLBACK_PX;
    body._cycleQ = cycleQ;
    body._peaks = peaks;
    body._isGroup = lane.kind === 'group';
    body._waveH = bodyH;

    body.classList.toggle('win-bypassed', !!(lane.window && lane.window.bypassed));
    body.classList.toggle('win-suspended', !!(lane.window && lane.window.suspended));
    body.classList.toggle('one-shot', !!lane.oneShot);
    body.classList.toggle('is-recording', !!lane.recording);
    body.classList.toggle('armed-empty',
        lane.kind === 'clip' && !lane.recording && lane.reps.length === 0 && lane.armed);
    // A raw inspector: the global playhead is masked over it
    // (playhead_mask.js) and the amber cursor is its one honest cursor.
    body.classList.toggle('inspecting', !!lane.windowEditing);

    patchGridlines(grid, laneGridTicks(lane, vm), cycleQ);
    patchSeqDims(body, lane, cycleQ);
    patchTrimDims(body, lane, cycleQ);
    patchReps(row, body, lane, vm, aux, { cycleQ, bodyW, bodyH, peaks });

    // Both read per-patch state and run before any frozen gate: cut
    // creation must never keep a wrong-frame editor, and the handles
    // move with a drag's preview.
    wireBandCreate(body, lane, vm, cycleQ);
    patchSpliceHandles(body, overlay, lane, vm, cycleQ);

    if (lane.windowChipQ && !lane.windowEditing) {
        const key = JSON.stringify(
            ['heard', lane.bandSegs, lane.bandTotalQ, lane.windowChipQ,
             lane.mapMulti, cycleQ, lane.takeStartQ, lane.bandEditable,
             !!lane.oneShot, lane.reps.map(r => [r.startQ, r.endQ])]);
        patchOverlay(body, overlay, key,
            o => buildHeardChrome(o, body, lane, vm, cycleQ),
            () => patchRevealCursor(body, lane, vm, aux.nodesById.get(lane.id)));
        return;
    }
    const winCursor = () => patchWinCursor(overlay, lane, vm, cycleQ);
    if (lane.mapSegs) {
        const key = JSON.stringify(
            ['map', lane.mapSegs, lane.mapBypassed, lane.mapSuspended,
             cycleQ, lane.bandEditable]);
        patchOverlay(body, overlay, key,
            o => buildMapChrome(o, body, lane, vm, cycleQ), winCursor);
        return;
    }
    const b = bracketChrome(lane, vm, cycleQ);
    const free = patchOverlay(body, overlay, b.key,
        o => buildBracketChrome(o, body, lane, vm, cycleQ, b), winCursor);
    // Slice canvases draw as their take peaks arrive (the cache answers
    // asynchronously), outside the keyed rebuild.
    if (free) patchCompCanvases(overlay, lane, aux, bodyW, bodyH);
}

/** HEARD chrome: the chip is the readout + bypass toggle (the whole raw
 * take lives on the region panel). A ONE-SHOT keeps its edge grips and
 * seam handles: its offset IS its placement (Q5), so it has no splice
 * to swap and no ↺ to shift. */
function buildHeardChrome(o, body, lane, vm, cycleQ) {
    const what = lane.mapMulti ? 'map' : 'window';
    const chip = el('div', 'win-chip win-heard-chip toggle', {
        title: 'Toggle the ' + what + ': active ↔ bypassed (the whole take ' +
            'sounds while bypassed; the region panel below the selected ' +
            'track edits it)',
        textContent: what + ' ' + fmtQ(lane.windowChipQ) + 'Q' });
    chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
    o.appendChild(chip);
    if (lane.oneShot) {
        appendTrimGrips(o, lane, vm, body, cycleQ);
        appendCutBands(o, lane, vm, body, cycleQ);  // heard → seams
    }
}

/** MAP chrome — a group's multi-segment map resting raw-framed: segment
 * boundary ticks, ONE chip (the bypass toggle) and the inner cuts as
 * draggable BANDS; no per-segment brackets. A map that does not sound
 * (bypassed, or suspended by its sequence) draws no dims and no sound
 * cursor, and its chip says which. */
function buildMapChrome(o, body, lane, vm, cycleQ) {
    const off = laneMapOff(lane);
    const end = lane.mapSegs[lane.mapSegs.length - 1][1];
    if (!off) buildWindowDims(o, { segs: lane.mapSegs }, lane, cycleQ);
    for (const seg of lane.mapSegs) {
        for (const q of seg) {
            const t = el('div', 'map-seam-tick');
            t.style.left = pct(q, cycleQ);
            o.appendChild(t);
        }
    }
    const chip = el('div', 'win-chip toggle' + (end >= cycleQ ? ' at-end' : ''));
    chip.style.left = pct(end, cycleQ);
    chip.textContent = off === 'suspended' ? 'map · suspended (sequence off)'
        : off === 'bypassed' ? 'map · bypassed'
        : 'map · ' + fmtQ(lane.mapChipQ) + 'Q';
    chip.title = off === 'suspended' ? suspendedTitle('map')
        : 'Toggle the map (bypass keeps its shape)';
    chip.addEventListener('click', () => ctx.cb.onToggleWindow(lane.id));
    o.appendChild(chip);
    // The heard-time cursor jumps across the cuts (patchWinCursor).
    if (!off) o.appendChild(el('div', 'win-cursor'));
    appendCutBands(o, lane, vm, body, cycleQ);
}

/** The BRACKET chrome's inputs and its key: the lane's window (or the
 * latent one), the arm marker's place, and everything its builder and
 * the window drag's closure read. */
function bracketChrome(lane, vm, cycleQ) {
    const win = lane.window || latentWindow(lane, vm);
    const armedEmpty = (lane.kind === 'clip' && !lane.recording &&
        lane.reps.length === 0 && lane.armed) || (lane.recording && lane.pendingStart);
    // A pending NEW TAKE waits for the SLOT's top (the lane's armAtQ),
    // not the next Q boundary.
    const retakePending = !!(lane.retake && lane.pendingStart);
    const armQ = (retakePending ? lane.armAtQ : vm.armAtQ) % cycleQ;
    // Window geometry is CONTENT-relative: brackets, dims and cursor
    // shift by the take tile's place (takeStartQ).
    const anchorQ = lane.takeStartQ || 0;
    // A definer's selection with cuts dims by its runs (vm.loopRunsQ).
    const runs = (lane.isQDefiner && vm.loopRunsQ) || null;
    const key = JSON.stringify(
        [win, armedEmpty && armQ, cycleQ, anchorQ,
         lane.bandSegs || null, lane.bandEditable || false,
         lane.windowEditing || false, lane.parentMapSegs || null,
         // The drag closure converts frame Q → samples with vm.quantum
         // and clamps to intrinsicQ: a change in either must rebuild.
         vm.quantum, lane.intrinsicQ || 0, !!lane.isQDefiner,
         compKey(lane), retakePending, runs]);
    return { win, armedEmpty, retakePending, armQ, anchorQ, runs, key };
}

function buildBracketChrome(o, body, lane, vm, cycleQ,
                            { win, armedEmpty, retakePending, armQ, anchorQ, runs }) {
    // An ENCLOSING map's excluded regions dim this child lane too —
    // what the map silences, the child shows silenced — tiled per group
    // cycle.
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
            // The window is a SUBSET of every repetition (the frame
            // stays intrinsic): dim outside it — and, in a definer's
            // selection with cuts, the cuts too.
            buildWindowDims(o, runs ? { segs: runs } : { startQ, endQ }, lane, cycleQ);
        }
        // Q13: the sole Q-definer's handles re-establish Q — styled as
        // "sets tempo", its chip always shown (even latent).
        const qDef = !!lane.isQDefiner;
        const qCls = qDef ? ' q-definer' : '';
        const latentCls = latent ? ' latent' : '';
        // The brackets wrap with a take tile the frame's end clips
        // (bracketQ). Two that land on one line (a whole take whose
        // seam is mid-lane) each keep their own side of it (.abut).
        const startAt = bracketQ(anchorQ + startQ, cycleQ, 'start');
        const endAt = bracketQ(anchorQ + endQ, cycleQ, 'end');
        const abut = Math.abs(startAt - endAt) < 1e-6 ? ' abut' : '';
        const b1 = el('div', 'win-bracket start' + latentCls + qCls + abut);
        b1.style.left = pct(startAt, cycleQ);
        const b2 = el('div', 'win-bracket end' + latentCls + qCls + abut);
        b2.style.left = pct(endAt, cycleQ);
        o.append(b1, b2);
        if (!latent || qDef) {
            const chip = document.createElement('div');
            if (qDef) {
                // CENTRED over the take: pinned to the window end it
                // would sit clipped against the lane's right edge.
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
                // chip past the lane's overflow clip: aligned inward.
                chip.className = 'win-chip' +
                    (endAt >= cycleQ ? ' at-end' : '');
                chip.style.left = pct(endAt, cycleQ);
                chip.textContent = win.suspended
                    ? 'window · suspended (sequence off)'
                    : bypassed ? 'window · bypassed'
                    : active ? 'window · active' : 'window';
                if (win.suspended) chip.title = suspendedTitle('window');
            }
            o.appendChild(chip);
            // NOT on the Q-definer: there the MAIN playhead is mapped
            // into the selection, and a second cursor over the same
            // span would read as two.
            if (active && !bypassed && !qDef) {
                o.appendChild(el('div', 'win-cursor'));
            }
        }
        wireWindow(o, lane, vm, body, win);
    }
    // Cut bands wherever the lane frames its raw material (groups, the
    // comp editor, windowless resting clips), and the comp's cells over
    // the take tile (docs/takes.md).
    appendCutBands(o, lane, vm, body, cycleQ);
    appendCompCells(o, lane, body, cycleQ);
}

/**
 * The heard-time WINDOW/MAP CURSOR — where in its map this lane is
 * sounding right now (the engine publishes the phase on `playhead`):
 * the island playhead sweeps ISLAND time, and under an active window a
 * raw-framed lane hears MAPPED time. SEAM-AWARE: over a multi-segment
 * map the phase maps through the SEGMENTS, so the cursor JUMPS across
 * cuts; such lanes skip the animator (its glide assumes one span) and
 * big jumps snap instead of sweeping.
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
        // The animator draws this cursor every frame (the playhead's
        // clock); the poll corrects its phase (wrap-aware: ease small
        // errors, snap teleports).
        winCursor._startQ = anchorQ + w.startQ;
        winCursor._lenQ = lenQ;
        winCursor._cycleQ = cycleQ;
        const target = lane.windowPhase || 0;
        if (winCursor._phase === undefined) {
            winCursor._phase = target;
            // A cursor new to the animator is placed in this patch: its
            // first animation frame is still to come.
            setStyle(winCursor, 'left', pct(winCursor._startQ + target * lenQ, cycleQ));
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
 * The LATENT window of a lane that has none: full-span brackets
 * (hover-revealed), so a window is CREATED by dragging an edge in — the
 * same gesture as editing — and removed by dragging back out to the
 * full span (the view model shows no window for one). Clips and groups
 * alike (I5).
 */
function latentWindow(lane, vm) {
    if (lane.window || lane.recording || !vm.qEstablished) return null;
    // A heard lane frames HEARD time: a full-span drag here would read
    // heard coordinates as raw loop points.
    if (lane.windowChipQ) return null;
    // A child shown THROUGH an enclosing map frames the parent's slice,
    // not its own take: the parent owns the chrome.
    if (lane.underMap || lane.definerMember) return null;
    const maxQ = Math.round(lane.intrinsicQ || 0);
    if (maxQ < 2) return null; // a 1Q lane has no sub-window to make
    return { startQ: 0, endQ: maxQ, active: false, bypassed: false, latent: true };
}

/* ---------- the peaks ---------- */

/** The samples a group lane's composite spans: the lane's own raw extent
 * (the view model's — `bandTotalQ`, or `intrinsicQ` on a lane with no
 * bands), which its tiles and a heard tile's `srcSegs` index into, and
 * never less than one Q. Exported for the tests. */
export function compositeExtent(lane, node, quantum) {
    return Math.max(
        Math.round((lane.bandTotalQ || lane.intrinsicQ || 0) * quantum),
        node.effectiveQuantum || quantum);
}

/** Peaks for a lane: clip peaks from the store; group = composite. */
function lanePeaks(lane, aux, bodyW = 0) {
    if (lane.kind === 'clip') return aux.livePeaks.get(lane.id);
    const node = aux.nodesById.get(lane.id);
    if (!node || !node.nodes || node.nodes.length === 0) return null;
    // Rasterize at least at the lane's own width: narrower, the
    // composite would upsample and read softer than its children.
    const canvasWidth = Math.max(COMPOSITE_CANVAS_W, Math.ceil(bodyW || 0));
    return generateCompositeWaveform({
        stack: node,
        stackDuration: compositeExtent(lane, node, aux.vmQuantum),
        effectiveQ: aux.vmQuantum,
        canvasWidth, livePeaks: aux.livePeaks,
        cache: ctx.compositeCache,
        excludeIds: aux.pendingFetch,
        // THE COMPOSITE'S FRAME (Q18, composition.md §9): the group's
        // tile sits at its take mark and the heard view's srcSegs are
        // INNER positions, so the mixdown is built in the STACK's own
        // frame — x = 0 is the stack's origin. An unanchored stack (no
        // content) keeps the island frame.
        frameZero: node.anchored ? (node.origin || 0)
                                    : (aux.frameZero || 0),
        // The Q-definer trim view frames the RAW take with the selection
        // over it, its members' whole takes beneath: the composite is
        // the same raw material (a heard mixdown would disagree with the
        // children and re-shape on every trim release).
        raw: !!lane.isQDefiner,
    });
}
