/**
 * MAP-EDIT CORE — what the two editing surfaces share.
 *
 * A loop region (a clip's window, a group's map — one law, I5) is
 * edited from two places that speak one protocol:
 *   - the LANE (splice_handles.js; loop-region phase 2, 2026-09-24):
 *     a SPLICE handle on every heard repeat of the wrap and each cut
 *     (drag = swap, in heard time, previewed locally), the ↺ TOP (drag
 *     = shift, a re-time), and ⇧ on a splice = the length there through
 *     the same-scale reveal (map_bands.js);
 *   - the REGION PANEL (region_panel.js): the raw take under the
 *     selected lane through the panel's own zoomable view
 *     (panel_view.js), with the kept region as a box you trim, slide,
 *     and cut, and the ↺ as Ableton's start marker.
 * Both build their gesture out of the pieces here: the `st` band
 * state, the whole-Q commit path (with the gesture-scoped undo latch —
 * shared by the re-time's commits), the raw-frame preview renderer, the
 * gesture runner (raw by default, pluggable for the heard drags), and
 * the move laws — TRIM, SEAM (slide / ⌥-resize a cut), SLIDE (the whole
 * region, length held) and LENGTH (⇧ at a splice). The interval algebra
 * itself lives in ../map_edit.js.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ } from './sv_util.js';
import { beginGesture, holdOverlay, releaseOverlay, afterSettled,
         deferTeardown, runTeardown } from './gesture.js';
import { buildWindowDims } from './dims.js';
import { applyCut, healCut, resizeCutTarget, slideCutTarget, segsPeriod,
         trimBoundTo, trimBoundForPeriod, slideSegs, lengthAtSeam,
         coveredSet } from '../map_edit.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { DEBUG } from '../debug_flags.js';

/* A cut/period length within this tolerance of a whole Q displays as
 * whole (and coherent); further off gets the ⚠ badge. */
export const WHOLE_Q_TOL = 0.02;
/* The dashed snap ghost appears only when the landing differs from the
 * pointer by more than this (free slides have no snap to preview). */
export const SNAP_GHOST_MIN_Q = 0.02;
/* Strict fp tolerance for the categorical period-coherence guard —
 * intentionally far tighter than the DISPLAY tolerance above. */
export const EPS_PERIOD = 1e-6;
/* Live-splice throttle: audible preview commits at most this often
 * while a gesture is in flight. */
export const LIVE_COMMIT_THROTTLE_MS = 90;
/* Cut handle glyph geometry (px offsets baked into calc()). */
export const CUT_HANDLE_W_PX = 14;
/* Preview badge: edge-aware text anchoring inside this fraction of the
 * visible span keeps the label from clipping off the ends. */
const BADGE_EDGE_FRAC = 0.15;
/* The smallest cut a resize preview may show (Q). */
export const MIN_CUT_Q = 0.05;
/* Post-commit overlay hold cap (window_edit.js twin; the gesture
 * runner owns it — the frame pin shares it): a poll in flight at
 * release still carries the pre-commit map and would snap the seams
 * back for a tick on a slow bridge. */
export { COMMIT_HOLD_MAX_MS } from './gesture.js';
/* The engage gate: a press becomes a drag after this much travel or
 * this long a hold — a sloppy grab-release must not edit. */
export const ENGAGE_SLOP_PX = 4;
export const ENGAGE_HOLD_MS = 160;
/* The tooltip of map chrome the recording gate holds inert (the lane's
 * splices, ↺ and one-shot grips; the panel's ↺). */
export const LOCKED_TITLE = 'Loop edits wait until the take finishes';

/** Hold an overlay until a final commit settles (or the cap). */
export function holdUntilSettled(host, p) {
    holdOverlay(host);
    afterSettled(p, () => releaseOverlay(host));
}

/** Cut-length chip content: whole-Q lengths print bare, fractional
 * lengths get two decimals and the ⚠ incoherence badge. */
export function cutChipLabel(lenQ) {
    const whole = Math.abs(lenQ - Math.round(lenQ)) < WHOLE_Q_TOL;
    return {
        text: (whole ? Math.round(lenQ) : lenQ.toFixed(2)) + 'Q cut' +
            (whole ? '' : ' ⚠'),
        incoherent: !whole,
    };
}

/** One heal-on-contextmenu handler per cut: the explicit, timing-proof
 * path (a dblclick near a seam is a fiddly target). */
