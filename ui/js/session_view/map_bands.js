/**
 * CUT BANDS (time_maps.md §4, owner-chosen design A) + the expanded
 * map drag.
 *
 * A cut is a first-class object in the bracket vocabulary: a dim band
 * with two bracket-style handles and a length chip. Double-click the
 * take → a 1Q cut on that Q cell; double-click a cut → it heals; drag
 * the chip → the cut SLIDES freely in position, length held (the
 * "exclude 1Q off the boundary" move); drag a handle → resize, length
 * ALWAYS snapping to whole Qs (the seam theorem is categorical). ⌥ is a
 * MODE key only — ⌥-drag a seam handle resizes instead of sliding
 * (`onMove(rawQ, altKey)`), and ⌥ on a window bracket free-slides the
 * whole window (window_edit.js); neither escapes the whole-Q snap. One
 * setSegments per finished gesture = one undo step.
 * Leading/trailing exclusions stay the WINDOW brackets' domain — bands
 * are only the INNER gaps, so the two gestures never overlap.
 */

import { ctx } from './context.js';
import { el, pct, fmtQ } from './sv_util.js';
import { beginGesture, isDragging, holdOverlay, releaseOverlay }
    from './gesture.js';
import { selectOnly } from './selection.js';
import { buildWindowDims } from './dims.js';
import { innerCuts, applyCut, healCut, cellCutAt, resizeCutTarget,
         slideCutTarget, segsPeriod, trimBoundTo,
         trimBoundForPeriod, cutBounds, slideSegs } from '../map_edit.js';
import { mapOffset } from '../time_map.js';
import { posMod } from '../math_utils.js';
import { DEBUG } from '../debug_flags.js';

/* A cut/period length within this tolerance of a whole Q displays as
 * whole (and coherent); further off gets the ⚠ badge. */
const WHOLE_Q_TOL = 0.02;
/* The dashed snap ghost appears only when the landing differs from the
 * pointer by more than this (free slides have no snap to preview). */
const SNAP_GHOST_MIN_Q = 0.02;
/* Strict fp tolerance for the categorical period-coherence guard —
 * intentionally far tighter than the DISPLAY tolerance above. */
const EPS_PERIOD = 1e-6;
/* Live-splice throttle: audible preview commits at most this often
 * while a gesture is in flight. */
const LIVE_COMMIT_THROTTLE_MS = 90;
/* The engage gate: a press becomes a drag after this much travel or
 * this long a hold — a sloppy grab-release must not edit. */
const ENGAGE_SLOP_PX = 4;
const ENGAGE_HOLD_MS = 160;
/* Warp-echo filter: any single jump this large inside the post-warp
 * suppression window is a warp echo, not a hand. */
const WARP_ECHO_PX = 150;
const WARP_ECHO_WINDOW_MS = 400;
/* Seam-heal hit reach: a dblclick within this many px of a seam means
 * HEAL (matching the handle's reach). */
const SEAM_HIT_PX = 12;
/* Flash-expand: how long a heard lane stays open to show a fresh cut
 * landing in raw context before relaxing. */
const FLASH_EXPAND_MS = 900;
/* Cut/seam handle glyph geometry (px offsets baked into calc()). */
const CUT_HANDLE_W_PX = 14;
const SEAM_HANDLE_HALF_PX = 7;
/* Coincident trim grips nudge apart by this much ("loop end ][ loop
 * start"). */
const GRIP_PAIR_NUDGE_PX = 8;
/* Preview badge: edge-aware text anchoring inside this fraction of the
 * lane keeps the label from clipping off the ends. */
const BADGE_EDGE_FRAC = 0.15;
/* Seam chip edge threshold (Q): keep the chip readable at the frame
 * edges. */
const CHIP_EDGE_Q = 0.4;
/* The smallest cut a resize preview may show (Q). */
const MIN_CUT_Q = 0.05;
/* Post-commit overlay hold cap (window_edit.js twin): a poll in flight
 * at release still carries the pre-commit map and would snap the seams
 * back for a tick on a slow bridge. */
const COMMIT_HOLD_MAX_MS = 1500;

/** Hold the overlay until a final commit settles (or the cap). */
function holdUntilSettled(body, p) {
    holdOverlay(body);
    let done = false;
    const settle = () => { if (done) return; done = true; releaseOverlay(body); };
    Promise.resolve(p).then(settle, settle);
    setTimeout(settle, COMMIT_HOLD_MAX_MS);
}

/** Cut-length chip content: whole-Q lengths print bare, fractional
 * lengths get two decimals and the ⚠ incoherence badge. */
function cutChipLabel(lenQ) {
    const whole = Math.abs(lenQ - Math.round(lenQ)) < WHOLE_Q_TOL;
    return {
        text: (whole ? Math.round(lenQ) : lenQ.toFixed(2)) + 'Q cut' +
            (whole ? '' : ' ⚠'),
        incoherent: !whole,
    };
}

