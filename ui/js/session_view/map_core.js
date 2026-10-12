/**
 * MAP-EDIT CORE — what the two editing surfaces share.
 *
 * A loop region (a clip's window, a group's map — one law, I5) is edited
 * from the LANE (splice_handles.js; the cut bands and one-shot chrome of
 * map_bands.js) and from the REGION PANEL (region_panel.js). Both build
 * their gestures out of the pieces here: the `st` band state, the commit
 * path under a gesture's one undo step, the raw-frame preview, and the
 * gesture runner. The move laws are map_moves.js; the interval algebra
 * is ../map_edit.js.
 */

import { ctx } from './context.js';
import { el, pct, setStyle, snapThenAnimate } from './sv_util.js';
import { beginGesture, holdUntilSettled, deferTeardown, runTeardown }
    from './gesture.js';
import { selectOnly } from './selection.js';
import { buildWindowDims } from './dims.js';
import { healCut, segsPeriod } from '../map_edit.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { DEBUG } from '../debug_flags.js';
import { EPS_PERIOD } from './map_moves.js';

/* Live commits (audible while dragging) go out at most this often. */
export const LIVE_COMMIT_THROTTLE_MS = 90;
/* Cut handle glyph width (px, baked into calc()). */
export const CUT_HANDLE_W_PX = 14;
/* The preview badge anchors inward within this fraction of the view's
 * ends, so its text never clips. */
const BADGE_EDGE_FRAC = 0.15;
/* A drag badge keeps this far inside its host's edges (px). */
const BADGE_INSET_PX = 4;
/* The engage gate: a press becomes a drag after this much travel or this
 * long a hold — a sloppy grab-release must not edit. */
export const ENGAGE_SLOP_PX = 4;
export const ENGAGE_HOLD_MS = 160;
/* A sound cursor glides with its CSS transition; a backward jump larger
 * than this fraction of its host is a wrap — snap. */
const CURSOR_WRAP_FRAC = 0.02;
/* A one-shot is at rest from this close to its shot's end (Q): float
 * noise in the fold must not draw one more frame of cursor. */
const REST_EDGE_Q = 1e-9;
/* The tooltip of map chrome the recording gate holds inert. */
export const LOCKED_TITLE = 'Loop edits wait until the take finishes';

/** One heal-on-contextmenu handler per cut. */
export const makeHealMenu = (st, cut) => ev => {
    ev.preventDefault();
    ev.stopPropagation();
    commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
};

/* ---------- the band state ---------- */

/** A covered set as an explicit list: null / [] = the whole take. The
 * runs AS PUBLISHED — never merged (the engine counts every boundary a
 * seam; map_edit coveredSet normalises for the algebra). */
export const keptOf = (segs, totalQ) =>
    (segs && segs.length) ? segs : [[0, totalQ]];

/**
 * Per-patch band state (the `st` every band/seam/trim/slide function
 * speaks):
 *   laneId   — the lane the gesture edits
 *   segs     — covered set (Q, raw-take coords); null = the whole take
 *   totalQ   — raw take extent (Q)
 *   anchorQ  — the lane's content-frame origin (take tile start)
 *   editable — cuts/trims allowed (Q established, no take live — the
 *              recording gate, vm/lane_common.js bandGate)
 *   locked   — editable but for the recording gate: the chrome draws
 *              INERT (visible, never grabbable)
 *   heard    — the lane frames HEARD time (cuts render as seams, the
 *              pointer maps through the segments)
 *   periodQ  — audible period (Q): the published bandPeriodQ, or the
 *              covered set's sum
 *   quantum  — samples per Q
 *   cycleQ   — the lane's display frame
 */
