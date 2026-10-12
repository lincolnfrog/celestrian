/**
 * THE SPLICE AND THE TOP — a heard lane's loop chrome (loop_selection.md
 * §9).
 *
 * Two kinds of handle for the two things a loop edit can do:
 *   - a SPLICE on every heard repeat of every splice — the WRAP (where
 *     the loop's end jumps back to its start) and each inner CUT —
 *     grabbed by the lane's LOWER half. Drag = SWAP (map_edit slideSeam):
 *     the splice slides with the period held, in heard time, the tiles
 *     following as a LOCAL preview (pending_edits.js). ⇧-drag = the
 *     LENGTH there, through the same-scale reveal (map_bands.js).
 *   - the ↺ TOP on every heard repeat of the loop's one, grabbed by the
 *     UPPER half. Drag = SHIFT: the take's origin moves with the hand
 *     (setTiming) — a re-time, the one gesture that changes WHEN a take
 *     plays.
 * The two are independent even where they coincide: each grabs by its
 * own half.
 *
 * A PLAIN LOOP (no map: the whole take loops) wears the ↺ alone, grabbed
 * by its TAB only — its line sits on the lane's latent brackets and must
 * never steal their press. A bypassed map wears none.
 *
 * GHOSTS: only the handles in the take tile wear their tabs; a ghost
 * repeat's handle is a faint line whose tab shows on hover, and it stays
 * grabbable.
 *
 * OUTSIDE THE KEYED OVERLAY: the handles live in their own layer
 * (.lr-layer), placed on EVERY patch — they move with a drag's preview
 * and with the frame. Mid-gesture, chrome may be CREATED (a repeat
 * entering the frame) and nothing is REMOVED: the grabbed handle holds
 * the pointer capture (gesture.js, the freeze law). Under the recording
 * gate every handle draws INERT (.lr-inert).
 */

import { el, pct, setStyle, setText, setTitle } from './sv_util.js';
import { isGestureLive, isOverlayFrozen } from './gesture.js';
import { selectOnly } from './selection.js';
import { bandState, coveredSegs, commitBandSegs, runMapDrag, cancelBandGesture,
         timingSender, timingText, fmtSignedQ, flatSegs, segsSamples, badgeLeft,
         LOCKED_TITLE } from './map_core.js';
import { lengthMoveFn, cutLenText } from './map_moves.js';
import { runRevealDrag } from './map_bands.js';
import { slideSeam, slideSeamWhole, healCut } from '../map_edit.js';
import { posMod, foldShift } from '../math_utils.js';
import { setPendingEdit, clearPendingEdit, pendingEditOf } from './pending_edits.js';
import { requestRender } from './render_request.js';
import { addDim } from './dims.js';
import { spliceSpots, topSpots, inTakeTile, inTakePass, pairHandles,
         TILE_EPS, MAX_SPOTS } from './splice_spots.js';

/* Tabs within this many px of a lane edge anchor inward (the lane body
 * clips its overflow). */
const TAB_EDGE_LEFT_PX = 14;
const TAB_EDGE_RIGHT_PX = 44;
/* The ↺ tab's half-width and the gap it keeps from the heard chip in
 * the top-right: closer than this, the tab drops below the chip. The
 * chip sits CHIP_RIGHT_PX in from the lane's right edge (session.css
 * .win-heard-chip). */
const TOP_TAB_HALF_PX = 22;
const CHIP_GAP_PX = 4;
const CHIP_RIGHT_PX = 4;
/* The snap ghost shows only when the landing is this far from the hand. */
const SNAP_GHOST_MIN_PX = 1.5;

const TITLES = {
    wrap: 'Splice: where the recording jumps from the loop\'s end back ' +
        'to its start. Drag = swap which material plays (whole Q; ⌥ = free) ' +
        '— the groove stays on the grid and the ↺ stays put. ⇧-drag = ' +
        'the loop\'s length here.',
    cut: 'Cut splice: drag to move the cut (a swap — whole Q; ⌥ = free). ' +
        '⇧-drag = more or less material before it (to nothing heals it). ' +
        'Double-click or right-click heals.',
    top: '↺ The loop\'s top, its one. Drag = shift the audio in time with ' +
        'it (a re-time), a whole Q at a time; ⌥ = fine. The region does ' +
        'not change.',
};