/** One heal-on-contextmenu handler per cut: the explicit, timing-proof
 * path (dblclick near a seam is a fiddly target and the drag warp can
 * split its two clicks apart). */
const makeHealMenu = (st, cut) => ev => {
    ev.preventDefault();
    ev.stopPropagation();
    commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
};

/**
 * Per-patch band state stashed on the body for the once-wired
 * creation/drag handlers (elements rebuild per reconcile; handlers on
 * the body must read fresh state).
 *
 * The `st` shape (the protocol every band/seam/trim function speaks):
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

/** Flatten a segment edit to samples and hand it to the engine — after
 * the categorical coherence guard. `segsQ === null` is a refusal from
 * the interval algebra: keep the previous map, commit nothing. */
function commitBandSegs(st, segsQ) {
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
    return ctx.cb.onSetSegments(st.laneId, flat);
}

/** Pointer x → CONTENT Q (raw-take coordinates). On a heard lane the
 * pointer lives in heard time — hop through the map to the RAW
 * position it selects; on a raw-framed lane it's a plain wrap into
 * the take's period. */
function bandContentQ(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const laneQ = ((clientX - r.left) / r.width) * st.cycleQ;
    if (st.heard && st.periodQ > 0) {
        // Heard lane: the pointer lives in heard time — hop through the
        // map to the RAW position it selects.
        const h = posMod(laneQ - st.anchorQ, st.periodQ);
        return mapOffset({ segs: st.segs || [[0, st.totalQ]] }, h);
    }
    // RIGHT-EDGE CLAMP: a dblclick ON the take's last pixel gives
    // rel === totalQ, which posMod would wrap to 0 (the FIRST cell).
    // In-range positions clamp; wrapping remains for content resting
    // mid-phase (rel outside [0, totalQ]).
    const rel = laneQ - st.anchorQ;
    if (rel >= 0 && rel <= st.totalQ) return Math.min(rel, st.totalQ - 1e-6);
    return posMod(rel, st.totalQ);
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
function mapDbg(a, rec) {
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

/* ---------- EXPANDED MAP DRAG (owner-ruled) -------
 *
 * Geometry edits are RAW-frame facts; editing them in heard space makes
 * handles wrap, chunks vanish off edges, and the ground shift
 * mid-gesture. So grabbing any handle on a heard lane EXPANDS it to the
 * raw take for the duration of the drag — excluded material visible as
 * dims, the cut a real band, the trim bracket over visible content —
 * commits stream live (audible), and release collapses back to the
 * heard view. The main cursor is suppressed over the expanded lane
 * (.inspecting); the raw-frame preview is the ground truth under the
 * pointer.
 */

/** Absolute pointer → RAW-take Q inside the expanded lane. */
function rawQAt(st, body, clientX) {
    const r = body.getBoundingClientRect();
    const q = ((clientX - r.left) / r.width) * st.totalQ;
    return Math.max(0, Math.min(st.totalQ, q));
}

/* trimBoundTo / trimBoundForPeriod / segsPeriod live in map_edit.js
 * (pure interval algebra, unit-tested there); they encode the
 * period-snap law that keeps the cycle LCM from exploding. */

/** The raw-frame drag preview — TWO-LAYER FEEDBACK (the bracket law):
 * a pointer-attached FOLLOW element moves continuously with the mouse
 * (`follow`: a bracket or a band), while a dashed snap ghost + badge
 * show the whole-Q landing (`active`), over dims of the pending kept
 * set. Rebuilt per move (a dozen nodes; the overlay is frozen and
 * OWNED by the gesture). */
function renderRawPreview(o, st, segsPreview, active, follow) {
    // NEVER wipe the overlay itself: the grabbed handle lives there and
    // holds the pointer capture — clearing it mid-gesture kills the
    // drag. The preview owns a dedicated layer; the stale chrome fades
    // via .drag-live.
    let layer = o.querySelector('.drag-preview-layer');
    if (!layer) {
        layer = el('div', 'drag-preview-layer');
        o.appendChild(layer);
        o.classList.add('drag-live');
    }
    layer.textContent = '';
    o._key = 'expanded-drag';  // poisons the key → fresh reconcile after
    const cov = (segsPreview && segsPreview.length)
        ? segsPreview
        : (segsPreview ? [[0, st.totalQ]] : null);
    if (!cov) return;
    const fake = { intrinsicQ: st.totalQ, takeStartQ: 0, kind: 'clip' };
    buildWindowDims(layer, { segs: cov }, fake, st.totalQ);
    // Resting bracket lines at the PENDING kept bounds (context).
    for (const [edge, q] of [['start', cov[0][0]],
                             ['end', cov[cov.length - 1][1]]]) {
        if (follow && follow.kind === 'bracket' && follow.edge === edge) {
            continue;  // the follow element replaces this edge's bracket
        }
        const b = el('div', 'win-bracket ' + edge);
        b.style.left = pct(q, st.totalQ);
        layer.appendChild(b);
    }
    // THE FOLLOW ELEMENT: attached to the pointer, continuous — you
    // always see exactly what you're holding.
    if (follow) {
        if (follow.kind === 'bracket') {
            const fb = el('div', 'win-bracket dragging ' + follow.edge);
            fb.style.left = pct(follow.q, st.totalQ);
            layer.appendChild(fb);
        } else {
            const band = el('div', 'cut-band');
            band.style.left = pct(follow.a, st.totalQ);
            band.style.width = pct(follow.b - follow.a, st.totalQ);
            layer.appendChild(band);
            for (const [edge, q] of [['start', follow.a], ['end', follow.b]]) {
                const h = el('div', 'cut-handle ' + edge);
                h.style.left = 'calc(' + pct(q, st.totalQ) +
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
        badge.style.left = pct(active.q, st.totalQ);
        // Ride above the lane's midline: at center the badge text would
        // sit on the follow bracket and the snap ghost, unreadable.
        badge.style.top = '22%';
        // Edge-aware anchoring so the text never clips off the lane.
        badge.style.transform = active.q < st.totalQ * BADGE_EDGE_FRAC
            ? 'translate(0, -50%)'
            : active.q > st.totalQ * (1 - BADGE_EDGE_FRAC)
                ? 'translate(-100%, -50%)'
            : 'translate(-50%, -50%)';
        layer.appendChild(badge);
        // Dashed snap ghost only when the landing differs from the
        // pointer (free slides have no snap to preview).
        if (active.ghost) {
            const line = el('div', 'cut-ghost');
            line.style.left = pct(active.q, st.totalQ);
            layer.appendChild(line);
        }
    }
}

/** Shared gesture runner: expand → drag in raw space → live commits →
 * final commit → collapse.
 *
 * `onMove(rawQ, altKey)` — the gesture's edit function:
 *   rawQ   {number|null} the pointer's EFFECTIVE raw-take Q (the
 *          relative bound, clamped to [0, totalQ]); null for the
 *          at-rest render at pointerdown/engage.
 *   altKey {boolean} live ⌥ state (mode switch, e.g. slide vs resize).
 *   returns null (refusal — keep the previous preview) or:
 *   {
 *     segs:   [[sQ,eQ],…]   the pending covered set (live-committed,
 *                           throttled; final-committed on release),
 *     follow: { kind:'bracket', edge:'start'|'end', q }   — or —
 *             { kind:'band', a, b }
 *                           the pointer-attached follow element,
 *     active: { q, text, incoherent, ghost }
 *                           the landing badge: position, label,
 *                           coherence style, and whether to draw the
 *                           dashed snap-ghost line at q.
 *   }
 *
 * CAPTURE: the grab pixel lives in HEARD geometry but the expanded lane
 * is RAW geometry, so once the lane opens the pointer is genuinely NOT
 * over the thing it grabbed. The bound is therefore RELATIVE —
 * `anchorQ` (the grabbed thing's raw position) plus accumulated pointer
 * deltas — and the native cursor WARP that unifies pointer and handle
 * is purely cosmetic, so its timing can never disturb the gesture.
 * Where warping is unsupported the mode flips to ABSOLUTE (handle
 * snaps to the pointer, stays glued). Nothing happens before
 * ENGAGE_SLOP_PX of travel — a sloppy grab-release must not edit. */
function runExpandedDrag(ev, o, lane, st, body, anchorQ, onMove) {
    const downX = ev.clientX;
    // The bound is RELATIVE (anchorQ plus accumulated pointer deltas)
    // for the whole gesture, and the warp is pure COSMETICS: because
    // the cursor's absolute position never feeds the bound, the warp
    // can land early, late, or mid-flight without resetting anything.
    // The delta filter also swallows warp echoes (CGWarp during a held
    // button can interleave warped and un-warped event positions inside
    // the suppression interval; any single ≥ WARP_ECHO_PX jump is not a
    // hand, it only rebases).
    //
    // Backends that cannot warp (the mock harness) resolve false and
    // the mode flips to ABSOLUTE: the handle snaps to the pointer and
    // stays glued (one visible jump, but every bound stays reachable —
    // owner-ruled: better a snap than easing complexity).
    let boundQ = anchorQ;
    let absolute = false;
    let prevX = ev.clientX;
    let lastClientY = ev.clientY;
    let warpState = 0;  // 0 untried · 1 requesting · 2 settled
    let echoUntil = 0;  // echo filter armed only just after the warp
    let lastAlt = ev.altKey;
    let engaged = false;
    let last = null;
    let lastLive = 0;
    const apply = () => {
        const res = onMove(boundQ, lastAlt);
        if (!res) return;
        last = res;
        renderRawPreview(o, st, res.segs, res.active, res.follow);
        mapDbg('render', { bound: +boundQ.toFixed(3),
            segs: res.segs && res.segs.map(s => +((s[1] - s[0]).toFixed(2))) });
        const now = performance.now();
        if (res.segs && now - lastLive > LIVE_COMMIT_THROTTLE_MS) {
            lastLive = now;
            commitBandSegs(st, res.segs);  // LIVE: audible while dragging
        }
    };
    // Warp the OS cursor onto the grabbed handle, once the raw view
    // has landed (the pixel mapping is expanded-frame; the horizontal
    // geometry flips in one patch — the lane-open ease is vertical
    // only, so there is no intermediate to ride).
    const tryWarp = () => {
        if (warpState || !g.live()) return;
        if (!ctx.cb.onWarpPointer) { warpState = 2; absolute = true; return; }
        if (!body.classList.contains('inspecting')) {
            setTimeout(tryWarp, 30);   // expansion still in flight
            return;
        }
        warpState = 1;
        const br = body.getBoundingClientRect();
        const x = br.left + (boundQ / st.totalQ) * br.width;
        Promise.resolve(ctx.cb.onWarpPointer(x, lastClientY)).then(ok => {
            warpState = 2;
            mapDbg('warp', { ok });
            if (!ok) { absolute = true; return; }  // snap-to-pointer
            // Warp echoes (warped/un-warped stream interleave) can only
            // exist inside the macOS suppression interval — arm the
            // jump filter for just that window. Armed forever, it eats
            // genuine fast-flick deltas and the handle falls behind the
            // pointer with no way to resync.
            echoUntil = performance.now() + WARP_ECHO_WINDOW_MS;
        });
    };
    // THE ENGAGE GATE: expansion AND warp start only once the press is
    // a real drag — > ENGAGE_SLOP_PX of travel or an ENGAGE_HOLD_MS
    // hold. A quick click(-click) never expands and never moves the
    // cursor, so double-click heal/create keeps stable geometry under
    // both of its clicks (an immediate warp would teleport the cursor
    // between them, and the expansion would move the seam out from
    // under click two — a doubled split).
    const engage = () => {
        if (engaged || !body.isConnected) return;
        engaged = true;
        mapDbg('engage', {});
        clearTimeout(body._flashT);     // a drag supersedes a flash
        g.freeze(body);                 // freeze the overlay reconcile
        g.pin();                        // freeze the SHARED frame + fold
        ctx.cb.onWindowEdit(lane.id, true); // expand to the raw take
        // The raw-frame SOUND CURSOR lives through the gesture (the
        // poll keeps positioning it — patchWinCursor runs before the
        // isOverlayFrozen gates): you hear the live splice AND see where it
        // is sounding.
        if (!o.querySelector('.win-cursor')) {
            o.appendChild(el('div', 'win-cursor'));
        }
        // Immediate feedback: the preview (dims + the followed handle
        // at rest) appears with the expansion, not on the first move.
        const initial = onMove(null, lastAlt);
        if (initial) {
            renderRawPreview(o, st, initial.segs, initial.active,
                initial.follow);
        }
        tryWarp();
    };
    const holdT = setTimeout(engage, ENGAGE_HOLD_MS);
    const move = mv => {
        if (!engaged && Math.abs(mv.clientX - downX) <= ENGAGE_SLOP_PX) return;
        engage();
        if (absolute) {
            boundQ = rawQAt(st, body, mv.clientX);
        } else {
            const dx = mv.clientX - prevX;
            if (Math.abs(dx) >= WARP_ECHO_PX &&
                performance.now() < echoUntil) {
                mapDbg('echo', { dx: Math.round(dx) });
                // warp echo (only possible in the post-warp suppression
                // window): rebase without applying
            } else {
                const w = body.getBoundingClientRect().width || 1;
                boundQ = Math.max(0, Math.min(st.totalQ,
                    boundQ + (dx / w) * st.totalQ));
            }
        }
        prevX = mv.clientX;
        lastAlt = mv.altKey;
        lastClientY = mv.clientY;
        apply();
    };
    // The runner owns capture, the lost-capture/blur net, the freeze +
    // pin (released automatically), and the exactly-once end.
    const g = beginGesture(ev, {
        stop: true,
        onMove: move,
        onEnd: committed => {
            clearTimeout(holdT);
            if (!engaged) return;         // a click: nothing to undo
            mapDbg('up', {});
            const layer = o.querySelector('.drag-preview-layer');
            if (layer) layer.remove();
            o.classList.remove('drag-live');
            // HONOR THE END KIND: a cancel (Escape, lost capture, blur)
            // restores the map the gesture began on — the live splices
            // already streamed to the engine, so doing nothing would
            // keep the last preview as if it had been committed.
            if (committed) {
                if (last && last.segs) {
                    holdUntilSettled(body, commitBandSegs(st, last.segs));
                }
            } else if (last && last.segs) {
                holdUntilSettled(body, commitBandSegs(st,
                    st.segs ? st.segs.map(sg => sg.slice())
                            : [[0, st.totalQ]]));
            }
            ctx.cb.onWindowEdit(lane.id, false);  // relax back to the heard view
        },
    });
    if (!g.live()) { clearTimeout(holdT); return; }  // gesture singleton
}

/** The once-per-body dblclick wiring: create a cell-snapped 1Q cut on
 * the take; heal the cut under the pointer. Wired ONCE per body
 * element (guarded by `body._bandsWired`); every patch refreshes
 * `body._bandState` so the handler always reads current-frame state —
 * a lane changing views must never leave a stale (wrong-frame) editor
 * behind. */
export function wireBandCreate(body, lane, vm, cycleQ) {
    body._bandState = bandState(lane, vm, cycleQ);
    if (body._bandsWired) return;
    body._bandsWired = true;
    body.addEventListener('dblclick', ev => {
        const st = body._bandState;
        if (!st || !st.editable || st.totalQ < 2) return;
        selectOnly(st.laneId); // editing a track claims it ([ ] target)
        // HEARD lanes: a cut has ZERO width (it IS the splice), so the
        // pointer can never be "inside" it — a dblclick meant to heal
        // would land on adjacent content and cut ANOTHER Q, merging
        // into a doubled cut. Near a seam (±SEAM_HIT_PX, matching the
        // handle's reach) the dblclick means HEAL.
        if (st.heard && st.segs && st.segs.length > 1) {
            const br = body.getBoundingClientRect();
            const periodQ = st.periodQ;
            let acc = 0;
            for (let i = 0; i < st.segs.length - 1; i++) {
                acc += st.segs[i][1] - st.segs[i][0];
                const first = posMod(st.anchorQ + acc, st.cycleQ) % periodQ;
                for (let q = first; q < st.cycleQ; q += periodQ) {
                    const px = br.left + (q / st.cycleQ) * br.width;
                    if (Math.abs(ev.clientX - px) < SEAM_HIT_PX) {
                        commitBandSegs(st, healCut(st.segs,
                            st.segs[i][1], st.segs[i + 1][0], st.totalQ));
                        return;
                    }
                }
            }
        }
        const q = bandContentQ(st, body, ev.clientX);
        const cut = innerCuts(st.segs, st.totalQ)
            .find(([a, b]) => q >= a && q < b);
        if (cut) {
            commitBandSegs(st, healCut(st.segs, cut[0], cut[1], st.totalQ));
        } else {
            const [a, b] = cellCutAt(q, st.totalQ);
            commitBandSegs(st, applyCut(st.segs, a, b, st.totalQ));
        }
        // FLASH-EXPAND (the one principle: every manipulation shows the
        // whole clip + map structure): a heard lane opens briefly so
        // the new cut is seen landing in raw context, then relaxes —
        // unless a drag has taken over in the meantime.
        if (st.heard) {
            clearTimeout(body._flashT);
            ctx.cb.onWindowEdit(st.laneId, true);
            body._flashT = setTimeout(() => {
                if (!isDragging(body)) ctx.cb.onWindowEdit(st.laneId, false);
            }, FLASH_EXPAND_MS);
        }
    });
}

/** The bands themselves, rebuilt per overlay reconcile. On heard-view
 * lanes a cut has ZERO width (it IS the splice), so it renders as a
 * SEAM HANDLE: passive ticks on every rep, one grabbable handle + chip
 * per cut on the take rep — drag slides the cut freely (length held),
 * ⌥-drag resizes (whole-Q snap), double-click heals. */
export function appendCutBands(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!st.editable || st.totalQ < 2) return;
    if (st.heard) {
        appendSeamHandles(o, lane, st, body, cycleQ);
        return;
    }
    const cuts = innerCuts(st.segs, st.totalQ);
    cuts.forEach(cut => {
        const band = el('div', 'cut-band');
        const chip = el('div', 'cut-chip mono', {
            title: 'Drag to slide the cut (length held) — ' +
                'right-click or double-click heals' });
        const handles = {};
        for (const edge of ['start', 'end']) {
            handles[edge] = el('div', 'cut-handle ' + edge,
                { title: 'Drag to resize — length snaps to whole Qs' });
        }
        const ghost = el('div', 'cut-ghost');
        ghost.style.display = 'none';

        const layout = (a, b, raw) => {
            band.style.left = pct(st.anchorQ + a, cycleQ);
            band.style.width = pct(b - a, cycleQ);
            handles.start.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'start'
                    ? raw.q : a), cycleQ) + ')';
            handles.end.style.left =
                'calc(' + pct(st.anchorQ + (raw && raw.edge === 'end'
                    ? raw.q : b), cycleQ) +
                ' - ' + CUT_HANDLE_W_PX + 'px)';
            chip.style.left = pct(st.anchorQ + (a + b) / 2, cycleQ);
            const label = cutChipLabel(b - a);
            chip.textContent = label.text;
            chip.classList.toggle('incoherent', label.incoherent);
        };
        layout(cut[0], cut[1]);

        // Drag machinery — the bracket pattern: pointer capture, the
        // handle/chip follows the pointer, the ghost previews the snap,
        // release commits ONE setSegments.
        const startDrag = (kind, edge) => ev => {
            let target = null;
            const g = beginGesture(ev, {
                stop: true,
                claim: lane.id, // grabbing a handle claims the track
                onMove: mv => move(mv),
                onEnd: committed => {
                    // HONOR THE END KIND: live splices streamed while
                    // dragging — a cancel must restore the pre-drag
                    // map, not keep the preview.
                    if (committed && target) {
                        let next = healCut(st.segs, cut[0], cut[1], st.totalQ);
                        next = applyCut(next, target.inQ, target.outQ, st.totalQ);
                        holdUntilSettled(body, commitBandSegs(st, next));
                    } else if (!committed && band._lastLive) {
                        holdUntilSettled(body, commitBandSegs(st,
                            st.segs ? st.segs.map(sg => sg.slice())
                                    : [[0, st.totalQ]]));
                    }
                },
            });
            if (!g.live()) return;  // gesture singleton
            g.freeze(body);
            g.pin();  // freeze the shared frame (see drag_pin.js)
            const q0 = bandContentQ(st, body, ev.clientX);
            // Kept-neighbourhood clamp (cutBounds): the gesture may
            // meet a neighbouring gap only at exact adjacency.
            const [loQ, hiQ] = cutBounds(st.segs, cut, st.totalQ);
            const move = mv => {
                const q = bandContentQ(st, body, mv.clientX);
                if (kind === 'slide') {
                    target = slideCutTarget({
                        cut, rawStartQ: cut[0] + (q - q0),
                        maxQ: st.totalQ, loQ, hiQ });
                    layout(target.inQ, target.outQ);
                    ghost.style.display = 'none';
                } else {
                    target = resizeCutTarget({
                        cut, edge, rawQ: q, maxQ: st.totalQ, loQ, hiQ });
                    layout(target.inQ, target.outQ, { edge, q });
                    ghost.style.display = '';
                    ghost.style.left = pct(st.anchorQ +
                        (edge === 'start' ? target.inQ : target.outQ),
                        cycleQ);
                }
                // LIVE SPLICE (see the seam handles): audible preview
                // while dragging, coalesced undo.
                const now = performance.now();
                if (target && now - (band._lastLive || 0) >
                        LIVE_COMMIT_THROTTLE_MS) {
                    band._lastLive = now;
                    let liveNext = healCut(st.segs, cut[0], cut[1], st.totalQ);
                    liveNext = applyCut(liveNext, target.inQ, target.outQ,
                                        st.totalQ);
                    commitBandSegs(st, liveNext);
                }
            };
        };
        chip.addEventListener('pointerdown', startDrag('slide'));
        handles.start.addEventListener('pointerdown', startDrag('resize', 'start'));
        handles.end.addEventListener('pointerdown', startDrag('resize', 'end'));
        // Right-click = heal (see the seam handles): the explicit,
        // timing-proof path.
        const healMenu = makeHealMenu(st, cut);
        [band, chip, handles.start, handles.end].forEach(node =>
            node.addEventListener('contextmenu', healMenu));

        o.append(band, handles.start, handles.end, chip, ghost);
    });
}

/** Seam handles for heard-view lanes (see appendCutBands). */
function appendSeamHandles(o, lane, st, body, cycleQ) {
    const segs = (st.segs && st.segs.length)
        ? st.segs : [[0, st.totalQ]];
    if (segs.length < 2) return;  // no inner cuts, no seams
    // Heard position of each join + the raw cut behind it.
    const seams = [];
    let acc = 0;
    for (let i = 0; i < segs.length - 1; i++) {
        acc += segs[i][1] - segs[i][0];
        seams.push({ heardQ: acc, cut: [segs[i][1], segs[i + 1][0]] });
    }
    const baseQ = st.anchorQ;
    const periodQ = st.periodQ;
    // A lane position for a heard offset, WRAPPED into the frame (the
    // content may rest mid-phase; an unwrapped seam would land on the
    // frame edge, half-clipped and out of reach).
    const wrapQ = heardQ => posMod(baseQ + heardQ, cycleQ);
    // Passive ticks at every audible splice across the frame.
    for (const s of seams) {
        const first = wrapQ(s.heardQ) % periodQ;
        for (let q = first; q < cycleQ; q += periodQ) {
            if (q < 1e-9 || q > cycleQ - 1e-9) continue;
            const t = el('div', 'map-seam-tick');
            t.style.left = pct(q, cycleQ);
            o.appendChild(t);
        }
    }
    // Grabbable handle + chip, wrapped with the content.
    seams.forEach(seam => {
        const handle = el('div', 'seam-handle', {
            title: 'The cut lives here — drag to slide it, ' +
                '⌥-drag to resize, right-click (or double-click) to heal' });
        const chip = el('div', 'cut-chip mono');
        const layout = (heardQ, cut) => {
            const q = wrapQ(heardQ);
            handle.style.left = 'calc(' + pct(q, cycleQ) +
                ' - ' + SEAM_HANDLE_HALF_PX + 'px)';
            chip.style.left = pct(q, cycleQ);
            // Keep the chip readable at the frame edges.
            chip.style.transform = q < CHIP_EDGE_Q ? 'translate(0, -50%)'
                : q > cycleQ - CHIP_EDGE_Q ? 'translate(-100%, -50%)'
                : 'translate(-50%, -50%)';
            const label = cutChipLabel(cut[1] - cut[0]);
            chip.textContent = '‖ ' + label.text;
            chip.classList.toggle('incoherent', label.incoherent);
        };
        layout(seam.heardQ, seam.cut);

        handle.addEventListener('dblclick', ev => {
            ev.stopPropagation();
            commitBandSegs(st,
                healCut(st.segs, seam.cut[0], seam.cut[1], st.totalQ));
        });
        // Right-click = heal, explicitly (dblclick near a seam is a
        // fiddly target and the drag warp can split its two clicks
        // apart — this path has no timing to break).
        const healMenu = makeHealMenu(st, seam.cut);
        handle.addEventListener('contextmenu', healMenu);
        chip.addEventListener('contextmenu', healMenu);
        const startDrag = ev => {
            selectOnly(lane.id); // grabbing a handle claims the track
            // EXPANDED DRAG (owner-ruled): the lane opens to the raw
            // take; the cut is a real band over visible content. Drag
            // slides it freely (length held), ⌥-drag resizes (whole-Q
            // snap). Deltas are RAW-frame from the first post-expansion
            // pointer sample, so nothing jumps.
            // Anchor by the mode chosen at the grab: a slide carries
            // the cut's start, ⌥-resize carries its end edge.
            const anchor0 = ev.altKey ? seam.cut[1] : seam.cut[0];
            // Kept-neighbourhood clamp (cutBounds): exact adjacency
            // only — a slide/resize can never fractionally overlap a
            // neighbouring gap.
            const [loQ, hiQ] = cutBounds(st.segs, seam.cut, st.totalQ);
            runExpandedDrag(ev, o, lane, st, body, anchor0, (rawQ, alt) => {
                // The seam glyph marks where the cut BEGINS — the cut's
                // start is what rides the pointer on a slide; ⌥-resize
                // glues the END edge to it instead.
                const target = rawQ === null
                    ? { inQ: seam.cut[0], outQ: seam.cut[1] } // at rest
                    : alt
                        ? resizeCutTarget({ cut: seam.cut, edge: 'end',
                                            rawQ, maxQ: st.totalQ,
                                            loQ, hiQ })
                        : slideCutTarget({ cut: seam.cut,
                                           rawStartQ: rawQ,
                                           maxQ: st.totalQ, loQ, hiQ });
                let next = healCut(st.segs, seam.cut[0], seam.cut[1],
                                   st.totalQ);
                next = applyCut(next, target.inQ, target.outQ, st.totalQ);
                if (next === null) return null;  // refusal: keep previous
                const label = cutChipLabel(target.outQ - target.inQ);
                // Follow: the BAND rides the pointer. Slides are free
                // (band = landing, no ghost); ⌥-resize shows the raw
                // edge under the pointer with the snap ghost at the
                // whole-Q landing.
                const rawEnd = alt && rawQ !== null
                    ? Math.min(st.totalQ,
                               Math.max(seam.cut[0] + MIN_CUT_Q, rawQ))
                    : target.outQ;
                return { segs: next,
                    follow: { kind: 'band', a: target.inQ, b: rawEnd },
                    active: {
                        q: alt ? target.outQ
                               : (target.inQ + target.outQ) / 2,
                        text: label.text,
                        incoherent: label.incoherent,
                        ghost: alt && Math.abs(rawEnd - target.outQ) >
                            SNAP_GHOST_MIN_Q,
                    } };
            });
        };
        handle.addEventListener('pointerdown', startDrag);
        chip.addEventListener('pointerdown', startDrag);
        o.append(handle, chip);
    });
}

/** Live TRIM handles on a heard-view lane's outer edges (grips DRAG,
 * never open a mode). Dragging inward
 * consumes kept time (whole-Q snap); outward reveals more of the take.
 * One setSegments on release — the single-window case delegates to
 * setLoopPoints inside the engine, preserving the existing semantics.
 */
export function appendTrimGrips(o, lane, vm, body, cycleQ) {
    const st = bandState(lane, vm, cycleQ);
    if (!st.editable || st.totalQ < 2) return;
    const segs = (st.segs && st.segs.length) ? st.segs : [[0, st.totalQ]];
    const periodQ = st.periodQ;
    // The grips hug the CONTENT's heard bounds (the loop may rest
    // mid-phase — its top is the bright tile's start, not the frame
    // edge).
    const startPos = st.anchorQ % cycleQ;
    const endRaw = startPos + Math.min(periodQ, cycleQ);
    const endPos = endRaw <= cycleQ + 1e-9 ? Math.min(endRaw, cycleQ)
                                           : endRaw % cycleQ;
    // The LOOP TOP: when the loop rests mid-phase its start/end meet
    // mid-lane — mark the spot so the paired grips read as intentional
    // ("loop end ][ loop start"), not noise.
    const coincident = Math.abs(startPos - endPos) < 1e-6 ||
        Math.abs(Math.abs(startPos - endPos) - cycleQ) < 1e-6;
    // MID-LANE pair only: at the frame edges the two grips already sit
    // apart (start at 0%, end at 100%) — no nudge, no chip.
    const paired = coincident && startPos > 1e-6 && startPos < cycleQ - 1e-6;
    if (paired) {
        // Named, and visible at rest: a bare ][ pair mid-lane reads as
        // a split the user never made — a loop whose top rests
        // mid-phase must SAY so.
        const top = el('div', 'loop-top-chip mono', {
            textContent: '↺ loop top',
            title: 'The loop\'s top: its END wraps to its START here — the ' +
                'window was performed mid-cycle. Grips: ] end · start [' });
        top.style.left = pct(startPos, cycleQ);
        o.appendChild(top);
    }
    ['start', 'end'].forEach(edge => {
        const basePos = edge === 'start' ? startPos : endPos;
        const grip = el('div', 'win-bracket latent ' + edge + ' trim-grip' +
            (paired ? ' paired' : ''));
        grip.style.left = paired
            ? 'calc(' + pct(basePos, cycleQ) +
              (edge === 'start' ? ' + ' + GRIP_PAIR_NUDGE_PX + 'px)'
                                : ' - ' + GRIP_PAIR_NUDGE_PX + 'px)')
            : pct(basePos, cycleQ);
        grip.title = (edge === 'start'
            ? 'Loop START — drag right to trim it in, left to reveal ' +
              'earlier material (whole-Q snap)'
            : 'Loop END — drag left to trim it in, right to reveal ' +
              'later material (whole-Q snap)') +
            ' · ⌥-drag SLIDES the loop by any amount (length held)';
        grip.addEventListener('pointerdown', ev => {
            selectOnly(lane.id); // grabbing a handle claims the track
            // EXPANDED DRAG (owner-ruled): the lane opens to the raw
            // take, the excluded material stays visible, and the trim
            // bracket rides an ABSOLUTE raw bound — dragging back over
            // dimmed content restores it (nothing is ever off-screen).
            const bound0 = edge === 'start'
                ? segs[0][0] : segs[segs.length - 1][1];
            runExpandedDrag(ev, o, lane, st, body, bound0, (rawQ, alt) => {
                if (alt && rawQ !== null) {
                    // ⌥ FREE SLIDE: the grabbed edge follows the pointer
                    // by ANY fractional amount and the other end moves
                    // by the same delta — the period is held, so Q
                    // coherence survives (the anchoring law keeps
                    // content in place; only which stretch is heard
                    // changes). Clamped to the take's extent; a slide
                    // never trims.
                    const { segs: next, deltaQ: delta } =
                        slideSegs(segs, rawQ - bound0, st.totalQ);
                    const edgeQ = edge === 'start'
                        ? next[0][0] : next[next.length - 1][1];
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
                const rawBound = rawQ === null
                    ? bound0                       // at-rest render
                    : Math.max(0, Math.min(st.totalQ, rawQ));
                // No snap until the pointer moves — the rest render is
                // the bound as it IS (a free-trimmed fractional bound
                // must not preview a rounded landing it never had).
                let bound = rawBound;
                if (rawQ !== null) {
                    // Snap the PERIOD, not the bound (trimBoundForPeriod
                    // header): what the pointer proposes is a period —
                    // round THAT to whole Qs and land the bound wherever
                    // that period lives.
                    const pFree = segsPeriod(
                        trimBoundTo(segs, edge, rawBound, st.totalQ),
                        st.totalQ);
                    if (pFree === null) return null;  // refusal zone
                    bound = trimBoundForPeriod(
                        segs, edge, Math.round(pFree), st.totalQ);
                }
                const next = trimBoundTo(segs, edge, bound, st.totalQ);
                if (next === null) return null;  // refusal: keep previous
                const p = segsPeriod(next, st.totalQ);
                const whole = Math.abs(p - Math.round(p)) < EPS_PERIOD;
                return { segs: next,
                    // The bracket rides the pointer; the dashed ghost
                    // marks the whole-Q-period landing.
                    follow: { kind: 'bracket', edge, q: rawBound },
                    active: {
                        q: bound,
                        text: 'loop ' + edge + ' · ' + fmtQ(p) + 'Q'
                            + (whole ? '' : ' ⚠'),
                        incoherent: !whole,
                        ghost: Math.abs(rawBound - bound) >
                            SNAP_GHOST_MIN_Q,
                    } };
            });
        });
        o.appendChild(grip);
    });
}
