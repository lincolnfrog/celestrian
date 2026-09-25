/**
 * requestRender(): re-derive the view from the LAST polled state — with
 * the current drag pin, edit hold, settle and pending edits — and patch
 * at once, without a poll. A gesture calls it on every move so its
 * preview (pending_edits.js) follows the pointer with no round-trip
 * lag; the settle's rAF loop calls it every frame (frame_hold.js).
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
