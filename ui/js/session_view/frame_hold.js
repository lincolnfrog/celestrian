/**
 * THE EDIT HOLD AND THE SETTLE (docs/frame.md §1; loop_selection.md
 * P2.1, §9.4; session_view.md law 17).
 *
 * While a lane is selected (activeSelectedId) the frame's zero is
 * HELD where it was on screen when the hold began: no edit re-seats
 * it — a drag, a nudge, a cut, an undo each lands in a still picture
 * where only the edited loop's own material moves. The hold is kept
 * RELATIVE to the root frame (islandZero), so a seek, which moves the
 * island zero and every origin together, carries it along.
 *
 * The hold RELEASES when the selection moves to another lane or
 * clears (Escape, a canvas or top-bar click, the selected lane
 * deleted — the default selection then takes the first lane), or a
 * take goes live or armed (the frame of a take is the seat's,
 * frame.md §1; the hold stays suspended until the take is done). The
 * frame then SETTLES, once: its zero glides from where it was to the
 * seat over SETTLE_MS, easeInOut, the shortest way round the frame,
 * landing exactly on it (view_model settleZero) — rAF re-derives from
 * the last polled state (app.js), never extra polls. With
 * prefers-reduced-motion it jumps. A hold that begins while a glide
 * runs holds the glide's TARGET, so a selection made mid-glide rests
 * where the glide lands.
 *
 * THE FRAME NEVER MOVES UNDER A HAND. A live gesture, or its frame pin
 * held until the final commit settles (gesture.js), is a hand on it:
 *   - a selection the hand makes (grabbing another lane's handle
 *     claims that lane) RE-KEYS the hold instead of releasing it — the
 *     grab keeps the picture it grabbed, and the settle waits for the
 *     next release;
 *   - a release under the hand (a take armed mid-drag) arms the glide,
 *     which starts from the held zero when the hand lifts;
 *   - a glide in motion when a hand comes down completes at once: the
 *     pin captures its target (drag_pin.js), so the hand edits a
 *     grid-true frame, never a mid-glide one.
 *
 * Module state, DOM-free: app.js calls frameHoldOptions before each
 * derive — its answer is the deriveViewModel `hold` / `settle` opts —
 * and noteFrameShown after it. The precedence between them, the drag
 * pin and the seat is the view model's (resolveFrameZero).
 */

/* The settle's length (the prototype's, owner-approved 2026-09-24). */
export const SETTLE_MS = 560;

/* A shown zero within this many samples of the seat needs no glide. */
const AT_SEAT_SAMPLES = 0.5;

// { key, rel, quantum, follow }: the lane the hold belongs to and its
// zero relative to the root frame — rel null until the derive after it
// began captures it; `follow` while it tracks a running glide's target.
let held = null;
// { fromRel, t0 }: a glide from the zero shown — t0 null while a hand
// keeps it armed.
let settle = null;
// { rel, seatRel }: the zero the last derive drew, and its seat.
let shown = null;
// The island (root id) the state above belongs to.
let island = null;

/**
 * Before a derive: advance the hold and the settle to this render and
 * return the view model's opts for them.
 *
 * @param {Object} o
 * @param {?string} o.key          activeSelectedId() — null: none
 * @param {boolean} o.takeActive   any take recording or armed
 * @param {boolean} o.handDown     a gesture is live, or its pin holds
 * @param {number}  o.now          performance.now()
 * @param {boolean} [o.reducedMotion] prefers-reduced-motion: jump
 * @param {string}  [o.islandId]   the root's id: a new island (a project
 *                                 opened) starts with nothing held
 * @returns {{hold: ?{zeroRel: number, quantum: number},
 *            settle: ?{fromRel: number, t: number}}}
 */
export function frameHoldOptions({ key = null, takeActive = false,
                                   handDown = false, now = 0,
                                   reducedMotion = false,
                                   islandId = '' } = {}) {
    if (islandId !== island) {
        island = islandId;
        held = null;
        settle = null;
        shown = null;
    }
    // THE RELEASE: the selection moved or cleared, or a take is up.
    if (held) {
        if (takeActive || key == null) {
            release(handDown, now, reducedMotion);
        } else if (key !== held.key) {
            if (handDown) held.key = key;   // the grab keeps its picture
            else release(handDown, now, reducedMotion);
        }
    }
    // Never under a hand: a glide in motion completes, an armed one
    // waits for the hand to lift.
    if (settle) {
        if (handDown) {
            if (settle.t0 !== null) settle = null;
        } else if (settle.t0 === null) {
            settle.t0 = now;
        }
    }
    // A HOLD BEGINS (captured after the derive: noteFrameShown).
    if (!held && key != null && !takeActive) {
        held = { key, rel: null, quantum: 0, follow: false };
    }
    return {
        hold: held && held.rel !== null
            ? { zeroRel: held.rel, quantum: held.quantum } : null,
        settle: settle
            ? { fromRel: settle.fromRel,
                t: settle.t0 === null ? 0
                    : Math.min(1, Math.max(0, (now - settle.t0) / SETTLE_MS)) }
            : null,
    };
}

/** Let the hold go and glide from the zero shown to the seat — unless
 * a glide already runs there, motion is reduced (the next derive
 * simply draws the seat), or the frame already sits on it. */
function release(handDown, now, reducedMotion) {
    held = null;
    if (settle || !shown || reducedMotion) return;
    if (!Number.isFinite(shown.seatRel) ||
        Math.abs(shown.rel - shown.seatRel) < AT_SEAT_SAMPLES) return;
    settle = { fromRel: shown.rel, t0: handDown ? null : now };
}

/**
 * After a derive: remember the zero it drew (a release glides from
 * it); capture a hold that began — the zero on screen, or the running
 * glide's TARGET; keep a hold begun mid-glide on the target until the
 * glide lands; re-capture across a Q change (the view model voids a
 * hold whose grid is gone); end a glide that has landed.
 *
 * @param {Object} vm         the view model just derived
 * @param {number} rootFrame  that state's root frame (islandZero)
 * @param {number} now        the performance.now() the derive used
 */
export function noteFrameShown(vm, rootFrame, now) {
    const q = !!(vm && vm.qEstablished);
    shown = q && Number.isFinite(vm.frameZero)
        ? { rel: vm.frameZero - rootFrame,
            seatRel: Number.isFinite(vm.seatedZero) ? vm.seatedZero - rootFrame : null }
        : null;
    if (held) {
        if (!q) {
            held.rel = null;
            held.follow = false;
        } else if (held.rel === null || held.quantum !== vm.quantum ||
                   (held.follow && settle)) {
            const z = settle ? vm.seatedZero : vm.frameZero;
            if (Number.isFinite(z)) {
                held.rel = z - rootFrame;
                held.quantum = vm.quantum;
                held.follow = !!settle;
            }
        }
    }
    if (settle && (!q || (settle.t0 !== null && now - settle.t0 >= SETTLE_MS))) {
        settle = null;
    }
    if (held && !settle) held.follow = false;
}

/** Is a glide in motion (the app keeps re-deriving each frame)? */
export function settleInMotion() {
    return !!(settle && settle.t0 !== null);
}

/** Tests: the module's state, and a clean slate. */
export function frameHoldState() {
    return { held: held && { ...held }, settle: settle && { ...settle },
             shown: shown && { ...shown } };
}
export function resetFrameHold() {
    held = null;
    settle = null;
    shown = null;
    island = null;
}