/* ---------- which lanes wear what (exported for the tests) ---------- */

/** Does this lane wear the splice chrome? A committed heard lane — clip
 * or group — with a map to edit (or one the recording gate holds), that
 * is not a one-shot (its offset IS its placement: it keeps its edge
 * grips, map_bands) and not the Q-definer (its trim SETS Q). */
export function wantsSpliceChrome(lane) {
    return !!(lane.windowChipQ && !lane.windowEditing && !lane.oneShot &&
        !lane.isQDefiner && lane.bandHeard &&
        (lane.bandEditable || lane.bandLocked) && lane.bandTotalQ >= 2);
}

/** Does the clip have a ↺? Where a re-time is offered (lane.canRetime)
 * — or would be but for the recording gate (lane.retimeLocked), drawn
 * inert. The lane's ↺, the panel's start marker and its timing readout
 * all start here. */
export function wantsTopHandle(lane) {
    return !!(lane.canRetime || lane.retimeLocked);
}

/** A PLAIN LOOP: a committed clip or group with no map of its own, its
 * whole take tiled where it sounds — the kept set is the take (a
 * group's: its inner cycle). Not a bypassed map (lane.window: the
 * raw-framed bracket overlay), a live take, nor comp mode's raw
 * inspector. */
export function isPlainLoop(lane) {
    return (lane.kind === 'clip' || lane.kind === 'group') && !lane.window &&
        !(lane.windowChipQ > 0) &&
        !lane.windowEditing && !lane.recording;
}

/** Does the lane wear the ↺? Where the clip has one (wantsTopHandle)
 * and the lane shows HEARD time: a heard map, beside its splices, or a
 * plain loop, alone. */
export function wantsLaneTop(lane) {
    if (!wantsTopHandle(lane)) return false;
    return lane.windowChipQ > 0 ? !!lane.bandHeard : isPlainLoop(lane);
}

/**
 * The top the engine will store — and publish — once a swap to `segsQ`
 * lands (the reconcile, time_map.js reconcileTop): `top`, the EFFECTIVE
 * top the swap starts from, while the new kept set still plays it, else
 * the new region start. The swap preview shows it, so the ↺ never jumps
 * when the commit answers.
 *
 * @param {Array<[number, number]>} segsQ  the new covered set, raw Q
 * @param {number} top  the effective top before the swap, samples
 * @param {number} quantum  samples per Q
 * @returns {number|undefined}
 */
export function predictTop(segsQ, top, quantum) {
    if (!segsQ || !segsQ.length) return undefined;
    const segs = segsSamples(segsQ, quantum);
    if (Number.isFinite(top) && segs.some(([a, b]) => top >= a && top < b)) return top;
    return segs[0][0];
}

/** A cut splice's tab: its length, whole Qs bare, a fraction flagged. */
function cutTabText(cut) {
    const { text, whole } = cutLenText(cut[1] - cut[0]);
    return '‖ ' + text + 'Q' + (whole ? '' : ' ⚠');
}

/* ---------- the layer ---------- */

/** The body's handle layer (made once, after the overlay). */
function layerOf(body) {
    if (!body._lrLayer || body._lrLayer.parentNode !== body) {
        body._lrLayer = el('div', 'body-layer lr-layer');
        body.appendChild(body._lrLayer);
        body._lrPools = new Map();   // 'wrap' | 'cut<j>' | 'top' → elements
    }
    return body._lrLayer;
}

/** Every handle out (no gesture holds one). */
function dropAll(body) {
    if (body._lrLayer) body._lrLayer.textContent = '';
    body._lrPools = new Map();
}

