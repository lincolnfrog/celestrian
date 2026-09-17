/**
 * The map-gesture frame pin. While any map gesture is live, the SHARED
 * display frame is PINNED: live commits change the audible cycle, and
 * letting the frame follow would re-scale every lane + the ruler under
 * the pointer mid-drag (the world must not squirm while you hold it).
 * The frame settles once, on release.
 *
 * app.js reads the pins each poll (mapDragPinQ / mapDragPinFoldQ) and
 * feeds them to the view model; patchSessionView records the latest
 * frame each patch (noteFrame) so a gesture pins the value that was
 * on screen when it engaged.
 */

let dragPinQ = null;
let dragPinFoldQ = null;  // audible-cycle fold pinned with the frame
let dragPinZero = null;   // the frame zero pinned with the frame
let lastFrameQ = 0;  // vm.cycleQ as of the latest patch (pin source)
let lastFoldQ = 0;   // vm.loopCycleQ ditto — the cursor's fold cycle
let lastZero = null; // vm.epochSamples ditto — the seated frame zero

export function mapDragPinQ() { return dragPinQ; }
export function mapDragPinFoldQ() { return dragPinFoldQ; }
export function mapDragPinZero() { return dragPinZero; }

/** Record the frame the latest patch rendered (the pin source). The
 * zero is pinned too: a live commit re-anchors the edited lane's
 * origin, and the seating would follow it mid-drag. */
export function noteFrame(frameQ, foldQ, zero = null) {
    lastFrameQ = frameQ;
    lastFoldQ = foldQ;
    lastZero = zero;
}

let pins = 0;  // refcount: the first of two overlapping pins must not
               // release the frame under the second (the same hazard
               // gesture.js's freeze counters close).

/** Freeze the shared frame at its last-patched value (gesture start). */
export function pinFrame() {
    if (pins++ === 0) {
        dragPinQ = lastFrameQ;
        dragPinFoldQ = lastFoldQ;
        dragPinZero = lastZero;
    }
}

/** Release the pin — the frame settles once, when the LAST holder lets
 * go (paired with pinFrame; the gesture runner pairs them for you). */
export function unpinFrame() {
    if (pins > 0 && --pins === 0) {
        dragPinQ = null;
        dragPinFoldQ = null;
        dragPinZero = null;
    }
}
