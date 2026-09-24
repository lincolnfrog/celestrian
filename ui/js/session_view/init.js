/**
 * One-time wiring: bind the callback table, hook the transport /
 * creation / selection chrome, and register the session view's
 * keyboard bindings (Escape, zoom, teleport, nudge, panel fit, R) with
 * the app-wide dispatcher in keys.js.
 */

import { isGestureLive } from './gesture.js';
import { initCtx, ctx } from './context.js';
import { parseDropIds } from './sv_util.js';
import { registerKey, SCOPE, ANY_MODIFIERS } from '../keys.js';
import { selection, clearSelection, activeSelectedId } from './selection.js';
import { wireZoom, zoomIn, zoomOut } from './zoom.js';
import { teleportToHandle } from './teleport.js';
import { wireRegionScroll, nudgeRegion, fitSelectedPanel } from './region_panel.js';
import { closeInputMenus, wireMenuDismiss } from './input_menu.js';
import { closeTakeMenus, wireTakeMenuDismiss } from './take_menu.js';
import { openCreationMenu, closeCreationMenu, wireCreationMenuDismiss }
    from './creation_menu.js';
import { wireRulerSeek } from './ruler_seek.js';
import { dragHasFiles } from '../import_drop.js';

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
    // DESELECT ALL from the top bar (owner request 2026-09-11): a click
    // on the transport's empty space clears the selection — and with it
    // the region panel — without needing a clear patch of canvas.
    // Controls keep their own verbs.
    const transport = document.getElementById('transport');
    if (transport) {
        transport.addEventListener('click', e => {
            if (e.target.closest('button, input, select, a, #odometer, ' +
                                 '#master-monitor, .brand')) return;
            clearSelection();
        });
    }
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

    // A file dropped anywhere but a lane body must not NAVIGATE the
    // webview to it (the browser default): swallow it. Lane bodies
    // handle their own drops first (lane_build.js).
    document.addEventListener('dragover', e => {
        if (dragHasFiles(e.dataTransfer)) e.preventDefault();
    });
    document.addEventListener('drop', e => {
        if (dragHasFiles(e.dataTransfer)) e.preventDefault();
    });

    wireZoom();
    // Ruler scrub: click/drag the ruler to seek — the callback is
    // onSeek (app.js → seekTransport).
    wireRulerSeek();
    wireRegionScroll();
    wireMenuDismiss();
    wireCreationMenuDismiss();
    wireTakeMenuDismiss();
    wireKeyboard();
}

/** The view-scope bindings (keys.js). Escape fires under any modifier
 * and while typing (clear selection, leave comp mode, drop the
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
        // Esc leaves comp mode on every lane (the comp itself stays).
        if (ctx.cb.onCompMode) ctx.cb.onCompMode(null, false);
        // Esc drops any step audition (§11.3: "esc exits the loop").
        if (ctx.cb.onEscapeAudition) ctx.cb.onEscapeAudition();
        closeInputMenus();
        closeTakeMenus();
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
    // ← / → NUDGE the selected track's loop region by 1Q (length held —
    // the region panel's slide as a keystroke); ⇧ = 4Q, ⌥ = ⅛Q. Long
    // takes get a deterministic, drag-free way to walk the region.
    const nudge = (dir, step, mods) => view({
        key: dir < 0 ? 'ArrowLeft' : 'ArrowRight',
        modifiers: mods,
        handler: e => {
            if (!nudgeRegion(dir * step)) return false;
            e.preventDefault();
        } });
    nudge(-1, 1, []);          nudge(1, 1, []);
    nudge(-1, 4, ['shift']);   nudge(1, 4, ['shift']);
    nudge(-1, 0.125, ['alt']); nudge(1, 0.125, ['alt']);
    // Z / ⇧Z fit the selected track's REGION PANEL to its loop / to
    // the whole take (Ableton's zoom-to-selection; loop-region phase 1,
    // 2026-09-23). Only while a panel is shown — otherwise the key
    // falls through and plain z stays unbound (undo is ⌘/Ctrl+Z, which
    // these never match). +/− stay on the main view.
    const fit = (mods, kind) => view({
        key: 'z',
        modifiers: mods,
        handler: e => {
            if (!fitSelectedPanel(kind)) return false;
            e.preventDefault();
        } });
    fit([], 'region');
    fit(['shift'], 'take');
    // R = the record key: press the selected track's (or group's) ●
    // — a group cascades per Q7 (arm every empty member). While
    // anything records, R stops it regardless of selection (the
    // handler owns that logic; see app.js onRecordKey).
    hotkey('r', () => {
        if (ctx.cb.onRecordKey) ctx.cb.onRecordKey(activeSelectedId());
    });
}
