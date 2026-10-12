/**
 * The recording-input picker: a popover under the lane's rail. The chip
 * shows the channel at rest; the menu fetches the device's input names
 * ON OPEN, so a hot-plugged interface appears without a reload.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';
import { openPopover, closePopover, closePopoverOf, menuNote }
    from './popover.js';

/** One button per input channel; `currentIdx` gets the check style. */
function menuItems(menu, inputs, currentIdx, onPick) {
    inputs.forEach((name, i) => {
        const item = el('button',
            'input-item' + (i === currentIdx ? ' current' : ''),
            { textContent: `${i + 1} · ${name}` });
        item.addEventListener('click', () => {
            closePopover();
            onPick(i);
        });
        menu.appendChild(item);
    });
}

/** Open (or close) the lane's input menu — the input chip's click. Two
 * sections in one column: the INPUT (left / mono) list, then the RIGHT
 * list that makes the track a stereo pair ("mono" clears it). A take's
 * channel count is fixed when it arms, so a change mid-take applies to
 * the next one. */
export async function toggleInputMenu(row) {
    const trigger = row.querySelector('.input-btn');
    if (closePopoverOf(trigger)) return;
    const lane = row._lane;
    if (!lane) return;

    const menu = el('div', 'input-menu');
    menu.appendChild(menuNote('input', 'inputs…'));
    openPopover({ menu, trigger, mount: row.querySelector('.lane-rail') });

    let inputs;
    try {
        inputs = await ctx.cb.getInputs();
    } catch (err) {
        console.error('Input list fetch failed:', err);
        if (!menu.isConnected) return; // closed while fetching
        menu.textContent = '';
        menu.appendChild(menuNote('input', 'inputs unavailable'));
        return;
    }
    if (!menu.isConnected) return; // closed while fetching
    menu.textContent = '';
    if (!inputs.length) {
        menu.appendChild(menuNote('input', 'no inputs found'));
        return;
    }
    menu.appendChild(menuNote('input',
        lane.inputChannelR >= 0 ? 'input · L' : 'input'));
    menuItems(menu, inputs, lane.inputChannel,
        i => ctx.cb.onSetInput(lane.id, i));
    menu.appendChild(menuNote('input', 'right (stereo pair)'));
    const monoItem = el('button',
        'input-item' + (lane.inputChannelR < 0 ? ' current' : ''),
        { textContent: '· mono' });
    monoItem.addEventListener('click', () => {
        closePopover();
        ctx.cb.onSetInputRight(lane.id, -1);
    });
    menu.appendChild(monoItem);
    menuItems(menu, inputs, lane.inputChannelR,
        i => ctx.cb.onSetInputRight(lane.id, i));
}
