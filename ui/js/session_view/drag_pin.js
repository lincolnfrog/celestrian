/**
 * The map-gesture frame pin. While any map gesture is live, the SHARED
 * display frame is PINNED: live commits change the audible cycle, and
 * letting the frame follow re-scaled every lane + the ruler under the
 * pointer mid-drag (owner video, 2026-07-23g — the world must not
 * squirm while you hold it). The frame settles once, on release.
 *
 * app.js reads the pins each poll (mapDragPinQ / mapDragPinFoldQ) and
 * feeds them to the view model; patchSessionView records the latest
 * frame each patch (noteFrame) so a gesture pins the value that was
 * on screen when it engaged.
 */

let dragPinQ = null;
let dragPinFoldQ = null;  // audible-cycle fold pinned with the frame
let lastFrameQ = 0;  // vm.cycleQ as of the latest patch (pin source)
let lastFoldQ = 0;   // vm.loopCycleQ ditto — the cursor's fold cycle

export function mapDragPinQ() { return dragPinQ; }
export function mapDragPinFoldQ() { return dragPinFoldQ; }

/** Record the frame the latest patch rendered (the pin source). */
export function noteFrame(frameQ, foldQ) {
    lastFrameQ = frameQ;
    lastFoldQ = foldQ;
}

/** Freeze the shared frame at its last-patched value (gesture start). */
export function pinFrame() {
    dragPinQ = lastFrameQ;
    dragPinFoldQ = lastFoldQ;
}

/** Release the pin — the frame settles once, on the next patch. */
export function unpinFrame() {
    dragPinQ = null;
    dragPinFoldQ = null;
}