/** Every handle hidden but the grabbed one (a gesture still runs). */
function hideAll(body) {
    const d = body._lrDrag;
    for (const els of (body._lrPools || new Map()).values()) {
        for (const h of els) if (!d || h !== d.el) setStyle(h, 'display', 'none');
    }
}

/**
 * Per patch (lane_body, before the overlay's frozen gate): place the
 * lane's splice handles and ↺ — a plain loop's ↺ alone — or clear them
 * off a lane that no longer wears them (mid-gesture: hidden, not
 * removed).
 *
 * @param {Element} body     the lane body
 * @param {Element} overlay  its keyed overlay (the runners' preview key)
 * @param {Object} lane      the lane (view model)
 * @param {Object} vm
 * @param {number} cycleQ    the lane's frame
 */
export function patchSpliceHandles(body, overlay, lane, vm, cycleQ) {
    const keep = isGestureLive();
    const splices = wantsSpliceChrome(lane);
    const withTop = wantsLaneTop(lane);
    if (!splices && !withTop) {
        body._lrCtx = null;
        if (body._lrLayer) {
            if (keep) hideAll(body);
            else dropAll(body);
            layoutDrag(body);
        }
        return;
    }
    layerOf(body);
    body._lrCtx = {
        lane, vm, overlay, cycleQ,
        // A plain loop's kept set is its whole take, so its period (the
        // ↺'s repeat) is the take's.
        st: bandState(lane, vm, cycleQ),
        W: body.clientWidth,
        splices, withTop,
        // A plain loop's ↺ grabs by its tab only, and wears it in the
        // take's PASS (inTakePass).
        plain: isPlainLoop(lane),
    };
    layoutHandles(body, keep);
    layoutDrag(body);
}

/** Place every handle from the lane's current (preview-applied) picture. */
function layoutHandles(body, keep) {
    const c = body._lrCtx;
    const layer = body._lrLayer;
    const { lane, st, cycleQ, W } = c;
    const S = st.periodQ;
    const byPool = new Map();
    if (c.splices) {
        for (const sp of spliceSpots(coveredSegs(st), st.anchorQ, S, cycleQ)) {
            const name = sp.kind === 'wrap' ? 'wrap' : 'cut' + sp.j;
            if (!byPool.has(name)) byPool.set(name, []);
            byPool.get(name).push(sp);
        }
    }
    if (c.withTop) byPool.set('top', topSpots(lane.topHeardQ, S, cycleQ));
    for (const name of body._lrPools.keys()) {
        if (!byPool.has(name)) byPool.set(name, []);
    }
    const drag = body._lrDrag;
    // The heard chip (top-right): the ↺ tab keeps clear of it.
    const chipW = c.withTop ? chipWidth(c.overlay) : 0;
    const chipLeft = chipW > 0 ? W - CHIP_RIGHT_PX - chipW : Infinity;
    for (const [name, spots] of byPool) {
        const els = body._lrPools.get(name) || [];
        const kind = name === 'top' ? 'top' : name === 'wrap' ? 'wrap' : 'cut';
        const dragEl = drag && drag.el && drag.el._pool === name ? drag.el : null;
        const { pairs, surplus } = pairHandles(els, spots, dragEl, drag ? drag.followX : 0);
        const next = [];
        for (const [h0, sp] of pairs) {
            const h = h0 || makeHandle(body, kind, name);
            if (!h0) layer.appendChild(h);
            next.push(h);
            const grabbed = h === dragEl;
            h._spot = sp;
            // The grabbed handle rides the hand (its landing is the
            // snap ghost), even where its repeat has left the frame.
            let x;
            if (grabbed) x = drag.followX;
            else if (sp) x = sp.x;
            else continue;
            placeHandle(h, x, c, {
                kind, sp, grabbed, chipLeft,
                inert: kind === 'top' ? !lane.canRetime : !st.editable,
            });
        }
        // Left over: out when no gesture runs, else hidden (never the
        // grabbed one — pairHandles always places it).
        for (const h of surplus) {
            if (keep) {
                setStyle(h, 'display', 'none');
                next.push(h);
            } else {
                h.remove();
            }
        }
        if (next.length) body._lrPools.set(name, next);
        else body._lrPools.delete(name);
    }
}

