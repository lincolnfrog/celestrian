/**
 * THE SPLICE AND THE TOP — a heard lane's loop chrome (loop_selection.md
 * §9, P2.3–P2.6; built 2026-09-24, prototype v10).
 *
 * Two kinds of handle for the two things a loop edit can do:
 *   - a SPLICE handle on every heard repeat of every splice: the WRAP,
 *     where the recording jumps from the loop's end back to its start,
 *     and each inner CUT. Grabbed by the lane's LOWER half, its tab on
 *     the bottom edge ("splice", "‖ 1Q"). Drag = SWAP (map_edit
 *     slideSeam): the splice slides with the period held, and by the
 *     anchoring law only the strip it sweeps changes what it plays — so
 *     the drag is exact direct manipulation in heard time. The tiles
 *     follow the pointer as a LOCAL preview (pending_edits.js +
 *     requestRender), with no reveal and no rescale; the swept strip is
 *     tinted by the SIGNED drag distance (never "the short way round").
 *     Whole Q relative, ⌥ free. ⇧-drag = the LENGTH at that splice
 *     (map_edit lengthAtSeam) through the same-scale reveal (map_bands
 *     runRevealDrag), anchored so the grabbed bound sits under the
 *     pointer. A cut's splice heals on double-click or right-click.
 *   - the ↺ TOP on every heard repeat of the loop's one (lane.topHeardQ),
 *     grabbed by the UPPER half, its tab on the top edge ("↺ top"). Drag =
 *     SHIFT: the take's origin moves with the hand (setTiming), so the
 *     audio, the ↺ and the splices move together — a re-time, the ONE
 *     gesture that changes WHEN a take plays. Whole Q, ⌥ fine.
 * The ↺ and a splice are independent even where they coincide (a fresh
 * take's top IS its region start): each grabs by its own half.
 *
 * A PLAIN LOOP (a clip with no map: the whole take loops) wears the ↺
 * alone — nothing to swap, so no splice, but its timing is the ↺'s to
 * shift ("my drum loop is 40 ms late"). Its ↺ grabs by the TAB only:
 * the line sits on the lane's latent brackets (drag an edge in to make
 * a region) and must never steal their press — the panel's rule. The
 * tab is the take PASS's (inTakePass): the take tile sits where it was
 * performed, and a top moved into the take can sound past the frame's
 * end. A bypassed map wears none (its raw-framed brackets own the lane;
 * the panel's "Timing as played" still reaches its timing).
 *
 * GHOSTS (session_view.md §3): when a loop is shorter than the frame one
 * tile is the take and the rest are faded prints. Only the handles in
 * the take tile wear their tabs; a ghost repeat's handle is a faint line
 * whose tab shows on hover — and it stays grabbable (a tab on every
 * repeat buried a 3Q loop in a 12Q frame under twelve labels).
 *
 * OUTSIDE THE KEYED OVERLAY: the handles live in their own layer
 * (.lr-layer), positioned on EVERY patch. The overlay rebuilds on key
 * changes and freezes through a drag, and these must move with a drag's
 * preview (the other repeats of the grabbed splice, the ↺ riding a
 * shift) and glide. A live edit's chrome is CREATED mid-gesture (a
 * repeat that enters the frame); nothing is REMOVED until the gesture
 * ends — the grabbed handle holds the pointer capture (§7).
 *
 * THE GLIDE: an instant edit that RESETS the ↺ — a cut, heal, nudge,
 * undo or redo moving the top's raw sample, and so where it sounds —
 * glides it TOP_GLIDE_MS to its new place instead of jumping. Never
 * under a hand, and never against the frame's own settle
 * (vm.frameSettling: the glide gives way and the ↺ rides the frame).
 *
 * THE RECORDING GATE: under it every handle draws INERT (.lr-inert, the
 * gate's tooltip, no gesture) — where the loop is stays visible.
 *
 * THE RECONCILE (owner 2026-09-24, P2): every swap STORES the top it
 * leaves — the ↺ where it was while the new region still plays it, else
 * the new region start — so a reset stays put when the region slides
 * back, and a fresh loop's ↺ stays where it showed on its first slide.
 * The engine publishes the EFFECTIVE top (`loopTop`), which is exactly
 * what it reconciles from, so a swap preview predicts the landing from
 * it alone (predictTop): no guessing what the engine stores.
 */

