/**
 * Horizontal zoom (design.md: mouse wheel or +/−).
 *
 * Everything on the timeline is positioned in PERCENT of the ruler, so
 * zoom is just #grid-area growing past the viewport — no renderer
 * changes, the browser owns the scroll. The plain wheel is left alone
 * (it scrolls the tracks vertically); Ctrl+wheel zooms about the
 * cursor like every DAW. The +/− hotkeys are dispatched from the
 * unified keyboard handler in init.js (zoomIn / zoomOut).
 */

import { ctx } from './context.js';
import { refreshTimelineWidth } from './animator.js';

let zoomZ = 1;
const ZOOM_MIN = 1, ZOOM_MAX = 16, ZOOM_STEP = 1.25;
/* Ctrl+wheel uses a finer per-notch factor than the button step —
 * wheels deliver many events per gesture. */
const WHEEL_STEP = 1.1;

/** Set the zoom factor, clamped to [ZOOM_MIN, ZOOM_MAX], holding the
 * timeline instant under `anchorClientX` (or the viewport center)
 * still, and refresh the animator's cached ruler width. */
function setZoom(z, anchorClientX) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (z === zoomZ) { updateZoomUI(); return; }
    const session = ctx.els.session;
    // Hold the timeline instant under the anchor (cursor or viewport
    // center) still: the rail column is fixed width, so the anchor is
    // measured against the RULER, which scales linearly.
    const wBefore = ctx.els.ruler.offsetWidth;
    const rulerLeft = ctx.els.ruler.getBoundingClientRect().left;
    const box = session.getBoundingClientRect();
    const ax = anchorClientX ?? (box.left + box.width / 2);
    const frac = (ax - rulerLeft) / wBefore;
    zoomZ = z;
    ctx.els.gridArea.style.width = z === 1 ? '' : (z * 100) + '%';
    session.scrollLeft += frac * (ctx.els.ruler.offsetWidth - wBefore);
    // The animator caches the ruler width between polls — refresh it
    // now or the playhead runs on the old scale for up to 50ms.
    refreshTimelineWidth();
    updateZoomUI();
}

function updateZoomUI() {
    const label = document.getElementById('zoom-level');
    const zin = document.getElementById('zoom-in-btn');
    const zout = document.getElementById('zoom-out-btn');
    if (label) label.textContent = Math.round(zoomZ * 100) + '%';
    if (zin) zin.disabled = zoomZ >= ZOOM_MAX;
    if (zout) zout.disabled = zoomZ <= ZOOM_MIN;
}

/** One button-step in (the '+' / '=' hotkey shares this). */
export function zoomIn() { setZoom(zoomZ * ZOOM_STEP); }
/** One button-step out (the '−' / '_' hotkey shares this). */
export function zoomOut() { setZoom(zoomZ / ZOOM_STEP); }

/** Wire the zoom buttons, the reset-on-label click, and Ctrl+wheel.
 * Keyboard zoom lives in init.js' unified dispatcher. */
export function wireZoom() {
    const zin = document.getElementById('zoom-in-btn');
    const zout = document.getElementById('zoom-out-btn');
    const label = document.getElementById('zoom-level');
    if (zin) zin.addEventListener('click', zoomIn);
    if (zout) zout.addEventListener('click', zoomOut);
    if (label) label.addEventListener('click', () => setZoom(1));
    ctx.els.session.addEventListener('wheel', e => {
        if (!e.ctrlKey) return; // plain wheel keeps native vertical scroll
        e.preventDefault();
        setZoom(zoomZ * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP), e.clientX);
    }, { passive: false });
    updateZoomUI();
}
