/**
 * Selection (view state). Click a rail to select it (⌘/shift-click
 * adds, Escape or a canvas click clears). Selection feeds the two bulk
 * verbs: the floating "Group N tracks" bar, and multi-drag (dragging a
 * selected rail carries the whole selection) — plus the [ / ] handle
 * teleport, which targets the most recently selected lane.
 */

import { setText } from './sv_util.js';

export const selection = new Set();

export function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    const n = selection.size;
    if (n < 2) { bar.classList.remove('open'); return; }
    bar.classList.add('open');
    setText(bar.querySelector('.sel-count'), `${n} tracks selected`);
}

export function clearSelection() {
    selection.clear();
    document.querySelectorAll('.lane-rail.selected')
        .forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.lane.sel')
        .forEach(el => el.classList.remove('sel'));
    updateSelectionBar();
}

/** Sync rail + row selection classes from the selection set (rows
 * carry .sel so the nav dock can reveal for selected lanes). */
export function paintSelection() {
    document.querySelectorAll('.lane').forEach(r => {
        const rail = r.querySelector('.lane-rail');
        if (rail && r._lane) {
            const on = selection.has(r._lane.id);
            rail.classList.toggle('selected', on);
            r.classList.toggle('sel', on);
        }
    });
}

/** Programmatic single-select: grabbing a loop handle claims the track
 * (field request 2026-08-09), which is what arms the [ ] teleport. */
export function selectOnly(id) {
    if (selection.size === 1 && selection.has(id)) return;
    selection.clear();
    selection.add(id);
    paintSelection();
    updateSelectionBar();
}

/** Rail-click selection: plain click selects (or clears when the row
 * was already the sole selection); ⌘/Ctrl/Shift-click toggles the row
 * in and out of the additive set. */
export function toggleSelect(row, additive) {
    const id = row._lane.id;
    if (!additive) {
        const wasSole = selection.size === 1 && selection.has(id);
        clearSelection();
        if (wasSole) return;  // plain click on the sole selection clears
        selection.add(id);
    } else if (selection.has(id)) {
        selection.delete(id);
    } else {
        selection.add(id);
    }
    paintSelection();
    updateSelectionBar();
}

/** The [ / ] target: the most recently selected lane id (Set keeps
 * insertion order), or null with nothing selected. */
export function activeSelectedId() {
    let last = null;
    for (const id of selection) last = id; // insertion order → most recent
    return last;
}
