/**
 * Session view patch layer (docs/ui_overhaul.md §2, §4 — P2-10).
 *
 * patchSessionView(vm, aux) renders the Q-unit view model from
 * view_model.js into the DOM. THE ONLY Q→geometry conversion in the app
 * happens here, as percentages of the cycle — which is what makes I2
 * (simultaneity ⇔ same x) structural: every lane body spans the same
 * cycle, so equal Q is equal % is equal x, always.
 *
 * This module is DOM + geometry only. It never calls the backend;
 * interactions are injected as callbacks from app.js.
 *
 * Split into js/session_view/ (2026-08-11); this file is the public
 * barrel — the four names app.js imports:
 *
 *   init.js      — one-time wiring + the unified keyboard dispatcher
 *   patch.js     — patchSessionView (top-level per-poll patch)
 *   drag_pin.js  — the map-gesture frame pin (mapDragPinQ/…FoldQ)
 *
 * plus the internal modules: context (shared ctx + expando contract),
 * sv_util, selection, zoom, animator, teleport (nav dock + [ / ]),
 * ruler, dials, input_menu, fx_row, dims, window_edit, map_bands
 * (cut bands / seams / trim / expanded drag), lane_body, lane_build,
 * rail.
 */

export { initSessionView } from './session_view/init.js';
export { patchSessionView } from './session_view/patch.js';
export { mapDragPinQ, mapDragPinFoldQ } from './session_view/drag_pin.js';
export { activeSelectedId } from './session_view/selection.js';
