/**
 * Lane body: gridlines, reps, window, arm.
 *
 * RECONCILED IN LAYERS, never nuked: destroying and recreating every
 * gridline/rep/canvas on any key change made commits (and every Q
 * crossing, via armAtQ in the old whole-body key) render as a global
 * "pop" (field report 2026-07-10). Rep divs are REUSED — position
 * updates morph via CSS transitions — and canvases redraw only when
 * their own peaks/geometry change.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ, setStyle, snapThenAnimate, approxQ, tickSetSig } from './sv_util.js';
import { drawWaveform } from '../canvas_renderer.js';
import { generateCompositeWaveform } from '../composite_waveform.js';
import { calculateStackLCM } from '../timeline_model.js';
import { oneTakeDuration } from '../view_model.js';
import { liveBoost, PEAKS_PER_SECOND } from '../live_peaks.js';
import { mapOffset } from '../time_map.js';
import { correctPosition } from '../playhead_clock.js';
import { isAnimRunning } from './animator.js';
import { buildWindowDims, dimComplementInto } from './dims.js';
import { wireBandCreate, appendCutBands, appendTrimGrips }
    from './map_bands.js';
import { wireWindow } from './window_edit.js';

/* Surplus rep tiles fade out over this long before removal (instant
 * removal mid-morph left a momentary gap — the commit "squish"). */
const EXIT_FADE_MS = 220;
/* Content-swap cross-fade: the old canvas fades over the new one for
 * this long, and is removed a beat later. Intentionally longer than
 * the exit fade — it covers a re-render of the SAME audio. */
