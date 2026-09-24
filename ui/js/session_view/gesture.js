/**
 * THE GESTURE RUNNER.
 *
 * Every drag in the session view — window brackets, cut-band
 * chip/handles, seam handles, trim grips — shares one lifecycle:
 * pointer capture, listener bookkeeping, the lost-capture / window-blur
 * safety net, the overlay-freeze latch, the shared frame pin, and an
 * exactly-once end. This module owns that lifecycle ONCE; gesture sites
 * keep only their own geometry.
 *
 * The latches live HERE, as COUNTERS keyed by the body element (a set
 * would let the first of two overlapping holds unfreeze the body under
 * the second):
 *   - FROZEN: a live drag holds pointer capture on an overlay node;
 *     rebuilding the overlay would orphan the gesture. Set via
 *     g.freeze(body); cleared automatically when the gesture ends,
 *     HOWEVER it ends (release, cancel, lost capture, blur).
 *   - HELD: after a commit the overlay stays at the previewed geometry
 *     until the bridge answers — a poll in flight at release still
 *     carries the pre-commit state (the snap-back).
 *     holdOverlay(body) / releaseOverlay(body), used by commit sites.
 * Renderers ask ONE question: isOverlayFrozen(body).
 *
 * THE RELEASE OUTLIVES THE POINTER. A gesture's final commit is in
 * flight when the pointer lets go, so two of its effects end when that
 * commit SETTLES (afterSettled, capped at COMMIT_HOLD_MAX_MS), not at
 * pointerup:
 *   - the FRAME PIN: onEnd returns the final commit's promise and the
 *     pin (g.pin) holds until it settles — a poll between the release
 *     and the engine's answer must not seat an unpinned frame from the
 *     last LIVE geometry (docs/frame.md §1);
 *   - the PREVIEW: deferTeardown(key, hosts, fn) keeps a finished
 *     gesture's preview up until the first patch after its hosts are
 *     released, which runs fn (flushTeardowns) in the same frame as
 *     the rebuild from committed state — so the held overlay never
 *     shows the pre-drag chrome, and nothing shows in between.
 *
 * ONE LIVE GESTURE: two simultaneous pointers (touch + mouse, or a
 * second button mid-drag) must not run two lifecycles against the same
 * latches and commit twice. The runner is a singleton: while one
 * gesture is live, beginGesture returns an INERT controller
 * (live() === false, every method a no-op) and takes no capture.
 * Callers that do their own setup gate it on g.live().
 *
 * ESCAPE CANCELS: a capture-phase keydown while live ends the gesture
 * with commit=false — the same path as pointercancel, so onEnd sites
 * restore their pre-drag state.
 *
 * (Per-node render caches — _peaksRef, _dk, _key … — deliberately stay
 * on their nodes: a cache keyed by the thing it caches dies exactly
 * when the node does. The latches gate OTHER code and must not outlive
 * their gesture on any failure path, so they live here instead.)
 */

import { capturePointer, guardGesture } from './sv_util.js';
import { selectOnly } from './selection.js';
import { pinFrame, unpinFrame } from './drag_pin.js';

/* Post-commit cap: a hold — or a pin held past release — waiting on a
 * bridge that never answers lets go after this long. */
export const COMMIT_HOLD_MAX_MS = 1500;

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

/** Run `fn` exactly once: when `p` settles (resolved or rejected) or
 * after `capMs` (COMMIT_HOLD_MAX_MS), whichever comes first. The timer
 * pair is injectable for DOM-free tests (the nudge chain's). */
export function afterSettled(p, fn, { capMs = COMMIT_HOLD_MAX_MS,
                                      setTimer = setTimeout,
                                      clearTimer = clearTimeout } = {}) {
    let done = false;
    let cap = 0;
    const once = () => {
        if (done) return;
        done = true;
        clearTimer(cap);
        fn();
    };
    cap = setTimer(once, capMs);
    Promise.resolve(p).then(once, once);
}

/* Finished gestures' previews awaiting their hosts' next rebuild:
 * key (the preview's overlay) → { hosts, fn }. */
const teardowns = new Map();

/** Keep a finished gesture's preview up until the first patch after
 * every host is released (neither frozen nor held); `fn` then tears it
 * down in that patch, after the hosts rebuilt from committed state
 * (flushTeardowns). A newer gesture on the same key runs the pending
 * teardown first (runTeardown). */
export function deferTeardown(key, hosts, fn) {
    runTeardown(key);
    teardowns.set(key, { hosts, fn });
}

/** Tear `key`'s pending preview down NOW (a newer gesture takes it). */
export function runTeardown(key) {
    const t = teardowns.get(key);
    if (!t) return;
    teardowns.delete(key);
    t.fn();
}

/** patchSessionView, once every lane body and panel has reconciled:
 * tear down the previews whose hosts are released — the rebuild this
 * patch just made is what shows next, with no frame in between. */
export function flushTeardowns() {
    for (const [key, t] of [...teardowns]) {
        if (t.hosts.some(isOverlayFrozen)) continue;
        runTeardown(key);
    }
}

let activeGesture = null;  // the singleton

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
 *                cleanup (freeze/defers released). May return the
 *                promise of the commit it sent: the frame pin then
 *                holds until that settles (afterSettled); otherwise,
 *                and if onEnd throws, the pin releases right after it.
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
    // preventDefault()s without blurring would leave it focused but
    // unreachable.
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
    let pins = 0;  // g.pin() holds, released after onEnd (see end)
    const g = {
        live: () => live,
        freeze(body) {
            bump(frozen, body);
            cleanups.push(() => drop(frozen, body));
        },
        pin() {
            pinFrame();
            pins++;
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
        // THE PIN OUTLIVES THE POINTER: the frame stays pinned until
        // the final commit onEnd hands back settles — never on a path
        // that could leave it pinned (a throw, no commit: at once).
        let settles;
        try {
            settles = onEnd ? onEnd(commit, g) : undefined;
        } finally {
            const n = pins;
            pins = 0;
            const unpin = () => { for (let i = 0; i < n; i++) unpinFrame(); };
            if (n && settles && typeof settles.then === 'function') {
                afterSettled(settles, unpin);
            } else {
                unpin();
            }
        }
    }

    window.addEventListener('keydown', onKey, true);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', endTrue);
    node.addEventListener('pointercancel', endFalse);
    return g;
}