export function bandState(lane, vm, cycleQ) {
    const totalQ = lane.bandTotalQ || 0;
    return {
        laneId: lane.id,
        segs: lane.bandSegs,
        totalQ,
        anchorQ: lane.takeStartQ || 0,
        editable: !!lane.bandEditable,
        locked: !!lane.bandLocked,
        heard: !!lane.bandHeard,
        periodQ: lane.bandPeriodQ || segsPeriod(lane.bandSegs || [], totalQ),
        // A one-shot sounds `periodQ` once per `everyQ` and rests between;
        // 0 on a looping lane (it repeats every `periodQ`).
        everyQ: lane.shotEveryQ || 0,
        quantum: vm.quantum,
        cycleQ,
    };
}

/** The band state's covered set as an explicit list. */
export const coveredSegs = st => keptOf(st.segs, st.totalQ);

/** A covered set in samples, [[start, end), …], each bound rounded. */
export const segsSamples = (segsQ, quantum) =>
    segsQ.map(([a, b]) => [Math.round(a * quantum), Math.round(b * quantum)]);

/** …flat, as the engine takes and publishes it. */
export const flatSegs = (segsQ, quantum) => segsSamples(segsQ, quantum).flat();

/** Is the lane's map SOUNDING (active, not bypassed/suspended)? */
export const laneMapActive = lane =>
    !!(lane.windowChipQ ||
       (lane.window && lane.window.active && !lane.window.bypassed &&
        !lane.window.suspended) ||
       (lane.mapSegs && !lane.mapBypassed && !lane.mapSuspended));

/** Why the lane's stored map is NOT sounding — 'suspended' (authored
 * over a sequence that is off) or 'bypassed' — or null: it sounds, or
 * the lane has none. A clip's window and a group's cut map alike. */
export function laneMapOff(lane) {
    const w = lane.window;
    if ((w && w.suspended) || (lane.mapSegs && lane.mapSuspended)) return 'suspended';
    if ((w && w.bypassed) || (lane.mapSegs && lane.mapBypassed)) return 'bypassed';
    return null;
}

/* ---------- the sound cursor in raw coordinates ---------- */

/** A ONE-SHOT lane's heard offset into its firing (Q), or null in its
 * REST: it sounds `periodQ` from takeStartQ + k·shotEveryQ and rests
 * between (vm/lane_common.js). */
function shotOffsetQ(lane, vm) {
    const h = posMod(vm.playheadQ - (lane.takeStartQ || 0), lane.shotEveryQ);
    return h < lane.periodQ - REST_EDGE_Q ? h : null;
}

/** Where the sound is in RAW take coordinates for `lane` right now: an
 * active map's phase (the engine's published `playhead`, 0..1 of the map
 * period) mapped through the segments as committed; otherwise the island
 * playhead folded into the take — a one-shot's, into its firing. null
 * when nothing sounds there (a one-shot's rest) or it is unknowable.
 *
 * A one-shot's rest is read off the lane's own firing, never off the
 * published phase: that reads 0 through the rest exactly as it does at
 * the shot's top. */
export function rawCursorQ(lane, vm, node) {
    const totalQ = lane.bandTotalQ || 0;
    if (!(totalQ > 0)) return null;
    const firing = lane.shotEveryQ > 0;
    const shotQ = firing ? shotOffsetQ(lane, vm) : 0;
    if (shotQ === null) return null;
    const segs = keptOf(lane.bandSegs, totalQ);
    if (laneMapActive(lane) && node && typeof node.playhead === 'number') {
        const p = segsPeriod(segs, totalQ);
        if (!(p > 0)) return null;
        return mapOffset({ segs }, posMod(node.playhead * p, p));
    }
    if (firing) return Math.min(shotQ, totalQ);
    return posMod(vm.playheadQ - (lane.takeStartQ || 0), totalQ);
}

/** Place a raw-frame sound cursor at fraction `f` of its host. It
 * GLIDES (its CSS transition) and SNAPS where a glide would lie: a wrap,
 * a reappearance, a changed scale (`viewKey`). `f` null or outside
 * [0, 1]: hidden. */
