/**
 * The take list (docs/takes.md §3): a popover under the lane's rail
 * — one row per take with a mini waveform (getTakeWaveform via the
 * app's per-take cache), the active row marked, click = selectTake,
 * × = deleteTake (never the last take), plus the comp toggle row that
 * puts the lane in COMP MODE (comp_cells.js). The input-menu pattern:
 * the menu lives on the rail, which patchRail never rebuilds, so the
 * 50ms tick cannot destroy it mid-choice; at most one is open. Escape
 * is a PANEL-scope binding in the keys.js dispatcher (it beats the
 * view's Escape, which would also clear the selection); outside press
 * dismisses.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';
import { drawWaveform } from '../canvas_renderer.js';
import { registerKey, SCOPE, ANY_MODIFIERS } from '../keys.js';

/* Row waveform geometry (CSS px). */
const ROW_WAVE_W = 120;
const ROW_WAVE_H = 18;

export function closeTakeMenus() {
    document.querySelectorAll('.take-menu').forEach(m => m.remove());
}

/** A non-interactive heading/status line (input-menu vocabulary). */
const menuNote = text => el('div', 'take-menu-note', { textContent: text });

/** One take row: label, mini waveform, delete. */
function takeRow(lane, k) {
    const active = k === lane.activeTake;
    const row = el('div', 'take-item' + (active ? ' current' : ''));
    row.dataset.take = String(k);
    const pick = el('button', 'take-pick', {
        title: active ? 'The take that sounds' : 'Make this take sound (⌘Z undoes)' });
    pick.appendChild(el('span', 'take-label mono', { textContent: 'T' + (k + 1) }));
    const canvas = document.createElement('canvas');
    canvas.className = 'take-wave';
    canvas.style.width = ROW_WAVE_W + 'px';
    canvas.style.height = ROW_WAVE_H + 'px';
    pick.appendChild(canvas);
    pick.addEventListener('click', () => {
        closeTakeMenus();
        if (!active) ctx.cb.onSelectTake(lane.id, k);
    });
    row.appendChild(pick);
    const del = el('button', 'take-delete', { textContent: '×',
        title: lane.takes < 2 ? 'The last take stays'
                              : 'Remove this take (⌘Z brings it back)' });
    del.disabled = lane.takes < 2;
    del.addEventListener('click', e => {
        e.stopPropagation();
        closeTakeMenus();
        ctx.cb.onDeleteTake(lane.id, k);
    });
    row.appendChild(del);
    // The waveform lands when the cache answers; a closed menu draws
    // nothing.
    Promise.resolve(ctx.cb.getTakePeaks ? ctx.cb.getTakePeaks(lane.id, k) : [])
        .then(peaks => {
            if (!canvas.isConnected) return;
            drawWaveform(canvas, peaks || [],
                { cssWidth: ROW_WAVE_W, cssHeight: ROW_WAVE_H, isEcho: !active });
        })
        .catch(() => {});
    return row;
}

/** Open (or close) the lane's take list. */
export function toggleTakeMenu(row) {
    const rail = row.querySelector('.lane-rail');
    if (rail.querySelector('.take-menu')) { closeTakeMenus(); return; }
    closeTakeMenus(); // at most one open across all lanes
    const lane = row._lane;
    if (!lane || lane.kind !== 'clip' || !(lane.takes > 0)) return;

    const menu = el('div', 'take-menu');
    menu.appendChild(menuNote(lane.takes + (lane.takes === 1 ? ' take' : ' takes') +
        ' · ● records another'));
    for (let k = 0; k < lane.takes; k++) menu.appendChild(takeRow(lane, k));
    // The comp: audio slots only (MIDI takes select, never comp).
    if (!lane.isMidi) {
        const comp = el('button', 'take-comp-row' + (lane.compMode ? ' on' : ''),
            { title: 'Choose per Q cell which take sounds there' });
        comp.appendChild(el('span', 'creation-item-label',
            { textContent: lane.compMode ? 'comp · done' : 'comp' }));
        comp.appendChild(el('span', 'creation-item-meta mono', {
            textContent: lane.comp.length ? 'edited' : 'per Q cell' }));
        comp.addEventListener('click', () => {
            closeTakeMenus();
            ctx.cb.onCompMode(lane.id, !lane.compMode);
        });
        menu.appendChild(comp);
    }
    rail.appendChild(menu);
}

/** Dismiss on outside press; Escape closes an open menu before the
 * view's Escape runs (PANEL scope — the one dispatcher). */
export function wireTakeMenuDismiss() {
    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.take-menu') && !e.target.closest('.take-btn')) {
            closeTakeMenus();
        }
    });
    registerKey({
        scope: SCOPE.PANEL, key: 'Escape', ignore: ANY_MODIFIERS,
        whileTyping: true,
        when: () => !!document.querySelector('.take-menu'),
        handler: () => closeTakeMenus(),
    });
}
