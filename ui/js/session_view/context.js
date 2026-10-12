/**
 * Shared view context: the callback table injected by app.js, the
 * static chrome elements, and the two long-lived caches. Every
 * session-view module imports { ctx } instead of owning globals.
 *
 * THE PATCH LAWS every module here keeps — stated here, cited by name
 * elsewhere:
 *
 *   BUILT ONCE, PATCHED IN PLACE — a lane's rail and its synthetic rows
 *     are built once and never rebuilt: each poll (the ~50ms tick)
 *     writes values into the same nodes, and writes nothing that did
 *     not change (sv_util setText). So a popover hung from a rail, or
 *     an editor open in it, outlives the tick.
 *   A HELD CONTROL IS THE USER'S — while a control is held
 *     (`control._hot`, press … release: sv_util holdControl) or a lane's
 *     rename editor is open (`row._renaming`), the patch does not write
 *     the engine's value over it.
 *
 * THE EXPANDO PROTOCOL: render CACHES ride the DOM node they describe,
 * so they live and die with it. Gesture LATCHES live in gesture.js
 * module state — a latch that gates other code must be released on
 * every failure path, which the gesture runner owns:
 *
 *   gesture.isOverlayFrozen(body) — a drag holds pointer capture on an
 *                     overlay element (or a commit is awaiting the
 *                     bridge); while true, patchLaneBody must NOT
 *                     rebuild that body's overlay (replacing the
 *                     captured node would orphan the gesture).
 *   overlay._key    — reconcileMarkers' rebuild key. A gesture that
 *                     draws its own preview POISONS it (sets a value
 *                     no legitimate key equals, e.g. 'raw-drag')
 *                     so the next patch after release reconciles from
 *                     settled state.
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
        regionDock: document.getElementById('region-dock'),
    };
}