export const makeHealMenu = (st, cut) => ev => {
    ev.preventDefault();
    ev.stopPropagation();
    commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
};

/**
 * Per-patch band state (the `st` shape every band/seam/trim/slide
 * function speaks):
 *   laneId   — the lane the gesture edits
 *   segs     — covered set (Q, raw-take coords); null = full span
 *   totalQ   — raw take extent (Q)
 *   anchorQ  — the lane's content-frame origin (take tile start)
 *   editable — cuts/trims allowed (Q established, no take live — the
 *              recording gate, view_model bandGate)
 *   locked   — editable but for the recording gate: the chrome draws
 *              INERT (visible, never grabbable)
 *   heard    — lane frames HEARD time (cuts render as seams, the
 *              pointer maps through the segments)
 *   periodQ  — audible period (Q): the published bandPeriodQ, or the
 *              covered-set sum when absent (computed once here)
 *   quantum  — samples per Q (for the setSegments flatten)
 *   cycleQ   — the lane's display frame (per-lane in edit views)
 */
export function bandState(lane, vm, cycleQ) {
    const totalQ = lane.bandTotalQ || 0;
    return {
        laneId: lane.id,
        segs: lane.bandSegs,           // covered set (Q); null = full span
        totalQ,
        anchorQ: lane.takeStartQ || 0,
        editable: !!lane.bandEditable,
        locked: !!lane.bandLocked,
        heard: !!lane.bandHeard,
        periodQ: lane.bandPeriodQ ||
            ((lane.bandSegs && lane.bandSegs.length)
                ? lane.bandSegs : [[0, totalQ]])
                .reduce((n, [a, b]) => n + (b - a), 0),
        quantum: vm.quantum,
        cycleQ,
    };
}

/** The covered set as an explicit list (null = the full span). */
export const coveredSegs = st =>
    (st.segs && st.segs.length) ? st.segs : [[0, st.totalQ]];

/** Is the lane's map SOUNDING (active, not bypassed/suspended)? */
export const laneMapActive = lane =>
    !!(lane.windowChipQ ||
       (lane.window && lane.window.active && !lane.window.bypassed &&
        !lane.window.suspended) ||
       (lane.mapSegs && !lane.mapBypassed));

/** Where the sound is in RAW take coordinates for `lane` right now:
 * an active map's phase (the engine's published `playhead`, 0..1 of
 * the map period) mapped through the segments as committed; otherwise
 * the island playhead folded into the take. null when unknowable. */
export function rawCursorQ(lane, vm, node) {
    const totalQ = lane.bandTotalQ || 0;
    if (!(totalQ > 0)) return null;
    const segs = (lane.bandSegs && lane.bandSegs.length)
        ? lane.bandSegs : [[0, totalQ]];
    if (laneMapActive(lane) && node && typeof node.playhead === 'number') {
        const p = segsPeriod(segs, totalQ);
        if (!(p > 0)) return null;
        return mapOffset({ segs }, posMod(node.playhead * p, p));
    }
    return posMod(vm.playheadQ - (lane.takeStartQ || 0), totalQ);
}

/** Flatten a segment edit to samples and hand it to the engine — after
 * the categorical coherence guard. `segsQ === null` is a refusal from
 * the interval algebra: keep the previous map, commit nothing. */
// GESTURE-SCOPED UNDO (owner ruling 2026-09-10): a drag streams live
// commits; every commit after the gesture's FIRST carries `live` so the
// engine coalesces it into that gesture's undo entry. Each gesture
// starts fresh (newGesture), so two cuts made one after the other are
// two undo steps.
let gestureLive = false;
export function newGesture() { gestureLive = false; }

export function commitBandSegs(st, segsQ, inGesture = false) {
    if (segsQ === null) return;  // refusal: keep the previous map
    // CATEGORICAL COHERENCE: no gesture may commit a fractional-period
    // map — the engine refuses them too (both sides, defense in depth).
    // Every path above snaps periods to whole Qs; this guard makes a
    // gesture bug degrade to "the edit didn't take" instead of an LCM
    // cycle explosion.
    const p = segsPeriod(segsQ, st.totalQ);
    if (Math.abs(p - Math.round(p)) > EPS_PERIOD) {
        console.warn('[map] refused incoherent period', p, segsQ);
        return;
    }
    const flat = [];
    segsQ.forEach(([s, e]) =>
        flat.push(Math.round(s * st.quantum), Math.round(e * st.quantum)));
    const live = inGesture && gestureLive;
    if (inGesture) gestureLive = true;
    return ctx.cb.onSetSegments(st.laneId, flat, live);
}

