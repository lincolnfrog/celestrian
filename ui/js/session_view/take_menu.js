/**
 * The take list (docs/takes.md §3): a popover under the lane's rail —
 * one row per take with a mini waveform (getTakePeaks: the app's
 * per-take cache), the active row marked, click = selectTake, × =
 * deleteTake (never the last take), plus the comp row that puts the lane
 * in COMP MODE (comp_cells.js). It hangs from the rail, which a patch
 * never rebuilds (context.js), so the tick cannot take it away
 * mid-choice.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';
import { drawWaveform } from '../canvas_renderer.js';
import { openPopover, closePopover, closePopoverOf, menuNote }
    from './popover.js';

/* Row waveform geometry (CSS px). */
const ROW_WAVE_W = 120;
const ROW_WAVE_H = 18;

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
        closePopover();
        if (!active) ctx.cb.onSelectTake(lane.id, k);
    });
    row.appendChild(pick);
    const del = el('button', 'take-delete', { textContent: '×',
        title: lane.takes < 2 ? 'The last take stays'
                              : 'Remove this take (⌘Z brings it back)' });
    del.disabled = lane.takes < 2;
    del.addEventListener('click', e => {
        e.stopPropagation();
        closePopover();
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

/** Whose ● records another take of this lane's slot: its own — or, for
 * a mic of the group that sets the tempo (the trim view), that group's:
 * the group is one take. The take chip's tooltip says the same. */
export const takeVerbOwner = lane => (lane.definerMember ? 'the group’s ●' : '●');

/** Open (or close) the lane's take list — the take chip's click. */
export function toggleTakeMenu(row) {
    const trigger = row.querySelector('.take-btn');
    if (closePopoverOf(trigger)) return;
    const lane = row._lane;
    if (!lane || lane.kind !== 'clip' || !(lane.takes > 0)) return;

    const menu = el('div', 'take-menu');
    menu.appendChild(menuNote('take',
        lane.takes + (lane.takes === 1 ? ' take' : ' takes') +
        ' · ' + takeVerbOwner(lane) + ' records another'));
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
            closePopover();
            ctx.cb.onCompMode(lane.id, !lane.compMode);
        });
        menu.appendChild(comp);
    }
    openPopover({ menu, trigger, mount: row.querySelector('.lane-rail') });
}
