/**
 * THE PLAYHEAD MASK: the one white playhead (I8) sweeps island time
 * across every audio row — except where a row draws a DIFFERENT time
 * axis, where a frame-x line would be a lie:
 *   - an inspecting lane (the raw-take edit view, its own scale);
 *   - a revealing lane (the same-scale reveal, raw coordinates for the
 *     length of a map gesture — map_bands.js);
 *   - the region panel under the selected lane (the whole raw take —
 *     region_panel.js; its amber cursor is the honest one there).
 * A vertical mask carves those rows' bands out of the line itself —
 * paint-order-independent: the z-index scheme (an opaque body above
 * the line) leaves stray frames where the webview compositor lets the
 * line bleed through mid-drag.
 *
 * Run per patch, and by the reveal the moment it engages and tears
 * down: a per-poll mask alone lags a pointer-driven reveal by a poll.
 */

import { ctx } from './context.js';

/* The rows the island playhead must not cross. */
const MASKED_ROWS = '.lane-body.inspecting, .lane-body.revealing, .lane-region';

export function maskPlayheadOverInspectors() {
    const ph = ctx.els && ctx.els.playhead;
    if (!ph) return;
    const pr = ph.getBoundingClientRect();
    if (!(pr.height > 0)) return;
    // Hidden rows (an unselected lane's panel is display:none) measure
    // empty and carve nothing.
    const bands = [...document.querySelectorAll(MASKED_ROWS)]
        .map(b => b.getBoundingClientRect())
        .map(r => [Math.max(0, (r.top - pr.top) / pr.height * 100),
                   Math.min(100, (r.bottom - pr.top) / pr.height * 100)])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    if (!bands.length) {
        if (ph._masked) {
            ph._masked = false;
            ph._maskImg = '';
            ph.style.webkitMaskImage = '';
            ph.style.maskImage = '';
        }
        return;
    }
    let prevPct = 0;
    const stops = [];
    for (const [a, b] of bands) {
        stops.push('black ' + prevPct + '%, black ' + a + '%, ' +
                   'transparent ' + a + '%, transparent ' + b + '%');
        prevPct = b;
    }
    stops.push('black ' + prevPct + '%, black 100%');
    const img = 'linear-gradient(to bottom, ' + stops.join(', ') + ')';
    if (ph._maskImg !== img) {
        ph._maskImg = img;
        ph._masked = true;
        ph.style.webkitMaskImage = img;
        ph.style.maskImage = img;
    }
}