/** THE RE-TIME's commit (loop_selection.md §9.2; setTiming): move the
 * clip's origin by `shiftSamples` — RELATIVE, so a live drag sends only
 * what its last commit had not — and, with a finite `topSamples`, store
 * the top. Under the same gesture latch as commitBandSegs: a gesture's
 * first commit opens its undo step, the rest coalesce into it (the
 * engine coalesces Timing into Timing only — a swap and a shift are
 * different gestures). */
export function commitTiming(st, shiftSamples, topSamples = null, inGesture = false) {
    const live = inGesture && gestureLive;
    if (inGesture) gestureLive = true;
    return ctx.cb.onSetTiming(st.laneId, Math.round(shiftSamples),
        Number.isFinite(topSamples) ? Math.round(topSamples) : null, live);
}

/* ---------- the readouts ---------- */

/** A Q amount for a badge or readout: whole Qs bare, fractions to three
 * decimals (a ⌥ re-time reads "0.025Q"), fp noise snapped. */
export function fmtFineQ(q) {
    const r = Math.round(q * 1000) / 1000;
    return String(Math.abs(r) < 1e-9 ? 0 : r);
}

/** A signed Q amount ("+1", "−0.25"): the sign always shown, the minus
 * a real minus (the badges' house style). */
export const fmtSignedQ = q => (q >= 0 ? '+' : '−') + fmtFineQ(Math.abs(q));

/**
 * The take's TIMING against how it was played (the prototype's
 * timingText) — the panel's readout and the ↺ drag's badge:
 *   "timing: as played" · "timing: shifted +1Q" ·
 *   "timing: shifted −0.025Q (40 ms earlier)" (under 1Q the milliseconds
 *   say how far — a fine re-time is felt in ms, not in Q).
 *
 * @param {number} retimeQ  the cumulative user shift (lane.retimeQ)
 * @param {number} msPerQ   one Q in milliseconds (quantum / rate × 1000)
 * @returns {string}
 */
export function timingText(retimeQ, msPerQ) {
    const d = Number.isFinite(retimeQ) ? retimeQ : 0;
    if (Math.abs(d) < 1e-9) return 'timing: as played';
    let text = 'timing: shifted ' + fmtSignedQ(d) + 'Q';
    if (Math.abs(d) < 1 && msPerQ > 0) {
        const ms = Math.abs(d) * msPerQ;
        text += ' (' + (ms < 1 ? '<1' : String(Math.round(ms))) + ' ms ' +
            (d < 0 ? 'earlier' : 'later') + ')';
    }
    return text;
}

/* Map-gesture flight recorder for flickers the mock cannot reproduce.
 * Exists only under `?debug=true` (debug_flags.js): a ring of the last
 * 400 gesture events — read `window.__mapDbg` in the app's console
 * after a repro. Also warns loudly when two renders under a near-still
 * pointer disagree on the pending segments (the flicker's signature).
 * Off, mapDbg is a no-op and `window.__mapDbg` is never defined. */
const mapDbgRing = (DEBUG && typeof window !== 'undefined')
    ? (window.__mapDbg = []) : null;
let mapDbgPrev = null;
export function mapDbg(a, rec) {
    if (!mapDbgRing) return;
    const e = Object.assign({ t: Math.round(performance.now()), a }, rec);
    mapDbgRing.push(e);
    if (mapDbgRing.length > 400) mapDbgRing.splice(0, mapDbgRing.length - 400);
    if (a === 'render') {
        const sig = JSON.stringify(rec.segs);
        if (mapDbgPrev && Math.abs(rec.bound - mapDbgPrev.bound) < 0.05 &&
            sig !== mapDbgPrev.sig) {
            console.warn('[map-flicker] segs changed under a still pointer:',
                mapDbgPrev.sig, '→', sig, 'bound', rec.bound);
        }
        mapDbgPrev = { bound: rec.bound, sig };
    } else if (a === 'up' || a === 'engage') {
        mapDbgPrev = null;
    }
}

/* ---------- the raw-frame preview ---------- */

/** Percent position of raw Q `q` inside a view {q0, spanQ}: the panel
 * views its own zoomable slice of the take (panel_view.js); the lane
 * reveal views a frame-sized slice of it at the lane's own scale. */
export const viewPct = (q, view) => pct(q - view.q0, view.spanQ);

