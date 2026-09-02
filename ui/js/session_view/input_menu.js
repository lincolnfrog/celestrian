/**
 * Recording-input picker.
 *
 * The chip shows the channel at rest (glanceability first — Tape Room
 * hover-density rule); the menu fetches the device's input names ON OPEN
 * so hot-plugged interfaces appear without a reload. The menu lives on
 * the rail, which patchRail never rebuilds, so the 50ms tick can't
 * destroy it mid-choice.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';

export function closeInputMenus() {
    document.querySelectorAll('.input-menu').forEach(m => m.remove());
}

/** A non-interactive heading/status line in the menu. */
const menuNote = text => el('div', 'input-menu-note', { textContent: text });

/** One button per input channel; `currentIdx` gets the check style. */
function menuItems(menu, inputs, currentIdx, onPick) {
    inputs.forEach((name, i) => {
        const item = el('button',
            'input-item' + (i === currentIdx ? ' current' : ''),
            { textContent: `${i + 1} · ${name}` });
        item.addEventListener('click', () => {
            closeInputMenus();
            onPick(i);
        });
        menu.appendChild(item);
    });
}

/** Open (or close) the lane's input menu: an INPUT (left/mono) list,
 * and the RIGHT list that makes the track a stereo pair (docs: stereo
 * overheads). "mono" clears the right assignment; the channel count of
 * a take is fixed at arm, so mid-take flips take effect on the next
 * arm. At most one menu is open across all lanes. */
export async function toggleInputMenu(row) {
    const rail = row.querySelector('.lane-rail');
    if (rail.querySelector('.input-menu')) { closeInputMenus(); return; }
    closeInputMenus(); // at most one open across all lanes
    const lane = row._lane;
    if (!lane) return;

    const menu = el('div', 'input-menu');
    menu.appendChild(menuNote('inputs…'));
    rail.appendChild(menu);

    let inputs;
    try {
        inputs = await ctx.cb.getInputs();
    } catch (err) {
        console.error('Input list fetch failed:', err);
        if (!menu.isConnected) return; // closed while fetching
        menu.textContent = '';
        menu.appendChild(menuNote('inputs unavailable'));
        return;
    }
    if (!menu.isConnected) return; // closed while fetching
    menu.textContent = '';
    if (!inputs.length) {
        menu.appendChild(menuNote('no inputs found'));
        return;
    }
    // Two columns: the INPUT (left/mono) list, and the RIGHT list that
    // makes the track a stereo pair.
    menu.appendChild(menuNote(
        lane.inputChannelR >= 0 ? 'input · L' : 'input'));
    menuItems(menu, inputs, lane.inputChannel,
        i => ctx.cb.onSetInput(lane.id, i));
    menu.appendChild(menuNote('right (stereo pair)'));
    const monoItem = el('button',
        'input-item' + (lane.inputChannelR < 0 ? ' current' : ''),
        { textContent: '· mono' });
    monoItem.addEventListener('click', () => {
        closeInputMenus();
        ctx.cb.onSetInputRight(lane.id, -1);
    });
    menu.appendChild(monoItem);
    menuItems(menu, inputs, lane.inputChannelR,
        i => ctx.cb.onSetInputRight(lane.id, i));
}

/** Input menus dismiss on outside press (Escape is init.js' view-scope
 * binding in the keys.js dispatcher). */
export function wireMenuDismiss() {
    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.input-menu') && !e.target.closest('.input-btn')) {
            closeInputMenus();
        }
    });
}
