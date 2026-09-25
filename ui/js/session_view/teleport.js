/**
 * [ / ] handle teleport.
 *
 * Dialing in a drum loop means zooming way in on one loop marker — and
 * then being "far" from the other one. [ and ]
 * WALK the viewport left/right through the SELECTED track's handles in
 * order — on a heard lane the take tile's splices and ↺ (the edge grips
 * retired 2026-09-24), on a raw lane its brackets and every cut edge —
 * from wherever the viewport currently is. Shift+[ / Shift+] go
 * straight to the outermost handle. Grabbing any handle selects its
 * track (see selectOnly callers), so the keys chain naturally with a
 * drag: grab a splice, swap it, hit the bracket key, drag the next one.
 * No selection → no-op.
 * (The keydown wiring itself lives in init.js' unified dispatcher.
 * The mouse face of these keys used to be a per-lane nav dock; the
 * region panel — region_panel.js — replaced it 2026-09-11, and has its
 * own navigation: Z / ⇧Z and the wheel zoom its view.)
 */

import { ctx } from './context.js';
import { activeSelectedId } from './selection.js';

/** Every grabbable boundary class in a lane: window brackets (a raw
 * lane's, a one-shot's grips), cut-band handles, a one-shot's seams,
 * and a heard lane's splice handles and ↺ (splice_handles.js). */
const HANDLE_SELECTOR =
    '.win-bracket.start, .win-bracket.end, .cut-handle, .seam-handle, ' +
    '.lr-splice, .lr-top';

/** Preview clones and drag layers are transient — never targets. Nor
 * is anything in the REGION PANEL (diagnosis N5, 2026-09-23): its cut
 * bands are the lane's band code (.cut-handle), but the panel is
 * pinned to the viewport, so centring one of its handles can never
 * converge — `]` got stuck re-targeting it, creeping the main view
 * ~45 px per press. The walk is the LANE's handles — the take tile's:
 * a GHOST repeat's splice or ↺ (2026-09-24) is the same splice again,
 * and a 3Q loop in a 12Q frame would walk it four times. */
export const isTransientHandle = node =>
    node.classList.contains('snap-ghost') ||
    node.classList.contains('lr-ghost') ||
    !!node.closest('.drag-preview-layer') ||
    !!node.closest('.lane-region');

/* How long the landing handle stays force-visible after a teleport. */
const TELEPORT_FLASH_MS = 900;
/* The next-handle walk skips anything within this slack of center, so
 * the handle you're parked on doesn't swallow the press. */
const CENTER_SLACK_PX = 4;

/** Every grabbable boundary in the lane, sorted by screen x: window
 * brackets (loop bounds / trim grips), cut-band handles, seam handles,
 * splices and the ↺ (a hidden one — a repeat parked mid-gesture — is
 * not a place to go). */
function laneHandleEls(row) {
    return [...row.querySelectorAll(HANDLE_SELECTOR)]
        .filter(node => !isTransientHandle(node) && node.style.display !== 'none')
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