/** The raw-frame drag preview — TWO-LAYER FEEDBACK (the bracket law):
 * a pointer-attached FOLLOW element moves continuously with the mouse
 * (`follow`: a bracket, a band, or the whole kept span), while a
 * dashed snap ghost + badge show the whole-Q landing (`active`), over
 * dims of the pending kept set. Rebuilt per move (a dozen nodes; the
 * overlay is frozen and OWNED by the gesture). Positions map through
 * `view` (viewPct); anything outside the view clips at the host's
 * overflow. */
export function renderRawPreview(o, st, segsPreview, active, follow, view) {
    // NEVER wipe the overlay itself: the grabbed handle lives there and
    // holds the pointer capture — clearing it mid-gesture kills the
    // drag. The preview owns a dedicated layer; the stale chrome fades
    // via .drag-live.
    let layer = o.querySelector(':scope > .drag-preview-layer');
    if (!layer) {
        layer = el('div', 'drag-preview-layer');
        o.appendChild(layer);
        o.classList.add('drag-live');
    }
    layer.textContent = '';
    o._key = 'raw-drag';  // poisons the key → fresh reconcile after
    const cov = (segsPreview && segsPreview.length)
        ? segsPreview
        : (segsPreview ? [[0, st.totalQ]] : null);
    if (!cov) return;
    // Dims over the excluded material, in view coordinates: the dim
    // builder tiles one raw span [0, totalQ) anchored at −q0.
    const fake = { intrinsicQ: st.totalQ, takeStartQ: -view.q0, kind: 'clip' };
    buildWindowDims(layer, { segs: cov }, fake, view.spanQ);
    // Resting bracket lines at the PENDING kept bounds (context).
    for (const [edge, q] of [['start', cov[0][0]],
                             ['end', cov[cov.length - 1][1]]]) {
        if (follow && follow.kind === 'bracket' && follow.edge === edge) {
            continue;  // the follow element replaces this edge's bracket
        }
        if (follow && follow.kind === 'span') continue;  // both follow
        const b = el('div', 'win-bracket ' + edge);
        b.style.left = viewPct(q, view);
        layer.appendChild(b);
    }
    // THE FOLLOW ELEMENT: attached to the pointer, continuous — you
    // always see exactly what you're holding.
    if (follow) {
        if (follow.kind === 'bracket') {
            const fb = el('div', 'win-bracket dragging ' + follow.edge);
            fb.style.left = viewPct(follow.q, view);
            layer.appendChild(fb);
        } else if (follow.kind === 'span') {
            for (const [edge, q] of [['start', follow.a], ['end', follow.b]]) {
                const fb = el('div', 'win-bracket dragging ' + edge);
                fb.style.left = viewPct(q, view);
                layer.appendChild(fb);
            }
        } else {
            const band = el('div', 'cut-band');
            band.style.left = viewPct(follow.a, view);
            band.style.width = pct(follow.b - follow.a, view.spanQ);
            layer.appendChild(band);
            for (const [edge, q] of [['start', follow.a], ['end', follow.b]]) {
                const h = el('div', 'cut-handle ' + edge);
                h.style.left = 'calc(' + viewPct(q, view) +
                    (edge === 'end' ? ' - ' + CUT_HANDLE_W_PX + 'px)' : ')');
                h.style.pointerEvents = 'none';
                layer.appendChild(h);
            }
        }
    }
    if (active) {
        const badge = el('div', 'cut-chip mono' +
            (active.incoherent ? ' incoherent' : ''));
        badge.textContent = active.text;
        badge.style.left = viewPct(active.q, view);
        // Ride above the midline: at center the badge text would sit on
        // the follow bracket and the snap ghost, unreadable.
        badge.style.top = '22%';
        // Edge-aware anchoring so the text never clips off the view.
        const f = (active.q - view.q0) / view.spanQ;
        badge.style.transform = f < BADGE_EDGE_FRAC
            ? 'translate(0, -50%)'
            : f > 1 - BADGE_EDGE_FRAC
                ? 'translate(-100%, -50%)'
            : 'translate(-50%, -50%)';
        layer.appendChild(badge);
        // Dashed snap ghost only when the landing differs from the
        // pointer (free slides have no snap to preview).
        if (active.ghost) {
            const line = el('div', 'cut-ghost');
            line.style.left = viewPct(active.q, view);
            layer.appendChild(line);
        }
    }
}

