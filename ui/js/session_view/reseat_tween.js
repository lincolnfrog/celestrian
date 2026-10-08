/**
 * THE RE-SEAT TWEEN (docs/frame.md §1; loop_selection.md §13.2; owner
 * 2026-10-01).
 *
 * When the frame's zero moves — the loop that places the frame was
 * swapped, shifted, cut, undone or removed — every lane, the ruler, the
 * gridlines, the cursor and the arm marker move onto the new seat
 * TOGETHER over RESEAT_MS, instead of jumping. It is not the edit hold
 * (revoked 2026-09-29) come back: nothing is held and nothing waits.
 * The move starts on the very render that would have jumped, takes the
 * shortest way round the frame (view_model reseatZero) and lands on the
 * seat exactly.
 *
 * It is one picture MOVING. Whatever re-lays the picture out jumps as
 * it always has (session_view.md law 11 — morph only pure moves):
 *   - the frame's LENGTH or Q changed in the same step;
 *   - a take is live or armed (the frame is the take's, and grows);
 *   - the Q13 trim view (its frame is the definer's buffer);
 *   - another island (a project opened), or no Q yet;
 *   - prefers-reduced-motion, or a hidden page (no frame is drawn).
 *
 * NEVER UNDER A HAND. A live gesture, or its frame pin held until the
 * final commit settles (gesture.js), is a hand on the frame: no move
 * starts, and one in motion completes at once — the pin captures its
 * TARGET (patch.js noteFrame), so a hand always edits a grid-true
 * frame.
 *
 * The zero is kept RELATIVE to the root frame (islandZero): a seek
 * moves the island zero and every origin together — the transport
 * moving, not the frame.
 *
 * Module state, DOM-free. app.js asks reseatOptions before each derive
 * — the answer is the deriveViewModel `reseat` opt — and tells
 * noteReseat what the derive drew. noteReseat answers TRUE when that
 * frame must not be shown: a move began on it (or its seat moved again,
 * or it gave way to a re-layout), and app.js derives once more. While a
 * move runs app.js re-derives every animation frame from the last
 * polled state — never an extra poll — and since progress is wall-clock
 * time, the 50 ms poll alone still lands it where animation frames are
 * throttled.
 */

import { posMod } from '../math_utils.js';

/* The move's length (owner 2026-10-01: "~200 ms"). */
export const RESEAT_MS = 200;

/* Zeros within this many samples of each other are one place. */
const AT_SEAT_SAMPLES = 0.5;

// { rel, quantum, cycleQ }: the zero the last render drew — relative to
// the root frame — and the frame it was drawn in.
let shown = null;
// { fromRel, toRel, t0 }: a move in motion — from the zero on screen
// when it began to the seat, both relative to the root frame.
let tween = null;
// The island (root id) the state above belongs to.
let island = null;

/** Are `a` and `b` different places in a frame `frame` samples long?
 * (A whole number of frames apart is the same picture.) */
function apart(a, b, frame) {
    const d = frame > 0 ? posMod(a - b + frame / 2, frame) - frame / 2 : a - b;
    return Math.abs(d) >= AT_SEAT_SAMPLES;
}

/**
 * Before a derive: the view model's `reseat` opt for this render — the
 * move in motion at its progress now, or null.
 *
 * @param {Object} o
 * @param {number}  o.now          performance.now()
 * @param {string}  [o.islandId]   the root's id: a new island (a project
 *                                 opened) starts with nothing shown
 * @param {boolean} [o.handDown]   a gesture is live, or its pin holds
 * @param {boolean} [o.reducedMotion] prefers-reduced-motion: jump
 * @param {boolean} [o.hidden]     the page is hidden: jump
 * @returns {?{fromRel: number, t: number}}
 */
export function reseatOptions({ now = 0, islandId = '', handDown = false,
                                reducedMotion = false, hidden = false } = {}) {
    if (islandId !== island) {
        island = islandId;
        shown = null;
        tween = null;
    }
    // Never under a hand, and never where no motion is wanted: a move
    // in motion completes at once (the next derive draws the seat).
    if (tween && (handDown || reducedMotion || hidden)) tween = null;
    return tween
        ? { fromRel: tween.fromRel,
            t: Math.min(1, Math.max(0, (now - tween.t0) / RESEAT_MS)) }
        : null;
}

/**
 * After a derive: remember the zero it drew; begin a move when the
 * frame, at rest, would have jumped; carry a move on from the zero on
 * screen when its seat moves again; give way to a re-layout; end a move
 * that has landed. Pass the same environment reseatOptions was given.
 *
 * @param {Object} vm  the view model just derived
 * @returns {boolean} true: derive again — this frame must not be shown
 */
export function noteReseat(vm, { now = 0, handDown = false,
                                 reducedMotion = false, hidden = false } = {}) {
    if (!vm || !vm.qEstablished || !Number.isFinite(vm.frameZero) ||
        !Number.isFinite(vm.rootFrame)) {
        shown = null;
        tween = null;
        return false;
    }
    const cur = { rel: vm.frameZero - vm.rootFrame,
                  quantum: vm.quantum, cycleQ: vm.cycleQ };
    const frame = Math.round(vm.cycleQ * vm.quantum);
    const sameFrame = !!shown && shown.quantum === vm.quantum &&
        shown.cycleQ === vm.cycleQ;
    if (tween) {
        if (vm.frameZeroSource !== 'tween') {
            // The view model drew another zero (a take came up, the
            // trim view opened): the move is over.
            tween = null;
            shown = cur;
            return false;
        }
        const seatRel = vm.seatedZero - vm.rootFrame;
        if (!sameFrame) {
            // RE-LAID OUT mid-move (the frame's length or Q changed):
            // jump, as a re-layout does.
            tween = null;
            return true;
        }
        if (apart(seatRel, tween.toRel, frame)) {
            // THE SEAT MOVED AGAIN: carry on from the zero on screen.
            tween = apart(seatRel, shown.rel, frame)
                ? { fromRel: shown.rel, toRel: seatRel, t0: now } : null;
            return true;
        }
        if (!vm.frameTweening) tween = null;  // landed, exactly
        shown = cur;
        return false;
    }
    // AT REST: the seat is somewhere else in the same frame — move
    // there instead of jumping.
    if (vm.frameZeroSource === 'seat' && sameFrame &&
        !handDown && !reducedMotion && !hidden &&
        !vm.mapEditsLocked && !vm.provisionalDefiner &&
        apart(cur.rel, shown.rel, frame)) {
        tween = { fromRel: shown.rel, toRel: cur.rel, t0: now };
        return true;
    }
    shown = cur;
    return false;
}

/** Is a move in motion (the app keeps re-deriving each frame)? */
export function reseatInMotion() {
    return tween !== null;
}

/** Tests: the module's state, and a clean slate. */
export function reseatState() {
    return { shown: shown && { ...shown }, tween: tween && { ...tween } };
}
export function resetReseat() {
    shown = null;
    tween = null;
    island = null;
}
