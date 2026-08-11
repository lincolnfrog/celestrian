/**
 * One-time wiring: bind the callback table, hook the transport /
 * creation / selection chrome, and install the single document-level
 * keyboard dispatcher (Escape, zoom, teleport — the four separate
 * keydown listeners of the pre-split file, merged so their ordering is
 * deterministic).
 */

import { initCtx, ctx } from './context.js';
import { parseDropIds, isTypingTarget } from './sv_util.js';
import { selection, clearSelection } from './selection.js';
import { wireZoom, zoomIn, zoomOut } from './zoom.js';
import { teleportToHandle, wireNavScroll } from './teleport.js';
import { closeInputMenus, wireMenuDismiss } from './input_menu.js';

export function initSessionView(callbacks) {
    initCtx(callbacks);
    ctx.els.playBtn.addEventListener('click', () => ctx.cb.onTogglePlay());
    // Creation lives in the CANVAS (2026-07-19g): the persistent row
    // under the lanes makes tracks/groups; the transport is transport.
    document.getElementById('create-track-btn')
        .addEventListener('click', () => ctx.cb.onAddTrack());

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
    wireNavScroll();
    wireMenuDismiss();
    wireKeyboard();
}

/** The unified keyboard dispatcher. Escape fires unconditionally
 * (clear selection, close the window editor, dismiss input menus —
 * matching the pre-split listeners' combined effect); the hotkeys
 * below it are gated on no-modifier and not-typing. */
function wireKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            clearSelection();
            if (ctx.cb.onWindowEdit) ctx.cb.onWindowEdit(null, false);
            closeInputMenus();
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
    });
}
