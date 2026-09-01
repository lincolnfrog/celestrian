/**
 * One-time wiring: bind the callback table, hook the transport /
 * creation / selection chrome, and install the single document-level
 * keyboard dispatcher (Escape, zoom, teleport — the four separate
 * keydown listeners of the pre-split file, merged so their ordering is
 * deterministic).
 */

import { isGestureLive } from './gesture.js';
import { initCtx, ctx } from './context.js';
import { parseDropIds, isTypingTarget } from './sv_util.js';
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
    // Creation lives in the CANVAS (2026-07-19g): the persistent row
    // under the lanes makes tracks; the transport is transport. Since
    // Q17 the + opens the TEMPLATE PICKER (default "Track" row under
    // the cursor — click-click keeps the old one-verb speed).
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
    // Ruler scrub (owner ruling 2026-08-27): click/drag the ruler to
    // seek — the callback is onSeek (app.js → seekTransport).
    wireRulerSeek();
    wireNavScroll();
    wireMenuDismiss();
    wireCreationMenuDismiss();
    wireKeyboard();
}

/** The unified keyboard dispatcher. Escape fires unconditionally
 * (clear selection, close the window editor, dismiss input menus —
 * matching the pre-split listeners' combined effect); the hotkeys
 * below it are gated on no-modifier and not-typing. */
function wireKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            // A live drag owns Escape (gesture.js cancels it in the
            // capture phase and stops propagation; this guard is the
            // belt to that suspender — audit 2026-08-31 U6).
            if (isGestureLive()) return;
            clearSelection();
            if (ctx.cb.onWindowEdit) ctx.cb.onWindowEdit(null, false);
            // Esc drops any step audition (§11.3: "esc exits the loop").
            if (ctx.cb.onEscapeAudition) ctx.cb.onEscapeAudition();
            closeInputMenus();
            closeCreationMenu();
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTypingTarget(e)) return;
        // '=' is the unshifted '+' on ANSI layouts — accept both so the
        // zoom hotkey works without holding Shift.
        if (e.key === '+' || e.key === '=') zoomIn();
        else if (e.key === '-' || e.key === '_') zoomOut();
        // [ / ] walk the selected track's handles; { / } jump to the
        // outer loop bounds (see teleport.js).
        else if (e.key === '[') teleportToHandle(-1, false);
        else if (e.key === ']') teleportToHandle(1, false);
        else if (e.key === '{') teleportToHandle(-1, true);
        else if (e.key === '}') teleportToHandle(1, true);
        // R = the record key: press the selected track's (or group's) ●
        // — a group cascades per Q7 (arm every empty member). While
        // anything records, R stops it regardless of selection (the
        // handler owns that logic; see app.js onRecordKey).
        else if (e.key === 'r' || e.key === 'R') {
            if (ctx.cb.onRecordKey) ctx.cb.onRecordKey(activeSelectedId());
        }
    });
}
