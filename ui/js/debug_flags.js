/**
 * Debug flags — a leaf module (no imports), so any layer can read them
 * without an import cycle.
 *
 * `DEBUG` is `?debug=true` on the page URL, read once at load. It turns
 * on the shell's debug log and commit trace (app.js) and the
 * map-gesture flight recorder (`window.__mapDbg`,
 * session_view/map_bands.js). False outside a browser.
 */

export const DEBUG =
    typeof window !== 'undefined' && !!window.location &&
    new URLSearchParams(window.location.search).get('debug') === 'true';
