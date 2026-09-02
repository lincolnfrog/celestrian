/**
 * Debug flags — a leaf module (no imports) so any layer can read them
 * without an import cycle (app.js → session_view → map_bands → app.js
 * would cycle if the flag lived in app.js).
 *
 * `DEBUG` is `?debug=true` on the page URL, read once at load. Gates
 * the verbose log line in app.js and the map-gesture flight recorder
 * (`window.__mapDbg`, session_view/map_bands.js). False outside a
 * browser (the node test suite).
 */

export const DEBUG =
    typeof window !== 'undefined' && !!window.location &&
    new URLSearchParams(window.location.search).get('debug') === 'true';