export function placeCursor(cur, f, viewKey = '') {
    const show = f !== null && f >= 0 && f <= 1;
    setStyle(cur, 'display', show ? '' : 'none');
    if (!show) { cur._frac = undefined; return; }
    if (cur._frac === undefined || cur._vk !== viewKey ||
        f < cur._frac - CURSOR_WRAP_FRAC) snapThenAnimate(cur);
    cur._frac = f;
    cur._vk = viewKey;
    setStyle(cur, 'left', (f * 100) + '%');
}

/* ---------- the commit path ---------- */

// THE GESTURE'S ONE UNDO STEP: a drag streams live commits; every commit
// after the gesture's FIRST carries `live` so the engine coalesces it
// into that gesture's undo entry. Each gesture starts fresh (newGesture —
// called by the gesture that is live, never from outside it).
let gestureLive = false;
export function newGesture() { gestureLive = false; }

/** Flatten a segment edit to samples and hand it to the engine — after
 * the categorical coherence guard. `segsQ === null` is a refusal from
 * the interval algebra: keep the previous map, commit nothing. */
export function commitBandSegs(st, segsQ, inGesture = false) {
    if (segsQ === null) return;
    // No gesture may commit a fractional-period map (the engine refuses
    // them too): a gesture bug degrades to "the edit didn't take", never
    // to an LCM cycle explosion.
    const p = segsPeriod(segsQ, st.totalQ);
    if (Math.abs(p - Math.round(p)) > EPS_PERIOD) {
        console.warn('[map] refused incoherent period', p, segsQ);
        return;
    }
    const live = inGesture && gestureLive;
    if (inGesture) gestureLive = true;
    return ctx.cb.onSetSegments(st.laneId, flatSegs(segsQ, st.quantum), live);
}

/** THE RE-TIME's commit (loop_selection.md §9.2; setTiming): move the
 * clip's origin by `shiftSamples` — RELATIVE — and, with a finite
 * `topSamples`, store the top. Under the same undo latch as
 * commitBandSegs (the engine coalesces Timing into Timing only: a swap
 * and a shift are different gestures). */
export function commitTiming(st, shiftSamples, topSamples = null, inGesture = false) {
    const live = inGesture && gestureLive;
    if (inGesture) gestureLive = true;
    return ctx.cb.onSetTiming(st.laneId, Math.round(shiftSamples),
        Number.isFinite(topSamples) ? Math.round(topSamples) : null, live);
}

/** A CANCELLED gesture's undo (the engine's cancelGesture;
 * loop_selection.md §14): the lane goes back exactly where the gesture
 * found it — map, origin, re-time and top, an unset top unset again —
 * and the log keeps no trace (its undo step dropped, the redo branch it
 * invalidated back). Returns the promise the caller holds its picture
 * on, as a commit's. */
export function cancelBandGesture(st) {
    gestureLive = false;
    return ctx.cb.onCancelGesture(st.laneId);
}

/**
 * A RE-TIME DRAG'S SENDER (the lane's ↺ shift, the panel's start
 * marker). setTiming is relative, so each live commit sends only the
 * shift its predecessor had not; a commit that would change nothing
 * returns the last one's promise. `pv` is the lane's pending preview
 * (splice_handles previewer); `top0` the top the gesture starts from
 * (null: it never sends one).
 *
 *   commit(shift, top)  the gesture's total shift so far (samples) and,
 *                       optionally, the top to store → the promise
 *   restore(held)       a cancel: nothing sent → the preview the gesture
 *                       found, and undefined; else the engine's cancel
 *                       (its promise) with `held` as the picture to hold
 *                       until it answers
 */
export function timingSender(st, pv, top0 = null) {
    let sent = 0;
    let sentTop = top0;
    let lastP;
    return {
        commit(shift, top = null) {
            if (shift === sent && top === sentTop) return lastP;
            const delta = shift - sent;
            sent = shift;
            sentTop = top;
            return (lastP = commitTiming(st, delta, top, true));
        },
        restore(held) {
            if (!lastP) {
                pv.restore(null);
                return undefined;
            }
            const p = cancelBandGesture(st);
            sent = 0;
            sentTop = top0;
            pv.restore(held);
            return p;
        },
    };
}

