/**
 * MAP-EDIT CORE — what the two editing surfaces share.
 *
 * A loop region (a clip's window, a group's map — one law, I5) is
 * edited from two places that speak one protocol:
 *   - the LANE (map_bands.js): trim grips and seam handles on the
 *     heard view, dragged at the lane's own scale (the same-scale
 *     reveal, 2026-09-11);
 *   - the REGION PANEL (region_panel.js): the whole raw take under the
 *     selected lane, with the kept region as a box you trim, slide,
 *     and cut.
 * Both build their gesture out of the pieces here: the `st` band
 * state, the whole-Q commit path (with the gesture-scoped undo latch),
 * the raw-frame preview renderer, and the three move laws — TRIM,
 * SEAM (slide / ⌥-resize a cut), and SLIDE (the whole region, length
 * held). The interval algebra itself lives in ../map_edit.js.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ } from './sv_util.js';
import { beginGesture, holdOverlay, releaseOverlay } from './gesture.js';
import { buildWindowDims } from './dims.js';
import { applyCut, healCut, resizeCutTarget, slideCutTarget, segsPeriod,
         trimBoundTo, trimBoundForPeriod, slideSegs } from '../map_edit.js';
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
/* Post-commit overlay hold cap (window_edit.js twin): a poll in flight
 * at release still carries the pre-commit map and would snap the seams
 * back for a tick on a slow bridge. */
export const COMMIT_HOLD_MAX_MS = 1500;
/* The engage gate: a press becomes a drag after this much travel or
 * this long a hold — a sloppy grab-release must not edit. */
export const ENGAGE_SLOP_PX = 4;
export const ENGAGE_HOLD_MS = 160;

/** Hold an overlay until a final commit settles (or the cap). */
export function holdUntilSettled(host, p) {
    holdOverlay(host);
    let done = false;
    const settle = () => { if (done) return; done = true; releaseOverlay(host); };
    Promise.resolve(p).then(settle, settle);
    setTimeout(settle, COMMIT_HOLD_MAX_MS);
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
 *   editable — cuts/trims allowed (Q established, not recording)
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
 * views the whole take ({0, totalQ}); the lane reveal views a
 * frame-sized slice of it at the lane's own scale. */
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

/** Tear the preview down (gesture end). */
export function clearRawPreview(o) {
    const layer = o.querySelector(':scope > .drag-preview-layer');
    if (layer) layer.remove();
    o.classList.remove('drag-live');
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
 *     onRelease,(committed) after the preview is torn down
 *   }) → { live, reapply }
 *
 * Live commits stream (throttled, audible) while dragging; release
 * commits the last preview; a cancel (Escape, lost capture, blur)
 * restores the map the gesture began on — the live splices already
 * reached the engine, so doing nothing would keep the preview.
 * `reapply()` re-evaluates the pointer's last position against the
 * CURRENT view (the reveal calls it while it pans under a still hand).
 */
export function runRawDrag(ev, o, st, { rawQAt, view, onMove, freeze = [],
                                        engage = true, onEngage = null,
                                        onPointer = null, onRelease = null }) {
    const downX = ev.clientX;
    let engaged = false;
    let last = null;
    let lastLive = 0;
    let lastX = ev.clientX;
    let lastAlt = ev.altKey;
    const clampQ = q => Math.max(0, Math.min(st.totalQ, q));
    const apply = () => {
        if (!engaged || !g.live()) return;
        const boundQ = clampQ(rawQAt(lastX));
        const res = onMove(boundQ, lastAlt);
        if (!res) return;
        last = res;
        renderRawPreview(o, st, res.segs, res.active, res.follow, view());
        mapDbg('render', { bound: +boundQ.toFixed(3),
            segs: res.segs && res.segs.map(s => +((s[1] - s[0]).toFixed(2))) });
        const now = performance.now();
        if (res.segs && now - lastLive > LIVE_COMMIT_THROTTLE_MS) {
            lastLive = now;
            commitBandSegs(st, res.segs, true);  // LIVE: audible while dragging
        }
    };
    const doEngage = () => {
        if (engaged || !o.isConnected || !g.live()) return;
        engaged = true;
        mapDbg('engage', {});
        for (const host of freeze) g.freeze(host);
        g.pin();  // freeze the SHARED frame + fold (drag_pin.js)
        if (onEngage) onEngage();
        // Immediate feedback: the preview (dims + the followed handle at
        // rest) appears at engage, not on the first move.
        const initial = onMove(null, lastAlt);
        if (initial) {
            renderRawPreview(o, st, initial.segs, initial.active,
                initial.follow, view());
        }
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
            if (!engaged) { if (onRelease) onRelease(false, false); return; }
            mapDbg('up', {});
            clearRawPreview(o);
            // HONOR THE END KIND.
            const hosts = freeze.length ? freeze : [o];
            if (committed) {
                if (last && last.segs) {
                    const p = commitBandSegs(st, last.segs, true);
                    hosts.forEach(h => holdUntilSettled(h, p));
                }
            } else if (last && last.segs) {
                const p = commitBandSegs(st,
                    st.segs ? st.segs.map(sg => sg.slice()) : [[0, st.totalQ]],
                    true);
                hosts.forEach(h => holdUntilSettled(h, p));
            }
            if (onRelease) onRelease(committed, true);
        },
    });
    if (!g.live()) { clearTimeout(holdT); return { live: false, reapply() {} }; }
    if (!engage) doEngage();
    return { live: true, reapply: apply };
}