/** The heard chip's width (px), measured once per text — a layout read
 * on every patch of every lane would force a reflow per lane. 0 with no
 * chip (yet: the overlay builds it after this layer is placed). */
function chipWidth(overlay) {
    const chip = overlay && overlay.querySelector(':scope > .win-heard-chip');
    if (!chip) return 0;
    if (chip._lrText !== chip.textContent || !(chip._lrW > 0)) {
        chip._lrText = chip.textContent;
        chip._lrW = chip.offsetWidth;
    }
    return chip._lrW;
}

/** Does the handle at lane position `x` wear its tab — the take's
 * (inTakeTile; a plain loop's ↺: the take's pass, inTakePass)? A
 * splice at the frame's right edge (`end`, spliceSpots) is the END of
 * the tile before it: the take's when that tile is. */
function isTakeSpot(c, x, end = false) {
    if (end) return inTakeTile(c.lane.reps, x - 2 * TILE_EPS);
    return c.plain ? inTakePass(c.lane.reps, x, c.st.periodQ, c.cycleQ)
        : inTakeTile(c.lane.reps, x);
}

/** One handle at lane position `x`: tab text, ghostliness, inertness,
 * edge anchoring, and the ↺ tab's clearance from the chip. */
function placeHandle(h, x, c, { kind, sp, grabbed, chipLeft, inert }) {
    const { cycleQ, W } = c;
    setStyle(h, 'display', '');
    setStyle(h, 'left', pct(x, cycleQ));
    const px = W * x / cycleQ;
    h.classList.toggle('lr-at-left', px < TAB_EDGE_LEFT_PX);
    h.classList.toggle('lr-at-right', px > W - TAB_EDGE_RIGHT_PX);
    // The loop's END handle, at the frame's right edge (spliceSpots).
    h.classList.toggle('lr-end', !!(sp && sp.end));
    h.classList.toggle('lr-ghost', !grabbed && !isTakeSpot(c, x, !!(sp && sp.end)));
    h.classList.toggle('lr-inert', !!inert);
    setTitle(h, inert ? LOCKED_TITLE : TITLES[kind]);
    if (kind === 'top') {
        h.classList.toggle('lr-under-chip', px + TOP_TAB_HALF_PX + CHIP_GAP_PX > chipLeft);
        h.classList.toggle('lr-tab-only', !!c.plain);
    }
    const tab = h.firstElementChild;
    if (tab) {
        setText(tab, kind === 'top' ? '↺ top'
            : kind === 'wrap' ? 'splice'
            : sp && sp.cut ? cutTabText(sp.cut) : tab.textContent);
    }
}

/** A handle element: its line is the element, its tab a child; the
 * gestures read the lane's CURRENT context at press time. */
function makeHandle(body, kind, pool) {
    const h = el('div', kind === 'top' ? 'lr-top'
        : 'lr-splice ' + (kind === 'wrap' ? 'lr-wrap' : 'lr-cut'));
    h.appendChild(el('span', 'lr-tab mono'));
    h._body = body;
    h._kind = kind;
    h._pool = pool;
    h.addEventListener('pointerdown', onPress);
    // A double-click on a handle never cuts the cell under it (the
    // body's dblclick): a cut's splice heals, the others swallow it.
    h.addEventListener('dblclick', onHeal);
    if (kind === 'cut') h.addEventListener('contextmenu', onHeal);
    return h;
}

/* ---------- the drag chrome ---------- */

/** The layer's `cls` child, made or removed to match `on`. */
function child(layer, cls, on) {
    let c = layer.querySelector(':scope > .' + cls);
    if (on && !c) {
        c = el('div', cls + (cls === 'lr-badge' ? ' mono' : ''));
        layer.appendChild(c);
    }
    if (!on && c) {
        c.remove();
        c = null;
    }
    return c;
}

/** A drag's chrome — the badge, the snap ghost at the landing, the
 * swept-strip tint — made mid-gesture, gone with it; the grabbed handle
 * rides the hand. */
