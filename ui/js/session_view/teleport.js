/**
 * [ / ] handle teleport.
 *
 * Dialing in a drum loop means zooming way in on one loop marker — and
 * then being "far" from the other one. [ and ]
 * WALK the viewport left/right through the SELECTED track's handles in
 * order — loop start, every cut edge/seam, loop end — from wherever the
 * viewport currently is; on an unsplit clip that degenerates to "jump
 * to the start/end handle". Shift+[ / Shift+] go straight to the outer
 * loop bounds. Grabbing any handle selects its track (see selectOnly
 * callers), so the keys chain naturally with a drag: grab an edge,
 * trim it, hit the other bracket key, trim that. No selection → no-op.
 * (The keydown wiring itself lives in init.js' unified dispatcher.
 * The mouse face of these keys used to be a per-lane nav dock; the
 * region panel — region_panel.js — replaced it 2026-09-11.)
 */

import { ctx } from './context.js';
import { activeSelectedId } from './selection.js';

/** Every grabbable boundary class in a lane. */
const HANDLE_SELECTOR =
    '.win-bracket.start, .win-bracket.end, .cut-handle, .seam-handle';

/** Preview clones and drag layers are transient — never targets. */
const isTransientHandle = node =>
    node.classList.contains('snap-ghost') ||
    !!node.closest('.drag-preview-layer');

/* How long the landing handle stays force-visible after a teleport. */
const TELEPORT_FLASH_MS = 900;
/* The next-handle walk skips anything within this slack of center, so
 * the handle you're parked on doesn't swallow the press. */
const CENTER_SLACK_PX = 4;

/** Every grabbable boundary in the lane, sorted by screen x: window
 * brackets (loop bounds / trim grips), cut-band handles, seam handles. */
function laneHandleEls(row) {
    return [...row.querySelectorAll(HANDLE_SELECTOR)]
        .filter(node => !isTransientHandle(node))
        .map(node => {
            const r = node.getBoundingClientRect();
            return { el: node, x: r.left + r.width / 2 };
        })
        .sort((a, b) => a.x - b.x);
}

/** The teleport primitive: center `node` horizontally (instant — this
 * is a precision-editing move, not a tour), bring the lane into view
 * vertically if off-screen, and blink the landing handle (latent grips
 * are invisible at rest — the flash class forces them visible). */
function teleportToEl(row, node) {
    const session = ctx.els.session;
    const box = session.getBoundingClientRect();
    const g = node.getBoundingClientRect();
    session.scrollLeft += (g.left + g.width / 2) - (box.left + box.width / 2);
    const r = row.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) {
        session.scrollTop += r.top - box.top - (box.height - r.height) / 2;
    }
    node.classList.remove('teleport-flash');
    void node.offsetWidth; // restart the animation on repeated presses
    node.classList.add('teleport-flash');
    setTimeout(() => node.classList.remove('teleport-flash'),
        TELEPORT_FLASH_MS);
}

/** Walk the viewport to the selected lane's next handle in `dir`
 * (−1 left / +1 right); `outer` jumps straight to the loop bound. */
export function teleportToHandle(dir, outer) {
    const id = activeSelectedId();
    if (id === null) return;
    const row = ctx.laneEls.get(id);
    if (!row) return;
    const handles = laneHandleEls(row);
    if (!handles.length) return;
    const box = ctx.els.session.getBoundingClientRect();
    const centerX = box.left + box.width / 2;
    let target;
    if (outer) {
        target = dir < 0 ? handles[0] : handles[handles.length - 1];
    } else {
        // The next handle strictly past center (slack so the one
        // you're parked on doesn't swallow the press).
        const past = dir < 0
            ? handles.filter(h => h.x < centerX - CENTER_SLACK_PX)
            : handles.filter(h => h.x > centerX + CENTER_SLACK_PX);
        if (!past.length) return;  // nothing further this way
        target = dir < 0 ? past[past.length - 1] : past[0];
    }
    teleportToEl(row, target.el);
}
