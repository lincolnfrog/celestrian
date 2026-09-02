/**
 * [ / ] handle teleport + the per-lane handle nav dock.
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
 * (The keydown wiring itself lives in init.js' unified dispatcher.)
 */

import { ctx } from './context.js';
import { el, pct } from './sv_util.js';
import { activeSelectedId, selectOnly } from './selection.js';

/** Every grabbable boundary class in a lane — shared by the walker and
 * the nav-dock tick builder so the two can never disagree. */
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
/* The dock's right edge sits this far inside the viewport. */
const DOCK_RIGHT_MARGIN_PX = 24;

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

/* ---------- handle nav dock (owner pick C) --------------
 * The mouse-viable face of [ / ]: a slim always-visible FOOTER BAR in
 * its own grid row under a mapped lane's body — unmapped lanes have no
 * footer and pay no space. Right-aligned to the VIEWPORT by JS in
 * updateNavDock (horizontal position: sticky misplaced the earlier
 * gutter inside the lane in the JUCE webview — never again). The
 * STRIP is a per-track minimap of loop bounds and cuts, one clickable
 * tick per handle, the cyan box marking the current viewport — the
 * split-clip answer: you see every handle instead of walking blind.
 * ⇤ ‹ › ⇥ reuse the same teleport primitive as the keys. Clicking
 * anything in the dock selects the lane, so dock and hotkeys always
 * agree on the active track. */
export function buildNavDock(row) {
    const nav = el('div', 'lane-nav');
    nav.style.display = 'none';   // shown once it has ticks
    const dock = el('div', 'nav-dock');
    row._navDock = dock;
    // A press in the dock must never fall through to the lane below.
    dock.addEventListener('pointerdown', e => e.stopPropagation());
    const btn = (label, title, fn) => {
        const b = el('button', 'nav-btn mono', { textContent: label, title });
        b.addEventListener('click', e => {
            e.stopPropagation();
            selectOnly(row._lane.id);
            fn();
        });
        return b;
    };
    const strip = el('div', 'nav-strip',
        { title: 'All handles at a glance — click one to teleport' });
    dock.append(
        btn('⇤', 'Outer: loop start (Shift+[)',
            () => teleportToHandle(-1, true)),
        btn('‹', 'Previous handle ([)', () => teleportToHandle(-1, false)),
        strip,
        btn('›', 'Next handle (])', () => teleportToHandle(1, false)),
        btn('⇥', 'Outer: loop end (Shift+])',
            () => teleportToHandle(1, true)));
    nav.appendChild(dock);
    row._navStrip = strip;
    return nav;
}

/** A strip tick's target at CLICK time: ticks store the handle's cycle
 * fraction, not the element (overlays rebuild every reconcile — a held
 * reference would go stale), and resolve to the nearest live handle. */
function teleportToFrac(row, f) {
    const handles = laneHandleEls(row);
    if (!handles.length) return;
    const body = row.querySelector('.lane-body');
    if (!body) return;
    const br = body.getBoundingClientRect();
    const targetX = br.left + f * br.width;
    let best = handles[0];
    for (const h of handles) {
        if (Math.abs(h.x - targetX) < Math.abs(best.x - targetX)) best = h;
    }
    teleportToEl(row, best.el);
}

/** Rebuild/patch a lane's dock from its overlay: tick fractions parse
 * the handles' own `left` styles (the same pct() truth the lane
 * renders with — no rect reads, zoom-independent); the viewport box is
 * the one rect-based fact, patched in place every call. */
export function updateNavDock(row) {
    const strip = row._navStrip;
    if (!strip) return;
    const nav = strip.closest('.lane-nav');
    const fracOf = node => {
        const m = /(-?[\d.]+)%/.exec(node.style.left || '');
        return m ? parseFloat(m[1]) / 100 : null;
    };
    const ticks = [];
    row.querySelectorAll(HANDLE_SELECTOR)
        .forEach(node => {
            if (isTransientHandle(node)) return;
            const f = fracOf(node);
            if (f === null || f < -0.01 || f > 1.01) return;
            ticks.push({ f,
                seam: node.classList.contains('cut-handle') ||
                      node.classList.contains('seam-handle'),
                title: node.title });
        });
    ticks.sort((a, b) => a.f - b.f);
    if (!ticks.length) { nav.style.display = 'none'; return; }
    if (nav.style.display !== '') nav.style.display = '';
    // Keyed rebuild: tick churn only when the handle set actually moved.
    const key = ticks.map(t => (t.seam ? 's' : 'b') + t.f.toFixed(4))
        .join(',');
    if (strip._key !== key) {
        strip._key = key;
        strip.textContent = '';
        const view = el('div', 'nav-view');
        strip.appendChild(view);
        strip._view = view;
        ticks.forEach(t => {
            const tick = el('div', 'nav-tick' + (t.seam ? ' seam' : ''));
            tick.style.left = (t.f * 100) + '%';
            if (t.title) tick.title = t.title;
            tick.addEventListener('click', e => {
                e.stopPropagation();
                selectOnly(row._lane.id);
                teleportToFrac(row, t.f);
            });
            strip.appendChild(tick);
        });
    }
    const body = row.querySelector('.lane-body');
    const session = ctx.els.session;
    if (body && session && strip._view) {
        const br = body.getBoundingClientRect();
        const sr = session.getBoundingClientRect();
        if (br.width > 0) {
            const l = Math.max(0, (sr.left - br.left) / br.width);
            const r = Math.min(1, (sr.right - br.left) / br.width);
            strip._view.style.left = (l * 100).toFixed(2) + '%';
            strip._view.style.width =
                (Math.max(0, r - l) * 100).toFixed(2) + '%';
        }
        // Pin the dock's right edge to the viewport (JS, not sticky —
        // see the section comment): the nav row spans the zoomed grid
        // width; place the dock at (viewport right − margin), clamped
        // to the row's left edge.
        const dock = row._navDock;
        if (dock) {
            const nr = nav.getBoundingClientRect();
            const left = Math.max(0,
                (sr.right - DOCK_RIGHT_MARGIN_PX) - dock.offsetWidth - nr.left);
            const px = Math.round(left) + 'px';
            if (dock.style.left !== px) dock.style.left = px;
        }
    }
}

/** The nav docks' viewport boxes track horizontal scroll live (the
 * 50ms patch would lag a flick); rAF-coalesced. */
export function wireNavScroll() {
    let navScrollRaf = 0;
    ctx.els.session.addEventListener('scroll', () => {
        if (navScrollRaf) return;
        navScrollRaf = requestAnimationFrame(() => {
            navScrollRaf = 0;
            ctx.laneEls.forEach(row => updateNavDock(row));
        });
    }, { passive: true });
}