function layoutDrag(body) {
    const layer = body._lrLayer;
    if (!layer) return;
    const d = body._lrDrag;
    const c = body._lrCtx;
    const on = !!(d && d.engaged && c);
    const tints = child(layer, 'lr-tints', on && !!d.tint);
    const snap = child(layer, 'lr-snap', on && d.ghost);
    const badge = child(layer, 'lr-badge', on);
    if (!on) return;
    const { cycleQ, W } = c;
    setText(badge, d.text);
    // Beside the dragged handle's own tab, clear of the other's: above
    // a splice's (bottom edge), below the ↺'s (top edge).
    badge.classList.toggle('lr-badge-splice', d.kind !== 'top');
    badge.classList.toggle('lr-badge-top', d.kind === 'top');
    // Centred on the hand, inside the lane. One layout read per move.
    setStyle(badge, 'left', badgeLeft(W * d.followX / cycleQ, badge.offsetWidth, W));
    if (snap) setStyle(snap, 'left', pct(d.landX, cycleQ));
    if (tints) {
        // The swept strip on every repeat, by the SIGNED distance: the
        // material the swap changes, in the direction dragged (never
        // "the short way round").
        tints.textContent = '';
        const { base, S } = d.tint;
        const dq = Math.max(-S, Math.min(S, d.tint.d));
        if (Math.abs(dq) > 1e-6 && S > 0 && cycleQ / S <= MAX_SPOTS) {
            for (let x = base - S; x < cycleQ + S; x += S) {
                addDim(tints, cycleQ, Math.min(x, x + dq), Math.max(x, x + dq),
                    'lr-tint');
            }
        }
    }
    if (d.el) setStyle(d.el, 'left', pct(d.followX, cycleQ));
}

/** A drag begins on `h`: the chrome's state, on the body. */
function beginDrag(body, h, kind, x) {
    const d = { el: h, kind, followX: x, landX: x, ghost: false, text: '',
                tint: null, engaged: false };
    body._lrDrag = d;
    return d;
}

/** ...and ends (release, cancel, or a press that never engaged): its
 * chrome goes; the handles return to the lane's picture. Only `d`'s — a
 * newer drag on the body keeps its own. */
function endDrag(body, d) {
    if (body._lrDrag !== d) return;
    body._lrDrag = null;
    if (d.el) d.el.classList.remove('lr-active');
    layoutDrag(body);
}

/* ---------- the preview ---------- */

/**
 * A gesture's handle on the lane's pending preview (the lane's drags
 * and the panel's start marker). A preview still in flight from an
 * EARLIER gesture (its commit not yet polled back) is built on, never
 * cleared (pending_edits pendingEditOf): the new preview carries it, a
 * shift adding to its shift. Nothing in flight: the first show starts a
 * fresh preview (a fresh shift base).
 */
export function previewer(laneId) {
    const prev = pendingEditOf(laneId);
    const merge = mine => {
        const e = Object.assign({}, prev || {});
        for (const [k, v] of Object.entries(mine)) if (v !== undefined) e[k] = v;
        if ((prev && prev.originShift !== undefined) || mine.originShift !== undefined) {
            e.originShift = ((prev && prev.originShift) || 0) + (mine.originShift || 0);
        }
        return e;
    };
    return {
        show(mine) {
            setPendingEdit(laneId, merge(mine));
            requestRender();
        },
        /** A cancel: `mine` is the picture the restore commit lands on
         * (null: nothing was sent — back to what the gesture found). */
        restore(mine) {
            if (mine) setPendingEdit(laneId, merge(mine));
            else if (prev) setPendingEdit(laneId, prev);
            else clearPendingEdit(laneId);
            requestRender();
        },
    };
}

/** The lane's top as the engine will publish it after a swap (clip or
 * group): the reconcile (predictTop) from the top the gesture starts
 * with — the engine's OWN effective top (lane.storedTopQ), never the ↺
 * as shown: on a loop that slots into the frame the ↺ shows where it
 * starts playing, which the engine neither stores nor publishes, and a
 * preview predicted from it would never match the engine's answer.
 * Exported for the tests. */