/* ---------- the readouts ---------- */

/** A Q amount for a badge or readout: whole Qs bare, fractions to three
 * decimals (a ⌥ re-time reads "0.025Q"), fp noise snapped. */
export function fmtFineQ(q) {
    const r = Math.round(q * 1000) / 1000;
    return String(Math.abs(r) < 1e-9 ? 0 : r);
}

/** A signed fine Q amount ("+1", "−0.025"): the sign always shown, the
 * minus a real minus. */
export const fmtSignedQ = q => (q >= 0 ? '+' : '−') + fmtFineQ(Math.abs(q));

/**
 * The take's TIMING against how it was played — the panel's readout and
 * the ↺ drag's badge:
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

/** The left (px) of a drag badge `badgeW` wide centred on `centerPx`,
 * kept inside its `hostW`-wide host (which clips). */
export const badgeLeft = (centerPx, badgeW, hostW) =>
    Math.max(BADGE_INSET_PX,
        Math.min(hostW - badgeW - BADGE_INSET_PX, centerPx - badgeW / 2)) + 'px';

/* Map-gesture flight recorder, only under `?debug=true` (debug_flags.js):
 * the last 400 gesture events in `window.__mapDbg`, and a loud warning
 * when two renders under a near-still pointer disagree on the pending
 * segments (a flicker's signature). Off, mapDbg is a no-op. */
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

/** Percent position of raw Q `q` inside a view {q0, spanQ}: the panel's
 * zoomable slice of the take (panel_view.js), the reveal's frame-sized
 * slice at the lane's own scale, a raw host's whole frame. */
export const viewPct = (q, view) => pct(q - view.q0, view.spanQ);

/** The raw-frame drag preview — TWO-LAYER FEEDBACK: a FOLLOW element
 * moves continuously with the pointer (`follow`: a bracket, a band, or
 * the whole kept span) while a dashed snap ghost + badge show the
 * whole-Q landing (`active`), over dims of the pending kept set. Drawn
 * in its OWN layer of the overlay (the grabbed handle lives in the
 * overlay: gesture.js, the freeze law); the stale chrome fades via
 * .drag-live. Positions map through `view`. */