/** Tear the preview down (its gesture's teardown — see runRawDrag). */
export function clearRawPreview(o) {
    const layer = o.querySelector(':scope > .drag-preview-layer');
    if (layer) layer.remove();
    o.classList.remove('drag-live', 'drag-held');
}

/* ---------- the three move laws ----------
 *
 * Each builder returns the gesture's edit function
 *   onMove(rawQ, altKey) → null (refusal — keep the previous preview) or
 *   { segs, follow, active }:
 *     segs:   [[sQ,eQ],…]  the pending covered set (live-committed,
 *                          throttled; final-committed on release)
 *     follow: { kind:'bracket', edge, q } | { kind:'band', a, b } |
 *             { kind:'span', a, b }   — the pointer-attached element
 *     active: { q, text, incoherent, ghost } — the landing badge
 *   rawQ is the pointer's raw-take Q (clamped to [0, totalQ]), or null
 *   for the at-rest render at pointerdown/engage.
 */

/** TRIM one outer bound (`edge`) from `bound0`. Snaps the PERIOD to
 * whole Qs and lands the bound where that period lives; ⌥ SLIDES the
 * whole region by any fractional amount instead (length held). */
export function trimMoveFn(st, segs0, edge, bound00) {
    // The trim's base: the grabbed geometry — or, after an ⌥ slide,
    // the slid geometry re-landed on whole Qs (see below).
    let segs = segs0;
    let bound0 = bound00;
    let slidDelta = 0;
    let wasAlt = false;
    const edgeOf = s => edge === 'start' ? s[0][0] : s[s.length - 1][1];
    return (rawQ, alt) => {
        if (alt && rawQ !== null) {
            // ⌥ FREE SLIDE: the grabbed edge follows the pointer by ANY
            // fractional amount and the other end moves by the same
            // delta — the period is held, so Q coherence survives (the
            // anchoring law keeps content in place; only which stretch
            // is heard changes). Clamped to the take's extent; a slide
            // never trims. Always from the GRAB geometry (a slide is a
            // displacement, not a series of them).
            const { segs: next, deltaQ: delta } =
                slideSegs(segs0, rawQ - bound00, st.totalQ);
            slidDelta = delta;
            wasAlt = true;
            const edgeQ = edgeOf(next);
            const p = segsPeriod(next, st.totalQ);
            return { segs: next,
                follow: { kind: 'bracket', edge, q: edgeQ },
                active: {
                    q: edgeQ,
                    text: 'slide ' + (delta >= 0 ? '+' : '−') +
                        fmtQ(Math.abs(delta)) + 'Q · ' + fmtQ(p) + 'Q',
                    incoherent: false,
                    ghost: false,
                } };
        }
        if (wasAlt && rawQ !== null) {
            // ⌥ RELEASED MID-DRAG (audit 2026-08-31 U2, the bracket law
            // carried over): the slide left the region on a fractional
            // grid, and the plain trim would otherwise forget it and
            // trim from the grab. Re-land the slide on whole Qs first
            // (length held), then trim from THERE.
            wasAlt = false;
            segs = slideSegs(segs0, Math.round(slidDelta), st.totalQ).segs;
            bound0 = edgeOf(segs);
        }
        const rawBound = rawQ === null
            ? bound0                       // at-rest render
            : Math.max(0, Math.min(st.totalQ, rawQ));
        // No snap until the pointer moves — the rest render is the
        // bound as it IS (a free-trimmed fractional bound must not
        // preview a rounded landing it never had).
        let bound = rawBound;
        if (rawQ !== null) {
            // Snap the PERIOD, not the bound (trimBoundForPeriod
            // header): what the pointer proposes is a period — round
            // THAT to whole Qs and land the bound wherever that period
            // lives.
            const pFree = segsPeriod(
                trimBoundTo(segs, edge, rawBound, st.totalQ), st.totalQ);
            if (pFree === null) return null;  // refusal zone
            bound = trimBoundForPeriod(segs, edge, Math.round(pFree), st.totalQ);
        }
        const next = trimBoundTo(segs, edge, bound, st.totalQ);
        if (next === null) return null;  // refusal: keep previous
        const p = segsPeriod(next, st.totalQ);
        const whole = Math.abs(p - Math.round(p)) < EPS_PERIOD;
        return { segs: next,
            // The bracket rides the pointer; the dashed ghost marks the
            // whole-Q-period landing.
            follow: { kind: 'bracket', edge, q: rawBound },
            active: {
                q: bound,
                text: 'loop ' + edge + ' · ' + fmtQ(p) + 'Q' + (whole ? '' : ' ⚠'),
                incoherent: !whole,
                ghost: Math.abs(rawBound - bound) > SNAP_GHOST_MIN_Q,
            } };
    };
}

