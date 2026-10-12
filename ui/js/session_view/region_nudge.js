/**
 * THE NUDGE KEYS: ← / → slide the selected track's loop region by whole
 * Qs, length held (map_edit slideSegs). One undo step per press; a run
 * of presses is ONE pinned gesture for the frame (makeChainPin) and
 * chains off the last target sent, not the last poll.
 */

import { ctx } from './context.js';
import { isGestureLive, afterSettled, COMMIT_HOLD_MAX_MS } from './gesture.js';
import { activeSelectedId } from './selection.js';
import { pinFrame, unpinFrame } from './drag_pin.js';
import { slideSegs } from '../map_edit.js';
import { coveredSegs, commitBandSegs, newGesture } from './map_core.js';
import { entryOf, setView } from './region_nav.js';
import { keepInView, regionBounds } from './panel_view.js';

/* Presses within this window are one chain: they share ONE frame pin,
 * and each bases itself on the last target sent. */
export const NUDGE_CHAIN_MS = 800;
/* Two region bounds within this many Q are one bound (a published
 * bound is its sample count over Q — fp noise, never a whole sample). */
const SEGS_EPS_Q = 1e-6;

/**
 * THE NUDGE CHAIN IS ONE PINNED GESTURE: a nudge commits with no drag,
 * so without a pin every press would re-seat the frame under the next.
 * The first press of a chain pins the frame (drag_pin.js); every press
 * within `windowMs` extends the chain; the pin drops once the window
 * elapses after the LAST press and that press's commit has settled
 * (capped at `capMs`). Timers are injectable for tests. Returns
 * press(commitPromise).
 */
export function makeChainPin({ pin = pinFrame, unpin = unpinFrame,
                               windowMs = NUDGE_CHAIN_MS,
                               capMs = COMMIT_HOLD_MAX_MS,
                               setTimer = setTimeout,
                               clearTimer = clearTimeout } = {}) {
    let chain = null;  // { timer, seq }
    return function press(p) {
        if (!chain) { pin(); chain = { timer: 0, seq: 0 }; }
        const mine = chain;
        const seq = ++mine.seq;
        clearTimer(mine.timer);
        mine.timer = setTimer(() => afterSettled(p, () => {
            // A press that landed while this one settled owns the
            // chain now; only the LAST press releases it.
            if (chain !== mine || mine.seq !== seq) return;
            chain = null;
            unpin();
        }, { capMs, setTimer, clearTimer }), windowMs);
    };
}
const nudgePin = makeChainPin();

/** Do two covered sets name one region (to fp noise)? */
const sameSegs = (a, b) => a.length === b.length && a.every(([s, e], i) =>
    Math.abs(s - b[i][0]) < SEGS_EPS_Q && Math.abs(e - b[i][1]) < SEGS_EPS_Q);

/** Per paint, once the strip's band state is refreshed: has the engine
 * published the nudge chain's last target? Once it has, a different
 * published region is someone else's edit — an undo — and the chain's
 * base is void (nudgeRegion). Exported for the tests. */
export function noteNudgePublished(strip) {
    const chain = strip._nudge;
    const st = strip._bandState;
    if (chain && st && sameSegs(coveredSegs(st), chain.segs)) chain.published = true;
}

/** ← / →: slide the selected track's loop region by `deltaQ` (whole Qs;
 * fine moves are the ⌥ DRAG's), clamped to the take. Reads the strip's
 * per-patch band state, so it works exactly when the panel does; the
 * view pans to keep the region in sight. Returns false when nothing
 * applies (no panel, not editable) so the key falls through. */
export function nudgeRegion(deltaQ) {
    const id = activeSelectedId();
    if (id === null) return false;
    const row = ctx.laneEls.get(id);
    const { strip, nav } = (row && row._region) || {};
    const st = strip && strip._bandState;
    if (!st || !st.editable || !nav || nav.style.display === 'none') return false;
    // A live gesture — on the panel or a lane — owns the map and its
    // undo step: the key is consumed and waits.
    if (isGestureLive()) return true;
    // CHAINED PRESSES: key repeat is faster than the poll that refreshes
    // `_bandState`, so a press slides from the last target SENT within
    // the chain window — unless the engine has published that target and
    // now shows another region (an undo): then from what is shown.
    const shown = coveredSegs(st);
    const chain = strip._nudge;
    const chained = chain && performance.now() - chain.t < NUDGE_CHAIN_MS &&
        !(chain.published && !sameSegs(shown, chain.segs));
    const { segs, deltaQ: moved } =
        slideSegs(chained ? chain.segs : shown, deltaQ, st.totalQ);
    if (Math.abs(moved) < 1e-9) return true;  // at the take's edge: consumed, no-op
    strip._nudge = { segs, t: performance.now(), published: false };
    newGesture();
    nudgePin(commitBandSegs(st, segs, true));
    const e = entryOf(row);
    if (e) {
        const [a, b] = regionBounds(segs, e.totalQ);
        setView(row, keepInView(e.view, a, b, e.totalQ));
    }
    return true;
}