import { el, pct, setStyle, setText, setTitle } from './sv_util.js';
import { isGestureLive, isOverlayFrozen } from './gesture.js';
import { selectOnly } from './selection.js';
import { bandState, coveredSegs, commitBandSegs, commitTiming, runRawDrag,
         lengthMoveFn, timingText, fmtSignedQ, WHOLE_Q_TOL,
         LOCKED_TITLE } from './map_core.js';
import { runRevealDrag } from './map_bands.js';
import { slideSeam, healCut } from '../map_edit.js';
import { posMod } from '../math_utils.js';
import { setPendingEdit, clearPendingEdit, pendingEditOf } from './pending_edits.js';
import { requestRender } from './render_request.js';

/* The ↺'s glide to a reset top (the prototype's, owner-approved). */
export const TOP_GLIDE_MS = 380;
/* A splice within this of its period's end is ON the left edge (the
 * next repeat's), not a sliver past the right one. */
const EDGE_EPS = 1e-7;
/* A handle within this of a tile's bounds belongs to that tile. */
const TILE_EPS = 1e-6;
/* The degenerate-frame guard: never more handles than this per lane
 * (a tiny period in a huge frame draws no tiles either — unrollReps). */
const MAX_SPOTS = 256;
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
/* The drag badge keeps this far inside the lane's edges (px). */
const BADGE_INSET_PX = 4;
/* A change of the ↺ smaller than this (Q) is not a move (fp noise). */
const TOP_MOVE_EPS_Q = 1e-6;

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

/* ---------- the pure geometry (exported for the tests) ---------- */

/** Does this lane wear the splice chrome? A committed heard lane —
 * clip or group — with a map to edit (or one the recording gate holds),
 * that is not a one-shot (its offset IS its placement: it keeps its
 * edge grips, map_bands) and not the Q-definer (its trim SETS Q). */
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

/** A PLAIN LOOP: a committed clip with no map of its own, its whole
 * take tiled where it sounds — the kept set is the take, [0, duration).
 * Not a bypassed map (lane.window: the raw-framed bracket overlay), a
 * live take, nor comp mode's raw inspector. */
export function isPlainLoop(lane) {
    return lane.kind === 'clip' && !lane.window && !(lane.windowChipQ > 0) &&
        !lane.windowEditing && !lane.recording;
}

/** Does the lane wear the ↺? Where the clip has one (wantsTopHandle)
 * and the lane shows HEARD time: a heard map, beside its splices, or a
 * plain loop, alone. */
export function wantsLaneTop(lane) {
    if (!wantsTopHandle(lane) || lane.kind !== 'clip') return false;
    return lane.windowChipQ > 0 ? !!lane.bandHeard : isPlainLoop(lane);
}

/**
 * Every heard splice across the frame: the WRAP (j = 0, at the region
 * start's heard position `anchorQ`) and one per inner cut (j ≥ 1, the
 * kept length before it later), each on every repeat of `periodQ`
 * inside [0, cycleQ).
 *
 * @param {Array<[number, number]>} segs  the covered set, raw Q
 * @param {number} anchorQ  where the wrap first sounds (lane.takeStartQ)
 * @returns {Array<{kind: 'wrap'|'cut', j: number, k: number, x: number,
 *                  cut: ?[number, number]}>}
 */
export function spliceSpots(segs, anchorQ, periodQ, cycleQ) {
    const out = [];
    if (!(periodQ > 0) || !(cycleQ > 0) || !segs || !segs.length) return out;
    let h = 0;
    segs.forEach(([s, e], j) => {
        let x = posMod(anchorQ + h, periodQ);
        if (x > periodQ - EDGE_EPS) x -= periodQ;  // ON the left edge
        for (let k = 0; x < cycleQ - EDGE_EPS && out.length < MAX_SPOTS; k++) {
            out.push({ kind: j === 0 ? 'wrap' : 'cut', j, k, x,
                       cut: j ? [segs[j - 1][1], s] : null });
            x += periodQ;
        }
        h += e - s;
    });
    return out;
}

/** The ↺ on every repeat: first at `topHeardQ` (lane.topHeardQ, in
 * [0, periodQ)), then every period inside [0, cycleQ). */
export function topSpots(topHeardQ, periodQ, cycleQ) {
    const out = [];
    if (!(periodQ > 0) || !(cycleQ > 0) || !Number.isFinite(topHeardQ)) return out;
    let x = posMod(topHeardQ, periodQ);
    if (x > periodQ - EDGE_EPS) x -= periodQ;
    for (let k = 0; x < cycleQ - EDGE_EPS && out.length < MAX_SPOTS; k++) {
        out.push({ kind: 'top', j: 0, k, x });
        x += periodQ;
    }
    return out;
}

