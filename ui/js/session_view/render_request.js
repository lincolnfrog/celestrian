/**
 * requestRender(): re-derive the view from the LAST polled state — with
 * the current drag pin, re-seat tween and pending edits — and patch at
 * once, without a poll. A gesture calls it on every move so its preview
 * (pending_edits.js) follows the pointer with no round-trip lag; the
 * re-seat tween's rAF loop renders the same way every frame (app.js).
 *
 * app.js registers the renderer (setRenderer). Until it has — and in
 * the DOM-free tests — a request is a no-op.
 */

let renderer = null;

/** app.js: the function that derives from the last poll and patches. */
export function setRenderer(fn) {
    renderer = typeof fn === 'function' ? fn : null;
}

/** Re-derive from the last polled state and patch now. */
export function requestRender() {
    if (renderer) renderer();
}