/** A SEAM (an inner cut `cut` = [inQ, outQ] with kept-neighbourhood
 * clamp [loQ, hiQ]): drag slides the cut freely (length held, its
 * START on the pointer); ⌥-drag resizes (whole-Q snap, its END on the
 * pointer). */
export function seamMoveFn(st, cut, loQ, hiQ) {
    return (rawQ, alt) => {
        const target = rawQ === null
            ? { inQ: cut[0], outQ: cut[1] } // at rest
            : alt
                ? resizeCutTarget({ cut, edge: 'end', rawQ, maxQ: st.totalQ,
                                    loQ, hiQ })
                : slideCutTarget({ cut, rawStartQ: rawQ, maxQ: st.totalQ,
                                   loQ, hiQ });
        let next = healCut(st.segs, cut[0], cut[1], st.totalQ);
        next = applyCut(next, target.inQ, target.outQ, st.totalQ);
        if (next === null) return null;  // refusal: keep previous
        const label = cutChipLabel(target.outQ - target.inQ);
        // Follow: the BAND rides the pointer. Slides are free (band =
        // landing, no ghost); ⌥-resize shows the raw edge under the
        // pointer with the snap ghost at the whole-Q landing.
        const rawEnd = alt && rawQ !== null
            ? Math.min(st.totalQ, Math.max(cut[0] + MIN_CUT_Q, rawQ))
            : target.outQ;
        return { segs: next,
            follow: { kind: 'band', a: target.inQ, b: rawEnd },
            active: {
                q: alt ? target.outQ : (target.inQ + target.outQ) / 2,
                text: label.text,
                incoherent: label.incoherent,
                ghost: alt && Math.abs(rawEnd - target.outQ) > SNAP_GHOST_MIN_Q,
            } };
    };
}

/** SLIDE the whole kept region (every segment as one body, length
 * held) from the grab point `grabQ`: whole-Q steps, ⌥ = any amount.
 * The region panel's "grab the box and move it" verb. */
export function slideMoveFn(st, segs, grabQ) {
    return (rawQ, alt) => {
        const free = rawQ === null ? 0 : rawQ - grabQ;
        const delta = alt ? free : Math.round(free);
        const { segs: next, deltaQ } = slideSegs(segs, delta, st.totalQ);
        const a = next[0][0];
        const b = next[next.length - 1][1];
        const p = segsPeriod(next, st.totalQ);
        return { segs: next,
            follow: { kind: 'span', a, b },
            active: {
                q: (a + b) / 2,
                text: 'slide ' + (deltaQ >= 0 ? '+' : '−') +
                    fmtQ(Math.abs(deltaQ)) + 'Q · ' + fmtQ(p) + 'Q',
                incoherent: false,
                ghost: false,
            } };
    };
}

/* How far past its whole-Q stops the length drag's follow element may
 * run with the hand (Q): it rides the pointer, never far from a stop. */
const LENGTH_FOLLOW_SLACK_Q = 0.45;

/** ⇧ AT SPLICE `j` = THE LENGTH THERE (loop_selection.md P2.4;
 * map_edit lengthAtSeam): the end of the material before the splice —
 * the loop's end at the wrap (j = 0), segment j−1's end at a cut —
 * follows the pointer and lands on whole Qs; right is more material.
 * Run through the same-scale reveal, anchored at that bound. The follow
 * element: the loop's end bracket at the wrap; at a cut, the band from
 * the pointer to the cut's end (it closes as the material grows — a cut
 * shrunk to nothing heals). */
