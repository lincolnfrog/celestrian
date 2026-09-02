/**
 * One-time wiring: bind the callback table, hook the transport /
 * creation / selection chrome, and register the session view's
 * keyboard bindings (Escape, zoom, teleport, R) with the app-wide
 * dispatcher in keys.js.
 */

import { isGestureLive } from './gesture.js';
import { initCtx, ctx } from './context.js';
import { parseDropIds } from './sv_util.js';
import { registerKey, SCOPE, ANY_MODIFIERS } from '../keys.js';
import { selection, clearSelection, activeSelectedId } from './selection.js';
import { wireZoom, zoomIn, zoomOut } from './zoom.js';
import { teleportToHandle, wireNavScroll } from './teleport.js';
import { closeInputMenus, wireMenuDismiss } from './input_menu.js';
import { openCreationMenu, closeCreationMenu, wireCreationMenuDismiss }
    from './creation_menu.js';
import { wireRulerSeek } from './ruler_seek.js';

export function initSessionView(callbacks) {
    initCtx(callbacks);
    ctx.els.playBtn.addEventListener('click', () => ctx.cb.onTogglePlay());
    // Creation lives in the CANVAS: the persistent row under the lanes
    // makes tracks; the transport is transport. The + opens the
    // TEMPLATE PICKER (Q17; default "Track" row under the cursor —
    // click-click is still one verb).
    document.getElementById('create-track-btn')
        .addEventListener('click', e => openCreationMenu(e, ''));

    // Selection: Escape or a click on empty canvas clears; the floating
    // bar groups the selection in place.
    ctx.els.session.addEventListener('click', e => {
        if (e.target.id === 'session' || e.target.id === 'grid-area' ||
            e.target.id === 'lanes') clearSelection();
    });
    const selBar = document.getElementById('selection-bar');
    if (selBar) {
        selBar.querySelector('.sel-group').addEventListener('click', () => {
            const ids = [...selection];
            clearSelection();
            ctx.cb.onGroupSelection(ids);
        });
        selBar.querySelector('.sel-clear')
            .addEventListener('click', clearSelection);
    }

    // The ＋ Track row doubles as the DRAG-OUT target: drop a nested
    // track here to move it to the top level (the inverse of
    // drag-onto-to-group, in the same physical language).
    const createRow = document.getElementById('create-row');
    const trackBtn = document.getElementById('create-track-btn');
    createRow.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        createRow.classList.add('drop-target');
        trackBtn.textContent = '⤒ Move to top level';
    });
    createRow.addEventListener('dragleave', () => {
        createRow.classList.remove('drop-target');
        trackBtn.textContent = '＋ Track';
    });
    createRow.addEventListener('drop', e => {
        e.preventDefault();
        createRow.classList.remove('drop-target');
        trackBtn.textContent = '＋ Track';
        const ids = parseDropIds(e);
        if (!ids) return;
        if (ids.length) { clearSelection(); ctx.cb.onMoveToTop(ids); }
    });

    wireZoom();
    // Ruler scrub: click/drag the ruler to seek — the callback is
    // onSeek (app.js → seekTransport).
    wireRulerSeek();
    wireNavScroll();
    wireMenuDismiss();
    wireCreationMenuDismiss();
    wireKeyboard();
}

/** The view-scope bindings (keys.js). Escape fires under any modifier
 * and while typing (clear selection, close the window editor, drop the
 * audition, dismiss menus) unless a higher scope — an open status-strip
 * panel — consumes it first; the hotkeys are no-modifier (Shift
 * ignored: '+' and '{' carry it) and not-typing. */
function wireKeyboard() {
    const view = spec => registerKey({ scope: SCOPE.VIEW, ...spec });
    view({ key: 'Escape', ignore: ANY_MODIFIERS, whileTyping: true, handler: () => {
        // A live drag owns Escape (gesture.js cancels it in the
        // capture phase and stops propagation; this guard is the
        // belt to that suspender).
        if (isGestureLive()) return;
        clearSelection();
        if (ctx.cb.onWindowEdit) ctx.cb.onWindowEdit(null, false);
        // Esc drops any step audition (§11.3: "esc exits the loop").
        if (ctx.cb.onEscapeAudition) ctx.cb.onEscapeAudition();
        closeInputMenus();
        closeCreationMenu();
    } });
    const hotkey = (key, handler) => view({ key, ignore: ['shift'], handler });
    // '=' is the unshifted '+' on ANSI layouts — accept both so the
    // zoom hotkey works without holding Shift.
    hotkey(['+', '='], zoomIn);
    hotkey(['-', '_'], zoomOut);
    // [ / ] walk the selected track's handles; { / } jump to the
    // outer loop bounds (see teleport.js).
    hotkey('[', () => teleportToHandle(-1, false));
    hotkey(']', () => teleportToHandle(1, false));
    hotkey('{', () => teleportToHandle(-1, true));
    hotkey('}', () => teleportToHandle(1, true));
    // R = the record key: press the selected track's (or group's) ●
    // — a group cascades per Q7 (arm every empty member). While
    // anything records, R stops it regardless of selection (the
    // handler owns that logic; see app.js onRecordKey).
    hotkey('r', () => {
        if (ctx.cb.onRecordKey) ctx.cb.onRecordKey(activeSelectedId());
    });
}