export function renderRawPreview(o, st, segsPreview, active, follow, view) {
    let layer = o.querySelector(':scope > .drag-preview-layer');
    if (!layer) {
        layer = el('div', 'drag-preview-layer');
        o.appendChild(layer);
        o.classList.add('drag-live');
    }
    layer.textContent = '';
    o._key = 'raw-drag';  // poisons the key → fresh reconcile after
    if (!segsPreview) return;
    const cov = keptOf(segsPreview, st.totalQ);
    // Dims over the excluded material, in view coordinates: the dim
    // builder tiles one raw span [0, totalQ) anchored at −q0.
    const fake = { intrinsicQ: st.totalQ, takeStartQ: -view.q0, kind: 'clip' };
    buildWindowDims(layer, { segs: cov }, fake, view.spanQ);
    const mark = (cls, q) => {
        const b = el('div', cls);
        b.style.left = viewPct(q, view);
        layer.appendChild(b);
        return b;
    };
    // Resting bracket lines at the PENDING kept bounds — but for the
    // edge(s) the follow element stands for.
    for (const [edge, q] of [['start', cov[0][0]],
                             ['end', cov[cov.length - 1][1]]]) {
        if (follow && follow.kind === 'bracket' && follow.edge === edge) continue;
        if (follow && follow.kind === 'span') continue;
        mark('win-bracket ' + edge, q);
    }
    if (follow) {
        if (follow.kind === 'bracket') {
            mark('win-bracket dragging ' + follow.edge, follow.q);
        } else if (follow.kind === 'span') {
            mark('win-bracket dragging start', follow.a);
            mark('win-bracket dragging end', follow.b);
        } else {
            mark('cut-band', follow.a).style.width =
                pct(follow.b - follow.a, view.spanQ);
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
        const badge = mark('cut-chip mono' +
            (active.incoherent ? ' incoherent' : ''), active.q);
        badge.textContent = active.text;
        // Above the midline: at centre the text would sit on the follow
        // bracket and the snap ghost.
        badge.style.top = '22%';
        const f = (active.q - view.q0) / view.spanQ;
        badge.style.transform = f < BADGE_EDGE_FRAC
            ? 'translate(0, -50%)'
            : f > 1 - BADGE_EDGE_FRAC
                ? 'translate(-100%, -50%)'
            : 'translate(-50%, -50%)';
        if (active.ghost) mark('cut-ghost', active.q);
    }
}

/** Tear the preview down (its gesture's teardown — see runMapDrag). */
export function clearRawPreview(o) {
    const layer = o.querySelector(':scope > .drag-preview-layer');
    if (layer) layer.remove();
    o.classList.remove('drag-live', 'drag-held');
}

/* ---------- the gesture runner ---------- */

/**
 * The RAW drag's parts (runMapDrag `parts`): the pointer is a raw-take Q
 * clamped to the take, the preview is the raw-frame preview in `view`
 * (() → {q0, spanQ}; it may move under the hand), commits are segment
 * edits, a cancel is the engine's, and the held picture is the landing
 * (the map the gesture found, after a cancel) under .drag-held.
 */
export function rawDragParts(o, st, view) {
    const show = (segs, active = null, follow = null) =>
        renderRawPreview(o, st, segs, active, follow, view());
    return {
        clamp: true,
        preview: res => show(res.segs, res.active, res.follow),
        commit: res => res.segs ? commitBandSegs(st, res.segs, true) : undefined,
        restore: last => (last && last.segs) ? cancelBandGesture(st) : undefined,
        held: res => {
            show(res ? res.segs : coveredSegs(st));
            o.classList.add('drag-held');
        },
        teardown: () => clearRawPreview(o),
    };
}

/** One RAW-frame edit gesture: runMapDrag with the raw drag's parts.
 * `rawQAt` (clientX) → the pointer's raw-take Q (unclamped). */
export function runRawDrag(ev, o, st, { rawQAt, view, ...rest }) {
    return runMapDrag(ev, o, st,
        { posAt: rawQAt, parts: rawDragParts(o, st, view), ...rest });
}

/**
 * Run one map-edit gesture from its pointerdown.
 *
 *   runMapDrag(ev, o, st, {
 *     posAt,    (clientX) → the pointer in the move function's own space
 *               (a raw Q, a lane Q, a delta)
 *     onMove,   (pos | null, altKey) → res | null: the edit function
 *               (map_moves.js, or the caller's own); null at the press
 *               is the at-rest render, a null result keeps the last
 *     parts,    WHAT KIND OF DRAG IT IS — rawDragParts, or the caller's:
 *       clamp     true: `posAt` is a raw Q, clamped to [0, st.totalQ]
 *       preview   (res) → draw it
 *       commit    (res, final) → send it; the promise, or undefined when
 *                 nothing was sent (live calls are throttled here)
 *       restore   (last) → a cancel: put back what the gesture found;
 *                 its promise, or undefined when nothing was sent
 *       held      (res | null) → the picture held after release (the
 *                 landing; null after a cancel) while the commit settles
 *       teardown  () → take the preview down
 *     freeze,   elements whose overlays freeze for the gesture
 *     engage,   false: engaged at the press (default: the engage gate)
 *     onEngage, () once, when the gesture becomes real
 *     onPointer,(mv) every move after engage (autoscroll hooks)
 *     onRelease,(committed, engaged) at the pointer's end, once the
 *               final commit is sent
 *     onTeardown,() when the preview comes down, and at the end of a
 *               press that never engaged
 *   }) → { live, reapply }
 *
 * THE PRESS SELECTS: a loop handle is pressed on ONE track, so the
 * gesture's track (st.laneId) becomes the whole selection at the press —
 * several selected tracks collapse to it.
 *
 * THE ENGAGE GATE: the visuals and the first commit wait for a real drag
 * (ENGAGE_SLOP_PX of travel or an ENGAGE_HOLD_MS hold) — a quick click
 * never edits and never swaps the view, so a double-click finds stable
 * geometry under both clicks.
 *
 * Live commits stream (throttled) under ONE undo step; release commits
 * the last result; a cancel (Escape, lost capture, blur) restores.
 * `reapply()` re-evaluates the pointer's last position (the caller's
 * view moved under a still hand).
 *
 * THE HELD PICTURE: after release the preview STAYS — `held`, no pointer
 * follow, the stale chrome under it hidden and inert — until the commit
 * settles and the next patch rebuilds the hosts from the committed
 * state; that patch tears it down in the same frame (gesture.js
 * deferTeardown). The frame pin holds for the same span (the commit's
 * promise is the gesture's).
 */
export function runMapDrag(ev, o, st, { posAt, onMove, parts, freeze = [],
                                        engage = true, onEngage = null,
                                        onPointer = null, onRelease = null,
                                        onTeardown = null }) {
    const { clamp = false, preview, commit, restore, held, teardown } = parts;
    const downX = ev.clientX;
    let engaged = false;
    let last = null;
    // −∞, not 0: performance.now() counts from page start, and a gesture
    // in the first throttle window must still commit.
    let lastLive = -Infinity;
    let lastX = ev.clientX;
    let lastAlt = ev.altKey;
    const apply = () => {
        if (!engaged || !g.live()) return;
        const raw = posAt(lastX);
        const pos = clamp ? Math.max(0, Math.min(st.totalQ, raw)) : raw;
        const res = onMove(pos, lastAlt);
        if (!res) return;
        last = res;
        preview(res);
        mapDbg('render', { bound: +pos.toFixed(3),
            segs: res.segs && res.segs.map(s => +((s[1] - s[0]).toFixed(2))) });
        const now = performance.now();
        if (now - lastLive > LIVE_COMMIT_THROTTLE_MS) {
            lastLive = now;
            commit(res, false);
        }
    };
    const doEngage = () => {
        if (engaged || !o.isConnected || !g.live()) return;
        engaged = true;
        mapDbg('engage', {});
        // An earlier gesture's held preview on this overlay gives way.
        runTeardown(o);
        for (const host of freeze) g.freeze(host);
        g.pin();  // the shared frame and fold (drag_pin.js)
        if (onEngage) onEngage();
        // The at-rest preview appears at engage, not on the first move.
        const initial = onMove(null, lastAlt);
        if (initial) preview(initial);
    };
    const holdT = engage ? setTimeout(doEngage, ENGAGE_HOLD_MS) : 0;
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
            const p = committed ? (last ? commit(last, true) : undefined)
                                : restore(last);
            const tearDown = () => {
                teardown();
                if (onTeardown) onTeardown();
            };
            if (!p) {
                // Nothing sent: the chrome underneath is the truth.
                if (onRelease) onRelease(committed, true);
                tearDown();
                return undefined;
            }
            held(committed ? last : null);
            const hosts = freeze.length ? freeze : [o];
            hosts.forEach(h => holdUntilSettled(h, p));
            deferTeardown(o, hosts, tearDown);
            if (onRelease) onRelease(committed, true);
            return p;  // the frame stays pinned until p settles
        },
    });
    if (!g.live()) { clearTimeout(holdT); return { live: false, reapply() {} }; }
    // Accepted (a refused press must touch neither): the press selects
    // the gesture's track ALONE, and its first commit is a new undo step.
    selectOnly(st.laneId);
    newGesture();
    if (!engage) doEngage();
    return { live: true, reapply: apply };
}