/** Is lane position `x` inside the take tile (a non-ghost rep)? With no
 * tiles to judge by, every handle is the take's. */
export function inTakeTile(reps, x) {
    const tiles = (reps || []).filter(r => !r.ghost && !r.bar);
    if (!tiles.length) return true;
    return tiles.some(r => x >= r.startQ - TILE_EPS && x < r.endQ - TILE_EPS);
}

/** Is lane position `x` in the take's own PASS — its tile, or the part
 * of it the frame's end clips, which sounds at the frame's start? (A
 * PLAIN loop's ↺.) A heard lane's take tile starts the frame grid, so
 * its first ↺ is always inside; a plain loop's sits where the take was
 * performed, and a top moved into the take (the panel's start marker)
 * can sound past the frame's end — its one ↺ would be a tabless ghost.
 * Exactly one ↺ lies in the pass. */
export function inTakePass(reps, x, periodQ, cycleQ) {
    if (inTakeTile(reps, x)) return true;
    const take = (reps || []).find(r => !r.ghost && !r.bar);
    const over = take ? take.startQ + periodQ - cycleQ : 0;
    return over > TILE_EPS && x < over - TILE_EPS;
}

/**
 * The top the engine will store — and publish — once a swap to `segsQ`
 * lands (the reconcile, time_map.js reconcileTop): `top`, the EFFECTIVE
 * top the swap starts from (the published `loopTop`), while the new kept
 * set still plays it, else the new region start. The swap preview shows
 * it, so the ↺ never jumps when the commit answers.
 *
 * @param {Array<[number, number]>} segsQ  the new covered set, raw Q
 * @param {number} top  the effective top before the swap, samples
 * @param {number} quantum  samples per Q
 * @returns {number|undefined}
 */
export function predictTop(segsQ, top, quantum) {
    if (!segsQ || !segsQ.length) return undefined;
    const segs = segsQ.map(([a, b]) => [Math.round(a * quantum), Math.round(b * quantum)]);
    if (Number.isFinite(top) && segs.some(([a, b]) => top >= a && top < b)) return top;
    return segs[0][0];
}

/** The ↺'s glide offset (Q) at `now`: from where it was toward where it
 * is, eased; 0 once landed. */
export function glideOffset(glide, now) {
    if (!glide) return 0;
    const p = Math.min(1, Math.max(0, (now - glide.t0) / TOP_GLIDE_MS));
    return (glide.from - glide.to) * (1 - easeInOut(p));
}

const easeInOut = p => p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

/** A cut splice's tab: its length, whole Qs bare, a fraction flagged. */
function cutTabText(cut) {
    const len = cut[1] - cut[0];
    const whole = Math.abs(len - Math.round(len)) < WHOLE_Q_TOL;
    return '‖ ' + (whole ? Math.round(len) : len.toFixed(2)) + 'Q' + (whole ? '' : ' ⚠');
}