export function lengthMoveFn(st, segs0, j) {
    const cov = coveredSet(segs0, st.totalQ);
    const n = cov.length;
    const cut = j > 0 && j < n;
    const gi = cut ? j - 1 : n - 1;
    const bound0 = cov[gi][1];
    const cutEnd = cut ? cov[j][0] : null;
    // The reachable stops, for the follow element's leash.
    const lo = lengthAtSeam(cov, j, -1e9, st.totalQ).deltaQ;
    const hi = lengthAtSeam(cov, j, 1e9, st.totalQ).deltaQ;
    return rawQ => {
        const { segs, deltaQ } = lengthAtSeam(cov, j,
            rawQ === null ? 0 : rawQ - bound0, st.totalQ);
        const at = bound0 + deltaQ;
        const hand = rawQ === null ? bound0
            : Math.max(bound0 + lo - LENGTH_FOLLOW_SLACK_Q,
                       Math.min(bound0 + hi + LENGTH_FOLLOW_SLACK_Q, rawQ));
        const p = segsPeriod(segs, st.totalQ);
        const healed = cut && at >= cutEnd - EPS_PERIOD;
        return { segs,
            follow: cut ? { kind: 'band', a: Math.min(hand, cutEnd), b: cutEnd }
                        : { kind: 'bracket', edge: 'end', q: hand },
            active: {
                q: at,
                text: cut
                    ? (healed ? 'cut healed · loop ' + fmtQ(p) + 'Q'
                              : 'cut ' + fmtQ(cutEnd - at) + 'Q · loop ' + fmtQ(p) + 'Q')
                    : 'loop ' + fmtQ(p) + 'Q (' + (deltaQ >= 0 ? '+' : '−') +
                      fmtQ(Math.abs(deltaQ)) + ')',
                incoherent: false,
                ghost: Math.abs(hand - at) > SNAP_GHOST_MIN_Q,
            } };
    };
}

/* ---------- the shared raw-frame gesture runner ---------- */

/**
 * Run one raw-frame edit gesture from its pointerdown.
 *
 *   runRawDrag(ev, o, st, {
 *     rawQAt,   (clientX) → the pointer's raw-take Q (unclamped)
 *     view,     () → {q0, spanQ} the preview's view (may move: reveal)
 *     onMove,   the edit function (trimMoveFn / seamMoveFn / …)
 *     freeze,   elements whose overlays freeze for the gesture
 *     engage,   true: the visuals + first commit wait for a real drag
 *               (ENGAGE_SLOP_PX travel or an ENGAGE_HOLD_MS hold) —
 *               a quick click(-click) never edits and never swaps the
 *               view, so double-click heal/create keeps stable
 *               geometry under both clicks. false: engaged at once.
 *     onEngage, () called once when the gesture becomes real
 *     onPointer,(mv) every move after engage (autoscroll hooks)
 *     onRelease,(committed, engaged) at the pointer's end, once the
 *               final commit is sent (the preview may still be up)
 *     onTeardown,() when the preview comes down: see THE HELD PICTURE
 *   }) → { live, reapply }
 *
 * Live commits stream (throttled, audible) while dragging; release
 * commits the last preview; a cancel (Escape, lost capture, blur)
 * restores the map the gesture began on — the live splices already
 * reached the engine, so doing nothing would keep the preview.
 * `reapply()` re-evaluates the pointer's last position against the
 * CURRENT view (the reveal calls it while it pans under a still hand).
 *
 * THE HELD PICTURE: after release the preview STAYS — redrawn at the
 * geometry just sent, still .drag-live over the stale chrome — until
 * the commit settles and the next patch rebuilds the hosts from the
 * committed state; that patch tears it down (gesture.js deferTeardown)
 * in the same frame. Torn down at pointerup, the held overlay would
 * show the PRE-drag chrome for a round trip, then jump. The frame pin
 * holds for the same span (onEnd hands the gesture its commit).
 *
 * PLUGGABLE (loop-region phase 2, 2026-09-24): the HEARD drags — the
 * lane's splice swap and ↺ shift, the panel's start marker — keep this
 * lifecycle (the engage gate, the throttled live commits under one undo
 * step, the freeze and the pin, the held commit, onEnd's promise) but
 * neither draw the raw preview nor commit segments only. They pass:
 *   clamp:    false — `rawQAt` returns the move function's own space
 *             (a lane Q, a delta), not a raw position to clamp;
 *   preview:  (res) → draw it (a pending edit + requestRender);
 *   commit:   (res, final) → send it; the promise, or undefined when
 *             nothing was sent (live calls are throttled here);
 *   restore:  (last) → a cancel's commit putting back what the gesture
 *             found (undefined: nothing to undo);
 *   held:     (res | null) → the picture held after release (the
 *             landing; null after a cancel) while the commit settles;
 *   teardown: () → take the preview down (the deferred teardown).
 * The defaults are the raw drag's own.
 */
