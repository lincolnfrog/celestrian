/**
 * The creation menu (design_language.md Q17): every + is a TEMPLATE
 * PICKER. All three + affordances (top-level ＋ Track, a group rail's +,
 * the add-row) open this one menu; a group's entry points insert into
 * that group.
 *
 * It opens with a FIXED "Track" default row directly under the pointer,
 * so click-click in place adds a bare track — never a last-used row:
 * the double-click habit needs the same thing under the cursor every
 * time. The user's templates are fetched on open (a fresh save shows
 * without a reload) and appended BELOW the already-placed default row,
 * so the anchor never shifts while the list loads. With exactly one
 * lane selected, the last row saves that lane as a template.
 */

import { ctx } from './context.js';
import { el } from './sv_util.js';
import { selection } from './selection.js';
import { openPopover, closePopover, closePopoverOf, menuNote }
    from './popover.js';

/* The menu keeps this far from the window's edges (px). */
const MENU_EDGE_PX = 8;
/* The pointer sits this far inside the default row's left edge (px). */
const POINTER_INSET_PX = 14;
/* A row's height before layout can say (px). */
const DEFAULT_ROW_H_PX = 28;
/* Opened at the window's foot, the menu still has this much height: its
 * default row, the rest a scroll away (px). */
const MIN_MENU_H_PX = 40;
/* A template's name is at most this long. */
const TEMPLATE_NAME_MAX = 64;

/** One menu action row: label + optional right-aligned meta chip. */
function menuItem(label, meta, onPick, extraClass = '') {
    const item = el('button', 'creation-item' + extraClass);
    item.appendChild(el('span', 'creation-item-label', { textContent: label }));
    if (meta) {
        item.appendChild(el('span', 'creation-item-meta mono',
            { textContent: meta }));
    }
    item.addEventListener('click', () => {
        closePopover();
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

/** The save-from-selection row: name the selected lane `sel` as a
 * template. */
function saveRow(sel) {
    const row = el('div', 'creation-save-row');
    const input = el('input', 'creation-save-input', {
        type: 'text',
        placeholder: `Save "${sel.name}" as template…`,
    });
    input.maxLength = TEMPLATE_NAME_MAX;
    const commit = () => {
        const name = input.value.trim();
        if (!name) return;
        closePopover();
        ctx.cb.onSaveTemplate(sel.id, name);
    };
    input.addEventListener('keydown', e => {
        e.stopPropagation();  // typing reaches no hotkey
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') closePopover();
    });
    const go = el('button', 'creation-save-btn', { textContent: 'Save' });
    go.addEventListener('click', commit);
    row.append(input, go);
    return row;
}

/** The rows under the default one: the templates, audio import, and the
 * save row. */
function fillRest(rest, templates, groupId) {
    rest.textContent = '';
    templates.forEach(t => {
        const meta = t.kind === 'group'
            ? `${t.tracks} track${t.tracks === 1 ? '' : 's'}`
            : 'track';
        rest.appendChild(menuItem(t.name, meta,
            () => ctx.cb.onCreateFromTemplate(t.name, groupId)));
    });
    if (!templates.length) {
        rest.appendChild(menuNote('creation',
            'no templates yet — select a track, save it below'));
    }
    // AUDIO FILE IMPORT (docs/import.md): a new track from a
    // WAV/AIFF/FLAC, picked natively, placed at the frame top.
    if (ctx.cb.onImportAudio) {
        rest.appendChild(el('div', 'creation-menu-sep'));
        rest.appendChild(menuItem('Import audio…', 'file',
            () => ctx.cb.onImportAudio(groupId, 0), ' import'));
    }
    const sel = soleSelection();
    if (sel && ctx.cb.onSaveTemplate) {
        rest.appendChild(el('div', 'creation-menu-sep'));
        rest.appendChild(saveRow(sel));
    }
}

/**
 * Open the menu for the + affordance that `ev` (its click) came from.
 * `groupId` is '' for the top level, a group's id for its + / add-row.
 * The menu is placed so the pointer lands inside its default row.
 */
export function openCreationMenu(ev, groupId = '') {
    const trigger = ev.currentTarget;
    if (closePopoverOf(trigger)) return;

    const menu = el('div', 'creation-menu');
    menu.appendChild(menuItem('Track', 'empty', () => {
        if (groupId) ctx.cb.onAddClip(groupId);
        else ctx.cb.onAddTrack();
    }, ' default'));
    const rest = el('div', 'creation-menu-rest');
    menu.appendChild(rest);
    rest.appendChild(menuNote('creation', 'templates…'));
    openPopover({ menu, trigger, mount: document.body });

    // The default row under the pointer, clamped into the window. The
    // rows that load below it never run past the window's foot: the
    // menu ends MENU_EDGE_PX above it and scrolls (session.css).
    const first = menu.querySelector('.creation-item');
    const rowH = first.offsetHeight || DEFAULT_ROW_H_PX;
    const x = Math.max(MENU_EDGE_PX, Math.min((ev.clientX || 0) - POINTER_INSET_PX,
        window.innerWidth - menu.offsetWidth - MENU_EDGE_PX));
    const y = Math.max(MENU_EDGE_PX, Math.min((ev.clientY || 0) - rowH / 2,
        window.innerHeight - MIN_MENU_H_PX));
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.maxHeight = (window.innerHeight - y - MENU_EDGE_PX) + 'px';

    Promise.resolve()
        .then(() => ctx.cb.getTrackTemplates ? ctx.cb.getTrackTemplates() : [])
        .then(templates => {
            if (menu.isConnected) fillRest(rest, templates || [], groupId);
        })
        .catch(err => {
            console.error('Template list fetch failed:', err);
            if (!menu.isConnected) return;  // dismissed while fetching
            rest.textContent = '';
            rest.appendChild(menuNote('creation', 'templates unavailable'));
        });
}