export function topAfterSwap(lane, st) {
    const q = st.quantum;
    const T0 = Math.round((lane.storedTopQ ?? lane.topQ ?? 0) * q);
    return segsQ => predictTop(segsQ, T0, q);
}

/* ---------- the gestures ---------- */

function onPress(ev) {
    const h = ev.currentTarget;
    const body = h._body;
    const c = body._lrCtx;
    if (ev.button !== 0 || !c || !h._spot) return;
    const inert = h._kind === 'top' ? !c.lane.canRetime : !c.st.editable;
    if (inert) return;   // the gate: the tooltip says why; nothing grabs
    // A drag, or its commit still settling, owns this lane: its preview
    // is the lane's picture until the engine answers.
    if (isOverlayFrozen(body)) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
    }
    if (h._kind === 'top') startTopDrag(ev, h, body);
    else if (ev.shiftKey) startLengthDrag(ev, h, body);
    else startSpliceDrag(ev, h, body);
}

/** Double-click / right-click on a handle: a cut's splice HEALS; any
 * handle swallows the event (no cell cut, no menu under a handle). */
function onHeal(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const h = ev.currentTarget;
    const c = h._body._lrCtx;
    const sp = h._spot;
    if (!c || !sp || h._kind !== 'cut' || !sp.cut || !c.st.editable) return;
    selectOnly(c.lane.id);
    commitBandSegs(c.st, healCut(c.st.segs, sp.cut[0], sp.cut[1], c.st.totalQ));
}

/**
 * One HEARD drag of handle `h` (a swap or a shift): the drag chrome's
 * state on the body, the shared runner (map_core runMapDrag) with the
 * caller's own `preview(res, d)` / `commit` / `restore`, and the
 * chrome's end on every path — a press that never engaged too (each
 * click of a double-click).
 */
function runHandleDrag(ev, h, body, kind, { posAt, onMove, preview, commit, restore }) {
    const c = body._lrCtx;
    const d = beginDrag(body, h, kind, h._spot.x);
    const run = runMapDrag(ev, c.overlay, c.st, {
        posAt,
        onMove,
        parts: {
            preview: res => { preview(res, d); layoutDrag(body); },
            commit,
            restore,
            held: () => { endDrag(body, d); requestRender(); },
            teardown: () => {},
        },
        onTeardown: () => endDrag(body, d),
        freeze: [body],
        onEngage: () => { d.engaged = true; h.classList.add('lr-active'); },
    });
    if (!run.live) endDrag(body, d);
}

/**
 * THE SPLICE DRAG = a SWAP, in heard time. The splice slides (slideSeam:
 * whole Q from the grab, ⌥ free) with the period held; the tiles follow
 * as a local preview; live commits stream (one undo step); the ↺ stays
 * put — or, when the region drops its spot, resets to the region start,
 * as the engine will (topAfterSwap).
 */