export function runRawDrag(ev, o, st, { rawQAt, view = null, onMove,
                                        freeze = [], engage = true,
                                        onEngage = null, onPointer = null,
                                        onRelease = null, onTeardown = null,
                                        clamp = true, preview = null,
                                        commit = null, restore = null,
                                        held = null, teardown = null }) {
    const downX = ev.clientX;
    let engaged = false;
    let last = null;
    // −∞, not 0: performance.now() counts from page (or process) start,
    // so a gesture in the first throttle window must still commit.
    let lastLive = -Infinity;
    let lastX = ev.clientX;
    let lastAlt = ev.altKey;
    const clampQ = q => Math.max(0, Math.min(st.totalQ, q));
    // The raw drag's own preview / commit / restore / held picture /
    // teardown — each replaceable (see PLUGGABLE above).
    const restoredSegs = () =>
        st.segs ? st.segs.map(sg => sg.slice()) : [[0, st.totalQ]];
    const show = preview ||
        (res => renderRawPreview(o, st, res.segs, res.active, res.follow, view()));
    const send = commit ||
        (res => res.segs ? commitBandSegs(st, res.segs, true) : undefined);
    const unsend = restore ||
        (l => (l && l.segs) ? commitBandSegs(st, restoredSegs(), true) : undefined);
    const hold = held || (res => {
        renderRawPreview(o, st, res ? res.segs : restoredSegs(), null, null, view());
        o.classList.add('drag-held');
    });
    const down = teardown || (() => clearRawPreview(o));
    const apply = () => {
        if (!engaged || !g.live()) return;
        const raw = rawQAt(lastX);
        const boundQ = clamp ? clampQ(raw) : raw;
        const res = onMove(boundQ, lastAlt);
        if (!res) return;
        last = res;
        show(res);
        mapDbg('render', { bound: +boundQ.toFixed(3),
            segs: res.segs && res.segs.map(s => +((s[1] - s[0]).toFixed(2))) });
        const now = performance.now();
        if (now - lastLive > LIVE_COMMIT_THROTTLE_MS) {
            lastLive = now;
            send(res, false);  // LIVE: audible while dragging
        }
    };
    const doEngage = () => {
        if (engaged || !o.isConnected || !g.live()) return;
        engaged = true;
        mapDbg('engage', {});
        // An earlier gesture's held preview on this overlay gives way.
        runTeardown(o);
        for (const host of freeze) g.freeze(host);
        g.pin();  // freeze the SHARED frame + fold (drag_pin.js)
        if (onEngage) onEngage();
        // Immediate feedback: the preview (dims + the followed handle at
        // rest) appears at engage, not on the first move.
        const initial = onMove(null, lastAlt);
        if (initial) show(initial);
    };
    const holdT = engage ? setTimeout(doEngage, ENGAGE_HOLD_MS) : 0;
    newGesture();  // its first commit is a new undo step
    const g = beginGesture(ev, {
        stop: true,
        onMove: mv => {
            lastX = mv.clientX;
            lastAlt = mv.altKey;
            if (!engaged && engage &&
                Math.abs(mv.clientX - downX) <= ENGAGE_SLOP_PX) return;
            doEngage();
            if (onPointer) onPointer(mv);
            apply();
        },
        onEnd: committed => {
            clearTimeout(holdT);
            if (!engaged) {
                if (onRelease) onRelease(false, false);
                if (onTeardown) onTeardown();
                return undefined;
            }
            mapDbg('up', {});
            // HONOR THE END KIND: a release commits the last preview; a
            // cancel restores the map the gesture began on.
            const p = committed ? (last ? send(last, true) : undefined)
                                : unsend(last);
            const tearDown = () => {
                down();
                if (onTeardown) onTeardown();
            };
            if (!p) {
                // Nothing sent: the chrome underneath is the truth.
                if (onRelease) onRelease(committed, true);
                tearDown();
                return undefined;
            }
            // THE HELD PICTURE: the landing just sent, no pointer
            // follow, no badge; the stale chrome under it stays hidden
            // and takes no presses (.drag-held) until the teardown.
            hold(committed ? last : null);
            const hosts = freeze.length ? freeze : [o];
            hosts.forEach(h => holdUntilSettled(h, p));
            deferTeardown(o, hosts, tearDown);
            if (onRelease) onRelease(committed, true);
            return p;  // the gesture keeps the frame pinned until p settles
        },
    });
    if (!g.live()) { clearTimeout(holdT); return { live: false, reapply() {} }; }
    if (!engage) doEngage();
    return { live: true, reapply: apply };
}
