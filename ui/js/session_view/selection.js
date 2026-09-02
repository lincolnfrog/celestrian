/**
 * Selection (view state). Click a rail to select it (⌘/shift-click
 * adds, Escape or a canvas click clears). Selection feeds the two bulk
 * verbs: the floating "Group N tracks" bar, and multi-drag (dragging a
 * selected rail carries the whole selection) — plus the [ / ] handle
 * teleport, which targets the most recently selected lane.
 */

import { setText } from './sv_util.js';

export const selection = new Set();
// Set by an explicit clear gesture (Escape, canvas click, plain click on
// the sole selection); reset by any select. While it holds, the default
// selection does not re-assert itself.
let userCleared = false;

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    const n = selection.size;
    if (n < 2) { bar.classList.remove('open'); return; }
    bar.classList.add('open');
    setText(bar.querySelector('.sel-count'), `${n} tracks selected`);
}

export function clearSelection() {
    selection.clear();
    userCleared = true;  // an explicit clear sticks (see ensureDefaultSelection)
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
    userCleared = false;
    paintSelection();
    updateSelectionBar();
}

/** Rail-click selection: plain click selects the row (a click on the
 * sole selection keeps it — a track is always selected by default,
 * 2026-08-18; Escape / a canvas click clear); ⌘/Ctrl/Shift-click
 * toggles the row in and out of the additive set. */
export function toggleSelect(row, additive) {
    const id = row._lane.id;
    if (!additive) {
        selection.clear();
        selection.add(id);
    } else if (selection.has(id)) {
        selection.delete(id);
    } else {
        selection.add(id);
    }
    if (selection.size > 0) userCleared = false;
    paintSelection();
    updateSelectionBar();
}

/**
 * A track is selected BY DEFAULT (owner request 2026-08-18: "make sure
 * the first track is selected by default" — with the MIDI target and
 * the [ ] teleport following selection, an empty selection is a dead
 * state). Called every patch with the lane ids in view order: prunes
 * ids that vanished (deleted lanes), and when nothing is selected —
 * and the user has not just cleared it on purpose — selects the first
 * lane. A vanished selection re-arms the default (the clear was not the
 * user's). Returns true when it changed the selection.
 */
export function ensureDefaultSelection(laneIds) {
    let pruned = false;
    for (const id of [...selection]) {
        if (!laneIds.includes(id)) { selection.delete(id); pruned = true; }
    }
    if (selection.size > 0) {
        userCleared = false;
        if (pruned) { paintSelection(); updateSelectionBar(); }
        return pruned;
    }
    if (pruned) userCleared = false;
    if (userCleared || !laneIds.length) {
        if (pruned) { paintSelection(); updateSelectionBar(); }
        return pruned;
    }
    selectOnly(laneIds[0]);
    return true;
}

/** The [ / ] target: the most recently selected lane id (Set keeps
 * insertion order), or null with nothing selected. */
export function activeSelectedId() {
    let last = null;
    for (const id of selection) last = id; // insertion order → most recent
    return last;
}
