/**
 * THE GESTURE RUNNER (audit 2026-08-30 §4.4/§4.5; hardened 2026-08-31).
 *
 * Every drag in the session view — window brackets, cut-band
 * chip/handles, seam handles, trim grips — used to hand-roll the same
 * lifecycle: pointer capture, listener bookkeeping, the lost-capture /
 * window-blur safety net, the overlay-freeze latch, the shared frame
 * pin, and an exactly-once end. The Windows fixes (guardGesture,
 * idempotent ends) had to be patched into three copies. This module
 * owns the lifecycle ONCE; gesture sites keep only their own geometry.
 *
 * The latches also live HERE, as COUNTERS keyed by the body element
 * (audit 2026-08-31 U1 — a WeakSet let the first of two overlapping
 * holds unfreeze the body under the second):
 *   - FROZEN  (was body._winDrag): a live drag holds pointer capture on
 *     an overlay node; rebuilding the overlay would orphan the gesture.
 *     Set via g.freeze(body); cleared automatically when the gesture
 *     ends, HOWEVER it ends (release, cancel, lost capture, blur).
 *   - HELD    (was body._winHold): after a commit the overlay stays at
 *     the previewed geometry until the bridge answers — a poll in
 *     flight at release still carries the OLD state (the snap-back).
 *     holdOverlay(body) / releaseOverlay(body), used by commit sites.
 * Renderers ask ONE question: isOverlayFrozen(body).
 *
 * ONE LIVE GESTURE (audit 2026-08-31 U7): two simultaneous pointers
 * (touch + mouse, or a second button mid-drag) used to run two gesture
 * lifecycles against the same latches and commit twice. The runner is
 * now a singleton: while one gesture is live, beginGesture returns an
 * INERT controller (live() === false, every method a no-op) and takes
 * no capture. Callers that do their own setup gate it on g.live().
 *
 * ESCAPE CANCELS (audit 2026-08-31 U6): a capture-phase keydown while
 * live ends the gesture with commit=false — the same path as
 * pointercancel, so onEnd sites restore their pre-drag state.
 *
 * (Per-node render caches — _peaksRef, _dk, _key … — deliberately stay
 * on their nodes: a cache keyed by the thing it caches dies exactly
 * when the node does, which is the lifetime a cache wants. The latches
 * were different: they gated OTHER code and outlived their gesture on
 * every failure path.)
 */

import { capturePointer, guardGesture } from './sv_util.js';
import { selectOnly } from './selection.js';
import { pinFrame, unpinFrame } from './drag_pin.js';

const frozen = new WeakMap();  // body → live-drag freeze count
const held = new WeakMap();    // body → post-commit hold count

const bump = (map, body) => map.set(body, (map.get(body) || 0) + 1);
const drop = (map, body) => {
    const n = (map.get(body) || 0) - 1;
    if (n <= 0) map.delete(body); else map.set(body, n);
};

/** Renderers: is this lane body's overlay off-limits right now? */
export const isOverlayFrozen = body => frozen.has(body) || held.has(body);
/** A live drag specifically (the dblclick heal path cares). */
export const isDragging = body => frozen.has(body);
/** Post-commit hold (see window_edit.js's settle). Counted — every
 * holdOverlay needs its releaseOverlay (settle paths already pair). */
export const holdOverlay = body => bump(held, body);
export const releaseOverlay = body => drop(held, body);

let activeGesture = null;  // the singleton (U7)

/** Is any gesture live right now? (init.js gates its Escape on this —
 * a live gesture's Escape means "cancel the drag", nothing else.) */
export const isGestureLive = () => activeGesture != null;

/** An inert controller: what beginGesture hands a second pointer. */
const INERT = Object.freeze({
    live: () => false,
    freeze() {}, pin() {}, defer() {}, end() {},
});

/**
 * Run one pointer gesture from its pointerdown.
 *
 *   beginGesture(ev, {
 *     node,      capture/listener target (default ev.target)
 *     claim,     lane id to select (grabbing a handle claims the track)
 *     stop,      also stopPropagation() (default false)
 *     onMove,    (moveEvent, g) — pointermove while live
 *     onEnd,     (committed, g) — EXACTLY once, however the gesture
 *                ends: pointerup → true; pointercancel, lost capture,
 *                window blur, Escape → false. Runs after the automatic
 *                cleanup (freeze/pin/defers released).
 *   }) → g   (INERT — g.live() false — if another gesture is live)
 */
export function beginGesture(ev, { node = ev.target, claim = null,
                                   stop = false, onMove = null,
                                   onEnd = null } = {}) {
    if (activeGesture != null) {
        // A second pointer while one gesture runs: swallow the event so
        // it cannot start a rival lifecycle, but change nothing.
        ev.preventDefault();
        if (stop) ev.stopPropagation();
        return INERT;
    }
    // A focused text field (rename box) keeps keystrokes; a drag that
    // preventDefault()s without blurring left it focused but unreachable
    // (audit 2026-08-31 U8).
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
               ae.isContentEditable)) {
        ae.blur();
    }
    ev.preventDefault();
    if (stop) ev.stopPropagation();
    if (claim != null) selectOnly(claim);
    capturePointer(node, ev);

    let live = true;
    const cleanups = [];
    const g = {
        live: () => live,
        freeze(body) {
            bump(frozen, body);
            cleanups.push(() => drop(frozen, body));
        },
        pin() {
            pinFrame();
            cleanups.push(unpinFrame);
        },
        defer(fn) { cleanups.push(fn); },
        end(commit) { end(commit, null); },
    };
    activeGesture = g;

    const move = mv => { if (onMove) onMove(mv, g); };
    const endTrue = e => end(true, e);
    const endFalse = e => end(false, e);
    const onKey = e => {
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();  // capture phase: init.js never sees it
            end(false, null);
        }
    };
    const releaseGuard = guardGesture(node, () => end(false, null));

    function end(commit, e) {
        if (!live) return;  // pointerup + lostpointercapture both arrive
        live = false;
        activeGesture = null;
        releaseGuard();
        window.removeEventListener('keydown', onKey, true);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', endTrue);
        node.removeEventListener('pointercancel', endFalse);
        try {
            if (e && node.hasPointerCapture && node.hasPointerCapture(e.pointerId)) {
                node.releasePointerCapture(e.pointerId);
            }
        } catch (_) { /* synthetic pointers */ }
        for (const fn of cleanups.splice(0).reverse()) fn();
        if (onEnd) onEnd(commit, g);
    }

    window.addEventListener('keydown', onKey, true);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', endTrue);
    node.addEventListener('pointercancel', endFalse);
    return g;
}