function reducedMotion() {
    try {
        return !!(typeof window !== 'undefined' && window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
        return false;
    }
}

/* ---------- the layer ---------- */

/** The body's handle layer (made once, after the overlay). */
function layerOf(body) {
    if (!body._lrLayer || body._lrLayer.parentNode !== body) {
        body._lrLayer = el('div', 'body-layer lr-layer');
        body.appendChild(body._lrLayer);
        body._lrPools = new Map();   // 'wrap' | 'cut<j>' | 'top' → elements
        body._lrTops = [];           // the placed ↺s: { el, x } (the glide)
    }
    return body._lrLayer;
}

/** Every handle out (no gesture holds one). */
function dropAll(body) {
    if (body._lrLayer) body._lrLayer.textContent = '';
    body._lrPools = new Map();
    body._lrTops = [];
}

/** Every handle hidden but the grabbed one (a gesture still runs). */
function hideAll(body) {
    const d = body._lrDrag;
    for (const els of (body._lrPools || new Map()).values()) {
        for (const h of els) if (!d || h !== d.el) setStyle(h, 'display', 'none');
    }
    body._lrTops = [];
}

/**
 * Per patch (lane_body, BEFORE its frozen gates — these move with a
 * drag's preview): place the lane's splice handles and ↺ — a plain
 * loop's ↺ alone — or clear them off a lane that no longer wears them
 * (never mid-gesture: the grabbed handle holds the capture — hidden
 * until the gesture ends instead).
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
        body._lrTopPrev = null;
        body._lrGlide = null;
        if (body._lrLayer) {
            if (keep) hideAll(body);
            else dropAll(body);
            layoutDrag(body);
        }
        return;
    }
    layerOf(body);
    const c = {
        lane, vm, overlay, cycleQ,
        // A plain loop's band state: its kept set is the whole take, so
        // its period (the ↺'s repeat) is the take's.
        st: bandState(lane, vm, cycleQ),
        W: body.clientWidth,
        splices, withTop,
        // A plain loop's ↺ grabs by its tab only (its line sits on the
        // latent brackets), and wears it in the take's PASS (inTakePass).
        plain: isPlainLoop(lane),
    };
    body._lrCtx = c;
    noteTop(body, c, keep);
    layoutHandles(body, keep);
    layoutDrag(body);
}

/** Watch the ↺ for a RESET — its raw sample changed AND so did where it
 * sounds, with no hand on it and no preview resolving — and glide it
 * (the prototype's glideTop: the ↺ glides, the splice lands). A heal or
 * a re-time moves the ↺ with its audio, its sample unchanged: no glide. */
function noteTop(body, c, keep) {
    const prev = body._lrTopPrev;
    const cur = c.withTop ? { topQ: c.lane.topQ, heardQ: c.lane.topHeardQ } : null;
    body._lrTopPrev = cur;
    if (!cur || keep || c.vm.frameSettling || reducedMotion()) {
        body._lrGlide = null;
        return;
    }
    if (!prev || pendingEditOf(c.lane.id)) return;
    if (Math.abs(cur.topQ - prev.topQ) > TOP_MOVE_EPS_Q &&
        Math.abs(cur.heardQ - prev.heardQ) > TOP_MOVE_EPS_Q) {
        body._lrGlide = { from: prev.heardQ, to: cur.heardQ, t0: performance.now() };
        glideLoop(body);
    }
}

/**
 * Pair a pool's elements with its spots. The GRABBED handle keeps its
 * element (it holds the pointer capture) and takes the spot nearest the
 * hand — so it stands for that repeat and no repeat shows twice; the
 * rest pair in order. Returns the pairs (a null element = make one) and
 * the elements left over.
 */
export function pairHandles(els, spots, dragEl = null, dragX = 0) {
    const pairs = [];
    let free = els;
    const rest = spots.slice();
    if (dragEl && els.includes(dragEl)) {
        free = els.filter(h => h !== dragEl);
        let bi = -1;
        rest.forEach((sp, i) => {
            if (bi < 0 || Math.abs(sp.x - dragX) < Math.abs(rest[bi].x - dragX)) bi = i;
        });
        pairs.push([dragEl, bi >= 0 ? rest.splice(bi, 1)[0] : null]);
    }
    rest.forEach((sp, i) => pairs.push([free[i] || null, sp]));
    return { pairs, surplus: free.slice(rest.length) };
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
    const off = glideOffset(body._lrGlide, performance.now());
    const tops = [];
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
            if (grabbed && (drag.kind !== 'length' || !sp)) x = drag.followX;
            else if (sp) x = sp.x + (kind === 'top' ? off : 0);
            else continue;
            placeHandle(h, x, c, {
                kind, sp, grabbed, chipLeft,
                inert: kind === 'top' ? !lane.canRetime : !st.editable,
            });
            if (kind === 'top' && !grabbed) tops.push({ el: h, x: sp.x });
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
    body._lrTops = tops;
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
 * (inTakeTile; a plain loop's ↺: the take's pass, inTakePass)? */
function isTakeSpot(c, x) {
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
    h.classList.toggle('lr-ghost', !grabbed && !isTakeSpot(c, x));
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

/** Re-place the gliding ↺s (the glide's animation frames). */
function placeTops(body) {
    const c = body._lrCtx;
    if (!c) return;
    const off = glideOffset(body._lrGlide, performance.now());
    for (const { el: h, x } of body._lrTops || []) {
        setStyle(h, 'left', pct(x + off, c.cycleQ));
        h.classList.toggle('lr-ghost', !isTakeSpot(c, x + off));
    }
}

const gliding = new Set();
let glideRaf = 0;

/** Run the glide's animation frames until every glide has landed. */
function glideLoop(body) {
    gliding.add(body);
    if (glideRaf || typeof requestAnimationFrame !== 'function') return;
    const tick = () => {
        glideRaf = 0;
        const now = performance.now();
        for (const b of [...gliding]) {
            if (!b.isConnected || !b._lrGlide) { gliding.delete(b); continue; }
            const done = now - b._lrGlide.t0 >= TOP_GLIDE_MS;
            if (done) b._lrGlide = null;
            placeTops(b);
            if (done) gliding.delete(b);
        }
        if (gliding.size) glideRaf = requestAnimationFrame(tick);
    };
    glideRaf = requestAnimationFrame(tick);
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
    const on = !!(d && d.engaged && d.kind !== 'length' && c);
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
    // Centred on the hand, kept inside the lane (it clips its overflow;
    // a re-time's badge is long). One layout read per move of a drag.
    const bx = W * d.followX / cycleQ;
    const bw = badge.offsetWidth;
    setStyle(badge, 'left',
        Math.max(BADGE_INSET_PX, Math.min(W - bw - BADGE_INSET_PX, bx - bw / 2)) + 'px');
    if (snap) setStyle(snap, 'left', pct(d.landX, cycleQ));
    if (tints) {
        // The swept strip on every repeat, by the SIGNED distance: the
        // material the swap changes, in the direction dragged.
        tints.textContent = '';
        const { base, S } = d.tint;
        const dq = Math.max(-S, Math.min(S, d.tint.d));
        if (Math.abs(dq) > 1e-6 && S > 0 && cycleQ / S <= MAX_SPOTS) {
            for (let x = base - S; x < cycleQ + S; x += S) {
                const a = Math.max(0, Math.min(x, x + dq));
                const b = Math.min(cycleQ, Math.max(x, x + dq));
                if (b - a <= 1e-9) continue;
                const t = el('div', 'lr-tint');
                t.style.left = pct(a, cycleQ);
                t.style.width = pct(b - a, cycleQ);
                tints.appendChild(t);
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

/** Samples of a covered set, flat (the engine's publication). */
const flatOf = (segsQ, quantum) => {
    const out = [];
    segsQ.forEach(([a, b]) => out.push(Math.round(a * quantum), Math.round(b * quantum)));
    return out;
};

/**
 * A gesture's handle on the lane's pending preview (the lane's drags
 * and the panel's start marker). A preview still in flight from an
 * EARLIER gesture (its commit not yet polled back) is built on, never
 * cleared (pending_edits pendingEditOf): the new preview carries it, a
 * shift adding to its shift. Nothing in flight: the first show starts a
 * fresh preview (a fresh shift base), as a clear at the start would.
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

/** The lane's top as the engine will publish it after a swap (clips;
 * a group's top is its region start, never stored in Phase 2): the
 * reconcile from the effective top the gesture starts with — the one
 * every live commit of it reconciles from too (AudioEngine::record). */
function topAfterSwap(lane, st) {
    if (lane.kind !== 'clip') return () => undefined;
    const q = st.quantum;
    const T0 = Math.round((lane.topQ || 0) * q);
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
 * THE SPLICE DRAG = a SWAP, in heard time. The splice slides (slideSeam:
 * whole Q from the grab, ⌥ free) with the period held; the tiles follow
 * as a local preview; live commits stream (one undo step); the ↺ stays
 * put — or, when the region drops its spot, resets to the region start,
 * as the engine will (topAfterSwap).
 */
function startSpliceDrag(ev, h, body) {
    const c = body._lrCtx;
    const sp = h._spot;
    const { lane, st, cycleQ } = c;
    selectOnly(lane.id);  // grabbing a handle claims the track
    const segs0 = coveredSegs(st).map(s => s.slice());
    const S = st.periodQ;
    const pxPerQ = body.getBoundingClientRect().width / cycleQ;
    // Where the moving splice sounds BEFORE the drag: the tint's base.
    let hQ = 0;
    for (let i = 0; i < sp.j; i++) hQ += segs0[i][1] - segs0[i][0];
    const tintBase = posMod(st.anchorQ + hQ, S);
    const topOf = topAfterSwap(lane, st);
    const pv = previewer(lane.id);
    const show = segsQ => pv.show({ segments: flatOf(segsQ, st.quantum), top: topOf(segsQ) });
    const d = beginDrag(body, h, 'splice', sp.x);
    const run = runRawDrag(ev, c.overlay, st, {
        rawQAt: x => sp.x + (x - ev.clientX) / pxPerQ,
        clamp: false,
        onMove: (pq, alt) => {
            if (pq === null) return { segs: segs0, deltaQ: 0, pq: sp.x, alt };
            const free = pq - sp.x;
            const r = slideSeam(segs0, sp.j, alt ? free : Math.round(free), st.totalQ);
            return { segs: r.segs, deltaQ: r.deltaQ, pq, alt };
        },
        preview: res => {
            d.followX = res.pq;
            d.landX = sp.x + res.deltaQ;
            d.ghost = Math.abs(res.pq - d.landX) * pxPerQ > SNAP_GHOST_MIN_PX;
            d.text = (sp.kind === 'cut' ? 'swap · move cut ' : 'swap · splice ') +
                fmtSignedQ(res.deltaQ) + 'Q' + (res.alt ? ' · free' : '');
            d.tint = { base: tintBase, d: res.deltaQ, S };
            show(res.segs);
            layoutDrag(body);
        },
        restore: last => {
            const p = last ? commitBandSegs(st, segs0, true) : undefined;
            if (p) show(segs0);
            else pv.restore(null);
            return p;
        },
        held: () => { endDrag(body, d); requestRender(); },
        // Every end path runs onTeardown — a press that never engaged
        // too (each click of a double-click): the drag state goes.
        onTeardown: () => endDrag(body, d),
        freeze: [body],
        engage: true,
        onEngage: () => { d.engaged = true; h.classList.add('lr-active'); },
    });
    if (!run.live) endDrag(body, d);
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
    const { lane, st } = c;
    selectOnly(lane.id);
    const segs0 = coveredSegs(st).map(s => s.slice());
    const j = sp.kind === 'cut' ? sp.j : 0;
    const gi = j > 0 ? j - 1 : segs0.length - 1;
    runRevealDrag(ev, c.overlay, lane, st, body, segs0[gi][1],
        lengthMoveFn(st, segs0, j));
}

/**
 * THE ↺ DRAG = a SHIFT: the take's origin moves with the hand (whole Q
 * from the grab; ⌥ fine), so the audio, the ↺ and the splices move
 * together — the preview moves the origin locally; live setTiming
 * commits send only what the last one had not (relative shifts).
 */
function startTopDrag(ev, h, body) {
    const c = body._lrCtx;
    const sp = h._spot;
    const { lane, vm, st, cycleQ } = c;
    selectOnly(lane.id);
    const q = st.quantum;
    const pxPerQ = body.getBoundingClientRect().width / cycleQ;
    const msPerQ = vm.sampleRate > 0 ? q / vm.sampleRate * 1000 : 0;
    const retime0 = lane.retimeQ || 0;
    const pv = previewer(lane.id);
    const d = beginDrag(body, h, 'top', sp.x);
    let sent = 0;        // samples this gesture has committed
    let lastP;           // its last commit
    const run = runRawDrag(ev, c.overlay, st, {
        rawQAt: x => (x - ev.clientX) / pxPerQ,
        clamp: false,
        onMove: (dx, alt) => {
            if (dx === null) return { dx: 0, dq: 0, shift: 0, alt };
            const dq = alt ? dx : Math.round(dx);
            return { dx, dq, shift: Math.round(dq * q), alt };
        },
        preview: res => {
            d.followX = sp.x + res.dx;
            d.landX = sp.x + res.dq;
            d.ghost = Math.abs(res.dx - res.dq) * pxPerQ > SNAP_GHOST_MIN_PX;
            d.text = 'shift ' + fmtSignedQ(res.dq) + 'Q' +
                (res.alt ? ' · fine' : '') + ' · ' +
                timingText(retime0 + res.shift / q, msPerQ);
            pv.show({ originShift: res.shift });
            layoutDrag(body);
        },
        commit: res => {
            const delta = res.shift - sent;
            if (delta === 0) return lastP;
            sent = res.shift;
            return (lastP = commitTiming(st, delta, null, true));
        },
        restore: () => {
            if (!lastP) {
                pv.restore(null);
                return undefined;
            }
            const p = sent ? commitTiming(st, -sent, null, true) : lastP;
            sent = 0;
            pv.restore({ originShift: 0 });
            return p;
        },
        held: () => { endDrag(body, d); requestRender(); },
        onTeardown: () => endDrag(body, d),
        freeze: [body],
        engage: true,
        onEngage: () => { d.engaged = true; h.classList.add('lr-active'); },
    });
    if (!run.live) endDrag(body, d);
}
