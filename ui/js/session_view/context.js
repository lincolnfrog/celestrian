/**
 * Shared view context: the callback table injected by app.js, the
 * static chrome elements, and the two long-lived caches. Every
 * session-view module imports { ctx } instead of owning globals —
 * the one place the split's shared mutable state lives.
 *
 * CONVENTIONS THE MODULES SHARE (the expando protocol — render CACHES
 * ride the DOM node they describe, so they live and die with the
 * node; gesture LATCHES live in gesture.js module state — a latch that
 * gates other code must be released on every failure path, which the
 * gesture runner owns):
 *
 *   gesture.isOverlayFrozen(body) — a drag holds pointer capture on an
 *                     overlay element (or a commit is awaiting the
 *                     bridge); while true, patchLaneBody must NOT
 *                     rebuild that body's overlay (replacing the
 *                     captured node would orphan the gesture).
 *   overlay._key    — reconcileMarkers' rebuild key. A gesture that
 *                     draws its own preview POISONS it (sets a value
 *                     no legitimate key equals, e.g. 'expanded-drag')
 *                     so the next patch after release reconciles from
 *                     settled state.
 *   control._hot    — the control is mid-gesture (pointerdown …
 *                     pointerup): the 50ms patch tick must not write
 *                     the engine value over the user's drag (the
 *                     fx-slider / rename-editor lesson).
 *
 * Other per-node expandos (_lane, _peaksRef, _dk, _phase, …) are
 * private to their owning module and documented there.
 */

export const ctx = {
    cb: {},                    // callbacks injected by app.js
    els: {},                   // static chrome elements
    laneEls: new Map(),        // lane id → row element
    compositeCache: new Map(), // group composite waveform cache
};

/** Bind the callback table and look up the static chrome. Called once
 * from initSessionView before any wiring. */
export function initCtx(callbacks) {
    ctx.cb = callbacks;
    ctx.els = {
        playBtn: document.getElementById('play-btn'),
        readout: document.getElementById('position-readout'),
        qInfo: document.getElementById('q-info'),
        ruler: document.getElementById('ruler'),
        rulerRow: document.getElementById('ruler-row'),
        lanes: document.getElementById('lanes'),
        playhead: document.getElementById('playhead'),
        emptyState: document.getElementById('empty-state'),
        gridArea: document.getElementById('grid-area'),
        session: document.getElementById('session'),
    };
}