const CROSSFADE_MS = 240;
const CROSSFADE_REMOVE_MS = 320;
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
 *   src         — window echoes: a LIST of [startFrac, endFrac]
 *                 content ranges to concatenate (phase 3: a
 *                 multi-segment map concatenates its slices, the
 *                 heard-time picture). Sliced only on redraw; identity
 *                 tracking stays on the ORIGINAL peaks array so polls
 *                 don't churn.
 *   isGhost     — EVERY ghost tile is an audible repetition ("ghosts
 *                 show what sounds") and draws in the cool ECHO tone —
 *                 warm hues are reserved for material (the take tile /
 *                 the live bar).
 *   rotFrac     — phase rotation: where the loop's heard top sits
 *                 within the tile (heard tiles sit on the frame grid).
 */
function drawRepCanvas(div, { peaks, cssWidth, cssHeight, isComposite,
                              live, pxPerSlot, src, isGhost, rotFrac }) {
    let canvas = div.firstElementChild;
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
    // while recording (same ref, growing length) — both covered here
    const dk = peaks.length + ':' + Math.round(cssWidth) + ':' +
        Math.round(cssHeight) + ':' + isComposite + ':' + !!live + ':' +
        Math.round((pxPerSlot || 0) * 1000) + ':' +
        (src ? src.map(r => r[0].toFixed(4) + '-' + r[1].toFixed(4)).join(',') : '') +
        ':' + !!isGhost + ':' + ((rotFrac || 0).toFixed(4));
    if (div._peaksRef === peaks && div._dk === dk) return false;

    // CONTENT SWAP → CROSS-FADE: a new peaks array replacing an old one
    // (live meter peaks → fetched waveform at commit; composite regen)
    // is a re-rendering of the same audio with features shifted a few
    // px — hard-swapping it read as squish/stretch (field video
    // 2026-07-10). The old canvas fades out over the new one.
    if (!live && div._peaksRef && div._peaksRef !== peaks && canvas.width > 0) {
        const old = canvas;
        old.style.transition = 'opacity ' + CROSSFADE_MS + 'ms linear';
        requestAnimationFrame(() => { old.style.opacity = '0'; });
        setTimeout(() => old.remove(), CROSSFADE_REMOVE_MS);
        canvas = document.createElement('canvas');
        div.insertBefore(canvas, old); // new below; old fades on top
    }
    div._peaksRef = peaks;
    div._dk = dk;
    if (live) {
        // Smoothed ratcheting normalization (live_peaks.liveBoost):
        // converges to the committed boost, so commit doesn't pop. The
        // FIXED px-per-slot scale pins every drawn peak to its slot's
        // pixels for the life of the take (poolColumns fixed mode).
        div._liveBoost = liveBoost(div._liveBoost, peaks);
        canvas.style.width = Math.round(cssWidth) + 'px';
        drawWaveform(canvas, peaks, { cssWidth, cssHeight,
            fixedBoost: div._liveBoost, pxPerPeak: pxPerSlot || undefined });
    } else {
        if (div._liveBoost !== undefined) delete div._liveBoost;
        // Pinned, like the live bar: the div's transition reveals/clips
        // the canvas — stretching it mid-morph distorted the content
        canvas.style.width = Math.round(cssWidth) + 'px';
        // Map content draws only its segment(s) — `src` is a LIST of
        // content ranges (phase 3: a multi-segment map concatenates its
        // slices, the heard-time picture); all ghosts draw in the echo
        // tone (audible repetitions — warm is for material).
        let drawPeaks = peaks;
        if (src) {
            const n = peaks.length;
            drawPeaks = [];
            for (const [f0, f1] of src) {
                const a = Math.max(0, Math.floor(f0 * n));
                const b = Math.min(n, Math.max(a + 1, Math.ceil(f1 * n)));
                for (let i = a; i < b; i++) drawPeaks.push(peaks[i]);
            }
            // Phase rotation (heard tiles sit on the frame grid; the
            // loop's top appears at rotFrac of the tile — every sample
            // stays at its true island phase with no wrap sliver).
            const m = drawPeaks.length;
            const rotN = Math.round(((rotFrac || 0) % 1) * m);
            if (rotN > 0 && m > 1) {
                drawPeaks = drawPeaks.slice(m - rotN)
                    .concat(drawPeaks.slice(0, m - rotN));
            }
        }
        // Tone follows GHOSTNESS, not segment-ness: a heard-view lane's
        // bright tile carries `src` (it draws the window segment) but is
        // the sounding material — warm tape, not the cool echo tone.
        drawWaveform(canvas, drawPeaks,
            { cssWidth, cssHeight, isComposite, isEcho: !!isGhost });
    }
    return true; // redrew
}

/** Keep `container`'s children to exactly the built descriptors. */
function reconcileMarkers(container, key, build) {
    if (container._key === key) return;
    container._key = key;
    container.textContent = '';
    build(container);
}

/** The "done" chip that closes an edit view (built in two overlay
 * branches — window editor and take view). */
function makeDoneChip(laneId, title) {
    const done = el('div', 'win-chip win-done-chip toggle',
        { textContent: 'done', title });
    done.addEventListener('click', () => ctx.cb.onWindowEdit(laneId, false));
    return done;
}

/**
 * Patch one lane's body: state classes, grid layer, reps layer, then
 * ONE of three overlay branches, checked in this order:
 *
 *   1. heard-view chrome (lane.windowChipQ && !windowEditing): chip +
 *      trim grips + seam handles — then return.
 *   2. multi-segment map on a group (lane.mapSegs): dims + seam ticks
 *      + one bypass chip + cut bands — then return.
 *   3. the bracket overlay: the lane's window, or the LATENT full-span
 *      window a resting take offers (latentWindow), or — when neither
 *      exists — just the arm marker and cut bands over the take.
 *
 * The heard-time cursor is patched every poll OUTSIDE the keyed
 * rebuilds, and BEFORE the body._winDrag gates — a frozen overlay
 * still shows where the sound is. The overlay itself is NEVER rebuilt
 * under an active drag (the captured node would orphan the gesture),
 * nor during the post-release HOLD (body._winHold, window_edit.js)
 * while the engine has not yet answered the commit.
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
    const { grid, reps: repsL, overlay } = layersOf(body);
    const bodyW = body.clientWidth;
    const peaks = lanePeaks(lane, aux, bodyW);
    const bodyH = body.clientHeight - BODY_V_INSET_PX || BODY_H_FALLBACK_PX;

    // State classes (idempotent via classList.toggle)
    body.classList.toggle('win-bypassed', !!(lane.window && lane.window.bypassed));
    body.classList.toggle('win-suspended', !!(lane.window && lane.window.suspended));
    body.classList.toggle('one-shot', !!lane.oneShot);
    body.classList.toggle('is-recording', !!lane.recording);
    body.classList.toggle('armed-empty',
        lane.kind === 'clip' && !lane.recording && lane.reps.length === 0 && lane.armed);
    // Inspector honesty (field 2026-07-22): an edit-view lane frames
    // its raw take on its own scale — the global playhead is suppressed
    // over it (stacking, see .inspecting) and the amber heard cursor is
    // its one honest cursor.
    body.classList.toggle('inspecting', !!lane.windowEditing);

    // Grid layer: rebuilt only when the frame's tick set changes. The
    // key is a content signature (tickSetSig) — count-equal re-buckets
    // can't render stale (audit 2026-08-11); edge suppression is
    // epsilon-tolerant like the ruler's cycle-end label.
    reconcileMarkers(grid, 'g:' + cycleQ + ':' + tickSetSig(vm.ruler.ticks), g => {
        vm.ruler.ticks.forEach(t => {
            if (approxQ(t.q, 0) || approxQ(t.q, cycleQ)) return;
            const d = el('div', 'gridline' + (t.major ? ' major' : ''));
            d.style.left = pct(t.q, cycleQ);
            g.appendChild(d);
        });
    });

    // SEQUENCE DIMS (docs/sequencer.md §9 — the lanes are the DISPLAY):
    // an enclosing sequence's gated-off spans dim this lane, tiled every
    // pass. A dedicated layer, so the three overlay paths below stay
    // untouched by the sequencer entirely.
    patchSeqDims(body, lane, cycleQ);

    // Reps layer: RECONCILE — reuse divs, update geometry in place.
    // The bar anchors at its Q boundary; in the first-take frame there
    // is no Q yet (quantum = 1 sample — rounding is meaningless and the
    // latency wobble made the left edge vibrate), and the first take by
    // definition starts the timeline: anchor 0.
    const wantBar = lane.recording && !lane.pendingStart;
    const barStartQ = !vm.qEstablished ? 0
        : Math.max(0, Math.round(vm.playheadQ - lane.recordingLengthQ));
    // The bar's edge is "now" (the playhead) — the written content
    // (canvas) trails inside by the latency compensation, and the bar's
    // background marks the being-written zone. Ending the bar at
    // start+length left the playhead visibly ahead of the waveform
    // (field screenshot 2026-07-10).
    const tiles = wantBar
        ? [{
            startQ: barStartQ,
            endQ: Math.max(vm.playheadQ,
                barStartQ + Math.max(lane.recordingLengthQ, MIN_BAR_LEN_Q)),
            ghost: false, bar: true,
        }]
        : lane.reps;

    // Surplus tiles FADE OUT through the settle instead of vanishing:
    // instant removal while the surviving tile is still mid-morph left a
    // momentary gap (the group lane's "squish" at commit — the engine
    // replay proved the state trajectory clean; this was the DOM layer)
    const live = [...repsL.children].filter(d => !d._exiting);
    for (let i = live.length - 1; i >= tiles.length; i--) {
        const d = live[i];
        d._exiting = true;
        d.style.opacity = '0';
        setTimeout(() => d.remove(), EXIT_FADE_MS);
    }
    const rows = live.slice(0, tiles.length);
    tiles.forEach((rep, i) => {
        let div = rows[i];
        if (!div) {
            div = document.createElement('div');
            // A fresh tile must appear AT its geometry, never animate
            // from width 0 ("composite collapses to zero then expands" —
            // field 2026-07-10, when a commit changes the tile count)
            snapThenAnimate(div);
            repsL.appendChild(div);
        }
        const cls = 'rep' + (rep.ghost ? ' ghost' : '') +
            (rep.echo ? ' echo' : '') +
            (rep.bar
                ? ' recording-bar' + (lane.throughMap ? ' map-bar' : '')
                : '');
        if (div.className !== cls) div.className = cls;
        // The live bar draws at a FIXED px-per-slot scale: a peak's
        // pixels are a function of its slot index only, never of the
        // growing count — fit-to-width remapped every column each poll
        // (the "vibrates left and right" field report; worst after a
        // frame extension shrinks the scale). The bar div's edge still
        // advances smoothly, ≤1 slot ahead of the canvas.
        let cssW = Math.max(MIN_TILE_PX,
            bodyW * (rep.endQ - rep.startQ) / cycleQ);
        let pxPerSlot = 0;
        if (rep.bar && peaks && aux.sampleRate) {
            const slotQ = aux.sampleRate / (PEAKS_PER_SECOND * aux.vmQuantum);
            pxPerSlot = bodyW * slotQ / cycleQ;
            cssW = Math.max(MIN_TILE_PX, Math.ceil(peaks.length * pxPerSlot));
        }
        const redrew = drawRepCanvas(div, {
            peaks, cssWidth: cssW, cssHeight: bodyH,
            isComposite: lane.kind === 'group', live: !!rep.bar, pxPerSlot,
            src: rep.srcSegs || (rep.src ? [rep.src] : null),
            isGhost: !!rep.ghost,
            rotFrac: rep.srcTopFrac || 0,
        });

        // MORPH ONLY PURE MOVES; SNAP RE-LAYOUTS. When the canvas was
        // redrawn AND the geometry changed in the same patch (a commit
        // or frame settle), animating the container over new content
        // reads as false motion — the composite visibly "stretched"
        // 255→510px at every growing commit (field 2026-07-10). Since
        // px-per-Q is preserved across the settle, snapping makes the
        // change read as the ghost half lighting up, not movement.
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
    const armQ = vm.armAtQ % cycleQ;
    // Cut-band creation is wired ONCE per body and reads per-patch
    // state — refresh it before any early return so a lane changing
    // views never leaves a stale (wrong-frame) editor behind.
    wireBandCreate(body, lane, vm, cycleQ);
    // HEARD-VIEW chrome (law 13 amendment): a quiet chip + edge grips
    // that EXPAND the lane into its edit view (full raw take with the
    // selection brackets — the seed track's trim view, per lane).
    if (lane.windowChipQ && !lane.windowEditing) {
        // HEARD-VIEW chrome, MODELESS (field 2026-07-23: "just let me
        // manipulate the drag handles live"): the edge grips ARE trim
        // handles (drag adjusts the outer bounds directly, whole-Q
        // snap, commit on release); cuts render as SEAM HANDLES (drag
        // slides the cut freely, ⌥-drag resizes, double-click heals);
        // the chip opens the raw-take inspector for INSPECTION only —
        // never required for editing, and it no longer eats a drag.
        const heardKey = JSON.stringify(
            ['heard', lane.bandSegs, lane.bandTotalQ, lane.windowChipQ,
             lane.mapMulti, cycleQ, lane.takeStartQ, lane.bandEditable,
             lane.reps.map(r => [r.startQ, r.endQ])]);
        if (body._winDrag || body._winHold) return;
        reconcileMarkers(overlay, heardKey, o => {
            const chip = el('div', 'win-chip win-open-chip toggle', {
                title: 'Inspect the whole take (editing works right here)',
                textContent: (lane.mapSuspended ? 'map · suspended (sequence off) · ' : '') +
                    (lane.mapMulti ? 'map ' : 'window ') +
                    fmtQ(lane.windowChipQ) + 'Q' });
            chip.addEventListener('click', () => ctx.cb.onWindowEdit(lane.id, true));
            o.appendChild(chip);
            appendTrimGrips(o, lane, vm, body, cycleQ);
            appendCutBands(o, lane, vm, body, cycleQ);  // heard → seams
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
        if (body._winDrag || body._winHold) return;
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
    // shift by it (field 2026-07-16c: they drew a phase off for takes
    // not anchored at the frame top).
    const anchorQ = lane.takeStartQ || 0;
    const overlayKey = JSON.stringify(
        [win, armedEmpty && armQ, cycleQ, anchorQ,
         lane.bandSegs || null, lane.bandEditable || false,
         lane.windowEditing || false, lane.parentMapSegs || null,
         // The drag closure converts frame Q → samples with vm.quantum
         // and clamps to intrinsicQ: a change in either must rebuild.
         vm.quantum, lane.intrinsicQ || 0, !!lane.isQDefiner]);

    // The heard-time WINDOW CURSOR: where in its window this lane is
    // sounding right now (the engine publishes the window phase on
    // `playhead`). The island playhead sweeps ISLAND time — under an
    // active window the lane hears MAPPED time, and without this cursor
    // the loop looked dead ("the loop window doesn't work anymore",
    // field 2026-07-11). Patched every poll, OUTSIDE the keyed rebuild —
    // and BEFORE the drag gate: during an expanded map drag this same
    // lane frames the RAW take (per-lane scale), the phase maps through
    // the live-committed segments, and the cursor jumps the cuts — the
    // "where is the sound" line the editing view was missing (field
    // 2026-07-25).
    patchWinCursor(overlay, lane, vm, cycleQ);
    if (body._winDrag || body._winHold) return;

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
            label.textContent = '● at ' + (armQ === 0 ? '↺' : fmtQ(armQ) + 'Q');
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
                    // the window end it sat clipped against the lane's
                    // right edge, unreadable (owner feedback 2026-08-08d).
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
                if (lane.windowEditing) {
                    const done = makeDoneChip(lane.id,
                        'Close the window editor (Esc)');
                    done.style.left = pct(anchorQ + startQ, cycleQ);
                    o.appendChild(done);
                }
                if (active && !bypassed && !qDef) {
                    // Heard-time cursor: positioned per poll below. NOT
                    // on the Q-definer — there the MAIN playhead is
                    // mapped into the selection (vm.loopStartQ), and a
                    // second cursor over the same span was the "two
                    // cursors" field bug (2026-07-19).
                    o.appendChild(el('div', 'win-cursor'));
                }
            }
            wireWindow(o, lane, vm, body, win);
        }
        // Cut bands ride alongside the bracket chrome wherever the lane
        // frames its raw material (groups, clip edit views, windowless
        // resting clips).
        appendCutBands(o, lane, vm, body, cycleQ);
        if (lane.windowEditing && !o.querySelector('.win-done-chip')) {
            o.appendChild(makeDoneChip(lane.id,
                'Close the take view (Esc)'));
        }
    });
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
    // A child shown THROUGH an enclosing map (the child heard unroll,
    // 2026-08-21) frames the parent's slice, not its own take — a
    // latent drag here would author a window in the wrong coordinates.
    // The parent owns the chrome.
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
    // Rasterize at least at the lane's own width: at the fixed 800 the
    // 1000px+ lane upsampled (interpolated) the composite, so the
    // group read softer than its children (field 2026-08-29).
    const canvasWidth = Math.max(COMPOSITE_CANVAS_W, Math.ceil(bodyW || 0));
    return generateCompositeWaveform({
        stack: node, stackDuration, effectiveQ: aux.vmQuantum,
        canvasWidth, livePeaks: aux.livePeaks,
        cache: ctx.compositeCache,
        excludeIds: aux.pendingFetch,
        epochSamples: aux.epochSamples || 0,
        // The Q-definer trim view frames the RAW take with the
        // selection over it (pushDefinerLane); its members draw their
        // whole takes beneath. The composite must be the same raw
        // material — the heard mixdown (windowed slices on the epoch
        // grid) disagreed with the children and re-shaped on every
        // trim release (field video 2026-08-29).
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
        for (let base = 0; base < cycleQ; base += P) {
            for (const [s, e] of dims.offSegsQ) {
                const from = base + s;
                const to = Math.min(base + e, cycleQ);
                if (to - from <= 1e-9) continue;
                const d = el('div', 'seq-dim');
                d.dataset.layer = String(li);
                d.style.left = pct(from, cycleQ);
                d.style.width = pct(to - from, cycleQ);
                layer.appendChild(d);
            }
            // CUED spans (docs/sequencer.md ss3): the subtree replays
            // the SONG TOP here - marked, not dimmed (it still sounds;
            // it just re-bases). The pip echoes the grid header's.
            for (const [s, e] of dims.cueSegsQ || []) {
                const from = base + s;
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
