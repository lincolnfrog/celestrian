/**
 * The creation menu (design_language.md Q17): every + is a TEMPLATE
 * PICKER. The menu opens with a fixed "Track" default row anchored
 * directly under the pointer — click-click in place reproduces the old
 * one-verb add — with the user's track templates listed below (one
 * short travel picks Guitar/Drums/…; the template click REPLACES the
 * rename + input-pick it saves). One control, no second button: all
 * three + affordances (top-level ＋ Track, group rail +, add-row) open
 * THIS menu; group entry points insert into their group.
 *
 * The default row is FIXED, never last-used: muscle memory needs the
 * same thing under the cursor every time (an adaptive default would
 * sabotage the double-click habit).
 *
 * Templates are fetched ON OPEN (the input-menu pattern — a fresh save
 * appears without a reload) and appended BELOW the already-positioned
 * default row, so the anchor never shifts while the list loads.
 *
 * With exactly one lane selected, the menu's last row saves that lane
 * to the library ("Save 'Guitar' as template…") — save-from-selection,
 * per the Q17 ruling.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';
import { selection } from './selection.js';

export function closeCreationMenu() {
    document.querySelectorAll('.creation-menu').forEach(m => m.remove());
}

/** A non-interactive heading/status line (input-menu vocabulary). */
const menuNote = text => el('div', 'creation-menu-note', { textContent: text });

/** One menu action row: label + optional right-aligned meta chip. */
function menuItem(label, meta, onPick, extraClass = '') {
    const item = el('button', 'creation-item' + extraClass);
    item.appendChild(el('span', 'creation-item-label', { textContent: label }));
    if (meta) {
        item.appendChild(el('span', 'creation-item-meta mono',
            { textContent: meta }));
    }
    item.addEventListener('click', () => {
        closeCreationMenu();
        onPick();
    });
    return item;
}

/** The single selected lane's {id, name}, or null (the save row only
 * offers itself for an unambiguous selection). */
function soleSelection() {
    if (selection.size !== 1) return null;
    const id = [...selection][0];
    const row = document.getElementById('lane-' + id);
    const lane = row && row._lane;
    if (!lane || (lane.kind !== 'clip' && lane.kind !== 'group')) return null;
    return { id, name: lane.name || id };
}

/**
 * Open the menu for a + affordance. `groupId` is '' for top level, a
 * group's id for its + / add-row (picks insert into that group).
 * Anchoring: the DEFAULT row is placed under the pointer — the menu is
 * positioned so (clientX, clientY) lands inside that first row.
 */
export function openCreationMenu(ev, groupId = '') {
    // Toggle: a second press on the same affordance closes.
    if (document.querySelector('.creation-menu')) {
        closeCreationMenu();
        return;
    }

    const menu = el('div', 'creation-menu');

    // The FIXED default row — bare empty track, default input. Sits
    // under the cursor; click-click = today's one-verb behavior.
    menu.appendChild(menuItem('Track', 'empty', () => {
        if (groupId) ctx.cb.onAddClip(groupId);
        else ctx.cb.onAddTrack();
    }, ' default'));

    // Async sections land below the anchored default row.
    const rest = el('div', 'creation-menu-rest');
    menu.appendChild(rest);
    rest.appendChild(menuNote('templates…'));

    document.body.appendChild(menu);

    // Anchor: default row under the pointer (clamped to the viewport).
    const first = menu.querySelector('.creation-item');
    const rowH = first.offsetHeight || 28;
    const x = Math.max(8, Math.min((ev.clientX || 0) - 14,
        window.innerWidth - menu.offsetWidth - 8));
    const y = Math.max(8, Math.min((ev.clientY || 0) - rowH / 2,
        window.innerHeight - 40));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    Promise.resolve()
        .then(() => ctx.cb.getTrackTemplates ? ctx.cb.getTrackTemplates() : [])
        .then(templates => {
            if (!menu.isConnected) return;  // dismissed while fetching
            rest.textContent = '';
            (templates || []).forEach(t => {
                const meta = t.kind === 'group'
                    ? `${t.tracks} track${t.tracks === 1 ? '' : 's'}`
                    : 'track';
                rest.appendChild(menuItem(t.name, meta,
                    () => ctx.cb.onCreateFromTemplate(t.name, groupId)));
            });
            if (!(templates || []).length) {
                rest.appendChild(menuNote(
                    'no templates yet — select a track, save it below'));
            }
            // Save-from-selection: the library grows from the session.
            const sel = soleSelection();
            if (sel && ctx.cb.onSaveTemplate) {
                rest.appendChild(el('div', 'creation-menu-sep'));
                const row = el('div', 'creation-save-row');
                const input = el('input', 'creation-save-input', {
                    type: 'text',
                    placeholder: `Save "${sel.name}" as template…`,
                });
                input.maxLength = 64;
                const commit = () => {
                    const name = input.value.trim();
                    if (!name) return;
                    closeCreationMenu();
                    ctx.cb.onSaveTemplate(sel.id, name);
                };
                input.addEventListener('keydown', e => {
                    e.stopPropagation();  // typing must not hit hotkeys
                    if (e.key === 'Enter') commit();
                    else if (e.key === 'Escape') closeCreationMenu();
                });
                const go = el('button', 'creation-save-btn',
                    { textContent: 'Save' });
                go.addEventListener('click', commit);
                row.append(input, go);
                rest.appendChild(row);
            }
        })
        .catch(err => {
            console.error('Template list fetch failed:', err);
            if (!menu.isConnected) return;
            rest.textContent = '';
            rest.appendChild(menuNote('templates unavailable'));
        });
}

/** Dismiss on outside press (Escape lives in init.js' dispatcher). */
export function wireCreationMenuDismiss() {
    document.addEventListener('pointerdown', e => {
        if (!e.target.closest('.creation-menu') &&
            !e.target.closest('#create-track-btn') &&
            !e.target.closest('.add-clip-btn') &&
            !e.target.closest('.add-track-row-btn')) {
            closeCreationMenu();
        }
    });
}
