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
import { wireRegionDock } from './region_dock.js';
import { nudgeRegion } from './region_nudge.js';
import { fitSelectedPanel, zoomSelectedPanel } from './region_nav.js';
import { openCreationMenu } from './creation_menu.js';
import { wireRulerSeek } from './ruler_seek.js';
import { dragHasFiles } from '../import_drop.js';

/* What in the transport bar is NOT its empty space: its controls and
 * readouts, and the panels that drop from it (the Project menu, the
 * preferences panel). */
const TRANSPORT_NOT_EMPTY = 'button, input, select, a, #odometer, ' +
    '#master-monitor, .brand, #project-menu, .audio-panel';

/* The create row's label at rest, and while a lane is dragged over it. */
const CREATE_LABEL = '＋ Track';
const MOVE_TO_TOP_LABEL = '⤒ Move to top level';

export function initSessionView(callbacks) {
    initCtx(callbacks);
    ctx.els.playBtn.addEventListener('click', () => ctx.cb.onTogglePlay());
    // Creation lives in the canvas: the persistent row under the lanes
    // makes tracks, through the creation menu.
    document.getElementById('create-track-btn')
        .addEventListener('click', e => openCreationMenu(e, ''));

    // Selection clears on Escape or a click on empty canvas — or on the
    // transport's empty space, so it needs no clear patch of canvas.
    // The transport's controls keep their own verbs, and a panel that
    // hangs from it is not the bar: a click inside one clears nothing.
    // The floating bar groups the selection in place.
    ctx.els.session.addEventListener('click', e => {
        if (e.target.id === 'session' || e.target.id === 'grid-area' ||
            e.target.id === 'lanes') clearSelection();
    });
    const transport = document.getElementById('transport');
    if (transport) {
        transport.addEventListener('click', e => {
            if (e.target.closest(TRANSPORT_NOT_EMPTY)) return;
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
        trackBtn.textContent = MOVE_TO_TOP_LABEL;
    });
    createRow.addEventListener('dragleave', () => {
        createRow.classList.remove('drop-target');
        trackBtn.textContent = CREATE_LABEL;
    });
    createRow.addEventListener('drop', e => {
        e.preventDefault();
        createRow.classList.remove('drop-target');
        trackBtn.textContent = CREATE_LABEL;
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
    wireRulerSeek();
    wireRegionDock();
    wireKeyboard();
}

/** The view-scope bindings (keys.js). Escape fires under any modifier
 * and while typing, unless a higher scope consumes it first — an open
 * popover (popover.js) or status-strip panel. The hotkeys take no
 * modifier (Shift ignored: '+' and '{' carry it) and never fire while
 * typing. */
function wireKeyboard() {
    const view = spec => registerKey({ scope: SCOPE.VIEW, ...spec });
    view({ key: 'Escape', ignore: ANY_MODIFIERS, whileTyping: true, handler: () => {
        // A live drag owns Escape: gesture.js cancels it in the capture
        // phase and stops propagation. This guard backs that up.
        if (isGestureLive()) return;
        clearSelection();
        // Leave comp mode on every lane (the comp itself stays) and drop
        // any step audition (docs/sequencer.md §11.3).
        if (ctx.cb.onCompMode) ctx.cb.onCompMode(null, false);
        if (ctx.cb.onEscapeAudition) ctx.cb.onEscapeAudition();
    } });
    const hotkey = (key, handler) => view({ key, ignore: ['shift'], handler });
    // A STEPPING key repeats while held (keys.js `repeat`): each
    // auto-repeat is one more step. Toggles and jumps are plain hotkeys
    // — a held key is one press.
    const stepKey = (key, handler) =>
        view({ key, ignore: ['shift'], repeat: true, handler });
    // '=' is the unshifted '+' on ANSI layouts: both zoom in. With a
    // region panel shown, +/− zoom the PANEL about the playhead; the
    // song view only with none.
    stepKey(['+', '='], () => { if (!zoomSelectedPanel(1)) zoomIn(); });
    stepKey(['-', '_'], () => { if (!zoomSelectedPanel(-1)) zoomOut(); });
    // [ / ] walk the selected track's handles; { / } jump to the outer
    // loop bounds (teleport.js).
    stepKey('[', () => teleportToHandle(-1, false));
    stepKey(']', () => teleportToHandle(1, false));
    hotkey('{', () => teleportToHandle(-1, true));
    hotkey('}', () => teleportToHandle(1, true));
    // ← / → NUDGE the selected track's loop region by 1Q, length held
    // (the region panel's slide as a keystroke); ⇧ = 4Q. No sub-Q step:
    // fine moves are the ⌥ drag's.
    const nudge = (dir, step, mods) => view({
        key: dir < 0 ? 'ArrowLeft' : 'ArrowRight',
        modifiers: mods,
        repeat: true,
        handler: e => {
            if (!nudgeRegion(dir * step)) return false;
            e.preventDefault();
        } });
    nudge(-1, 1, []);          nudge(1, 1, []);
    nudge(-1, 4, ['shift']);   nudge(1, 4, ['shift']);
    // Z / ⇧Z fit the selected track's REGION PANEL to its loop / to the
    // whole take. Only while a panel is shown — otherwise the key falls
    // through (undo is ⌘/Ctrl+Z, which these never match).
    const fit = (mods, kind) => view({
        key: 'z',
        modifiers: mods,
        handler: e => {
            if (!fitSelectedPanel(kind)) return false;
            e.preventDefault();
        } });
    fit([], 'region');
    fit(['shift'], 'take');
    // R = the record key: press the selected track's (or group's) ●.
    // What it does is record_verbs.js onRecordKey's — while anything records, it
    // stops that, whatever is selected.
    hotkey('r', () => {
        if (ctx.cb.onRecordKey) ctx.cb.onRecordKey(activeSelectedId());
    });
}
