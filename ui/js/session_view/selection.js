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
// A just-created track waiting for its lane (selectWhenPresent): taken
// by the first patch that lists it; any explicit select or clear, or
// PENDING_SELECT_MS without the lane appearing, drops it.
let pendingSelect = null;   // { id, t }
const PENDING_SELECT_MS = 3000;
// A handle press that was only a CLICK claims its track a moment later
// (claimSoon): the region panel sits under the selected lane, and
// claiming at once would move the lanes under what may be the first
// click of a double-click. Any explicit select or clear drops it.
let pendingClaim = null;    // { id, timer }

/** Drop a claim that is still waiting (claimSoon). */
export function cancelClaim() {
    if (!pendingClaim) return;
    clearTimeout(pendingClaim.timer);
    pendingClaim = null;
}

/** Claim track `id` after `ms` — unless it is selected or cleared, or a
 * new press begins, before then. A no-op for the sole selection. */
export function claimSoon(id, ms) {
    cancelClaim();
    if (selection.size === 1 && selection.has(id)) return;
    pendingClaim = { id, timer: setTimeout(() => {
        pendingClaim = null;
        selectOnly(id);
    }, ms) };
}

/** The track a waiting claim will select, or null (tests). */
export const pendingClaimId = () => (pendingClaim ? pendingClaim.id : null);

function updateSelectionBar() {
    const bar = document.getElementById('selection-bar');
    if (!bar) return;
    const n = selection.size;
    if (n < 2) { bar.classList.remove('open'); return; }
    bar.classList.add('open');
    setText(bar.querySelector('.sel-count'), `${n} tracks selected`);
}

export function clearSelection() {
    pendingSelect = null;
    cancelClaim();
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

/** Programmatic single-select: a loop handle's gesture claims its track
 * when it ENDS (gesture.js — never at the press: the region panel would
 * move the lane out from under the hand), which is what arms the [ ]
 * teleport. */
export function selectOnly(id) {
    pendingSelect = null;
    cancelClaim();
    if (selection.size === 1 && selection.has(id)) return;
    selection.clear();
    selection.add(id);
    userCleared = false;
    paintSelection();
    updateSelectionBar();
}

/** Rail-click selection: plain click selects the row (a click on the
 * sole selection keeps it — a track is always selected by default;
 * Escape / a canvas click clear); ⌘/Ctrl/Shift-click
 * toggles the row in and out of the additive set. */
export function toggleSelect(row, additive) {
    pendingSelect = null;
    cancelClaim();
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
 * A track is selected BY DEFAULT (with the MIDI target and the [ ]
 * teleport following selection, an empty selection is a dead state).
 * Called every patch with the lane ids in view order: prunes
 * ids that vanished (deleted lanes), and when nothing is selected —
 * and the user has not just cleared it on purpose — selects the first
 * lane. A vanished selection re-arms the default (the clear was not the
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

/** The [ / ] target: the most recently selected lane id (Set keeps
 * insertion order), or null with nothing selected. */
export function activeSelectedId() {
    let last = null;
    for (const id of selection) last = id; // insertion order → most recent
    return last;
}