function startSpliceDrag(ev, h, body) {
    const sp = h._spot;
    const { lane, st, cycleQ } = body._lrCtx;
    const segs0 = coveredSegs(st).map(s => s.slice());
    const S = st.periodQ;
    const pxPerQ = body.getBoundingClientRect().width / cycleQ;
    // Where the moving splice sounds BEFORE the drag: the tint's base.
    let hQ = 0;
    for (let i = 0; i < sp.j; i++) hQ += segs0[i][1] - segs0[i][0];
    const tintBase = posMod(st.anchorQ + hQ, S);
    const topOf = topAfterSwap(lane, st);
    const pv = previewer(lane.id);
    const show = segsQ => pv.show({ segments: flatSegs(segsQ, st.quantum), top: topOf(segsQ) });
    runHandleDrag(ev, h, body, 'splice', {
        posAt: x => sp.x + (x - ev.clientX) / pxPerQ,
        onMove: (pq, alt) => {
            if (pq === null) return { segs: segs0, deltaQ: 0, pq: sp.x, alt };
            const free = pq - sp.x;
            // Whole Qs from the grab (never the clamp's fractional
            // bound — a sliver, a re-gridded offset); ⌥ = free.
            const r = alt ? slideSeam(segs0, sp.j, free, st.totalQ)
                          : slideSeamWhole(segs0, sp.j, free, st.totalQ);
            return { segs: r.segs, deltaQ: r.deltaQ, pq, alt };
        },
        preview: (res, d) => {
            d.followX = res.pq;
            d.landX = sp.x + res.deltaQ;
            d.ghost = Math.abs(res.pq - d.landX) * pxPerQ > SNAP_GHOST_MIN_PX;
            d.text = (sp.kind === 'cut' ? 'swap · move cut ' : 'swap · splice ') +
                fmtSignedQ(res.deltaQ) + 'Q' + (res.alt ? ' · free' : '');
            d.tint = { base: tintBase, d: res.deltaQ, S };
            show(res.segs);
        },
        commit: res => commitBandSegs(st, res.segs, true),
        restore: last => {
            const p = last ? cancelBandGesture(st) : undefined;
            if (p) show(segs0);
            else pv.restore(null);
            return p;
        },
    });
}

/**
 * ⇧ ON A SPLICE = the LENGTH there (lengthAtSeam), in raw time: the lane
 * unrolls the take at its own scale (the same-scale reveal), anchored
 * so the bound the drag moves — the end of the material before the
 * splice — sits under the pointer. The handles step aside meanwhile
 * (.revealing).
 */
function startLengthDrag(ev, h, body) {
    const c = body._lrCtx;
    const sp = h._spot;
    const st = c.st;
    const segs0 = coveredSegs(st).map(s => s.slice());
    const j = sp.kind === 'cut' ? sp.j : 0;
    const gi = j > 0 ? j - 1 : segs0.length - 1;
    runRevealDrag(ev, c.overlay, st, body, segs0[gi][1],
        lengthMoveFn(st, segs0, j));
}

/**
 * THE ↺ DRAG = a SHIFT: the take's origin moves with the hand (whole Q
 * from the grab; ⌥ fine), so the audio, the ↺ and the splices move
 * together — the preview moves the origin locally; live commits go
 * through the re-time sender (map_core timingSender).
 */
function startTopDrag(ev, h, body) {
    const sp = h._spot;
    const { lane, vm, st, cycleQ } = body._lrCtx;
    const q = st.quantum;
    const pxPerQ = body.getBoundingClientRect().width / cycleQ;
    const msPerQ = vm.sampleRate > 0 ? q / vm.sampleRate * 1000 : 0;
    const retime0 = lane.retimeQ || 0;
    const pv = previewer(lane.id);
    const sender = timingSender(st, pv);
    runHandleDrag(ev, h, body, 'top', {
        posAt: x => (x - ev.clientX) / pxPerQ,
        onMove: (dx, alt) => {
            if (dx === null) return { dx: 0, dq: 0, shift: 0, alt };
            const dq = alt ? dx : Math.round(dx);
            return { dx, dq, shift: Math.round(dq * q), alt };
        },
        preview: (res, d) => {
            d.followX = sp.x + res.dx;
            d.landX = sp.x + res.dq;
            d.ghost = Math.abs(res.dx - res.dq) * pxPerQ > SNAP_GHOST_MIN_PX;
            d.text = 'shift ' + fmtSignedQ(res.dq) + 'Q' +
                (res.alt ? ' · fine' : '') + ' · ' +
                // The running total AS HEARD (foldShift, the readout's).
                timingText(foldShift(retime0 + res.shift / q,
                                     lane.retimePeriodQ || 0), msPerQ);
            pv.show({ originShift: res.shift });
        },
        commit: res => sender.commit(res.shift),
        // Whatever was sent — a net shift of nothing included — its step
        // goes: the log is as the gesture found it.
        restore: () => sender.restore({ originShift: 0 }),
    });
}
