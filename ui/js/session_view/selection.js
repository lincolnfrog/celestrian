/**
 * Selection (view state). Click a rail to select it (⌘/shift-click
 * adds, Escape or a canvas click clears); a press on a track's loop
 * handle selects that track alone. Selection feeds the two bulk verbs —
 * the floating "Group N tracks" bar, and multi-drag (dragging a selected
 * rail carries the whole selection) — and the keyboard verbs, the
 * region panel and the MIDI target, which follow the most recently
 * selected lane.
 */

import { setText } from './sv_util.js';

export const selection = new Set();
// Set by an explicit clear gesture (Escape, a canvas or top-bar click);
// reset by any select. While it holds, the default selection does not
// re-assert itself.
let userCleared = false;
// A just-created track waiting for its lane (selectWhenPresent): taken
// by the first patch that lists it; any explicit select or clear, or
// PENDING_SELECT_MS without the lane appearing, drops it.
let pendingSelect = null;   // { id, t }
const PENDING_SELECT_MS = 3000;

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    const n = selection.size;
    if (n < 2) { bar.classList.remove('open'); return; }
    bar.classList.add('open');
    setText(bar.querySelector('.sel-count'), `${n} tracks selected`);
}

/** The explicit clear: it sticks (ensureDefaultSelection). */
export function clearSelection() {
    pendingSelect = null;
    selection.clear();
    userCleared = true;
    document.querySelectorAll('.lane-rail.selected')
        .forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.lane.sel')
        .forEach(el => el.classList.remove('sel'));
    updateSelectionBar();
}

/** Sync rail + row selection classes from the selection set (rows
 * carry .sel: only a selected lane's loop handles show and grab). */
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

/** Select `id` alone — what a press on one of the track's loop handles
 * does, at the press, whatever was selected. */
export function selectOnly(id) {
    pendingSelect = null;
    if (selection.size === 1 && selection.has(id)) return;
    selection.clear();
    selection.add(id);
    userCleared = false;
    paintSelection();
    updateSelectionBar();
}

/** Rail-click selection: plain click selects the row alone;
 * ⌘/Ctrl/Shift-click toggles the row in and out of the additive set.
 * Either click on the sole selection keeps it — a track is always
 * selected by default; only Escape / a canvas click clear. */
export function toggleSelect(row, additive) {
    pendingSelect = null;
    const id = row._lane.id;
    if (!additive) {
        selection.clear();
        selection.add(id);
    } else if (!selection.has(id)) {
        selection.add(id);
    } else if (selection.size > 1) {
        selection.delete(id);  // never the last member: it stays selected
    }
    userCleared = false;
    paintSelection();
    updateSelectionBar();
}

/**
 * A track is selected BY DEFAULT (the MIDI target, the keyboard verbs
 * and the region panel follow the selection: an empty one is a dead
 * state). Called every patch with the lane ids in view order: prunes
 * ids that vanished (deleted lanes), and when nothing is selected — and
 * the user has not just cleared it on purpose — selects the first lane.
 * A vanished selection re-arms the default (the clear was not the
 * user's). Returns true when it changed the selection.
 */
export function ensureDefaultSelection(laneIds) {
    if (pendingSelect) {
        if (laneIds.includes(pendingSelect.id)) {
            selectOnly(pendingSelect.id);  // clears pendingSelect
            return true;
        }
        if (performance.now() - pendingSelect.t > PENDING_SELECT_MS) {
            pendingSelect = null;
        }
    }
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

/** Select a lane that may not be rendered yet: a NEW track is selected
 * by default. Selecting it directly could lose a race — a poll already
 * in flight still lists the old tree, and its patch would prune an id
 * it doesn't list — so the next patch that lists it selects it. */
export function selectWhenPresent(id) {
    if (id == null) return;
    pendingSelect = { id, t: performance.now() };
}

/** The most recently selected lane id (a Set keeps insertion order), or
 * null with nothing selected: the keyboard verbs' target. */
export function activeSelectedId() {
    let last = null;
    for (const id of selection) last = id;
    return last;
}
